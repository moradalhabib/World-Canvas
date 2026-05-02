import type { Building, Citizen, CitizenNeeds, Grid } from "./types";
import { findPath, isWalkable } from "./pathfinding";

/* -------------------------------------------------------------------------- */
/*  Spawning & creation                                                       */
/* -------------------------------------------------------------------------- */

let citizenCounter = 0;

function nextId(): string {
  citizenCounter++;
  return `npc_${Date.now().toString(36)}_${citizenCounter}`;
}

function randNeeds(): CitizenNeeds {
  // "Random baselines" per spec — keep all below the SEEK_FOOD threshold so
  // we get to watch the meter tick up before the first food run.
  return {
    hunger: 20 + Math.random() * 30, // 20-50
    safety: 20 + Math.random() * 30,
    social: 20 + Math.random() * 30,
    vanity: 10 + Math.random() * 20,
    faith: 10 + Math.random() * 20,
  };
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
    needs: randNeeds(),
    hue,
  };
}

/**
 * Spawn `count` citizens on walkable tiles near the given center point.
 * Uses a small expanding spiral so they don't all stack on the same tile.
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
        // Distinct hues per spawn for visual differentiation
        const hue = Math.round((out.length * 360) / count);
        out.push(createCitizen(r, c, hue));
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Per-month "brain" tick                                                    */
/* -------------------------------------------------------------------------- */

const HUNGER_RISE_PER_MONTH = 8; // base
const HUNGER_RISE_JITTER = 6; // +0..6 random
const HUNGER_SEEK_THRESHOLD = 70;

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
 * Run one game-month tick on the citizen's needs + decision-making.
 * If hunger crosses the threshold and the citizen is currently idle (or
 * already path-less while seeking), they plan a path to the nearest farm
 * or bakery and switch to SEEK_FOOD.
 */
export function tickCitizenMonth(
  citizen: Citizen,
  grid: Grid,
  buildings: Building[]
): void {
  citizen.needs.hunger = Math.min(
    100,
    citizen.needs.hunger + HUNGER_RISE_PER_MONTH + Math.random() * HUNGER_RISE_JITTER
  );
  citizen.needs.social = Math.min(100, citizen.needs.social + 2);
  citizen.needs.safety = Math.min(100, citizen.needs.safety + 1);

  // Don't replan mid-walk
  if (citizen.path.length > 0 && citizen.pathIndex < citizen.path.length) return;

  if (citizen.needs.hunger > HUNGER_SEEK_THRESHOLD) {
    const food = findNearestFood(citizen.row, citizen.col, buildings);
    if (!food) {
      // No food source exists yet — stay idle, hunger keeps climbing.
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
      // Unreachable
      citizen.state = "IDLE";
    }
  } else {
    citizen.state = "IDLE";
  }
}

/* -------------------------------------------------------------------------- */
/*  Per-frame movement update                                                 */
/* -------------------------------------------------------------------------- */

const TILES_PER_SECOND_AT_1X = 1.5;

/**
 * Advance the citizen's tile interpolation. When `progress` saturates we
 * snap to the next path tile and consume one path step. On arrival, eat
 * (reset hunger) and return to IDLE.
 */
export function updateCitizenMovement(
  citizen: Citizen,
  dtMs: number,
  timeScale: number,
  buildings: Building[]
): void {
  if (timeScale === 0) return;
  if (citizen.path.length === 0 || citizen.pathIndex >= citizen.path.length) return;

  citizen.state = citizen.state === "SEEK_FOOD" ? "SEEK_FOOD" : "MOVING";
  const tilesPerMs = (TILES_PER_SECOND_AT_1X / 1000) * timeScale;
  citizen.progress += dtMs * tilesPerMs;

  // Consume tiles while we have remaining budget
  while (citizen.progress >= 1 && citizen.pathIndex < citizen.path.length) {
    const next = citizen.path[citizen.pathIndex];
    citizen.row = next.row;
    citizen.col = next.col;
    citizen.pathIndex++;
    citizen.progress -= 1;
  }

  // Arrived?
  if (citizen.pathIndex >= citizen.path.length) {
    citizen.progress = 0;
    citizen.path = [];
    citizen.pathIndex = 0;

    // If we were heading to a food building (and it still exists), eat.
    if (citizen.state === "SEEK_FOOD" && citizen.targetBuildingId) {
      const target = buildings.find((b) => b.id === citizen.targetBuildingId);
      if (target && (target.typeId === "bakery" || target.typeId === "farm")) {
        citizen.needs.hunger = 0;
      }
    }

    citizen.state = "IDLE";
    citizen.targetTile = undefined;
    citizen.targetBuildingId = undefined;
  }
}

/**
 * Get the citizen's smooth visual position in (row, col) space, where
 * row/col are floats interpolated between the source tile and the next
 * path step.
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
