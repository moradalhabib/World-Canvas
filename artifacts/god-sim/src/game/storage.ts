import type { GameState, Tile, TileType } from "./types";

const SAVE_KEY = "god_sim_state";
const CURRENT_VERSION = 1;
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
  return {
    version: CURRENT_VERSION,
    camera: { x: 0, y: 0, zoom: 1 },
    time: {
      gameMonth: 1,
      gameYear: 1,
      timeScale: 1,
      lastSavedTimestamp: Date.now(),
      totalRealMs: 0,
    },
    grid: {
      cols: GRID_COLS,
      rows: GRID_ROWS,
      tileSize: TILE_SIZE,
      tiles: generateTerrain(GRID_COLS, GRID_ROWS),
    },
  };
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
    if (s.version !== CURRENT_VERSION) return null;
    const tiles = decompressTiles(s.tilesData, s.gridMeta.rows, s.gridMeta.cols);
    return {
      version: s.version,
      camera: s.camera,
      time: s.time,
      grid: { ...s.gridMeta, tiles },
    };
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
