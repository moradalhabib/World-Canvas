import type { NeedState, NeedType } from "./types";
import { ALL_NEEDS } from "./types";

/**
 * Utility AI scoring framework.
 *
 * Each agent (or the civilization as a meta-agent) has a `Record<NeedType, NeedState>`
 * representing what it currently wants. Possible actions advertise what needs
 * they satisfy via `Partial<Record<NeedType, number>>` — the higher the number,
 * the more that need is reduced by performing the action.
 *
 * `scoreAction` returns a score combining current need urgency (value × weight)
 * with the magnitude of need satisfaction the action offers.
 */
export function scoreAction(
  needs: Record<NeedType, NeedState>,
  satisfies: Partial<Record<NeedType, number>>
): number {
  let score = 0;
  for (const need of ALL_NEEDS) {
    const satisfaction = satisfies[need] ?? 0;
    if (satisfaction <= 0) continue;
    const n = needs[need];
    // Urgency curve: needs above 50 are weighted exponentially more
    const urgency = n.value <= 50 ? n.value : 50 + (n.value - 50) * 1.8;
    score += urgency * n.weight * satisfaction;
  }
  return score;
}

/** Pick the highest-scoring action above a minimum threshold. */
export function pickBestAction<T extends { satisfies: Partial<Record<NeedType, number>> }>(
  needs: Record<NeedType, NeedState>,
  actions: T[],
  minScore = 50
): T | null {
  let best: T | null = null;
  let bestScore = minScore;
  for (const a of actions) {
    const s = scoreAction(needs, a.satisfies);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return best;
}

/** Apply per-month decay (need values rise toward 100 over time when unmet). */
export function decayNeeds(needs: Record<NeedType, NeedState>): void {
  for (const k of ALL_NEEDS) {
    const n = needs[k];
    n.value = Math.max(0, Math.min(100, n.value + n.decay));
  }
}

/** Apply satisfaction (reduce need values by their satisfaction amounts). */
export function applySatisfaction(
  needs: Record<NeedType, NeedState>,
  satisfaction: Partial<Record<NeedType, number>>
): void {
  for (const k of ALL_NEEDS) {
    const amount = satisfaction[k] ?? 0;
    if (amount <= 0) continue;
    const n = needs[k];
    n.value = Math.max(0, n.value - amount);
  }
}
