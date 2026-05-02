/**
 * Phase 3B: Royal Succession & Lineage Engine.
 *
 * Layered on top of the existing utility-AI / pathfinding NPC system. Owns:
 *   - The Anointing  : flag the first King + Queen at world start.
 *   - Royal Reproduction : every ~10 years, a chance for a Prince heir.
 *   - Heir Logic     : on adult age the Prince paths to the King to minister.
 *   - Succession     : when the King dies, an adult heir succeeds; a minor
 *                      heir triggers a Dowager Queen regency + HIGH dissent.
 *   - Chronicles     : a cumulative localStorage event log.
 */

import type {
  Building,
  Citizen,
  CivilizationState,
  GameState,
  Grid,
  ChronicleEntry,
} from "./types";
import { findPath } from "./pathfinding";
import { createCitizen } from "./npc";

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

export const ADULT_AGE = 18;
export const NATURAL_DEATH_AGE = 60;
export const NATURAL_DEATH_AGE_JITTER = 18;          // dies between 60–78
const ROYAL_FERTILITY_INTERVAL_YEARS = 10;
const ROYAL_FERTILITY_CHANCE = 0.65;
const QUEEN_MIN_AGE = 18;
const QUEEN_MAX_AGE = 40;
const CHRONICLE_CAP = 200;
const CHRONICLE_KEY = "god_sim_chronicle";

/* -------------------------------------------------------------------------- */
/*  Names                                                                     */
/* -------------------------------------------------------------------------- */

const MALE_NAMES = [
  "John", "Edward", "Henry", "William", "Richard", "Edmund",
  "Robert", "Charles", "Philip", "Alfred", "Magnus", "Otto",
];
const FEMALE_NAMES = [
  "Jane", "Eleanor", "Margaret", "Isabella", "Matilda", "Catherine",
  "Beatrice", "Elspeth", "Constance", "Adela", "Sigrid", "Helena",
];

export function pickName(sex: Citizen["sex"]): string {
  const pool = sex === "male" ? MALE_NAMES : FEMALE_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function pickSex(): Citizen["sex"] {
  return Math.random() < 0.5 ? "male" : "female";
}

/* -------------------------------------------------------------------------- */
/*  Chronicle                                                                 */
/* -------------------------------------------------------------------------- */

export function addChronicle(state: GameState, text: string): void {
  const entry: ChronicleEntry = {
    year: state.time.gameYear,
    month: state.time.gameMonth,
    text,
  };
  state.chronicle.push(entry);
  if (state.chronicle.length > CHRONICLE_CAP) {
    state.chronicle.splice(0, state.chronicle.length - CHRONICLE_CAP);
  }
  try {
    localStorage.setItem(CHRONICLE_KEY, JSON.stringify(state.chronicle));
  } catch {
    /* storage may be full or disabled — silently ignore */
  }
  // Surface in dev console for visibility while testing.
  // eslint-disable-next-line no-console
  console.log(`[Chronicle] Year ${entry.year}: ${text}`);
}

export function loadChronicle(): ChronicleEntry[] {
  try {
    const raw = localStorage.getItem(CHRONICLE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

export function ageOf(c: Citizen, currentYear: number): number {
  return Math.max(0, currentYear - c.birthYear);
}

export function findKing(citizens: Citizen[]): Citizen | undefined {
  return citizens.find((c) => c.isKing && c.state !== "DEAD");
}

export function findQueen(citizens: Citizen[]): Citizen | undefined {
  return citizens.find((c) => c.isQueen && c.state !== "DEAD");
}

export function findHeirs(citizens: Citizen[]): Citizen[] {
  return citizens.filter((c) => c.isPrince && c.state !== "DEAD");
}

/** Find the building that represents the King's seat — best high-class
 *  manor, otherwise the founded town center tile. */
function findKingsSeat(
  buildings: Building[],
  civ: CivilizationState
): { row: number; col: number } {
  const manor = buildings.find((b) => b.typeId === "house_high");
  if (manor) return { row: manor.row, col: manor.col };
  return { row: civ.founded.row, col: civ.founded.col };
}

/* -------------------------------------------------------------------------- */
/*  1. The Anointing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pick the first adult NPC and crown them King. If a suitable opposite-sex
 * adult exists, marry them as Queen. Idempotent — bails if a King already
 * reigns.
 */
export function anointInitialKing(state: GameState): void {
  if (findKing(state.citizens)) return;

  const currentYear = state.time.gameYear;
  const adults = state.citizens.filter(
    (c) => c.state !== "DEAD" && ageOf(c, currentYear) >= ADULT_AGE
  );
  // No adults? Just take the oldest non-dead candidate.
  const candidate =
    adults[0] ??
    [...state.citizens]
      .filter((c) => c.state !== "DEAD")
      .sort((a, b) => a.birthYear - b.birthYear)[0];
  if (!candidate) return;

  candidate.isKing = true;
  candidate.socialTier = "king";
  if (!candidate.name) candidate.name = pickName(candidate.sex);

  // Find a queen of opposite sex within marriageable age
  const queen = state.citizens.find(
    (c) =>
      c.id !== candidate.id &&
      c.state !== "DEAD" &&
      c.sex !== candidate.sex &&
      ageOf(c, currentYear) >= QUEEN_MIN_AGE &&
      ageOf(c, currentYear) <= QUEEN_MAX_AGE
  );
  if (queen) {
    queen.isQueen = true;
    queen.socialTier = "noble";
    queen.spouseId = candidate.id;
    candidate.spouseId = queen.id;
    if (!queen.name) queen.name = pickName(queen.sex);
  }

  addChronicle(
    state,
    queen
      ? `${capRoyal(candidate)} ${candidate.name} is anointed, with ${queen.name} as consort.`
      : `${capRoyal(candidate)} ${candidate.name} is anointed.`
  );
}

function capRoyal(c: Citizen): string {
  return c.sex === "male" ? "King" : "Queen";
}

/* -------------------------------------------------------------------------- */
/*  2. Royal Reproduction                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Once per game-year, with reproduction only firing every
 * ROYAL_FERTILITY_INTERVAL_YEARS, attempt to produce a Prince heir.
 */
export function tryRoyalReproduction(state: GameState): void {
  const king = findKing(state.citizens);
  const queen = findQueen(state.citizens);
  if (!king || !queen) return;
  if (state.time.gameYear % ROYAL_FERTILITY_INTERVAL_YEARS !== 0) return;
  if (Math.random() > ROYAL_FERTILITY_CHANCE) return;

  const sex = pickSex();
  const baby = createCitizen(king.row, king.col, Math.floor(Math.random() * 360), "noble");
  baby.name = pickName(sex);
  baby.sex = sex;
  baby.birthYear = state.time.gameYear;
  baby.isPrince = true;
  baby.legitimacy = 100;
  state.citizens.push(baby);

  addChronicle(
    state,
    `An heir is born to King ${king.name} and Queen ${queen.name}: ${baby.name}.`
  );
}

/* -------------------------------------------------------------------------- */
/*  3. Heir Logic — adult heirs path to the King's seat to minister           */
/* -------------------------------------------------------------------------- */

export function tickHeirDuties(
  state: GameState,
  grid: Grid,
  buildings: Building[],
  civ: CivilizationState
): void {
  const currentYear = state.time.gameYear;
  for (const heir of findHeirs(state.citizens)) {
    if (ageOf(heir, currentYear) < ADULT_AGE) continue;
    if (heir.state === "MINISTERING") continue;
    // Don't yank an heir out of an active food/crisis routine.
    if (heir.state === "SEEK_FOOD" || heir.state === "PRAYING" || heir.state === "ROGUE") continue;

    const seat = findKingsSeat(buildings, civ);
    const path = findPath(grid, heir.row, heir.col, seat.row, seat.col);
    if (path && path.length > 0) {
      heir.path = path;
      heir.pathIndex = 0;
      heir.progress = 0;
      heir.targetTile = { row: seat.row, col: seat.col };
      heir.state = "MINISTERING";
    } else {
      heir.state = "MINISTERING"; // still flagged even if unreachable
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  4. Succession                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Triggered from the death() event when the dying citizen was the King.
 *  - Adult heir present  → he becomes the new King.
 *  - Minor heir present  → spouse becomes Dowager Queen regent, dissent → HIGH.
 *  - No heir at all      → nearest noble adult is acclaimed (best-effort), or
 *                          the throne sits empty.
 */
export function succession(state: GameState, deadKing: Citizen): void {
  const currentYear = state.time.gameYear;
  const heirs = findHeirs(state.citizens).sort(
    (a, b) => ageOf(b, currentYear) - ageOf(a, currentYear)
  );
  const adultHeir = heirs.find((h) => ageOf(h, currentYear) >= ADULT_AGE);
  const minorHeir = !adultHeir && heirs.length > 0 ? heirs[0] : null;
  const queen = state.citizens.find(
    (c) => c.id === deadKing.spouseId && c.state !== "DEAD"
  );

  // Condition A — adult heir succeeds immediately.
  if (adultHeir) {
    adultHeir.isKing = true;
    adultHeir.isPrince = false;
    adultHeir.socialTier = "king";
    adultHeir.state = "IDLE";
    if (queen) {
      queen.isQueen = false;
      queen.isDowagerQueen = true;
    }
    addChronicle(
      state,
      `King ${deadKing.name} has died. ${capRoyal(adultHeir)} ${adultHeir.name} ascends the throne.`
    );
    return;
  }

  // Condition B — minor heir, spouse becomes Dowager Queen regent.
  if (minorHeir && queen) {
    queen.isQueen = false;
    queen.isDowagerQueen = true;
    state.nobleDissent = "HIGH";
    addChronicle(
      state,
      `King ${deadKing.name} has died. Dowager Queen ${queen.name} takes the throne as regent for young ${minorHeir.name}. The nobles grow restless.`
    );
    return;
  }

  // Condition C — no heir. A surviving adult noble is acclaimed if one exists.
  const noble = state.citizens.find(
    (c) =>
      c.state !== "DEAD" &&
      c.socialTier === "noble" &&
      ageOf(c, currentYear) >= ADULT_AGE &&
      !c.isKing
  );
  if (noble) {
    noble.isKing = true;
    noble.socialTier = "king";
    state.nobleDissent = "HIGH";
    addChronicle(
      state,
      `King ${deadKing.name} has died with no heir. ${capRoyal(noble)} ${noble.name} is acclaimed amid bitter dispute.`
    );
  } else {
    state.nobleDissent = "HIGH";
    addChronicle(
      state,
      `King ${deadKing.name} has died. No heir survives. The throne stands empty.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Yearly aging tick — natural death + succession trigger                    */
/* -------------------------------------------------------------------------- */

/**
 * Run once per game-year (called from the engine when gameYear changes).
 * Handles old-age deaths and triggers succession for the King.
 */
export function tickYear(
  state: GameState,
  grid: Grid,
  buildings: Building[],
  civ: CivilizationState
): void {
  const year = state.time.gameYear;

  for (const c of state.citizens) {
    if (c.state === "DEAD") continue;
    const age = ageOf(c, year);
    // Probabilistic natural death past the threshold.
    const deathFloor = NATURAL_DEATH_AGE;
    const deathCeil = NATURAL_DEATH_AGE + NATURAL_DEATH_AGE_JITTER;
    let dies = false;
    if (age >= deathCeil) {
      dies = true;
    } else if (age >= deathFloor) {
      const overshoot = (age - deathFloor) / (deathCeil - deathFloor);
      dies = Math.random() < overshoot * 0.5;
    }
    if (!dies) continue;

    const wasKing = !!c.isKing;
    c.state = "DEAD";
    c.path = [];
    c.pathIndex = 0;
    c.progress = 0;
    c.targetTile = undefined;
    c.targetBuildingId = undefined;
    c.deathYear = year;
    if (wasKing) {
      c.isKing = false;
      addChronicle(state, `${c.name}, the King, dies of old age (age ${age}).`);
      succession(state, c);
    } else if (c.isQueen) {
      c.isQueen = false;
      addChronicle(state, `Queen ${c.name} dies of old age (age ${age}).`);
    } else if (c.isDowagerQueen) {
      c.isDowagerQueen = false;
      addChronicle(state, `Dowager Queen ${c.name} dies of old age (age ${age}).`);
    }
  }

  // Heir maturity & royal reproduction run after deaths so a freshly-crowned
  // adult heir doesn't get re-pathed to themselves.
  tickHeirDuties(state, grid, buildings, civ);
  tryRoyalReproduction(state);

  // Safety net: if there's no King but there are eligible adults, anoint one.
  if (!findKing(state.citizens)) {
    anointInitialKing(state);
  }
}

/* -------------------------------------------------------------------------- */
/*  Death notification from other systems (e.g. starvation)                   */
/* -------------------------------------------------------------------------- */

/**
 * Other systems (starvation, future combat) call this immediately after they
 * mark a citizen DEAD, so royal succession can react to non-old-age deaths.
 */
export function notifyDeath(
  state: GameState,
  c: Citizen
): void {
  c.deathYear = state.time.gameYear;
  if (c.isKing) {
    c.isKing = false;
    addChronicle(state, `${c.name}, the King, has perished.`);
    succession(state, c);
  } else if (c.isQueen) {
    c.isQueen = false;
    addChronicle(state, `Queen ${c.name} has perished.`);
  }
}
