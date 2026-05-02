import type {
  Building,
  ChronicleEntry,
  Citizen,
  CivilizationState,
  GameState,
  Tile,
  TileType,
} from "./types";
import { createDefaultCivilization } from "./civilization";
import { normalizeCitizens, spawnInitialCitizens } from "./npc";
import { anointInitialKing, ensureMonarch, loadChronicle } from "./royalty";

const SAVE_KEY = "god_sim_state";
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
 */
const CURRENT_VERSION = 8;
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
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(serialized));
  } catch (e) {
    console.warn("Failed to save state:", e);
  }
}

export function loadState(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
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
      s.version !== 7
    ) {
      return null;
    }

    const tiles = decompressTiles(s.tilesData, s.gridMeta.rows, s.gridMeta.cols);
    const grid = { ...s.gridMeta, tiles };
    const civilization = s.civilization;

    let citizens: Citizen[];
    if (
      (s.version === CURRENT_VERSION ||
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
    };

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
      const founded = state.civilization.founded;
      const ts = state.grid.tileSize;
      const focusX = founded.col * ts + ts / 2;
      const focusY = founded.row * ts + ts / 2;
      // Note: viewW/viewH not known here (engine sets them on init). We just
      // place the camera so the focus point is at world origin offset; the
      // engine's clampCamera() runs after construction and will keep it sane.
      // Use a reasonable default zoom (1.5x) — engine's first frame will not
      // override because (x,y,zoom) are no longer all defaults.
      state.camera.zoom = 1.5;
      state.camera.x = focusX - 400;
      state.camera.y = focusY - 300;
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
    localStorage.removeItem(SAVE_KEY);
  } catch (e) {
    console.warn("Failed to clear save:", e);
  }
}
