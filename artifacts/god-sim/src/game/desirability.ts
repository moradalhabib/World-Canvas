import type { Building, Grid } from "./types";
import { getBuildingDef } from "./buildings";

/**
 * Hidden land-value map driving social hierarchy.
 *
 * Score interpretation:
 *   > +0.5 → highly desirable (manors, wealthy)
 *   ~  0.0 → neutral
 *   < -0.5 → undesirable (slums, industrial)
 *
 * Two contributions composed at read time:
 *  - terrain: cached once at init (water/forest = +, desert = -)
 *  - buildings: re-summed when buildings change (high-tier homes = +, mines = -)
 *
 * Splitting the two avoids re-scanning all 10,000 tiles + 49-cell radius spread
 * (~500k ops) just because a single building was placed.
 */
export class DesirabilityMap {
  readonly rows: number;
  readonly cols: number;
  private terrainMap: Float32Array;
  private buildingMap: Float32Array;
  private terrainBuilt = false;
  private dirty = true;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.terrainMap = new Float32Array(rows * cols);
    this.buildingMap = new Float32Array(rows * cols);
  }

  markDirty() {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /** Composed terrain + buildings score at (row, col). */
  get(row: number, col: number): number {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return 0;
    const i = row * this.cols + col;
    return this.terrainMap[i] + this.buildingMap[i];
  }

  /**
   * Recompute. The terrain pass runs only the first time (terrain is static).
   * The building pass runs every time buildings change.
   */
  recompute(grid: Grid, buildings: Building[]): void {
    if (!this.terrainBuilt) {
      this.recomputeTerrain(grid);
      this.terrainBuilt = true;
    }
    this.recomputeBuildings(buildings);
    this.dirty = false;
  }

  private recomputeTerrain(grid: Grid): void {
    this.terrainMap.fill(0);
    const TERRAIN_RADIUS = 4;
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const t = grid.tiles[r][c].type;
        let contrib = 0;
        if (t === "water") contrib = 0.45;
        else if (t === "forest") contrib = 0.3;
        else if (t === "mountain") contrib = 0.05;
        else if (t === "desert") contrib = -0.15;
        else if (t === "snow") contrib = -0.05;
        if (contrib === 0) continue;
        this.spread(this.terrainMap, r, c, contrib, TERRAIN_RADIUS);
      }
    }
  }

  private recomputeBuildings(buildings: Building[]): void {
    this.buildingMap.fill(0);
    for (const b of buildings) {
      const def = getBuildingDef(b.typeId);
      if (def.desirability === 0) continue;
      this.spread(this.buildingMap, b.row, b.col, def.desirability, def.desirabilityRadius);
    }
  }

  /** Spread a value contribution from (r,c) outward with linear falloff. */
  private spread(
    map: Float32Array,
    row: number,
    col: number,
    value: number,
    radius: number
  ): void {
    const r2 = radius * radius;
    for (let dr = -radius; dr <= radius; dr++) {
      const nr = row + dr;
      if (nr < 0 || nr >= this.rows) continue;
      for (let dc = -radius; dc <= radius; dc++) {
        const nc = col + dc;
        if (nc < 0 || nc >= this.cols) continue;
        const dist2 = dr * dr + dc * dc;
        if (dist2 > r2) continue;
        const falloff = 1 - Math.sqrt(dist2) / radius;
        map[nr * this.cols + nc] += value * falloff;
      }
    }
  }
}
