/**
 * Phase 22 — Sprite Asset Pre-Loader
 * Phase 23 — Era-keyed AssetSkinMap (evolutionary asset packs)
 *
 * Loads era-keyed PNG sprite paths into HTMLImageElement instances BEFORE
 * the game loop ever asks for them, so the renderer can blit
 * `ctx.drawImage(...)` without ever stalling on a network request mid-frame
 * (which would manifest as flicker / popping).
 *
 * Phase 23 introduces era-based skinning: instead of a flat "house" sprite,
 * the renderer asks for `Assets[currentEra].buildings.house_free`. Drop a
 * PNG into `public/assets/<era>/buildings/<typeId>.png` and the matching
 * entity in that era will swap to the sprite. Eras with no PNGs on disk
 * silently fall through to the existing procedural rendering — visual
 * state is preserved 1:1.
 *
 * Asset URLs are resolved against `import.meta.env.BASE_URL` so the same
 * manifest works whether the artifact is mounted at "/" (the current
 * configuration) or at a sub-path (future multi-artifact moves).
 */

import type { Era } from "./types";

/** Per-asset load state. `pending` means the Image is in-flight. */
export type AssetStatus = "pending" | "ready" | "failed";

/**
 * Per-era skin: a flat dictionary of `entity-key → relative public path`.
 *
 * Keys are stable strings the renderer uses at draw time, prefixed by
 * the entity family:
 *   - `building.<typeId>`     (e.g. building.house_free, building.farm)
 *   - `character.<role>`      (e.g. character.king, character.peasant)
 *   - `environment.<kind>`    (e.g. environment.tree, environment.wolf)
 *
 * The full sprite cache key the AssetManager stores internally is
 * `<era>::<key>` — namespaced by era so the same `building.house_free`
 * entity has a distinct PNG per era (a stone-age hut, a medieval cottage,
 * an industrial brick row-house).
 */
export type SpriteSkin = Record<string, string>;

/**
 * Phase 23 — AssetSkinMap. The MEDIEVAL skin is fully populated; STONE_AGE
 * and INDUSTRIAL are reserved as empty slots so future asset packs slot in
 * with zero engine changes (just drop PNGs + add path entries here).
 *
 * Path convention: `assets/<era>/<family>/<entity>.png`
 *   - On disk: `artifacts/god-sim/public/assets/medieval/buildings/farm.png`
 *   - URL:     `${BASE_URL}assets/medieval/buildings/farm.png`
 */
export const ASSET_SKIN_MAP: Record<Era, SpriteSkin> = {
  MEDIEVAL: {
    /* Phase 7 (Hi-Fi sprite drop) — three real PNGs live at the root
     * `assets/` path. They override the era-namespaced placeholders
     * below so the renderer picks them up automatically. The remaining
     * placeholder paths still 404 (no sprite on disk → AssetManager
     * flips status=failed → renderer falls through to procedural). */
    "building.house_free": "assets/house_4.png",
    "environment.tree":   "assets/tree_3.png",
    /* Phase 7 — base ground tile sprite, blitted into the cached
     * terrainLayer for every "land" biome (grass / desert / snow).
     * Forest, water, mountain, and crater keep their procedural fills
     * because the asphalt diamond would erase their distinctive look. */
    "environment.ground": "assets/asphalt.png",
    /* Buildings (one per BuildingId in buildings.ts) */
    "building.house_middle": "assets/medieval/buildings/house_middle.png",
    "building.house_high": "assets/medieval/buildings/house_high.png",
    "building.farm": "assets/medieval/buildings/farm.png",
    "building.bakery": "assets/medieval/buildings/bakery.png",
    "building.lumber_camp": "assets/medieval/buildings/lumber_camp.png",
    "building.mine": "assets/medieval/buildings/mine.png",
    "building.well": "assets/medieval/buildings/well.png",
    "building.tavern": "assets/medieval/buildings/tavern.png",
    "building.church": "assets/medieval/buildings/church.png",
    "building.apothecary": "assets/medieval/buildings/apothecary.png",
    "building.dungeon": "assets/medieval/buildings/dungeon.png",
    /* Characters (per social tier + life stage + royalty) */
    "character.peasant": "assets/medieval/characters/peasant.png",
    "character.noble": "assets/medieval/characters/noble.png",
    "character.king": "assets/medieval/characters/king.png",
    "character.queen": "assets/medieval/characters/queen.png",
    "character.child": "assets/medieval/characters/child.png",
    "character.infant": "assets/medieval/characters/infant.png",
    /* Environment / fauna */
    "environment.sheep": "assets/medieval/environment/sheep.png",
    "environment.wolf": "assets/medieval/environment/wolf.png",
  },
  // Reserved era slots — empty until a future asset pack ships. The
  // renderer will harmlessly fall through to procedural drawing for any
  // era whose skin has no entry for the requested key.
  STONE_AGE: {},
  INDUSTRIAL: {},
};

/**
 * Anchor point for sprite blits. ISO PNGs are conventionally drawn
 * anchored at their bottom-center so the sprite "stands" on the iso
 * diamond's center-bottom point. Default for every key — overrides can be
 * added per-key here as the asset library grows.
 */
export type SpriteAnchor = "bottom-center" | "center" | "top-left";

const ANCHOR_OVERRIDES: Record<string, SpriteAnchor> = {
  // Phase 7 — the ground tile sprite is the iso diamond ITSELF, so
  // bottom-center would push it down to "stand on" the diamond instead
  // of filling it. Use top-left so the bake pass can place it exactly
  // at the diamond's bounding-box origin.
  "environment.ground": "top-left",
};

export function anchorFor(key: string): SpriteAnchor {
  return ANCHOR_OVERRIDES[key] ?? "bottom-center";
}

/** Internal cache key — namespaces the entity key by era. */
function cacheKey(era: Era, key: string): string {
  return `${era}::${key}`;
}

/**
 * Phase 22/23 AssetManager. Single instance per GameEngine.
 *
 * Lifecycle:
 *   1. constructor() — instantiate, then call `preload(ASSET_SKIN_MAP)`.
 *      preload schedules every PNG across every era; the game loop starts
 *      immediately and every `get()` / `has()` call returns null/false
 *      until the corresponding Image fires `onload`. No frame is ever
 *      blocked.
 *   2. Each draw call hits `has(era, key)` first — if true, blit the
 *      image; else call the procedural fallback. Era is sourced from
 *      `state.currentEra` so the moment the EraController flips, every
 *      subsequent frame asks for the new era's skin without any other
 *      bookkeeping.
 *
 * Failed loads (404, decode error) are silently flipped to "failed" and
 * never retried — `has()` keeps returning false and the renderer keeps
 * using the procedural path. This is the intended Phase 22/23 fallback
 * behavior pre-asset-drop.
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
   * Schedule async load of every entry across every era's skin.
   * Idempotent — calling twice is a no-op. Returns immediately; loads
   * complete in the background as the browser fetches each PNG.
   */
  preload(skinMap: Record<Era, SpriteSkin> = ASSET_SKIN_MAP): void {
    if (this.preloadStarted) return;
    this.preloadStarted = true;
    for (const era of Object.keys(skinMap) as Era[]) {
      const skin = skinMap[era];
      for (const [key, relativePath] of Object.entries(skin)) {
        this.loadOne(era, key, relativePath);
      }
    }
  }

  private loadOne(era: Era, key: string, relativePath: string): void {
    const ck = cacheKey(era, key);
    if (this.status.has(ck)) return;
    this.status.set(ck, "pending");
    const img = new Image();
    img.onload = () => {
      this.status.set(ck, "ready");
      this.images.set(ck, img);
    };
    img.onerror = () => {
      // Phase 22/23 ships with NO PNGs on disk, so every initial load
      // fires this branch. Quiet — the fallback IS the intended behavior
      // pre-asset-drop. Status flips to "failed" so `has()` short-circuits
      // to the procedural fallback forever (no retries).
      this.status.set(ck, "failed");
    };
    // Strip any leading slash on the relative path so concatenation with
    // BASE_URL (which always ends in "/") produces exactly one slash.
    const clean = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
    img.src = this.baseUrl + clean;
  }

  /** True only when the era-specific image is fully decoded and ready to blit. */
  has(era: Era, key: string): boolean {
    return this.status.get(cacheKey(era, key)) === "ready";
  }

  /** Returns the loaded HTMLImageElement for (era, key), or null if not ready. */
  get(era: Era, key: string): HTMLImageElement | null {
    return this.has(era, key) ? (this.images.get(cacheKey(era, key)) ?? null) : null;
  }

  /**
   * Convenience: try to blit (era, key) at iso ground tile (x, y, ts).
   * Returns true if the sprite was drawn (caller should skip its
   * procedural fallback), false if not ready (caller draws the fallback).
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
    era: Era,
    key: string,
    x: number,
    y: number,
    ts: number,
  ): boolean {
    const img = this.get(era, key);
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
        // Phase 7: top-left anchor draws the sprite at exactly (x, y)
        // sized w×h preserving the source aspect ratio. Used for the
        // ground tile sprite which IS the iso diamond and needs to
        // fill its bounding box rather than "stand on" it. The bake
        // pass passes (-ts/2, -ts/4) so the diamond's bounding box
        // origin lines up with the canvas origin after translate.
        // For the ground sprite specifically, we override h to ts/2
        // (the diamond's bbox height) to avoid any vertical scaling
        // surprise from a non-2:1 source PNG.
        dx = x;
        dy = y;
        if (key === "environment.ground") {
          ctx.drawImage(img, dx, dy, ts, ts / 2);
          return true;
        }
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

/* ─────────────────────────────────────────────────────────────────────
 * Phase 23 — Era-flavored cognitive thoughts (sabertooth vs. wolf, etc.)
 *
 * Tiny helper that returns era-appropriate flavor strings the chat-bubble
 * / cognitive-state system can plug in. Phase 23 wires the API but no
 * runtime call site uses it yet — it's exported so the next pass over
 * NPC chat lines can flip from hardcoded "wolf" to `predatorNoun(era)`.
 * Future phases extend with more vocabulary buckets.
 * ───────────────────────────────────────────────────────────────────── */

export function predatorNoun(era: Era): string {
  switch (era) {
    case "STONE_AGE": return "sabertooth";
    case "INDUSTRIAL": return "stray dog";
    case "MEDIEVAL":
    default: return "wolf";
  }
}

export function dwellingNoun(era: Era): string {
  switch (era) {
    case "STONE_AGE": return "hut";
    case "INDUSTRIAL": return "row-house";
    case "MEDIEVAL":
    default: return "cottage";
  }
}

export function rulerNoun(era: Era): string {
  switch (era) {
    case "STONE_AGE": return "chieftain";
    case "INDUSTRIAL": return "magnate";
    case "MEDIEVAL":
    default: return "king";
  }
}
