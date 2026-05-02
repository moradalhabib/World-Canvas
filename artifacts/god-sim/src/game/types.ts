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
  | "snow";

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
}

export const TILE_COLORS: Record<TileType, string> = {
  grass: "#4a7c3f",
  water: "#2b6cb0",
  forest: "#276749",
  mountain: "#718096",
  desert: "#d69e2e",
  snow: "#e2e8f0",
};

export const TILE_BORDER_COLORS: Record<TileType, string> = {
  grass: "#38643a",
  water: "#2c5282",
  forest: "#1d5633",
  mountain: "#4a5568",
  desert: "#b7791f",
  snow: "#cbd5e0",
};
