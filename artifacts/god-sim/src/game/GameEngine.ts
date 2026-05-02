import {
  TILE_COLORS,
  TILE_BORDER_COLORS,
  TILE_SPECKLE_COLORS,
  SPECKLE_DENSITY,
  getTransitionColor,
} from "./types";
import type { Building, GameState, TileType } from "./types";
import {
  createDefaultState,
  saveState,
  loadState,
  applyOfflineProgression,
} from "./storage";
import { getBuildingDef } from "./buildings";
import { tickCivilizationMonth } from "./civilization";
import { DesirabilityMap } from "./desirability";
import { planAndBuild, tryUpgradeHouses } from "./buildAI";
import {
  getCitizenVisualPos,
  tickCitizenMonth,
  updateCitizenMovement,
  processNightSleep,
  processDayWake,
} from "./npc";
import { tickYear as tickRoyalYear, getLifeStage, notifyDeath, addChronicle } from "./royalty";
import type { Citizen } from "./types";

/* Phase 4: Combat tunables */
const COMBAT_RADIUS_TILES = 2;
const COMBAT_DURATION_MS = 900;
const SPARK_LIFE_MS = 450;
const SPARKS_PER_FRAME = 1;

interface Spark {
  x: number;        // world px
  y: number;        // world px
  vx: number;
  vy: number;
  life: number;     // ms remaining
  maxLife: number;
}

export interface CitizenTapInfo {
  citizen: Citizen;
  screenX: number;
  screenY: number;
}

const MAX_ZOOM = 4.0;
const SAVE_INTERVAL_MS = 10_000;
const MONTHS_PER_REAL_MS_AT_1X = 1 / 60_000;

export interface GameCallbacks {
  onTimeUpdate: (state: GameState) => void;
  /** Phase 4: Inner Monologue — fired when the user taps an NPC. */
  onCitizenTap?: (info: CitizenTapInfo) => void;
}

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
  /** Pre-baked edge fade strips, keyed by `${color}|${dir}` where dir is t/b/l/r. */
  private transitionStrips = new Map<string, HTMLCanvasElement>();

  /** Pre-rendered humanoid sprites per social tier, keyed by tier name.
   *  Stamped in renderCitizens; rebuilt when tile size changes. */
  private npcSprites = new Map<string, HTMLCanvasElement>();
  private npcSpriteTileSize = 0;

  /** Hidden land-value map driving social hierarchy. */
  private desirability!: DesirabilityMap;
  /** Months between full desirability recomputes (it's also marked dirty on builds). */
  private monthsSinceDesirRecompute = 0;
  /** Pending offline simulation catch-up to run after init. */
  private pendingOfflineMonths = 0;

  /* Phase 4: Combat sparks (world-space particles) */
  private sparks: Spark[] = [];

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

    this.buildBiomePatterns();
    this.buildWaterHighlight();

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
      const focusX = founded.col * grid.tileSize + grid.tileSize / 2;
      const focusY = founded.row * grid.tileSize + grid.tileSize / 2;
      // Pick a comfortable mid-range zoom that shows ~20 tiles across
      const targetZoom = Math.min(MAX_ZOOM, this.viewW / (20 * grid.tileSize));
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

    tickCivilizationMonth(this.state.civilization, this.state.buildings);

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
        this.state.time.gameYear = realYear;
        safety++;
      }
      this.state.lastRoyalYearTicked = target;
    }
  }

  private buildBiomePatterns() {
    const tileSize = this.state.grid.tileSize;
    const types: TileType[] = [
      "grass", "water", "forest", "mountain", "desert", "snow",
    ];
    for (const type of types) {
      const off = document.createElement("canvas");
      off.width = tileSize;
      off.height = tileSize;
      const p = off.getContext("2d")!;

      p.fillStyle = TILE_COLORS[type];
      p.fillRect(0, 0, tileSize, tileSize);

      const [light, dark] = TILE_SPECKLE_COLORS[type];
      const density = SPECKLE_DENSITY[type];

      let seed = type.charCodeAt(0) * 9301 + 49297;
      const rand = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      for (let i = 0; i < density; i++) {
        const x = rand() * tileSize;
        const y = rand() * tileSize;
        const r = 0.4 + rand() * 1.6;
        const useLight = rand() > 0.5;
        const alpha = 0.15 + rand() * 0.45;
        p.globalAlpha = alpha;
        p.fillStyle = useLight ? light : dark;
        p.beginPath();
        p.arc(x, y, r, 0, Math.PI * 2);
        p.fill();
      }
      p.globalAlpha = 1;

      const pat = this.ctx.createPattern(off, "repeat");
      if (pat) this.biomePatterns.set(type, pat);
    }
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
  private renderBuildings(
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number
  ) {
    const ctx = this.ctx;
    const ts = this.state.grid.tileSize;
    const cam = this.state.camera;
    if (this.state.buildings.length === 0) return;

    for (const b of this.state.buildings) {
      if (b.row < startRow || b.row > endRow) continue;
      if (b.col < startCol || b.col > endCol) continue;
      const def = getBuildingDef(b.typeId);
      const x = b.col * ts;
      const y = b.row * ts;
      this.drawBuilding(b, def, x, y, ts);
    }

    // Show building glyphs only when zoomed in enough to read them
    if (cam.zoom > 0.7) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      ctx.font = `bold ${Math.round(ts * 0.32)}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const b of this.state.buildings) {
        if (b.row < startRow || b.row > endRow) continue;
        if (b.col < startCol || b.col > endCol) continue;
        const def = getBuildingDef(b.typeId);
        ctx.fillText(def.glyph, b.col * ts + ts * 0.5, b.row * ts + ts * 0.62);
      }
    }
  }

  private drawBuilding(
    b: Building,
    def: ReturnType<typeof getBuildingDef>,
    x: number,
    y: number,
    ts: number
  ) {
    const ctx = this.ctx;
    // Inset so building doesn't touch tile edges
    const pad = ts * 0.15;
    const w = ts - pad * 2;
    const h = ts - pad * 2;
    const px = x + pad;
    const py = y + pad;

    if (def.category === "service") {
      // Circular well/service icon
      ctx.fillStyle = def.fillColor;
      ctx.strokeStyle = def.roofColor;
      ctx.lineWidth = ts * 0.06;
      ctx.beginPath();
      ctx.arc(x + ts * 0.5, y + ts * 0.5, w * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      return;
    }

    // House / production: walls + roof
    const wallH = h * 0.6;
    const roofH = h * 0.45;

    // Drop shadow under building
    ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
    ctx.beginPath();
    ctx.ellipse(x + ts * 0.5, y + ts * 0.92, w * 0.42, h * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();

    // Walls
    ctx.fillStyle = def.fillColor;
    ctx.fillRect(px, py + roofH * 0.55, w, wallH);
    // Subtle wall outline
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py + roofH * 0.55, w, wallH);

    // Roof (triangle)
    ctx.fillStyle = def.roofColor;
    ctx.beginPath();
    ctx.moveTo(px - w * 0.06, py + roofH * 0.6);
    ctx.lineTo(px + w * 0.5, py);
    ctx.lineTo(px + w + w * 0.06, py + roofH * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Tier indicator: gold dot for high-class manors
    if (b.typeId === "house_high") {
      ctx.fillStyle = "#ffd84a";
      ctx.shadowColor = "rgba(255, 200, 50, 0.8)";
      ctx.shadowBlur = ts * 0.12;
      ctx.beginPath();
      ctx.arc(x + ts * 0.5, py - h * 0.08, ts * 0.07, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
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

    const bodyColor =
      tier === "peasant" ? "#A18262" :        // Mud/Brown Tunic
      tier === "noble"   ? "#8A2BE2" :        // Royal Purple
                           "#8A2BE2";         // King uses Noble base
    const headColor = "#F2C9A0";              // Skin tone (shared)

    // Body rectangle (rounded shoulders for polish)
    c.fillStyle = bodyColor;
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

  /**
   * Phase 3 / 4: Draw all citizens within the visible tile bounds as
   * humanoid sprites (pre-rendered head+body buffer + live-drawn legs).
   * State icons (halo, rogue ring, dead rotation) are layered on top.
   */
  private renderCitizens(
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number
  ) {
    const ctx = this.ctx;
    const ts = this.state.grid.tileSize;
    const cam = this.state.camera;
    if (this.state.citizens.length === 0) return;

    this.ensureNpcSprites();

    // Sub-second pulse for halo / rogue shimmer / leg gait
    const t = performance.now() / 1000;
    const radius = ts * 0.18; // legacy radius — kept for path-line spacing

    for (const c of this.state.citizens) {
      const pos = getCitizenVisualPos(c);
      // Cull off-screen (with 1-tile margin so we don't pop in/out at edges)
      if (pos.row < startRow - 1 || pos.row > endRow + 1) continue;
      if (pos.col < startCol - 1 || pos.col > endCol + 1) continue;

      const cx = pos.col * ts + ts * 0.5;
      const cy = pos.row * ts + ts * 0.5;

      /* ---------- Pathfinding hint lines (drawn under sprite) ---------- */
      if (c.state === "SEEK_FOOD" && c.targetTile && cam.zoom > 0.6) {
        const tx = c.targetTile.col * ts + ts * 0.5;
        const ty = c.targetTile.row * ts + ts * 0.5;
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
        const tx = c.targetTile.col * ts + ts * 0.5;
        const ty = c.targetTile.row * ts + ts * 0.5;
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

      // Pick the buffer for this NPC's tier
      const sprite = this.npcSprites.get(c.socialTier) ?? this.npcSprites.get("peasant")!;
      const sw = sprite.width;
      const sh = sprite.height;
      // Anchor: feet centered at (cx, cy + ts*0.32). Sprite origin top-left.
      const dx = cx - sw / 2;
      const dy = cy + ts * 0.32 - sh;

      const isMoving =
        c.state === "MOVING" || c.state === "SEEK_FOOD" || c.state === "ROGUE";
      const isDead = c.state === "DEAD";

      // Leg color matches body for cohesion
      const legColor =
        c.socialTier === "peasant" ? "#6E5440" :
        c.socialTier === "noble"   ? "#5A1B95" :
                                     "#5A1B95";
      const legW = ts * 0.10;
      const legH = ts * 0.14;
      const legY = cy + ts * 0.18;
      // Alternating gait: phase shifts by NPC id-hash so they don't march in lockstep
      const gaitPhase = c.hue * 0.05;
      const swing = isMoving ? Math.sin(t * 8 + gaitPhase) : 0;
      const offsetA = swing * ts * 0.06;
      const offsetB = -offsetA;

      /* ---------- DEAD: rotated 90° + 0.4 alpha for the WHOLE figure ---------- */
      if (isDead) {
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI / 2);
        ctx.translate(-cx, -cy);
        ctx.drawImage(sprite, dx, dy);
        // Static (non-swinging) legs while dead
        ctx.fillStyle = legColor;
        ctx.fillRect(cx - legW - ts * 0.01, legY, legW, legH);
        ctx.fillRect(cx + ts * 0.01, legY, legW, legH);
        ctx.restore();
        continue;
      }

      // Legs (drawn first so body overlaps the tops cleanly)
      ctx.fillStyle = legColor;
      ctx.fillRect(cx - legW - ts * 0.01, legY + offsetA, legW, legH);
      ctx.fillRect(cx + ts * 0.01,        legY + offsetB, legW, legH);

      // Body + head sprite
      ctx.drawImage(sprite, dx, dy);

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
  private get worldW() { return this.state.grid.cols * this.state.grid.tileSize; }
  private get worldH() { return this.state.grid.rows * this.state.grid.tileSize; }

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

  private start() {
    this.lastFrameTime = performance.now();
    this.lastSaveTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  private loop = (now: number) => {
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;

    this.tickTime(dt);
    this.tickCitizenMovement(dt);
    this.tickCombat(dt);
    this.tickSparks(dt);
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
    for (const c of all) {
      updateCitizenMovement(c, dtMs, ts, buildings, all, civ);
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
    ctx.translate(-cam.x, -cam.y);

    const startCol = Math.max(0, Math.floor(cam.x / ts));
    const endCol = Math.min(
      grid.cols - 1,
      Math.ceil((cam.x + W / cam.zoom) / ts)
    );
    const startRow = Math.max(0, Math.floor(cam.y / ts));
    const endRow = Math.min(
      grid.rows - 1,
      Math.ceil((cam.y + H / cam.zoom) / ts)
    );

    const useTextures = cam.zoom > 0.35;
    const edgeWidth = Math.max(2, ts * 0.18);

    // Pass 1: base tile fills (with cached texture patterns)
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const tile = grid.tiles[r][c];
        const px = c * ts;
        const py = r * ts;

        if (useTextures) {
          const pat = this.biomePatterns.get(tile.type);
          if (pat) {
            ctx.fillStyle = pat;
            ctx.save();
            ctx.translate(px, py);
            ctx.fillRect(0, 0, ts, ts);
            ctx.restore();
          } else {
            ctx.fillStyle = TILE_COLORS[tile.type];
            ctx.fillRect(px, py, ts, ts);
          }
        } else {
          ctx.fillStyle = TILE_COLORS[tile.type];
          ctx.fillRect(px, py, ts, ts);
        }
      }
    }

    // Pass 2: auto-tile biome transitions (uses pre-baked cached strips)
    if (cam.zoom > 0.4) {
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const tile = grid.tiles[r][c];
          const px = c * ts;
          const py = r * ts;

          if (r > 0) {
            const n = grid.tiles[r - 1][c];
            const tc = getTransitionColor(tile.type, n.type);
            if (tc) ctx.drawImage(this.getTransitionStrip(tc, "t"), px, py);
          }
          if (r < grid.rows - 1) {
            const n = grid.tiles[r + 1][c];
            const tc = getTransitionColor(tile.type, n.type);
            if (tc) ctx.drawImage(this.getTransitionStrip(tc, "b"), px, py + ts - edgeWidth);
          }
          if (c > 0) {
            const n = grid.tiles[r][c - 1];
            const tc = getTransitionColor(tile.type, n.type);
            if (tc) ctx.drawImage(this.getTransitionStrip(tc, "l"), px, py);
          }
          if (c < grid.cols - 1) {
            const n = grid.tiles[r][c + 1];
            const tc = getTransitionColor(tile.type, n.type);
            if (tc) ctx.drawImage(this.getTransitionStrip(tc, "r"), px + ts - edgeWidth, py);
          }
        }
      }
    }

    // Pass 3: water bloom highlight
    if (this.waterHighlight && cam.zoom > 0.5) {
      ctx.globalCompositeOperation = "lighter";
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          if (grid.tiles[r][c].type !== "water") continue;
          ctx.drawImage(this.waterHighlight, c * ts, r * ts);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    }

    // Pass 4: subtle tile borders for definition (only when zoomed in)
    if (cam.zoom > 1.2) {
      ctx.lineWidth = 0.5 / cam.zoom;
      for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
          const tile = grid.tiles[r][c];
          ctx.strokeStyle = TILE_BORDER_COLORS[tile.type] + "40";
          ctx.strokeRect(c * ts, r * ts, ts, ts);
        }
      }
    }

    // Pass 5: buildings (autonomous AI placements)
    this.renderBuildings(startRow, endRow, startCol, endCol);

    // Pass 5.5: citizens (NPCs walking the world)
    this.renderCitizens(startRow, endRow, startCol, endCol);

    // Phase 4: combat sparks (drawn above citizens, still in world space)
    this.renderSparks();

    ctx.restore();

    // Pass 6: vignette overlay
    this.buildVignette();
    if (this.vignetteGradient) {
      ctx.fillStyle = this.vignetteGradient;
      ctx.fillRect(0, 0, W, H);
    }
  }

  public setTimeScale(scale: 0 | 1 | 2) {
    this.state.time.timeScale = scale;
  }

  /**
   * Phase 4: Convert a screen-space tap to world-space and find the closest
   * living citizen within a tap-tolerant radius. Hitboxes are larger than the
   * sprite so mobile fingers reliably hit a target even at low zoom.
   */
  private handleTap(clientX: number, clientY: number) {
    if (!this.callbacks.onCitizenTap) return;
    const rect = this.canvas.getBoundingClientRect();
    const cam = this.state.camera;
    const ts = this.state.grid.tileSize;
    // Screen → world
    const wx = (clientX - rect.left) / cam.zoom + cam.x;
    const wy = (clientY - rect.top) / cam.zoom + cam.y;

    // Tap tolerance: at least one tile of slop, more at low zoom — and a hard
    // 24px screen-space minimum so fingers can always reach a target.
    const tileTol = ts * 0.7;
    const screenMinTol = 24 / cam.zoom; // 24px finger pad
    const tol = Math.max(tileTol, screenMinTol);

    let best: Citizen | null = null;
    let bestDist = tol;
    for (const c of this.state.citizens) {
      if (c.state === "DEAD") continue;
      const pos = getCitizenVisualPos(c);
      const cx = pos.col * ts + ts * 0.5;
      const cy = pos.row * ts + ts * 0.5;
      const d = Math.hypot(wx - cx, wy - cy);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (best) {
      this.callbacks.onCitizenTap({
        citizen: best,
        screenX: clientX - rect.left,
        screenY: clientY - rect.top,
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
