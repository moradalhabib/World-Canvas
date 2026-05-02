/**
 * Phase 22 — Sprite Asset Pre-Loader
 *
 * Loads a manifest of PNG sprite paths into HTMLImageElement instances
 * BEFORE the game loop ever asks for them, so the renderer can blit
 * `ctx.drawImage(...)` without ever stalling on a network request mid-frame
 * (which would manifest as flicker / popping).
 *
 * Phase 22 ships ONLY the pipeline — no PNG files exist on disk yet, so
 * every `Image.onerror` fires and `get()` returns null for every key. The
 * renderer then falls back to the existing procedural drawing path, which
 * means the visual state is preserved 1:1 until the user begins dropping
 * PNGs into `artifacts/god-sim/public/assets/`.
 *
 * Asset URLs are resolved against `import.meta.env.BASE_URL` so the same
 * manifest works whether the artifact is mounted at "/" (the current
 * configuration) or at a sub-path (future multi-artifact moves).
 */

/** Per-asset load state. `pending` means the Image is in-flight. */
export type AssetStatus = "pending" | "ready" | "failed";

/**
 * Sprite manifest. Keys are stable strings the renderer uses at draw
 * time (e.g. "building.house_free"). Values are PUBLIC paths under
 * `/assets/...` — Vite serves the `public/` directory at the artifact's
 * BASE_URL, so the file at `artifacts/god-sim/public/assets/buildings/
 * house_free.png` is reachable at `${BASE_URL}assets/buildings/house_free.png`.
 *
 * The keys are exhaustive across every entity type the renderer currently
 * supports, so dropping in a single PNG only swaps that one entity to a
 * sprite while everything else stays procedural.
 */
export const SPRITE_MANIFEST: Record<string, string> = {
  /* ── Buildings (one per BuildingId in buildings.ts) ── */
  "building.house_free": "assets/buildings/house_free.png",
  "building.house_middle": "assets/buildings/house_middle.png",
  "building.house_high": "assets/buildings/house_high.png",
  "building.farm": "assets/buildings/farm.png",
  "building.bakery": "assets/buildings/bakery.png",
  "building.lumber_camp": "assets/buildings/lumber_camp.png",
  "building.mine": "assets/buildings/mine.png",
  "building.well": "assets/buildings/well.png",
  "building.tavern": "assets/buildings/tavern.png",
  "building.church": "assets/buildings/church.png",
  "building.apothecary": "assets/buildings/apothecary.png",
  "building.dungeon": "assets/buildings/dungeon.png",

  /* ── Characters (per social tier + life stage + royalty) ── */
  "character.peasant": "assets/characters/peasant.png",
  "character.noble": "assets/characters/noble.png",
  "character.king": "assets/characters/king.png",
  "character.queen": "assets/characters/queen.png",
  "character.child": "assets/characters/child.png",
  "character.infant": "assets/characters/infant.png",

  /* ── Environment / fauna ── */
  "environment.tree": "assets/environment/tree.png",
  "environment.sheep": "assets/environment/sheep.png",
  "environment.wolf": "assets/environment/wolf.png",
};

/**
 * Anchor point for sprite blits. ISO PNGs are conventionally drawn
 * anchored at their bottom-center so the sprite "stands" on the iso
 * diamond's center-bottom point. Default for every key — overrides can be
 * added per-key here as the asset library grows.
 */
export type SpriteAnchor = "bottom-center" | "center" | "top-left";

const ANCHOR_OVERRIDES: Record<string, SpriteAnchor> = {
  // (none yet — every entity uses bottom-center for iso ground placement)
};

export function anchorFor(key: string): SpriteAnchor {
  return ANCHOR_OVERRIDES[key] ?? "bottom-center";
}

/**
 * Phase 22 AssetManager. Single instance per GameEngine.
 *
 * Lifecycle:
 *   1. constructor() — instantiate, then call `preload(SPRITE_MANIFEST)`.
 *      preload is fire-and-forget; the game loop starts immediately and
 *      every `get()` / `has()` call returns null/false until the
 *      corresponding Image fires `onload`. No frame is ever blocked.
 *   2. Each draw call hits `has(key)` first — if true, blit the image;
 *      else call the procedural fallback. This guarantees no flicker
 *      because we never partial-draw an unloaded sprite.
 *
 * Failed loads (404, decode error) are silently logged once and never
 * retried — the manager flips the status to "failed" so `has()` keeps
 * returning false and the renderer keeps using the procedural path.
 */
export class AssetManager {
  private images = new Map<string, HTMLImageElement>();
  private status = new Map<string, AssetStatus>();
  private baseUrl: string;
  /** True after `preload()` has at least scheduled every manifest entry. */
  private preloadStarted = false;

  constructor(baseUrl: string = "/") {
    // BASE_URL from Vite always ends with a trailing slash. Normalize so
    // we don't accidentally produce "//assets/..." when concatenating.
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  }

  /**
   * Schedule async load of every manifest entry. Idempotent — calling
   * twice is a no-op. Returns immediately; loads complete in the
   * background as the browser fetches each PNG.
   */
  preload(manifest: Record<string, string> = SPRITE_MANIFEST): void {
    if (this.preloadStarted) return;
    this.preloadStarted = true;
    for (const [key, relativePath] of Object.entries(manifest)) {
      this.loadOne(key, relativePath);
    }
  }

  private loadOne(key: string, relativePath: string): void {
    if (this.status.has(key)) return;
    this.status.set(key, "pending");
    const img = new Image();
    img.onload = () => {
      this.status.set(key, "ready");
      this.images.set(key, img);
    };
    img.onerror = () => {
      // Phase 22 ships with NO PNGs on disk, so every initial load fires
      // this branch. We log once at debug level so the console isn't
      // spammed during normal operation, and flip status to "failed" so
      // `has()` short-circuits to the procedural fallback forever.
      this.status.set(key, "failed");
      // Quiet — the fallback IS the intended behavior pre-asset-drop.
    };
    // Strip any leading slash on the relative path so concatenation with
    // BASE_URL (which always ends in "/") produces exactly one slash.
    const clean = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
    img.src = this.baseUrl + clean;
  }

  /** True only when the image is fully decoded and ready to blit. */
  has(key: string): boolean {
    return this.status.get(key) === "ready";
  }

  /** Returns the loaded HTMLImageElement, or null if not ready. */
  get(key: string): HTMLImageElement | null {
    return this.has(key) ? (this.images.get(key) ?? null) : null;
  }

  /**
   * Convenience: try to blit `key` at iso ground tile (x, y, ts). Returns
   * true if the sprite was drawn (caller should skip its procedural
   * fallback), false if not ready (caller draws the fallback).
   *
   * Aspect ratio is preserved; sprite width fills the tile and height
   * scales accordingly. Anchor controls vertical placement:
   *   - bottom-center: bottom of sprite sits on tile's bottom-center
   *     (correct for buildings, characters, trees, animals on iso diamonds)
   *   - center: sprite center == tile center (rarely useful for iso)
   *   - top-left: sprite top-left == tile top-left (debug / non-iso UI)
   *
   * The caller's existing alpha / shadow / overlay code still runs
   * AROUND this call — anything that should compose with the sprite
   * (e.g. a roof-fade alpha) should set ctx.globalAlpha before the call.
   */
  tryDraw(
    ctx: CanvasRenderingContext2D,
    key: string,
    x: number,
    y: number,
    ts: number,
  ): boolean {
    const img = this.get(key);
    if (!img) return false;
    const w = ts;
    const aspect = img.height / Math.max(1, img.width);
    const h = ts * aspect;
    const anchor = anchorFor(key);
    let dx: number, dy: number;
    switch (anchor) {
      case "bottom-center":
        dx = x + ts * 0.5 - w * 0.5;
        // Tile's "ground" line for an iso diamond sits at y + ts (bottom
        // of bounding rect); bottom-center anchor puts the sprite's foot
        // on that line.
        dy = y + ts - h;
        break;
      case "center":
        dx = x + ts * 0.5 - w * 0.5;
        dy = y + ts * 0.5 - h * 0.5;
        break;
      case "top-left":
      default:
        dx = x;
        dy = y;
        break;
    }
    ctx.drawImage(img, dx, dy, w, h);
    return true;
  }

  /** Diagnostics — useful for an in-engine HUD or dev console. */
  getStatusSnapshot(): { ready: number; pending: number; failed: number; total: number } {
    let ready = 0, pending = 0, failed = 0;
    for (const s of this.status.values()) {
      if (s === "ready") ready++;
      else if (s === "pending") pending++;
      else failed++;
    }
    return { ready, pending, failed, total: this.status.size };
  }
}
