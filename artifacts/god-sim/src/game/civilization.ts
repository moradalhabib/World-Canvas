import type {
  Building,
  CivilizationState,
  Grid,
  NeedType,
  Resource,
} from "./types";
import { ALL_NEEDS, ALL_RESOURCES } from "./types";
import { getBuildingDef } from "./buildings";
import { applySatisfaction, decayNeeds } from "./utilityAI";

/** Find a good spawn location: a grass tile near water at the world center. */
export function findSpawnCenter(grid: Grid): { row: number; col: number } {
  const cr = Math.floor(grid.rows / 2);
  const cc = Math.floor(grid.cols / 2);
  let bestScore = -Infinity;
  let best = { row: cr, col: cc };
  const radius = Math.min(20, Math.floor(Math.min(grid.rows, grid.cols) / 4));
  for (let r = Math.max(0, cr - radius); r < Math.min(grid.rows, cr + radius); r++) {
    for (let c = Math.max(0, cc - radius); c < Math.min(grid.cols, cc + radius); c++) {
      const t = grid.tiles[r][c];
      if (t.type !== "grass") continue;
      let score = t.fertility * 10;
      // Prefer being near water within 3 tiles
      for (let dr = -3; dr <= 3; dr++) {
        for (let dc = -3; dc <= 3; dc++) {
          const nr = r + dr;
          const nc = c + dc;
          if (nr < 0 || nr >= grid.rows || nc < 0 || nc >= grid.cols) continue;
          if (grid.tiles[nr][nc].type === "water") score += 2;
          if (grid.tiles[nr][nc].type === "forest") score += 1;
        }
      }
      // Slight preference for staying near center
      const distFromCenter = Math.abs(r - cr) + Math.abs(c - cc);
      score -= distFromCenter * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = { row: r, col: c };
      }
    }
  }
  return best;
}

export function createDefaultCivilization(grid: Grid): CivilizationState {
  const founded = findSpawnCenter(grid);
  return {
    population: 4,
    treasury: 80,
    // Phase 11 v8: bread reserve bumped 8 → 60 (~10 months of food at pop 6)
    // so a fresh realm has time to build farms/bakeries before starving.
    resources: { wheat: 0, bread: 60, wood: 30, stone: 20, gold: 80 },
    needs: {
      hunger: { value: 0, weight: 2.4, decay: 4 },
      safety: { value: 40, weight: 2.0, decay: 3 },
      social: { value: 15, weight: 1.0, decay: 1.5 },
      vanity: { value: 10, weight: 0.7, decay: 1 },
      faith: { value: 12, weight: 0.9, decay: 1 },
      // Phase 14: leisure starts moderately unmet so a fresh realm has a
      // small but visible orange bar in the Civic Needs panel from day 1.
      // Rises +decay per month; a Tavern's `satisfies.leisure` (24/month)
      // pushes it back down once the building is staffed.
      leisure: { value: 25, weight: 0.8, decay: 1.2 },
    },
    founded,
    monthlyTaxHistory: [],
  };
}

/**
 * Run one in-game month of civilization simulation.
 *
 * Pipeline:
 *   1. Each building's consumption is paid from the resource pool. If insufficient,
 *      production is halved (representing inefficiency).
 *   2. Production is added to the resource pool.
 *   3. Each building generates its tax income (gold) into the treasury.
 *   4. Population consumes bread → reduces hunger; lack of bread raises hunger.
 *   5. Total housing capacity vs population → adjusts safety need.
 *   6. Each building also satisfies some abstract needs (e.g. wells → social/faith).
 *   7. All needs decay by their per-month rate.
 *   8. Population grows slowly when housing surplus + low hunger; shrinks when starving.
 */
export function tickCivilizationMonth(
  civ: CivilizationState,
  buildings: Building[],
  /** Phase 5: when true, all wheat-producing buildings yield zero. */
  winterActive: boolean = false,
  /** Phase 13: seasonal multiplier for crop output (1.5x Spring/Autumn, 0 Winter, 1 Summer). */
  seasonCropMul: number = 1
): { taxes: number; housingCapacity: number } {
  const res = civ.resources;
  let totalHousing = 0;
  let monthTaxes = 0;
  const collectiveSatisfaction: Partial<Record<NeedType, number>> = {};

  // Pass A: production / consumption / taxes
  for (const b of buildings) {
    // Phase 5: rubble produces nothing, consumes nothing, pays no tax — but
    // its tile is still occupied by the wreck.
    if (b.status === "rubble") continue;

    const def = getBuildingDef(b.typeId);

    // Check if all consumed resources are available
    let efficiency = 1;
    for (const [k, amount] of Object.entries(def.consumes) as [Resource, number][]) {
      if ((res[k] ?? 0) < amount) {
        efficiency = 0.5;
        break;
      }
    }

    // Pay consumption
    for (const [k, amount] of Object.entries(def.consumes) as [Resource, number][]) {
      res[k] = Math.max(0, (res[k] ?? 0) - amount);
    }

    // Add production (scaled by efficiency). Phase 13: wheat is gated by
    // both the manual Chronomancer Winter (kills crops outright) AND the
    // seasonal cycle (1.5x in Spring/Autumn, 0 in natural Winter, 1x in
    // Summer). The two effects compose multiplicatively — winterActive
    // forces the multiplier to 0 even if seasonCropMul says otherwise.
    for (const [k, amount] of Object.entries(def.produces) as [Resource, number][]) {
      let mul = 1;
      if (k === "wheat") {
        mul = winterActive ? 0 : seasonCropMul;
      }
      res[k] = (res[k] ?? 0) + amount * efficiency * mul;
    }

    // Taxes (scaled by efficiency)
    monthTaxes += def.taxes * efficiency;
    totalHousing += def.housing;

    // Aggregate need satisfaction for residential/service buildings
    for (const [k, amount] of Object.entries(def.satisfies) as [NeedType, number][]) {
      collectiveSatisfaction[k] = (collectiveSatisfaction[k] ?? 0) + amount * efficiency;
    }
  }

  // Pass B: feed the population (bread → hunger reduction)
  const breadDemand = civ.population * 0.5;
  const breadEaten = Math.min(res.bread, breadDemand);
  res.bread -= breadEaten;
  const hungerReduction = (breadEaten / Math.max(1, breadDemand)) * 25;
  collectiveSatisfaction.hunger = (collectiveSatisfaction.hunger ?? 0) + hungerReduction;
  // Starvation increases hunger. Phase 11 v8: rate cut from *8 to *3 per
  // bread-deficit unit so a brief food shortage doesn't peg civic hunger to
  // 100 within a few months. Phase 19 "God-Sim balance": rate cut a further
  // 60% (3 → 1.2) to give the player a relaxed, creative pace — a brief
  // bread shortage should be a warning, not a death sentence. With 1.2x
  // multiplier the realm has ~7x the original (Phase 11 pre-v8) headroom
  // to construct farms/bakeries before civic hunger crosses 80.
  if (breadEaten < breadDemand) {
    civ.needs.hunger.value = Math.min(100, civ.needs.hunger.value + (breadDemand - breadEaten) * 1.2);
  }

  // Pass C: housing surplus reduces safety
  const housingSurplus = totalHousing - civ.population;
  if (housingSurplus > 0) {
    collectiveSatisfaction.safety = (collectiveSatisfaction.safety ?? 0) + Math.min(20, housingSurplus * 4);
  } else if (housingSurplus < 0) {
    civ.needs.safety.value = Math.min(100, civ.needs.safety.value + Math.abs(housingSurplus) * 3);
  }

  // Pass D: collect taxes
  civ.treasury += monthTaxes;
  // Phase 11 hardening: defensively clamp the treasury to a non-negative
  // integer at the canonical end-of-month tick. All known decrements
  // (rogue theft, building costs) are already guarded at their call site,
  // but this floor + max(0) belt-and-braces guarantees no future code path
  // can ever leave the realm in debt or with fractional gold.
  civ.treasury = Math.max(0, Math.floor(civ.treasury));
  res.gold = civ.treasury;

  // Pass E: apply satisfaction then decay
  applySatisfaction(civ.needs, collectiveSatisfaction);
  decayNeeds(civ.needs);

  // Pass F: population dynamics
  if (civ.needs.hunger.value < 40 && housingSurplus > 0) {
    // Population grows slowly when fed and housed
    if (Math.random() < 0.5) civ.population += 1;
  } else if (civ.needs.hunger.value > 80) {
    // Starvation kills off population
    if (Math.random() < 0.4 && civ.population > 1) civ.population -= 1;
  }

  // Track tax history for HUD trend
  civ.monthlyTaxHistory.push(monthTaxes);
  if (civ.monthlyTaxHistory.length > 12) civ.monthlyTaxHistory.shift();

  // Clamp resources to non-negative integers (display)
  for (const r of ALL_RESOURCES) {
    res[r] = Math.max(0, res[r] ?? 0);
  }

  return { taxes: monthTaxes, housingCapacity: totalHousing };
}
