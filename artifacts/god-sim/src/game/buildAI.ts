import type {
  Building,
  BuildingDef,
  BuildingId,
  CivilizationState,
  Grid,
  Resource,
  TileType,
} from "./types";
import { BUILDING_DEFS, getBuildingDef } from "./buildings";
import { scoreAction } from "./utilityAI";
import { DesirabilityMap } from "./desirability";

/**
 * Autonomous build AI.
 *
 * Each evaluation step:
 *   1. Score every building type using utility AI against current civ needs.
 *   2. Filter to buildings the civ can afford.
 *   3. For each candidate, find the best plot near existing settlement.
 *   4. Pick the (building × plot) with the best combined score.
 *   5. Place it, debit resources, mark desirability dirty.
 *
 * Houses also auto-upgrade based on desirability — handled by `tryUpgradeHouses`.
 */

/** Can the civ afford this build cost from current resources? */
function canAfford(civ: CivilizationState, cost: Partial<Record<Resource, number>>): boolean {
  for (const [k, amount] of Object.entries(cost) as [Resource, number][]) {
    const have = k === "gold" ? civ.treasury : civ.resources[k];
    if (have < amount) return false;
  }
  return true;
}

/** Debit a build cost from civ resources / treasury. */
function payCost(civ: CivilizationState, cost: Partial<Record<Resource, number>>): void {
  for (const [k, amount] of Object.entries(cost) as [Resource, number][]) {
    if (k === "gold") {
      civ.treasury -= amount;
      civ.resources.gold = civ.treasury;
    } else {
      civ.resources[k] = Math.max(0, civ.resources[k] - amount);
    }
  }
}

/** Are placement constraints satisfied for the building at (r,c)? */
function isPlotValid(
  def: BuildingDef,
  grid: Grid,
  occupancy: Uint8Array,
  r: number,
  c: number
): boolean {
  if (r < 0 || r >= grid.rows || c < 0 || c >= grid.cols) return false;
  if (occupancy[r * grid.cols + c]) return false;
  const tile = grid.tiles[r][c];
  if (!def.validOn.includes(tile.type)) return false;
  if (def.requiredAdjacent && def.requiredAdjacent.length > 0) {
    let found = false;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= grid.rows || nc < 0 || nc >= grid.cols) continue;
        if (def.requiredAdjacent.includes(grid.tiles[nr][nc].type as TileType)) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) return false;
  }
  return true;
}

/** Build an occupancy mask for fast plot lookups. */
function buildOccupancy(grid: Grid, buildings: Building[]): Uint8Array {
  const occ = new Uint8Array(grid.rows * grid.cols);
  for (const b of buildings) {
    occ[b.row * grid.cols + b.col] = 1;
  }
  return occ;
}

/**
 * Find the best plot for a building type, scanning outward from civilization center.
 * Score considers desirability and (optionally) penalty for distance from town center.
 */
function findBestPlot(
  def: BuildingDef,
  grid: Grid,
  occupancy: Uint8Array,
  civ: CivilizationState,
  desirability: DesirabilityMap
): { row: number; col: number; score: number } | null {
  const center = civ.founded;
  // Search radius scales with how many homes already exist (rough proxy)
  const SEARCH_RADIUS = 12;
  let best: { row: number; col: number; score: number } | null = null;

  for (let dr = -SEARCH_RADIUS; dr <= SEARCH_RADIUS; dr++) {
    for (let dc = -SEARCH_RADIUS; dc <= SEARCH_RADIUS; dc++) {
      const r = center.row + dr;
      const c = center.col + dc;
      if (!isPlotValid(def, grid, occupancy, r, c)) continue;

      const dist = Math.sqrt(dr * dr + dc * dc);
      const distPenalty = -dist * 0.04;
      const desir = desirability.get(r, c);

      let plotScore = distPenalty;
      // High-tier residences want high desirability
      if (def.category === "residential") {
        if (def.tier === "high") plotScore += desir * 4;
        else if (def.tier === "middle") plotScore += desir * 2;
        else plotScore += desir * 0.5;
      } else if (def.category === "production") {
        // Production buildings tolerate (or even prefer) low desirability
        plotScore += -desir * 0.5;
      } else {
        plotScore += desir * 0.5;
      }

      if (!best || plotScore > best.score) {
        best = { row: r, col: c, score: plotScore };
      }
    }
  }
  return best;
}

/**
 * Decide and place at most one new building this evaluation.
 * Returns the new building if any was placed.
 */
export function planAndBuild(
  grid: Grid,
  buildings: Building[],
  civ: CivilizationState,
  desirability: DesirabilityMap,
  currentMonth: number
): Building | null {
  const occ = buildOccupancy(grid, buildings);

  // Step 1: score every building type by utility (need satisfaction).
  // Step 2: Production buildings get an "indirect" need score based on resource shortages.
  const candidates: { def: BuildingDef; score: number }[] = [];

  for (const def of Object.values(BUILDING_DEFS)) {
    if (!canAfford(civ, def.buildCost)) continue;

    let utilityScore = scoreAction(civ.needs, def.satisfies);

    // Boost production buildings when their output is scarce
    for (const [res, amount] of Object.entries(def.produces) as [Resource, number][]) {
      const stock = res === "gold" ? civ.treasury : civ.resources[res];
      if (res === "wheat" && stock < 10) utilityScore += (10 - stock) * 6;
      if (res === "bread" && stock < 8) utilityScore += (8 - stock) * 10;
      if (res === "wood" && stock < 12) utilityScore += (12 - stock) * 5;
      if (res === "stone" && stock < 8) utilityScore += (8 - stock) * 4;
      void amount;
    }

    // Discourage overbuilding the same type
    const sameTypeCount = buildings.filter((b) => b.typeId === def.id).length;
    utilityScore -= sameTypeCount * 8;

    // Houses: discourage building higher tier when population is small
    if (def.category === "residential") {
      const totalHousing = buildings.reduce(
        (s, b) => s + getBuildingDef(b.typeId).housing,
        0
      );
      const surplus = totalHousing - civ.population;
      if (surplus > 4) utilityScore -= surplus * 6; // we have enough houses
    }

    if (utilityScore <= 30) continue;
    candidates.push({ def, score: utilityScore });
  }

  if (candidates.length === 0) return null;

  // Step 3: try candidates in score order until one finds a valid plot.
  candidates.sort((a, b) => b.score - a.score);

  for (const { def, score } of candidates) {
    const plot = findBestPlot(def, grid, occ, civ, desirability);
    if (!plot) continue;
    payCost(civ, def.buildCost);
    desirability.markDirty();
    void score;
    return {
      id: `${def.id}_${currentMonth}_${plot.row}_${plot.col}_${Math.floor(Math.random() * 9999)}`,
      typeId: def.id as BuildingId,
      row: plot.row,
      col: plot.col,
      builtMonth: currentMonth,
      lastDesirability: desirability.get(plot.row, plot.col),
      // Phase 21 — every new build starts as a scaffolded foundation. It
      // produces nothing and houses no one until the engine's per-frame
      // tickConstruction has accumulated CONSTRUCTION_WORK_MS_REQUIRED of
      // WORKING-NPC time on the tile.
      complete: false,
      constructionWorkMs: 0,
    };
  }
  return null;
}

/**
 * Auto-upgrade / downgrade existing residential buildings based on desirability.
 * - Free → Middle when desirability > 0.4 and treasury can afford the difference
 * - Middle → High when desirability > 0.8
 * - High → Middle when desirability < 0.2
 * - Middle → Free when desirability < -0.2
 * Returns the count of buildings that changed tier.
 */
export function tryUpgradeHouses(
  buildings: Building[],
  civ: CivilizationState,
  desirability: DesirabilityMap
): number {
  let changes = 0;
  for (const b of buildings) {
    const def = getBuildingDef(b.typeId);
    if (def.category !== "residential") continue;
    const desir = desirability.get(b.row, b.col);
    b.lastDesirability = desir;

    // Hysteresis: wider gap between upgrade & downgrade thresholds prevents
    // month-to-month oscillation when desirability sits near a boundary.
    //   free   → middle  at desir > 0.50
    //   middle → high    at desir > 1.00
    //   high   → middle  at desir < 0.30   (gap of 0.70 below upgrade)
    //   middle → free    at desir < -0.30  (gap of 0.80 below upgrade)
    if (b.typeId === "house_free" && desir > 0.5) {
      const upgradeCost: Partial<Record<Resource, number>> = { wood: 4, stone: 6 };
      if (canAffordSimple(civ, upgradeCost)) {
        payCostSimple(civ, upgradeCost);
        b.typeId = "house_middle";
        changes++;
      }
    } else if (b.typeId === "house_middle" && desir > 1.0) {
      const upgradeCost: Partial<Record<Resource, number>> = { wood: 4, stone: 8, gold: 15 };
      if (canAffordSimple(civ, upgradeCost)) {
        payCostSimple(civ, upgradeCost);
        b.typeId = "house_high";
        changes++;
      }
    } else if (b.typeId === "house_high" && desir < 0.3) {
      b.typeId = "house_middle";
      changes++;
    } else if (b.typeId === "house_middle" && desir < -0.3) {
      b.typeId = "house_free";
      changes++;
    }
  }
  if (changes > 0) desirability.markDirty();
  return changes;
}

function canAffordSimple(civ: CivilizationState, cost: Partial<Record<Resource, number>>): boolean {
  for (const [k, amount] of Object.entries(cost) as [Resource, number][]) {
    const have = k === "gold" ? civ.treasury : civ.resources[k];
    if (have < amount) return false;
  }
  return true;
}

function payCostSimple(civ: CivilizationState, cost: Partial<Record<Resource, number>>): void {
  for (const [k, amount] of Object.entries(cost) as [Resource, number][]) {
    if (k === "gold") {
      civ.treasury -= amount;
      civ.resources.gold = civ.treasury;
    } else {
      civ.resources[k] = Math.max(0, civ.resources[k] - amount);
    }
  }
}
