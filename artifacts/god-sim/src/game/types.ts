export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type TileType =
  | "grass"
  | "water"
  | "forest"
  | "mountain"
  | "desert"
  | "snow"
  /** Phase 5: Wrath crater — burnt scar left by a meteor strike. */
  | "crater";

export interface Tile {
  type: TileType;
  elevation: number;
  fertility: number;
}

export interface Grid {
  cols: number;
  rows: number;
  tileSize: number;
  tiles: Tile[][];
}

export interface TimeState {
  gameMonth: number;
  gameYear: number;
  timeScale: 0 | 1 | 2;
  lastSavedTimestamp: number;
  totalRealMs: number;
}

export interface GameState {
  version: number;
  camera: Camera;
  time: TimeState;
  grid: Grid;
  buildings: Building[];
  civilization: CivilizationState;
  citizens: Citizen[];
  /** Phase 3B: Political tension among nobles. HIGH unlocks the future Civil War mechanic. */
  nobleDissent: "LOW" | "MEDIUM" | "HIGH";
  /** Phase 3B: In-memory mirror of the localStorage chronicle (capped). */
  chronicle: ChronicleEntry[];
  /** Phase 3B: Last year aging/reproduction tick was processed (so we run once per game-year). */
  lastRoyalYearTicked: number;
  /** Phase 6: Day/Night cycle. 1 game-month = day, next = night, alternating. */
  dayNight: "day" | "night";
  /** Phase 6: Last absolute month (year*12+month) at which the day/night phase flipped. */
  lastDayNightFlipMonth: number;
  /** Phase 5: Chronomancer Winter mode — halts crops and doubles hunger. */
  winterActive: boolean;
  /* -- Phase 13: Dynamic Climate & Ecosystem Engine -- */
  /** Macro-cycle derived from gameMonth (Mar-May Spring, Jun-Aug Summer, Sep-Nov Autumn, Dec-Feb Winter). */
  currentSeason: Season;
  /** Current weather state. Re-rolled at the start of each game-day (dawn). */
  currentWeather: WeatherKind;
  /** Absolute month index (year * 12 + month) at which weather was last re-rolled. */
  lastWeatherRollMonth: number;
}

/* ── Phase 13: Dynamic Climate & Ecosystem Engine ── */

export type Season = "SPRING" | "SUMMER" | "AUTUMN" | "WINTER";

export type WeatherKind = "CLEAR" | "RAIN" | "SNOW" | "THUNDERSTORM";

/**
 * Lightweight particle for the weather VFX pool. Rendered in screen-space
 * (no camera transform) so wind/snow direction is independent of pan/zoom.
 * Capped at PARTICLE_MAX in GameEngine to protect mobile FPS.
 */
export interface Particle {
  kind: "rain" | "snow";
  /** Screen-space pixel coordinates. */
  x: number;
  y: number;
  /** Pixel velocity per millisecond. */
  vx: number;
  vy: number;
  /** Snow only: anchor x for the sine wobble. */
  baseX?: number;
  /** Snow only: wobble phase in radians. */
  phase?: number;
}

export const TILE_COLORS: Record<TileType, string> = {
  grass: "#4a7c3f",
  water: "#2b6cb0",
  forest: "#276749",
  mountain: "#718096",
  desert: "#d69e2e",
  snow: "#e2e8f0",
  crater: "#2a1410",
};

export const TILE_BORDER_COLORS: Record<TileType, string> = {
  grass: "#38643a",
  water: "#2c5282",
  forest: "#1d5633",
  mountain: "#4a5568",
  desert: "#b7791f",
  snow: "#cbd5e0",
  crater: "#1a0a08",
};

export const TILE_SPECKLE_COLORS: Record<TileType, [string, string]> = {
  grass: ["#5a8f4a", "#3d6b35"],
  water: ["#4a8fd6", "#1f4f8a"],
  forest: ["#2f7a52", "#194226"],
  mountain: ["#8b95a3", "#5a6472"],
  desert: ["#e8b85a", "#b8801a"],
  snow: ["#ffffff", "#b5c2d1"],
  crater: ["#5c2a1a", "#1a0606"],
};

export const SPECKLE_DENSITY: Record<TileType, number> = {
  grass: 60,
  water: 18,
  forest: 80,
  mountain: 50,
  desert: 40,
  snow: 25,
  crater: 90,
};

export const TRANSITION_COLORS: Partial<Record<string, string>> = {
  "water|grass": "#d4b88e",
  "water|forest": "#a89066",
  "water|desert": "#e0c690",
  "water|mountain": "#7a8590",
  "water|snow": "#c4d0dc",
  "grass|desert": "#a89856",
  "grass|mountain": "#6e7860",
  "forest|desert": "#9a8a4f",
  "mountain|snow": "#c0c8d5",
  "desert|mountain": "#9a8866",
};

export function getTransitionColor(a: TileType, b: TileType): string | null {
  if (a === b) return null;
  return (
    TRANSITION_COLORS[`${a}|${b}`] ??
    TRANSITION_COLORS[`${b}|${a}`] ??
    null
  );
}

/* ========================================================================== */
/*  Phase 2: Resources, Buildings, Civilization, Utility AI                   */
/* ========================================================================== */

export type Resource = "wheat" | "bread" | "wood" | "stone" | "gold";

export const ALL_RESOURCES: Resource[] = ["wheat", "bread", "wood", "stone", "gold"];

export type SocialTier = "free" | "middle" | "high";

export type BuildingId =
  | "house_free"
  | "house_middle"
  | "house_high"
  | "farm"
  | "bakery"
  | "lumber_camp"
  | "mine"
  | "well";

export type BuildingCategory = "residential" | "production" | "service";

export interface BuildingDef {
  id: BuildingId;
  name: string;
  category: BuildingCategory;
  tier: SocialTier;
  /** Tile types this building can be placed on. */
  validOn: TileType[];
  /** Requires at least one neighbor of these tile types (within 1 tile). */
  requiredAdjacent?: TileType[];
  /** Build cost paid from civilization treasury/resources. */
  buildCost: Partial<Record<Resource, number>>;
  /** Per-month consumption (must be available or production halves). */
  consumes: Partial<Record<Resource, number>>;
  /** Per-month production (when consumption is met). */
  produces: Partial<Record<Resource, number>>;
  /** Gold tax generated per month (when staffed/served). */
  taxes: number;
  /** People housed (residential only). */
  housing: number;
  /** Worker slots required. */
  workers: number;
  /** Desirability contribution (per tile within radius). */
  desirability: number;
  desirabilityRadius: number;
  /** Visuals. */
  fillColor: string;
  roofColor: string;
  glyph: string;
  /** What needs this building satisfies, used by utility AI. */
  satisfies: Partial<Record<NeedType, number>>;
}

export interface Building {
  id: string;
  typeId: BuildingId;
  row: number;
  col: number;
  builtMonth: number;
  /** Cached desirability score at last evaluation, for HUD/debug. */
  lastDesirability: number;
  /** Phase 5: "rubble" buildings still occupy their tile but produce nothing. */
  status?: "intact" | "rubble";
}

/* ── Utility AI: needs ── */

export type NeedType = "hunger" | "safety" | "social" | "vanity" | "faith";

export const ALL_NEEDS: NeedType[] = ["hunger", "safety", "social", "vanity", "faith"];

export interface NeedState {
  /** 0..100, higher = more urgent / more unmet. */
  value: number;
  /** Priority multiplier when scoring actions. */
  weight: number;
  /** How fast this need rises per month if unmet. */
  decay: number;
}

export const NEED_COLORS: Record<NeedType, string> = {
  hunger: "#e8a23a",
  safety: "#5fb3d6",
  social: "#d96bd9",
  vanity: "#d4af37",
  faith: "#a78bd9",
};

export const NEED_LABELS: Record<NeedType, string> = {
  hunger: "Hunger",
  safety: "Safety",
  social: "Social",
  vanity: "Vanity",
  faith: "Faith",
};

/* ── Civilization state ── */

export interface CivilizationState {
  population: number;
  treasury: number;
  resources: Record<Resource, number>;
  needs: Record<NeedType, NeedState>;
  /** Town center (where the first settlement spawned). */
  founded: { row: number; col: number };
  /** Monthly cumulative tax income for HUD trend (last 12 months). */
  monthlyTaxHistory: number[];
}

/* ========================================================================== */
/*  Phase 3: Citizens (NPCs) — utility AI + pathfinding                       */
/* ========================================================================== */

export type CitizenState =
  | "IDLE"
  | "MOVING"
  | "SEEK_FOOD"
  | "PRAYING"
  | "ROGUE"
  | "DEAD"
  | "WORKING"
  | "MINISTERING"
  | "SLEEPING"
  | "REBEL"
  | "COMBAT"
  /** Phase 9: Coward Guard breaks combat and pathfinds away. */
  | "FLEEING"
  /** Phase 12: NPC has snapped from mood == 0 (see breakKind). */
  | "MENTAL_BREAK"
  /** Phase 12: NPC is mid-rumor-exchange with chatPartnerId (see chatUntilMs). */
  | "CHATTING";

/** Phase 9: Permanent behavioral trait assigned at spawn. */
export type CitizenTrait = "Zealot" | "Greedy" | "Coward" | "Diligent";
export const ALL_TRAITS: CitizenTrait[] = ["Zealot", "Greedy", "Coward", "Diligent"];

/** Phase 9: RPG-style skill progression for the NPC's profession. */
export interface CitizenSkills {
  level: number;
  xp: number;
}

/** Phase 4: Profession assigned to every adult NPC. */
export type Profession = "Farmer" | "Miner" | "Guard" | "None";

/** Phase 4: Faction during a Civil War (HIGH dissent). */
export type Faction = "royalist" | "rebel" | "neutral";

export type LifeStage = "child" | "adult" | "elder";

export type DissentLevel = "LOW" | "MEDIUM" | "HIGH";

export interface PathStep {
  row: number;
  col: number;
}

export interface Citizen {
  id: string;
  /** Logical "from" tile — the tile the citizen most recently occupied. */
  row: number;
  col: number;
  /** Lerp factor 0..1 from current tile toward path[pathIndex]. */
  progress: number;
  state: CitizenState;
  /** Remaining tiles to walk through (excluding current). */
  path: PathStep[];
  pathIndex: number;
  /** Final destination — for arrival logic. */
  targetTile?: { row: number; col: number };
  /** ID of building being targeted (so we can still look it up after arriving). */
  targetBuildingId?: string;
  /** 0..100. Starts at 0, rises every month, drives SEEK_FOOD / crisis. */
  hunger: number;
  /** 0..100, randomized per citizen. Determines crisis branch (PRAYING vs ROGUE). */
  faith: number;
  /** Months spent in PRAYING or ROGUE since the crisis began. > 2 → DEAD. */
  crisisTimer: number;
  /** Hue rotation for visual variation (0..359). */
  hue: number;
  /** Social tier — drives sprite color + crown rendering. */
  socialTier: "peasant" | "noble" | "king";

  /* -- Phase 3B: Royal Succession & Lineage Engine -- */
  /** Display name (used in chronicles). */
  name: string;
  /** Sex — drives queen selection & reproduction. */
  sex: "male" | "female";
  /** Game year of birth (for age = currentYear - birthYear). */
  birthYear: number;
  /** True for the reigning monarch. */
  isKing?: boolean;
  /** True for the King's spouse. */
  isQueen?: boolean;
  /** True for an heir produced by the royal couple. */
  isPrince?: boolean;
  /** True for the regent spouse after a King dies leaving a minor heir. */
  isDowagerQueen?: boolean;
  /** Hidden 0..100, set to 100 on royal birth; future challenges can erode it. */
  legitimacy?: number;
  /** Spouse citizen id (King <-> Queen pairing). */
  spouseId?: string;
  /** Year this NPC died (set when state becomes DEAD). */
  deathYear?: number;

  /* -- Phase 6: Lifecycle, Safety, Vanity, Rebellion -- */
  /** 0..100 Safety stat. Drops when sleeping outside; low → higher rogue/rebel chance. */
  safety: number;
  /** Personal gold/wealth accumulated (used to pick the rebel king). */
  vanity: number;
  /** Active rebel during civil war — eligible to seize the crown. */
  isRebel?: boolean;
  /** Building id of the home this NPC last slept in (sticky). */
  homeBuildingId?: string;

  /* -- Phase 4: Professions, Economy & Factions -- */
  /** Adult profession — drives the per-month economy tick. */
  profession?: Profession;
  /** Personal goods stockpile (raw output before being banked into vanity/gold). */
  goods?: number;
  /** Faction allegiance during a Civil War (set when nobleDissent = HIGH). */
  faction?: Faction;
  /** Frames remaining in the current COMBAT lockup before resolution. */
  combatTimer?: number;
  /** id of the opposing combatant currently locked with this NPC. */
  combatOpponentId?: string;

  /* -- Phase 9: Psychology & Mastery Engine -- */
  /** Permanent behavioral trait, picked once at spawn. */
  trait?: CitizenTrait;
  /** RPG-style mastery for the assigned profession (level/xp). */
  skills?: CitizenSkills;
  /**
   * Episodic memory graph: other-citizen id → opinion score.
   * Negative scores represent grudges (default −100 for witnessed attacks).
   * Stored as a plain object so per-frame lookups are O(1).
   */
  memory?: Record<string, number>;

  /* -- Phase 12: Societal Fabric Engine (Genetics, Psychology, Contagion) -- */
  /** Family / dynasty surname (e.g. "Baker"). Inherited from mother on birth. */
  lastName?: string;
  /** 0..100 mental wellbeing. Hunger / homelessness drain it; mastery buffs it.
   *  At 0 the NPC enters MENTAL_BREAK with a trait-driven sub-behavior. */
  mood?: number;
  /** Sub-kind of the active MENTAL_BREAK — drives behavior + UI overlay. */
  breakKind?: "DOOMSAYER" | "RECLUSE" | "THIEF";
  /** RECLUSE: absolute (year * 12 + month) at which the recluse exits the house. */
  breakUntilMonth?: number;
  /** CHATTING: epoch-style state.time.totalRealMs at which the chat ends. */
  chatUntilMs?: number;
  /** CHATTING: id of the symmetric chat partner (also in CHATTING state). */
  chatPartnerId?: string;
  /** Per-citizen rebellion contagion meter (0..100). Spreads via rumor mill. */
  dissent?: number;
}

/* ── Phase 3B: Chronicle entries ── */

export interface ChronicleEntry {
  year: number;
  month: number;
  text: string;
}
