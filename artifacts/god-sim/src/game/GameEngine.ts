import { TILE_COLORS, TILE_BORDER_COLORS } from "./types";
import type { GameState, Camera } from "./types";
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

    this.bindTouchEvents();
    this.bindMouseEvents();
    this.start();
  }

  private resize() {
    const parent = this.canvas.parentElement!;
    this.canvas.width = parent.clientWidth * window.devicePixelRatio;
    this.canvas.height = parent.clientHeight * window.devicePixelRatio;
    this.canvas.style.width = parent.clientWidth + "px";
    this.canvas.style.height = parent.clientHeight + "px";
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
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

  private bindMouseEvents() {
    const el = this.canvas;
    let mouseDown = false;
    let lastX = 0;
    let lastY = 0;

    el.addEventListener("mousedown", (e) => {
      mouseDown = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.panVelX = 0;
      this.panVelY = 0;
    });

    el.addEventListener("mousemove", (e) => {
      if (!mouseDown) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      this.panVelX = -dx / this.state.camera.zoom;
      this.panVelY = -dy / this.state.camera.zoom;
      this.state.camera.x += this.panVelX;
      this.state.camera.y += this.panVelY;
      this.clampCamera();
      lastX = e.clientX;
      lastY = e.clientY;
    });

    el.addEventListener("mouseup", () => { mouseDown = false; });
    el.addEventListener("mouseleave", () => { mouseDown = false; });

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const rect = el.getBoundingClientRect();
      const focusX = (e.clientX - rect.left) / this.state.camera.zoom + this.state.camera.x;
      const focusY = (e.clientY - rect.top) / this.state.camera.zoom + this.state.camera.y;
      this.applyZoom(factor, focusX, focusY);
    }, { passive: false });
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

    ctx.clearRect(0, 0, W, H);

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

    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const tile = grid.tiles[r][c];
        const px = c * ts;
        const py = r * ts;

        ctx.fillStyle = TILE_COLORS[tile.type];
        ctx.fillRect(px, py, ts, ts);

        if (cam.zoom > 0.5) {
          ctx.strokeStyle = TILE_BORDER_COLORS[tile.type];
          ctx.lineWidth = cam.zoom > 1 ? 0.5 : 0.25;
          ctx.strokeRect(px + 0.5, py + 0.5, ts - 1, ts - 1);
        }
      }
    }

    ctx.restore();

    this.renderDebugOverlay();
  }

  private renderDebugOverlay() {
    const ctx = this.ctx;
    const cam = this.state.camera;
    ctx.font = "12px monospace";
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(8, 8, 200, 22);
    ctx.fillStyle = "#fff";
    ctx.fillText(
      `zoom:${cam.zoom.toFixed(2)} x:${cam.x.toFixed(0)} y:${cam.y.toFixed(0)}`,
      14,
      23
    );
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
  }
}
