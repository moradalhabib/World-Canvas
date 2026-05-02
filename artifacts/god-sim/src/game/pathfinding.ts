import type { Grid, PathStep, TileType } from "./types";

/**
 * Grid-based A* pathfinding for citizens.
 *
 * Walkable: grass, forest, desert, snow.
 * Blocked:  water, mountain.
 * Soft cost: forest & snow are 1.5× to encourage paths through open ground.
 *
 * Implementation: A* with a binary min-heap open set. Path is reconstructed
 * via parent pointers and returned as an array of {row, col} steps EXCLUDING
 * the start tile (the first entry is the first tile to walk to).
 */

const UNWALKABLE: ReadonlySet<TileType> = new Set<TileType>(["water", "mountain"]);

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export function isWalkable(grid: Grid, row: number, col: number): boolean {
  if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) return false;
  return !UNWALKABLE.has(grid.tiles[row][col].type);
}

function tileMoveCost(grid: Grid, row: number, col: number): number {
  const t = grid.tiles[row][col].type;
  if (t === "forest" || t === "snow") return 1.5;
  return 1;
}

interface AStarNode {
  r: number;
  c: number;
  g: number; // cost from start
  f: number; // g + heuristic
  parent: AStarNode | null;
}

class MinHeap {
  private items: AStarNode[] = [];
  push(n: AStarNode): void {
    this.items.push(n);
    this.bubbleUp(this.items.length - 1);
  }
  pop(): AStarNode | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop() as AStarNode;
    if (n > 1) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }
  size(): number {
    return this.items.length;
  }
  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[i].f < this.items[p].f) {
        const tmp = this.items[i];
        this.items[i] = this.items[p];
        this.items[p] = tmp;
        i = p;
      } else break;
    }
  }
  private bubbleDown(i: number): void {
    const n = this.items.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && this.items[l].f < this.items[best].f) best = l;
      if (r < n && this.items[r].f < this.items[best].f) best = r;
      if (best === i) break;
      const tmp = this.items[i];
      this.items[i] = this.items[best];
      this.items[best] = tmp;
      i = best;
    }
  }
}

function manhattan(r1: number, c1: number, r2: number, c2: number): number {
  return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}

/**
 * Find a path from (sr,sc) to (gr,gc). Returns null if unreachable.
 *
 * If the goal tile itself is unwalkable (e.g. a building's footprint marker),
 * we automatically retarget to the closest walkable orthogonal neighbor so a
 * citizen can "arrive next to" their target.
 */
export function findPath(
  grid: Grid,
  sr: number,
  sc: number,
  gr: number,
  gc: number,
  maxNodes: number = 4000
): PathStep[] | null {
  // Trivial case
  if (sr === gr && sc === gc) return [];

  // Retarget to a walkable neighbor if the goal is blocked.
  let goalR = gr;
  let goalC = gc;
  if (!isWalkable(grid, goalR, goalC)) {
    let bestR = -1;
    let bestC = -1;
    let bestD = Infinity;
    for (const [dr, dc] of NEIGHBORS) {
      const nr = gr + dr;
      const nc = gc + dc;
      if (!isWalkable(grid, nr, nc)) continue;
      const d = manhattan(nr, nc, sr, sc);
      if (d < bestD) {
        bestD = d;
        bestR = nr;
        bestC = nc;
      }
    }
    if (bestR === -1) return null;
    goalR = bestR;
    goalC = bestC;
  }

  if (!isWalkable(grid, sr, sc)) return null;

  const cols = grid.cols;
  const bestG = new Map<number, number>();
  const open = new MinHeap();
  const start: AStarNode = {
    r: sr,
    c: sc,
    g: 0,
    f: manhattan(sr, sc, goalR, goalC),
    parent: null,
  };
  open.push(start);
  bestG.set(sr * cols + sc, 0);

  let explored = 0;
  while (open.size() > 0 && explored < maxNodes) {
    const cur = open.pop() as AStarNode;
    explored++;

    if (cur.r === goalR && cur.c === goalC) {
      // Reconstruct path (exclude start)
      const path: PathStep[] = [];
      let n: AStarNode | null = cur;
      while (n && n.parent) {
        path.push({ row: n.r, col: n.c });
        n = n.parent;
      }
      path.reverse();
      return path;
    }

    // Skip if a better path to this node was already processed
    const curKey = cur.r * cols + cur.c;
    const bestSoFar = bestG.get(curKey);
    if (bestSoFar !== undefined && cur.g > bestSoFar) continue;

    for (const [dr, dc] of NEIGHBORS) {
      const nr = cur.r + dr;
      const nc = cur.c + dc;
      if (!isWalkable(grid, nr, nc)) continue;
      const tentative = cur.g + tileMoveCost(grid, nr, nc);
      const key = nr * cols + nc;
      const prev = bestG.get(key);
      if (prev !== undefined && tentative >= prev) continue;
      bestG.set(key, tentative);
      open.push({
        r: nr,
        c: nc,
        g: tentative,
        f: tentative + manhattan(nr, nc, goalR, goalC),
        parent: cur,
      });
    }
  }
  return null;
}
