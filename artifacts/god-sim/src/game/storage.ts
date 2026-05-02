import type {
  Animal,
  Building,
  ChronicleEntry,
  Citizen,
  CivilizationState,
  GameState,
  Grid,
  Tile,
  TileType,
} from "./types";
import { createDefaultCivilization } from "./civilization";
import { normalizeCitizens, spawnInitialCitizens } from "./npc";
import { anointInitialKing, ensureMonarch, loadChronicle } from "./royalty";

/**
 * Phase 16/17: Spawn fauna on random grass/forest tiles for fresh + migrated
 * saves. Phase 17 widened to take separate `sheepCount` and `wolfCount` so
 * the migration path can also seed predators when a v12 save is upgraded.
 *
 * Both species use the same Animal interface — only `kind` and the renderer
 * dispatch differ. We pick from the same candidate pool because both species
 * walk the same terrain (grass / forest only).
 */
export function spawnInitialAnimals(grid: Grid, sheepCount: number, wolfCount: number = 0): Animal[] {
  const animals: Animal[] = [];
  const candidates: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const t = grid.tiles[r][c].type;
      if (t === "grass" || t === "forest") candidates.push({ r, c });
    }
  }
  if (candidates.length === 0) return animals;
  const stamp = Date.now();
  for (let i = 0; i < sheepCount; i++) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    animals.push({
      id: `sheep-${stamp}-${i}-${Math.floor(Math.random() * 9999)}`,
      kind: "sheep",
      row: pick.r,
      col: pick.c,
      targetRow: pick.r,
      targetCol: pick.c,
      progress: 0,
      dir: (Math.floor(Math.random() * 4) as 0 | 1 | 2 | 3),
      nextWanderMs: 0,
      grazingUntilMs: 0,
    });
  }
  for (let i = 0; i < wolfCount; i++) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    animals.push({
      id: `wolf-${stamp}-${i}-${Math.floor(Math.random() * 9999)}`,
      kind: "wolf",
      row: pick.r,
      col: pick.c,
      targetRow: pick.r,
      targetCol: pick.c,
      progress: 0,
      dir: (Math.floor(Math.random() * 4) as 0 | 1 | 2 | 3),
      nextWanderMs: 0,
      grazingUntilMs: 0,
    });
  }
  return animals;
}

/**
 * Phase 26 — Local-First "Black Box" save engine.
 *
 * Storage key. Renamed from the legacy `god_sim_state` to the
 * production-branded `humanity_progress_save` for the App Store wrap.
 * `loadState()` reads the new key first and falls back to the legacy key
 * for one-shot migration so existing dev/player saves are not lost.
 * `saveState()` writes only the new key going forward.
 */
const SAVE_KEY = "humanity_progress_save";
/**
 * Legacy storage key (Phase 1 → Phase 25). Read-only fallback in
 * `loadState()` — once a v15+ save is written under SAVE_KEY, the legacy
 * key becomes stale. We do NOT delete the legacy key automatically so
 * users can roll back to a pre-Phase-26 build if they want.
 */
const LEGACY_SAVE_KEY = "god_sim_state";

/* ─────────────────────────────────────────────────────────────────────
 * Phase 26 — SaveBackend abstraction.
 *
 * Thin pluggable interface so the same SaveManager works against either
 * `window.localStorage` (web build, current default) or the Capacitor
 * Preferences API (native iOS App Store build).
 *
 * The web build registers `localStorageBackend`; the future native build
 * will swap in a `capacitorPreferencesBackend` (commented stub below)
 * with zero changes to the call sites.
 *
 * The interface is intentionally narrow — getItem / setItem / removeItem
 * mirror the localStorage subset Capacitor Preferences exposes natively
 * via `Preferences.get({ key })` / `Preferences.set({ key, value })` /
 * `Preferences.remove({ key })`. Both are string-only key/value stores,
 * so the JSON serialization stays the same across both backends.
 * ───────────────────────────────────────────────────────────────────── */

export interface SaveBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const localStorageBackend: SaveBackend = {
  getItem: (k) => {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  setItem: (k, v) => {
    try { localStorage.setItem(k, v); } catch (e) { console.warn("save: localStorage.setItem failed", e); }
  },
  removeItem: (k) => {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  },
};

/*
 * Future Capacitor backend (registered when the app is wrapped for iOS).
 *
 * IMPORTANT — async caveat: The current `SaveBackend` contract is
 * synchronous because it mirrors `localStorage` and is consumed from
 * inside the synchronous `GameEngine` constructor. Capacitor's
 * `Preferences` API is async-only, so a true native wrap will require
 * EITHER:
 *   (a) widening this interface to `Promise<string | null>` returns and
 *       making `loadState()` + the GameEngine boot path awaitable
 *       (cascades through the React mount — bigger refactor, deferred
 *       to Phase 27), OR
 *   (b) shipping a small native shim that hot-loads all keys into an
 *       in-memory cache at app boot and write-throughs on setItem so
 *       the sync facade keeps working unchanged.
 *
 * Phase 26 ships the abstraction + key rebrand so the swap site is
 * centralized in ONE file (storage.ts) instead of scattered across
 * every saveState/loadState/clearSave call site — but the async
 * migration itself is real engineering, not a 5-line edit.
 *
 * import { Preferences } from "@capacitor/preferences";
 * const capacitorPreferencesBackend: SaveBackend = {
 *   getItem: async (k) => (await Preferences.get({ key: k })).value,
 *   setItem: async (k, v) => { await Preferences.set({ key: k, value: v }); },
 *   removeItem: async (k) => { await Preferences.remove({ key: k }); },
 * };
 */

let activeBackend: SaveBackend = localStorageBackend;

/** Test/debug hook — let the host swap the backend (e.g. for Capacitor wrap). */
export function setSaveBackend(backend: SaveBackend): void {
  activeBackend = backend;
}
/** v1: terrain only. v2: + buildings + civilization. v3: + citizens.
 *  v4: + royal succession (nobleDissent, chronicle, lineage fields).
 *  v5: + Phase 6 lifecycle (safety, vanity, day/night, REBEL/SLEEPING).
 *  v6: + Phase 5 Divine Powers (crater tile, building.status, winterActive).
 *  v7: + Phase 11 balance pass — one-shot hunger reset on load + empty-throne
 *       failsafe applied via ensureMonarch().
 *  v8: + Bread economy hotfix — Phase 11 v7 only zeroed PER-CITIZEN hunger but
 *       the panel reads CIVIC needs.hunger.value, which still pegged to 100
 *       within 4 months because starting state has bread:8/wheat:0/no farms.
 *       v8 also zeros civ.needs.hunger.value, tops up the bread reserve, and
 *       recenters the camera on spawn so off-screen NPCs become visible again.
 *  v9: + Phase 12 Societal Fabric Engine — adds lastName/mood/dissent fields
 *       on every citizen plus MENTAL_BREAK + CHATTING states. normalizeCitizens
 *       backfills the new fields; no other state mutations needed.
 *  v10: + Phase 13 Dynamic Climate & Ecosystem Engine — adds currentSeason,
 *        currentWeather, lastWeatherRollMonth on GameState. Migration backfills
 *        from gameMonth (season is deterministic) and seeds CLEAR weather.
 *  v11: + Phase 14 Living City Expansion (Crime, Medicine, Leisure) — adds
 *        morality/health/leisure/isSick/sickSinceMonth/arrestTargetId/
 *        imprisonedInId on every citizen, leisure on civ.needs, plus 3 new
 *        building kinds (dungeon, apothecary, tavern) and 5 new citizen
 *        states (STEALING, ARRESTING, IMPRISONED, HEALING, DRINKING).
 *        normalizeCitizens backfills the per-citizen fields; civ.needs.leisure
 *        is patched in below if absent.
 *  v12: + Phase 16 Living World — adds GameState.animals (ambient sheep
 *        fauna). Migration backfills `animals: []` THEN spawns 10 fresh
 *        sheep on grass/forest tiles so the realm doesn't look lifeless
 *        after upgrade. spawnInitialAnimals is called inside loadState
 *        for any save older than v12.
 *  v13: + Phase 17 Master VFX & Ecosystem — widens AnimalKind to include
 *        "wolf". v12 saves only contain sheep, so on upgrade we KEEP all
 *        persisted sheep AND inject 4 fresh wolves into the herd so the
 *        realm gains its predator population without losing existing
 *        animal identity. Older saves go through spawnInitialAnimals
 *        directly with both sheep and wolf counts.
 */
/**
 *  v14: + Phase 21 Masterpiece Integration — adds Building.complete /
 *        constructionWorkMs (scaffolded construction) and
 *        GameState.lastImmigrationYear. Migration backfills every legacy
 *        building to complete:true (so existing realms don't freeze every
 *        structure back to "under construction" on upgrade) and sets
 *        lastImmigrationYear to the current gameYear (so older saves
 *        don't get a free immigrant wave the moment they load).
 */
const CURRENT_VERSION = 15;
const INITIAL_CITIZEN_COUNT = 6;
const GRID_COLS = 100;
const GRID_ROWS = 100;
const TILE_SIZE = 64;

const TILE_TYPE_MAP: TileType[] = [
  "grass",
  "water",
  "forest",
  "mountain",
  "desert",
  "snow",
  "crater",
];

function generateTerrain(cols: number, rows: number): Tile[][] {
  const tiles: Tile[][] = [];
  for (let r = 0; r < rows; r++) {
    tiles[r] = [];
    for (let c = 0; c < cols; c++) {
      const nx = c / cols;
      const ny = r / rows;
      const distFromCenter = Math.sqrt(
        (nx - 0.5) ** 2 + (ny - 0.5) ** 2
      );
      const noise =
        Math.sin(nx * 12.1) * Math.cos(ny * 8.7) * 0.4 +
        Math.sin(nx * 5.3 + ny * 6.1) * 0.3 +
        Math.cos(nx * 3.7 - ny * 9.2) * 0.3;
      const elevation = Math.max(0, Math.min(1, 0.5 + noise - distFromCenter * 0.4));

      let type: TileType;
      if (elevation < 0.25) type = "water";
      else if (elevation < 0.38) type = "desert";
      else if (elevation < 0.6) type = "grass";
      else if (elevation < 0.72) type = "forest";
      else if (elevation < 0.86) type = "mountain";
      else type = "snow";

      tiles[r][c] = {
        type,
        elevation,
        fertility: type === "grass" ? 0.7 + Math.random() * 0.3 : 0,
      };
    }
  }
  return tiles;
}

export function createDefaultState(): GameState {
  const grid = {
    cols: GRID_COLS,
    rows: GRID_ROWS,
    tileSize: TILE_SIZE,
    tiles: generateTerrain(GRID_COLS, GRID_ROWS),
  };
  const civilization = createDefaultCivilization(grid);
  const citizens = spawnInitialCitizens(grid, civilization.founded, INITIAL_CITIZEN_COUNT);
  const state: GameState = {
    version: CURRENT_VERSION,
    camera: { x: 0, y: 0, zoom: 1 },
    time: {
      gameMonth: 1,
      gameYear: 1,
      timeScale: 1,
      lastSavedTimestamp: Date.now(),
      totalRealMs: 0,
    },
    grid,
    buildings: [],
    civilization,
    citizens,
    nobleDissent: "LOW",
    chronicle: [],
    lastRoyalYearTicked: 1,
    dayNight: "day",
    lastDayNightFlipMonth: 1,
    winterActive: false,
    // Phase 13: month 1 = January = WINTER. Weather seeded CLEAR; the engine
    // re-rolls on the first day-phase transition.
    currentSeason: monthToSeason(1),
    currentWeather: "CLEAR",
    lastWeatherRollMonth: 1,
    // Phase 16/17: seed 10 sheep + 4 wolves on grass/forest tiles.
    animals: spawnInitialAnimals(grid, 10, 4),
    // Phase 21: anchor immigration cooldown to the founding year so the
    // realm doesn't get a free immigrant wave on Year 1 before the
    // founders have proven anything.
    lastImmigrationYear: 1,
    // Phase 23: every fresh realm starts in the MEDIEVAL era. The
    // EraController is wired but no automatic era-progression trigger
    // fires yet — only an explicit `engine.setEra(...)` call advances it.
    currentEra: "MEDIEVAL",
  };
  // Phase 3B: anoint the founding King + Queen and write the first chronicle.
  anointInitialKing(state);
  return state;
}

export function compressTiles(tiles: Tile[][]): string {
  const rows = tiles.length;
  const cols = tiles[0].length;
  const buf: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = tiles[r][c];
      const typeIdx = TILE_TYPE_MAP.indexOf(t.type);
      const elev = Math.round(t.elevation * 255);
      const fert = Math.round(t.fertility * 255);
      buf.push(typeIdx, elev, fert);
    }
  }
  return btoa(String.fromCharCode(...buf));
}

export function decompressTiles(
  data: string,
  rows: number,
  cols: number
): Tile[][] {
  const raw = atob(data);
  const tiles: Tile[][] = [];
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    tiles[r] = [];
    for (let c = 0; c < cols; c++) {
      const typeIdx = raw.charCodeAt(idx);
      const elev = raw.charCodeAt(idx + 1) / 255;
      const fert = raw.charCodeAt(idx + 2) / 255;
      idx += 3;
      tiles[r][c] = {
        type: TILE_TYPE_MAP[typeIdx] ?? "grass",
        elevation: elev,
        fertility: fert,
      };
    }
  }
  return tiles;
}

interface SerializedState {
  version: number;
  camera: GameState["camera"];
  time: GameState["time"];
  gridMeta: { cols: number; rows: number; tileSize: number };
  tilesData: string;
  buildings: Building[];
  civilization: CivilizationState;
  citizens?: Citizen[];
  nobleDissent?: GameState["nobleDissent"];
  chronicle?: ChronicleEntry[];
  lastRoyalYearTicked?: number;
  dayNight?: GameState["dayNight"];
  lastDayNightFlipMonth?: number;
  winterActive?: boolean;
  /* Phase 13 */
  currentSeason?: GameState["currentSeason"];
  currentWeather?: GameState["currentWeather"];
  lastWeatherRollMonth?: number;
  /* Phase 16 */
  animals?: Animal[];
  /* Phase 21 */
  lastImmigrationYear?: number;
  /* Phase 23 */
  currentEra?: GameState["currentEra"];
}

/** Phase 13: deterministic season from game month (Mar-May Spring, etc.). */
export function monthToSeason(month: number): GameState["currentSeason"] {
  if (month >= 3 && month <= 5) return "SPRING";
  if (month >= 6 && month <= 8) return "SUMMER";
  if (month >= 9 && month <= 11) return "AUTUMN";
  return "WINTER";
}

export function saveState(state: GameState): void {
  try {
    const tilesData = compressTiles(state.grid.tiles);
    const serialized: SerializedState = {
      version: state.version,
      camera: { ...state.camera },
      time: { ...state.time, lastSavedTimestamp: Date.now() },
      gridMeta: {
        cols: state.grid.cols,
        rows: state.grid.rows,
        tileSize: state.grid.tileSize,
      },
      tilesData,
      buildings: state.buildings,
      civilization: state.civilization,
      citizens: state.citizens,
      nobleDissent: state.nobleDissent,
      chronicle: state.chronicle,
      lastRoyalYearTicked: state.lastRoyalYearTicked,
      dayNight: state.dayNight,
      lastDayNightFlipMonth: state.lastDayNightFlipMonth,
      winterActive: state.winterActive,
      // Phase 13: persist climate state so reloads don't snap weather back
      // to CLEAR mid-storm. Season is deterministic from gameMonth (fallback
      // works) but currentWeather is non-deterministic and MUST be saved.
      currentSeason: state.currentSeason,
      currentWeather: state.currentWeather,
      lastWeatherRollMonth: state.lastWeatherRollMonth,
      // Phase 16: persist sheep so they don't snap to fresh-spawn locations
      // on reload. Each sheep is ~10 fields, so 10 sheep ≈ negligible.
      animals: state.animals ?? [],
      // Phase 21/23: persist immigration cooldown + era.
      lastImmigrationYear: state.lastImmigrationYear,
      currentEra: state.currentEra,
    };
    activeBackend.setItem(SAVE_KEY, JSON.stringify(serialized));
  } catch (e) {
    console.warn("Failed to save state:", e);
  }
}

export function loadState(): GameState | null {
  try {
    // Phase 26: read the production key first; fall back to the legacy
    // `god_sim_state` key one time so existing pre-Phase-26 saves migrate
    // transparently. When we hit the legacy fallback we ALSO write the
    // raw payload through to the new key immediately — this way the
    // engine's dirty flag can stay false on a clean idle boot, and the
    // legacy entry is only consulted once per realm.
    let raw = activeBackend.getItem(SAVE_KEY);
    if (raw == null) {
      const legacy = activeBackend.getItem(LEGACY_SAVE_KEY);
      if (legacy != null) {
        activeBackend.setItem(SAVE_KEY, legacy);
        raw = legacy;
      }
    }
    if (!raw) return null;
    const s: SerializedState = JSON.parse(raw);

    // v8 is current. We migrate from v2 (no citizens), v3 (no royalty),
    // v4 (no Phase-6 lifecycle/day-night), v5 (no Phase-5 winter/rubble/crater),
    // v6 (Phase 11 balance pass: zero per-citizen hunger + empty-throne failsafe),
    // and v7 (bread economy hotfix: zero civic hunger, top up bread, recenter cam).
    // Older versions are discarded.
    if (
      s.version !== CURRENT_VERSION &&
      s.version !== 2 &&
      s.version !== 3 &&
      s.version !== 4 &&
      s.version !== 5 &&
      s.version !== 6 &&
      s.version !== 7 &&
      s.version !== 8 &&
      s.version !== 9 &&
      s.version !== 10 && // Phase 13 saves migrate cleanly to Phase 14
      s.version !== 11 && // Phase 14 saves migrate cleanly to Phase 16
      s.version !== 12 && // Phase 16 saves migrate cleanly to Phase 17
      s.version !== 13 && // Phase 17/18/19/20 saves migrate cleanly to Phase 21
      s.version !== 14    // Phase 21/22 saves migrate cleanly to Phase 23
    ) {
      return null;
    }

    const tiles = decompressTiles(s.tilesData, s.gridMeta.rows, s.gridMeta.cols);
    const grid = { ...s.gridMeta, tiles };
    const civilization = s.civilization;

    let citizens: Citizen[];
    if (
      (s.version === CURRENT_VERSION ||
        s.version === 14 || // Phase 21/22 saves — preserve through Phase 23 EraController upgrade.
        s.version === 13 || // Phase 17/18/19/20 saves — preserve through Phase 21 upgrade.
        s.version === 12 || // Phase 16 saves — preserve citizens through Phase 17 upgrade.
        s.version === 11 || // Phase 14 saves carry full citizen state — DO NOT
                            // wipe to fresh-spawn population on Phase 16 upgrade.
        s.version === 10 ||
        s.version === 9 ||
        s.version === 8 ||
        s.version === 7 ||
        s.version === 6 ||
        s.version === 5 ||
        s.version === 4 ||
        s.version === 3) &&
      Array.isArray(s.citizens)
    ) {
      // Backfill any fields added in mid-version code changes (e.g. faith,
      // crisisTimer, royalty fields) so save data from earlier dev builds keeps working.
      citizens = normalizeCitizens(s.citizens);
    } else {
      // v2 → v4 migration: spawn fresh citizens around the existing town.
      citizens = spawnInitialCitizens(grid, civilization.founded, INITIAL_CITIZEN_COUNT);
    }

    // Phase 5: backfill missing per-Building.status so older saves render correctly.
    const buildings = (s.buildings ?? []).map((b) => ({
      ...b,
      status: b.status ?? "intact",
    }));

    // Phase 14 backfill: older saves predate the leisure civic need. Patch
    // the needs record in-place so the HUD doesn't blow up on the missing
    // entry. Default mirrors createDefaultCivilization() so a migrated
    // realm and a fresh realm start from the same baseline.
    if (civilization && civilization.needs && !civilization.needs.leisure) {
      civilization.needs.leisure = { value: 25, weight: 0.8, decay: 1.2 };
    }

    const state: GameState = {
      version: CURRENT_VERSION,
      camera: s.camera,
      time: s.time,
      grid,
      buildings,
      civilization,
      citizens,
      nobleDissent: s.nobleDissent ?? "LOW",
      chronicle: s.chronicle ?? loadChronicle(),
      lastRoyalYearTicked: s.lastRoyalYearTicked ?? s.time.gameYear,
      dayNight: s.dayNight ?? "day",
      lastDayNightFlipMonth:
        s.lastDayNightFlipMonth ?? s.time.gameYear * 12 + s.time.gameMonth,
      winterActive: s.winterActive ?? false,
      // Phase 13 backfill — season is deterministic from gameMonth, so older
      // saves can simply recompute it. Weather defaults to CLEAR; the engine
      // will re-roll on the next day-phase transition.
      currentSeason: s.currentSeason ?? monthToSeason(s.time.gameMonth),
      currentWeather: s.currentWeather ?? "CLEAR",
      lastWeatherRollMonth:
        s.lastWeatherRollMonth ?? s.time.gameYear * 12 + s.time.gameMonth,
      // Phase 16/17: animal hydration with predator backfill.
      //   - v13+ (current) saves: trust persisted herd, contains both species.
      //   - v12 saves: contain only sheep — KEEP them all, inject 4 fresh
      //     wolves so the predator population appears post-upgrade.
      //   - older saves (no `animals` field): spawn full fresh herd.
      // The predator-injection branch preserves sheep identity (id/position/
      // grazing state) — only NEW wolf entries are appended.
      animals: Array.isArray(s.animals)
        ? (s.version === 12
            ? [...s.animals, ...spawnInitialAnimals(grid, 0, 4)]
            : s.animals)
        : spawnInitialAnimals(grid, 10, 4),
      // Phase 21 backfill — anchor the immigration cooldown to the save's
      // current year so older realms don't get a free wave the instant
      // they load. Saves that already have the field keep it.
      lastImmigrationYear: s.lastImmigrationYear ?? s.time.gameYear,
      // Phase 23 backfill — every legacy realm is by definition MEDIEVAL
      // (it's the only era that's ever existed in shipped builds). Future
      // saves persist the era explicitly.
      currentEra: s.currentEra ?? "MEDIEVAL",
    };

    // Phase 21 backfill — every pre-v14 building was implicitly complete.
    // Without this stamp, the new construction-gated production loop would
    // freeze every existing farm/mine/house back into "scaffolded" mode.
    if ((s.version ?? 0) < 14) {
      for (const b of state.buildings) {
        if (b.complete === undefined) b.complete = true;
        if (b.constructionWorkMs === undefined) b.constructionWorkMs = 0;
      }
    }

    // v3 → v4: no monarch existed. Anoint the existing population.
    if (s.version === 3 || s.version === 2) {
      anointInitialKing(state);
    }

    // v6 → v7: Phase 11 one-shot save fix.
    //   1) Zero everyone's hunger so the user isn't punished by the old
    //      pre-balance-pass drain rates while they test the new tunings.
    //   2) If the throne is empty (e.g. Queen-died-without-heir soft-lock),
    //      elevate the highest-Vanity surviving citizen to King.
    if (s.version === 6) {
      for (const c of state.citizens) {
        if (c.state !== "DEAD") c.hunger = 0;
      }
      ensureMonarch(state);
    }

    // v7 → v8: Bread economy hotfix.
    //   1) Re-zero PER-CITIZEN hunger (defensive — repeats v6→v7 logic for
    //      saves that have continued to drift).
    //   2) Zero CIVIC needs.hunger.value — this is what the Civic Needs panel
    //      reads, and v6→v7 missed it. Without this, panels still show 100.
    //   3) Top up the bread reserve to at least 60 loaves (~10 months of food
    //      at population 6) so the realm doesn't immediately re-spiral while
    //      the player is testing the new walk-cycle visuals.
    //   4) Recenter the camera on the civ founding tile so any NPCs that had
    //      wandered off-screen are immediately visible after the migration.
    if (s.version === 6 || s.version === 7) {
      for (const c of state.citizens) {
        if (c.state !== "DEAD") c.hunger = 0;
      }
      if (state.civilization.needs?.hunger) {
        state.civilization.needs.hunger.value = 0;
      }
      const res = state.civilization.resources;
      if ((res.bread ?? 0) < 60) res.bread = 60;
      // Force-recenter camera on the founded tile at a comfortable zoom so
      // citizens that had wandered are visible immediately on next render.
      // Reset to (0,0,1) so the engine's init-block detects "default camera"
      // and re-runs its targetZoom formula — that formula now shows ~10 tiles
      // across (NPCs ~2x bigger than the old /20 setting).
      state.camera.zoom = 1;
      state.camera.x = 0;
      state.camera.y = 0;
    }

    return state;
  } catch (e) {
    console.warn("Failed to load state:", e);
    return null;
  }
}

export function applyOfflineProgression(state: GameState): void {
  const now = Date.now();
  const elapsedRealMs = now - state.time.lastSavedTimestamp;
  if (elapsedRealMs <= 0) return;
  const elapsedMinutes = elapsedRealMs / 60_000;
  const elapsedMonths = Math.floor(elapsedMinutes);
  if (elapsedMonths > 0) {
    state.time.gameMonth += elapsedMonths;
    while (state.time.gameMonth > 12) {
      state.time.gameMonth -= 12;
      state.time.gameYear++;
    }
  }
  state.time.lastSavedTimestamp = now;
  state.time.totalRealMs += elapsedRealMs;
}

export function clearSave(): void {
  try {
    activeBackend.removeItem(SAVE_KEY);
    // Phase 26: also wipe the legacy key so a "new game" can't be
    // accidentally re-hydrated from the pre-rename fallback.
    activeBackend.removeItem(LEGACY_SAVE_KEY);
  } catch (e) {
    console.warn("Failed to clear save:", e);
  }
}
