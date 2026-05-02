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
import { createCitizen, pickLastName } from "./npc";
import { ALL_TRAITS } from "./types";
import type { CitizenTrait } from "./types";

/* -------------------------------------------------------------------------- */
/*  Tunables                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Phase 21: Aging accelerated to a Townsmen-style fast generational pace —
 * infants 0..2, children 2..5, adults 5..60, elders 60+. The previous
 * ADULT_AGE = 18 made dynasties move on real-time decade timescales; the
 * Phase 21 spec ("creative god-sim pacing, see lineages turn over") wants
 * children to mature into a working/marriageable adult after just three
 * game-years as a child. ELDER_AGE stays at 60 so the working-adult arc
 * is the longest stage (~55 game-years).
 */
export const ADULT_AGE = 5;
export const ELDER_AGE = 60;
export const VENERABLE_AGE = 75;                    // Phase 6: per-tick death chance kicks in
export const VENERABLE_DEATH_CHANCE = 0.18;         // Phase 6: per game-year roll past age 75
export const NATURAL_DEATH_AGE = 60;
export const NATURAL_DEATH_AGE_JITTER = 18;          // dies between 60–78
const ROYAL_FERTILITY_INTERVAL_YEARS = 10;
const ROYAL_FERTILITY_CHANCE = 0.65;
const QUEEN_MIN_AGE = 18;
const QUEEN_MAX_AGE = 40;
const CHRONICLE_CAP = 200;
const CHRONICLE_KEY = "god_sim_chronicle";

/* ---- Phase 6 / 20.6: Civilian reproduction tunables ---- */
const CIVILIAN_BREED_FOOD_PER_PERSON = 4;            // bread/person threshold
// Phase 20.6: doubled the breed chance and bumped the per-year cap. The
// God-Sim pacing target is "see babies in the houses" — at the previous
// 0.4 chance / 2 cap most realms only produced a child every 4-5 years
// once you accounted for adult-of-each-sex availability and food gating.
const CIVILIAN_BREED_CHANCE = 0.85;                  // per qualifying year
const CIVILIAN_BREED_MAX_PER_YEAR = 3;               // hard cap so it doesn't snowball
const CIVILIAN_BREED_MIN_MOOD = 40;                  // both parents need ≥40 mood
const CIVILIAN_BREED_HOUSE_RADIUS = 3;               // tiles — mother must be near a house

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
/*  Phase 12: Inherited Genetics (lastName + trait)                           */
/* -------------------------------------------------------------------------- */

/**
 * Phase 12: 50% probability the child inherits one parent's trait
 * (random of mother/father), otherwise a fresh random trait.
 *
 * Why 50/50: the spec wants visible familial traits ("the Greedy Bakers"
 * become a thing) without making every dynasty completely homogeneous.
 */
export function inheritTrait(
  mother: Citizen,
  father: Citizen | undefined
): CitizenTrait {
  if (Math.random() < 0.5) {
    const parentTraits: CitizenTrait[] = [];
    if (mother.trait) parentTraits.push(mother.trait);
    if (father?.trait) parentTraits.push(father.trait);
    if (parentTraits.length > 0) {
      return parentTraits[Math.floor(Math.random() * parentTraits.length)];
    }
  }
  return ALL_TRAITS[Math.floor(Math.random() * ALL_TRAITS.length)];
}

/**
 * Phase 12: Surnames pass matrilineally — every child takes the mother's
 * lastName. Falls back to a random one if the mother predates the Phase 12
 * migration and somehow lacks one.
 */
export function inheritLastName(mother: Citizen): string {
  return mother.lastName && mother.lastName.length > 0
    ? mother.lastName
    : pickLastName();
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

/** Phase 20.6: Infant cutoff. 0..2 game-years swaddled, no limbs, no work. */
export const INFANT_AGE = 2;

/** Phase 6 / 20.6: Map an NPC's age to a discrete life stage. */
export function getLifeStage(
  c: Citizen,
  currentYear: number
): "infant" | "child" | "adult" | "elder" {
  const age = ageOf(c, currentYear);
  if (age < INFANT_AGE) return "infant";
  if (age < ADULT_AGE) return "child";
  if (age >= ELDER_AGE) return "elder";
  return "adult";
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
  // Phase 12: heirs inherit the dynasty surname (the King's lastName) so
  // "House Crown" / "House Iron" emerges naturally. Trait inheritance follows
  // the same 50/50 inheritTrait rule as commoners.
  const baby = createCitizen(
    king.row,
    king.col,
    Math.floor(Math.random() * 360),
    "noble",
    {
      birthYear: state.time.gameYear,
      sex,
      name: pickName(sex),
      lastName: king.lastName ?? inheritLastName(queen),
      trait: inheritTrait(queen, king),
    }
  );
  baby.isPrince = true;
  baby.legitimacy = 100;
  state.citizens.push(baby);

  addChronicle(
    state,
    `An heir is born to King ${king.name} and Queen ${queen.name}: ${baby.name} ${baby.lastName ?? ""}`.trim() + "."
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
 * Phase 6: Rebellion coronation. If the realm is in a Civil War (HIGH dissent)
 * and at least one rebel survives, the wealthiest rebel (Vanity = personal
 * gold) seizes the crown. Returns true if a coronation happened.
 */
export function tryRebellionCoronation(state: GameState, deadMonarch: Citizen): boolean {
  if (state.nobleDissent !== "HIGH") return false;
  const rebels = state.citizens.filter(
    (c) => c.isRebel && c.state !== "DEAD" && c.id !== deadMonarch.id
  );
  if (rebels.length === 0) return false;

  // Pick the rebel with the highest Vanity (gold accumulated through theft).
  rebels.sort((a, b) => (b.vanity ?? 0) - (a.vanity ?? 0));
  const newKing = rebels[0];

  // Strip rebel flag, anoint as King, give crown sprite (via socialTier).
  newKing.isRebel = false;
  newKing.isKing = true;
  newKing.socialTier = "king";
  newKing.state = "IDLE";
  newKing.path = [];
  newKing.pathIndex = 0;
  newKing.targetTile = undefined;
  newKing.targetBuildingId = undefined;

  // Demote any other rebels — civil war is over, dynasty resets.
  for (const r of rebels) {
    if (r.id !== newKing.id) {
      r.isRebel = false;
      // Don't reset their state; they go back to whatever they were doing.
    }
  }

  state.nobleDissent = "LOW";
  addChronicle(
    state,
    `A new dynasty begins! The rebel ${newKing.name} seizes the crown by force after the fall of ${deadMonarch.name}.`
  );
  return true;
}

/**
 * Triggered from the death() event when the dying citizen was the King.
 *  - Adult heir present  → he becomes the new King.
 *  - Minor heir present  → spouse becomes Dowager Queen regent, dissent → HIGH.
 *  - No heir at all      → nearest noble adult is acclaimed (best-effort), or
 *                          the throne sits empty.
 */
export function succession(state: GameState, deadKing: Citizen): void {
  // Phase 6: A successful rebellion overrides all dynastic succession rules.
  if (tryRebellionCoronation(state, deadKing)) return;

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
    return;
  }

  // Phase 11 succession failsafe — rather than letting the throne sit empty
  // (which soft-locks the realm), elevate the surviving adult citizen with
  // the highest Vanity to King so the dynasty can endure.
  if (elevateHighestVanityToKing(state, deadKing.name)) return;

  // Absolute last resort: zero adults survive.
  state.nobleDissent = "HIGH";
  addChronicle(
    state,
    `King ${deadKing.name} has died. No heir survives. The throne stands empty.`
  );
}

/**
 * Phase 11: Pick the surviving adult citizen with the highest Vanity and
 * crown them. Used both as a succession last-resort and as a periodic
 * "soft-lock recovery" check (see `ensureMonarch`).
 *
 * Returns true if a citizen was elevated.
 */
function elevateHighestVanityToKing(state: GameState, deadKingName?: string): boolean {
  const currentYear = state.time.gameYear;
  const candidate = state.citizens
    .filter(
      (c) =>
        c.state !== "DEAD" &&
        !c.isKing &&
        ageOf(c, currentYear) >= ADULT_AGE
    )
    .sort((a, b) => (b.vanity ?? 0) - (a.vanity ?? 0))[0];
  if (!candidate) return false;

  // Strip any conflicting royal/rebel flags before crowning.
  candidate.isQueen = false;
  candidate.isDowagerQueen = false;
  candidate.isRebel = false;
  candidate.isKing = true;
  candidate.socialTier = "king";
  candidate.state = "IDLE";
  candidate.path = [];
  candidate.pathIndex = 0;
  candidate.progress = 0;
  candidate.targetTile = undefined;
  candidate.targetBuildingId = undefined;
  state.nobleDissent = "HIGH";
  addChronicle(
    state,
    deadKingName
      ? `King ${deadKingName} has died with no heir. ${candidate.name}, the most prominent commoner (Vanity ${Math.round(candidate.vanity ?? 0)}), is hastily elevated to the throne.`
      : `The throne stood empty. ${candidate.name}, the most prominent commoner (Vanity ${Math.round(candidate.vanity ?? 0)}), is acclaimed monarch by popular demand.`
  );
  return true;
}

/**
 * Phase 11: Defensive check called from the engine each year. If the throne
 * is currently empty (no living King), runs the highest-Vanity failsafe so
 * the realm can never permanently soft-lock on a no-heir extinction event.
 *
 * Safe to call every tick — it returns immediately if a King is alive.
 */
export function ensureMonarch(state: GameState): void {
  const livingKing = state.citizens.find(
    (c) => c.isKing && c.state !== "DEAD"
  );
  if (livingKing) return;
  elevateHighestVanityToKing(state);
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
    // Phase 6: Two-tier death model.
    //   age 60–78: legacy probabilistic death window
    //   age >= 75: per-tick venerable death roll (spec: "random chance each tick")
    const deathFloor = NATURAL_DEATH_AGE;
    const deathCeil = NATURAL_DEATH_AGE + NATURAL_DEATH_AGE_JITTER;
    let dies = false;
    if (age >= deathCeil) {
      dies = true;
    } else if (age >= VENERABLE_AGE) {
      dies = Math.random() < VENERABLE_DEATH_CHANCE;
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
  // Phase 6: Civilian breeding keeps the workforce alive when food is plentiful.
  tryCivilianReproduction(state, buildings);
  // Phase 21: Immigration. Once the realm reaches a high average mood and the
  // cooldown has elapsed, a small group of Grade-1 peasants arrives at the
  // map edge. Logged once: "Travelers drawn by our prosperity have arrived."
  tryImmigration(state, buildings);

  // Safety net: if there's no King but there are eligible adults, anoint one.
  if (!findKing(state.citizens)) {
    anointInitialKing(state);
  }
}

/* -------------------------------------------------------------------------- */
/*  Phase 21: Immigration                                                     */
/* -------------------------------------------------------------------------- */

/** Phase 21 immigration tunables. */
const IMMIGRATION_COOLDOWN_MIN_YEARS = 3;
const IMMIGRATION_COOLDOWN_JITTER_YEARS = 2; // total range 3..5 years
const IMMIGRATION_MOOD_THRESHOLD = 80;
const IMMIGRATION_MIN_PEASANTS = 1;
const IMMIGRATION_MAX_PEASANTS = 3;

/**
 * Phase 21: Once every 3-5 years, if the average mood across all living
 * citizens is above 80, spawn 1-3 Grade-1 peasants at a random grass tile
 * on the map edge. Logs a single Chronicle entry per wave. The cooldown
 * is sampled deterministically from `lastImmigrationYear` so a rapid
 * succession of high-mood years can't trigger every year.
 */
export function tryImmigration(state: GameState, buildings: Building[]): void {
  const year = state.time.gameYear;
  const elapsed = year - state.lastImmigrationYear;

  // Deterministic per-window jitter (0..2 extra years) so the cooldown
  // varies but doesn't re-roll every tick.
  const jitter =
    Math.floor((state.lastImmigrationYear * 31337) % (IMMIGRATION_COOLDOWN_JITTER_YEARS + 1));
  const required = IMMIGRATION_COOLDOWN_MIN_YEARS + jitter;
  if (elapsed < required) return;

  // Mood gate — happy realms attract migrants.
  const living = state.citizens.filter((c) => c.state !== "DEAD");
  if (living.length === 0) return;
  const avgMood = living.reduce((s, c) => s + (c.mood ?? 0), 0) / living.length;
  if (avgMood < IMMIGRATION_MOOD_THRESHOLD) return;

  // Pick a random spawn tile on the four map edges (grass only, so we
  // don't drop peasants in the middle of an ocean or on a mountain).
  // Also exclude tiles already occupied by a building or an animal so
  // immigrants don't materialize inside a wall or on top of a wolf.
  const { rows, cols, tiles } = state.grid;
  const occupied = new Set<string>();
  for (const b of buildings) occupied.add(`${b.row},${b.col}`);
  for (const a of state.animals ?? []) occupied.add(`${a.row},${a.col}`);
  const candidates: { row: number; col: number }[] = [];
  const tryAdd = (r: number, c: number) => {
    if (tiles[r]?.[c]?.type !== "grass") return;
    if (occupied.has(`${r},${c}`)) return;
    candidates.push({ row: r, col: c });
  };
  for (let c = 0; c < cols; c++) {
    tryAdd(0, c);
    tryAdd(rows - 1, c);
  }
  for (let r = 0; r < rows; r++) {
    tryAdd(r, 0);
    tryAdd(r, cols - 1);
  }
  if (candidates.length === 0) return;

  const count =
    IMMIGRATION_MIN_PEASANTS +
    Math.floor(Math.random() * (IMMIGRATION_MAX_PEASANTS - IMMIGRATION_MIN_PEASANTS + 1));

  for (let i = 0; i < count; i++) {
    const spawn = candidates[Math.floor(Math.random() * candidates.length)];
    // Spawn as already-adult peasants (birthYear backdated past ADULT_AGE)
    // so the new arrivals can immediately work + breed. Random age in the
    // young-adult band so they have decades of life ahead of them.
    const ageOnArrival = ADULT_AGE + Math.floor(Math.random() * 10);
    const peasant = createCitizen(
      spawn.row,
      spawn.col,
      Math.floor(Math.random() * 360),
      "peasant",
      { birthYear: year - ageOnArrival }
    );
    state.citizens.push(peasant);
  }

  addChronicle(state, "Travelers drawn by our prosperity have arrived.");
  state.lastImmigrationYear = year;
}

/* -------------------------------------------------------------------------- */
/*  Phase 6: Civilian reproduction                                            */
/* -------------------------------------------------------------------------- */

/**
 * If food is plentiful and there's residential capacity to spare, spawn a
 * Child to a pair of adult NPCs. Capped per year so a great harvest doesn't
 * explode the population.
 */
export function tryCivilianReproduction(state: GameState, buildings: Building[]): void {
  const civ = state.civilization;
  const adults = state.citizens.filter(
    (c) =>
      c.state !== "DEAD" &&
      ageOf(c, state.time.gameYear) >= ADULT_AGE &&
      ageOf(c, state.time.gameYear) < ELDER_AGE
  );
  if (adults.length < 2) return;

  // Food check: bread plus wheat as a buffer per person.
  const foodPerPerson =
    (civ.resources.bread + civ.resources.wheat * 0.5) /
    Math.max(1, state.citizens.filter((c) => c.state !== "DEAD").length);
  if (foodPerPerson < CIVILIAN_BREED_FOOD_PER_PERSON) return;

  // Housing check: total housing > living population.
  let totalHousing = 0;
  const houses: Building[] = [];
  for (const b of buildings) {
    if (b.typeId === "house_free") { totalHousing += 4; houses.push(b); }
    else if (b.typeId === "house_middle") { totalHousing += 6; houses.push(b); }
    else if (b.typeId === "house_high") { totalHousing += 8; houses.push(b); }
  }
  const living = state.citizens.filter((c) => c.state !== "DEAD").length;
  if (totalHousing <= living) return;
  if (houses.length === 0) return; // no homes → no mating

  // Phase 20.6: only adults that are (a) reasonably content (mood ≥ 40) and
  // (b) currently within HOUSE_RADIUS of at least one house qualify as
  // breeding candidates. This is the "in the same House at NIGHT" check from
  // the Dynasty spec, relaxed to "near a house with high enough mood" so it
  // works whether the year-tick happens to coincide with the night phase.
  const isNearHouse = (c: Citizen): boolean => {
    for (const h of houses) {
      if (Math.abs(h.row - c.row) + Math.abs(h.col - c.col) <= CIVILIAN_BREED_HOUSE_RADIUS) {
        return true;
      }
    }
    return false;
  };
  const eligible = adults.filter(
    (c) => (c.mood ?? 0) >= CIVILIAN_BREED_MIN_MOOD && isNearHouse(c)
  );
  if (eligible.length < 2) return;

  // Phase 20.6: birth chronicle uses the reigning King's name to honor the
  // user's exact spec wording ("A new soul, [Name], has joined the realm of
  // King [X]."). Falls back gracefully if the throne happens to be empty.
  const kingName = findKing(state.citizens)?.name ?? "the unknown";

  for (let i = 0; i < CIVILIAN_BREED_MAX_PER_YEAR; i++) {
    if (Math.random() > CIVILIAN_BREED_CHANCE) continue;
    // Pick two random eligible adults of opposite sex (best effort).
    const males = eligible.filter((c) => c.sex === "male");
    const females = eligible.filter((c) => c.sex === "female");
    if (males.length === 0 || females.length === 0) return;
    const father = males[Math.floor(Math.random() * males.length)];
    const mother = females[Math.floor(Math.random() * females.length)];

    const sex = pickSex();
    // Phase 12: inherit mother's lastName + a 50/50 chance of one parent's trait.
    const baby = createCitizen(
      mother.row,
      mother.col,
      Math.floor(Math.random() * 360),
      "peasant",
      {
        birthYear: state.time.gameYear,
        sex,
        name: pickName(sex),
        lastName: inheritLastName(mother),
        trait: inheritTrait(mother, father),
      }
    );
    state.citizens.push(baby);
    addChronicle(
      state,
      `A new soul, ${baby.name} ${baby.lastName}, has joined the realm of King ${kingName}.`.replace(/\s+/g, " ")
    );
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
