/**
 * Phase 20 — SoundManager
 *
 * A thin event-bus singleton for game-side audio hooks. We do NOT ship any
 * SFX assets in this phase — the manager simply logs each event so that:
 *
 *   1. Gameplay code can be wired against the API today (no second-pass
 *      "go-back-and-add-sound-calls" refactor when assets land).
 *   2. The browser devtools console is a usable audio "preview" today
 *      (you can scroll the log to see when smites fired, when buildings
 *      finished, when an NPC leveled up).
 *   3. Replacing each `console.debug` with a real `audio.play()` is a
 *      single-line edit per event when the SFX assets arrive.
 *
 * Intentional design choices:
 *   - Singleton (not DI) so non-engine modules (npc.ts) can fire events
 *     without threading a manager handle through every signature.
 *   - All methods are no-throw — audio failures must NEVER crash the
 *     simulation. Each handler is `try/catch`-wrapped.
 *   - `setEnabled(false)` makes every method an O(1) early-return; useful
 *     for headless tests and for a future user "mute" toggle.
 */
export class SoundManager {
  private static _instance: SoundManager | null = null;
  static get instance(): SoundManager {
    if (!SoundManager._instance) SoundManager._instance = new SoundManager();
    return SoundManager._instance;
  }

  private enabled = true;

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  /** Fired when divine lightning strikes (NPC smite OR building smite OR meteor). */
  onSmite(detail?: { x?: number; y?: number; victim?: string }) {
    if (!this.enabled) return;
    try {
      console.debug("[SFX] smite", detail ?? {});
      // TODO Phase 20+: this.play(this.sfx.smite, { volume: 0.9 });
    } catch {
      /* swallow — audio must never crash the sim */
    }
  }

  /** Fired when an NPC's profession skill ticks up (e.g. Farmer reaches level 4). */
  onLevelUp(detail?: { name?: string; profession?: string; level?: number }) {
    if (!this.enabled) return;
    try {
      console.debug("[SFX] level-up", detail ?? {});
      // TODO Phase 20+: this.play(this.sfx.levelUp, { volume: 0.6 });
    } catch {
      /* swallow */
    }
  }

  /** Fired when a building finishes construction and is ready to use. */
  onBuildingComplete(detail?: { typeId?: string; row?: number; col?: number }) {
    if (!this.enabled) return;
    try {
      console.debug("[SFX] building-complete", detail ?? {});
      // TODO Phase 20+: this.play(this.sfx.buildingComplete, { volume: 0.7 });
    } catch {
      /* swallow */
    }
  }

  /** Fired when divine bless / heal lands on an NPC. */
  onBless(detail?: { name?: string }) {
    if (!this.enabled) return;
    try {
      console.debug("[SFX] bless", detail ?? {});
    } catch {
      /* swallow */
    }
  }
}

/** Convenience accessor for non-class modules (npc.ts etc.). */
export const sound = SoundManager.instance;
