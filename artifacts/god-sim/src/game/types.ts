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

export const TILE_SPECKLE_COLORS: Record<TileType, [string, string]> = {
  grass: ["#5a8f4a", "#3d6b35"],
  water: ["#4a8fd6", "#1f4f8a"],
  forest: ["#2f7a52", "#194226"],
  mountain: ["#8b95a3", "#5a6472"],
  desert: ["#e8b85a", "#b8801a"],
  snow: ["#ffffff", "#b5c2d1"],
};

export const SPECKLE_DENSITY: Record<TileType, number> = {
  grass: 60,
  water: 18,
  forest: 80,
  mountain: 50,
  desert: 40,
  snow: 25,
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
