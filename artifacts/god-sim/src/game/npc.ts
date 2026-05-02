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

// Phase 11 balance pass: base hunger drain reduced ~30% (8→6 base, 6→4 jitter)
// so the town can survive the new Winter cycles without immediately starving.
const HUNGER_RISE_PER_MONTH = 6;
const HUNGER_RISE_JITTER = 4;
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
// Phase 11 balance pass: Farmer base yield +50% (6→9) so winter food stocks
// recover. Miners unchanged — diamond-tier yield is already steep with mastery.
const GOODS_PER_MONTH_FARMER = 9;
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
// Phase 11 balance pass: per-level XP cost lowered 100→40 so a working
// adult realistically reaches Mastery level 10 well before Elder age (60).
// At ~6 successful banks/year (factoring SEEK_FOOD/sleep interruptions), a
// citizen will hit level 10 in roughly 6 adult years and enjoy 35+ years
// of Mastery visuals (gold hoe, diamond pickaxe, plated guard shield).
const XP_PER_LEVEL = 40;            // xp needed to level up
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

/* Phase 12: Societal Fabric Engine tunables */
const MOOD_DRAIN_HUNGRY = 10;             // mood lost per month when hunger > 80
const MOOD_DRAIN_UNSAFE = 10;             // mood lost per month when safety < 20
const MOOD_BUFF_MASTERY = 5;              // mood gained per month at skill level 10+
const MOOD_REGEN_PER_MONTH = 2;           // passive mood regen when no stressor active
// Phase 13: climate-driven mood drain.
const MOOD_DRAIN_WINTER = 5;              // mood lost per month during natural Winter (doubled if homeless)
const MOOD_DRAIN_WET = 2;                 // mood lost per month when outdoors during rain/snow/thunderstorm
const MENTAL_BREAK_THIEF_STEAL = 100;     // gold a Greedy thief loots from treasury
const MENTAL_BREAK_RECLUSE_MONTHS = 3;    // months a Coward hides indoors before recovery
const DOOMSAYER_AURA_RADIUS = 3;          // tiles — drains -1 faith from each citizen in range
const RUMOR_MILL_INTERVAL_MS = 1000;      // ~60 ticks @ 60 FPS — proximity check cadence
const RUMOR_PROXIMITY_TILES = 2;          // chebyshev distance for two NPCs to chat
const RUMOR_CHAT_CHANCE = 0.10;           // 10% chance per qualifying pair per check
const RUMOR_CHAT_DURATION_MS = 2000;      // CHATTING state lifetime
const RUMOR_DISSENT_GAIN = 15;            // dissent added when rebel infects royalist
const RUMOR_DISSENT_FLIP = 80;            // dissent threshold to flip royalist → rebel
const RUMOR_DISSENT_FLIP_VANITY = 60;     // must also be wealthy enough to bankroll rebellion
const RUMOR_DISSENT_CHANCE = 0.25;        // 25% chance per chat
const RUMOR_HERETIC_FAITH_THRESHOLD = 20; // faith < this → counted as a "heretic" carrier
const RUMOR_HERETIC_FAITH_LOSS = 5;       // faith B loses when chatting with a heretic A

/* -------------------------------------------------------------------------- */
/*  Phase 12: Family surnames                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Phase 12: Pool of medieval English occupational/locative surnames.
 * Founders draw randomly; civilian children inherit their mother's.
 * Royal children inherit the dynasty surname (the King's lastName).
 */
export const LAST_NAMES: string[] = [
  "Baker", "Smith", "Iron", "Crown", "Stone", "Wood",
  "Fields", "Rivers", "Hill", "Cooper", "Mason", "Fletcher",
  "Ward", "Reeve", "Carter", "Tanner", "Thatcher", "Weaver",
  "Hunter", "Fisher", "Black", "White", "Gray", "Brown",
];

export function pickLastName(): string {
  return LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
}

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
  opts: {
    birthYear?: number;
    sex?: Citizen["sex"];
    name?: string;
    profession?: Profession;
    /** Phase 12: explicit surname (used by inheritance). Random if omitted. */
    lastName?: string;
    /** Phase 12: explicit trait (used by inheritance). Random if omitted. */
    trait?: CitizenTrait;
  } = {}
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
    trait: opts.trait ?? ALL_TRAITS[Math.floor(Math.random() * ALL_TRAITS.length)],
    skills: { level: 1, xp: 0 },
    memory: {},
    // Phase 12: family + psychology + contagion fields
    lastName: opts.lastName ?? pickLastName(),
    mood: 100,
    dissent: 0,
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
    // Phase 12 backfill — Societal Fabric Engine fields.
    if (typeof c.lastName !== "string" || c.lastName.length === 0) {
      c.lastName = pickLastName();
    }
    if (typeof c.mood !== "number" || c.mood < 0 || c.mood > 100) {
      c.mood = 100;
    }
    if (typeof c.dissent !== "number" || c.dissent < 0) {
      c.dissent = 0;
    }
    // Defensive: clear any partial Phase-12 transient state from a crashed save.
    if (c.state !== "MENTAL_BREAK") {
      c.breakKind = undefined;
      c.breakUntilMonth = undefined;
    }
    if (c.state !== "CHATTING") {
      c.chatUntilMs = undefined;
      c.chatPartnerId = undefined;
    } else if (typeof c.chatUntilMs !== "number") {
      // Save was persisted mid-chat with a corrupted timer — softlock guard:
      // drop them back to IDLE rather than leave them stuck speaking forever.
      c.state = "IDLE";
      c.chatPartnerId = undefined;
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
      "MENTAL_BREAK",
      "CHATTING",
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
    // Phase 13: per-citizen farmer yield is gated by the same seasonal cycle
    // that drives civic wheat production. Spring/Autumn = 1.5x harvest;
    // Summer = 1x; Winter = 0 (frozen ground). The Chronomancer Winter god
    // power also forces yield to 0 regardless of natural season.
    const season = state.currentSeason;
    const seasonMul = state.winterActive || season === "WINTER"
      ? 0
      : season === "SPRING" || season === "AUTUMN"
        ? 1.5
        : 1;
    citizen.goods =
      (citizen.goods ?? 0) +
      GOODS_PER_MONTH_FARMER * masteryMul * traitYieldMul * seasonMul;
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

  // ---- Phase 12: handle ongoing MENTAL_BREAK state (RECLUSE timer) -------
  // The THIEF break completes via the arrival branch in updateCitizenMovement.
  // The DOOMSAYER break exits when mood naturally regenerates above 20.
  // The RECLUSE break exits when its breakUntilMonth has elapsed.
  if (citizen.state === "MENTAL_BREAK") {
    const monthIdx = state ? state.time.gameYear * 12 + state.time.gameMonth : 0;
    if (citizen.breakKind === "RECLUSE") {
      if (typeof citizen.breakUntilMonth === "number" && monthIdx >= citizen.breakUntilMonth) {
        citizen.state = "IDLE";
        citizen.breakKind = undefined;
        citizen.breakUntilMonth = undefined;
        citizen.mood = 50; // post-recluse: stable but not euphoric
      }
      return; // recluses do not work / chat / repath while hiding
    }
    if (citizen.breakKind === "DOOMSAYER") {
      // Doomsayer slow recovery: +3 mood/month. Faith-drain aura is a
      // separate pass (see tickDoomsayerAura — runs once per simulated month).
      citizen.mood = Math.min(100, (citizen.mood ?? 0) + 3);
      if ((citizen.mood ?? 0) >= 25) {
        citizen.state = "IDLE";
        citizen.breakKind = undefined;
      }
      return;
    }
    // THIEF and any unknown breakKind fall through and let updateCitizenMovement
    // resolve them (path arrival → reset).
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

  // ---- Phase 12: Mood update + mental-break trigger ----------------------
  // Stressors drain mood. Mastery (level 10+) is a permanent passive buff.
  // No active stressor → mood naturally recovers a bit each month.
  let mood = typeof citizen.mood === "number" ? citizen.mood : 100;
  let stressed = false;
  if (citizen.hunger > 80) { mood -= MOOD_DRAIN_HUNGRY; stressed = true; }
  if (citizen.safety < 20) { mood -= MOOD_DRAIN_UNSAFE; stressed = true; }
  if ((citizen.skills?.level ?? 0) >= 10) mood += MOOD_BUFF_MASTERY;
  if (!stressed) mood += MOOD_REGEN_PER_MONTH;

  // ---- Phase 13: Climate-driven mood drain ------------------------------
  // Winter is harsh (-5/month). The homeless catch a double penalty because
  // they have no warm house to retreat into. Rain/snow adds a "wet &
  // miserable" -2 drain whenever the citizen is outdoors at the moment of
  // the monthly tick (SLEEPING citizens are tucked safely into their home).
  if (state) {
    const naturalWinter = state.currentSeason === "WINTER";
    if (naturalWinter || state.winterActive) {
      const homeless = !citizen.homeBuildingId;
      mood -= MOOD_DRAIN_WINTER * (homeless ? 2 : 1);
      stressed = true;
    }
    // Anyone reaching this branch already passed the SLEEPING early-return
    // up top, so they're definitionally outdoors when the monthly tick fires.
    const wet =
      state.currentWeather === "RAIN" ||
      state.currentWeather === "SNOW" ||
      state.currentWeather === "THUNDERSTORM";
    if (wet) {
      mood -= MOOD_DRAIN_WET;
      stressed = true;
    }
  }

  citizen.mood = Math.max(0, Math.min(100, mood));

  if (citizen.mood === 0 && state) {
    triggerMentalBreak(citizen, grid, buildings, civ, state);
    return; // mental break resolves on its own; skip the SEEK_FOOD branch
  }

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

  // Phase 12: CHATTING NPCs stand still until their chat timer expires.
  // The pair was symmetrically set in runRumorMill; we exit independently
  // (no need to coordinate — the partner exits on their own next tick).
  if (citizen.state === "CHATTING") {
    const now = state?.time.totalRealMs ?? performance.now();
    if (typeof citizen.chatUntilMs === "number" && now >= citizen.chatUntilMs) {
      citizen.state = "IDLE";
      citizen.chatUntilMs = undefined;
      citizen.chatPartnerId = undefined;
    }
    return;
  }

  if (citizen.path.length === 0 || citizen.pathIndex >= citizen.path.length) return;

  // SEEK_FOOD/ROGUE/REBEL/FLEEING/MENTAL_BREAK keep their named state for the
  // HUD + render overlays; everything else gets the generic MOVING tag while
  // walking. (Phase 12: MENTAL_BREAK preserved so the THIEF/RECLUSE overlays
  // stay visible while the NPC is in transit toward their target.)
  if (
    citizen.state !== "SEEK_FOOD" &&
    citizen.state !== "ROGUE" &&
    citizen.state !== "REBEL" &&
    citizen.state !== "FLEEING" &&
    citizen.state !== "MENTAL_BREAK"
  ) {
    citizen.state = "MOVING";
  }

  // Phase 6: Elders shuffle along at 70% speed.
  const year = state?.time.gameYear ?? 1;
  let speedMul =
    getLifeStage(citizen, year) === "elder" ? ELDER_SPEED_MULTIPLIER : 1;
  // Phase 13: rain/snow/thunderstorm slows outdoor movement by 10%. SLEEPING
  // citizens never tick into this branch (tickCitizenMonth early-returns)
  // so we don't need an indoor check here — anyone walking IS outdoors.
  if (
    state &&
    (state.currentWeather === "RAIN" ||
      state.currentWeather === "SNOW" ||
      state.currentWeather === "THUNDERSTORM")
  ) {
    speedMul *= 0.9;
  }
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

    // Phase 12: THIEF mental break completes on arrival at the treasury.
    // Drain 100 gold from the treasury, convert to personal vanity, restore
    // mood enough that they exit the break, and reset to IDLE. We key on
    // breakKind (not state) because state was set to MENTAL_BREAK earlier and
    // either preserved or transparently widened through the move loop.
    if (citizen.breakKind === "THIEF") {
      const stolen = Math.min(MENTAL_BREAK_THIEF_STEAL, civ.treasury);
      civ.treasury -= stolen;
      civ.resources.gold = civ.treasury;
      citizen.vanity = Math.min(999, citizen.vanity + stolen);
      citizen.mood = 60;
      citizen.breakKind = undefined;
      if (state && stolen > 0) {
        addChronicle(
          state,
          `${citizen.name} ${citizen.lastName ?? ""}, snapped by greed, plunders ${stolen} gold from the treasury.`.replace(/\s+/g, " ")
        );
      }
    }

    // Phase 12 fix: a RECLUSE arriving home must STAY in MENTAL_BREAK so
    // their 3-month hide timer (handled by tickCitizenMonth) can run. If we
    // reset to IDLE here, the Coward instantly recovers the moment the path
    // ends, violating the spec.
    if (citizen.breakKind === "RECLUSE") {
      citizen.targetTile = undefined;
      citizen.targetBuildingId = undefined;
      return;
    }

    citizen.state = "IDLE";
    citizen.targetTile = undefined;
    citizen.targetBuildingId = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Phase 12: Societal Fabric Engine — Mental Breaks                          */
/* -------------------------------------------------------------------------- */

/**
 * Phase 12: When a citizen's mood hits 0, branch into a trait-driven break:
 *   • Zealot   → DOOMSAYER  (wanders, drains nearby faith)
 *   • Coward   → RECLUSE    (paths to nearest house, hides for 3 months)
 *   • Greedy   → THIEF      (paths to treasury, loots 100 gold on arrival)
 *   • Diligent → no break, just regen mood (handled by caller)
 */
function triggerMentalBreak(
  citizen: Citizen,
  grid: Grid,
  buildings: Building[],
  civ: CivilizationState,
  state: GameState
): void {
  // Diligent NPCs are mentally tough — no break, just bounce mood up so they
  // don't sit at 0 and re-trigger every tick.
  if (citizen.trait === "Diligent" || !citizen.trait) {
    citizen.mood = 25;
    return;
  }

  if (citizen.trait === "Zealot") {
    citizen.state = "MENTAL_BREAK";
    citizen.breakKind = "DOOMSAYER";
    citizen.path = [];
    citizen.pathIndex = 0;
    citizen.progress = 0;
    citizen.targetTile = undefined;
    citizen.targetBuildingId = undefined;
    addChronicle(
      state,
      `${citizen.name} ${citizen.lastName ?? ""} has lost their faith and now wanders preaching doom.`.replace(/\s+/g, " ")
    );
    return;
  }

  if (citizen.trait === "Coward") {
    const home = findNearestHome(citizen.row, citizen.col, buildings);
    citizen.state = "MENTAL_BREAK";
    citizen.breakKind = "RECLUSE";
    citizen.breakUntilMonth =
      state.time.gameYear * 12 + state.time.gameMonth + MENTAL_BREAK_RECLUSE_MONTHS;
    if (home) {
      const path = findPath(grid, citizen.row, citizen.col, home.row, home.col);
      if (path && path.length > 0) {
        citizen.path = path;
        citizen.pathIndex = 0;
        citizen.progress = 0;
        citizen.targetTile = { row: home.row, col: home.col };
        citizen.targetBuildingId = home.id;
        citizen.homeBuildingId = home.id;
      } else {
        citizen.path = [];
        citizen.pathIndex = 0;
      }
    }
    addChronicle(
      state,
      `${citizen.name} ${citizen.lastName ?? ""}, overcome with fear, has shut themselves indoors.`.replace(/\s+/g, " ")
    );
    return;
  }

  if (citizen.trait === "Greedy") {
    citizen.state = "MENTAL_BREAK";
    citizen.breakKind = "THIEF";
    const target = { row: civ.founded.row, col: civ.founded.col };
    const path = findPath(grid, citizen.row, citizen.col, target.row, target.col);
    if (path && path.length > 0) {
      citizen.path = path;
      citizen.pathIndex = 0;
      citizen.progress = 0;
      citizen.targetTile = target;
      citizen.targetBuildingId = undefined;
    } else {
      // Unreachable treasury — abort the break gracefully.
      citizen.state = "IDLE";
      citizen.breakKind = undefined;
      citizen.mood = 25;
    }
    return;
  }

  // Defensive fallback for any future trait we haven't handled here.
  citizen.mood = 25;
}

/**
 * Phase 12: Once-per-month aura tick. Every active DOOMSAYER drains 1 faith
 * from each living citizen within DOOMSAYER_AURA_RADIUS tiles. O(D × N) where
 * D is the (typically tiny) doomsayer count, so steady-state cost is fine.
 */
export function tickDoomsayerAura(state: GameState): void {
  const doomsayers = state.citizens.filter(
    (c) => c.state === "MENTAL_BREAK" && c.breakKind === "DOOMSAYER"
  );
  if (doomsayers.length === 0) return;
  for (const d of doomsayers) {
    for (const other of state.citizens) {
      if (other.id === d.id) continue;
      if (other.state === "DEAD") continue;
      const dr = Math.abs(other.row - d.row);
      const dc = Math.abs(other.col - d.col);
      if (Math.max(dr, dc) <= DOOMSAYER_AURA_RADIUS) {
        other.faith = Math.max(0, other.faith - 1);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Phase 12: Societal Fabric Engine — Rumor Mill (social contagion)          */
/* -------------------------------------------------------------------------- */

/**
 * Phase 12: Rumor mill proximity check. Designed to run AT MOST once every
 * RUMOR_MILL_INTERVAL_MS (≈ 1 second / 60 ticks at 60 FPS) — the engine loop
 * gates the call cadence, NOT this function. If you call me every frame
 * you will tank performance.
 *
 * Optimization strategy:
 *   1. Bucket every IDLE/MOVING citizen into a 2-tile spatial hash so we
 *      check at most the 9 neighboring buckets, not the full N² cross-product.
 *   2. Inside a bucket, pair-check is still O(k²) per bucket but k is small
 *      (typically 1–3 NPCs share a bucket).
 *   3. Citizens already CHATTING / MENTAL_BREAK / DEAD are skipped early.
 *
 * On a successful chat:
 *   • Both NPCs flip to CHATTING for RUMOR_CHAT_DURATION_MS milliseconds.
 *   • Contagion is applied symmetrically (A → B and B → A).
 */
export function runRumorMill(state: GameState): void {
  const now = state.time.totalRealMs;
  // 1) Build the spatial hash. Bucket size = 2 tiles (matches proximity).
  const BUCKET = 2;
  const buckets = new Map<string, Citizen[]>();
  const eligible: Citizen[] = [];
  for (const c of state.citizens) {
    if (c.state !== "IDLE" && c.state !== "MOVING") continue;
    eligible.push(c);
    const key = `${Math.floor(c.row / BUCKET)},${Math.floor(c.col / BUCKET)}`;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(c);
  }
  if (eligible.length < 2) return;

  // 2) For each eligible citizen, check the 9 neighboring buckets.
  // Use a "pair seen" set keyed by sorted-id so we don't double-process.
  const seen = new Set<string>();
  for (const a of eligible) {
    if (a.state === "CHATTING") continue; // freshly flipped this pass
    const br = Math.floor(a.row / BUCKET);
    const bc = Math.floor(a.col / BUCKET);
    for (let dbr = -1; dbr <= 1; dbr++) {
      for (let dbc = -1; dbc <= 1; dbc++) {
        const neighbors = buckets.get(`${br + dbr},${bc + dbc}`);
        if (!neighbors) continue;
        for (const b of neighbors) {
          if (b.id === a.id) continue;
          if (b.state === "CHATTING") continue;
          // Stable pair key — ids in lexical order — so A↔B is processed once.
          const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          // Final geometric check (chebyshev distance).
          const dr = Math.abs(a.row - b.row);
          const dc = Math.abs(a.col - b.col);
          if (Math.max(dr, dc) > RUMOR_PROXIMITY_TILES) continue;
          if (Math.random() > RUMOR_CHAT_CHANCE) continue;
          // Flip both into CHATTING and apply contagion symmetrically.
          startChat(a, b, now);
          applyContagion(a, b);
          applyContagion(b, a);
        }
      }
    }
  }
}

/** Phase 12: symmetric CHATTING transition. */
function startChat(a: Citizen, b: Citizen, nowMs: number): void {
  const until = nowMs + RUMOR_CHAT_DURATION_MS;
  // Preserve any active path so they resume walking after the chat.
  a.state = "CHATTING";
  a.chatUntilMs = until;
  a.chatPartnerId = b.id;
  b.state = "CHATTING";
  b.chatUntilMs = until;
  b.chatPartnerId = a.id;
}

/**
 * Phase 12: Contagion from carrier `from` → susceptible `to`.
 *  • Rebel → Royalist : 25% chance to add dissent. At ≥80 dissent + ≥60
 *    vanity, the royalist flips to rebel (joins the rebellion).
 *  • Heretic (faith < 20) → believer : -5 faith.
 */
function applyContagion(from: Citizen, to: Citizen): void {
  // Rebellion contagion
  if (from.faction === "rebel" && to.faction === "royalist") {
    if (Math.random() < RUMOR_DISSENT_CHANCE) {
      to.dissent = Math.min(100, (to.dissent ?? 0) + RUMOR_DISSENT_GAIN);
      if ((to.dissent ?? 0) >= RUMOR_DISSENT_FLIP && (to.vanity ?? 0) >= RUMOR_DISSENT_FLIP_VANITY) {
        to.faction = "rebel";
        to.isRebel = true;
      }
    }
  }
  // Faith contagion (heresy spreads from low-faith carriers)
  if (from.faith < RUMOR_HERETIC_FAITH_THRESHOLD && to.faith >= RUMOR_HERETIC_FAITH_THRESHOLD) {
    to.faith = Math.max(0, to.faith - RUMOR_HERETIC_FAITH_LOSS);
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

/* -------------------------------------------------------------------------- */
/*  Phase 13: Lightning trauma — adjacent NPCs to a strike are scared into    */
/*  FLEEING with mood crashed to 0. Returns the citizens that were affected   */
/*  so the caller can chronicle the event.                                    */
/* -------------------------------------------------------------------------- */

export function traumatizeAdjacent(
  state: GameState,
  strikeCol: number,
  strikeRow: number
): Citizen[] {
  const victims: Citizen[] = [];
  for (const c of state.citizens) {
    if (c.state === "DEAD" || c.state === "SLEEPING") continue;
    if (c.isKing) continue; // the king is shielded by his palace's lightning rod
    const dx = Math.abs(c.col - strikeCol);
    const dy = Math.abs(c.row - strikeRow);
    if (dx > 1 || dy > 1) continue;
    c.mood = 0;
    c.state = "FLEEING";
    c.progress = 0;
    c.targetBuildingId = undefined;
    // Clear any stale Phase-12 transient fields so the FLEEING state is clean.
    c.breakKind = undefined;
    c.breakUntilMonth = undefined;
    c.chatUntilMs = undefined;
    c.chatPartnerId = undefined;

    // Compute an actual flee path: pick a goal tile a few steps in the
    // direction OPPOSITE the strike, clamped to the grid, then progressively
    // shorten the radius until findPath returns a walkable destination.
    // Without a real path, the citizen would just sit in FLEEING.
    const grid = state.grid;
    const fleeVecCol = c.col - strikeCol; // points away from strike
    const fleeVecRow = c.row - strikeRow;
    // If the citizen is exactly on the strike tile, jitter randomly so we
    // don't divide by zero / pick a self-targeted path.
    const vc = fleeVecCol === 0 && fleeVecRow === 0
      ? (Math.random() < 0.5 ? -1 : 1)
      : fleeVecCol;
    const vr = fleeVecCol === 0 && fleeVecRow === 0
      ? (Math.random() < 0.5 ? -1 : 1)
      : fleeVecRow;
    const mag = Math.max(1, Math.abs(vc) + Math.abs(vr));
    let assigned = false;
    for (const radius of [6, 4, 3, 2]) {
      const goalCol = Math.max(0, Math.min(grid.cols - 1,
        Math.round(c.col + (vc / mag) * radius)));
      const goalRow = Math.max(0, Math.min(grid.rows - 1,
        Math.round(c.row + (vr / mag) * radius)));
      if (!isWalkable(grid, goalRow, goalCol)) continue;
      const path = findPath(grid, c.row, c.col, goalRow, goalCol);
      if (path && path.length > 0) {
        c.path = path;
        c.pathIndex = 0;
        c.targetTile = { row: goalRow, col: goalCol };
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      // Fallback: clear path so existing FLEEING handler can re-plan next tick.
      c.path = [];
      c.pathIndex = 0;
      c.targetTile = undefined;
    }
    victims.push(c);
  }
  return victims;
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
