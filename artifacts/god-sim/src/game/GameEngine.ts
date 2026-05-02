import {
  TILE_COLORS,
  TILE_BORDER_COLORS,
  TILE_SPECKLE_COLORS,
  SPECKLE_DENSITY,
  getTransitionColor,
} from "./types";
import type { GameState, TileType } from "./types";
import {
  createDefaultState,
  saveState,
  loadState,
  applyOfflineProgression,
} from "./storage";

const MAX_ZOOM = 4.0;
const SAVE_INTERVAL_MS = 10_000;
const MONTHS_PER_REAL_MS_AT_1X = 1 / 60_000;

export interface GameCallbacks {
  onTimeUpdate: (state: GameState) => void;
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

  constructor(canvas: HTMLCanvasElement, callbacks: GameCallbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.callbacks = callbacks;

    const saved = loadState();
    if (saved) {
      applyOfflineProgression(saved);
      this.state = saved;
    } else {
      this.state = createDefaultState();
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement!);
    this.resize();

    this.buildBiomePatterns();
    this.buildWaterHighlight();

    this.bindTouchEvents();
    this.bindMouseEvents();
    this.start();
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
    this.panVelX = 0;
    this.panVelY = 0;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.mouseDown) return;
    const dx = e.clientX - this.mouseLastX;
    const dy = e.clientY - this.mouseLastY;
    this.panVelX = -dx / this.state.camera.zoom;
    this.panVelY = -dy / this.state.camera.zoom;
    this.state.camera.x += this.panVelX;
    this.state.camera.y += this.panVelY;
    this.clampCamera();
    this.mouseLastX = e.clientX;
    this.mouseLastY = e.clientY;
  };

  private onMouseUp = () => { this.mouseDown = false; };
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
    this.render();

    if (now - this.lastSaveTime > SAVE_INTERVAL_MS) {
      this.save();
      this.lastSaveTime = now;
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

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

    ctx.restore();

    // Pass 5: vignette overlay
    this.buildVignette();
    if (this.vignetteGradient) {
      ctx.fillStyle = this.vignetteGradient;
      ctx.fillRect(0, 0, W, H);
    }
  }

  public setTimeScale(scale: 0 | 1 | 2) {
    this.state.time.timeScale = scale;
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
