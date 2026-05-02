import type {
  Building,
  Citizen,
  CivilizationState,
  CitizenTrait,
  GameState,
  Grid,
  Profession,
} from "./types";
import { ALL_TRAITS } from "./types";
import { findPath, isWalkable } from "./pathfinding";
import {
  ELDER_AGE,
  ADULT_AGE,
  ageOf,
  getLifeStage,
  notifyDeath,
  pickName,
  pickSex,
  addChronicle,
} from "./royalty";

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
const ELDER_SPEED_MULTIPLIER = 0.7; // Phase 6: -30% movement for elders
const GRAVESTONE_PROXIMITY_RADIUS = 2; // tiles
const GRAVESTONE_SOCIAL_PENALTY = 0.5; // applied per tile-snap when near a grave

/* Phase 4: Economy & Factions tunables */
const GOODS_PER_MONTH_FARMER = 6;
const GOODS_PER_MONTH_MINER = 5;
const GUARD_STIPEND_VANITY = 1;       // tiny per-month vanity gain for guards
const VANITY_NOBLE_THRESHOLD = 50;    // peasant → noble visual upgrade
const VANITY_REBEL_THRESHOLD = 80;    // wealthy enough to bankroll rebellion
const HOUSE_DEPOSIT_RADIUS = 3;       // tiles — proximity for converting goods
const VANITY_PER_GOOD = 2;            // vanity per banked unit of goods
const TREASURY_PER_GOOD = 1;          // gold per banked unit of goods (civ tax)

/* Phase 9: Psychology & Mastery tunables */
const GRUDGE_OPINION = -100;        // score logged when an NPC witnesses an attack
const WITNESS_RADIUS = 5;           // tiles — bystanders within this range remember the attacker
const XP_PER_BANK = 10;             // xp granted on a successful goods → gold conversion
const XP_PER_LEVEL = 100;           // xp needed to level up
const ZEALOT_FAITH_DECAY = 0.5;     // per game-month
const NORMAL_FAITH_DECAY = 1;       // per game-month
const DILIGENT_HUNGER_MUL = 1.2;    // hunger rises 20% faster
const DILIGENT_YIELD_MUL = 1.15;    // base goods generation +15%
const GREEDY_NOBLE_MUL = 2;         // doubles VANITY_NOBLE_THRESHOLD before upgrade

/* Phase 6: Sleep & Safety */
const HOMELESS_SAFETY_PENALTY = 35;       // safety lost when sleeping outside
const SAFETY_RECOVERY_PER_NIGHT = 8;      // recovered when sleeping safely indoors
const LOW_SAFETY_REBEL_THRESHOLD = 25;    // below this, ROGUE becomes REBEL during civil war
const ASSASSINATION_RADIUS = 1;           // tiles — rebels at this range can kill the King

/* -------------------------------------------------------------------------- */
/*  Spawning & creation                                                       */
/* -------------------------------------------------------------------------- */

let citizenCounter = 0;

function nextId(): string {
  citizenCounter++;
  return `npc_${Date.now().toString(36)}_${citizenCounter}`;
}

export function createCitizen(
  row: number,
  col: number,
  hue: number,
  socialTier: Citizen["socialTier"] = "peasant",
  opts: { birthYear?: number; sex?: Citizen["sex"]; name?: string; profession?: Profession } = {}
): Citizen {
  const sex = opts.sex ?? pickSex();
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
    socialTier,
    name: opts.name ?? pickName(sex),
    sex,
    // Default to "born this year" for newborns; spawnInitialCitizens overrides
    // the founders so they start as adults.
    birthYear: opts.birthYear ?? 1,
    safety: 100,
    vanity: 0,
    profession: opts.profession ?? "None",
    goods: 0,
    faction: "neutral",
    // Phase 9: Pick a trait, init skills + empty memory graph.
    trait: ALL_TRAITS[Math.floor(Math.random() * ALL_TRAITS.length)],
    skills: { level: 1, xp: 0 },
    memory: {},
  };
}

/* -------------------------------------------------------------------------- */
/*  Phase 9: Memory graph helpers (O(1) lookup, exported for the engine)       */
/* -------------------------------------------------------------------------- */

/** Log a grudge from `victim` against `attackerId`. Idempotent. */
export function recordGrudge(victim: Citizen, attackerId: string): void {
  if (!victim.memory) victim.memory = {};
  // Use the worst (most negative) opinion we've ever held — never soften.
  const prev = victim.memory[attackerId] ?? 0;
  if (GRUDGE_OPINION < prev) victim.memory[attackerId] = GRUDGE_OPINION;
}

/** True if `c` holds a negative opinion of `otherId`. */
export function hasGrudge(c: Citizen, otherId: string): boolean {
  if (!c.memory) return false;
  return (c.memory[otherId] ?? 0) < 0;
}

/**
 * Phase 9: Spread the witness penalty for a freshly-started fight.
 * Every living NPC within WITNESS_RADIUS of either combatant logs a grudge
 * against both. Combatants always grudge each other directly.
 *
 * O(N) per call, but only fires once per fight (in startCombat) — never
 * per frame — so it does not affect the steady-state frame rate.
 */
export function recordCombatWitnesses(
  attacker: Citizen,
  defender: Citizen,
  allCitizens: Citizen[]
): void {
  recordGrudge(attacker, defender.id);
  recordGrudge(defender, attacker.id);
  for (const w of allCitizens) {
    if (w.state === "DEAD") continue;
    if (w.id === attacker.id || w.id === defender.id) continue;
    const dra = Math.abs(w.row - attacker.row);
    const dca = Math.abs(w.col - attacker.col);
    const drb = Math.abs(w.row - defender.row);
    const dcb = Math.abs(w.col - defender.col);
    if (Math.max(dra, dca) <= WITNESS_RADIUS) recordGrudge(w, attacker.id);
    if (Math.max(drb, dcb) <= WITNESS_RADIUS) recordGrudge(w, defender.id);
  }
}

/** Phase 4: deterministic-ish profession spread for adult founders. */
const PROFESSION_CYCLE: Profession[] = ["Farmer", "Farmer", "Miner", "Guard"];
function pickProfessionForIndex(i: number): Profession {
  return PROFESSION_CYCLE[i % PROFESSION_CYCLE.length];
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
        // First citizen is the King; ~15% of remainder are Nobles; rest peasants.
        const tier: Citizen["socialTier"] =
          out.length === 0 ? "king" : Math.random() < 0.15 ? "noble" : "peasant";
        // Founders start as adults — the King ~30, others 18-45 — so the
        // succession engine has a viable population from year 1.
        const founderAge =
          out.length === 0 ? 30 : 18 + Math.floor(Math.random() * 28);
        const birthYear = 1 - founderAge; // current gameYear is 1 at world start
        // Force first founder male so the auto-anointed monarch is a King by name.
        const sex: Citizen["sex"] | undefined = out.length === 0 ? "male" : undefined;
        // Phase 4: King has no profession; the rest cycle Farmer/Farmer/Miner/Guard.
        const profession: Profession =
          out.length === 0 ? "None" : pickProfessionForIndex(out.length - 1);
        out.push(createCitizen(r, c, hue, tier, { birthYear, sex, profession }));
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
    if (c.socialTier !== "king" && c.socialTier !== "noble" && c.socialTier !== "peasant") {
      c.socialTier = "peasant";
    }
    // Phase 3B backfill — older saves predate the lineage engine.
    if (c.sex !== "male" && c.sex !== "female") c.sex = pickSex();
    if (typeof c.name !== "string" || c.name.length === 0) c.name = pickName(c.sex);
    if (typeof c.birthYear !== "number") c.birthYear = 1;
    // Phase 6 backfill
    if (typeof c.safety !== "number") c.safety = 100;
    if (typeof c.vanity !== "number") c.vanity = 0;
    // Phase 4 backfill
    if (typeof c.goods !== "number") c.goods = 0;
    if (c.profession !== "Farmer" && c.profession !== "Miner" && c.profession !== "Guard" && c.profession !== "None") {
      c.profession = c.isKing ? "None" : pickProfessionForIndex(citizens.indexOf(c));
    }
    if (c.faction !== "rebel" && c.faction !== "royalist" && c.faction !== "neutral") {
      c.faction = "neutral";
    }
    // Phase 9 backfill — older saves predate trait/skills/memory.
    if (!c.trait || !ALL_TRAITS.includes(c.trait)) {
      c.trait = ALL_TRAITS[Math.floor(Math.random() * ALL_TRAITS.length)];
    }
    if (
      !c.skills ||
      typeof c.skills.level !== "number" ||
      typeof c.skills.xp !== "number"
    ) {
      c.skills = { level: 1, xp: 0 };
    }
    if (!c.memory || typeof c.memory !== "object" || Array.isArray(c.memory)) {
      c.memory = {};
    }
    // Legacy state values that no longer exist map to IDLE
    const validStates = new Set([
      "IDLE",
      "MOVING",
      "SEEK_FOOD",
      "PRAYING",
      "ROGUE",
      "DEAD",
      "WORKING",
      "MINISTERING",
      "SLEEPING",
      "REBEL",
      "COMBAT",
      "FLEEING",
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
/*  Phase 4: Economy + faction per-month tick                                 */
/* -------------------------------------------------------------------------- */

/**
 * Each game-month, working adults generate Goods. When they're standing within
 * HOUSE_DEPOSIT_RADIUS of any house they "return home", banking goods → personal
 * Vanity (gold) plus a small treasury contribution. High-Vanity NPCs visually
 * upgrade to the noble (middle/high-class) sprite. During a Civil War (HIGH
 * dissent) wealthy NPCs join the Rebellion and Guards remain Royalist.
 */
function tickEconomyAndFaction(
  citizen: Citizen,
  buildings: Building[],
  civ: CivilizationState,
  state: GameState
): void {
  const year = state.time.gameYear;
  const stage = getLifeStage(citizen, year);
  if (stage === "child") return;
  if (citizen.isKing || citizen.isQueen || citizen.isDowagerQueen) return;

  // 1) Production
  // Phase 9: mastery yield = (1 + level * 0.1); Diligent gets a flat +15%.
  const prof = citizen.profession ?? "None";
  const lvl = citizen.skills?.level ?? 1;
  const masteryMul = 1 + lvl * 0.1;
  const traitYieldMul = citizen.trait === "Diligent" ? DILIGENT_YIELD_MUL : 1;
  if (prof === "Farmer") {
    citizen.goods =
      (citizen.goods ?? 0) +
      GOODS_PER_MONTH_FARMER * masteryMul * traitYieldMul;
  } else if (prof === "Miner") {
    citizen.goods =
      (citizen.goods ?? 0) +
      GOODS_PER_MONTH_MINER * masteryMul * traitYieldMul;
  } else if (prof === "Guard") {
    // Guards are paid a small stipend out of the treasury — keeps them loyal.
    citizen.vanity = Math.min(999, citizen.vanity + GUARD_STIPEND_VANITY);
  }

  // 2) Banking — if near any house, convert goods → vanity + treasury
  if ((citizen.goods ?? 0) > 0) {
    let nearHouse = false;
    for (const b of buildings) {
      if (b.typeId !== "house_free" && b.typeId !== "house_middle" && b.typeId !== "house_high") continue;
      if (Math.abs(b.row - citizen.row) + Math.abs(b.col - citizen.col) <= HOUSE_DEPOSIT_RADIUS) {
        nearHouse = true;
        break;
      }
    }
    if (nearHouse) {
      const goods = citizen.goods ?? 0;
      citizen.vanity = Math.min(999, citizen.vanity + goods * VANITY_PER_GOOD);
      civ.treasury += goods * TREASURY_PER_GOOD;
      civ.resources.gold = civ.treasury;
      citizen.goods = 0;

      // Phase 9: a successful goods → gold conversion grants profession XP.
      // Only Farmers/Miners actually accumulate raw goods to bank, so guards
      // never level up here — that mirrors "their assigned profession".
      if (prof === "Farmer" || prof === "Miner") {
        if (!citizen.skills) citizen.skills = { level: 1, xp: 0 };
        citizen.skills.xp += XP_PER_BANK;
        if (citizen.skills.xp >= XP_PER_LEVEL) {
          citizen.skills.level += 1;
          citizen.skills.xp = 0;
          addChronicle(
            state,
            `${citizen.name} the ${prof} reaches mastery level ${citizen.skills.level}.`
          );
        }
      }
    }
  }

  // 3) Visual upgrade — wealthy commoners become Noble-class sprites.
  // Phase 9: Greedy NPCs require double the wealth to climb the social ladder.
  const nobleThreshold =
    VANITY_NOBLE_THRESHOLD * (citizen.trait === "Greedy" ? GREEDY_NOBLE_MUL : 1);
  if (citizen.socialTier === "peasant" && citizen.vanity >= nobleThreshold) {
    citizen.socialTier = "noble";
    addChronicle(state, `${citizen.name} has grown wealthy and risen to the noble class.`);
  }

  // 4) Faction allegiance — only meaningful during a Civil War.
  if (state.nobleDissent === "HIGH") {
    if (prof === "Guard" && citizen.vanity < VANITY_REBEL_THRESHOLD) {
      if (citizen.faction !== "royalist") {
        citizen.faction = "royalist";
      }
    } else if (citizen.vanity >= VANITY_REBEL_THRESHOLD) {
      if (citizen.faction !== "rebel") {
        citizen.faction = "rebel";
        citizen.isRebel = true;
        addChronicle(state, `${citizen.name} joins the Noble Rebellion.`);
      }
    }
  } else {
    citizen.faction = "neutral";
  }
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
  civ: CivilizationState,
  state?: GameState
): void {
  // --- 1. DEAD: completely inert -------------------------------------------
  if (citizen.state === "DEAD") return;

  // Phase 6: Sleeping NPCs are inert until woken at dawn.
  if (citizen.state === "SLEEPING") return;

  // Phase 4: Combat is resolved per-frame in the engine — skip the brain tick
  // so combatants don't wander off mid-fight.
  if (citizen.state === "COMBAT") return;

  // Phase 4: Economy + faction tick (runs every month for living adults).
  if (state) tickEconomyAndFaction(citizen, buildings, civ, state);

  // Phase 6: Children skip the work/crisis brain — they wander/idle. They
  // still age (birthYear) and can starve via civ-level food shortages.
  const year = state?.time.gameYear ?? 1;
  const stage = getLifeStage(citizen, year);
  if (stage === "child") {
    citizen.state = "IDLE";
    return;
  }

  // Phase 6: Promote ROGUE to REBEL when civil war is underway and the NPC
  // feels unsafe. REBELs behave like ROGUEs but are eligible to seize the
  // crown if they (or a comrade) topple the King.
  if (
    citizen.state === "ROGUE" &&
    state?.nobleDissent === "HIGH" &&
    citizen.safety <= LOW_SAFETY_REBEL_THRESHOLD &&
    !citizen.isKing
  ) {
    if (!citizen.isRebel) {
      citizen.isRebel = true;
      addChronicle(state, `${citizen.name} raises the banner of rebellion.`);
    }
    citizen.state = "REBEL";
  }

  // --- 2. Already in a crisis state: tick the death timer ------------------
  if (citizen.state === "PRAYING" || citizen.state === "ROGUE" || citizen.state === "REBEL") {
    citizen.crisisTimer += 1;
    if (citizen.crisisTimer > CRISIS_DEATH_TIMER) {
      // Starvation / consequence kicks in — they fall where they stand.
      citizen.state = "DEAD";
      citizen.path = [];
      citizen.pathIndex = 0;
      citizen.progress = 0;
      citizen.targetTile = undefined;
      citizen.targetBuildingId = undefined;
      // Notify royal succession if a monarch just fell.
      if (state) notifyDeath(state, citizen);
      return;
    }
    // ROGUE/REBEL: if they have no active path (target gone, etc.), try to repath.
    if ((citizen.state === "ROGUE" || citizen.state === "REBEL") && citizen.path.length === 0) {
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
  // Phase 5: Winter doubles the rate at which everyone gets hungry.
  // Phase 9: Diligent NPCs work harder and burn through food 20% faster.
  const winterMul = state?.winterActive ? 2 : 1;
  const traitHungerMul = citizen.trait === "Diligent" ? DILIGENT_HUNGER_MUL : 1;
  citizen.hunger = Math.min(
    100,
    citizen.hunger +
      HUNGER_RISE_PER_MONTH * winterMul * traitHungerMul +
      Math.random() * HUNGER_RISE_JITTER * winterMul * traitHungerMul
  );

  // Phase 9: Faith decays slowly; Zealots resist that decay (50% slower).
  // This is what gives Zealots their "always above PRAYING threshold" feel
  // — they tend to enter PRAYING (not ROGUE) when hunger maxes out.
  const faithDecay =
    citizen.trait === "Zealot" ? ZEALOT_FAITH_DECAY : NORMAL_FAITH_DECAY;
  citizen.faith = Math.max(0, citizen.faith - faithDecay);

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
  civ: CivilizationState,
  state?: GameState
): void {
  if (timeScale === 0) return;
  if (citizen.state === "DEAD" || citizen.state === "PRAYING" || citizen.state === "SLEEPING") return;
  if (citizen.path.length === 0 || citizen.pathIndex >= citizen.path.length) return;

  // SEEK_FOOD/ROGUE/REBEL/FLEEING keep their named state; otherwise mark MOVING for HUD
  if (
    citizen.state !== "SEEK_FOOD" &&
    citizen.state !== "ROGUE" &&
    citizen.state !== "REBEL" &&
    citizen.state !== "FLEEING"
  ) {
    citizen.state = "MOVING";
  }

  // Phase 6: Elders shuffle along at 70% speed.
  const year = state?.time.gameYear ?? 1;
  const speedMul =
    getLifeStage(citizen, year) === "elder" ? ELDER_SPEED_MULTIPLIER : 1;
  const tilesPerMs = (TILES_PER_SECOND_AT_1X / 1000) * timeScale * speedMul;
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
    } else if (citizen.state === "ROGUE" || citizen.state === "REBEL") {
      // Steal! Drains the treasury and cures the crisis.
      const stolen = Math.min(ROGUE_STEAL_AMOUNT, civ.treasury);
      civ.treasury -= stolen;
      civ.resources.gold = civ.treasury; // keep the dual-tracked field in sync
      citizen.vanity += stolen; // Phase 6: hoarded loot makes them a coronation candidate
      citizen.hunger = 0;
      citizen.crisisTimer = 0;

      // Phase 6: Assassination — a REBEL who reaches a tile within range of
      // the King (or Dowager Queen regent) topples them. Triggers rebellion
      // succession via succession() inside notifyDeath().
      if (citizen.state === "REBEL" && state) {
        for (const other of allCitizens) {
          if (other.state === "DEAD") continue;
          if (!other.isKing && !other.isDowagerQueen) continue;
          const dr = Math.abs(other.row - citizen.row);
          const dc = Math.abs(other.col - citizen.col);
          if (dr + dc <= ASSASSINATION_RADIUS) {
            const wasKing = !!other.isKing;
            other.state = "DEAD";
            other.path = [];
            other.pathIndex = 0;
            other.progress = 0;
            other.targetTile = undefined;
            other.targetBuildingId = undefined;
            addChronicle(
              state,
              `${citizen.name} cuts down ${wasKing ? "King" : "Dowager Queen"} ${other.name} in cold rebellion.`
            );
            notifyDeath(state, other);
            break;
          }
        }
      }
    }

    citizen.state = "IDLE";
    citizen.targetTile = undefined;
    citizen.targetBuildingId = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Phase 6: Sleep Protocol & Day/Night transitions                           */
/* -------------------------------------------------------------------------- */

/** Find nearest residential building. Returns null if none exist. */
function findNearestHome(
  row: number,
  col: number,
  buildings: Building[]
): Building | null {
  let best: Building | null = null;
  let bestDist = Infinity;
  for (const b of buildings) {
    if (b.typeId !== "house_free" && b.typeId !== "house_middle" && b.typeId !== "house_high") {
      continue;
    }
    const d = Math.abs(b.row - row) + Math.abs(b.col - col);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

/**
 * Called at the start of a Night month. All non-DEAD, non-King NPCs path to
 * the nearest residential building. Those who can't reach one sleep outside
 * and lose Safety, raising their odds of turning ROGUE/REBEL.
 *
 * Spec: "all non-guard NPCs enter a SLEEPING state". We treat the King and
 * Dowager Queen as the de-facto guards/defenders that don't sleep.
 */
export function processNightSleep(state: GameState, grid: Grid, buildings: Building[]): void {
  for (const c of state.citizens) {
    if (c.state === "DEAD") continue;
    if (c.isKing || c.isDowagerQueen) continue;
    if (c.state === "PRAYING") continue; // pious citizens kneel through the night

    const home = findNearestHome(c.row, c.col, buildings);
    if (!home) {
      // No residential building exists — entire town sleeps outside.
      c.safety = Math.max(0, c.safety - HOMELESS_SAFETY_PENALTY);
      c.state = "SLEEPING";
      c.path = [];
      c.pathIndex = 0;
      c.progress = 0;
      continue;
    }

    const path = findPath(grid, c.row, c.col, home.row, home.col);
    if (path && path.length > 0) {
      // Snap straight to home — sleep happens "by midnight".
      c.row = home.row;
      c.col = home.col;
      c.path = [];
      c.pathIndex = 0;
      c.progress = 0;
      c.state = "SLEEPING";
      c.homeBuildingId = home.id;
      c.safety = Math.min(100, c.safety + SAFETY_RECOVERY_PER_NIGHT);
    } else {
      // Unreachable home — slept in the gutter.
      c.safety = Math.max(0, c.safety - HOMELESS_SAFETY_PENALTY);
      c.state = "SLEEPING";
      c.path = [];
      c.pathIndex = 0;
      c.progress = 0;
    }
  }
}

/** Called at the start of a Day month. Wake everyone who was sleeping. */
export function processDayWake(state: GameState): void {
  for (const c of state.citizens) {
    if (c.state === "SLEEPING") c.state = "IDLE";
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
