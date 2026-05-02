import type {
  Building,
  Citizen,
  CivilizationState,
  Grid,
} from "./types";
import { findPath, isWalkable } from "./pathfinding";

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

const HUNGER_RISE_PER_MONTH = 8;
const HUNGER_RISE_JITTER = 6;
const HUNGER_SEEK_THRESHOLD = 70;
const HUNGER_CRISIS_THRESHOLD = 100;
const FAITH_PRAY_THRESHOLD = 50;
const CRISIS_DEATH_TIMER = 2; // months in PRAYING/ROGUE before dying
const ROGUE_STEAL_AMOUNT = 30; // gold removed from treasury when a thief succeeds
const TILES_PER_SECOND_AT_1X = 1.5;
const GRAVESTONE_PROXIMITY_RADIUS = 2; // tiles
const GRAVESTONE_SOCIAL_PENALTY = 0.5; // applied per tile-snap when near a grave

/* -------------------------------------------------------------------------- */
/*  Spawning & creation                                                       */
/* -------------------------------------------------------------------------- */

let citizenCounter = 0;

function nextId(): string {
  citizenCounter++;
  return `npc_${Date.now().toString(36)}_${citizenCounter}`;
}

export function createCitizen(row: number, col: number, hue: number): Citizen {
  return {
    id: nextId(),
    row,
    col,
    progress: 0,
    state: "IDLE",
    path: [],
    pathIndex: 0,
    hunger: 0,                                    // spec: hunger starts at 0
    faith: Math.floor(Math.random() * 101),       // spec: faith randomized 0-100
    crisisTimer: 0,                               // spec: crisisTimer starts at 0
    hue,
  };
}

/**
 * Spawn `count` citizens on walkable tiles near the given center point.
 * Uses a small expanding ring so spawns don't stack.
 */
export function spawnInitialCitizens(
  grid: Grid,
  center: { row: number; col: number },
  count: number
): Citizen[] {
  const out: Citizen[] = [];
  const used = new Set<number>();
  const maxRadius = 8;
  for (let radius = 0; radius <= maxRadius && out.length < count; radius++) {
    for (let dr = -radius; dr <= radius && out.length < count; dr++) {
      for (let dc = -radius; dc <= radius && out.length < count; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const r = center.row + dr;
        const c = center.col + dc;
        if (!isWalkable(grid, r, c)) continue;
        const key = r * grid.cols + c;
        if (used.has(key)) continue;
        used.add(key);
        const hue = Math.round((out.length * 360) / count);
        out.push(createCitizen(r, c, hue));
      }
    }
  }
  return out;
}

/**
 * Backfill missing fields on citizens loaded from older save versions
 * (e.g. v3 saves that had a `needs` object instead of flat hunger/faith).
 * Mutates and returns the array for convenience.
 */
export function normalizeCitizens(citizens: Citizen[]): Citizen[] {
  for (const c of citizens) {
    // Older shape: needs.hunger lived inside a CitizenNeeds object
    const legacy = c as unknown as { needs?: { hunger?: number } };
    if (typeof c.hunger !== "number") {
      c.hunger = legacy.needs?.hunger ?? 0;
    }
    if (typeof c.faith !== "number") c.faith = Math.floor(Math.random() * 101);
    if (typeof c.crisisTimer !== "number") c.crisisTimer = 0;
    if (typeof c.progress !== "number") c.progress = 0;
    if (!Array.isArray(c.path)) c.path = [];
    if (typeof c.pathIndex !== "number") c.pathIndex = 0;
    // Legacy state values that no longer exist map to IDLE
    const validStates = new Set([
      "IDLE",
      "MOVING",
      "SEEK_FOOD",
      "PRAYING",
      "ROGUE",
      "DEAD",
      "WORKING",
    ]);
    if (!validStates.has(c.state as string)) c.state = "IDLE";
  }
  return citizens;
}

/* -------------------------------------------------------------------------- */
/*  Target finders                                                            */
/* -------------------------------------------------------------------------- */

function findNearestFood(
  row: number,
  col: number,
  buildings: Building[]
): Building | null {
  let best: Building | null = null;
  let bestDist = Infinity;
  for (const b of buildings) {
    if (b.typeId !== "bakery" && b.typeId !== "farm") continue;
    const d = Math.abs(b.row - row) + Math.abs(b.col - col);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

/**
 * For ROGUE citizens: nearest high-class house or, if none exist, the town
 * center (treated as the treasury vault). Returns coordinates plus an
 * optional building id (only set when targeting an actual building).
 */
function findNearestStealTarget(
  row: number,
  col: number,
  buildings: Building[],
  civ: CivilizationState
): { row: number; col: number; buildingId?: string } {
  let best: Building | null = null;
  let bestDist = Infinity;
  for (const b of buildings) {
    if (b.typeId !== "house_high") continue;
    const d = Math.abs(b.row - row) + Math.abs(b.col - col);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  if (best) {
    return { row: best.row, col: best.col, buildingId: best.id };
  }
  // Fallback: the treasury (town center)
  return { row: civ.founded.row, col: civ.founded.col };
}

/* -------------------------------------------------------------------------- */
/*  Per-month "brain" tick                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Run one game-month tick on the citizen's stats and decision-making.
 *
 * State machine (highest precedence first):
 *   DEAD              → no-op (skip everything)
 *   PRAYING / ROGUE   → increment crisisTimer; if > 2 → DEAD
 *                       PRAYING stays put; ROGUE keeps walking to its target
 *   hunger >= 100     → ENTER CRISIS:
 *                          faith >= 50 → PRAYING (clear path, kneel)
 *                          faith <  50 → ROGUE (path to high-class / treasury)
 *   hunger > 70       → SEEK_FOOD (path to nearest farm/bakery)
 *   else              → IDLE
 */
export function tickCitizenMonth(
  citizen: Citizen,
  grid: Grid,
  buildings: Building[],
  civ: CivilizationState
): void {
  // --- 1. DEAD: completely inert -------------------------------------------
  if (citizen.state === "DEAD") return;

  // --- 2. Already in a crisis state: tick the death timer ------------------
  if (citizen.state === "PRAYING" || citizen.state === "ROGUE") {
    citizen.crisisTimer += 1;
    if (citizen.crisisTimer > CRISIS_DEATH_TIMER) {
      // Starvation / consequence kicks in — they fall where they stand.
      citizen.state = "DEAD";
      citizen.path = [];
      citizen.pathIndex = 0;
      citizen.progress = 0;
      citizen.targetTile = undefined;
      citizen.targetBuildingId = undefined;
      return;
    }
    // ROGUE: if they have no active path (target gone, etc.), try to repath.
    if (citizen.state === "ROGUE" && citizen.path.length === 0) {
      const target = findNearestStealTarget(
        citizen.row,
        citizen.col,
        buildings,
        civ
      );
      const path = findPath(
        grid,
        citizen.row,
        citizen.col,
        target.row,
        target.col
      );
      if (path && path.length > 0) {
        citizen.path = path;
        citizen.pathIndex = 0;
        citizen.progress = 0;
        citizen.targetTile = { row: target.row, col: target.col };
        citizen.targetBuildingId = target.buildingId;
      }
    }
    // PRAYING: never moves — path is already cleared at crisis entry.
    return;
  }

  // --- 3. Living, non-crisis: hunger ticks up ------------------------------
  citizen.hunger = Math.min(
    100,
    citizen.hunger + HUNGER_RISE_PER_MONTH + Math.random() * HUNGER_RISE_JITTER
  );

  // --- 4. CRISIS BRANCH: hunger maxed out → independent choice -------------
  if (citizen.hunger >= HUNGER_CRISIS_THRESHOLD) {
    citizen.crisisTimer = 0;

    if (citizen.faith >= FAITH_PRAY_THRESHOLD) {
      // Pious citizens kneel and pray
      citizen.state = "PRAYING";
      citizen.path = [];
      citizen.pathIndex = 0;
      citizen.progress = 0;
      citizen.targetTile = undefined;
      citizen.targetBuildingId = undefined;
    } else {
      // Faithless citizens turn to crime
      citizen.state = "ROGUE";
      const target = findNearestStealTarget(
        citizen.row,
        citizen.col,
        buildings,
        civ
      );
      const path = findPath(
        grid,
        citizen.row,
        citizen.col,
        target.row,
        target.col
      );
      if (path && path.length > 0) {
        citizen.path = path;
        citizen.pathIndex = 0;
        citizen.progress = 0;
        citizen.targetTile = { row: target.row, col: target.col };
        citizen.targetBuildingId = target.buildingId;
      } else {
        // Unreachable — they'll wander the crisis timer down
        citizen.path = [];
        citizen.pathIndex = 0;
      }
    }
    return;
  }

  // --- 5. Don't replan if mid-walk ----------------------------------------
  if (citizen.path.length > 0 && citizen.pathIndex < citizen.path.length) return;

  // --- 6. SEEK_FOOD if hungry ---------------------------------------------
  if (citizen.hunger > HUNGER_SEEK_THRESHOLD) {
    const food = findNearestFood(citizen.row, citizen.col, buildings);
    if (!food) {
      citizen.state = "IDLE";
      return;
    }
    const path = findPath(grid, citizen.row, citizen.col, food.row, food.col);
    if (path && path.length > 0) {
      citizen.state = "SEEK_FOOD";
      citizen.path = path;
      citizen.pathIndex = 0;
      citizen.progress = 0;
      citizen.targetTile = { row: food.row, col: food.col };
      citizen.targetBuildingId = food.id;
    } else {
      citizen.state = "IDLE";
    }
  } else {
    citizen.state = "IDLE";
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-frame movement update                                                 */
/* -------------------------------------------------------------------------- */

function applyGravestonePenalty(
  walker: Citizen,
  allCitizens: Citizen[],
  civ: CivilizationState
): void {
  for (const other of allCitizens) {
    if (other.state !== "DEAD") continue;
    if (other.id === walker.id) continue;
    const dr = Math.abs(other.row - walker.row);
    const dc = Math.abs(other.col - walker.col);
    if (dr + dc <= GRAVESTONE_PROXIMITY_RADIUS) {
      civ.needs.social.value = Math.max(
        0,
        civ.needs.social.value - GRAVESTONE_SOCIAL_PENALTY
      );
      // One penalty per snap is enough — if multiple graves are nearby, cap it
      return;
    }
  }
}

/**
 * Advance the citizen's tile interpolation. PRAYING/DEAD never move. On
 * arrival we either eat (SEEK_FOOD), steal (ROGUE), or just stop. While
 * walking, each tile-snap may cost a small civic Social penalty if the
 * walker passes within range of a gravestone.
 */
export function updateCitizenMovement(
  citizen: Citizen,
  dtMs: number,
  timeScale: number,
  buildings: Building[],
  allCitizens: Citizen[],
  civ: CivilizationState
): void {
  if (timeScale === 0) return;
  if (citizen.state === "DEAD" || citizen.state === "PRAYING") return;
  if (citizen.path.length === 0 || citizen.pathIndex >= citizen.path.length) return;

  // SEEK_FOOD/ROGUE keep their named state; otherwise mark MOVING for HUD
  if (citizen.state !== "SEEK_FOOD" && citizen.state !== "ROGUE") {
    citizen.state = "MOVING";
  }

  const tilesPerMs = (TILES_PER_SECOND_AT_1X / 1000) * timeScale;
  citizen.progress += dtMs * tilesPerMs;

  while (citizen.progress >= 1 && citizen.pathIndex < citizen.path.length) {
    const next = citizen.path[citizen.pathIndex];
    citizen.row = next.row;
    citizen.col = next.col;
    citizen.pathIndex++;
    citizen.progress -= 1;
    // "Walked past a gravestone" → small Social hit
    applyGravestonePenalty(citizen, allCitizens, civ);
  }

  // Arrived?
  if (citizen.pathIndex >= citizen.path.length) {
    citizen.progress = 0;
    citizen.path = [];
    citizen.pathIndex = 0;

    if (citizen.state === "SEEK_FOOD" && citizen.targetBuildingId) {
      const target = buildings.find((b) => b.id === citizen.targetBuildingId);
      if (target && (target.typeId === "bakery" || target.typeId === "farm")) {
        citizen.hunger = 0;
      }
    } else if (citizen.state === "ROGUE") {
      // Steal! Drains the treasury and cures the crisis.
      const stolen = Math.min(ROGUE_STEAL_AMOUNT, civ.treasury);
      civ.treasury -= stolen;
      civ.resources.gold = civ.treasury; // keep the dual-tracked field in sync
      citizen.hunger = 0;
      citizen.crisisTimer = 0;
    }

    citizen.state = "IDLE";
    citizen.targetTile = undefined;
    citizen.targetBuildingId = undefined;
  }
}

/**
 * Smoothly interpolated position in (row, col) space.
 */
export function getCitizenVisualPos(citizen: Citizen): { row: number; col: number } {
  if (citizen.path.length === 0 || citizen.pathIndex >= citizen.path.length) {
    return { row: citizen.row, col: citizen.col };
  }
  const next = citizen.path[citizen.pathIndex];
  const p = citizen.progress;
  return {
    row: citizen.row + (next.row - citizen.row) * p,
    col: citizen.col + (next.col - citizen.col) * p,
  };
}
