import {
  TILE_COLORS,
  TILE_BORDER_COLORS,
  TILE_SPECKLE_COLORS,
  SPECKLE_DENSITY,
  getTransitionColor,
} from "./types";
import type { Animal, Building, GameState, Particle as WeatherParticle, Season, TileType, WeatherKind } from "./types";
import { getTileColorsForSeason, getTileSpecklesForSeason } from "./types";
import {
  createDefaultState,
  saveState,
  loadState,
  applyOfflineProgression,
  monthToSeason,
} from "./storage";
import { getBuildingDef } from "./buildings";
import { tickCivilizationMonth } from "./civilization";
// Phase 14: Living City Expansion — crime/medical/leisure ticks live in npc.ts
// and are wired into simulateMonth() right after the per-citizen brain pass.
import { DesirabilityMap } from "./desirability";
// Phase 20: SoundManager singleton — wired to smite / bless / level-up /
// building-complete moments so SFX assets can drop in without a refactor.
import { sound } from "./SoundManager";
import { planAndBuild, tryUpgradeHouses } from "./buildAI";
import {
  getCitizenVisualPos,
  tickCitizenMonth,
  updateCitizenMovement,
  processNightSleep,
  tickCrimeAndLaw,
  tickDoctors,
  tickLeisureCivic,
  // Phase 12: Societal Fabric Engine
  tickDoomsayerAura,
  runRumorMill,
  processDayWake,
  recordCombatWitnesses,
  // Phase 13: Climate Engine
  traumatizeAdjacent,
} from "./npc";
import { findPath, isWalkable } from "./pathfinding";
import { tickYear as tickRoyalYear, getLifeStage, notifyDeath, addChronicle, ensureMonarch } from "./royalty";
import type { Citizen } from "./types";
import { CONSTRUCTION_WORK_MS_REQUIRED } from "./types";
import { AssetManager, SPRITE_MANIFEST } from "./AssetManager";

/* Phase 4: Combat tunables */
const COMBAT_RADIUS_TILES = 2;
const COMBAT_DURATION_MS = 900;
const SPARK_LIFE_MS = 450;
const SPARKS_PER_FRAME = 1;

/* ---------- Phase 13: Climate & Weather tunables ----------
 * The particle pool is hard-capped to keep mobile FPS stable.
 * Spawn rates are per-millisecond, scaled by dt each frame, then
 * Math.floor'd against an accumulator so we don't lose fractional spawns.
 */
const PARTICLE_MAX = 200;
const PARTICLE_SPAWN_PER_MS_RAIN = 0.30;        // ~18 drops/frame at 60 FPS
const PARTICLE_SPAWN_PER_MS_SNOW = 0.10;        // ~6 flakes/frame at 60 FPS
const PARTICLE_SPAWN_PER_MS_THUNDERSTORM = 0.40;
const RAIN_VY = 1.4;                            // px/ms (≈ 84 px/frame at 60 FPS)
const RAIN_VX = -0.35;                          // negative = wind from upper-right
const SNOW_VY = 0.18;                           // px/ms — slow drifters
const SNOW_WOBBLE_AMP = 14;                     // px sine amplitude
const SNOW_WOBBLE_FREQ_RAD_PER_MS = 0.0035;     // ~0.5 Hz
const LIGHTNING_FLASH_CHANCE_PER_FRAME = 0.01;  // 1% per frame in THUNDERSTORM
const LIGHTNING_STRIKE_CHANCE_PER_FRAME = 0.0015; // ~1 in 670 frames (≈ 11s @ 60 FPS)
const LIGHTNING_FLASH_MS = 180;                 // duration of the white overlay
const LIGHTNING_COOLDOWN_MS = 1200;             // min gap between flashes

/* ---------- Phase 13: True 2:1 dimetric isometric projection ----------
 * Standard "Age of Empires" iso: each tile is a diamond `ts` wide and
 * `ts/2` tall. World coords (col, row) project to iso pixel (sx, sy):
 *   sx = (col - row) * ts/2   + xOffset
 *   sy = (col + row) * ts/4   + yOffset
 * The xOffset shifts the leftmost tile (col=0, row=rows-1) so its diamond
 * left point lands at sx=0. The yOffset reserves the top half-diamond.
 *
 * Inverse (used for mouse picking):
 *   col - row = 2*(sx - xOffset)/ts
 *   col + row = 4*(sy - yOffset)/ts
 * → col = (sy - yOffset) * 2/ts + (sx - xOffset)/ts
 * → row = (sy - yOffset) * 2/ts - (sx - xOffset)/ts
 */
function isoXOffset(rows: number, ts: number): number {
  return (rows - 1) * ts / 2 + ts / 2;
}
function isoYOffset(ts: number): number {
  return ts / 4;
}
function worldToIso(col: number, row: number, ts: number, rows: number): { sx: number; sy: number } {
  return {
    sx: (col - row) * ts / 2 + isoXOffset(rows, ts),
    sy: (col + row) * ts / 4 + isoYOffset(ts),
  };
}
function isoToWorld(sx: number, sy: number, ts: number, rows: number): { col: number; row: number } {
  const px = sx - isoXOffset(rows, ts);
  const py = sy - isoYOffset(ts);
  return {
    col: py * 2 / ts + px / ts,
    row: py * 2 / ts - px / ts,
  };
}
function isoWorldBounds(cols: number, rows: number, ts: number): { w: number; h: number } {
  return { w: (cols + rows) * ts / 2, h: (cols + rows) * ts / 4 };
}

/* Phase 5: Divine power tunables */
const LIGHTNING_LIFE_MS = 420;
const FIRE_LIFE_MS = 850;
const METEOR_RADIUS = 1; // 3x3 footprint = radius 1

/**
 * Phase 5: Particle interface (extended from the original Spark).
 * `kind` switches the renderer; "spark" is the existing combat ember.
 */
type ParticleKind = "spark" | "lightning" | "fire" | "smoke" | "bless";
interface Particle {
  kind: ParticleKind;
  x: number;        // world px
  y: number;        // world px
  vx: number;
  vy: number;
  life: number;     // ms remaining
  maxLife: number;
  size?: number;    // for fire/smoke radii
  /** For lightning: cached zigzag offsets (px) so the bolt doesn't dance. */
  bolt?: { x: number; y: number }[];
}

export interface CitizenTapInfo {
  citizen: Citizen;
  screenX: number;
  screenY: number;
}

/* Phase 5: Divine Powers */
export type DivinePower = "none" | "architect" | "judge" | "wrath";
export type DivineBrush =
  | "none"
  /* Architect — terrain paint */
  | "paint_grass"
  | "paint_water"
  | "paint_forest"
  | "paint_mountain"
  /* Judge — single-target */
  | "smite"
  | "bless"
  /* Wrath — area of effect */
  | "meteor";

const MAX_ZOOM = 4.0;
const SAVE_INTERVAL_MS = 10_000;
const MONTHS_PER_REAL_MS_AT_1X = 1 / 60_000;

export interface GameCallbacks {
  onTimeUpdate: (state: GameState) => void;
  /** Phase 4: Inner Monologue — fired when the user taps an NPC. */
  onCitizenTap?: (info: CitizenTapInfo) => void;
}

/**
 * Phase 10.5: Asset names registered in the procedural sprite atlas. The
 * atlas is built once at construct time (see `buildAssets`) and consumed via
 * `assets.get(name)` for blit-style rendering — the architectural equivalent
 * of a single PNG atlas loader, but generated in-memory so the game has no
 * external image dependencies.
 */
type AssetName =
  | "FarmerHoe" | "FarmerHoeGold"
  | "MinerPickaxe" | "MinerPickaxeDiamond"
  | "GuardSpear" | "GuardShield" | "GuardShieldPlated"
  | "ZealotCross" | "GreedyPouch"
  | "KingCrown" | "QueenTiara"
  | "MasterPendant";

export class GameEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: GameState;
  private callbacks: GameCallbacks;

  private rafId = 0;
  private lastFrameTime = 0;
  private lastSaveTime = 0;
  private accumulatedMonthFrac = 0;

  private touch1: Touch | null = null;
  private touch2: Touch | null = null;
  private lastPinchDist = 0;
  private panVelX = 0;
  private panVelY = 0;
  private lastPanX = 0;
  private lastPanY = 0;
  private isDragging = false;

  private resizeObserver: ResizeObserver;

  private biomePatterns = new Map<TileType, CanvasPattern>();
  private waterHighlight: HTMLCanvasElement | null = null;
  private vignetteGradient: CanvasGradient | null = null;
  private vignetteSize = { w: 0, h: 0 };
  private waterAnimPhase = 0;
  /** Phase 16: last season the biome patterns + terrain layer were built for.
   *  When the live season changes we rebuild both atomically. */
  private lastBuiltSeason: Season | null = null;
  /** Phase 16: live tile-color lookup (season-aware), refreshed on rebuild. */
  private liveTileColors: Record<TileType, string> = getTileColorsForSeason("SUMMER");
  /** Phase 16: divine-impact screen shake state. Triggered by smite/meteor lightning.
   *  shake intensity in px @ 1x zoom; jitter applied to ctx pre-translate. */
  private screenShakeUntilMs = 0;
  private screenShakeIntensity = 0;
  /** Phase 16: golden light shafts left by Bless. World-space anchor + expiry. */
  private lightShafts: { x: number; y: number; until: number; born: number }[] = [];
  /** Pre-baked edge fade strips, keyed by `${color}|${dir}` where dir is t/b/l/r. */
  private transitionStrips = new Map<string, HTMLCanvasElement>();

  /** Pre-rendered humanoid sprites per social tier, keyed by tier name.
   *  Stamped in renderCitizens; rebuilt when tile size changes. */
  private npcSprites = new Map<string, HTMLCanvasElement>();
  private npcSpriteTileSize = 0;

  /**
   * Phase 10: Composite NPC sprites — keyed by citizen.id, value carries the
   * cached sprite plus a numeric `sig` summarizing tier/profession/trait/
   * life-stage/mastery/royalty. The sig is compared with a freshly-computed
   * one each frame: equal → reuse; different → rebuild. Storing a number
   * (not a template-literal string) avoids per-frame allocations in the
   * sprite hot path. Entries are evicted via simple FIFO when count >= cap.
   */
  private compositeSprites = new Map<string, { sig: number; sprite: HTMLCanvasElement }>();

  /**
   * Phase 22 — Sprite asset pipeline. Holds all preloaded PNGs (buildings,
   * characters, environment). Initialized + preload-kicked-off in the
   * constructor; every per-entity draw call asks `assets.has(key)` first
   * and only falls through to the existing procedural draw path when the
   * sprite isn't ready (or doesn't exist on disk yet — Phase 22 ships
   * with zero PNGs, so the fallback IS the live visual right now).
   *
   * Named `spriteAssets` (not `assets`) to avoid colliding with the legacy
   * Phase 10.5 procedural sprite atlas, which is also called `assets` and
   * holds offscreen-canvas accessory tiles.
   */
  private spriteAssets!: AssetManager;
  private compositeSpriteTileSize = 0;
  private readonly COMPOSITE_CACHE_MAX = 200;

  /**
   * Phase 10.5: Procedural sprite atlas. Built once at construct time, this
   * map plays the role of a single PNG-atlas asset registry — every named
   * accessory (FarmerHoe, KingCrown, ZealotCross, etc.) is a small offscreen
   * canvas that the NPC compositor blits via `drawImage`. This decouples
   * accessory drawing from per-NPC redraws and means scaling is the only
   * per-frame cost.
   */
  private assets = new Map<AssetName, HTMLCanvasElement>();
  /** Reference render scale for atlas entries; consumers rescale at draw time. */
  private readonly ASSET_REF = 64;

  /**
   * Phase 10.5: Static terrain layer cache. The full world's base tiles +
   * biome transitions are pre-rendered into one offscreen canvas at
   * `terrainLayerScale` resolution. Each frame we blit the visible portion
   * with a single drawImage call instead of looping every visible tile.
   * `terraformTile()` patches the affected tiles incrementally so painting
   * stays smooth.
   */
  private terrainLayer: HTMLCanvasElement | null = null;
  private terrainLayerScale = 0.5; // half-scale → 100*64*0.5 = 3200px max edge
  // Phase 13: Set true when a tile changes (architect, meteor) so render()
  // triggers a full iso terrain rebuild on the next frame instead of trying
  // to do a tricky incremental patch on overlapping diamond tiles.
  private terrainDirty = false;

  /**
   * Phase 10.5: FPS counter. EMA over recent frame times; surfaced through
   * `getFPS()` so the React HUD can poll without re-rendering on every frame.
   */
  private fpsEma = 60;
  private fpsLastSampleAt = 0;
  /**
   * Phase 12: Rumor Mill accumulator. The proximity-check pass is O(N) (with
   * spatial bucketing) but it allocates a Map + walks every NPC, so we MUST
   * gate it to once-per-second rather than every frame. 1000 ms ≈ 60 ticks
   * @ 60 FPS — well within the perf budget.
   */
  private rumorAccMs = 0;

  /* ---------- Phase 13: Climate Engine runtime state ----------
   * The particle pool, lightning timers, and spawn accumulators all live
   * on the engine — none of these need to persist across reloads (the
   * weather kind itself is on GameState, but particles re-seed instantly
   * on the next frame). Keeping them off GameState avoids serialization
   * churn and lets us hard-cap the array length without migration logic.
   */
  private weatherParticles: WeatherParticle[] = [];
  private weatherSpawnAcc = 0;          // fractional spawn carry-over
  private lightningFlashUntilMs = 0;    // wall-clock ms while screen flashes white
  private lastLightningStrikeMs = 0;    // throttle for back-to-back strikes
  private lastSeasonSeen: Season | null = null; // detect season transitions for chronicles

  /** Hidden land-value map driving social hierarchy. */
  private desirability!: DesirabilityMap;
  /** Months between full desirability recomputes (it's also marked dirty on builds). */
  private monthsSinceDesirRecompute = 0;
  /** Pending offline simulation catch-up to run after init. */
  private pendingOfflineMonths = 0;

  /* Phase 4/5: Particles (combat sparks + divine effects, all world-space) */
  private sparks: Particle[] = [];

  /* Phase 5: Currently-selected divine power. When 'none', taps trigger the
   * inner-monologue NPC inspector; otherwise taps cast the chosen power. */
  private currentPower: DivinePower = "none";
  private currentBrush: DivineBrush = "none";

  /* Phase 4: Tap detection state — distinguish drag from click/tap */
  private pointerDownX = 0;
  private pointerDownY = 0;
  private pointerDownTime = 0;
  private pointerMaxMove = 0;
  private readonly TAP_MOVE_SLOP = 8;   // px
  private readonly TAP_TIME_MAX = 350;  // ms

  constructor(canvas: HTMLCanvasElement, callbacks: GameCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.callbacks = callbacks;

    const saved = loadState();
    if (saved) {
      const elapsedMs = Date.now() - saved.time.lastSavedTimestamp;
      const offlineMonths = Math.max(0, Math.floor(elapsedMs / 60_000));
      applyOfflineProgression(saved);
      this.state = saved;
      // Defer offline simulation catch-up — desirability map isn't built yet.
      this.pendingOfflineMonths = Math.min(offlineMonths, 60);
    } else {
      this.state = createDefaultState();
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement!);
    this.resize();

    // Phase 16: build biome patterns with the LIVE season so the world
    // opens at the correct palette (winter saves wake to a snowy world).
    this.buildBiomePatterns(this.state.currentSeason);
    this.buildWaterHighlight();
    // Phase 10.5: build the procedural sprite atlas before the first frame
    // so accessory blits never have to wait. Terrain layer is built lazily
    // on first render (after resize so we know the device pixel ratio).
    this.buildAssets();

    // Phase 22 — kick off PNG sprite preload. BASE_URL is Vite's artifact
    // base path (currently "/" for god-sim, but resolved dynamically so a
    // future multi-artifact remount works without touching this code).
    // Fire-and-forget: no frame is blocked, every PNG resolves async, and
    // every draw call falls back to procedural rendering until the
    // matching Image fires onload.
    this.spriteAssets = new AssetManager(import.meta.env.BASE_URL);
    this.spriteAssets.preload(SPRITE_MANIFEST);

    // Initialize desirability map and seed with terrain + any saved buildings.
    this.desirability = new DesirabilityMap(this.state.grid.rows, this.state.grid.cols);
    this.desirability.recompute(this.state.grid, this.state.buildings);

    // Run offline simulation catch-up now that desirability is ready.
    if (this.pendingOfflineMonths > 0) {
      for (let i = 0; i < this.pendingOfflineMonths; i++) this.simulateMonth();
      this.pendingOfflineMonths = 0;
    }

    // Center camera on the civilization spawn point on fresh start so the
    // user immediately sees where buildings will appear. (Don't override
    // a meaningful saved camera — only do this when camera is at default.)
    if (this.state.camera.x === 0 && this.state.camera.y === 0 && this.state.camera.zoom === 1) {
      const grid = this.state.grid;
      const founded = this.state.civilization.founded;
      // Phase 13: focus camera on the iso projection of the founding tile,
      // not its top-down rect center, so the iso terrain centers correctly.
      const f = worldToIso(founded.col, founded.row, grid.tileSize, grid.rows);
      const focusX = f.sx;
      const focusY = f.sy;
      // Pick a comfortable mid-range zoom that shows ~10 tiles across so
      // NPCs are clearly visible at default. (Was /20 — sprites were tiny in
      // the 606px-wide canvas iframe; halving the tile-count doubles the
      // perceived NPC size without overscaling on a desktop viewport since
      // MAX_ZOOM=4.0 still caps it.)
      const targetZoom = Math.min(MAX_ZOOM, this.viewW / (10 * grid.tileSize));
      this.state.camera.zoom = Math.max(this.minZoom, targetZoom);
      this.state.camera.x = focusX - this.viewW / (2 * this.state.camera.zoom);
      this.state.camera.y = focusY - this.viewH / (2 * this.state.camera.zoom);
      this.clampCamera();
    }

    this.bindTouchEvents();
    this.bindMouseEvents();
    this.start();
  }

  /**
   * Run one month of civilization simulation.
   * Sequence:
   *   1. Recompute desirability if marked dirty (or every N months).
   *   2. Tick civilization (production, taxes, needs decay).
   *   3. Try to upgrade existing houses based on land value.
   *   4. Run autonomous build AI to place at most one new building.
   */
  private simulateMonth() {
    this.monthsSinceDesirRecompute++;
    if (this.desirability.isDirty() || this.monthsSinceDesirRecompute >= 6) {
      this.desirability.recompute(this.state.grid, this.state.buildings);
      this.monthsSinceDesirRecompute = 0;
    }

    // Phase 13: keep the season in sync with gameMonth at the START of every
    // month-tick. Without this, boundary months (e.g. the moment we cross
    // from Feb→Mar) would simulate crops/mood under the OLD season because
    // the daily refresh in tickDayNight() doesn't fire until the next dawn.
    // Weather is NOT re-rolled here — that stays a per-day event at dawn.
    const liveSeason = monthToSeason(this.state.time.gameMonth);
    if (liveSeason !== this.state.currentSeason) {
      const prev = this.state.currentSeason;
      this.state.currentSeason = liveSeason;
      addChronicle(
        this.state,
        `The realm turns from ${prev.toLowerCase()} to ${liveSeason.toLowerCase()}.`
      );
      this.lastSeasonSeen = liveSeason;
      // Phase 16: rebuild biome patterns + flag terrain rebuild so the
      // palette swap (lush spring → russet autumn → snow winter) appears
      // on the very next frame. Both ops are cheap; biome rebuild is
      // ~5-8ms once per quarter-year, terrain rebuild ~15-30ms once.
      this.buildBiomePatterns(liveSeason);
      this.terrainDirty = true;
    }

    tickCivilizationMonth(
      this.state.civilization,
      this.state.buildings,
      this.state.winterActive,
      // Phase 13: seasonal crop multiplier. Spring/Autumn = 1.5x harvest
      // bonus; Summer baseline; Winter halts crops entirely.
      this.state.currentSeason === "WINTER"
        ? 0
        : this.state.currentSeason === "SPRING" ||
            this.state.currentSeason === "AUTUMN"
          ? 1.5
          : 1
    );

    tryUpgradeHouses(this.state.buildings, this.state.civilization, this.desirability);

    const newBuilding = planAndBuild(
      this.state.grid,
      this.state.buildings,
      this.state.civilization,
      this.desirability,
      this.state.time.gameMonth + (this.state.time.gameYear - 1) * 12
    );
    if (newBuilding) {
      this.state.buildings.push(newBuilding);
    }

    // Phase 3: tick each citizen's brain — hunger rises, crisis branch fires
    // (PRAYING / ROGUE), the death timer counts down, and SEEK_FOOD/ROGUE
    // citizens replan their A* path when they don't already have one.
    // Pass the full state so starvation deaths can trigger royal succession.
    for (const c of this.state.citizens) {
      tickCitizenMonth(
        c,
        this.state.grid,
        this.state.buildings,
        this.state.civilization,
        this.state
      );
    }

    // Phase 12: After every NPC has ticked, apply the DOOMSAYER faith aura
    // (drains -1 faith from each citizen within 3 tiles of any active
    // DOOMSAYER). Cheap when no doomsayers exist; O(D × N) otherwise.
    tickDoomsayerAura(this.state);

    // Phase 14: Living City Expansion — three single-pass O(N) ticks that
    // resolve crime, medicine, and leisure aggregation. Order matters:
    //   1. tickCrimeAndLaw FIRST — desperate NPCs flip to STEALING and
    //      Guards path to arrest. Without this first, a sick thief could
    //      be cured before being arrested.
    //   2. tickDoctors SECOND — Doctors acquire/heal SICK patients. Run
    //      after crime so an arrested-then-imprisoned NPC isn't double-targeted.
    //   3. tickLeisureCivic LAST — aggregate per-citizen leisure into the
    //      civilization-level Civic Needs HUD bar.
    tickCrimeAndLaw(this.state);
    tickDoctors(this.state);
    tickLeisureCivic(this.state);

    // Phase 3B: once per game-year, run aging, natural death, heir maturity
    // and royal reproduction. We compare to lastRoyalYearTicked rather than
    // gating on month==1 so offline catch-up runs the right number of years.
    if (this.state.time.gameYear !== this.state.lastRoyalYearTicked) {
      const target = this.state.time.gameYear;
      // Cap the catch-up loop in case of a huge offline gap.
      let safety = 0;
      while (this.state.lastRoyalYearTicked < target && safety < 200) {
        this.state.lastRoyalYearTicked++;
        // Use the engine's notion of "now" so chronicles get the right year.
        const realYear = this.state.time.gameYear;
        this.state.time.gameYear = this.state.lastRoyalYearTicked;
        tickRoyalYear(
          this.state,
          this.state.grid,
          this.state.buildings,
          this.state.civilization
        );
        // Phase 10.7: After every yearly royalty tick, guarantee a living
        // monarch — if succession somehow leaves the throne empty, the
        // highest-Vanity surviving adult is acclaimed so the game can
        // never permanently soft-lock on a no-heir extinction event.
        ensureMonarch(this.state);
        this.state.time.gameYear = realYear;
        safety++;
      }
      this.state.lastRoyalYearTicked = target;

      // Phase 11 hardening — Dead NPC garbage collection.
      // Citizens who have been DEAD for more than DEAD_GRACE_YEARS are
      // removed from the active citizens[] array entirely. This:
      //   • prevents unbounded array growth over centuries of play
      //     (every per-frame loop over citizens stays O(living))
      //   • keeps the gravestone visual on screen for the grace period so
      //     the player still sees recent fatalities
      //   • is safe for lineage: findHeirs() iterates living children, so
      //     GC'ing a long-dead parent never breaks succession
      const DEAD_GRACE_YEARS = 10;
      const cutoff = this.state.time.gameYear - DEAD_GRACE_YEARS;
      const before = this.state.citizens.length;
      this.state.citizens = this.state.citizens.filter(
        (c) => c.state !== "DEAD" || (c.deathYear ?? this.state.time.gameYear) > cutoff
      );
      const removed = before - this.state.citizens.length;
      if (removed > 0) {
        // Composite-sprite cache may now reference stale citizen IDs; clear
        // any orphans so the FIFO buffer doesn't carry dead weight.
        const liveIds = new Set(this.state.citizens.map((c) => c.id));
        for (const id of [...this.compositeSprites.keys()]) {
          if (!liveIds.has(id)) this.compositeSprites.delete(id);
        }
      }
    }

    // Phase 6: Day/Night flip — alternates each in-game month. Triggers the
    // sleep protocol on Night and wakes everyone on Day.
    this.tickDayNight();
  }

  /**
   * Phase 6: Each in-game month boundary, toggle the day/night phase.
   * Entering Night runs the Sleep Protocol (NPCs path home, homeless lose
   * Safety). Entering Day wakes everyone. Called exactly once per
   * simulateMonth() invocation, so multi-month catch-ups (lag spikes,
   * offline progression) flip the correct number of times.
   */
  private tickDayNight() {
    if (this.state.dayNight === "day") {
      this.state.dayNight = "night";
      processNightSleep(this.state, this.state.grid, this.state.buildings);
    } else {
      this.state.dayNight = "day";
      processDayWake(this.state);
      // Phase 13: dawn = "new game-day". Recompute season from gameMonth and
      // re-roll the daily weather. Season transitions write a chronicle entry.
      this.refreshSeasonAndWeather();
    }
    this.state.lastDayNightFlipMonth =
      this.state.time.gameYear * 12 + this.state.time.gameMonth;
  }

  /* -------------------------------------------------------------------- */
  /*  Phase 13: Dynamic Climate & Ecosystem Engine                        */
  /* -------------------------------------------------------------------- */

  /**
   * Recompute the current season from gameMonth and roll a new daily weather
   * kind from the season's lookup table. Called once per dawn (transition
   * to "day"). Season changes are chronicled; weather changes are silent
   * (the HUD pill is the player's signal).
   */
  private refreshSeasonAndWeather(): void {
    // Season is kept in sync inside simulateMonth() too, so by the time
    // we reach dawn, currentSeason is already correct. Re-derive defensively
    // here in case dawn fires through some path that bypasses simulateMonth.
    const newSeason = monthToSeason(this.state.time.gameMonth);
    if (this.lastSeasonSeen === null) {
      this.lastSeasonSeen = this.state.currentSeason;
    }
    if (newSeason !== this.state.currentSeason) {
      this.state.currentSeason = newSeason;
      this.lastSeasonSeen = newSeason;
    }

    // Per-season weather pool. Probabilities sum to 1 within each row.
    //   Spring : mostly clear, plenty of rain, no snow, occasional storms.
    //   Summer : dominated by clear skies, light rain, rare thunderstorms.
    //   Autumn : balanced clear/rain, some thunder, no snow.
    //   Winter : snow-heavy, some clear days, no rain (rain freezes), no thunder.
    let pool: { kind: WeatherKind; weight: number }[];
    switch (newSeason) {
      case "SPRING":
        pool = [
          { kind: "CLEAR", weight: 0.45 },
          { kind: "RAIN", weight: 0.40 },
          { kind: "THUNDERSTORM", weight: 0.15 },
        ];
        break;
      case "SUMMER":
        pool = [
          { kind: "CLEAR", weight: 0.70 },
          { kind: "RAIN", weight: 0.20 },
          { kind: "THUNDERSTORM", weight: 0.10 },
        ];
        break;
      case "AUTUMN":
        pool = [
          { kind: "CLEAR", weight: 0.45 },
          { kind: "RAIN", weight: 0.35 },
          { kind: "THUNDERSTORM", weight: 0.20 },
        ];
        break;
      case "WINTER":
      default:
        pool = [
          { kind: "CLEAR", weight: 0.45 },
          { kind: "SNOW", weight: 0.55 },
        ];
        break;
    }

    const r = Math.random();
    let cum = 0;
    let pick: WeatherKind = "CLEAR";
    for (const e of pool) {
      cum += e.weight;
      if (r <= cum) { pick = e.kind; break; }
    }
    if (pick !== this.state.currentWeather) {
      // Drop any in-flight particles whose kind no longer matches the new
      // weather — leaving stale rain falling under a CLEAR sky looks broken.
      const expectedKind = pick === "SNOW" ? "snow" : "rain";
      this.weatherParticles = this.weatherParticles.filter(
        (p) => pick === "CLEAR" ? false : p.kind === expectedKind
      );
    }
    this.state.currentWeather = pick;
    this.state.lastWeatherRollMonth =
      this.state.time.gameYear * 12 + this.state.time.gameMonth;
  }

  /**
   * Per-frame climate tick: spawn / advect / cull weather particles, and
   * roll thunderstorm lightning. Cheap when CLEAR (early-out + drains the
   * pool). Particle math is kept in screen-space so the wind direction is
   * camera-independent — pan/zoom never warps the rain angle.
   */
  private tickClimate(dtMs: number): void {
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    const weather = this.state.currentWeather;

    // 1. Spawn budget for this frame (fractional carry-over).
    if (weather !== "CLEAR" && this.weatherParticles.length < PARTICLE_MAX) {
      const rate =
        weather === "RAIN"
          ? PARTICLE_SPAWN_PER_MS_RAIN
          : weather === "SNOW"
            ? PARTICLE_SPAWN_PER_MS_SNOW
            : PARTICLE_SPAWN_PER_MS_THUNDERSTORM;
      this.weatherSpawnAcc += rate * dtMs;
      const spawnCount = Math.floor(this.weatherSpawnAcc);
      this.weatherSpawnAcc -= spawnCount;

      const isSnow = weather === "SNOW";
      for (let i = 0; i < spawnCount; i++) {
        if (this.weatherParticles.length >= PARTICLE_MAX) break;
        // Spawn just above the top of the viewport. For rain, also seed
        // some particles from the right edge so the diagonal stream looks
        // continuous (the wind blows them off the left side).
        const fromRightEdge = !isSnow && Math.random() < 0.3;
        const startX = fromRightEdge
          ? W + Math.random() * 40
          : Math.random() * (W + 60) - 30;
        const startY = fromRightEdge
          ? Math.random() * H * 0.5
          : -10 - Math.random() * 20;
        if (isSnow) {
          this.weatherParticles.push({
            kind: "snow",
            x: startX,
            y: startY,
            vx: 0,
            vy: SNOW_VY * (0.7 + Math.random() * 0.6),
            baseX: startX,
            phase: Math.random() * Math.PI * 2,
          });
        } else {
          this.weatherParticles.push({
            kind: "rain",
            x: startX,
            y: startY,
            vx: RAIN_VX,
            vy: RAIN_VY * (0.85 + Math.random() * 0.3),
          });
        }
      }
    } else if (weather === "CLEAR" && this.weatherParticles.length > 0) {
      // Let existing particles fall through naturally so we don't snap-pop
      // a screen full of rain when the weather clears mid-storm.
    }

    // 2. Advect + cull. We rebuild the array (not splice) — pure JS arrays
    //    of plain objects are much faster to .filter() than to splice live.
    if (this.weatherParticles.length > 0) {
      const next: WeatherParticle[] = [];
      for (const p of this.weatherParticles) {
        if (p.kind === "snow") {
          p.phase = (p.phase ?? 0) + dtMs * SNOW_WOBBLE_FREQ_RAD_PER_MS;
          p.y += p.vy * dtMs;
          p.x = (p.baseX ?? p.x) + Math.sin(p.phase) * SNOW_WOBBLE_AMP;
        } else {
          p.x += p.vx * dtMs;
          p.y += p.vy * dtMs;
        }
        if (p.y > H + 8) continue;
        if (p.x < -40 || p.x > W + 40) continue;
        next.push(p);
      }
      this.weatherParticles = next;
    }

    // 3. Lightning — only during THUNDERSTORM. Two independent rolls per
    //    frame: a cheap visual flash (always allowed — pure cosmetic), and
    //    a much rarer ground strike that mutates NPC state. The strike is
    //    GATED on timeScale > 0 so a paused world stays simulation-frozen
    //    (the player should be able to inspect citizens during a storm
    //    without the world traumatizing them under the pause).
    if (weather === "THUNDERSTORM") {
      const nowMs = this.state.time.totalRealMs;
      if (
        nowMs - this.lastLightningStrikeMs > LIGHTNING_COOLDOWN_MS &&
        Math.random() < LIGHTNING_FLASH_CHANCE_PER_FRAME
      ) {
        this.lightningFlashUntilMs = nowMs + LIGHTNING_FLASH_MS;
        this.lastLightningStrikeMs = nowMs;
      }
      if (
        this.state.time.timeScale > 0 &&
        Math.random() < LIGHTNING_STRIKE_CHANCE_PER_FRAME
      ) {
        this.tryLightningStrike();
      }
    }
  }

  /**
   * Pick a random tile in the visible viewport and traumatize any non-king
   * NPCs within Chebyshev distance 1. Skipped if no living non-king NPC is
   * actually on screen — no point in rolling for an impact in empty space.
   */
  private tryLightningStrike(): void {
    const grid = this.state.grid;
    if (grid.rows <= 0 || grid.cols <= 0) return;
    // Random tile anywhere on the map. The chronicle line is the player's
    // feedback even if the strike is off-camera.
    const col = Math.floor(Math.random() * grid.cols);
    const row = Math.floor(Math.random() * grid.rows);
    const victims = traumatizeAdjacent(this.state, col, row);
    // Trigger the visual flash even when the strike is off-screen so the
    // player gets the audio-style cue that something happened.
    const nowMs = this.state.time.totalRealMs;
    this.lightningFlashUntilMs = nowMs + LIGHTNING_FLASH_MS;
    this.lastLightningStrikeMs = nowMs;
    if (victims.length > 0) {
      const names = victims.slice(0, 3).map((c) => c.name).join(", ");
      const more = victims.length > 3 ? ` and ${victims.length - 3} others` : "";
      addChronicle(
        this.state,
        `Lightning strikes near ${names}${more} — they flee in terror.`
      );
    }
  }

  /**
   * Compose the seasonal color tint as a fillStyle string. Returns null
   * when no tint should be applied (Summer = neutral baseline).
   */
  private seasonTintColor(season: Season): string | null {
    switch (season) {
      case "SPRING": return "rgba(140, 220, 140, 0.10)"; // pale leaf green
      case "AUTUMN": return "rgba(220, 150, 80, 0.14)";  // amber wash
      case "WINTER": return "rgba(170, 210, 255, 0.18)"; // pale icy blue
      case "SUMMER":
      default:       return null;
    }
  }

  /**
   * Phase 13: Render the screen-space weather VFX layer on top of all
   * other overlays. Called from render() after the vignette so particles
   * land above night tinting and lightning flashes blow out the whole
   * screen briefly. Pure 2D canvas ops, no transforms.
   */
  private renderWeatherFx(): void {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;

    // Phase 16: Thunderstorm ambient darkening — a cool-blue wash drawn
    // BEFORE particles so candlelit windows + lightning bolts read against
    // a properly stormy sky instead of just a normal-day backdrop with
    // rain on top. Sits between vignette and rain particles so the rain
    // streaks still pop against the darkening.
    if (this.state.currentWeather === "THUNDERSTORM") {
      ctx.fillStyle = "rgba(15, 25, 50, 0.32)";
      ctx.fillRect(0, 0, W, H);
    }

    // Particles
    if (this.weatherParticles.length > 0) {
      ctx.save();
      // Rain pass — short angled lines, single batched stroke.
      ctx.strokeStyle = "rgba(180, 210, 240, 0.55)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let drewRain = false;
      for (const p of this.weatherParticles) {
        if (p.kind !== "rain") continue;
        // Streak length proportional to velocity (px/ms × scale).
        const len = 9;
        const dx = p.vx * (len / RAIN_VY);
        const dy = p.vy * (len / RAIN_VY);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - dx, p.y - dy);
        drewRain = true;
      }
      if (drewRain) ctx.stroke();

      // Snow pass — small soft circles.
      ctx.fillStyle = "rgba(245, 250, 255, 0.85)";
      for (const p of this.weatherParticles) {
        if (p.kind !== "snow") continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Lightning flash — full-screen white pulse with quick falloff.
    const nowMs = this.state.time.totalRealMs;
    if (nowMs < this.lightningFlashUntilMs) {
      const t = (this.lightningFlashUntilMs - nowMs) / LIGHTNING_FLASH_MS;
      const alpha = 0.55 * t * t; // ease-out quad
      ctx.fillStyle = `rgba(255, 255, 240, ${alpha})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /**
   * Phase 10: Procedural biome textures — value-noise base + biome-specific
   * overlay (water waves, grass blades, forest canopy clumps, mountain
   * cracks, desert dunes, snow drifts). Pattern is 96×96 to keep tiling
   * less obvious than tileSize-square. Patterns are biome-specific seamless
   * canvases used as `CanvasPattern` repeats.
   *
   * Phase 16: Now season-aware. The full TileType palette is swapped at
   * once via `getTileColorsForSeason / getTileSpecklesForSeason`. Callers
   * must invalidate the cached terrainLayer (set `terrainDirty=true`) AND
   * the per-NPC composite sprites are unaffected. This rebuilds in O(7)
   * patterns × 96² pixels each — about 4 MB of imagedata work, ~5–8 ms on
   * mid-tier mobile, run only on season transitions (4× per game year ≈
   * once per 4 real-world minutes), so the cost is invisible.
   */
  private buildBiomePatterns(season: Season = "SUMMER") {
    const PATTERN = 96;
    const types: TileType[] = [
      "grass", "water", "forest", "mountain", "desert", "snow", "crater",
    ];
    const seasonColors = getTileColorsForSeason(season);
    const seasonSpeckles = getTileSpecklesForSeason(season);
    this.liveTileColors = seasonColors;
    this.lastBuiltSeason = season;
    // Drop existing cached patterns so the new palette takes effect.
    this.biomePatterns.clear();
    for (const type of types) {
      const off = document.createElement("canvas");
      off.width = PATTERN;
      off.height = PATTERN;
      const p = off.getContext("2d")!;

      // Base fill (season-aware)
      p.fillStyle = seasonColors[type];
      p.fillRect(0, 0, PATTERN, PATTERN);

      const [light, dark] = seasonSpeckles[type];
      const lightRGB = this.hexToRgb(light);
      const darkRGB = this.hexToRgb(dark);

      let seed = type.charCodeAt(0) * 9301 + 49297;
      const rand = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      // Value-noise blend over the base fill via per-pixel ImageData mixing.
      const img = p.getImageData(0, 0, PATTERN, PATTERN);
      const data = img.data;
      const noiseAlpha = type === "water" ? 0.18 : type === "snow" ? 0.10 : 0.30;
      for (let i = 0; i < PATTERN * PATTERN; i++) {
        // Two-octave value noise sample
        const n1 = rand();
        const n2 = (rand() + n1) * 0.5;
        const n = n1 * 0.6 + n2 * 0.4;
        const useLight = n > 0.5;
        const intensity = (useLight ? n - 0.5 : 0.5 - n) * 2; // 0..1
        const rgb = useLight ? lightRGB : darkRGB;
        const o = i * 4;
        const mix = noiseAlpha * intensity;
        data[o]     = Math.round(data[o]     * (1 - mix) + rgb[0] * mix);
        data[o + 1] = Math.round(data[o + 1] * (1 - mix) + rgb[1] * mix);
        data[o + 2] = Math.round(data[o + 2] * (1 - mix) + rgb[2] * mix);
      }
      p.putImageData(img, 0, 0);

      // Biome-specific overlays for richness
      if (type === "water") {
        p.strokeStyle = "rgba(255,255,255,0.10)";
        p.lineWidth = 1;
        for (let y = 6; y < PATTERN; y += 11) {
          p.beginPath();
          p.moveTo(0, y);
          for (let x = 0; x <= PATTERN; x += 6) {
            p.lineTo(x, y + Math.sin(x * 0.45) * 1.4);
          }
          p.stroke();
        }
      } else if (type === "grass") {
        for (let i = 0; i < 36; i++) {
          const x = rand() * PATTERN;
          const y = rand() * PATTERN;
          p.strokeStyle = "rgba(50,80,35,0.55)";
          p.lineWidth = 1;
          p.beginPath();
          p.moveTo(x, y);
          p.lineTo(x + (rand() - 0.5) * 1.4, y - 2 - rand() * 1.5);
          p.stroke();
        }
      } else if (type === "forest") {
        for (let i = 0; i < 7; i++) {
          const x = rand() * PATTERN;
          const y = rand() * PATTERN;
          const r = 4 + rand() * 5;
          p.fillStyle = "rgba(20,40,20,0.32)";
          p.beginPath();
          p.arc(x, y, r, 0, Math.PI * 2);
          p.fill();
          p.fillStyle = "rgba(80,120,60,0.25)";
          p.beginPath();
          p.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, Math.PI * 2);
          p.fill();
        }
      } else if (type === "mountain") {
        p.strokeStyle = "rgba(0,0,0,0.22)";
        p.lineWidth = 1;
        for (let i = 0; i < 10; i++) {
          const x1 = rand() * PATTERN;
          const y1 = rand() * PATTERN;
          p.beginPath();
          p.moveTo(x1, y1);
          p.lineTo(x1 + (rand() - 0.5) * 26, y1 + (rand() - 0.5) * 26);
          p.stroke();
        }
        // Granite speckles
        for (let i = 0; i < 30; i++) {
          p.fillStyle = `rgba(240,240,240,${0.15 + rand() * 0.2})`;
          p.fillRect(rand() * PATTERN, rand() * PATTERN, 1.2, 1.2);
        }
      } else if (type === "desert") {
        // Dune curves
        p.strokeStyle = "rgba(180,140,80,0.35)";
        p.lineWidth = 1;
        for (let y = 8; y < PATTERN; y += 14) {
          p.beginPath();
          p.moveTo(0, y);
          for (let x = 0; x <= PATTERN; x += 8) {
            p.lineTo(x, y + Math.sin(x * 0.25 + y) * 2);
          }
          p.stroke();
        }
      } else if (type === "snow") {
        // Soft drift highlights
        for (let i = 0; i < 14; i++) {
          const x = rand() * PATTERN;
          const y = rand() * PATTERN;
          const r = 6 + rand() * 8;
          const grad = p.createRadialGradient(x, y, 0, x, y, r);
          grad.addColorStop(0, "rgba(255,255,255,0.35)");
          grad.addColorStop(1, "rgba(255,255,255,0)");
          p.fillStyle = grad;
          p.beginPath();
          p.arc(x, y, r, 0, Math.PI * 2);
          p.fill();
        }
      } else if (type === "crater") {
        // Faint scorched rings
        for (let i = 0; i < 4; i++) {
          const x = rand() * PATTERN;
          const y = rand() * PATTERN;
          const r = 6 + rand() * 10;
          p.strokeStyle = "rgba(20,10,5,0.4)";
          p.lineWidth = 1;
          p.beginPath();
          p.arc(x, y, r, 0, Math.PI * 2);
          p.stroke();
        }
      }

      // Reference SPECKLE_DENSITY constant to keep symbol valid for callers
      void SPECKLE_DENSITY[type];

      const pat = this.ctx.createPattern(off, "repeat");
      if (pat) this.biomePatterns.set(type, pat);
    }
  }

  private hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    const full = h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h.padEnd(6, "0").slice(0, 6);
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }

  private hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace("#", "");
    const full = h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h.padEnd(6, "0").slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  private getTransitionStrip(color: string, dir: "t" | "b" | "l" | "r"): HTMLCanvasElement {
    const key = `${color}|${dir}`;
    const cached = this.transitionStrips.get(key);
    if (cached) return cached;

    const ts = this.state.grid.tileSize;
    const edge = Math.max(2, Math.round(ts * 0.18));
    const horizontal = dir === "t" || dir === "b";
    const off = document.createElement("canvas");
    off.width = horizontal ? ts : edge;
    off.height = horizontal ? edge : ts;
    const p = off.getContext("2d")!;

    const opaque = this.hexToRgba(color, 0.95);
    const transparent = this.hexToRgba(color, 0);

    let grd: CanvasGradient;
    if (dir === "t") {
      grd = p.createLinearGradient(0, 0, 0, edge);
      grd.addColorStop(0, opaque);
      grd.addColorStop(1, transparent);
    } else if (dir === "b") {
      grd = p.createLinearGradient(0, 0, 0, edge);
      grd.addColorStop(0, transparent);
      grd.addColorStop(1, opaque);
    } else if (dir === "l") {
      grd = p.createLinearGradient(0, 0, edge, 0);
      grd.addColorStop(0, opaque);
      grd.addColorStop(1, transparent);
    } else {
      grd = p.createLinearGradient(0, 0, edge, 0);
      grd.addColorStop(0, transparent);
      grd.addColorStop(1, opaque);
    }
    p.fillStyle = grd;
    p.fillRect(0, 0, off.width, off.height);
    this.transitionStrips.set(key, off);
    return off;
  }

  private buildWaterHighlight() {
    const ts = this.state.grid.tileSize;
    const off = document.createElement("canvas");
    off.width = ts;
    off.height = ts;
    const p = off.getContext("2d")!;
    const grad = p.createRadialGradient(ts * 0.35, ts * 0.3, 0, ts * 0.5, ts * 0.5, ts * 0.7);
    grad.addColorStop(0, "rgba(180, 220, 255, 0.18)");
    grad.addColorStop(0.6, "rgba(180, 220, 255, 0.04)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
    p.fillStyle = grad;
    p.fillRect(0, 0, ts, ts);
    this.waterHighlight = off;
  }

  /**
   * Draw all buildings within the given tile bounds. Visual style varies per
   * category & tier:
   *   - Residential: roofed cottage shape; tier controls colors + size
   *   - Production: square workshop with darker roof + glyph
   *   - Service: circular icon
   * High-tier homes get a small golden "wealth" indicator.
   */
  /**
   * Phase 13: Render ONE building at its iso-projected position. Called
   * from the depth-sorted scene queue in render(). The (sx, sy) is the
   * iso center of the building's tile. We anchor the existing building
   * draw routine so the building's wall base sits inside the lower half
   * of the diamond — visually "standing on" the tile rather than floating.
   *
   *   x = sx - ts/2     (building square left edge = tile diamond left)
   *   y = sy - ts*0.6   (so the wall base ~ sy + ts*0.1, slightly below
   *                      tile center, hugging the lower diamond half)
   */
  /**
   * Phase 14b "Dollhouse" — drawSingleBuilding is now used ONLY for the
   * combined-render paths: rubble (no layering needed) and the circular
   * well (round, no roof to cut away). All other buildings go through the
   * three-layer queue (floor → back → citizen → front+roof) so the
   * caller in render() pushes those entries directly and skips this
   * method for them.
   */
  private drawSingleBuilding(b: Building, sx: number, sy: number, ts: number) {
    const ctx = this.ctx;
    const cam = this.state.camera;
    const x = sx - ts * 0.5;
    const y = sy - ts * 0.6;
    if (b.status === "rubble") {
      this.drawRubble(x, y, ts);
      return;
    }
    const def = getBuildingDef(b.typeId);
    // Only the well uses the legacy combined draw — everything else is
    // composed via the three-layer queue and never reaches this path.
    if (!(def.category === "service" && b.typeId === "well")) return;
    this.drawBuilding(b, def, x, y, ts);
    // Phase 19: center letter-glyph overlay removed per "no text labels for
    // entities" directive. The well's distinct circular silhouette + roof
    // color now identifies it without a "W" letter floating on top.
  }

  /**
   * Phase 14b "Dollhouse" — true layered iso building render. Splits the
   * building into FOUR draw passes that interleave with citizens in the
   * depth queue so NPCs draw between the floor and the roof, giving an
   * always-visible cutaway when an NPC stands on the building's tile.
   *
   * Layer order on the SAME tile (smaller sortKey draws first):
   *   1. floor          (sortKey - 0.1)  — wood/stone diamond on the ground
   *   2. back-structure (sortKey - 0.05) — right-side iso wall + back wall
   *   3. citizen        (sortKey + 0.01) — NPC sprite stands on the floor
   *   4. front+roof     (sortKey + 0.5)  — front wall, door, roof, glyph
   *                                         (roof fades to 0.25α when occupied,
   *                                          walls stay opaque)
   *
   * The front-wall is intentionally NOT faded — the prompt asks for the
   * NPC to be "behind any foreground walls so they look like they're
   * standing inside the room." Only the roof goes transparent.
   */
  private drawBuildingFloor(b: Building, def: ReturnType<typeof getBuildingDef>, x: number, y: number, ts: number) {
    if (b.status === "rubble") return;
    if (def.category === "service" && b.typeId === "well") return; // wells use legacy combined draw
    // Phase 22 — when a PNG sprite is loaded for this building type the
    // sprite is the entire visual (drawn in the FRONT layer below); the
    // floor / back-structure / front-and-roof procedural decomposition
    // is suppressed so we don't double-render planks behind the sprite.
    if (this.spriteAssets.has(`building.${b.typeId}`)) return;
    // Phase 21: scaffolded foundations replace the normal floor + furniture
    // for any building that hasn't completed construction yet. Drawn ONLY in
    // the floor layer; the back-wall + front-wall + roof renderers early-out
    // for incomplete builds, so the cumulative visual is just a dirt patch
    // with wooden corner posts and a horizontal scaffolding beam.
    if (b.complete === false) {
      this.drawConstructionScaffolding(b, x, y, ts);
      return;
    }
    const ctx = this.ctx;
    const isNight = this.state.dayNight === "night";
    const cx = x + ts * 0.5;
    const groundY = y + ts * 0.55;

    // Soft elongated drop shadow beneath the building.
    ctx.fillStyle = isNight ? "rgba(0,0,0,0.20)" : "rgba(0,0,0,0.36)";
    ctx.beginPath();
    const shadowOff = isNight ? 0.02 : 0.10;
    ctx.ellipse(
      x + ts * (0.5 + shadowOff),
      y + ts * 0.93,
      ts * (0.46 + shadowOff),
      ts * 0.09,
      0, 0, Math.PI * 2
    );
    ctx.fill();

    // Interior floor diamond — warm wood for residential, stone for service,
    // packed earth for production. Sized to a 2:1 dimetric diamond inside
    // the building footprint so it reads as floor planks on the ground.
    let floorColor = "#a87a4a";
    let floorDark = "#7a5a32";
    if (def.category === "service") {
      floorColor = "#8a8278";
      floorDark = "#5a544c";
    } else if (def.category === "production") {
      floorColor = "#9a7a52";
      floorDark = "#6a5236";
    }
    if (b.typeId === "house_high") {
      floorColor = "#c8a878";
      floorDark = "#8a6c44";
    }

    const fw = ts * 0.86;
    const fh = fw * 0.5;
    // Diamond points (top, right, bottom, left)
    const tx = cx, ty = groundY - fh * 0.5;
    const rx = cx + fw * 0.5, ry = groundY;
    const bx = cx, by = groundY + fh * 0.5;
    const lx = cx - fw * 0.5, ly = groundY;

    // Floor fill with subtle gradient (lighter at the top-left, darker at
    // the bottom-right) for a hint of iso lighting.
    const grad = ctx.createLinearGradient(lx, ty, rx, by);
    grad.addColorStop(0, floorColor);
    grad.addColorStop(1, floorDark);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(rx, ry);
    ctx.lineTo(bx, by);
    ctx.lineTo(lx, ly);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Plank seams — three thin lines parallel to the iso "floorboard"
    // direction (top-left → bottom-right axis), giving the floor a
    // recognizable wooden-plank read.
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 0.6;
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      // Interpolate seam endpoints along the left and right edges.
      const x1 = tx + (lx - tx) * t;
      const y1 = ty + (ly - ty) * t;
      const x2 = rx + (bx - rx) * t;
      const y2 = ry + (by - ry) * t;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Phase 15: Interior furniture stamps — visible whenever the roof
    // fades to 0.25α (any NPC on the building tile). Drawn on the FLOOR
    // layer so they sit BEHIND the citizen sprite (sortKey -0.10 vs
    // citizen sortKey +0.01) but inside the back-wall (sortKey -0.05),
    // giving the dollhouse cutaway a furnished interior. Each layout is
    // axis-aligned to the iso diamond and clipped to ~70% of the floor
    // footprint so it stays clear of the back/right walls.
    this.drawInteriorFurniture(ctx, b, def, cx, groundY, fw, fh);
  }

  /**
   * Phase 15: Per-building-type furniture stamp. Drawn into the floor
   * diamond after the planks. Cheap (just rects + ellipses, no images).
   * Variants:
   *   - residential: bed (with pillow) + small wooden table
   *   - house_high:  ornate bed + table with goblet (gold accents)
   *   - tavern:      bar counter + stool + barrel
   *   - apothecary:  potion shelves with green/red/blue vials
   *   - dungeon:     iron-bar grate + straw pile
   *   - production farm/mill: grain sacks + flour barrel
   *   - production mine: ore pile + pickaxe rest
   *   - production lumber: log stack
   *   - service church: pew + altar
   *   - service medical: cot + apothecary cabinet
   *   - service generic: simple bench
   */
  private drawInteriorFurniture(
    ctx: CanvasRenderingContext2D,
    b: Building,
    def: ReturnType<typeof getBuildingDef>,
    cx: number, groundY: number, fw: number, fh: number,
  ) {
    // Position helpers — left third / center / right third of the floor.
    const leftX = cx - fw * 0.22;
    const rightX = cx + fw * 0.22;
    const backY = groundY - fh * 0.18;
    const frontY = groundY + fh * 0.10;

    const t = b.typeId;
    const cat = def.category;

    // Helper: a small wooden table (top + 2 visible legs).
    const drawTable = (tx: number, ty: number, w: number, h: number, ornate = false) => {
      ctx.fillStyle = "#6b4a28";
      ctx.fillRect(tx - w / 2, ty - h * 0.15, w, h * 0.18);
      ctx.fillStyle = "#4a3018";
      ctx.fillRect(tx - w / 2 + 1, ty + h * 0.03, 2, h * 0.30);
      ctx.fillRect(tx + w / 2 - 3, ty + h * 0.03, 2, h * 0.30);
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(tx - w / 2, ty - h * 0.15, w, h * 0.18);
      if (ornate) {
        // Gold goblet on the table
        ctx.fillStyle = "#d4af37";
        ctx.fillRect(tx - 1.5, ty - h * 0.30, 3, h * 0.18);
      }
    };

    // Helper: a bed with a darker frame, lighter mattress, and pillow.
    const drawBed = (bx: number, by: number, w: number, h: number, ornate = false) => {
      // Frame
      ctx.fillStyle = ornate ? "#5a3a1a" : "#4a3018";
      ctx.fillRect(bx - w / 2, by - h / 2, w, h);
      // Mattress
      ctx.fillStyle = ornate ? "#e0c890" : "#c8b48e";
      ctx.fillRect(bx - w / 2 + 2, by - h / 2 + 1.5, w - 4, h - 3);
      // Pillow at the head (top-left quadrant)
      ctx.fillStyle = "#f5efde";
      ctx.fillRect(bx - w / 2 + 3, by - h / 2 + 2.5, w * 0.32, h * 0.30);
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(bx - w / 2, by - h / 2, w, h);
      if (ornate) {
        // Gold trim along the foot of the bed
        ctx.fillStyle = "#d4af37";
        ctx.fillRect(bx - w / 2, by + h / 2 - 1.5, w, 1.2);
      }
    };

    // Compact shelf with three colored vials.
    const drawShelf = (sx: number, sy: number, w: number, h: number) => {
      ctx.fillStyle = "#5a3a1c";
      ctx.fillRect(sx - w / 2, sy - h * 0.35, w, h * 0.10);  // top shelf board
      ctx.fillRect(sx - w / 2, sy + h * 0.15, w, h * 0.10);  // bottom shelf board
      const colors = ["#7fc97f", "#ef5e5e", "#5e8eef"];
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = colors[i];
        const vx = sx - w / 2 + 2 + i * (w / 3);
        ctx.fillRect(vx, sy - h * 0.30, 2.2, h * 0.18);
        ctx.fillRect(vx, sy + h * 0.20, 2.2, h * 0.18);
      }
    };

    if (cat === "residential") {
      // house_high gets gold accents (ornate=true); house_free/house_middle plain.
      const ornate = t === "house_high";
      drawBed(leftX, frontY + fh * 0.05, fw * 0.28, fh * 0.32, ornate);
      drawTable(rightX, backY + fh * 0.10, fw * 0.20, fh * 0.40, ornate);
    } else if (t === "tavern") {
      // Bar counter along the back-right
      ctx.fillStyle = "#6b4a28";
      ctx.fillRect(cx - fw * 0.05, backY - fh * 0.05, fw * 0.40, fh * 0.18);
      ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.6;
      ctx.strokeRect(cx - fw * 0.05, backY - fh * 0.05, fw * 0.40, fh * 0.18);
      // Three mug circles on the bar
      ctx.fillStyle = "#caa15a";
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(cx + fw * 0.02 + i * fw * 0.10, backY + fh * 0.02, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Barrel on the front-left
      ctx.fillStyle = "#7a5028";
      ctx.beginPath();
      ctx.ellipse(leftX, frontY + fh * 0.08, fw * 0.07, fh * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.lineWidth = 0.7;
      ctx.stroke();
      // Two iron bands on the barrel
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.beginPath(); ctx.ellipse(leftX, frontY + fh * 0.04, fw * 0.07, fh * 0.04, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(leftX, frontY + fh * 0.12, fw * 0.07, fh * 0.04, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (t === "apothecary") {
      drawShelf(leftX, backY + fh * 0.05, fw * 0.32, fh * 0.42);
      drawShelf(rightX, backY + fh * 0.05, fw * 0.32, fh * 0.42);
      // Mortar + pestle in the center foreground
      ctx.fillStyle = "#a89070";
      ctx.beginPath();
      ctx.ellipse(cx, frontY + fh * 0.05, fw * 0.06, fh * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#5a4830";
      ctx.fillRect(cx + fw * 0.03, frontY - fh * 0.02, 1.5, fh * 0.18);
    } else if (t === "dungeon") {
      // Iron-bar window grate at the back
      ctx.strokeStyle = "#3a3a3a";
      ctx.lineWidth = 1.2;
      const barW = fw * 0.30;
      const barH = fh * 0.20;
      const barX = cx - barW / 2;
      const barY = backY - fh * 0.05;
      ctx.strokeRect(barX, barY, barW, barH);
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(barX + (barW * i) / 4, barY);
        ctx.lineTo(barX + (barW * i) / 4, barY + barH);
        ctx.stroke();
      }
      // Straw pile in the front
      ctx.fillStyle = "#c8a050";
      for (let i = 0; i < 6; i++) {
        const angle = i * 0.4;
        const sx = leftX + Math.cos(angle) * fw * 0.05;
        const sy = frontY + Math.sin(angle) * fh * 0.06;
        ctx.fillRect(sx, sy, 4, 1);
      }
      // Manacles (small iron ring) on the right
      ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(rightX, frontY, fw * 0.04, 0, Math.PI * 2);
      ctx.stroke();
    } else if (cat === "production") {
      if (t === "farm" || t === "bakery") {
        // Stack of three grain sacks
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = i === 1 ? "#caa15a" : "#b8945a";
          ctx.beginPath();
          ctx.ellipse(leftX + (i - 1) * fw * 0.06, frontY + fh * 0.04, fw * 0.06, fh * 0.10, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.5; ctx.stroke();
        }
        // Wheat sheaf in the back
        ctx.strokeStyle = "#d4b860"; ctx.lineWidth = 1;
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(rightX + (i - 1.5) * 2, backY + fh * 0.10);
          ctx.lineTo(rightX + (i - 1.5) * 2, backY - fh * 0.05);
          ctx.stroke();
        }
      } else if (t === "mine") {
        // Pile of dark ore chunks
        ctx.fillStyle = "#3a3a44";
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.arc(cx + (i - 2) * fw * 0.04, frontY + fh * 0.04 - (i % 2) * fh * 0.05, fw * 0.035, 0, Math.PI * 2);
          ctx.fill();
        }
        // A tiny gleam
        ctx.fillStyle = "#a8c8e8";
        ctx.beginPath();
        ctx.arc(cx + fw * 0.02, frontY - fh * 0.01, 1.2, 0, Math.PI * 2);
        ctx.fill();
        // Pickaxe leaning on the right wall
        ctx.strokeStyle = "#6b4a28"; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(rightX, backY); ctx.lineTo(rightX + fw * 0.05, backY + fh * 0.30); ctx.stroke();
        ctx.fillStyle = "#9aa0ad";
        ctx.fillRect(rightX - fw * 0.03, backY - fh * 0.04, fw * 0.10, 2);
      } else if (t === "lumber_camp") {
        // Log stack
        ctx.fillStyle = "#7a5028";
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.ellipse(cx, frontY + fh * 0.05 - i * fh * 0.07, fw * 0.18, fh * 0.05, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.5; ctx.stroke();
          // Tree-ring marks on the left end
          ctx.strokeStyle = "#4a2818"; ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.arc(cx - fw * 0.18, frontY + fh * 0.05 - i * fh * 0.07, fh * 0.025, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    } else if (cat === "service") {
      // Phase 14 service buildings: well (handled by legacy combined draw,
      // returned early), dungeon, apothecary, tavern (all handled above).
      // This generic-service fallback is a safety net for any future
      // service building that doesn't have its own furniture branch yet.
      {
        // Generic service: a simple bench
        ctx.fillStyle = "#6b4a28";
        ctx.fillRect(cx - fw * 0.20, frontY + fh * 0.04, fw * 0.40, fh * 0.06);
        ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 0.5;
        ctx.strokeRect(cx - fw * 0.20, frontY + fh * 0.04, fw * 0.40, fh * 0.06);
      }
    }
  }

  /**
   * Phase 14b "Dollhouse" — back-structure layer. Draws the iso right-side
   * wall (parallelogram) and a thin back-wall strip. These appear BEHIND
   * the NPC in iso projection so they go in the queue at sortKey - 0.05,
   * before the citizen (sortKey + 0.01).
   */
  private drawBuildingBackStructure(b: Building, def: ReturnType<typeof getBuildingDef>, x: number, y: number, ts: number) {
    if (b.status === "rubble") return;
    if (def.category === "service" && b.typeId === "well") return;
    // Phase 22 — sprite handles the whole structure when loaded.
    if (this.spriteAssets.has(`building.${b.typeId}`)) return;
    // Phase 21: incomplete buildings have no back wall — the foundation
    // layer drew the scaffolding visual already.
    if (b.complete === false) return;
    const ctx = this.ctx;
    // Phase 14b: building scale bumped from pad=0.15 to pad=0.07 (≈86%
    // tile width) so houses fill their tile substantially per the prompt.
    const pad = ts * 0.07;
    const w = ts - pad * 2;
    const h = ts - pad * 2;
    const px = x + pad;
    const py = y + pad;
    const wallH = h * 0.55;
    const roofH = h * 0.45;
    const wallTopY = py + roofH * 0.55;
    const wallBotY = wallTopY + wallH;
    const sideDepth = w * 0.14;
    const sideColor = this.shadeHex(def.fillColor, -0.35);
    const backColor = this.shadeHex(def.fillColor, -0.2);

    // Back wall — a thin strip drawn at the rear of the floor, giving
    // the room a back wall to "lean against" so the NPC doesn't look
    // like they're floating in a doorless rectangle.
    ctx.fillStyle = backColor;
    ctx.fillRect(px, wallTopY, w, wallH * 0.35);
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px, wallTopY, w, wallH * 0.35);

    // Right-side wall (faux-iso): parallelogram offset to upper-right.
    ctx.fillStyle = sideColor;
    ctx.beginPath();
    ctx.moveTo(px + w, wallTopY);
    ctx.lineTo(px + w + sideDepth, wallTopY - sideDepth * 0.6);
    ctx.lineTo(px + w + sideDepth, wallBotY - sideDepth * 0.6);
    ctx.lineTo(px + w, wallBotY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * Phase 14b "Dollhouse" — front wall + roof layer. Drawn AFTER the
   * citizen in the depth queue. The front wall stays fully opaque so it
   * still occludes the lower body of the NPC like a real wall would; the
   * roof is the only piece that fades to `roofAlpha` when an NPC is
   * inside, giving the cutaway dollhouse view.
   */
  private drawBuildingFrontAndRoof(
    b: Building,
    def: ReturnType<typeof getBuildingDef>,
    x: number,
    y: number,
    ts: number,
    roofAlpha: number
  ) {
    if (b.status === "rubble") return;
    if (def.category === "service" && b.typeId === "well") return;
    // Phase 22 — sprite-first: blit the building PNG anchored bottom-center
    // on the iso diamond. We pick the front-and-roof slot for the blit so
    // the sprite sits in the depth queue at the same sortKey as the
    // procedural front wall, preserving NPC-behind-wall occlusion ordering.
    // Roof transparency (when an NPC is inside) is honored via globalAlpha.
    if (this.spriteAssets.has(`building.${b.typeId}`)) {
      const ctx = this.ctx;
      const prevAlpha = ctx.globalAlpha;
      // Mix roofAlpha (0..1) into the sprite blit so the dollhouse
      // cutaway still works when an NPC enters the building.
      ctx.globalAlpha = prevAlpha * Math.max(roofAlpha, 0.6);
      this.spriteAssets.tryDraw(ctx, `building.${b.typeId}`, x, y, ts);
      ctx.globalAlpha = prevAlpha;
      return;
    }
    // Phase 21: incomplete buildings have no walls or roof — only the
    // scaffolded foundation rendered by drawBuildingFloor.
    if (b.complete === false) return;
    const ctx = this.ctx;
    const isNight = this.state.dayNight === "night";
    const pad = ts * 0.07;
    const w = ts - pad * 2;
    const h = ts - pad * 2;
    const px = x + pad;
    const py = y + pad;
    const wallH = h * 0.55;
    const roofH = h * 0.45;
    const wallTopY = py + roofH * 0.55;
    const wallBotY = wallTopY + wallH;
    const sideDepth = w * 0.14;

    // ── Front wall (always opaque — the "foreground wall" the prompt asks
    // the NPC to stand BEHIND) ───────────────────────────────────────────
    // Front wall fill — but only the LOWER portion so the NPC's torso
    // peeks above the front wall. Upper portion is already drawn by the
    // back-wall strip in drawBuildingBackStructure.
    const frontWallTop = wallTopY + wallH * 0.35;
    const frontWallH = wallH - wallH * 0.35;
    ctx.fillStyle = def.fillColor;
    ctx.fillRect(px, frontWallTop, w, frontWallH);

    // Wood/stone grain — thin horizontal lines on the front wall.
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 0.6;
    for (let gy = frontWallTop + frontWallH * 0.30; gy < wallBotY; gy += frontWallH * 0.30) {
      ctx.beginPath();
      ctx.moveTo(px + 1, gy);
      ctx.lineTo(px + w - 1, gy);
      ctx.stroke();
    }
    // Phase 21: half-timbered beams — dark wooden vertical posts at the
    // wall edges plus a diagonal cross brace, painted on top of the wall
    // fill. Skipped for production buildings (mines/lumber camps don't
    // have residential half-timbering) and for the well (which uses a
    // legacy combined render).
    if (def.category !== "production" && b.typeId !== "well") {
      const beamColor = "rgba(58, 36, 18, 0.78)";
      const beamW = Math.max(1.2, ts * 0.022);
      ctx.fillStyle = beamColor;
      // Two vertical beams flush with the wall edges
      ctx.fillRect(px, frontWallTop, beamW, frontWallH);
      ctx.fillRect(px + w - beamW, frontWallTop, beamW, frontWallH);
      // Horizontal beam at the wall midline (a "girt" in real timber framing)
      const girtY = frontWallTop + frontWallH * 0.50 - beamW * 0.5;
      ctx.fillRect(px + beamW, girtY, w - beamW * 2, beamW);
      // Diagonal cross brace on the LEFT half of the wall (skipped on the
      // right half so it doesn't collide with the door/window detailing)
      ctx.save();
      ctx.strokeStyle = beamColor;
      ctx.lineWidth = beamW;
      ctx.lineCap = "square";
      ctx.beginPath();
      ctx.moveTo(px + beamW, frontWallTop + frontWallH);
      ctx.lineTo(px + w * 0.32, frontWallTop + beamW);
      ctx.stroke();
      ctx.restore();
    }
    // Door / windows (door for residential + service, windows for production).
    if (def.category !== "production") {
      ctx.fillStyle = "rgba(40,20,10,0.55)";
      const doorW = w * 0.18;
      const doorH = frontWallH * 0.75;
      ctx.fillRect(px + w * 0.5 - doorW * 0.5, wallBotY - doorH, doorW, doorH);
      ctx.fillStyle = "rgba(60,30,15,0.55)";
      ctx.beginPath();
      ctx.arc(px + w * 0.5, wallBotY - doorH, doorW * 0.5, Math.PI, 0);
      ctx.fill();
    } else {
      ctx.fillStyle = "rgba(80,60,25,0.7)";
      ctx.fillRect(px + w * 0.30, frontWallTop + frontWallH * 0.20, w * 0.18, frontWallH * 0.35);
      ctx.fillRect(px + w * 0.55, frontWallTop + frontWallH * 0.20, w * 0.18, frontWallH * 0.35);
    }
    // Front-wall outline.
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px, frontWallTop, w, frontWallH);

    // Window glow at night (on front wall, fades with roof alpha so the
    // cutaway view feels consistent — a glowing window on a transparent
    // roof would look weird).
    if (isNight && def.category !== "production") {
      ctx.save();
      ctx.globalAlpha = roofAlpha;
      ctx.fillStyle = "rgba(255,210,120,0.65)";
      ctx.fillRect(px + w * 0.18, frontWallTop + frontWallH * 0.20, w * 0.10, frontWallH * 0.25);
      ctx.fillRect(px + w * 0.72, frontWallTop + frontWallH * 0.20, w * 0.10, frontWallH * 0.25);
      ctx.restore();
    }

    // ── Roof (this is what fades) ──────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = roofAlpha;

    const roofPeakX = px + w * 0.5;
    const roofPeakY = py;
    const roofLeftX = px - w * 0.06;
    const roofRightX = px + w + w * 0.06;
    const roofBaseY = wallTopY;

    // Left roof slope (lit)
    ctx.fillStyle = def.roofColor;
    ctx.beginPath();
    ctx.moveTo(roofLeftX, roofBaseY);
    ctx.lineTo(roofPeakX, roofPeakY);
    ctx.lineTo(roofPeakX, roofBaseY);
    ctx.closePath();
    ctx.fill();

    // Right roof slope (shaded) with iso side
    ctx.fillStyle = this.shadeHex(def.roofColor, -0.25);
    ctx.beginPath();
    ctx.moveTo(roofPeakX, roofPeakY);
    ctx.lineTo(roofRightX, roofBaseY);
    ctx.lineTo(roofPeakX, roofBaseY);
    ctx.closePath();
    ctx.fill();

    // Iso roof depth wedge along right side
    ctx.fillStyle = this.shadeHex(def.roofColor, -0.45);
    ctx.beginPath();
    ctx.moveTo(roofRightX, roofBaseY);
    ctx.lineTo(roofRightX + sideDepth, roofBaseY - sideDepth * 0.6);
    ctx.lineTo(roofPeakX + sideDepth * 0.5, roofPeakY - sideDepth * 0.3);
    ctx.lineTo(roofPeakX, roofPeakY);
    ctx.closePath();
    ctx.fill();

    // Shingle texture
    ctx.strokeStyle = "rgba(0,0,0,0.30)";
    ctx.lineWidth = 0.6;
    for (let s = 0.2; s < 1; s += 0.22) {
      const lx1 = roofLeftX + (roofPeakX - roofLeftX) * s;
      const ly1 = roofBaseY + (roofPeakY - roofBaseY) * s;
      const ly2 = ly1;
      ctx.beginPath();
      ctx.moveTo(lx1, ly1);
      ctx.lineTo(roofPeakX, ly2);
      ctx.stroke();
      const rx2 = roofRightX + (roofPeakX - roofRightX) * s;
      const ry2 = roofBaseY + (roofPeakY - roofBaseY) * s;
      ctx.beginPath();
      ctx.moveTo(roofPeakX, ry2);
      ctx.lineTo(rx2, ry2);
      ctx.stroke();
    }

    // Roof ridge outline
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(roofLeftX, roofBaseY);
    ctx.lineTo(roofPeakX, roofPeakY);
    ctx.lineTo(roofRightX, roofBaseY);
    ctx.stroke();

    ctx.restore(); // end roof-alpha block

    // Gold tier indicator for high manors — full alpha (it's a status sign,
    // not part of the roof itself).
    if (b.typeId === "house_high") {
      ctx.fillStyle = "#ffd84a";
      ctx.shadowColor = "rgba(255, 200, 50, 0.8)";
      ctx.shadowBlur = ts * 0.12;
      ctx.beginPath();
      ctx.arc(x + ts * 0.5, py - h * 0.10, ts * 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Phase 14 glyph badge for the three new building kinds — full alpha
    // (the sign should stay readable even when the roof goes transparent).
    if (
      this.state.camera.zoom > 0.5 &&
      (b.typeId === "dungeon" || b.typeId === "apothecary" || b.typeId === "tavern")
    ) {
      const glyph = b.typeId === "dungeon" ? "‖" : b.typeId === "apothecary" ? "+" : "🍺";
      const color = b.typeId === "dungeon" ? "#9aa3ad" : b.typeId === "apothecary" ? "#e84545" : "#d4a04a";
      const badgeCx = x + ts * 0.5;
      const badgeCy = roofPeakY - ts * 0.10;
      const haloR = ts * 0.13;
      const grad = ctx.createRadialGradient(badgeCx, badgeCy, 0, badgeCx, badgeCy, haloR);
      grad.addColorStop(0, color + "cc");
      grad.addColorStop(1, color + "00");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(badgeCx, badgeCy, haloR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0d1117";
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, ts * 0.012);
      ctx.font = `bold ${Math.round(ts * 0.22)}px Georgia, serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeText(glyph, badgeCx, badgeCy);
      ctx.fillText(glyph, badgeCx, badgeCy);
    }

    // Phase 19: center letter-glyph overlay (F/B/H/L) removed per the
    // "no text labels for entities" directive. Building identity now
    // comes from silhouette, roof color, and door/window detailing.
    // The Phase-14 special-building badge (tavern/dungeon/apothecary)
    // above keeps its iconographic symbol (‖ + 🍺) since those are
    // icons, not letter placeholders.
  }

  /** Phase 5: draw a wreck — a few broken stones in dark grey + soot. */
  private drawRubble(x: number, y: number, ts: number) {
    const ctx = this.ctx;
    const cx = x + ts * 0.5;
    const cy = y + ts * 0.6;
    // Soot patch
    ctx.fillStyle = "rgba(20, 12, 10, 0.55)";
    ctx.beginPath();
    ctx.ellipse(cx, cy + ts * 0.1, ts * 0.42, ts * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    // Three broken stone chunks
    const chunks: [number, number, number][] = [
      [-0.22, -0.05, 0.20],
      [0.05, 0.05, 0.16],
      [0.18, -0.12, 0.13],
    ];
    for (const [dx, dy, sz] of chunks) {
      ctx.fillStyle = "#5a5046";
      ctx.beginPath();
      ctx.arc(cx + dx * ts, cy + dy * ts, sz * ts, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /**
   * Phase 10: Faux-isometric building render. Each non-service building gets:
   *   - Soft elongated drop shadow on the ground (longer at "day")
   *   - Right-side wall (parallelogram) shaded darker for 3D effect
   *   - Front wall with horizontal "wood/stone grain" lines (texture)
   *   - Pitched gable roof with "shingle/thatch" texture lines
   *   - Tier-specific gold accent for high-class manors
   */
  private drawBuilding(
    b: Building,
    def: ReturnType<typeof getBuildingDef>,
    x: number,
    y: number,
    ts: number
  ) {
    const ctx = this.ctx;
    // Phase 22 — sprite-first: if a PNG for this building type is loaded,
    // blit it (anchored bottom-center on the iso diamond) and skip the
    // procedural well/house draw entirely. Falls through harmlessly when
    // no PNG exists, preserving the current visual 1:1.
    if (this.spriteAssets.tryDraw(ctx, `building.${b.typeId}`, x, y, ts)) return;
    const pad = ts * 0.15;
    const w = ts - pad * 2;
    const h = ts - pad * 2;
    const px = x + pad;
    const py = y + pad;

    // Phase 14: only the well keeps the round well-head silhouette. The new
    // service buildings (dungeon / apothecary / tavern) fall through to the
    // generic iso building path below — their distinct fillColor + roofColor
    // + glyph overlay (drawn at high zoom) give them visual identity.
    if (def.category === "service" && b.typeId === "well") {
      // Service (well) — circular with rim shading + glint
      const cx = x + ts * 0.5;
      const cy = y + ts * 0.5;
      // shadow
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      ctx.beginPath();
      ctx.ellipse(cx + ts * 0.05, cy + ts * 0.18, w * 0.42, h * 0.10, 0, 0, Math.PI * 2);
      ctx.fill();
      // body
      const grad = ctx.createRadialGradient(cx - w * 0.15, cy - h * 0.15, 0, cx, cy, w * 0.5);
      grad.addColorStop(0, def.fillColor);
      grad.addColorStop(1, this.shadeHex(def.fillColor, -0.35));
      ctx.fillStyle = grad;
      ctx.strokeStyle = def.roofColor;
      ctx.lineWidth = ts * 0.06;
      ctx.beginPath();
      ctx.arc(cx, cy, w * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // inner ring
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, w * 0.30, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    // ---- Faux-isometric house / production ----
    const wallH = h * 0.55;
    const roofH = h * 0.45;
    const wallTopY = py + roofH * 0.55;
    const wallBotY = wallTopY + wallH;
    const isNight = this.state.dayNight === "night";

    // Soft elongated drop shadow (longer at day, smaller at night)
    ctx.fillStyle = isNight ? "rgba(0,0,0,0.20)" : "rgba(0,0,0,0.36)";
    ctx.beginPath();
    const shadowOff = isNight ? 0.02 : 0.10;
    ctx.ellipse(
      x + ts * (0.5 + shadowOff),
      y + ts * 0.93,
      w * (0.46 + shadowOff),
      h * 0.09,
      0, 0, Math.PI * 2
    );
    ctx.fill();

    // Right-side wall (faux-iso): parallelogram offset to upper-right
    const sideDepth = w * 0.14;
    const sideColor = this.shadeHex(def.fillColor, -0.35);
    ctx.fillStyle = sideColor;
    ctx.beginPath();
    ctx.moveTo(px + w, wallTopY);
    ctx.lineTo(px + w + sideDepth, wallTopY - sideDepth * 0.6);
    ctx.lineTo(px + w + sideDepth, wallBotY - sideDepth * 0.6);
    ctx.lineTo(px + w, wallBotY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Front wall fill
    ctx.fillStyle = def.fillColor;
    ctx.fillRect(px, wallTopY, w, wallH);

    // Wood/stone grain — thin horizontal lines
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 0.6;
    for (let gy = wallTopY + wallH * 0.25; gy < wallBotY; gy += wallH * 0.22) {
      ctx.beginPath();
      ctx.moveTo(px + 1, gy);
      ctx.lineTo(px + w - 1, gy);
      ctx.stroke();
    }
    // Subtle wall vertical seam (door slot)
    if (def.category !== "production") {
      ctx.fillStyle = "rgba(40,20,10,0.55)";
      const doorW = w * 0.18;
      const doorH = wallH * 0.55;
      ctx.fillRect(px + w * 0.5 - doorW * 0.5, wallBotY - doorH, doorW, doorH);
      // Door arch top
      ctx.fillStyle = "rgba(60,30,15,0.55)";
      ctx.beginPath();
      ctx.arc(px + w * 0.5, wallBotY - doorH, doorW * 0.5, Math.PI, 0);
      ctx.fill();
    } else {
      // Production: small dark window
      ctx.fillStyle = "rgba(80,60,25,0.7)";
      ctx.fillRect(px + w * 0.30, wallTopY + wallH * 0.25, w * 0.18, wallH * 0.30);
      ctx.fillRect(px + w * 0.55, wallTopY + wallH * 0.25, w * 0.18, wallH * 0.30);
    }

    // Wall outline
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px, wallTopY, w, wallH);

    // ---- Roof (gable) with shingle texture ----
    const roofPeakX = px + w * 0.5;
    const roofPeakY = py;
    const roofLeftX = px - w * 0.06;
    const roofRightX = px + w + w * 0.06;
    const roofBaseY = wallTopY;

    // Left roof slope (lit)
    ctx.fillStyle = def.roofColor;
    ctx.beginPath();
    ctx.moveTo(roofLeftX, roofBaseY);
    ctx.lineTo(roofPeakX, roofPeakY);
    ctx.lineTo(roofPeakX, roofBaseY);
    ctx.closePath();
    ctx.fill();

    // Right roof slope (shaded) with iso side
    ctx.fillStyle = this.shadeHex(def.roofColor, -0.25);
    ctx.beginPath();
    ctx.moveTo(roofPeakX, roofPeakY);
    ctx.lineTo(roofRightX, roofBaseY);
    ctx.lineTo(roofPeakX, roofBaseY);
    ctx.closePath();
    ctx.fill();

    // Iso roof depth wedge along right side
    ctx.fillStyle = this.shadeHex(def.roofColor, -0.45);
    ctx.beginPath();
    ctx.moveTo(roofRightX, roofBaseY);
    ctx.lineTo(roofRightX + sideDepth, roofBaseY - sideDepth * 0.6);
    ctx.lineTo(roofPeakX + sideDepth * 0.5, roofPeakY - sideDepth * 0.3);
    ctx.lineTo(roofPeakX, roofPeakY);
    ctx.closePath();
    ctx.fill();

    // Shingle texture: parallel rows of short ticks on each slope
    ctx.strokeStyle = "rgba(0,0,0,0.30)";
    ctx.lineWidth = 0.6;
    for (let s = 0.2; s < 1; s += 0.22) {
      // Left slope row
      const lx1 = roofLeftX + (roofPeakX - roofLeftX) * s;
      const ly1 = roofBaseY + (roofPeakY - roofBaseY) * s;
      const lx2 = roofPeakX;
      const ly2 = roofBaseY + (roofPeakY - roofBaseY) * s;
      ctx.beginPath();
      ctx.moveTo(lx1, ly1);
      ctx.lineTo(lx2, ly2);
      ctx.stroke();
      // Right slope row
      const rx1 = roofPeakX;
      const ry1 = roofBaseY + (roofPeakY - roofBaseY) * s;
      const rx2 = roofRightX + (roofPeakX - roofRightX) * s;
      const ry2 = roofBaseY + (roofPeakY - roofBaseY) * s;
      ctx.beginPath();
      ctx.moveTo(rx1, ry1);
      ctx.lineTo(rx2, ry2);
      ctx.stroke();
    }

    // Roof ridge highlight + outline
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(roofLeftX, roofBaseY);
    ctx.lineTo(roofPeakX, roofPeakY);
    ctx.lineTo(roofRightX, roofBaseY);
    ctx.stroke();

    // Gold tier indicator for high manors
    if (b.typeId === "house_high") {
      ctx.fillStyle = "#ffd84a";
      ctx.shadowColor = "rgba(255, 200, 50, 0.8)";
      ctx.shadowBlur = ts * 0.12;
      ctx.beginPath();
      ctx.arc(x + ts * 0.5, py - h * 0.10, ts * 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Phase 14: glyph badge for the three new building kinds. Drawn just
    // above the roof peak so it reads as a "sign" hanging over the door.
    // Skipped at very low zoom to keep the world overview readable.
    if (
      this.state.camera.zoom > 0.5 &&
      (b.typeId === "dungeon" || b.typeId === "apothecary" || b.typeId === "tavern")
    ) {
      const glyph = b.typeId === "dungeon" ? "‖" : b.typeId === "apothecary" ? "+" : "🍺";
      const color = b.typeId === "dungeon" ? "#9aa3ad" : b.typeId === "apothecary" ? "#e84545" : "#d4a04a";
      const badgeCx = x + ts * 0.5;
      const badgeCy = roofPeakY - ts * 0.10;
      // Halo for legibility
      const haloR = ts * 0.13;
      const grad = ctx.createRadialGradient(badgeCx, badgeCy, 0, badgeCx, badgeCy, haloR);
      grad.addColorStop(0, color + "cc");
      grad.addColorStop(1, color + "00");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(badgeCx, badgeCy, haloR, 0, Math.PI * 2);
      ctx.fill();
      // Glyph
      ctx.fillStyle = "#0d1117";
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, ts * 0.012);
      ctx.font = `bold ${Math.round(ts * 0.22)}px Georgia, serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeText(glyph, badgeCx, badgeCy);
      ctx.fillText(glyph, badgeCx, badgeCy);
    }

    // Window glow at night
    if (isNight && def.category !== "production") {
      ctx.fillStyle = "rgba(255,210,120,0.65)";
      ctx.fillRect(px + w * 0.18, wallTopY + wallH * 0.22, w * 0.10, wallH * 0.18);
      ctx.fillRect(px + w * 0.72, wallTopY + wallH * 0.22, w * 0.10, wallH * 0.18);
    }
  }

  /** Lighten (>0) or darken (<0) a #rrggbb hex color by `amt` in [-1, 1]. */
  private shadeHex(hex: string, amt: number): string {
    const [r, g, b] = this.hexToRgb(hex);
    const adj = (v: number) =>
      Math.max(0, Math.min(255, Math.round(v + (amt < 0 ? v * amt : (255 - v) * amt))));
    return `rgb(${adj(r)},${adj(g)},${adj(b)})`;
  }

  /**
   * Build (or rebuild) a pre-rendered humanoid sprite for a given social tier.
   * Sprite = head circle + body rectangle (legs are drawn live for animation).
   * Stamping these at draw-time keeps perf flat at 100+ citizens since the
   * static body never re-paints per frame.
   */
  private buildNpcSprite(tier: "peasant" | "noble" | "king"): HTMLCanvasElement {
    const ts = this.state.grid.tileSize;
    // Sprite canvas covers head + body + small crown overhead. Legs sit below
    // the canvas so we don't bake them in (they animate per frame).
    const W = Math.ceil(ts * 0.7);
    const H = Math.ceil(ts * 1.0);
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const c = cv.getContext("2d")!;

    const cx = W / 2;
    const bodyW = ts * 0.42;
    const bodyH = ts * 0.46;
    const headR = ts * 0.16;
    const headCy = H * 0.36;
    const bodyTop = headCy + headR * 0.6;

    // Phase 7: Procedural gradients on the tunic — top is the rich hue,
    // bottom is a darker shade to fake directional lighting.
    const bodyTopColor =
      tier === "peasant" ? "#B8956F" :        // Warm tan top
      tier === "noble"   ? "#A044F5" :        // Bright royal purple
                           "#A044F5";         // King shares noble base
    const bodyBotColor =
      tier === "peasant" ? "#6E5440" :        // Deep mud shadow
      tier === "noble"   ? "#5A1B95" :        // Plum shadow
                           "#5A1B95";
    const grad = c.createLinearGradient(0, bodyTop, 0, bodyTop + bodyH);
    grad.addColorStop(0, bodyTopColor);
    grad.addColorStop(1, bodyBotColor);
    const headColor = "#F2C9A0";              // Skin tone (shared)

    // Body rectangle (rounded shoulders for polish)
    c.fillStyle = grad;
    c.beginPath();
    const r = ts * 0.06;
    c.moveTo(cx - bodyW / 2 + r, bodyTop);
    c.lineTo(cx + bodyW / 2 - r, bodyTop);
    c.quadraticCurveTo(cx + bodyW / 2, bodyTop, cx + bodyW / 2, bodyTop + r);
    c.lineTo(cx + bodyW / 2, bodyTop + bodyH);
    c.lineTo(cx - bodyW / 2, bodyTop + bodyH);
    c.lineTo(cx - bodyW / 2, bodyTop + r);
    c.quadraticCurveTo(cx - bodyW / 2, bodyTop, cx - bodyW / 2 + r, bodyTop);
    c.closePath();
    c.fill();
    // Body outline for readability against any biome
    c.strokeStyle = "rgba(0,0,0,0.45)";
    c.lineWidth = Math.max(1, ts * 0.025);
    c.stroke();

    // Head circle
    c.fillStyle = headColor;
    c.beginPath();
    c.arc(cx, headCy, headR, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.5)";
    c.lineWidth = Math.max(1, ts * 0.022);
    c.stroke();

    // King: tiny yellow triangle crown (3px-style) atop the head
    if (tier === "king") {
      const crownW = ts * 0.18;
      const crownH = ts * 0.12;
      const cyTop = headCy - headR - ts * 0.02;
      c.fillStyle = "#FFD700";
      c.beginPath();
      c.moveTo(cx - crownW / 2, cyTop);
      c.lineTo(cx + crownW / 2, cyTop);
      c.lineTo(cx, cyTop - crownH);
      c.closePath();
      c.fill();
      c.strokeStyle = "rgba(120,80,0,0.8)";
      c.lineWidth = Math.max(1, ts * 0.02);
      c.stroke();
    }

    return cv;
  }

  /** Lazily build / rebuild all tier sprite buffers when tile size changes. */
  private ensureNpcSprites() {
    const ts = this.state.grid.tileSize;
    if (this.npcSpriteTileSize === ts && this.npcSprites.size === 3) return;
    this.npcSprites.clear();
    this.npcSprites.set("peasant", this.buildNpcSprite("peasant"));
    this.npcSprites.set("noble",   this.buildNpcSprite("noble"));
    this.npcSprites.set("king",    this.buildNpcSprite("king"));
    this.npcSpriteTileSize = ts;
  }

  /* =====================================================================
   * Phase 10: Composite (per-NPC) sprite system
   * ===================================================================== */

  /** djb2-ish string hash → unsigned 32-bit int. Stable across runs. */
  private hashId(id: string): number {
    let h = 5381;
    for (let i = 0; i < id.length; i++) h = (h * 33 + id.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  /** Mulberry32 — deterministic PRNG for one citizen. */
  private makeRng(seed: number) {
    let s = seed | 0;
    return () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  private getTunicPalette(tier: "peasant" | "noble" | "king" | "middle" | string, rng: () => number): { top: string; bottom: string } {
    if (tier === "king") return { top: "#7a1419", bottom: "#3d0508" };           // Deep crimson
    if (tier === "noble") {
      const opts = [["#A044F5", "#5A1B95"], ["#D4AF37", "#7A6312"], ["#1d4ed8", "#0c2660"]];
      const c = opts[Math.floor(rng() * opts.length)];
      return { top: c[0], bottom: c[1] };
    }
    if (tier === "middle") {
      const opts = [["#3a7a3a", "#1f4521"], ["#2563eb", "#13347d"], ["#5b6b8a", "#2e3a52"]];
      const c = opts[Math.floor(rng() * opts.length)];
      return { top: c[0], bottom: c[1] };
    }
    // peasant
    const opts = [["#B8956F", "#6E5440"], ["#8a7060", "#4a3829"], ["#9a8870", "#5a4a3a"], ["#7d6b58", "#3f3424"]];
    const c = opts[Math.floor(rng() * opts.length)];
    return { top: c[0], bottom: c[1] };
  }

  private roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
  }

  private drawHair(
    c: CanvasRenderingContext2D,
    cx: number, headCy: number, headR: number,
    color: string, style: number
  ) {
    c.fillStyle = color;
    if (style === 0) {
      // Cap: top half-disc
      c.beginPath();
      c.arc(cx, headCy, headR * 1.05, Math.PI, 0);
      c.closePath();
      c.fill();
    } else if (style === 1) {
      // Bowl cut: cap + side flares
      c.beginPath();
      c.arc(cx, headCy, headR * 1.08, Math.PI * 1.05, Math.PI * -0.05);
      c.closePath();
      c.fill();
      c.fillRect(cx - headR * 1.05, headCy - headR * 0.1, headR * 0.18, headR * 0.6);
      c.fillRect(cx + headR * 0.87, headCy - headR * 0.1, headR * 0.18, headR * 0.6);
    } else if (style === 2) {
      // Long: cap + back drape
      c.beginPath();
      c.arc(cx, headCy, headR * 1.05, Math.PI, 0);
      c.closePath();
      c.fill();
      c.fillRect(cx - headR * 0.95, headCy - headR * 0.1, headR * 1.9, headR * 1.1);
    } else if (style === 3) {
      // Mohawk strip
      c.beginPath();
      c.arc(cx, headCy, headR * 1.02, Math.PI, 0);
      c.closePath();
      c.fill();
      c.fillRect(cx - headR * 0.18, headCy - headR * 1.4, headR * 0.36, headR * 0.5);
    } else {
      // Bald top: small fringe only
      c.beginPath();
      c.arc(cx, headCy, headR * 1.04, Math.PI * 1.15, Math.PI * -0.15);
      c.closePath();
      c.fill();
    }
  }

  private drawBeard(
    c: CanvasRenderingContext2D,
    cx: number, headCy: number, headR: number,
    color: string, style: number, _stage: string
  ) {
    c.fillStyle = color;
    if (style === 0) {
      // Stubble strip
      c.beginPath();
      c.arc(cx, headCy + headR * 0.35, headR * 0.7, 0.15, Math.PI - 0.15);
      c.closePath();
      c.fill();
    } else if (style === 1) {
      // Full beard wedge
      c.beginPath();
      c.moveTo(cx - headR * 0.85, headCy + headR * 0.15);
      c.quadraticCurveTo(cx, headCy + headR * 1.2, cx + headR * 0.85, headCy + headR * 0.15);
      c.lineTo(cx + headR * 0.6, headCy + headR * 0.5);
      c.quadraticCurveTo(cx, headCy + headR * 0.85, cx - headR * 0.6, headCy + headR * 0.5);
      c.closePath();
      c.fill();
    } else {
      // Goatee
      c.beginPath();
      c.ellipse(cx, headCy + headR * 0.7, headR * 0.25, headR * 0.32, 0, 0, Math.PI * 2);
      c.fill();
    }
  }

  /**
   * Phase 10.5: Profession accessory — now an atlas blit. Each variant
   * (FarmerHoe / FarmerHoeGold / MinerPickaxe / MinerPickaxeDiamond /
   * GuardSpear+Shield) is a pre-rendered offscreen canvas; we just compute
   * the destination rect from `ts` and draw. Master craftsmen (skill ≥ 10)
   * receive the high-value gold/diamond variant.
   */
  private drawAccessory(
    c: CanvasRenderingContext2D,
    cit: Citizen,
    cx: number, bodyTop: number, bodyW: number, bodyH: number, ts: number,
    master: boolean
  ) {
    const handY = bodyTop + bodyH * 0.45;
    const rightHandX = cx + bodyW * 0.55;
    const prof = cit.profession;
    // Tool dimensions in destination space — picked to match the previous
    // hand-drawn proportions.
    const toolW = ts * 0.30;
    const toolH = ts * 0.95;
    const toolDx = rightHandX - toolW * 0.5;
    const toolDy = handY - bodyH * 0.75;

    // Phase 20.6 — "Visual Mastery" subtle gold glow at skill ≥ 5. Master
    // (≥ 10) NPCs already get a unique gold/diamond tool ASSET so we don't
    // double-glow them; instead the L5..L9 band gets a soft golden halo
    // baked onto whatever tool they have, telegraphing "rising mastery"
    // before they reach the gold-tool tier.
    const lvl = cit.skills?.level ?? 1;
    const subtleGlow = lvl >= 5 && !master;
    if (subtleGlow) {
      c.save();
      c.shadowColor = "#ffd24a";
      c.shadowBlur = Math.max(2, ts * 0.05);
    }

    if (prof === "Farmer") {
      const a = this.assets.get(master ? "FarmerHoeGold" : "FarmerHoe");
      if (a) c.drawImage(a, toolDx, toolDy, toolW, toolH);
    } else if (prof === "Miner") {
      const a = this.assets.get(master ? "MinerPickaxeDiamond" : "MinerPickaxe");
      if (a) c.drawImage(a, toolDx, toolDy, toolW, toolH);
    } else if (prof === "Guard") {
      const spear = this.assets.get("GuardSpear");
      if (spear) c.drawImage(spear, toolDx, toolDy - bodyH * 0.10, toolW, toolH * 1.1);
      const shieldA = this.assets.get(master ? "GuardShieldPlated" : "GuardShield");
      if (shieldA) {
        const sh = ts * 0.26;
        c.drawImage(shieldA, cx - bodyW * 0.55 - sh * 0.5, handY - sh * 0.5, sh, sh);
      }
    }

    if (subtleGlow) c.restore();
  }

  /**
   * Phase 10.5: Crown / tiara — atlas blit. The asset is rendered at
   * ASSET_REF resolution and rescaled here to the head dimensions; this is
   * one drawImage instead of ~12 vector ops per crown.
   */
  private drawCrown(
    c: CanvasRenderingContext2D,
    cx: number, headCy: number, headR: number, ts: number,
    feminine = false
  ) {
    const crownW = ts * (feminine ? 0.24 : 0.30);
    const crownH = ts * (feminine ? 0.16 : 0.22);
    const cyTop = headCy - headR - ts * 0.02;
    const a = this.assets.get(feminine ? "QueenTiara" : "KingCrown");
    if (a) c.drawImage(a, cx - crownW / 2, cyTop - crownH, crownW, crownH);
  }

  /**
   * Get (or build) the cached composite sprite for a citizen.
   * Performance: the visual signature is packed into a single number (no
   * template-literal allocation per frame). When the citizen's signature
   * matches the cached one, we just return the canvas. Cache is hard-capped
   * at COMPOSITE_CACHE_MAX with FIFO eviction (Map preserves insertion order).
   */
  private getCompositeSprite(c: Citizen): HTMLCanvasElement {
    const ts = this.state.grid.tileSize;
    if (this.compositeSpriteTileSize !== ts) {
      this.compositeSprites.clear();
      this.compositeSpriteTileSize = ts;
    }
    const stage = getLifeStage(c, this.state.time.gameYear);
    // Phase 10.5: master tier shifted from level 3 → level 10 to match the
    // updated mastery curve. Level-10 NPCs receive a unique gold/diamond
    // profession-tool variant in the atlas (see drawAccessory).
    const master = (c.skills?.level ?? 1) >= 10;
    // Phase 20.6 — track the L5..L9 "subtle glow" band as a separate cache
    // tier. drawAccessory keys its golden tool halo off this band, so a
    // citizen leveling 4→5 must invalidate the composite sprite cache or
    // the glow won't appear until some unrelated signature change occurs
    // (architect-flagged regression).
    const subtleGlowTier = !master && (c.skills?.level ?? 1) >= 5;
    const tierN  = c.socialTier === "king" ? 3 : c.socialTier === "noble" ? 2 : 0;
    const profN  = c.profession === "Farmer" ? 1 : c.profession === "Miner" ? 2 : c.profession === "Guard" ? 3 : 0;
    const traitN = c.trait === "Zealot" ? 1 : c.trait === "Greedy" ? 2 : c.trait === "Coward" ? 3 : c.trait === "Diligent" ? 4 : 0;
    const stageN = stage === "child" ? 1 : stage === "elder" ? 2 : stage === "infant" ? 3 : 0;
    const royalN = c.isKing ? 1 : c.isQueen ? 2 : c.isDowagerQueen ? 3 : 0;
    const sig =
      tierN |
      (profN  << 2) |
      (traitN << 5) |
      (stageN << 8) |
      ((master ? 1 : 0) << 10) |
      (royalN << 11) |
      ((subtleGlowTier ? 1 : 0) << 13);

    const cached = this.compositeSprites.get(c.id);
    if (cached && cached.sig === sig) return cached.sprite;

    // Hard-cap eviction (FIFO via Map insertion order). Drop oldest until
    // strictly under cap before inserting the new entry.
    while (this.compositeSprites.size >= this.COMPOSITE_CACHE_MAX) {
      const firstKey = this.compositeSprites.keys().next().value;
      if (firstKey === undefined) break;
      this.compositeSprites.delete(firstKey);
    }
    const sprite = this.buildCompositeSprite(c, stage, master);
    this.compositeSprites.set(c.id, { sig, sprite });
    return sprite;
  }

  private buildCompositeSprite(
    c: Citizen,
    stage: string,
    master: boolean
  ): HTMLCanvasElement {
    const ts = this.state.grid.tileSize;
    // Sprite canvas covers head + body + accessory + crown overhead. Legs
    // are drawn live for animation (not baked).
    const W = Math.ceil(ts * 1.0);
    const H = Math.ceil(ts * 1.15);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c2 = cv.getContext("2d")!;

    const cx = W / 2;
    const headR = ts * 0.16;
    const headCy = H * 0.36;
    const bodyTop = headCy + headR * 0.55;
    const bodyW = ts * 0.46;
    const bodyH = ts * 0.50;

    const seed = this.hashId(c.id);
    const rng = this.makeRng(seed);

    // Skin tone (varied)
    const skinPool = ["#F2C9A0", "#E8B58F", "#D49978", "#B57A55", "#8B5A3C", "#6E4530"];
    const skin = skinPool[Math.floor(rng() * skinPool.length)];

    // Hair color (natural, gray for elder)
    const hairPool = ["#1a1a1a", "#3a2418", "#5a3a1f", "#a0762f", "#d6b06b", "#7d4425"];
    let hair = hairPool[Math.floor(rng() * hairPool.length)];
    if (stage === "elder") hair = rng() < 0.5 ? "#d4d4d8" : "#f4f4f5";

    // Tunic palette by social tier
    const tunic = this.getTunicPalette(c.socialTier, rng);

    // ---- Body (gradient + texture overlay) ----
    const grad = c2.createLinearGradient(0, bodyTop, 0, bodyTop + bodyH);
    grad.addColorStop(0, tunic.top);
    grad.addColorStop(1, tunic.bottom);
    c2.fillStyle = grad;
    this.roundRect(c2, cx - bodyW / 2, bodyTop, bodyW, bodyH, ts * 0.07);
    c2.fill();

    // Linen/wool weave overlay
    c2.save();
    this.roundRect(c2, cx - bodyW / 2, bodyTop, bodyW, bodyH, ts * 0.07);
    c2.clip();
    c2.strokeStyle = "rgba(0,0,0,0.10)";
    c2.lineWidth = 0.5;
    for (let yy = bodyTop + 2; yy < bodyTop + bodyH; yy += 2.2) {
      c2.beginPath(); c2.moveTo(cx - bodyW / 2, yy); c2.lineTo(cx + bodyW / 2, yy); c2.stroke();
    }
    // Class-specific accents
    if (c.socialTier === "noble") {
      c2.fillStyle = "rgba(255,215,0,0.45)";
      c2.fillRect(cx - bodyW * 0.08, bodyTop, bodyW * 0.16, bodyH);
    }
    if (c.socialTier === "king") {
      // Ermine spots along hem
      c2.fillStyle = "rgba(245,245,245,0.95)";
      for (let i = 0; i < 4; i++) {
        const x = cx - bodyW * 0.32 + i * bodyW * 0.22;
        c2.fillRect(x, bodyTop + bodyH * 0.85, 3, 4);
      }
    }
    c2.restore();

    // Phase 15: King's royal cape — wider crimson drape behind body with
    // gold trim and an ermine collar. Drawn on TOP of the body so it
    // reads as a layered garment rather than just a tunic accent. Only
    // applied to the actual king (not retired dowagers / queens) to keep
    // his silhouette unmistakable.
    if (c.isKing) {
      const capeTopY = bodyTop - ts * 0.02;
      const capeBotY = bodyTop + bodyH + ts * 0.04;
      const capeWTop = bodyW * 0.55;
      const capeWBot = bodyW * 1.30;
      // Cape body (deep crimson with darker bottom)
      const capeGrad = c2.createLinearGradient(0, capeTopY, 0, capeBotY);
      capeGrad.addColorStop(0, "#8a1620");
      capeGrad.addColorStop(1, "#3a0408");
      c2.fillStyle = capeGrad;
      c2.beginPath();
      c2.moveTo(cx - capeWTop / 2, capeTopY);
      c2.lineTo(cx + capeWTop / 2, capeTopY);
      c2.lineTo(cx + capeWBot / 2, capeBotY);
      c2.lineTo(cx - capeWBot / 2, capeBotY);
      c2.closePath();
      c2.fill();
      c2.strokeStyle = "rgba(0,0,0,0.6)";
      c2.lineWidth = Math.max(1, ts * 0.018);
      c2.stroke();
      // Gold trim down both edges
      c2.strokeStyle = "#d4af37";
      c2.lineWidth = Math.max(1.5, ts * 0.022);
      c2.beginPath();
      c2.moveTo(cx - capeWTop / 2 + 1, capeTopY);
      c2.lineTo(cx - capeWBot / 2 + 1, capeBotY);
      c2.moveTo(cx + capeWTop / 2 - 1, capeTopY);
      c2.lineTo(cx + capeWBot / 2 - 1, capeBotY);
      c2.stroke();
      // Ermine collar (white fur band with black tail spots)
      const collarH = ts * 0.07;
      c2.fillStyle = "#f5efde";
      c2.fillRect(cx - capeWTop / 2 - 2, capeTopY, capeWTop + 4, collarH);
      c2.strokeStyle = "rgba(0,0,0,0.6)";
      c2.lineWidth = 0.8;
      c2.strokeRect(cx - capeWTop / 2 - 2, capeTopY, capeWTop + 4, collarH);
      // Black ermine spots
      c2.fillStyle = "#1a1a1a";
      for (let i = 0; i < 5; i++) {
        const ex = cx - capeWTop / 2 + 2 + i * (capeWTop / 4);
        c2.fillRect(ex, capeTopY + collarH * 0.45, 1.5, 1.5);
      }
      // Re-draw body silhouette over the cape so the tunic stays visible
      // (the cape drapes BEHIND the body but its top edge would otherwise
      // cover the chest band — clip back to body shape here).
      this.roundRect(c2, cx - bodyW / 2, bodyTop + collarH * 0.7, bodyW, bodyH - collarH * 0.7, ts * 0.07);
      c2.fillStyle = grad;
      c2.fill();
      // Gold sash diagonal across the chest
      c2.strokeStyle = "#d4af37";
      c2.lineWidth = Math.max(2, ts * 0.04);
      c2.beginPath();
      c2.moveTo(cx - bodyW * 0.45, bodyTop + bodyH * 0.20);
      c2.lineTo(cx + bodyW * 0.45, bodyTop + bodyH * 0.55);
      c2.stroke();
    }

    // Body outline
    this.roundRect(c2, cx - bodyW / 2, bodyTop, bodyW, bodyH, ts * 0.07);
    c2.strokeStyle = "rgba(0,0,0,0.5)";
    c2.lineWidth = Math.max(1, ts * 0.022);
    c2.stroke();

    // ---- Head ----
    c2.fillStyle = skin;
    c2.beginPath(); c2.arc(cx, headCy, headR, 0, Math.PI * 2); c2.fill();
    c2.strokeStyle = "rgba(0,0,0,0.55)";
    c2.lineWidth = Math.max(1, ts * 0.022);
    c2.stroke();

    // Hair
    const hairStyle = Math.floor(rng() * 5);
    this.drawHair(c2, cx, headCy, headR, hair, hairStyle);

    // Beard (males, 55% chance)
    if (c.sex === "male" && rng() < 0.55) {
      const beardStyle = Math.floor(rng() * 3);
      this.drawBeard(c2, cx, headCy, headR, hair, beardStyle, stage);
    }

    // Eyes (two tiny dots)
    c2.fillStyle = "rgba(0,0,0,0.75)";
    c2.beginPath(); c2.arc(cx - headR * 0.32, headCy + headR * 0.05, Math.max(0.8, ts * 0.018), 0, Math.PI * 2); c2.fill();
    c2.beginPath(); c2.arc(cx + headR * 0.32, headCy + headR * 0.05, Math.max(0.8, ts * 0.018), 0, Math.PI * 2); c2.fill();

    // ---- Trait markers ----
    if (c.trait === "Zealot") {
      // Cross necklace at neckline
      const cyN = bodyTop + ts * 0.05;
      c2.strokeStyle = "#d4af37";
      c2.lineWidth = Math.max(1.2, ts * 0.028);
      c2.beginPath(); c2.moveTo(cx, cyN - ts * 0.03); c2.lineTo(cx, cyN + ts * 0.06); c2.stroke();
      c2.beginPath(); c2.moveTo(cx - ts * 0.035, cyN + ts * 0.005); c2.lineTo(cx + ts * 0.035, cyN + ts * 0.005); c2.stroke();
    }
    if (c.trait === "Greedy") {
      // Coin pouch on belt (right hip)
      const beltY = bodyTop + bodyH * 0.62;
      c2.fillStyle = "#6b4f12";
      c2.beginPath(); c2.arc(cx + bodyW * 0.42, beltY, ts * 0.07, 0, Math.PI * 2); c2.fill();
      c2.fillStyle = "#d4af37";
      c2.beginPath(); c2.arc(cx + bodyW * 0.42, beltY, ts * 0.025, 0, Math.PI * 2); c2.fill();
      c2.strokeStyle = "rgba(0,0,0,0.5)"; c2.lineWidth = 1; c2.stroke();
    }

    // ---- Profession accessory (atlas blit; gold/diamond if master) ----
    this.drawAccessory(c2, c, cx, bodyTop, bodyW, bodyH, ts, master);

    // ---- Master pendant (skill ≥ 10): gold medallion on chest, atlas blit ----
    if (master) {
      const pendant = this.assets.get("MasterPendant");
      if (pendant) {
        const ph = ts * 0.13;
        c2.drawImage(pendant, cx + bodyW * 0.10 - ph * 0.5, bodyTop + ts * 0.02, ph, ph);
      }
    }

    // ---- Royal crown ----
    if (c.isKing) {
      this.drawCrown(c2, cx, headCy, headR, ts, false);
    } else if (c.isQueen || c.isDowagerQueen) {
      this.drawCrown(c2, cx, headCy, headR, ts, true);
    }

    return cv;
  }

  /**
   * Phase 13: Render ONE citizen at its iso-projected position. Called
   * from the depth-sorted scene queue in render(). The (sx, sy) is the
   * iso center of the tile the citizen currently stands on. The body cy
   * is offset upward by ts*0.32 so the foot anchor (cy + ts*0.32) lands
   * exactly at the tile's iso center — the citizen "stands on" the tile.
   *
   * The Phase 12 walk cycle (8-dir facing, sine bob, opposite-arm swing)
   * is preserved verbatim — it's purely a function of (cx, cy) anchor
   * and is independent of whether the world is top-down or iso.
   */
  private drawSingleCitizen(
    c: Citizen,
    pos: { row: number; col: number },
    sx: number,
    sy: number,
    t: number,
    ts: number,
  ) {
    const ctx = this.ctx;
    const cam = this.state.camera;

    // Phase 22 — sprite-first per-citizen pipeline. We resolve the most
    // specific PNG key the manager has loaded, in priority order: King /
    // Queen → infant → child → noble → peasant. This way dropping in
    // just `peasant.png` swaps every commoner without breaking nobles
    // (who fall through to procedural until `noble.png` ships). When a
    // sprite is found we blit it anchored bottom-center at the citizen's
    // iso ground point and skip the rest of this function — the dense
    // procedural body / limbs / accessories pipeline.
    //
    // NOTE: This early-return ALSO skips the path-line hint + overhead
    // badge logic below. Phase 22 ships with no PNGs so this never
    // triggers; once real sprites exist we can split this into a
    // sprite-body call with the procedural overlays still drawn around
    // it. Wiring the pipeline first is the explicit Phase 22 ask.
    const spriteKey = this.resolveCitizenSpriteKey(c);
    if (spriteKey && this.spriteAssets.has(spriteKey)) {
      const tileX = sx - ts * 0.5;
      const tileY = sy - ts * 0.5;
      this.spriteAssets.tryDraw(ctx, spriteKey, tileX, tileY, ts);
      return;
    }

    const radius = ts * 0.18; // legacy radius — kept for path-line spacing

    {
      const cx = sx;
      const cy = sy - ts * 0.32;

      /* ---------- Pathfinding hint lines (drawn under sprite) ---------- */
      if (c.state === "SEEK_FOOD" && c.targetTile && cam.zoom > 0.6) {
        // Phase 13: project target tile through iso so the dashed hint
        // line connects feet-to-feet across the iso world, not into a
        // stale top-down pixel position.
        const tIso = worldToIso(c.targetTile.col, c.targetTile.row, ts, this.state.grid.rows);
        const tx = tIso.sx;
        const ty = tIso.sy - ts * 0.32;
        ctx.strokeStyle = "rgba(255, 220, 80, 0.55)";
        ctx.lineWidth = Math.max(1, 1.5 / cam.zoom);
        ctx.setLineDash([ts * 0.12, ts * 0.08]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (c.state === "ROGUE" && c.targetTile && cam.zoom > 0.6) {
        const tIso = worldToIso(c.targetTile.col, c.targetTile.row, ts, this.state.grid.rows);
        const tx = tIso.sx;
        const ty = tIso.sy - ts * 0.32;
        ctx.strokeStyle = "rgba(255, 60, 60, 0.7)";
        ctx.lineWidth = Math.max(1, 1.8 / cam.zoom);
        ctx.setLineDash([ts * 0.10, ts * 0.06]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Soft drop shadow on the ground beneath the citizen
      ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
      ctx.beginPath();
      ctx.ellipse(cx, cy + ts * 0.32, ts * 0.22, ts * 0.07, 0, 0, Math.PI * 2);
      ctx.fill();

      /* ---------- PRAYING halo (drawn behind sprite) ---------- */
      if (c.state === "PRAYING") {
        const pulse = 0.6 + 0.25 * Math.sin(t * 3 + c.hue);
        const haloR = ts * (0.22 + 0.04 * Math.sin(t * 3 + c.hue));
        const haloCy = cy - ts * 0.32;
        const grad = ctx.createRadialGradient(cx, haloCy, ts * 0.04, cx, haloCy, haloR);
        grad.addColorStop(0, `rgba(255, 255, 255, ${0.85 * pulse})`);
        grad.addColorStop(0.5, `rgba(255, 245, 200, ${0.45 * pulse})`);
        grad.addColorStop(1, "rgba(255, 240, 180, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, haloCy, haloR, Math.PI, 0); // semi-circle (top half)
        ctx.closePath();
        ctx.fill();
      }

      // Phase 10: per-NPC composite sprite (cached by visual signature)
      const sprite = this.getCompositeSprite(c);
      const sw = sprite.width;
      const sh = sprite.height;
      // Anchor: feet centered at (cx, cy + ts*0.32). Sprite origin top-left.
      const dx = cx - sw / 2;
      const dy = cy + ts * 0.32 - sh;

      const isMoving =
        c.state === "MOVING" || c.state === "SEEK_FOOD" || c.state === "ROGUE" || c.state === "FLEEING";
      const isDead = c.state === "DEAD";

      // Phase 6: life-stage scale — children draw at 65%, elders at 90%,
      // adults full size. Phase 10: Coward NPCs draw 12% smaller for visible
      // diversity. Anchor at feet (cx, cy + ts*0.32).
      const lifeStage = getLifeStage(c, this.state.time.gameYear);
      const cowardScale = c.trait === "Coward" ? 0.88 : 1;
      const baseScale =
        lifeStage === "child" ? 0.65 :
        lifeStage === "elder" ? 0.9 : 1;
      const lifeScale = baseScale * cowardScale;
      if (lifeScale !== 1) {
        ctx.save();
        const anchorY = cy + ts * 0.32;
        ctx.translate(cx, anchorY);
        ctx.scale(lifeScale, lifeScale);
        ctx.translate(-cx, -anchorY);
      }

      // Phase 20.6 — Infant render. Swaddled bundle (no limbs, no full
      // sprite, no overlays). Bypasses every system below so a 0-2 yr old
      // reads as a "baby in a blanket near a house" instead of a tiny
      // half-rendered adult silhouette. Stage is also part of the
      // composite-sprite cache key, so this never collides with a child.
      if (lifeStage === "infant") {
        // Phase 20.6 polish — wrap the whole branch in save/restore so
        // fillStyle/strokeStyle/lineWidth changes here can't bleed into
        // the next NPC's draw block. Architect-flagged.
        ctx.save();
        const cradleW = ts * 0.20;
        const cradleH = ts * 0.22;
        const cradleCy = cy + ts * 0.32 - cradleH * 0.5;
        // Swaddle cloth body — warm cream ellipse with a brown outline
        // for contrast against grass/dirt/snow.
        ctx.fillStyle = "#f5e9d6";
        ctx.strokeStyle = "rgba(60, 40, 20, 0.55)";
        ctx.lineWidth = Math.max(1, ts * 0.012);
        ctx.beginPath();
        ctx.ellipse(cx, cradleCy, cradleW * 0.5, cradleH * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Tiny diagonal cloth fold across the bundle
        ctx.strokeStyle = "rgba(60, 40, 20, 0.35)";
        ctx.lineWidth = Math.max(1, ts * 0.01);
        ctx.beginPath();
        ctx.moveTo(cx - cradleW * 0.35, cradleCy + cradleH * 0.05);
        ctx.lineTo(cx + cradleW * 0.35, cradleCy - cradleH * 0.05);
        ctx.stroke();
        // Pink head poking out the top
        ctx.fillStyle = "#f4c4a8";
        ctx.strokeStyle = "rgba(60, 30, 10, 0.65)";
        ctx.lineWidth = Math.max(1, ts * 0.012);
        const headR = cradleW * 0.30;
        const headCy = cradleCy - cradleH * 0.45;
        ctx.beginPath();
        ctx.arc(cx, headCy, headR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        if (lifeScale !== 1) ctx.restore();
        return;
      }

      // Phase 10: smoky heresy aura for ROGUE / REBEL (dark, floating particles)
      if (c.state === "ROGUE") {
        for (let i = 0; i < 3; i++) {
          const phase = t * 1.4 + c.hue + i * 2;
          const ax = cx + Math.sin(phase) * ts * 0.18;
          const ay = cy - ts * 0.05 + Math.cos(phase * 0.8) * ts * 0.10 - i * ts * 0.06;
          const ar = ts * (0.10 + 0.04 * Math.sin(phase * 1.7));
          const grad = ctx.createRadialGradient(ax, ay, 0, ax, ay, ar);
          grad.addColorStop(0, "rgba(40,10,40,0.45)");
          grad.addColorStop(1, "rgba(40,10,40,0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(ax, ay, ar, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Phase 20.5 — Limb pass. Beefier, higher-contrast limbs so the
      // gait is unmistakable. Leg color is a darker boot/trouser tone;
      // we now also paint a small foot rect at the bottom so the leg
      // doesn't end in a thin stick. King keeps deep crimson; nobles a
      // plum; commoners a saturated walnut (was muddy #3f3424 — that
      // blended into the body and made NPCs look limbless).
      const legColor =
        c.socialTier === "king"   ? "#3d0508" :
        c.socialTier === "noble"  ? "#3a1f5e" :
                                    "#3a2a18";
      const footColor =
        c.socialTier === "king"   ? "#1a0205" :
        c.socialTier === "noble"  ? "#1a0e30" :
                                    "#1d1408";
      const legW = ts * 0.12;       // was 0.10 — +20% width
      const legH = ts * 0.18;       // was 0.14 — longer legs read better
      const footW = ts * 0.14;
      const footH = ts * 0.04;
      const legY = cy + ts * 0.16;
      // Alternating gait: phase shifts by NPC id-hash so they don't march
      // in lockstep. Swing amplitude bumped from ts*0.06 → ts*0.10 so the
      // 2-frame "left forward / right forward" pattern is obvious at zoom.
      const gaitPhase = c.hue * 0.05;
      const swing = isMoving ? Math.sin(t * 8 + gaitPhase) : 0;
      const offsetA = swing * ts * 0.10;
      const offsetB = -offsetA;

      /* ---------- DEAD: rotated 90° + 0.4 alpha for the WHOLE figure ---------- */
      if (isDead) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 2);
        ctx.translate(-cx, -cy);
        ctx.drawImage(sprite, dx, dy);
        // Static (non-swinging) legs + feet while dead
        ctx.fillStyle = legColor;
        ctx.fillRect(cx - legW - ts * 0.01, legY, legW, legH);
        ctx.fillRect(cx + ts * 0.01, legY, legW, legH);
        ctx.fillStyle = footColor;
        ctx.fillRect(cx - legW - ts * 0.01 - (footW - legW) / 2, legY + legH - footH, footW, footH);
        ctx.fillRect(cx + ts * 0.01 - (footW - legW) / 2,        legY + legH - footH, footW, footH);
        ctx.restore();
        if (lifeScale !== 1) ctx.restore();
        return; // Phase 13: per-citizen call — early-exit instead of `continue`.
      }

      /* ---------- Phase 12: 8-directional facing + walk cycle ----------
       * Stateless — derive facing each frame from the vector to the next
       * path tile. Compass bins (45° sectors): 0=N, 1=NE, 2=E, 3=SE,
       * 4=S, 5=SW, 6=W, 7=NW. When idle, default to S (face camera).
       * PRAYING / SLEEPING citizens stay axis-aligned (face camera).
       *
       * The facing wraps the legs+arms+sprite as one transformed group:
       *   • flipSign  → mirror W-side facings horizontally
       *   • squashAbs → narrow silhouette for E/W to suggest a side-on
       *                 profile without needing a separate sprite asset
       *   • tiltRad   → small body lean in the direction of motion
       *   • bobY      → vertical body bob locked to the gait sine, only
       *                 applied while actually moving so they look like
       *                 they're physically walking, not sliding. */
      let facing: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 = 4;
      const stillStates = c.state === "PRAYING" || c.state === "SLEEPING";
      if (!stillStates && c.path.length > 0 && c.pathIndex < c.path.length) {
        const nxt = c.path[c.pathIndex];
        const dr = nxt.row - c.row;
        const dc = nxt.col - c.col;
        if (dr !== 0 || dc !== 0) {
          // atan2(dc, -dr): row+ is south on screen, so we negate dr to
          // recover a true compass where 0° = N and 90° = E.
          let deg = (Math.atan2(dc, -dr) * 180) / Math.PI;
          if (deg < 0) deg += 360;
          facing = (Math.round(deg / 45) % 8) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
        }
      }
      const flipSign = facing === 5 || facing === 6 || facing === 7 ? -1 : 1;
      const tiltDeg =
        facing === 2 ? -12 : facing === 6 ? 12 :
        facing === 1 ? -8  : facing === 7 ? 8  :
        facing === 3 ? -5  : facing === 5 ? 5  : 0;
      const squashAbs =
        facing === 2 || facing === 6 ? 0.85 :
        facing === 1 || facing === 3 || facing === 5 || facing === 7 ? 0.95 : 1;
      const tiltRad = (tiltDeg * Math.PI) / 180;
      // Body bob: |sin| gives a "double-step" bounce — feet lift twice per
      // gait cycle, like a real walk. Negative = upward in screen-space.
      const bobY = isMoving ? -Math.abs(Math.sin(t * 8 + gaitPhase)) * ts * 0.03 : 0;

      // Phase 20.5 — Arm geometry. Drawn live (not in cached sprite) so
      // they swing. Arms swing OPPOSITE to legs while WALKING for a
      // believable cross-gait. While CHATTING the arms move TOGETHER
      // up/down ~10px to read as a "talking" gesture (not a walk).
      // armW bumped 0.07 → 0.10 so they're visible past the body silhouette.
      const isChatting = c.state === "CHATTING";
      const isFocusing = c.state === "WORKING" && (c.socialTier !== "peasant" || (c.skills?.level ?? 1) >= 3);
      // Talk gesture: both arms shift down ~ts*0.06 (≈10px at default zoom)
      // on a slow 3 Hz sine — feels like emphatic gesturing.
      const talkBob = isChatting ? (Math.sin(t * 3 + gaitPhase) * 0.5 + 0.5) * ts * 0.06 : 0;
      // Focus pulse: Specialist+ "leaning in" while working — small forward
      // arm dip on a 4 Hz sine.
      const focusBob = isFocusing ? Math.abs(Math.sin(t * 4 + gaitPhase)) * ts * 0.04 : 0;
      const armSwing = isMoving && !isChatting ? -swing * ts * 0.10 : 0;
      const armColor =
        c.socialTier === "king"   ? "#7a1419" :       // Crimson sleeve
        c.socialTier === "noble"  ? "#6a3a9a" :       // Bright royal sleeve
        c.profession === "Guard"  ? "#4a5a7a" :       // Steel-grey for guards (Specialist)
        c.profession === "Doctor" ? "#d4a85a" :       // Gold-trim for doctors (Specialist)
        c.profession === "Farmer" ? "#7a6a3a" :       // Wheat-tone for farmers (Specialist)
        c.profession === "Miner"  ? "#5a4a3a" :       // Coal-grey for miners (Specialist)
        (c.skills?.level ?? 1) >= 3 ? "#6a4a2a" :     // Specialist commoner — saturated wood
                                    "#5a4530";        // Plain commoner — earth tone
      const armW = ts * 0.10;       // was 0.07 — +43% visible mass
      const armH = ts * 0.22;       // was 0.20 — slightly longer
      const shoulderY = cy - ts * 0.05;
      const armOuterX = ts * 0.22;  // was 0.20 — arms peek beyond body silhouette

      // Phase 20.5 — Royal gold drop-shadow. Canvas `filter:` is
      // unreliable across browsers, so we use the native shadow API
      // instead, which is what the user is asking for visually. Only
      // applied to the actual reigning King (not retired/queens) so the
      // glow uniquely identifies him.
      if (c.isKing) {
        ctx.save();
        ctx.shadowColor = "#ffd700";
        ctx.shadowBlur = Math.max(3, ts * 0.06);
      }

      // Apply facing transform around the feet anchor so rotation pivots
      // at the ground (figure leans, doesn't slide off the tile).
      ctx.save();
      const feetY = cy + ts * 0.32;
      ctx.translate(cx, feetY);
      ctx.scale(flipSign * squashAbs, 1);
      ctx.rotate(tiltRad);
      ctx.translate(-cx, -feetY + bobY);

      // Legs (drawn first so body overlaps the tops cleanly).
      // Phase 20.5 — batched: set fillStyle once for both legs + feet of
      // a tier, since we're already iterating one citizen at a time the
      // GPU paint cost is dominated by the rectangle count, not state
      // changes. Two leg rects + two foot rects per NPC.
      ctx.fillStyle = legColor;
      ctx.fillRect(cx - legW - ts * 0.01, legY + offsetA, legW, legH);
      ctx.fillRect(cx + ts * 0.01,        legY + offsetB, legW, legH);
      ctx.fillStyle = footColor;
      ctx.fillRect(cx - legW - ts * 0.01 - (footW - legW) / 2, legY + offsetA + legH - footH, footW, footH);
      ctx.fillRect(cx + ts * 0.01 - (footW - legW) / 2,        legY + offsetB + legH - footH, footW, footH);

      // Arms — front pair (drawn behind body so the body sprite covers
      // the shoulder root). Walking → opposite swing. Chatting →
      // synchronized talkBob. Working (Specialist+) → focus dip.
      ctx.fillStyle = armColor;
      const leftArmY  = shoulderY + armSwing + talkBob + focusBob;
      const rightArmY = shoulderY - armSwing + talkBob + focusBob;
      ctx.fillRect(cx - armOuterX - armW * 0.5, leftArmY,  armW, armH);
      ctx.fillRect(cx + armOuterX - armW * 0.5, rightArmY, armW, armH);

      // Body + head sprite
      ctx.drawImage(sprite, dx, dy);

      // Phase 20.5 — Specialist tool accessory: builder's hammer for the
      // commoner-class Specialist (skill ≥ 3, no profession-specific tool
      // already drawn by drawAccessory). Tiny grey rectangle + brown
      // handle in the right hand. Skipped for Farmer/Miner/Guard — they
      // already get drawAccessory tools elsewhere.
      const showBuilderHammer = (c.skills?.level ?? 1) >= 3
        && (c.profession === undefined || c.profession === "None");
      if (showBuilderHammer) {
        const handX = cx + armOuterX;
        const handY = rightArmY + armH * 0.85;
        // Handle (brown)
        ctx.fillStyle = "#6a3a18";
        ctx.fillRect(handX - ts * 0.015, handY, ts * 0.03, ts * 0.12);
        // Head (grey rect)
        ctx.fillStyle = "#7a7a82";
        ctx.fillRect(handX - ts * 0.05, handY + ts * 0.10, ts * 0.10, ts * 0.05);
      }

      ctx.restore();
      if (c.isKing) ctx.restore();

      /* ---------- ROGUE: pulsing red overhead circle ---------- */
      if (c.state === "ROGUE") {
        const pulse = 0.6 + 0.4 * Math.abs(Math.sin(t * 4 + c.hue));
        const iconR = ts * (0.07 + 0.015 * Math.sin(t * 4 + c.hue));
        const iconCy = cy - ts * 0.45;
        ctx.fillStyle = `rgba(255, 50, 50, ${0.85 * pulse})`;
        ctx.beginPath();
        ctx.arc(cx, iconCy, iconR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 200, 200, 0.9)";
        ctx.lineWidth = Math.max(1, ts * 0.018);
        ctx.stroke();
      }

      /* ---------- SEEK_FOOD: small orange alert ring under feet ---------- */
      if (c.state === "SEEK_FOOD") {
        ctx.strokeStyle = "rgba(255, 130, 30, 0.85)";
        ctx.lineWidth = Math.max(1, ts * 0.03);
        ctx.beginPath();
        ctx.ellipse(cx, cy + ts * 0.32, radius * 1.2, radius * 0.45, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      /* ---------- Phase 14: Sick aura — three wobbling green dots ----------
       * Cheap (3 fills, no per-particle pool) and only drawn when the citizen
       * is flagged isSick AND camera zoom is high enough to read the sprite
       * detail. Provides instant visual triage for plague spread.
       */
      if (c.isSick && cam.zoom > 0.4) {
        const auraCy = cy - ts * 0.55;
        ctx.fillStyle = "rgba(120, 220, 120, 0.75)";
        for (let i = 0; i < 3; i++) {
          const phase = t * 2 + i * 2.1 + c.hue;
          const ax = cx + Math.cos(phase) * ts * 0.08;
          const ay = auraCy + Math.sin(phase * 1.3) * ts * 0.04;
          ctx.beginPath();
          ctx.arc(ax, ay, ts * 0.025, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (lifeScale !== 1) ctx.restore();

      /* ---------- Phase 12: Chat bubble + Mental-Break overlays ----------
       * Drawn AFTER lifeScale restore so they sit at "true" pixel sizes,
       * unaffected by child/elder scale. Anchored above the head at
       * cy − ts * 1.0 to clear the sprite. Skipped at very low zoom to
       * avoid render-cost on the world overview.
       */
      if (cam.zoom > 0.4) {
        const bubbleCy = cy - ts * 1.0;
        if (c.state === "CHATTING") {
          // Tiny "..." pill speech bubble.
          const w = ts * 0.36;
          const h = ts * 0.18;
          ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
          ctx.strokeStyle = "rgba(20, 20, 30, 0.85)";
          ctx.lineWidth = Math.max(1, ts * 0.012);
          // Pill body
          ctx.beginPath();
          ctx.ellipse(cx, bubbleCy, w / 2, h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          // Three black dots
          ctx.fillStyle = "rgba(20, 20, 30, 0.9)";
          const dotR = ts * 0.025;
          const dotGap = ts * 0.07;
          for (let i = -1; i <= 1; i++) {
            ctx.beginPath();
            ctx.arc(cx + i * dotGap, bubbleCy, dotR, 0, Math.PI * 2);
            ctx.fill();
          }
        } else if (
          c.state === "MENTAL_BREAK" ||
          c.state === "STEALING" ||
          c.state === "ARRESTING" ||
          c.state === "IMPRISONED" ||
          c.state === "HEALING" ||
          c.state === "DRINKING"
        ) {
          // Phase 20.5 — "no letter placeholders." Previously rendered
          // text glyphs (?, !, $, +, ‖, 🍺) above the head; now drawn as
          // pure shape badges so the silhouette tells the story without
          // any typography. The halo color still encodes the state.
          type Shape = "alert" | "circle" | "diamond" | "bars" | "cross" | "mug";
          let shape: Shape = "circle";
          let color = "#ffd64a";
          if (c.state === "MENTAL_BREAK") {
            if (c.breakKind === "DOOMSAYER") { shape = "alert";  color = "#ff4848"; }
            else if (c.breakKind === "RECLUSE") { shape = "circle"; color = "#9aa6c0"; }
            else if (c.breakKind === "THIEF")   { shape = "diamond"; color = "#ffd64a"; }
          }
          else if (c.state === "STEALING")    { shape = "diamond"; color = "#ff9933"; }
          else if (c.state === "ARRESTING")   { shape = "alert";   color = "#3aa1ff"; }
          else if (c.state === "IMPRISONED")  { shape = "bars";    color = "#9aa3ad"; }
          else if (c.state === "HEALING")     { shape = "cross";   color = "#5fd16f"; }
          else if (c.state === "DRINKING")    { shape = "mug";     color = "#e8b85a"; }
          // Soft halo behind the badge for legibility on bright tiles.
          const haloR = ts * 0.16;
          const grad = ctx.createRadialGradient(cx, bubbleCy, ts * 0.02, cx, bubbleCy, haloR);
          grad.addColorStop(0, color + "cc");
          grad.addColorStop(1, color + "00");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, bubbleCy, haloR, 0, Math.PI * 2);
          ctx.fill();
          // Shape badge — solid color body + dark outline for contrast.
          // Phase 20.5 polish — wrap in save/restore so the mug's foam
          // fillStyle swap (and any future shape state changes) can't
          // leak into the next NPC's draw block. Architect-flagged.
          ctx.save();
          ctx.fillStyle = color;
          ctx.strokeStyle = "rgba(13,17,23,0.95)";
          ctx.lineWidth = Math.max(1, ts * 0.018);
          const r = ts * 0.10;
          if (shape === "alert") {
            // Warning triangle pointing up
            ctx.beginPath();
            ctx.moveTo(cx, bubbleCy - r);
            ctx.lineTo(cx + r * 0.95, bubbleCy + r * 0.7);
            ctx.lineTo(cx - r * 0.95, bubbleCy + r * 0.7);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          } else if (shape === "circle") {
            // Hollow circle (recluse) — stroke-only, no fill, so the
            // halo gradient shows through the center. Architect-flagged
            // that the previous version filled it solid.
            ctx.beginPath();
            ctx.arc(cx, bubbleCy, r * 0.75, 0, Math.PI * 2);
            ctx.lineWidth = Math.max(1.5, ts * 0.025);
            ctx.strokeStyle = color;
            ctx.stroke();
          } else if (shape === "diamond") {
            // Diamond (thief / stealing — value/coin shape)
            ctx.beginPath();
            ctx.moveTo(cx, bubbleCy - r);
            ctx.lineTo(cx + r * 0.8, bubbleCy);
            ctx.lineTo(cx, bubbleCy + r);
            ctx.lineTo(cx - r * 0.8, bubbleCy);
            ctx.closePath();
            ctx.fill(); ctx.stroke();
          } else if (shape === "bars") {
            // Two vertical bars (imprisoned)
            const bw = r * 0.32, bh = r * 1.5;
            ctx.fillRect(cx - r * 0.55, bubbleCy - bh / 2, bw, bh);
            ctx.fillRect(cx + r * 0.23, bubbleCy - bh / 2, bw, bh);
            ctx.strokeRect(cx - r * 0.55, bubbleCy - bh / 2, bw, bh);
            ctx.strokeRect(cx + r * 0.23, bubbleCy - bh / 2, bw, bh);
          } else if (shape === "cross") {
            // Medical cross (healing)
            const tw = r * 1.4, tt = r * 0.42;
            ctx.fillRect(cx - tw / 2, bubbleCy - tt / 2, tw, tt);
            ctx.fillRect(cx - tt / 2, bubbleCy - tw / 2, tt, tw);
            ctx.strokeRect(cx - tw / 2, bubbleCy - tt / 2, tw, tt);
            ctx.strokeRect(cx - tt / 2, bubbleCy - tw / 2, tt, tw);
          } else if (shape === "mug") {
            // Beer mug (drinking) — rectangle body + handle arc
            const mw = r * 1.2, mh = r * 1.4;
            ctx.fillRect(cx - mw / 2, bubbleCy - mh / 2, mw, mh);
            ctx.strokeRect(cx - mw / 2, bubbleCy - mh / 2, mw, mh);
            // Foam cap
            ctx.fillStyle = "#fff8e0";
            ctx.fillRect(cx - mw / 2, bubbleCy - mh / 2, mw, mh * 0.18);
            // Handle
            ctx.beginPath();
            ctx.arc(cx + mw / 2, bubbleCy, mh * 0.32, -Math.PI / 2, Math.PI / 2);
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }
  }

  private buildVignette() {
    const W = this.viewW;
    const H = this.viewH;
    if (this.vignetteGradient && this.vignetteSize.w === W && this.vignetteSize.h === H) return;
    const grad = this.ctx.createRadialGradient(
      W / 2, H / 2, Math.min(W, H) * 0.35,
      W / 2, H / 2, Math.max(W, H) * 0.75
    );
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(0.7, "rgba(0, 0, 0, 0.18)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    this.vignetteGradient = grad;
    this.vignetteSize = { w: W, h: H };
  }

  private resize() {
    const parent = this.canvas.parentElement!;
    this.canvas.width = parent.clientWidth * window.devicePixelRatio;
    this.canvas.height = parent.clientHeight * window.devicePixelRatio;
    this.canvas.style.width = parent.clientWidth + "px";
    this.canvas.style.height = parent.clientHeight + "px";
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    this.vignetteGradient = null;
    this.clampCamera();
  }

  private get viewW() { return this.canvas.width / window.devicePixelRatio; }
  private get viewH() { return this.canvas.height / window.devicePixelRatio; }
  // Phase 13: World bounds are the iso bounding box, NOT the top-down
  // grid rect. The bounding box is (cols+rows) tiles diagonally across.
  private get worldW() {
    const g = this.state.grid;
    return (g.cols + g.rows) * g.tileSize / 2;
  }
  private get worldH() {
    const g = this.state.grid;
    return (g.cols + g.rows) * g.tileSize / 4;
  }

  private get minZoom(): number {
    if (this.viewW === 0 || this.viewH === 0) return 0.05;
    return Math.min(this.viewW / this.worldW, this.viewH / this.worldH);
  }

  private clampCamera() {
    const cam = this.state.camera;
    cam.zoom = Math.max(this.minZoom, Math.min(MAX_ZOOM, cam.zoom));

    const scaledViewW = this.viewW / cam.zoom;
    const scaledViewH = this.viewH / cam.zoom;

    if (scaledViewW >= this.worldW) {
      cam.x = -(scaledViewW - this.worldW) / 2;
    } else {
      cam.x = Math.max(0, Math.min(cam.x, this.worldW - scaledViewW));
    }

    if (scaledViewH >= this.worldH) {
      cam.y = -(scaledViewH - this.worldH) / 2;
    } else {
      cam.y = Math.max(0, Math.min(cam.y, this.worldH - scaledViewH));
    }
  }

  private bindTouchEvents() {
    const el = this.canvas;
    el.addEventListener("touchstart", this.onTouchStart, { passive: false });
    el.addEventListener("touchmove", this.onTouchMove, { passive: false });
    el.addEventListener("touchend", this.onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", this.onTouchEnd, { passive: false });
  }

  private mouseDown = false;
  private mouseLastX = 0;
  private mouseLastY = 0;

  private onMouseDown = (e: MouseEvent) => {
    this.mouseDown = true;
    this.mouseLastX = e.clientX;
    this.mouseLastY = e.clientY;
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
    this.pointerDownTime = performance.now();
    this.pointerMaxMove = 0;
    this.panVelX = 0;
    this.panVelY = 0;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.mouseDown) return;
    const dx = e.clientX - this.mouseLastX;
    const dy = e.clientY - this.mouseLastY;
    this.pointerMaxMove = Math.max(
      this.pointerMaxMove,
      Math.hypot(e.clientX - this.pointerDownX, e.clientY - this.pointerDownY)
    );
    this.panVelX = -dx / this.state.camera.zoom;
    this.panVelY = -dy / this.state.camera.zoom;
    this.state.camera.x += this.panVelX;
    this.state.camera.y += this.panVelY;
    this.clampCamera();
    this.mouseLastX = e.clientX;
    this.mouseLastY = e.clientY;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (this.mouseDown) {
      const dt = performance.now() - this.pointerDownTime;
      if (this.pointerMaxMove < this.TAP_MOVE_SLOP && dt < this.TAP_TIME_MAX) {
        this.handleTap(e.clientX, e.clientY);
      }
    }
    this.mouseDown = false;
  };
  private onMouseLeave = () => { this.mouseDown = false; };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const rect = this.canvas.getBoundingClientRect();
    const focusX = (e.clientX - rect.left) / this.state.camera.zoom + this.state.camera.x;
    const focusY = (e.clientY - rect.top) / this.state.camera.zoom + this.state.camera.y;
    this.applyZoom(factor, focusX, focusY);
  };

  private bindMouseEvents() {
    const el = this.canvas;
    el.addEventListener("mousedown", this.onMouseDown);
    el.addEventListener("mousemove", this.onMouseMove);
    el.addEventListener("mouseup", this.onMouseUp);
    el.addEventListener("mouseleave", this.onMouseLeave);
    el.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      this.touch1 = e.touches[0];
      this.touch2 = null;
      this.lastPanX = this.touch1.clientX;
      this.lastPanY = this.touch1.clientY;
      this.pointerDownX = this.touch1.clientX;
      this.pointerDownY = this.touch1.clientY;
      this.pointerDownTime = performance.now();
      this.pointerMaxMove = 0;
      this.panVelX = 0;
      this.panVelY = 0;
      this.isDragging = true;
    } else if (e.touches.length === 2) {
      this.touch1 = e.touches[0];
      this.touch2 = e.touches[1];
      this.lastPinchDist = this.pinchDistance();
      this.isDragging = false;
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1 && this.isDragging && this.touch1) {
      const t = e.touches[0];
      const dx = t.clientX - this.lastPanX;
      const dy = t.clientY - this.lastPanY;
      this.pointerMaxMove = Math.max(
        this.pointerMaxMove,
        Math.hypot(t.clientX - this.pointerDownX, t.clientY - this.pointerDownY)
      );
      const cam = this.state.camera;
      const movX = -dx / cam.zoom;
      const movY = -dy / cam.zoom;
      this.panVelX = movX;
      this.panVelY = movY;
      cam.x += movX;
      cam.y += movY;
      this.clampCamera();
      this.lastPanX = t.clientX;
      this.lastPanY = t.clientY;
      this.touch1 = t;
    } else if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const newDist = Math.hypot(
        t2.clientX - t1.clientX,
        t2.clientY - t1.clientY
      );
      const factor = newDist / this.lastPinchDist;
      const rect = this.canvas.getBoundingClientRect();
      const midX = ((t1.clientX + t2.clientX) / 2 - rect.left);
      const midY = ((t1.clientY + t2.clientY) / 2 - rect.top);
      const focusX = midX / this.state.camera.zoom + this.state.camera.x;
      const focusY = midY / this.state.camera.zoom + this.state.camera.y;
      this.applyZoom(factor, focusX, focusY);
      this.lastPinchDist = newDist;
      this.touch1 = t1;
      this.touch2 = t2;
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 0 && this.touch1 && !this.touch2) {
      // Single-finger lift — could be a tap. Touch slop is generous on mobile.
      const dt = performance.now() - this.pointerDownTime;
      const TOUCH_SLOP = 14;
      if (this.pointerMaxMove < TOUCH_SLOP && dt < this.TAP_TIME_MAX) {
        this.handleTap(this.touch1.clientX, this.touch1.clientY);
      }
    }
    if (e.touches.length < 2) {
      this.touch2 = null;
    }
    if (e.touches.length === 0) {
      this.touch1 = null;
      this.isDragging = false;
    } else if (e.touches.length === 1) {
      this.touch1 = e.touches[0];
      this.lastPanX = this.touch1.clientX;
      this.lastPanY = this.touch1.clientY;
      this.isDragging = true;
    }
  };

  private pinchDistance(): number {
    if (!this.touch1 || !this.touch2) return 1;
    return Math.hypot(
      this.touch2.clientX - this.touch1.clientX,
      this.touch2.clientY - this.touch1.clientY
    );
  }

  private applyZoom(factor: number, worldFocusX: number, worldFocusY: number) {
    const cam = this.state.camera;
    const newZoom = Math.max(this.minZoom, Math.min(MAX_ZOOM, cam.zoom * factor));
    cam.x = worldFocusX - (worldFocusX - cam.x) * (cam.zoom / newZoom);
    cam.y = worldFocusY - (worldFocusY - cam.y) * (cam.zoom / newZoom);
    cam.zoom = newZoom;
    this.clampCamera();
  }

  // --------------------------------------------------------------------
  // Phase 10.5: Procedural sprite atlas (the "asset map")
  // --------------------------------------------------------------------

  /** Allocate a fresh offscreen canvas and run a draw routine into it. */
  private makeAsset(
    w: number, h: number,
    draw: (g: CanvasRenderingContext2D) => void
  ): HTMLCanvasElement {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.ceil(w));
    cv.height = Math.max(1, Math.ceil(h));
    const g = cv.getContext("2d")!;
    draw(g);
    return cv;
  }

  /**
   * Build every named accessory canvas once and cache it in `this.assets`.
   * All artwork is drawn against ASSET_REF (64) so consumers can pick any
   * destination size and scale via drawImage. Switching to atlas blits frees
   * the per-NPC compositor from re-running primitive draws for accessories.
   */
  private buildAssets() {
    const R = this.ASSET_REF;
    this.assets.clear();

    // ---- FarmerHoe (wood shaft + iron blade) ----
    this.assets.set("FarmerHoe", this.makeAsset(R * 0.30, R * 0.95, (g) => {
      const W = R * 0.30, H = R * 0.95;
      g.strokeStyle = "#7a4a1f"; g.lineWidth = Math.max(1.5, R * 0.04);
      g.beginPath(); g.moveTo(W * 0.5, H * 0.10); g.lineTo(W * 0.5, H); g.stroke();
      g.fillStyle = "#9c9c9c";
      g.beginPath();
      g.moveTo(W * 0.5, H * 0.10);
      g.lineTo(W, H * 0.18);
      g.lineTo(W, H * 0.28);
      g.lineTo(W * 0.5, H * 0.20);
      g.closePath();
      g.fill();
      g.strokeStyle = "rgba(0,0,0,0.4)"; g.lineWidth = 1; g.stroke();
    }));

    // ---- FarmerHoeGold (master variant: gold blade + bound shaft) ----
    this.assets.set("FarmerHoeGold", this.makeAsset(R * 0.30, R * 0.95, (g) => {
      const W = R * 0.30, H = R * 0.95;
      // Darker shaft, gold ferrule
      g.strokeStyle = "#5a3a1f"; g.lineWidth = Math.max(1.5, R * 0.04);
      g.beginPath(); g.moveTo(W * 0.5, H * 0.10); g.lineTo(W * 0.5, H); g.stroke();
      g.strokeStyle = "#d4af37"; g.lineWidth = Math.max(1, R * 0.025);
      g.beginPath(); g.moveTo(W * 0.35, H * 0.30); g.lineTo(W * 0.65, H * 0.30); g.stroke();
      g.beginPath(); g.moveTo(W * 0.35, H * 0.85); g.lineTo(W * 0.65, H * 0.85); g.stroke();
      // Gold blade with shine
      const grad = g.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, "#fde68a"); grad.addColorStop(0.5, "#f4cf5b"); grad.addColorStop(1, "#a07a1b");
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(W * 0.5, H * 0.08);
      g.lineTo(W, H * 0.16);
      g.lineTo(W, H * 0.30);
      g.lineTo(W * 0.5, H * 0.22);
      g.closePath();
      g.fill();
      g.strokeStyle = "rgba(80,50,0,0.7)"; g.lineWidth = 1; g.stroke();
    }));

    // ---- MinerPickaxe (curved iron head) ----
    this.assets.set("MinerPickaxe", this.makeAsset(R * 0.34, R * 0.95, (g) => {
      const W = R * 0.34, H = R * 0.95;
      g.strokeStyle = "#7a4a1f"; g.lineWidth = Math.max(1.5, R * 0.04);
      g.beginPath(); g.moveTo(W * 0.5, H * 0.20); g.lineTo(W * 0.5, H); g.stroke();
      g.strokeStyle = "#5a5a5a"; g.lineWidth = Math.max(2, R * 0.06);
      g.beginPath();
      g.moveTo(0, H * 0.18);
      g.quadraticCurveTo(W * 0.5, H * 0.02, W, H * 0.18);
      g.stroke();
      // Subtle highlight tip
      g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(W * 0.10, H * 0.13); g.lineTo(W * 0.30, H * 0.07); g.stroke();
    }));

    // ---- MinerPickaxeDiamond (master variant: diamond/sapphire head) ----
    this.assets.set("MinerPickaxeDiamond", this.makeAsset(R * 0.34, R * 0.95, (g) => {
      const W = R * 0.34, H = R * 0.95;
      g.strokeStyle = "#5a3a1f"; g.lineWidth = Math.max(1.5, R * 0.04);
      g.beginPath(); g.moveTo(W * 0.5, H * 0.20); g.lineTo(W * 0.5, H); g.stroke();
      g.strokeStyle = "#d4af37"; g.lineWidth = Math.max(1, R * 0.025);
      g.beginPath(); g.moveTo(W * 0.35, H * 0.35); g.lineTo(W * 0.65, H * 0.35); g.stroke();
      // Cyan/diamond head
      g.fillStyle = "#7dd3fc";
      g.beginPath();
      g.moveTo(0, H * 0.18);
      g.quadraticCurveTo(W * 0.5, H * 0.02, W, H * 0.18);
      g.lineTo(W * 0.85, H * 0.28);
      g.quadraticCurveTo(W * 0.5, H * 0.14, W * 0.15, H * 0.28);
      g.closePath();
      g.fill();
      g.strokeStyle = "#0c4a6e"; g.lineWidth = 1; g.stroke();
      g.fillStyle = "rgba(255,255,255,0.7)";
      g.beginPath(); g.arc(W * 0.35, H * 0.13, R * 0.025, 0, Math.PI * 2); g.fill();
    }));

    // ---- GuardSpear (shaft + steel head) ----
    this.assets.set("GuardSpear", this.makeAsset(R * 0.16, R * 1.00, (g) => {
      const W = R * 0.16, H = R * 1.00;
      g.strokeStyle = "#5a3a1f"; g.lineWidth = Math.max(1.5, R * 0.035);
      g.beginPath(); g.moveTo(W * 0.5, H * 0.08); g.lineTo(W * 0.5, H); g.stroke();
      g.fillStyle = "#c0c0c0";
      g.beginPath();
      g.moveTo(0, H * 0.10);
      g.lineTo(W, H * 0.10);
      g.lineTo(W * 0.5, 0);
      g.closePath();
      g.fill();
      g.strokeStyle = "rgba(0,0,0,0.5)"; g.lineWidth = 1; g.stroke();
    }));

    // ---- GuardShield (round, painted red, gold boss) ----
    this.assets.set("GuardShield", this.makeAsset(R * 0.30, R * 0.30, (g) => {
      const S = R * 0.30, c = S / 2;
      g.fillStyle = "#7a3030";
      g.beginPath(); g.arc(c, c, c - 1, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#3a1010"; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = "#d4af37";
      g.beginPath(); g.arc(c, c, c * 0.30, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(80,50,0,0.7)"; g.stroke();
    }));

    // ---- GuardShieldPlated (master: steel face + gold rim + cross emblem) ----
    this.assets.set("GuardShieldPlated", this.makeAsset(R * 0.30, R * 0.30, (g) => {
      const S = R * 0.30, c = S / 2;
      const grad = g.createRadialGradient(c, c * 0.7, c * 0.1, c, c, c);
      grad.addColorStop(0, "#e5e7eb"); grad.addColorStop(1, "#6b7280");
      g.fillStyle = grad;
      g.beginPath(); g.arc(c, c, c - 1, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#d4af37"; g.lineWidth = 2;
      g.beginPath(); g.arc(c, c, c - 1.5, 0, Math.PI * 2); g.stroke();
      // Cross emblem
      g.fillStyle = "#7a3030";
      g.fillRect(c - S * 0.05, c - S * 0.30, S * 0.10, S * 0.55);
      g.fillRect(c - S * 0.25, c - S * 0.05, S * 0.50, S * 0.10);
    }));

    // ---- ZealotCross (gold latin cross with depth) ----
    this.assets.set("ZealotCross", this.makeAsset(R * 0.18, R * 0.22, (g) => {
      const W = R * 0.18, H = R * 0.22;
      g.fillStyle = "#d4af37";
      g.fillRect(W * 0.42, 0, W * 0.16, H);
      g.fillRect(W * 0.20, H * 0.30, W * 0.60, W * 0.16);
      g.strokeStyle = "rgba(80,50,0,0.85)"; g.lineWidth = 1;
      g.strokeRect(W * 0.42, 0, W * 0.16, H);
      g.strokeRect(W * 0.20, H * 0.30, W * 0.60, W * 0.16);
    }));

    // ---- GreedyPouch (leather purse with gold coin) ----
    this.assets.set("GreedyPouch", this.makeAsset(R * 0.20, R * 0.22, (g) => {
      const W = R * 0.20, H = R * 0.22;
      g.fillStyle = "#6b4f12";
      g.beginPath(); g.ellipse(W / 2, H * 0.55, W * 0.45, H * 0.40, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(0,0,0,0.55)"; g.lineWidth = 1; g.stroke();
      // Drawstring
      g.strokeStyle = "#3b2a08"; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(W * 0.30, H * 0.18); g.lineTo(W * 0.70, H * 0.18); g.stroke();
      // Gold coin
      g.fillStyle = "#f4cf5b";
      g.beginPath(); g.arc(W * 0.5, H * 0.55, W * 0.20, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(120,80,0,0.85)"; g.stroke();
    }));

    // ---- KingCrown (gold base + 3 spikes + ruby) ----
    this.assets.set("KingCrown", this.makeAsset(R * 0.30, R * 0.22, (g) => {
      const W = R * 0.30, H = R * 0.22;
      g.fillStyle = "#FFD700";
      g.fillRect(0, H * 0.55, W, H * 0.30);
      g.beginPath();
      g.moveTo(0, H * 0.55);
      g.lineTo(W * 0.20, 0);
      g.lineTo(W * 0.40, H * 0.55);
      g.lineTo(W * 0.50, 0);
      g.lineTo(W * 0.60, H * 0.55);
      g.lineTo(W * 0.80, 0);
      g.lineTo(W, H * 0.55);
      g.closePath(); g.fill();
      g.strokeStyle = "rgba(120,80,0,0.9)"; g.lineWidth = 1.2; g.stroke();
      // Ruby in center
      g.fillStyle = "#dc2626";
      g.beginPath(); g.arc(W / 2, H * 0.70, R * 0.030, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(80,0,0,0.8)"; g.lineWidth = 1; g.stroke();
    }));

    // ---- QueenTiara (delicate arc with three points) ----
    this.assets.set("QueenTiara", this.makeAsset(R * 0.24, R * 0.16, (g) => {
      const W = R * 0.24, H = R * 0.16;
      g.fillStyle = "#FFD700";
      g.beginPath();
      g.moveTo(0, H * 0.85);
      g.lineTo(W * 0.25, H * 0.20);
      g.lineTo(W * 0.50, H * 0.55);
      g.lineTo(W * 0.75, H * 0.20);
      g.lineTo(W, H * 0.85);
      g.closePath(); g.fill();
      g.strokeStyle = "rgba(120,80,0,0.9)"; g.lineWidth = 1.2; g.stroke();
      g.fillStyle = "#dc2626";
      g.beginPath(); g.arc(W * 0.50, H * 0.45, R * 0.015, 0, Math.PI * 2); g.fill();
    }));

    // ---- MasterPendant (gold medallion on chest) ----
    this.assets.set("MasterPendant", this.makeAsset(R * 0.13, R * 0.13, (g) => {
      const S = R * 0.13, c = S / 2;
      const grad = g.createRadialGradient(c * 0.8, c * 0.8, c * 0.1, c, c, c);
      grad.addColorStop(0, "#fde68a"); grad.addColorStop(1, "#a07a1b");
      g.fillStyle = grad;
      g.beginPath(); g.arc(c, c, c - 0.5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "rgba(120,80,0,0.85)"; g.lineWidth = 1; g.stroke();
      // Star inside
      g.fillStyle = "#7a4a1f";
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
        const x = c + Math.cos(a) * c * 0.5;
        const y = c + Math.sin(a) * c * 0.5;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
    }));
  }

  // --------------------------------------------------------------------
  // Phase 10.5: Static terrain layer (single offscreen canvas)
  // --------------------------------------------------------------------

  /**
   * Pre-render the entire world's base tiles + biome transitions into one
   * offscreen canvas. Subsequent frames blit a sub-rect of this canvas
   * instead of looping every visible tile. Built at half resolution to keep
   * memory under control on mobile (100*64*0.5 = 3200px max edge → ~40MB).
   */
  private rebuildTerrainLayer() {
    const grid = this.state.grid;
    const ts = grid.tileSize;
    const s = this.terrainLayerScale;
    // Phase 13: iso bounding box (not top-down rect). For a 100×100 grid
    // this is ~6400px wide × 3200px tall at full-res; half-scale keeps it
    // around 3200×1600 = ~20MB in memory — well within mobile limits.
    const bounds = isoWorldBounds(grid.cols, grid.rows, ts);
    const W = Math.ceil(bounds.w * s);
    const H = Math.ceil(bounds.h * s);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d")!;
    g.imageSmoothingEnabled = true;
    g.scale(s, s);
    // Draw each tile as a 2:1 dimetric diamond centered at its iso
    // projected position. Iterating row-major then col-major gives a
    // valid back-to-front order for tiles (no two tile diamonds overlap).
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const tile = grid.tiles[r][c];
        const { sx, sy } = worldToIso(c, r, ts, grid.rows);
        g.save();
        g.translate(sx, sy);
        g.beginPath();
        g.moveTo(0, -ts / 4);   // top
        g.lineTo(ts / 2, 0);    // right
        g.lineTo(0, ts / 4);    // bottom
        g.lineTo(-ts / 2, 0);   // left
        g.closePath();
        const pat = this.biomePatterns.get(tile.type);
        // Phase 16: Use the live (season-aware) tile color as the fallback
        // so a missing pattern still respects spring greens / winter snow.
        g.fillStyle = pat || this.liveTileColors[tile.type];
        g.fill();
        // Subtle dark edge to give every tile a visible boundary, like
        // the etched lines you see in classic dimetric strategy games.
        g.strokeStyle = "rgba(0, 0, 0, 0.18)";
        g.lineWidth = 0.75;
        g.stroke();

        // Phase 15: Procedural clutter pass — pebbles, wildflowers, and
        // grass tufts scattered onto grass / forest / desert / snow tiles
        // with a deterministic per-tile RNG so two adjacent screens never
        // look identical, but the same tile renders the same scatter on
        // every reload. Drawn ONCE into the cached terrainLayer, so the
        // per-frame cost is exactly zero. Skipped entirely for water /
        // mountain / crater (those biomes get their own visual texture).
        if (tile.type === "grass" || tile.type === "forest" || tile.type === "desert" || tile.type === "snow") {
          this.drawTerrainClutter(g, ts, tile.type, r, c);
        }
        // Phase 16: Mountain cliff face — gray rocky ridge on the south
        // edge of mountain tiles, giving the world genuine verticality
        // when zoomed in. Baked into terrainLayer (zero per-frame cost).
        if (tile.type === "mountain") {
          this.drawMountainCliff(g, ts, r, c);
        }
        // Phase 17: Water foam moved to per-frame `drawAnimatedFoam` so
        // the shore can pulse with the same waterAnimPhase as the wave
        // overlay (3-frame loop). Baking it here would freeze the foam
        // out of phase with the moving water.

        g.restore();
      }
    }

    // Phase 17: True 3D extruded cliff faces — second pass after every
    // tile has been filled, so the cliff prism (which extends DOWN past
    // the diamond's south vertex) draws OVER any non-mountain tile
    // immediately below it, exactly like a real cliff dropping into the
    // valley floor. Drawn in iso-projection world space (no per-tile
    // translate) so the extrusion lines up with neighbor tile tops.
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        if (grid.tiles[r][c].type !== "mountain") continue;
        this.drawCliffExtrusion(g, ts, grid, r, c);
      }
    }

    this.terrainLayer = cv;
  }

  /**
   * Phase 15: Procedural clutter for one tile. Uses a deterministic
   * per-tile RNG (seeded from row/col) so the scatter is stable across
   * reloads and never flickers. Called from inside rebuildTerrainLayer
   * with the canvas already translated to the tile's iso center.
   *
   * Each tile gets up to ~3 small props chosen from a biome-aware pool:
   *   - grass:  white/yellow flowers, pebbles, grass tufts
   *   - forest: pine saplings, moss patches, larger pebbles
   *   - desert: bleached rocks, sparse cacti dots
   *   - snow:   small snow drifts, dark twigs
   *
   * All props stay strictly inside the tile's diamond footprint
   * (|x|/(ts/2) + |y|/(ts/4) <= 0.85) so they never spill into
   * neighboring tiles when the terrainLayer is blitted.
   */
  private drawTerrainClutter(
    g: CanvasRenderingContext2D,
    ts: number,
    biome: TileType,
    row: number,
    col: number,
  ) {
    // Seeded mulberry32 — same tile coords always produce the same
    // scatter, no flicker on terrain rebuilds (e.g. after a meteor).
    let s = ((row * 73856093) ^ (col * 19349663)) >>> 0;
    const rand = () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // 0–3 props per tile. Probability tuned for "scattered, not crowded."
    const propCount = rand() < 0.55 ? Math.floor(rand() * 3) + 1 : 0;
    if (propCount === 0) return;

    for (let i = 0; i < propCount; i++) {
      // Sample inside the tile's diamond. Reject if outside.
      let dx = 0, dy = 0, ok = false;
      for (let tries = 0; tries < 6 && !ok; tries++) {
        dx = (rand() * 2 - 1) * ts * 0.42;
        dy = (rand() * 2 - 1) * ts * 0.21;
        // Diamond test: |x| / (ts/2) + |y| / (ts/4) <= 0.85
        if (Math.abs(dx) / (ts * 0.5) + Math.abs(dy) / (ts * 0.25) <= 0.82) ok = true;
      }
      if (!ok) continue;

      const roll = rand();

      if (biome === "grass") {
        if (roll < 0.40) {
          // Wildflower: small white or yellow petal cluster (4 dots in a +)
          const isYellow = rand() < 0.5;
          const petal = isYellow ? "rgba(250, 232, 120, 0.95)" : "rgba(248, 248, 245, 0.95)";
          const center = isYellow ? "rgba(180, 130, 40, 0.95)" : "rgba(220, 200, 80, 0.95)";
          const r = ts * 0.020;
          g.fillStyle = petal;
          for (const [px, py] of [[0, -r], [r, 0], [0, r], [-r, 0]]) {
            g.beginPath();
            g.arc(dx + px, dy + py, r * 0.85, 0, Math.PI * 2);
            g.fill();
          }
          g.fillStyle = center;
          g.beginPath();
          g.arc(dx, dy, r * 0.55, 0, Math.PI * 2);
          g.fill();
        } else if (roll < 0.70) {
          // Pebble cluster: 2-3 small grey-brown ovals
          const pebbleCount = 1 + Math.floor(rand() * 2);
          for (let p = 0; p < pebbleCount; p++) {
            const px = dx + (rand() - 0.5) * ts * 0.06;
            const py = dy + (rand() - 0.5) * ts * 0.03;
            const pr = ts * (0.018 + rand() * 0.012);
            g.fillStyle = `rgba(${110 + Math.floor(rand() * 30)}, ${100 + Math.floor(rand() * 25)}, ${85 + Math.floor(rand() * 20)}, 0.95)`;
            g.beginPath();
            g.ellipse(px, py, pr, pr * 0.65, 0, 0, Math.PI * 2);
            g.fill();
            // tiny highlight
            g.fillStyle = "rgba(255, 255, 255, 0.30)";
            g.beginPath();
            g.ellipse(px - pr * 0.25, py - pr * 0.25, pr * 0.30, pr * 0.18, 0, 0, Math.PI * 2);
            g.fill();
          }
        } else if (roll < 0.92) {
          // Grass tuft: 3-4 short upward strokes in a darker green
          g.strokeStyle = `rgba(${50 + Math.floor(rand() * 25)}, ${100 + Math.floor(rand() * 30)}, ${45 + Math.floor(rand() * 20)}, 0.85)`;
          g.lineWidth = 0.9;
          g.lineCap = "round";
          const blades = 3 + Math.floor(rand() * 2);
          for (let b = 0; b < blades; b++) {
            const bx = dx + (b - blades / 2) * ts * 0.018;
            const by = dy + ts * 0.012;
            const tipX = bx + (rand() - 0.5) * ts * 0.012;
            const tipY = by - ts * (0.025 + rand() * 0.015);
            g.beginPath();
            g.moveTo(bx, by);
            g.lineTo(tipX, tipY);
            g.stroke();
          }
        } else {
          // Small sapling: brown trunk + green canopy
          const trunkH = ts * 0.06;
          g.fillStyle = "#6b4f2a";
          g.fillRect(dx - 0.8, dy - trunkH * 0.3, 1.6, trunkH * 0.6);
          g.fillStyle = `rgba(${30 + Math.floor(rand() * 20)}, ${110 + Math.floor(rand() * 25)}, ${40 + Math.floor(rand() * 20)}, 0.92)`;
          g.beginPath();
          g.arc(dx, dy - trunkH * 0.5, ts * 0.045, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = "rgba(0, 0, 0, 0.35)";
          g.lineWidth = 0.5;
          g.stroke();
        }
      } else if (biome === "forest") {
        // Forest gets pine saplings + moss patches + larger pebbles
        if (roll < 0.55) {
          // Pine sapling: triangle canopy + small trunk
          const trunkH = ts * 0.05;
          const canopyH = ts * 0.10;
          g.fillStyle = "#5a3e22";
          g.fillRect(dx - 1, dy - trunkH * 0.2, 2, trunkH * 0.7);
          g.fillStyle = `rgba(${20 + Math.floor(rand() * 15)}, ${75 + Math.floor(rand() * 25)}, ${30 + Math.floor(rand() * 15)}, 0.95)`;
          g.beginPath();
          g.moveTo(dx, dy - trunkH * 0.2 - canopyH);
          g.lineTo(dx - canopyH * 0.5, dy - trunkH * 0.2);
          g.lineTo(dx + canopyH * 0.5, dy - trunkH * 0.2);
          g.closePath();
          g.fill();
          g.strokeStyle = "rgba(0, 0, 0, 0.45)";
          g.lineWidth = 0.5;
          g.stroke();
        } else if (roll < 0.85) {
          // Moss patch: 3 small dark-green blobs
          for (let b = 0; b < 3; b++) {
            const bx = dx + (rand() - 0.5) * ts * 0.06;
            const by = dy + (rand() - 0.5) * ts * 0.03;
            g.fillStyle = `rgba(40, 90, 50, 0.55)`;
            g.beginPath();
            g.ellipse(bx, by, ts * 0.025, ts * 0.013, 0, 0, Math.PI * 2);
            g.fill();
          }
        } else {
          // Large mossy pebble
          g.fillStyle = "rgba(95, 88, 70, 0.95)";
          g.beginPath();
          g.ellipse(dx, dy, ts * 0.032, ts * 0.020, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "rgba(50, 95, 55, 0.45)";
          g.beginPath();
          g.ellipse(dx - ts * 0.005, dy - ts * 0.008, ts * 0.018, ts * 0.008, 0, 0, Math.PI * 2);
          g.fill();
        }
      } else if (biome === "desert") {
        // Desert: bleached rocks + dry tufts
        if (roll < 0.6) {
          g.fillStyle = `rgba(${190 + Math.floor(rand() * 25)}, ${175 + Math.floor(rand() * 20)}, ${140 + Math.floor(rand() * 20)}, 0.95)`;
          g.beginPath();
          g.ellipse(dx, dy, ts * 0.025, ts * 0.016, 0, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = "rgba(120, 90, 50, 0.4)";
          g.lineWidth = 0.5;
          g.stroke();
        } else {
          g.strokeStyle = "rgba(150, 130, 70, 0.7)";
          g.lineWidth = 0.8;
          for (let b = 0; b < 3; b++) {
            const bx = dx + (b - 1) * ts * 0.014;
            g.beginPath();
            g.moveTo(bx, dy + ts * 0.01);
            g.lineTo(bx + (rand() - 0.5) * ts * 0.01, dy - ts * 0.022);
            g.stroke();
          }
        }
      } else if (biome === "snow") {
        // Snow: small drifts + dark twigs
        if (roll < 0.55) {
          g.fillStyle = "rgba(255, 255, 255, 0.95)";
          g.beginPath();
          g.ellipse(dx, dy, ts * 0.030, ts * 0.014, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "rgba(180, 200, 230, 0.5)";
          g.beginPath();
          g.ellipse(dx + ts * 0.008, dy + ts * 0.003, ts * 0.018, ts * 0.008, 0, 0, Math.PI * 2);
          g.fill();
        } else {
          g.strokeStyle = "rgba(60, 45, 30, 0.85)";
          g.lineWidth = 0.9;
          g.beginPath();
          g.moveTo(dx - ts * 0.025, dy + ts * 0.005);
          g.lineTo(dx + ts * 0.025, dy - ts * 0.008);
          g.stroke();
        }
      }
    }
  }

  /**
   * Incrementally patch the terrain layer for one tile and its 4 neighbours
   * (so transition strips on both sides of the painted tile stay correct).
   * Avoids the cost of a full rebuild during architect-mode painting.
   */
  private redrawTerrainTile(_row: number, _col: number) {
    // Phase 13: iso diamond tiles overlap their bounding rects, so an
    // incremental "patch this tile + its 4 neighbors" is risky (you can
    // erase parts of unrelated tiles). Instead, mark dirty and let
    // render() trigger one full rebuild on the next frame. Architect
    // brush strokes and meteor strikes are both rare enough that paying
    // ~30ms once is cheaper than any incremental scheme.
    this.terrainDirty = true;
  }

  /**
   * Phase 10.5: Public — rounded current FPS reading (EMA over recent frames).
   * The React HUD polls this from a separate rAF loop so a value change
   * never triggers a re-render of unrelated game state.
   */
  public getFPS(): number {
    return Math.round(this.fpsEma);
  }

  /**
   * Phase 22 — Resolve the most-specific sprite manifest key for a citizen.
   * Priority: King → Queen → infant → child → noble → peasant. The first
   * key the AssetManager actually has loaded is returned; if none of the
   * candidate keys are loaded we return null and the caller falls through
   * to the procedural body draw. Returning a fallback key (vs. always
   * returning the most-specific one) means dropping in just `peasant.png`
   * works without nobles disappearing.
   */
  private resolveCitizenSpriteKey(c: Citizen): string | null {
    const candidates: string[] = [];
    if (c.isKing) candidates.push("character.king");
    else if (c.isQueen || c.isDowagerQueen) candidates.push("character.queen");
    const stage = getLifeStage(c, this.state.time.gameYear);
    if (stage === "infant") candidates.push("character.infant");
    else if (stage === "child") candidates.push("character.child");
    if (c.socialTier === "noble") candidates.push("character.noble");
    candidates.push("character.peasant");
    for (const key of candidates) {
      if (this.spriteAssets.has(key)) return key;
    }
    return null;
  }

  /**
   * Phase 21: Per-frame construction accumulator. For each building that is
   * still scaffolded (`complete === false`), find any living non-infant
   * citizen physically standing on the building tile and credit that
   * frame's wall-clock dt (scaled by timeScale) toward
   * CONSTRUCTION_WORK_MS_REQUIRED. When the threshold is crossed the
   * building flips to complete, the desirability map is dirtied (so the
   * Build AI re-scores neighborhoods now that a real producer/house
   * exists), and a Chronicle entry is logged.
   *
   * Note on the spec deviation: the original Phase 21 brief asked for
   * "NPCs in the WORKING state". Because the production loop already
   * skips incomplete buildings (zero output, zero housing), no NPC ever
   * gets formally assigned-as-worker to a scaffold. To keep construction
   * from deadlocking we credit any living non-infant citizen on the
   * tile — peasants walking past the foundation count as the work crew.
   */
  private tickConstruction(dtMs: number) {
    if (this.state.time.timeScale === 0) return;
    // Cheap pre-check — most buildings are complete; iterate once to find
    // any incomplete ones, and bail if there are none.
    const incomplete: Building[] = [];
    for (const b of this.state.buildings) {
      if (b.complete === false && b.status !== "rubble") incomplete.push(b);
    }
    if (incomplete.length === 0) return;

    // Build a row,col → building lookup for the (small) incomplete set.
    const tileMap = new Map<string, Building>();
    for (const b of incomplete) tileMap.set(`${b.row},${b.col}`, b);

    const scaledMs = dtMs * this.state.time.timeScale;
    const currentYear = this.state.time.gameYear;

    for (const c of this.state.citizens) {
      if (c.state === "DEAD") continue;
      // Infants don't build (they're swaddled bundles). Children do — Phase
      // 21 children are 60% scale and run errands.
      if (getLifeStage(c, currentYear) === "infant") continue;
      const b = tileMap.get(`${c.row},${c.col}`);
      if (!b) continue;
      b.constructionWorkMs = (b.constructionWorkMs ?? 0) + scaledMs;
      if (b.constructionWorkMs >= CONSTRUCTION_WORK_MS_REQUIRED) {
        b.complete = true;
        b.constructionWorkMs = CONSTRUCTION_WORK_MS_REQUIRED;
        // The building is now a live economic entity — re-score
        // desirability so neighbors update on the next month tick.
        this.desirability.markDirty();
        // Friendly building name — strip the "house_" prefix and replace
        // underscores so "house_free" reads as "free house".
        const friendly = b.typeId.replace(/_/g, " ");
        addChronicle(this.state, `A new ${friendly} stands complete in the realm.`);
      }
    }
  }

  /**
   * Phase 21: Render a scaffolded foundation in place of the normal
   * building floor + furniture. Visual: dark dirt diamond (the cleared
   * plot) + four wooden corner posts + a horizontal scaffold beam. A
   * progress bar across the foundation shows construction completion so
   * the player can read at a glance how close the structure is to
   * finishing.
   */
  private drawConstructionScaffolding(b: Building, x: number, y: number, ts: number) {
    const ctx = this.ctx;
    const cx = x + ts * 0.5;
    const groundY = y + ts * 0.55;
    const fw = ts * 0.86;
    const fh = fw * 0.5;

    // Soft drop shadow under the cleared plot
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(cx, y + ts * 0.93, ts * 0.46, ts * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    // Foundation diamond — packed dark earth so it reads as "cleared lot"
    // distinct from grass.
    const tx = cx, ty = groundY - fh * 0.5;
    const rx = cx + fw * 0.5, ry = groundY;
    const bx = cx, by = groundY + fh * 0.5;
    const lx = cx - fw * 0.5, ly = groundY;
    ctx.fillStyle = "#5a4632";
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(rx, ry);
    ctx.lineTo(bx, by);
    ctx.lineTo(lx, ly);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Four wooden corner posts at the diamond points (top/right/bottom/left).
    const postW = Math.max(1.5, ts * 0.04);
    const postH = ts * 0.30;
    const postColor = "#7a4a22";
    const postShade = "#3a2310";
    const corners: Array<[number, number]> = [
      [tx, ty],
      [rx, ry],
      [bx, by],
      [lx, ly],
    ];
    for (const [px, py] of corners) {
      ctx.fillStyle = postShade;
      ctx.fillRect(px - postW * 0.5 + 1, py - postH + 1, postW, postH);
      ctx.fillStyle = postColor;
      ctx.fillRect(px - postW * 0.5, py - postH, postW, postH);
    }

    // Two crossing horizontal scaffold beams (front + back) connecting
    // the corner posts at half-post height, like real construction
    // staging.
    const beamY = groundY - postH * 0.55;
    ctx.strokeStyle = postColor;
    ctx.lineWidth = Math.max(1.2, ts * 0.025);
    ctx.beginPath();
    ctx.moveTo(lx, ly - postH * 0.55);
    ctx.lineTo(tx, ty - postH * 0.55);
    ctx.lineTo(rx, ry - postH * 0.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(lx, ly - postH * 0.55);
    ctx.lineTo(bx, by - postH * 0.55);
    ctx.lineTo(rx, ry - postH * 0.55);
    ctx.stroke();
    void beamY;

    // Progress bar — drawn at the foundation's leading edge so it always
    // sits clear of the scaffold posts.
    const progress = Math.min(
      1,
      (b.constructionWorkMs ?? 0) / CONSTRUCTION_WORK_MS_REQUIRED
    );
    const barW = fw * 0.65;
    const barH = ts * 0.05;
    const barX = cx - barW * 0.5;
    const barY = groundY + fh * 0.5 + ts * 0.04;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = "#d4a04a";
    ctx.fillRect(barX + 1, barY + 1, Math.max(0, (barW - 2) * progress), barH - 2);
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);
  }

  private start() {
    this.lastFrameTime = performance.now();
    this.lastSaveTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;

    // Phase 10.5: FPS EMA. Clamp dt to a sane band so a single GC stall
    // doesn't pull the average to 1 FPS for several seconds.
    if (dt > 0 && dt < 1000) {
      const inst = 1000 / dt;
      // Heavier weight when we have no sample yet, then settle to a 90/10 EMA.
      const a = this.fpsLastSampleAt === 0 ? 1 : 0.1;
      this.fpsEma = this.fpsEma * (1 - a) + inst * a;
      this.fpsLastSampleAt = now;
    }

    // Phase 12: advance the wall-clock counter every frame so CHATTING
    // expirations + future time-based contagion stay in sync (the engine
    // never gets per-frame ms updates from anywhere else).
    this.state.time.totalRealMs += dt;

    this.tickTime(dt);
    this.tickCitizenMovement(dt);
    this.tickCombat(dt);
    this.tickSparks(dt);
    // Phase 21: accumulate construction work on incomplete buildings. Cheap
    // (early-outs when no incomplete buildings exist) and only counts living
    // adults physically standing on the building tile, so the rate matches
    // worker presence rather than a fixed timer. timeScale=0 freezes
    // construction along with everything else.
    this.tickConstruction(dt);
    // Phase 13: weather particles + lightning roll. Runs every frame
    // regardless of timeScale so a paused world still has visible rain.
    this.tickClimate(dt);
    // Phase 16: Ambient fauna (sheep). Cheap per-frame wander logic, runs
    // every frame regardless of timeScale so paused worlds still feel
    // alive (sheep slow to a crawl when timeScale=0 — they don't freeze).
    this.tickAnimals(dt);
    // Phase 16: Expire bless light shafts so the array doesn't grow.
    if (this.lightShafts.length > 0) {
      const tCutoff = this.state.time.totalRealMs;
      this.lightShafts = this.lightShafts.filter((s) => s.until > tCutoff);
    }
    // Phase 16: Animate water surface. Phase tracker is unbounded so we
    // increment per real-frame ms (independent of timeScale — water keeps
    // moving when the world is paused, which feels correct).
    this.waterAnimPhase += dt * 0.0025;

    // Phase 12: Rumor Mill — gated to once per second to keep the O(N)
    // bucketed proximity scan from running 60×/s. Pause completely when
    // the player has frozen time (timeScale === 0).
    if (this.state.time.timeScale > 0) {
      this.rumorAccMs += dt;
      if (this.rumorAccMs >= 1000) {
        runRumorMill(this.state);
        this.rumorAccMs = 0;
      }
    }

    this.render();

    if (now - this.lastSaveTime > SAVE_INTERVAL_MS) {
      this.save();
      this.lastSaveTime = now;
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  /**
   * Per-frame: smoothly interpolate every citizen along their current path.
   * Movement speed scales with timeScale (frozen at 0×). Arrival logic
   * (e.g. eating at a Bakery) lives inside updateCitizenMovement.
   */
  private tickCitizenMovement(dtMs: number) {
    const ts = this.state.time.timeScale;
    if (ts === 0) return;
    const buildings = this.state.buildings;
    const all = this.state.citizens;
    const civ = this.state.civilization;
    // Phase 12 fix: pass `this.state` so updateCitizenMovement uses the
    // canonical `state.time.totalRealMs` clock for CHATTING expiry. Without
    // it, the fallback to performance.now() (which resets on page load)
    // can leave NPCs stuck in CHATTING forever after a reload, since
    // chatUntilMs was stamped against the much-larger persisted totalRealMs.
    for (const c of all) {
      updateCitizenMovement(c, dtMs, ts, buildings, all, civ, this.state);
    }
  }

  private tickTime(dtMs: number) {
    const ts = this.state.time.timeScale;
    if (ts === 0) return;
    const monthsPerMs = MONTHS_PER_REAL_MS_AT_1X * ts;
    this.accumulatedMonthFrac += dtMs * monthsPerMs;
    const wholeMonths = Math.floor(this.accumulatedMonthFrac);
    if (wholeMonths > 0) {
      this.accumulatedMonthFrac -= wholeMonths;
      this.state.time.gameMonth += wholeMonths;
      while (this.state.time.gameMonth > 12) {
        this.state.time.gameMonth -= 12;
        this.state.time.gameYear++;
      }
      // Run civilization simulation for each elapsed month (capped to avoid
      // huge stalls if user tabbed away — offline catch-up handles long gaps).
      const sims = Math.min(wholeMonths, 6);
      for (let i = 0; i < sims; i++) this.simulateMonth();
      this.callbacks.onTimeUpdate(this.state);
    }
  }

  private render() {
    const ctx = this.ctx;
    const cam = this.state.camera;
    const grid = this.state.grid;
    const ts = grid.tileSize;
    const W = this.viewW;
    const H = this.viewH;

    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.scale(cam.zoom, cam.zoom);
    // Phase 16: Divine impact screen shake. Apply BEFORE the camera
    // translate so jitter is in screen-space px (independent of zoom).
    // Linear ease-out: shake amplitude scales with remaining time.
    let shakeDx = 0;
    let shakeDy = 0;
    if (this.state.time.totalRealMs < this.screenShakeUntilMs) {
      const remaining = this.screenShakeUntilMs - this.state.time.totalRealMs;
      const t = Math.max(0, Math.min(1, remaining / 500)); // Phase 17: 500ms full duration
      const amp = this.screenShakeIntensity * t;
      shakeDx = (Math.random() - 0.5) * 2 * amp;
      shakeDy = (Math.random() - 0.5) * 2 * amp;
    }
    ctx.translate(-cam.x + shakeDx / cam.zoom, -cam.y + shakeDy / cam.zoom);

    // Phase 13: TRUE 2:1 DIMETRIC ISOMETRIC RENDER
    //
    // 1) Terrain — pre-rendered iso diamond layer, blitted as a single
    //    image. We rebuild on first frame and whenever a tile mutation
    //    set the dirty flag (architect brush, meteor blast).
    // 2) Entities — buildings + citizens are interleaved in a single
    //    depth-sorted queue keyed by (row + col) so a citizen on a tile
    //    "in front" of a building draws over its wall, while one on a
    //    tile "behind" the building gets occluded. Citizens get a +0.01
    //    epsilon so on the SAME tile as a building they draw on top.
    if (this.terrainDirty) {
      this.rebuildTerrainLayer();
      this.terrainDirty = false;
    }
    if (!this.terrainLayer) this.rebuildTerrainLayer();

    if (this.terrainLayer) {
      const layerScale = this.terrainLayerScale;
      const visW = W / cam.zoom;
      const visH = H / cam.zoom;
      // Source rect = visible camera viewport mapped into terrain image
      // pixel coords (clamped so we never read outside the image).
      const srcX = Math.max(0, cam.x * layerScale);
      const srcY = Math.max(0, cam.y * layerScale);
      const srcW = Math.min(this.terrainLayer.width - srcX, visW * layerScale);
      const srcH = Math.min(this.terrainLayer.height - srcY, visH * layerScale);
      const dstX = Math.max(cam.x, 0);
      const dstY = Math.max(cam.y, 0);
      const dstW = srcW / layerScale;
      const dstH = srcH / layerScale;
      if (srcW > 0 && srcH > 0) {
        ctx.drawImage(this.terrainLayer, srcX, srcY, srcW, srcH, dstX, dstY, dstW, dstH);
      }
    }

    // Phase 16: Animated water surface — sine-wave overlay drawn over the
    // baked terrain layer for visible water tiles only. Cheap because we
    // cull to camera bounds + cap iteration count.
    this.drawAnimatedWater(ctx, ts, cam);

    // Phase 17: Animated coastline foam — 3-frame pulse loop along every
    // water-tile edge that abuts land. Drawn AFTER the water waves so
    // the foam highlight sits on top of the ripples, not under them.
    this.drawAnimatedFoam(ctx, ts, cam);

    // Build the depth-sorted entity queue. Cull anything whose iso
    // projected center is well outside the visible camera viewport so
    // we don't pay sort/draw cost for off-screen actors.
    const margin = ts * 3;
    const minSx = cam.x - margin;
    const maxSx = cam.x + W / cam.zoom + margin;
    const minSy = cam.y - margin;
    const maxSy = cam.y + H / cam.zoom + margin;
    type SceneEntry = { sortKey: number; draw: () => void };
    const queue: SceneEntry[] = [];
    const rows = grid.rows;

    // Phase 14b "Dollhouse" — pre-compute building occupancy so the front+roof
    // layer can fade the roof when an NPC is on the building's tile. We
    // hash by "row,col" and check non-DEAD citizens only (corpses don't
    // open the dollhouse). O(N_citizens) once per frame, then O(1) per
    // building lookup.
    //
    // Architect note: we use the citizen's LOGICAL tile (c.row, c.col) —
    // not the smoothly-interpolated visual position — to avoid roof
    // flicker as an NPC walks across the edge of a house tile. The
    // logical row/col only updates on full tile commits inside
    // updateCitizenMovement, giving the cutaway natural hysteresis
    // (the roof opens on entry, stays open until the NPC has fully
    // stepped off the tile).
    const occupied = new Set<string>();
    for (const c of this.state.citizens) {
      if (c.state === "DEAD") continue;
      occupied.add(`${c.row},${c.col}`);
    }

    for (const b of this.state.buildings) {
      const { sx, sy } = worldToIso(b.col, b.row, ts, rows);
      if (sx < minSx || sx > maxSx || sy < minSy || sy > maxSy) continue;
      const def = getBuildingDef(b.typeId);
      const isLegacyCombined =
        b.status === "rubble" || (def.category === "service" && b.typeId === "well");
      if (isLegacyCombined) {
        // Wells / rubble — single combined draw (no roof to fade).
        queue.push({
          sortKey: b.row + b.col,
          draw: () => this.drawSingleBuilding(b, sx, sy, ts),
        });
      } else {
        // Dollhouse three-layer split. The citizen entry below interleaves
        // at sortKey + 0.01 so order on the same tile is:
        //   floor (-0.10)  →  back (-0.05)  →  citizen (+0.01)  →  front+roof (+0.50)
        const baseKey = b.row + b.col;
        const x = sx - ts * 0.5;
        const y = sy - ts * 0.6;
        const roofAlpha = occupied.has(`${b.row},${b.col}`) ? 0.25 : 1.0;
        queue.push({
          sortKey: baseKey - 0.10,
          draw: () => this.drawBuildingFloor(b, def, x, y, ts),
        });
        queue.push({
          sortKey: baseKey - 0.05,
          draw: () => this.drawBuildingBackStructure(b, def, x, y, ts),
        });
        queue.push({
          sortKey: baseKey + 0.50,
          draw: () => this.drawBuildingFrontAndRoof(b, def, x, y, ts, roofAlpha),
        });
      }
    }

    const tNow = performance.now() / 1000;
    for (const c of this.state.citizens) {
      const pos = getCitizenVisualPos(c);
      const { sx, sy } = worldToIso(pos.col, pos.row, ts, rows);
      if (sx < minSx || sx > maxSx || sy < minSy || sy > maxSy) continue;
      queue.push({
        sortKey: pos.row + pos.col + 0.01,
        draw: () => this.drawSingleCitizen(c, pos, sx, sy, tNow, ts),
      });
    }

    // Phase 16/17: Animals — interpolated visual pos like citizens, sortKey
    // +0.005 so on the same tile animals draw BELOW citizens. Phase 17
    // dispatches on `kind` for sheep vs wolf sprites.
    for (const a of this.state.animals ?? []) {
      const visRow = a.row + (a.targetRow - a.row) * a.progress;
      const visCol = a.col + (a.targetCol - a.col) * a.progress;
      const { sx, sy } = worldToIso(visCol, visRow, ts, rows);
      if (sx < minSx || sx > maxSx || sy < minSy || sy > maxSy) continue;
      const animal = a;
      queue.push({
        sortKey: visRow + visCol + 0.005,
        draw: () =>
          animal.kind === "wolf"
            ? this.drawWolf(animal, sx, sy, ts)
            : this.drawSheep(animal, sx, sy, ts),
      });
    }

    queue.sort((a, b) => a.sortKey - b.sortKey);
    for (const e of queue) e.draw();

    // Phase 4: combat sparks (drawn above all entities, still in world space)
    this.renderSparks();

    // Phase 16: Bless light shafts — golden vertical pillars descending onto
    // recently-blessed citizens. Drawn AFTER particles so the shaft outlines
    // the rising motes rather than getting buried under them.
    this.renderLightShafts(ctx, ts);

    ctx.restore();

    // Phase 6/10: Dramatic cool-blue night overlay — multiply tint plus a
    // subtle vignette that's darker at the edges for cinematic depth.
    if (this.state.dayNight === "night") {
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "rgb(70, 95, 160)";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      // Cool tint pass
      ctx.fillStyle = "rgba(12, 20, 56, 0.32)";
      ctx.fillRect(0, 0, W, H);
      // Edge darkening
      const nv = ctx.createRadialGradient(
        W / 2, H / 2, Math.min(W, H) * 0.30,
        W / 2, H / 2, Math.max(W, H) * 0.75
      );
      nv.addColorStop(0, "rgba(0,0,0,0)");
      nv.addColorStop(1, "rgba(0,10,30,0.45)");
      ctx.fillStyle = nv;
      ctx.fillRect(0, 0, W, H);
    }

    // Phase 5: Winter overlay — pale blue wash + a faint brightness boost.
    if (this.state.winterActive) {
      ctx.fillStyle = "rgba(170, 210, 255, 0.22)";
      ctx.fillRect(0, 0, W, H);
    }

    // Phase 13: Seasonal tint overlay. Sits between the night/winter
    // overlays and the vignette so it colors the world but doesn't
    // muddy the edge darkening. Summer is neutral (no overlay).
    const seasonTint = this.seasonTintColor(this.state.currentSeason);
    if (seasonTint) {
      ctx.fillStyle = seasonTint;
      ctx.fillRect(0, 0, W, H);
    }

    // Pass 6: vignette overlay
    this.buildVignette();
    if (this.vignetteGradient) {
      ctx.fillStyle = this.vignetteGradient;
      ctx.fillRect(0, 0, W, H);
    }

    // Phase 16: Speed vignette — extra darkening at 2× to telegraph that
    // the simulation is running fast. A second radial pass on top of the
    // baseline vignette is cheaper than rebuilding a custom gradient and
    // gives a richer "tunnel vision" feel during fast-forward.
    if (this.state.time.timeScale === 2) {
      const sv = ctx.createRadialGradient(
        W / 2, H / 2, Math.min(W, H) * 0.20,
        W / 2, H / 2, Math.max(W, H) * 0.70
      );
      sv.addColorStop(0, "rgba(0,0,0,0)");
      sv.addColorStop(1, "rgba(0,0,0,0.32)");
      ctx.fillStyle = sv;
      ctx.fillRect(0, 0, W, H);
    }

    // Phase 13: Weather VFX layer (rain/snow particles + lightning flash).
    // Drawn LAST so particles sit above the vignette and a lightning flash
    // blows out the entire screen including overlays.
    this.renderWeatherFx();
  }

  /* -------------------------------------------------------------------- */
  /*  Phase 4: Combat & particle effects                                  */
  /* -------------------------------------------------------------------- */

  /**
   * Each frame, look for a Rebel and a Royalist within COMBAT_RADIUS_TILES
   * who aren't already in combat. Lock both into COMBAT, start the timer,
   * and emit sparks. When the timer hits 0, one combatant dies (King-killers
   * get the chance to topple the throne via royalty.notifyDeath).
   */
  private tickCombat(dtMs: number) {
    if (this.state.time.timeScale === 0) return;
    const ts = this.state.grid.tileSize;
    const all = this.state.citizens;

    // 1) Pair up new combat encounters (only when civil war is hot).
    if (this.state.nobleDissent === "HIGH") {
      const rebels = all.filter(
        (c) => c.faction === "rebel" && c.state !== "DEAD" && c.state !== "COMBAT"
      );
      const royals = all.filter(
        (c) => c.faction === "royalist" && c.state !== "DEAD" && c.state !== "COMBAT"
      );
      for (const r of rebels) {
        for (const g of royals) {
          const dr = Math.abs(r.row - g.row);
          const dc = Math.abs(g.col - r.col);
          if (dr <= COMBAT_RADIUS_TILES && dc <= COMBAT_RADIUS_TILES) {
            this.startCombat(r, g);
            break;
          }
        }
      }
    }

    // 2) Tick existing combats — emit sparks and resolve when timer expires.
    const speed = this.state.time.timeScale;
    for (const c of all) {
      if (c.state !== "COMBAT") continue;
      // Stop in place while fighting
      c.path = [];
      c.pathIndex = 0;
      c.progress = 0;
      c.combatTimer = (c.combatTimer ?? COMBAT_DURATION_MS) - dtMs * speed;

      // Spark only from one side of the pair to avoid duplicates.
      const opp = all.find((x) => x.id === c.combatOpponentId);
      if (opp && c.id < opp.id) {
        const midX = ((c.col + opp.col) / 2 + 0.5) * ts;
        const midY = ((c.row + opp.row) / 2 + 0.5) * ts;
        for (let i = 0; i < SPARKS_PER_FRAME; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 0.04 + Math.random() * 0.06; // px/ms
          this.sparks.push({
            kind: "spark",
            x: midX,
            y: midY,
            vx: Math.cos(a) * sp * ts,
            vy: Math.sin(a) * sp * ts - 0.02 * ts,
            life: SPARK_LIFE_MS,
            maxLife: SPARK_LIFE_MS,
          });
        }
      }

      if ((c.combatTimer ?? 0) <= 0) {
        this.resolveCombat(c, opp);
      }
    }
  }

  private startCombat(a: Citizen, b: Citizen) {
    // Phase 9: Coward Guards (or any Coward) may break and flee at the
    // moment of engagement — 30% chance per spec. Cowards still record
    // a grudge against the would-be attacker.
    for (const [self, opp] of [[a, b], [b, a]] as const) {
      if (self.trait === "Coward" && Math.random() < 0.3) {
        this.makeFlee(self, opp);
        addChronicle(
          this.state,
          `${self.name} loses nerve and flees from ${opp.name}.`
        );
        // The fleeing party still witnesses the assault, and bystanders too.
        recordCombatWitnesses(opp, self, this.state.citizens);
        return;
      }
    }
    a.state = "COMBAT";
    b.state = "COMBAT";
    a.combatTimer = COMBAT_DURATION_MS;
    b.combatTimer = COMBAT_DURATION_MS;
    a.combatOpponentId = b.id;
    b.combatOpponentId = a.id;
    addChronicle(this.state, `${a.name} (rebel) clashes with ${b.name} (royalist)!`);
    // Phase 9: combatants + nearby witnesses (radius 5) all log a grudge.
    recordCombatWitnesses(a, b, this.state.citizens);
  }

  /**
   * Phase 9: Push a Coward away from their attacker. We pick a target tile
   * 6 tiles in the opposite direction, clamped to the grid, and use the
   * existing pathfinder. If no path is reachable, the NPC just stops in
   * place — better than locking them into combat they wanted to avoid.
   */
  private makeFlee(self: Citizen, opp: Citizen) {
    const grid = this.state.grid;
    const dr = self.row - opp.row;
    const dc = self.col - opp.col;
    const stepR = dr === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dr);
    const stepC = dc === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dc);
    const targetRow = Math.max(0, Math.min(grid.rows - 1, self.row + stepR * 6));
    const targetCol = Math.max(0, Math.min(grid.cols - 1, self.col + stepC * 6));
    const path = findPath(grid, self.row, self.col, targetRow, targetCol);
    self.state = "FLEEING";
    if (path && path.length > 0) {
      self.path = path;
      self.pathIndex = 0;
      self.progress = 0;
      self.targetTile = { row: targetRow, col: targetCol };
    } else {
      self.path = [];
      self.pathIndex = 0;
      self.progress = 0;
    }
    self.combatTimer = undefined;
    self.combatOpponentId = undefined;
  }

  private resolveCombat(a: Citizen, b: Citizen | undefined) {
    // Roll a winner. Rebels lean on vanity (mercenary gold), Royalists on safety.
    const aScore = (a.faction === "rebel" ? a.vanity : a.safety) + Math.random() * 30;
    const bScore = b
      ? (b.faction === "rebel" ? b.vanity : b.safety) + Math.random() * 30
      : 0;
    const loser = !b ? a : aScore >= bScore ? b : a;
    const winner = loser === a ? b : a;

    loser.state = "DEAD";
    loser.path = [];
    loser.pathIndex = 0;
    loser.progress = 0;
    loser.targetTile = undefined;
    loser.targetBuildingId = undefined;
    loser.combatTimer = undefined;
    loser.combatOpponentId = undefined;
    addChronicle(
      this.state,
      `${loser.name} falls in the streets${winner ? `, slain by ${winner.name}` : ""}.`
    );
    notifyDeath(this.state, loser);

    if (winner) {
      winner.state = "IDLE";
      winner.combatTimer = undefined;
      winner.combatOpponentId = undefined;
    }
  }

  private tickSparks(dtMs: number) {
    if (this.sparks.length === 0) return;
    // Particles always advance (so divine FX play even while paused), but
    // slower when the game is frozen so they look ambient instead of frozen.
    const speed = this.state.time.timeScale === 0 ? 0.4 : this.state.time.timeScale;
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dtMs;
      if (s.life <= 0) {
        this.sparks.splice(i, 1);
        continue;
      }
      s.x += s.vx * dtMs * speed;
      s.y += s.vy * dtMs * speed;
      // Smoke rises and drifts; everything else falls a tiny bit.
      if (s.kind === "smoke") {
        s.vy *= 0.992;
      } else if (s.kind !== "lightning") {
        s.vy += 0.0001 * dtMs * speed;
      }
    }
  }

  private renderSparks() {
    if (this.sparks.length === 0) return;
    const ctx = this.ctx;
    const ts = this.state.grid.tileSize;
    for (const s of this.sparks) {
      const a = Math.max(0, s.life / s.maxLife);

      if (s.kind === "lightning" && s.bolt && s.bolt.length > 1) {
        // Bright additive bolt with a wide afterglow.
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        // Outer glow
        ctx.strokeStyle = `rgba(180, 220, 255, ${0.35 * a})`;
        ctx.lineWidth = ts * 0.18;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(s.bolt[0].x, s.bolt[0].y);
        for (let i = 1; i < s.bolt.length; i++) ctx.lineTo(s.bolt[i].x, s.bolt[i].y);
        ctx.stroke();
        // Hot core
        ctx.strokeStyle = `rgba(255, 255, 255, ${a})`;
        ctx.lineWidth = Math.max(1.5, ts * 0.06);
        ctx.beginPath();
        ctx.moveTo(s.bolt[0].x, s.bolt[0].y);
        for (let i = 1; i < s.bolt.length; i++) ctx.lineTo(s.bolt[i].x, s.bolt[i].y);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (s.kind === "fire") {
        const r = (s.size ?? ts * 0.3) * (0.4 + 0.6 * a);
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const grd = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
        grd.addColorStop(0, `rgba(255, 240, 180, ${a})`);
        grd.addColorStop(0.4, `rgba(255, 130, 40, ${a * 0.85})`);
        grd.addColorStop(1, `rgba(120, 20, 0, 0)`);
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      if (s.kind === "smoke") {
        const r = (s.size ?? ts * 0.5) * (0.6 + 0.6 * (1 - a));
        ctx.fillStyle = `rgba(60, 60, 60, ${0.35 * a})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      if (s.kind === "bless") {
        const r = ts * 0.08 * a + 1;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = `rgba(255, 220, 100, ${a})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      // Default "spark": warm ember
      const r = ts * 0.05 * a + 0.5;
      ctx.fillStyle = `rgba(255, ${180 + Math.floor(60 * a)}, 80, ${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  public setTimeScale(scale: 0 | 1 | 2) {
    this.state.time.timeScale = scale;
  }

  public getTimeScale(): 0 | 1 | 2 {
    return this.state.time.timeScale;
  }

  /**
   * Phase 4/5: Convert a screen-space tap to world-space, then dispatch:
   *  - When a divine power is active → cast it on the tapped target/tile.
   *  - When no power is active → fall back to the Inner Monologue inspector.
   */
  private handleTap(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const cam = this.state.camera;
    const grid = this.state.grid;
    const ts = grid.tileSize;
    // Screen → iso world pixel
    const wx = (clientX - rect.left) / cam.zoom + cam.x;
    const wy = (clientY - rect.top) / cam.zoom + cam.y;
    // Phase 13: invert the iso projection to recover the (col, row) tile
    // under the cursor. CRITICAL: integer (col, row) values map to tile
    // CENTERS in iso (not NW-corners like in top-down), so the diamond
    // for tile (col0, row0) spans col ∈ [col0-0.5, col0+0.5] and row ∈
    // [row0-0.5, row0+0.5]. We therefore round-to-nearest, NOT floor —
    // flooring would bias every click into the NW-adjacent tile (off by
    // one for the top half + left half of every diamond).
    const { col, row } = isoToWorld(wx, wy, ts, grid.rows);
    const tileR = Math.round(row);
    const tileC = Math.round(col);

    // Find the closest tap-tolerant citizen (mobile-friendly hitbox). The
    // hitbox check is in iso pixel space — project each citizen to its iso
    // diamond center and measure screen-space distance.
    const tileTol = ts * 0.7;
    const screenMinTol = 24 / cam.zoom;
    const tol = Math.max(tileTol, screenMinTol);
    let citizenHit: Citizen | null = null;
    let bestDist = tol;
    for (const c of this.state.citizens) {
      if (c.state === "DEAD") continue;
      const pos = getCitizenVisualPos(c);
      const { sx, sy } = worldToIso(pos.col, pos.row, ts, grid.rows);
      const d = Math.hypot(wx - sx, wy - sy);
      if (d < bestDist) {
        bestDist = d;
        citizenHit = c;
      }
    }

    // Phase 5: divine dispatch — power/brush takes precedence over monologue.
    if (this.currentPower !== "none") {
      this.castDivine(tileR, tileC, citizenHit);
      return;
    }

    // Default: Inner Monologue (Phase 4)
    if (citizenHit && this.callbacks.onCitizenTap) {
      this.callbacks.onCitizenTap({
        citizen: citizenHit,
        screenX: clientX - rect.left,
        screenY: clientY - rect.top,
      });
    }
  }

  /* -------------------------------------------------------------------- */
  /*  Phase 5: Divine Powers — public control surface                     */
  /* -------------------------------------------------------------------- */

  public setPower(power: DivinePower, brush: DivineBrush = "none") {
    this.currentPower = power;
    this.currentBrush = brush;
  }
  public clearPower() {
    this.currentPower = "none";
    this.currentBrush = "none";
  }
  public getPower(): { power: DivinePower; brush: DivineBrush } {
    return { power: this.currentPower, brush: this.currentBrush };
  }
  public toggleFreezeTime() {
    this.setTimeScale(this.state.time.timeScale === 0 ? 1 : 0);
  }
  public toggleWinter() {
    this.state.winterActive = !this.state.winterActive;
    addChronicle(
      this.state,
      this.state.winterActive
        ? "A divine winter falls upon the land. The crops wither."
        : "The winter lifts. Spring returns to the fields."
    );
  }
  public isWinter(): boolean { return this.state.winterActive; }

  private brushToTile(brush: DivineBrush): TileType | null {
    switch (brush) {
      case "paint_grass":    return "grass";
      case "paint_water":    return "water";
      case "paint_forest":   return "forest";
      case "paint_mountain": return "mountain";
      default: return null;
    }
  }

  /**
   * Apply the selected power to the tapped tile / NPC. Each branch encapsulates
   * its own state mutation, particle effects, and chronicle entry.
   */
  private castDivine(row: number, col: number, citizen: Citizen | null) {
    const grid = this.state.grid;
    if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) return;
    const ts = grid.tileSize;

    if (this.currentPower === "architect") {
      const newType = this.brushToTile(this.currentBrush);
      if (!newType) return;
      this.terraformTile(row, col, newType);
      return;
    }

    if (this.currentPower === "judge") {
      if (this.currentBrush === "smite") {
        if (citizen) {
          this.smiteCitizen(citizen);
        } else {
          // Building target — find a building on this tile and rubble it.
          const b = this.state.buildings.find(
            (b) => b.row === row && b.col === col && b.status !== "rubble"
          );
          if (b) this.smiteBuilding(b, row, col);
          else {
            const iso = worldToIso(col, row, ts, this.state.grid.rows);
            this.spawnLightning(iso.sx, iso.sy);
          }
        }
      } else if (this.currentBrush === "bless") {
        if (citizen) this.blessCitizen(citizen);
      }
      return;
    }

    if (this.currentPower === "wrath" && this.currentBrush === "meteor") {
      this.castMeteor(row, col);
      return;
    }
  }

  /** Architect: paint one tile, scrub paths that intersected it. */
  private terraformTile(row: number, col: number, newType: TileType) {
    const tile = this.state.grid.tiles[row][col];
    if (tile.type === newType) return;
    tile.type = newType;
    if (newType === "grass") tile.fertility = 0.8;
    else tile.fertility = 0;
    this.invalidatePathsThrough([{ row, col }]);
    this.desirability.markDirty();
    // Phase 10.5: incrementally patch the terrain layer cache so the user
    // sees the result immediately without paying for a full rebuild.
    this.redrawTerrainTile(row, col);
  }

  /** Judge / Smite: lightning kills an NPC outright. */
  private smiteCitizen(c: Citizen) {
    if (c.state === "DEAD") return;
    const grid = this.state.grid;
    const ts = grid.tileSize;
    const pos = getCitizenVisualPos(c);
    // Phase 13: strike at the iso-projected position so the bolt lands on
    // the visible NPC, not at the top-down rect center.
    const iso = worldToIso(pos.col, pos.row, ts, grid.rows);
    this.spawnLightning(iso.sx, iso.sy);
    // Phase 20: SoundManager hook + propagate PANIC to nearby witnesses.
    sound.onSmite({ x: iso.sx, y: iso.sy, victim: c.name });
    this.propagatePanic(pos.row, pos.col, c.id);
    c.state = "DEAD";
    c.path = []; c.pathIndex = 0; c.progress = 0;
    c.targetTile = undefined; c.targetBuildingId = undefined;
    c.combatTimer = undefined; c.combatOpponentId = undefined;
    addChronicle(this.state, `${c.name} is struck down by divine lightning.`);
    notifyDeath(this.state, c);
    // Phase 17: Scorch the ground where the smite hit — spec calls for
    // the target tile to flip to a "scorched_earth" texture. We reuse
    // the existing `crater` tile (same one used by meteor) since it
    // already has the burnt-black palette and matching speckle/border
    // colors. Water tiles are immune (bolt evaporates harmlessly).
    const tr = Math.floor(pos.row);
    const tc = Math.floor(pos.col);
    const tile = grid.tiles[tr]?.[tc];
    if (tile && tile.type !== "water" && tile.type !== "crater") {
      tile.type = "crater";
      this.redrawTerrainTile(tr, tc);
    }
  }

  /** Judge / Smite on building: lightning + reduce to rubble + scorch tile. */
  private smiteBuilding(b: Building, row: number, col: number) {
    const grid = this.state.grid;
    const ts = grid.tileSize;
    const iso = worldToIso(col, row, ts, grid.rows);
    this.spawnLightning(iso.sx, iso.sy);
    // Phase 20: SoundManager hook + propagate PANIC to nearby witnesses.
    sound.onSmite({ x: iso.sx, y: iso.sy, victim: b.typeId });
    this.propagatePanic(row, col);
    b.status = "rubble";
    addChronicle(this.state, `A divine bolt reduces a building to rubble.`);
    this.desirability.markDirty();
    // Phase 17: Scorch the building's tile too (same crater texture).
    const tile = grid.tiles[row]?.[col];
    if (tile && tile.type !== "water" && tile.type !== "crater") {
      tile.type = "crater";
      this.redrawTerrainTile(row, col);
    }
  }

  /**
   * Phase 20: propagate PANIC to NPCs within `radius` tiles of (row, col)
   * after a divine smite. Witnesses stop in place, drop into the existing
   * FLEEING state with a real flee path AWAY from the strike, and pick up
   * a 6-second `panicUntilMs` window that the UI / thought library reads
   * as "Panicking".
   *
   * IMPORTANT: timers use `Date.now()` (wall-clock ms) to match the read
   * side in `thoughts.ts` (`buildThought` / `actionLabel` both read
   * `Date.now()`). Using `state.time.totalRealMs` here would write tiny
   * sim-time values that always read as "expired" against wall-clock.
   *
   * Skip-list: dead, royalty, AND any state that owns transactional fields
   * (COMBAT owns `combatOpponentId`; IMPRISONED owns dungeon link;
   * MENTAL_BREAK / PRAYING are owned narrative beats; STEALING / ARRESTING
   * / HEALING / DRINKING own pairing-with-target / patient-link / tavern
   * leisure-credit). Without this guard a smite next to the apothecary
   * would orphan in-flight treatments for a full game-month tick.
   */
  private propagatePanic(row: number, col: number, excludeId?: string, radius = 5) {
    const now = Date.now();
    const r2 = radius * radius;
    const grid = this.state.grid;
    let count = 0;
    for (const witness of this.state.citizens) {
      if (witness.id === excludeId) continue;
      if (witness.state === "DEAD") continue;
      if (witness.isKing || witness.isQueen || witness.isPrince || witness.isDowagerQueen) continue;
      const dr = witness.row - row;
      const dc = witness.col - col;
      if (dr * dr + dc * dc > r2) continue;
      // Tag the reactive timer (read by the thought library + UI).
      witness.panicUntilMs = now + 6000;
      witness.admireUntilMs = undefined;
      // Reuse the existing FLEEING state so the renderer + AI tick treat
      // them as already-fleeing NPCs (animation, no new branch needed).
      // Skip if already locked in a heavier / transactional state — those
      // own resources (combat opponent, prisoner link, patient link,
      // tavern leisure credit) that would orphan if we clobbered state.
      if (
        witness.state !== "COMBAT" &&
        witness.state !== "IMPRISONED" &&
        witness.state !== "MENTAL_BREAK" &&
        witness.state !== "PRAYING" &&
        witness.state !== "STEALING" &&
        witness.state !== "ARRESTING" &&
        witness.state !== "HEALING" &&
        witness.state !== "DRINKING"
      ) {
        witness.state = "FLEEING";
        witness.progress = 0;
        witness.targetBuildingId = undefined;
        // Compute an actual flee path AWAY from the strike — same approach
        // as `traumatizeAdjacent` in npc.ts. Without a real path, the NPC
        // would just sit in FLEEING for 6s and look broken.
        const fleeVecCol = witness.col - col; // points away from strike
        const fleeVecRow = witness.row - row;
        const vc = fleeVecCol === 0 && fleeVecRow === 0
          ? (Math.random() < 0.5 ? -1 : 1)
          : fleeVecCol;
        const vr = fleeVecCol === 0 && fleeVecRow === 0
          ? (Math.random() < 0.5 ? -1 : 1)
          : fleeVecRow;
        const mag = Math.max(1, Math.abs(vc) + Math.abs(vr));
        let assigned = false;
        for (const r of [6, 4, 3, 2]) {
          const goalCol = Math.max(0, Math.min(grid.cols - 1,
            Math.round(witness.col + (vc / mag) * r)));
          const goalRow = Math.max(0, Math.min(grid.rows - 1,
            Math.round(witness.row + (vr / mag) * r)));
          if (!isWalkable(grid, goalRow, goalCol)) continue;
          const path = findPath(grid, witness.row, witness.col, goalRow, goalCol);
          if (path && path.length > 0) {
            witness.path = path;
            witness.pathIndex = 0;
            witness.targetTile = { row: goalRow, col: goalCol };
            assigned = true;
            break;
          }
        }
        if (!assigned) {
          witness.path = [];
          witness.pathIndex = 0;
          witness.targetTile = undefined;
        }
      }
      count++;
    }
    if (count > 0) {
      addChronicle(this.state, `${count} citizen${count === 1 ? "" : "s"} witnessed the divine wrath and fled in panic.`);
    }
  }

  /**
   * Phase 20: propagate ADMIRE to NPCs within `radius` tiles of a bless
   * impact. Witnesses pause briefly, look up at the light, and the
   * thought library shows them saying "The Heavens are watching us."
   * No state change — they keep doing what they were doing, the timer
   * just tints the UI label and the thought line for ~5 seconds.
   *
   * Same wall-clock (`Date.now()`) timer base as `propagatePanic`.
   */
  private propagateAdmire(row: number, col: number, excludeId?: string, radius = 5) {
    const now = Date.now();
    const r2 = radius * radius;
    let count = 0;
    for (const witness of this.state.citizens) {
      if (witness.id === excludeId) continue;
      if (witness.state === "DEAD") continue;
      const dr = witness.row - row;
      const dc = witness.col - col;
      if (dr * dr + dc * dc > r2) continue;
      // Don't override an active panic — wrath beats awe.
      if (typeof witness.panicUntilMs === "number" && witness.panicUntilMs > now) continue;
      witness.admireUntilMs = now + 5000;
      count++;
    }
    if (count > 0) {
      addChronicle(this.state, `${count} citizen${count === 1 ? "" : "s"} stopped to admire the divine light.`);
    }
  }

  /** Judge / Bless: a vanity spike that flips the NPC firmly Royalist. */
  private blessCitizen(c: Citizen) {
    if (c.state === "DEAD") return;
    const grid = this.state.grid;
    const ts = grid.tileSize;
    const pos = getCitizenVisualPos(c);
    // Phase 13: emit sparks from the iso-projected NPC body center (sy is
    // the foot anchor; subtract ts*0.3 to land at chest height).
    const iso = worldToIso(pos.col, pos.row, ts, grid.rows);
    const sparkX = iso.sx;
    const sparkY = iso.sy - ts * 0.3;
    c.vanity = 100;
    c.faction = "royalist";
    c.isRebel = false;
    if (c.socialTier === "peasant") c.socialTier = "noble";
    // Phase 20: bless SFX hook + propagate ADMIRE to nearby witnesses.
    sound.onBless({ name: c.name });
    this.propagateAdmire(pos.row, pos.col, c.id);
    addChronicle(this.state, `${c.name} is touched by divine favor — blessed with riches.`);
    // Phase 17: Golden bless particles — 12 motes that float UP and
    // fade out over a full 2 seconds (was 18 motes / 700ms). Slower,
    // longer-lasting drift reads as a sustained holy aura rather than
    // a quick puff.
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.02 + Math.random() * 0.04;
      this.sparks.push({
        kind: "bless",
        x: sparkX + (Math.random() - 0.5) * ts * 0.4,
        y: sparkY,
        vx: Math.cos(a) * sp * ts,
        // Strong upward bias — particles rise, not radiate
        vy: -Math.abs(Math.sin(a) * sp * ts) - 0.025 * ts,
        life: 2000,
        maxLife: 2000,
      });
    }
    // Phase 16: Divine light shaft — a vertical golden gradient pillar that
    // descends from the heavens onto the blessed NPC. Decoupled from the
    // sparks list because it draws as a single gradient quad each frame
    // rather than a particle (much cheaper than 60+ extra sparks). Lasts
    // 900ms with an ease-out fade.
    const shaftNow = this.state.time.totalRealMs;
    this.lightShafts.push({
      x: iso.sx,
      y: iso.sy,
      born: shaftNow,
      until: shaftNow + 900,
    });
  }

  /** Wrath / Meteor: 3x3 fire + crater + obliterate buildings & NPCs. */
  private castMeteor(row: number, col: number) {
    const grid = this.state.grid;
    const ts = grid.tileSize;
    const changed: { row: number; col: number }[] = [];
    for (let dr = -METEOR_RADIUS; dr <= METEOR_RADIUS; dr++) {
      for (let dc = -METEOR_RADIUS; dc <= METEOR_RADIUS; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= grid.rows || c < 0 || c >= grid.cols) continue;
        // Burn the terrain
        const tile = grid.tiles[r][c];
        if (tile.type !== "water") {
          tile.type = "crater";
          tile.fertility = 0;
          // Phase 10.5: keep the static terrain layer in sync — meteor
          // bypasses terraformTile(), so patch the cache directly.
          this.redrawTerrainTile(r, c);
        }
        changed.push({ row: r, col: c });
      }
    }
    // Kill citizens caught in the blast
    for (const c of this.state.citizens) {
      if (c.state === "DEAD") continue;
      if (Math.abs(c.row - row) <= METEOR_RADIUS && Math.abs(c.col - col) <= METEOR_RADIUS) {
        c.state = "DEAD";
        c.path = []; c.pathIndex = 0; c.progress = 0;
        c.targetTile = undefined; c.targetBuildingId = undefined;
        addChronicle(this.state, `${c.name} is consumed by divine fire.`);
        notifyDeath(this.state, c);
      }
    }
    // Reduce buildings in the blast to rubble
    for (const b of this.state.buildings) {
      if (b.status === "rubble") continue;
      if (Math.abs(b.row - row) <= METEOR_RADIUS && Math.abs(b.col - col) <= METEOR_RADIUS) {
        b.status = "rubble";
      }
    }
    // VFX: large fireburst + smoke at the impact center (iso-projected)
    const isoImpact = worldToIso(col, row, ts, grid.rows);
    this.spawnFireburst(isoImpact.sx, isoImpact.sy);
    addChronicle(this.state, `A meteor strikes the realm — the earth itself is scarred.`);
    this.invalidatePathsThrough(changed);
    this.desirability.markDirty();
  }

  /**
   * Force any NPC currently traveling through one of the changed tiles
   * (or whose destination was on one) to drop their path. Their normal
   * brain tick will pick a fresh target and replan next month.
   */
  private invalidatePathsThrough(tiles: { row: number; col: number }[]) {
    if (tiles.length === 0) return;
    const set = new Set(tiles.map((t) => `${t.row},${t.col}`));
    for (const c of this.state.citizens) {
      if (c.state === "DEAD" || c.state === "SLEEPING") continue;
      let hits = false;
      if (c.targetTile && set.has(`${c.targetTile.row},${c.targetTile.col}`)) hits = true;
      if (!hits) {
        for (const step of c.path) {
          if (set.has(`${step.row},${step.col}`)) { hits = true; break; }
        }
      }
      if (hits) {
        c.path = [];
        c.pathIndex = 0;
        c.progress = 0;
        c.targetTile = undefined;
        c.targetBuildingId = undefined;
      }
    }
  }

  /* ────────────────────────────────────────────────────────────────────
   *  Phase 16: Living World terrain + fauna helpers
   * ──────────────────────────────────────────────────────────────────── */

  /**
   * Phase 16: Bake a stylised cliff face onto a mountain tile. Called
   * once per mountain tile during rebuildTerrainLayer (so zero per-frame
   * cost). The canvas is already translated to the tile's iso center
   * with the diamond clipped — we paint inside the diamond only.
   *
   * Cliff face = darker triangle along the south half of the diamond
   * (between the tile center, right vertex, and bottom vertex), plus
   * a couple of crack lines for stone texture. Rendered with a fixed
   * deterministic seed so the same tile always looks the same.
   */
  private drawMountainCliff(g: CanvasRenderingContext2D, ts: number, row: number, col: number) {
    let s = ((row * 374761393) ^ (col * 668265263)) >>> 0;
    const rand = () => {
      s = (s + 0x9E3779B9) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 16), 0x85EBCA6B);
      t = Math.imul(t ^ (t >>> 13), 0xC2B2AE35);
      return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
    };
    g.save();
    // Clip to the tile diamond so the cliff geometry never spills onto
    // adjacent tiles when the terrain layer is blitted.
    g.beginPath();
    g.moveTo(0, -ts / 4);
    g.lineTo(ts / 2, 0);
    g.lineTo(0, ts / 4);
    g.lineTo(-ts / 2, 0);
    g.closePath();
    g.clip();

    // Dark south-facing cliff face — covers the lower half of the diamond
    // with a vertical stone gradient.
    const grad = g.createLinearGradient(0, -ts * 0.05, 0, ts * 0.25);
    grad.addColorStop(0, "rgba(60, 65, 75, 0.45)");
    grad.addColorStop(1, "rgba(30, 32, 40, 0.65)");
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-ts / 2, 0);
    g.lineTo(ts / 2, 0);
    g.lineTo(0, ts / 4);
    g.closePath();
    g.fill();

    // Two or three crack lines for stone detail
    g.strokeStyle = "rgba(20, 22, 28, 0.55)";
    g.lineWidth = 1;
    const crackCount = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < crackCount; i++) {
      const startX = (rand() - 0.5) * ts * 0.6;
      const startY = rand() * ts * 0.18 + ts * 0.02;
      g.beginPath();
      g.moveTo(startX, startY);
      let cx = startX;
      let cy = startY;
      const segs = 2 + Math.floor(rand() * 2);
      for (let k = 0; k < segs; k++) {
        cx += (rand() - 0.5) * ts * 0.18;
        cy += rand() * ts * 0.05;
        g.lineTo(cx, cy);
      }
      g.stroke();
    }

    // A small bright highlight along the top ridge for "sun-hit" stone.
    g.strokeStyle = "rgba(190, 195, 205, 0.45)";
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-ts * 0.35, -ts * 0.04);
    g.lineTo(0, -ts * 0.18);
    g.lineTo(ts * 0.35, -ts * 0.04);
    g.stroke();

    g.restore();
  }

  /**
   * Phase 16: Bake a foam edge onto a water tile along any side that
   * abuts a non-water neighbor. Called once per water tile during
   * rebuildTerrainLayer (zero per-frame cost). Uses 4-connected check
   * (N, E, S, W) — diagonal neighbors are intentionally ignored to
   * avoid double-painting at corners.
   *
   * Important: in iso projection the diamond's "north" (top vertex)
   * is the (row-1) neighbor, NOT the visual N direction on screen.
   * So foam-along-NE-edge maps to the (row-1) neighbor.
   */
  /**
   * Phase 17: True 3D extruded cliff face — drawn in a SECOND pass after
   * every tile fill in `rebuildTerrainLayer`. The extrusion extends
   * DOWNWARD from the diamond's south vertex by ~0.4 tiles, painting a
   * parallelogram on top of any non-mountain neighbor below the cliff.
   * The result reads as genuine vertical depth: mountains drop into
   * valleys instead of sitting flush with neighboring grass tiles.
   *
   * Geometry (translated to the tile's iso center sx, sy):
   *   diamond south vertex     S = (0, ts/4)
   *   diamond east vertex      E = (ts/2, 0)
   *   diamond west vertex      W = (-ts/2, 0)
   *   extrusion base south     B = (0, ts/4 + D)
   *   extrusion base east      Be = (ts/2, D)
   *   extrusion base west      Bw = (-ts/2, D)
   * SE face = E → S → B → Be (sun-facing, lighter)
   * SW face = W → S → B → Bw (shaded, darker)
   *
   * Faces only render when their corresponding "below" neighbor is NOT
   * a mountain — otherwise we'd be painting over another mountain top.
   *   SE face hides if (row, col+1) is mountain (the E-direction tile
   *   is the cliff's downhill neighbor on iso south-east edge).
   *   SW face hides if (row+1, col) is mountain.
   */
  private drawCliffExtrusion(g: CanvasRenderingContext2D, ts: number, grid: GameState["grid"], row: number, col: number) {
    const tiles = grid.tiles;
    const isMountain = (r: number, c: number): boolean => {
      if (r < 0 || r >= grid.rows || c < 0 || c >= grid.cols) return false;
      return tiles[r][c].type === "mountain";
    };
    const seNeighborMtn = isMountain(row, col + 1);
    const swNeighborMtn = isMountain(row + 1, col);
    // Phase 17 architect-flagged correctness fix: even when both cardinal
    // SE/SW neighbors are non-mountain, the extrusion's south-vertex tip
    // can still dip into the DIAGONAL (r+1, c+1) tile's diamond. If that
    // diagonal tile is itself a mountain peak, the tip would overpaint
    // a valid mountain top — visible corruption in sparse-mountain maps.
    // We clip the diagonal peak's diamond out of the extrusion paint zone.
    const diagMtn = isMountain(row + 1, col + 1);
    if (seNeighborMtn && swNeighborMtn) return; // Fully interior peak — no exposed cliff.

    const D = ts * 0.40; // Cliff height (vertical extrusion depth in iso px).
    const { sx, sy } = worldToIso(col, row, ts, grid.rows);

    g.save();
    g.translate(sx, sy);

    // Diagonal-mountain protection: clip OUTSIDE the (r+1, c+1) diamond
    // using an even-odd path (outer rect + inner diamond). All subsequent
    // fills/strokes will skip the diagonal peak's footprint.
    if (diagMtn) {
      g.beginPath();
      // Outer bounding rect — generous so it covers the entire extrusion zone
      g.rect(-ts, -ts * 0.5, ts * 2, ts * 2);
      // Inner: (r+1, c+1) diamond in this tile's local coords
      // Its iso center is offset by (0, ts/2) from us; vertices are:
      //   top (0, ts/4), right (ts/2, ts/2), bottom (0, 3ts/4), left (-ts/2, ts/2)
      g.moveTo(0, ts / 4);
      g.lineTo(ts / 2, ts / 2);
      g.lineTo(0, ts * 0.75);
      g.lineTo(-ts / 2, ts / 2);
      g.closePath();
      g.clip("evenodd");
    }

    // ── SE face (sun-hit, lighter) ─────────────────────────────────────
    if (!seNeighborMtn) {
      const seGrad = g.createLinearGradient(0, 0, 0, ts / 4 + D);
      seGrad.addColorStop(0, "#7a8290"); // top — slightly bright stone
      seGrad.addColorStop(0.5, "#5b626d");
      seGrad.addColorStop(1, "#363a42"); // base — deep shadow at the foot
      g.fillStyle = seGrad;
      g.beginPath();
      g.moveTo(ts / 2, 0);              // E vertex
      g.lineTo(0, ts / 4);              // S vertex
      g.lineTo(0, ts / 4 + D);          // S vertex extruded down
      g.lineTo(ts / 2, D);              // E vertex extruded down
      g.closePath();
      g.fill();
      // Stratification — 2 horizontal stone bands give the face texture
      g.strokeStyle = "rgba(20, 22, 28, 0.45)";
      g.lineWidth = 0.8;
      for (let i = 1; i <= 2; i++) {
        const ty = (D * i) / 3;
        g.beginPath();
        // Band runs from the SE diagonal back toward the south vertex
        // at constant extrusion depth `ty`.
        const xRight = ts / 2 - (ts / 2) * (ty / D) * 0.0; // right vertex stays at x=ts/2 (vertical extrusion)
        const xLeft = 0;
        g.moveTo(xLeft, ts / 4 + ty);
        g.lineTo(xRight, ty);
        g.stroke();
      }
      // Bright top edge for the cliff lip
      g.strokeStyle = "rgba(180, 188, 200, 0.55)";
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(ts / 2, 0);
      g.lineTo(0, ts / 4);
      g.stroke();
    }

    // ── SW face (shaded, darker) ───────────────────────────────────────
    if (!swNeighborMtn) {
      const swGrad = g.createLinearGradient(0, 0, 0, ts / 4 + D);
      swGrad.addColorStop(0, "#5d6470"); // top — dimmer than SE face
      swGrad.addColorStop(0.5, "#404650");
      swGrad.addColorStop(1, "#22252b"); // base — near-black foot
      g.fillStyle = swGrad;
      g.beginPath();
      g.moveTo(-ts / 2, 0);             // W vertex
      g.lineTo(0, ts / 4);              // S vertex
      g.lineTo(0, ts / 4 + D);          // S vertex extruded down
      g.lineTo(-ts / 2, D);             // W vertex extruded down
      g.closePath();
      g.fill();
      // Stratification bands
      g.strokeStyle = "rgba(15, 17, 22, 0.55)";
      g.lineWidth = 0.8;
      for (let i = 1; i <= 2; i++) {
        const ty = (D * i) / 3;
        g.beginPath();
        g.moveTo(-ts / 2, ty);
        g.lineTo(0, ts / 4 + ty);
        g.stroke();
      }
      // Dim top edge (shaded side gets only a faint lip highlight)
      g.strokeStyle = "rgba(140, 148, 160, 0.35)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-ts / 2, 0);
      g.lineTo(0, ts / 4);
      g.stroke();
    }

    // South-vertex seam between the two faces — single dark line for
    // a crisp ridge silhouette down the middle of the cliff face.
    if (!seNeighborMtn || !swNeighborMtn) {
      g.strokeStyle = "rgba(10, 12, 16, 0.65)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, ts / 4);
      g.lineTo(0, ts / 4 + D);
      g.stroke();
    }

    g.restore();
  }

  private drawWaterFoam(g: CanvasRenderingContext2D, ts: number, grid: GameState["grid"], row: number, col: number) {
    const tiles = grid.tiles;
    const isLand = (r: number, c: number): boolean => {
      if (r < 0 || r >= grid.rows || c < 0 || c >= grid.cols) return false;
      return tiles[r][c].type !== "water";
    };
    // Diamond vertices in tile-local coords: top(0,-ts/4), right(ts/2,0),
    // bottom(0,ts/4), left(-ts/2,0). Each diamond EDGE corresponds to a
    // tile NEIGHBOR via iso projection:
    //   top-right edge (top → right):   neighbor at (row-1, col)  [N tile]
    //   bottom-right edge (right → bot): neighbor at (row, col+1) [E tile]
    //   bottom-left edge (bot → left):   neighbor at (row+1, col) [S tile]
    //   top-left edge (left → top):      neighbor at (row, col-1) [W tile]
    const edges: Array<{ neighborR: number; neighborC: number; ax: number; ay: number; bx: number; by: number }> = [
      { neighborR: row - 1, neighborC: col, ax: 0, ay: -ts / 4, bx: ts / 2, by: 0 },
      { neighborR: row, neighborC: col + 1, ax: ts / 2, ay: 0, bx: 0, by: ts / 4 },
      { neighborR: row + 1, neighborC: col, ax: 0, ay: ts / 4, bx: -ts / 2, by: 0 },
      { neighborR: row, neighborC: col - 1, ax: -ts / 2, ay: 0, bx: 0, by: -ts / 4 },
    ];
    g.save();
    g.lineCap = "round";
    for (const e of edges) {
      if (!isLand(e.neighborR, e.neighborC)) continue;
      // Inner foam stroke (lighter, thicker)
      g.strokeStyle = "rgba(220, 240, 255, 0.65)";
      g.lineWidth = Math.max(1.5, ts * 0.06);
      g.beginPath();
      g.moveTo(e.ax, e.ay);
      g.lineTo(e.bx, e.by);
      g.stroke();
      // Outer foam stroke (very faint, slightly wider haze)
      g.strokeStyle = "rgba(255, 255, 255, 0.18)";
      g.lineWidth = Math.max(2, ts * 0.10);
      g.beginPath();
      g.moveTo(e.ax, e.ay);
      g.lineTo(e.bx, e.by);
      g.stroke();
    }
    g.restore();
  }

  /**
   * Phase 16: Per-frame animated water surface. Iterates ONLY visible
   * water tiles (camera-bounds culled) and draws 2 sine-offset wave
   * strokes per tile using the global `waterAnimPhase` accumulator.
   *
   * Performance: capped at 96 tile-paints per frame. At zoom 0.5 with
   * a 100×100 grid the visible water count is typically 20-60, so the
   * cap rarely fires. Each tile = 2 short bezier strokes = ~12 ops total.
   * Measured cost on a Chromebook: <0.4ms per frame.
   */
  private drawAnimatedWater(ctx: CanvasRenderingContext2D, ts: number, cam: GameState["camera"]) {
    const grid = this.state.grid;
    const W = this.viewW;
    const H = this.viewH;
    // Camera viewport in world-space px
    const visMinX = cam.x;
    const visMaxX = cam.x + W / cam.zoom;
    const visMinY = cam.y;
    const visMaxY = cam.y + H / cam.zoom;
    // Inverse of worldToIso: walk visible iso bounds → enumerate (row,col)
    // Cheap conservative bounding box: just iterate every tile and reject
    // by iso bounds. 10000 tiles * 2 ops = 20k ops, negligible.
    const phase = this.waterAnimPhase;
    let drawn = 0;
    const CAP = 96;
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let r = 0; r < grid.rows && drawn < CAP; r++) {
      for (let c = 0; c < grid.cols && drawn < CAP; c++) {
        const tile = grid.tiles[r][c];
        if (tile.type !== "water") continue;
        const { sx, sy } = worldToIso(c, r, ts, grid.rows);
        // Cull by iso projection
        if (sx < visMinX - ts || sx > visMaxX + ts) continue;
        if (sy < visMinY - ts || sy > visMaxY + ts) continue;
        // Two short wave strokes, vertically offset, with horizontal
        // sine displacement keyed by tile coords + global phase so
        // adjacent tiles ripple out of sync (organic look).
        const localPhase1 = phase + (r * 0.7 + c * 0.3);
        const localPhase2 = phase * 1.3 + (r * 0.4 + c * 0.9) + 1.7;
        const amp = ts * 0.04;
        const yOff1 = -ts * 0.04 + Math.sin(localPhase1) * amp * 0.5;
        const yOff2 = ts * 0.04 + Math.sin(localPhase2) * amp * 0.5;
        // Wave 1
        ctx.moveTo(sx - ts * 0.22, sy + yOff1);
        ctx.quadraticCurveTo(sx, sy + yOff1 - amp, sx + ts * 0.22, sy + yOff1);
        // Wave 2
        ctx.moveTo(sx - ts * 0.18, sy + yOff2);
        ctx.quadraticCurveTo(sx, sy + yOff2 - amp * 0.7, sx + ts * 0.18, sy + yOff2);
        drawn++;
      }
    }
    if (drawn > 0) ctx.stroke();
    ctx.restore();
  }

  /**
   * Phase 17: Per-frame animated coastline foam. Replaces the Phase-16
   * baked foam (which was static) with a 3-frame pulse loop synchronized
   * to `waterAnimPhase` so the foam visibly breathes alongside the
   * sine-wave water surface.
   *
   * Frame selection: `Math.floor(waterAnimPhase / (Math.PI * 2 / 3)) % 3`
   * gives 3 evenly-spaced phase buckets per full sine cycle. Each frame
   * brightens a different one of three foam stroke layers (inner/mid/
   * outer haze), creating a "wash in, wash out" surf effect.
   *
   * Performance: capped at 96 water tiles per frame (same budget as
   * drawAnimatedWater). For each tile we test 4 neighbors and only
   * stroke the ones that abut land — typical case is 1 stroke per
   * coastal tile. Total cost on a Chromebook: <0.3ms per frame.
   */
  private drawAnimatedFoam(ctx: CanvasRenderingContext2D, ts: number, cam: GameState["camera"]) {
    const grid = this.state.grid;
    const tiles = grid.tiles;
    const W = this.viewW;
    const H = this.viewH;
    const visMinX = cam.x - ts;
    const visMaxX = cam.x + W / cam.zoom + ts;
    const visMinY = cam.y - ts;
    const visMaxY = cam.y + H / cam.zoom + ts;

    const isLand = (r: number, c: number): boolean => {
      if (r < 0 || r >= grid.rows || c < 0 || c >= grid.cols) return false;
      return tiles[r][c].type !== "water";
    };

    // Phase 17 architect-flagged perf fix: SINGLE grid scan that collects
    // coastal edges into a flat array, THEN three stroke passes over the
    // collected list. Old impl scanned the 100×100 grid 3× (30k iterations
    // worst case). New impl scans once (10k iterations) + 3 short array
    // walks. Net: ~3× faster on the foam pass alone.
    //
    // CAP=96 is now a global per-frame water-tile budget shared by all
    // three passes (was per-pass). Coastal-edge count per tile is 1-3
    // typically, so total edges per frame ≤ ~250.
    const CAP = 96;
    type Edge = { x1: number; y1: number; x2: number; y2: number };
    const edges: Edge[] = [];
    let scanned = 0;
    for (let r = 0; r < grid.rows && scanned < CAP; r++) {
      for (let c = 0; c < grid.cols && scanned < CAP; c++) {
        if (tiles[r][c].type !== "water") continue;
        const { sx, sy } = worldToIso(c, r, ts, grid.rows);
        if (sx < visMinX || sx > visMaxX) continue;
        if (sy < visMinY || sy > visMaxY) continue;
        // Diamond edges → land neighbors. Edge mapping:
        //   top edge   (top→right): (r-1, c)
        //   right edge (right→bot): (r,   c+1)
        //   bot edge   (bot→left):  (r+1, c)
        //   left edge  (left→top):  (r,   c-1)
        if (isLand(r - 1, c)) edges.push({ x1: sx,        y1: sy - ts / 4, x2: sx + ts / 2, y2: sy });
        if (isLand(r, c + 1)) edges.push({ x1: sx + ts/2, y1: sy,          x2: sx,          y2: sy + ts / 4 });
        if (isLand(r + 1, c)) edges.push({ x1: sx,        y1: sy + ts / 4, x2: sx - ts / 2, y2: sy });
        if (isLand(r, c - 1)) edges.push({ x1: sx - ts/2, y1: sy,          x2: sx,          y2: sy - ts / 4 });
        scanned++;
      }
    }
    if (edges.length === 0) return;

    // 3-frame index from the global water phase. 2π full cycle → 3 buckets.
    const frame = Math.floor(this.waterAnimPhase / ((Math.PI * 2) / 3)) % 3;
    const innerAlpha = frame === 0 ? 0.85 : 0.55;
    const midAlpha   = frame === 1 ? 0.55 : 0.32;
    const outerAlpha = frame === 2 ? 0.32 : 0.16;

    ctx.save();
    ctx.lineCap = "round";
    // Three batched stroke passes over the collected edge array. Each pass
    // is a SINGLE beginPath/stroke for all edges → minimal GPU state churn.
    for (let pass = 0; pass < 3; pass++) {
      let alpha: number;
      let widthMul: number;
      if (pass === 0)      { alpha = outerAlpha; widthMul = 0.13; ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`; }
      else if (pass === 1) { alpha = midAlpha;   widthMul = 0.08; ctx.strokeStyle = `rgba(230, 245, 255, ${alpha})`; }
      else                 { alpha = innerAlpha; widthMul = 0.05; ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`; }
      ctx.lineWidth = Math.max(1, ts * widthMul);
      ctx.beginPath();
      for (const e of edges) {
        ctx.moveTo(e.x1, e.y1);
        ctx.lineTo(e.x2, e.y2);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Phase 16/17: Render a single sheep at iso pixel (sx, sy). 4-direction
   * facing via `dir` (0=N, 1=E, 2=S, 3=W). Phase 17 changes:
   *   - Body width = ts * 0.21 (50% of citizen body width = ts * 0.42),
   *     matching the spec "Sheep must render at 50% the size of an
   *     adult human."
   *   - Grazing now uses a 2-FRAME loop instead of a binary dip:
   *     while `grazingUntilMs > now`, the head alternates between
   *     "down" and "up-slightly" every ~500ms via Math.floor(now/500)%2.
   *     Reads as a real bobbing graze rather than a frozen pose.
   */
  private drawSheep(a: Animal, sx: number, sy: number, ts: number) {
    const ctx = this.ctx;
    // Phase 17: 50% adult-human size. Citizen bodyW = ts * 0.42, so sheep = ts * 0.21.
    const bodyW = ts * 0.21;
    const bodyH = ts * 0.12;
    // Body anchor: foot center is at sy; raise body so legs touch the ground
    const cx = sx;
    const cy = sy - ts * 0.04;
    const nowMs = this.state.time.totalRealMs;
    const isGrazing = nowMs < a.grazingUntilMs;
    // Phase 17: 2-frame graze loop — flips at 2Hz (500ms per frame).
    const grazeFrame = isGrazing ? Math.floor(nowMs / 500) % 2 : 0;
    // Shadow
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
    ctx.beginPath();
    ctx.ellipse(cx, sy + ts * 0.015, bodyW * 0.6, ts * 0.03, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Legs — 4 small dark bars
    ctx.fillStyle = "#2a2a2a";
    const legW = ts * 0.018;
    const legH = ts * 0.055;
    ctx.fillRect(cx - bodyW * 0.55, cy + ts * 0.02, legW, legH);
    ctx.fillRect(cx - bodyW * 0.20, cy + ts * 0.02, legW, legH);
    ctx.fillRect(cx + bodyW * 0.20, cy + ts * 0.02, legW, legH);
    ctx.fillRect(cx + bodyW * 0.55, cy + ts * 0.02, legW, legH);

    // Body — fluffy white oval
    ctx.fillStyle = "#f0eee5";
    ctx.beginPath();
    ctx.ellipse(cx, cy, bodyW * 0.6, bodyH * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    // Wool tufts — 3 small bumps along the top
    ctx.beginPath();
    ctx.arc(cx - bodyW * 0.25, cy - bodyH * 0.45, ts * 0.030, 0, Math.PI * 2);
    ctx.arc(cx, cy - bodyH * 0.55, ts * 0.034, 0, Math.PI * 2);
    ctx.arc(cx + bodyW * 0.25, cy - bodyH * 0.45, ts * 0.030, 0, Math.PI * 2);
    ctx.fill();
    // Body outline
    ctx.strokeStyle = "rgba(60,60,60,0.3)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, bodyW * 0.6, bodyH * 0.6, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Head — dark, position depends on `dir` (4-dir face). The head is
    // offset from body center along the facing direction.
    let hx = cx;
    let hy = cy;
    const headOff = bodyW * 0.55;
    if (a.dir === 0) { hx = cx; hy = cy - bodyH * 0.45; }       // N — head up + back
    else if (a.dir === 1) { hx = cx + headOff; hy = cy - bodyH * 0.05; }  // E
    else if (a.dir === 2) { hx = cx; hy = cy + bodyH * 0.15; }   // S — head forward
    else { hx = cx - headOff; hy = cy - bodyH * 0.05; }          // W
    // Phase 17: 2-frame grazing animation
    //   frame 0: head DOWN (dipping to grass) — strong dip
    //   frame 1: head UP slightly (chewing/lifting) — small lift
    if (isGrazing) {
      hy += grazeFrame === 0 ? ts * 0.045 : -ts * 0.005;
    }
    ctx.fillStyle = "#3a3530";
    ctx.beginPath();
    ctx.arc(hx, hy, ts * 0.045, 0, Math.PI * 2);
    ctx.fill();
    // Tiny eye (white dot) when facing E/W/S so we read the face.
    if (a.dir !== 0) {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      const eyeOffX = a.dir === 1 ? ts * 0.018 : a.dir === 3 ? -ts * 0.018 : 0;
      const eyeOffY = a.dir === 2 ? ts * 0.004 : -ts * 0.010;
      ctx.arc(hx + eyeOffX, hy + eyeOffY, ts * 0.009, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Phase 17: Render a single wolf at iso pixel (sx, sy). Wolves are the
   * predator counterpart to sheep — same 4-direction facing convention,
   * but a darker gray angular silhouette with a pointed snout, perked
   * triangle ears, and a bushy tail. Slightly larger than a sheep
   * (~70% adult-human size) so the size hierarchy reads as
   * "human > wolf > sheep" at a glance.
   *
   * No grazing animation — wolves prowl. They share `tickAnimals`
   * wandering logic with sheep but visually feel more alert.
   */
  private drawWolf(a: Animal, sx: number, sy: number, ts: number) {
    const ctx = this.ctx;
    const bodyW = ts * 0.30;
    const bodyH = ts * 0.13;
    const cx = sx;
    const cy = sy - ts * 0.05;

    // Shadow
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.beginPath();
    ctx.ellipse(cx, sy + ts * 0.02, bodyW * 0.65, ts * 0.035, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Legs — 4 dark bars (slightly thicker than sheep)
    ctx.fillStyle = "#1f1d1c";
    const legW = ts * 0.022;
    const legH = ts * 0.075;
    ctx.fillRect(cx - bodyW * 0.55, cy + ts * 0.02, legW, legH);
    ctx.fillRect(cx - bodyW * 0.20, cy + ts * 0.02, legW, legH);
    ctx.fillRect(cx + bodyW * 0.20, cy + ts * 0.02, legW, legH);
    ctx.fillRect(cx + bodyW * 0.55, cy + ts * 0.02, legW, legH);

    // Body — gray, slimmer than sheep (more elongated)
    const bodyGrad = ctx.createLinearGradient(cx, cy - bodyH * 0.6, cx, cy + bodyH * 0.6);
    bodyGrad.addColorStop(0, "#7a7570");
    bodyGrad.addColorStop(1, "#4a4642");
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, bodyW * 0.62, bodyH * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body outline
    ctx.strokeStyle = "rgba(20, 18, 16, 0.55)";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.ellipse(cx, cy, bodyW * 0.62, bodyH * 0.58, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Head — pointed snout, position depends on `dir` (4-dir face).
    // For E/W/S the snout is a small triangle extending past the head circle.
    let hx = cx;
    let hy = cy;
    const headOff = bodyW * 0.58;
    if (a.dir === 0) { hx = cx; hy = cy - bodyH * 0.50; }       // N
    else if (a.dir === 1) { hx = cx + headOff; hy = cy - bodyH * 0.08; }  // E
    else if (a.dir === 2) { hx = cx; hy = cy + bodyH * 0.20; }   // S
    else { hx = cx - headOff; hy = cy - bodyH * 0.08; }          // W

    // Head circle (dark gray, slightly darker than body)
    ctx.fillStyle = "#3a3633";
    ctx.beginPath();
    ctx.arc(hx, hy, ts * 0.052, 0, Math.PI * 2);
    ctx.fill();

    // Pointed snout — small triangle extending in facing direction
    if (a.dir !== 0) {
      ctx.beginPath();
      if (a.dir === 1) {
        // E: snout points right
        ctx.moveTo(hx + ts * 0.03, hy - ts * 0.018);
        ctx.lineTo(hx + ts * 0.08, hy);
        ctx.lineTo(hx + ts * 0.03, hy + ts * 0.018);
      } else if (a.dir === 2) {
        // S: snout points down/forward
        ctx.moveTo(hx - ts * 0.018, hy + ts * 0.03);
        ctx.lineTo(hx, hy + ts * 0.07);
        ctx.lineTo(hx + ts * 0.018, hy + ts * 0.03);
      } else {
        // W: snout points left
        ctx.moveTo(hx - ts * 0.03, hy - ts * 0.018);
        ctx.lineTo(hx - ts * 0.08, hy);
        ctx.lineTo(hx - ts * 0.03, hy + ts * 0.018);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Perked ears — two small triangles on top of head (always visible
    // to keep the wolf silhouette readable from any facing direction).
    ctx.beginPath();
    ctx.moveTo(hx - ts * 0.030, hy - ts * 0.030);
    ctx.lineTo(hx - ts * 0.020, hy - ts * 0.075);
    ctx.lineTo(hx - ts * 0.005, hy - ts * 0.030);
    ctx.moveTo(hx + ts * 0.005, hy - ts * 0.030);
    ctx.lineTo(hx + ts * 0.020, hy - ts * 0.075);
    ctx.lineTo(hx + ts * 0.030, hy - ts * 0.030);
    ctx.fill();

    // Eye (yellow dot) for E/W/S so wolves read as alert predators
    if (a.dir !== 0) {
      ctx.fillStyle = "#ffd968";
      ctx.beginPath();
      const eyeOffX = a.dir === 1 ? ts * 0.018 : a.dir === 3 ? -ts * 0.018 : 0;
      const eyeOffY = a.dir === 2 ? ts * 0.004 : -ts * 0.012;
      ctx.arc(hx + eyeOffX, hy + eyeOffY, ts * 0.011, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bushy tail — opposite the head direction. Curls up slightly so it
    // pops above the body silhouette.
    ctx.fillStyle = "#4a4642";
    let tx = cx;
    let ty = cy;
    if (a.dir === 0) { tx = cx; ty = cy + bodyH * 0.55; }
    else if (a.dir === 1) { tx = cx - bodyW * 0.55; ty = cy - bodyH * 0.10; }
    else if (a.dir === 2) { tx = cx; ty = cy - bodyH * 0.55; }
    else { tx = cx + bodyW * 0.55; ty = cy - bodyH * 0.10; }
    ctx.beginPath();
    ctx.ellipse(tx, ty, ts * 0.045, ts * 0.022, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Phase 16: Tick fauna AI. Sheep wander on grass tiles (and forest
   * occasionally) by lerping between adjacent tiles. They never use
   * the pathfinder — at each "decision point" they pick one of the 4
   * neighbors that's grass/forest, or stay put and graze.
   *
   * Movement speed slows but does not freeze when timeScale = 0 so a
   * paused world still has subtle ambient motion.
   */
  private tickAnimals(dtMs: number) {
    const animals = this.state.animals;
    if (!animals || animals.length === 0) return;
    const grid = this.state.grid;
    const tiles = grid.tiles;
    const ts = this.state.time.timeScale;
    const speedMul = ts === 0 ? 0.25 : ts;
    // Sheep step duration ~ 1.6s per tile @ 1×, slowed to ~6.4s at 0×.
    const stepProgressPerMs = 0.000625 * speedMul;
    const nowMs = this.state.time.totalRealMs;
    const isGrass = (r: number, c: number) => {
      if (r < 0 || r >= grid.rows || c < 0 || c >= grid.cols) return false;
      const t = tiles[r][c].type;
      return t === "grass" || t === "forest";
    };

    for (const a of animals) {
      // Advance current step
      if (a.row !== a.targetRow || a.col !== a.targetCol) {
        a.progress += dtMs * stepProgressPerMs;
        if (a.progress >= 1) {
          a.row = a.targetRow;
          a.col = a.targetCol;
          a.progress = 0;
          // Settle for a short graze before deciding next move.
          a.grazingUntilMs = nowMs + 800 + Math.random() * 2200;
          a.nextWanderMs = a.grazingUntilMs + 400;
        }
        continue;
      }
      // Idle: maybe pick a new step
      if (nowMs >= a.nextWanderMs) {
        // 50/50: stay put a bit longer (graze) OR pick a random neighbor.
        if (Math.random() < 0.4) {
          a.grazingUntilMs = nowMs + 1500 + Math.random() * 2500;
          a.nextWanderMs = a.grazingUntilMs;
          continue;
        }
        const candidates: Array<{ r: number; c: number; d: 0 | 1 | 2 | 3 }> = [];
        if (isGrass(a.row - 1, a.col)) candidates.push({ r: a.row - 1, c: a.col, d: 0 });
        if (isGrass(a.row, a.col + 1)) candidates.push({ r: a.row, c: a.col + 1, d: 1 });
        if (isGrass(a.row + 1, a.col)) candidates.push({ r: a.row + 1, c: a.col, d: 2 });
        if (isGrass(a.row, a.col - 1)) candidates.push({ r: a.row, c: a.col - 1, d: 3 });
        if (candidates.length === 0) {
          // Stuck on an isolated tile — just wait and try again later.
          a.nextWanderMs = nowMs + 1500;
          continue;
        }
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        a.targetRow = pick.r;
        a.targetCol = pick.c;
        a.dir = pick.d;
        a.progress = 0;
      }
    }
  }

  /**
   * Phase 16: Draw the active bless light shafts. Each shaft is a single
   * golden vertical gradient ~6 tiles tall, fading top to bottom, with
   * an additive composite so it blooms over whatever's underneath.
   */
  private renderLightShafts(ctx: CanvasRenderingContext2D, ts: number) {
    if (this.lightShafts.length === 0) return;
    const nowMs = this.state.time.totalRealMs;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const s of this.lightShafts) {
      const dur = s.until - s.born;
      const remaining = s.until - nowMs;
      if (remaining <= 0) continue;
      // Ease out — the shaft starts bright and fades over its lifetime.
      const t = remaining / dur;
      const halfW = ts * 0.45;
      const top = s.y - ts * 6;
      const bottom = s.y + ts * 0.1;
      // Phase 17: Normalize beam color to spec rgba(255, 215, 0, 0.4)
      // — pure gold, fading from translucent at the top to peak alpha
      // (gated by ease-out `t`) at the foot of the beam.
      const peak = 0.40 * t;
      const grad = ctx.createLinearGradient(s.x, top, s.x, bottom);
      grad.addColorStop(0,   `rgba(255, 215, 0, 0)`);
      grad.addColorStop(0.4, `rgba(255, 215, 0, ${peak * 0.7})`);
      grad.addColorStop(1,   `rgba(255, 215, 0, ${peak})`);
      ctx.fillStyle = grad;
      // Trapezoidal beam — narrower at the top, wider at the foot
      ctx.beginPath();
      ctx.moveTo(s.x - halfW * 0.25, top);
      ctx.lineTo(s.x + halfW * 0.25, top);
      ctx.lineTo(s.x + halfW, bottom);
      ctx.lineTo(s.x - halfW, bottom);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Bright cyan/white zigzag bolt from sky to (x,y), with afterglow sparks. */
  private spawnLightning(x: number, y: number) {
    const ts = this.state.grid.tileSize;
    // Phase 17: Bolt now ORIGINATES from the top of the camera viewport —
    // a true "from the heavens" strike that arcs across the visible sky
    // to the target rather than just appearing 6 tiles above the impact.
    // Camera viewport top in world coords = cam.y. We push the start a
    // half-tile above that so the bolt clearly enters from off-screen.
    const cam = this.state.camera;
    const startY = cam.y - ts * 0.5;
    // More segments so the longer bolt has visible jaggedness all the
    // way down (8 was fine for a 6-tile bolt; the screen-top bolt is
    // typically 10-15 tiles tall).
    const segments = 14;
    const bolt: { x: number; y: number }[] = [];
    // Modest x-drift toward the impact so the bolt arcs naturally
    // instead of falling straight down.
    const startX = x + (Math.random() - 0.5) * ts * 1.5;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const px = startX + (x - startX) * t;
      const py = startY + (y - startY) * t;
      // Jitter scales with (1 - t) so the bolt converges to a clean
      // point at the impact and is most chaotic at the top.
      const jitter = (Math.random() - 0.5) * ts * 0.6 * (1 - t * 0.5);
      bolt.push({ x: px + jitter, y: py });
    }
    this.sparks.push({
      kind: "lightning",
      x, y,
      vx: 0, vy: 0,
      life: LIGHTNING_LIFE_MS,
      maxLife: LIGHTNING_LIFE_MS,
      bolt,
    });
    // Crackle embers
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.06 + Math.random() * 0.1;
      this.sparks.push({
        kind: "spark",
        x, y,
        vx: Math.cos(a) * sp * ts,
        vy: Math.sin(a) * sp * ts,
        life: 500, maxLife: 500,
      });
    }
    // Phase 16: Divine wrath dramatics — every smite/meteor lightning gets
    // (a) the same screen-wide white flash that thunderstorms use, and
    // (b) a brief screen shake. Pre-Phase-16, smite was visually understated
    // because the flash only triggered from the THUNDERSTORM ambient roller
    // and the lightning bolt itself was just a thin line. Now the player
    // FEELS the wrath of god regardless of weather.
    const nowMs = this.state.time.totalRealMs;
    this.lightningFlashUntilMs = Math.max(this.lightningFlashUntilMs, nowMs + LIGHTNING_FLASH_MS);
    // Phase 17: 500ms shake (was 350ms) at 7px amplitude — divine wrath
    // hits harder. The render pass attenuates over time so the shake
    // naturally eases out.
    this.screenShakeUntilMs = nowMs + 500;
    this.screenShakeIntensity = 7;
  }

  /** Big orange explosion + smoke + radial sparks. */
  private spawnFireburst(x: number, y: number) {
    const ts = this.state.grid.tileSize;
    // Core blast
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * ts * 0.4;
      this.sparks.push({
        kind: "fire",
        x: x + Math.cos(a) * r,
        y: y + Math.sin(a) * r,
        vx: Math.cos(a) * (0.05 + Math.random() * 0.1) * ts,
        vy: Math.sin(a) * (0.05 + Math.random() * 0.1) * ts,
        life: FIRE_LIFE_MS,
        maxLife: FIRE_LIFE_MS,
        size: ts * (0.25 + Math.random() * 0.35),
      });
    }
    // Smoke trailing upward
    for (let i = 0; i < 14; i++) {
      const a = (Math.random() - 0.5) * Math.PI;
      this.sparks.push({
        kind: "smoke",
        x: x + (Math.random() - 0.5) * ts,
        y: y + (Math.random() - 0.5) * ts,
        vx: Math.cos(a) * 0.02 * ts,
        vy: -Math.abs(0.04 + Math.random() * 0.04) * ts,
        life: 1400, maxLife: 1400,
        size: ts * (0.4 + Math.random() * 0.5),
      });
    }
    // Outer sparks
    for (let i = 0; i < 28; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.08 + Math.random() * 0.15;
      this.sparks.push({
        kind: "spark",
        x, y,
        vx: Math.cos(a) * sp * ts,
        vy: Math.sin(a) * sp * ts - 0.04 * ts,
        life: 700, maxLife: 700,
      });
    }
  }

  public save() {
    saveState(this.state);
  }

  public getState(): GameState {
    return this.state;
  }

  public destroy() {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.save();
    const el = this.canvas;
    el.removeEventListener("touchstart", this.onTouchStart);
    el.removeEventListener("touchmove", this.onTouchMove);
    el.removeEventListener("touchend", this.onTouchEnd);
    el.removeEventListener("touchcancel", this.onTouchEnd);
    el.removeEventListener("mousedown", this.onMouseDown);
    el.removeEventListener("mousemove", this.onMouseMove);
    el.removeEventListener("mouseup", this.onMouseUp);
    el.removeEventListener("mouseleave", this.onMouseLeave);
    el.removeEventListener("wheel", this.onWheel);
  }
}
