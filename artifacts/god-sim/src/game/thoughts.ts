/**
 * Phase 20 — Cognitive Engine: Thought Library
 *
 * Replaces the Phase-4 single-line `buildMonologue` ladder with a richer
 * library that picks a thought based on:
 *
 *   1. Royalty / faction (King, Queen, Heir, Rebel) — strongest narrative
 *      signal, always wins.
 *   2. Acute reactive state — PANIC (after a nearby smite), ADMIRE (after
 *      a nearby bless), MENTAL_BREAK, COMBAT, FLEEING, IMPRISONED.
 *   3. Behavioural state — SLEEPING, WORKING, CHATTING, SEEK_FOOD,
 *      DRINKING, PRAYING, ROGUE.
 *   4. Need pressure — extreme hunger, low safety, high vanity.
 *   5. Profession flavour — Farmer / Miner / Guard / Priest / Healer.
 *   6. Quiet wandering default keyed on TRAIT (Coward, Zealot, Greedy,
 *      Diligent) so even the "nothing happening" thought varies by
 *      personality.
 *
 * Each branch returns an array of candidate lines; we pick deterministically
 * via a citizen-id seed so the same NPC keeps the same thought between
 * 5-second refresh ticks (no flicker if the modal stays open). The seed
 * also rotates with the in-game minute so the line evolves over time.
 */

import type { Citizen, CitizenTrait } from "./types";

/** Cheap deterministic 32-bit hash of a string. */
function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Pick a line from `arr` deterministically using the seed. */
function pick(arr: readonly string[], seed: number): string {
  return arr[seed % arr.length];
}

// ── Royalty + faction (always wins) ────────────────────────────────────
const KING_LINES = [
  "The crown weighs heavy. My subjects must remember their place.",
  "Every road, every wheat-field — mine to shepherd.",
  "Let the chroniclers note: I built this realm with my own hands.",
] as const;
const DOWAGER_LINES = [
  "I rule until my son is grown. Let no one forget it.",
  "A regent's word is the King's word, until it isn't.",
] as const;
const QUEEN_LINES = [
  "A queen's smile must never falter, no matter the winter.",
  "He needs me more than he admits. Let him learn it slowly.",
] as const;
const HEIR_LINES = [
  "Father trains me for the throne. The day will come.",
  "I have studied the maps. I am ready.",
] as const;
const REBEL_LINES = [
  "The true bloodline is broken. We march at dawn.",
  "Better a free death than a fed slavery.",
  "When the gates fall, history will name us.",
] as const;
const ROYALIST_LINES = [
  "The King's favour shines on me. I will not waste it.",
  "Long may the Crown reign. My loyalty is a sword.",
] as const;

// ── Acute reactive states (Phase 20 net-new) ───────────────────────────
const PANIC_LINES_GENERAL = [
  "The sky has eyes! Run, run!",
  "It strikes from nowhere! Where is shelter?",
  "We are not safe. We are NEVER safe.",
] as const;
const PANIC_LINES_COWARD = [
  "I knew it would come for me first. I knew it!",
  "Hide. Hide and the gods will forget my name.",
] as const;
const PANIC_LINES_ZEALOT = [
  "We are judged! Repent, repent before the next bolt!",
  "The Heavens are wrathful — what offering will appease them?",
] as const;
const ADMIRE_LINES_GENERAL = [
  "The Heavens are watching us.",
  "Did you see the light? It chose someone among us.",
  "A blessing falls — my heart steadies.",
] as const;
const ADMIRE_LINES_ZEALOT = [
  "Behold! The divine touches the earth — let us kneel.",
  "Praise! Praise! The Heavens favour our realm.",
] as const;

// ── Behavioural states ─────────────────────────────────────────────────
const COMBAT_LINES = [
  "For the realm! Steel meets steel!",
  "One more swing — for those at home!",
] as const;
const FLEEING_LINES = [
  "Faster, faster — they're behind me!",
  "I won't die here. Not today.",
] as const;
const SLEEPING_LINES = [
  "Mmh… the bed is warm tonight.",
  "Tomorrow there will be more work. Tomorrow…",
] as const;
const WORKING_LINES = [
  "Good steady work. Good steady wages.",
  "The realm needs hands like mine.",
  "Sweat now, eat tonight.",
] as const;
const CHATTING_LINES = [
  "Did you hear what the miller said?",
  "Tell me again — and slowly this time.",
  "It's been so long since we talked.",
] as const;
const SEEK_FOOD_LINES = [
  "If the bakery is empty I'll weep right there in the street.",
  "Just a heel of bread. Anything.",
] as const;
const DRINKING_LINES = [
  "One more cup — and then truly home, I swear it.",
  "The ale here is honest, at least.",
] as const;
const PRAYING_LINES = [
  "Heavens, deliver us. The bread is gone.",
  "Hear me — if not for me, then for my children.",
] as const;
const ROGUE_LINES = [
  "If they will not feed us, we will take what we are owed.",
  "The lock is old. The night is long.",
] as const;
const IMPRISONED_LINES = [
  "Stone walls and iron — I deserved better than this.",
  "How many days now? I've stopped counting.",
] as const;
const HEALING_LINES = [
  "Hold still. The poultice will sting before it soothes.",
  "Another patient. Another quiet prayer.",
] as const;
const MENTAL_BREAK_LINES_DOOMSAYER = [
  "The end is at the gates! Listen to me!",
  "I have seen what comes — and you laugh!",
] as const;
const MENTAL_BREAK_LINES_RECLUSE = [
  "Leave me. Just leave me alone.",
  "The world is too loud. Too loud.",
] as const;
const MENTAL_BREAK_LINES_THIEF = [
  "It will not be missed. Not really.",
  "Nimble fingers — that's all it takes.",
] as const;

// ── Need pressure ──────────────────────────────────────────────────────
const HUNGER_LINES = [
  "The granaries are empty. We will not survive the winter.",
  "I dreamt of bread last night. Just bread.",
] as const;
const VANITY_LINES = [
  "My estates grow larger by the day.",
  "Let the peasants gawk. Let them.",
] as const;
const HOMELESS_LINES = [
  "I have not slept beneath a roof in weeks.",
  "The wind finds every gap in the cloth.",
] as const;

// ── Profession flavour ─────────────────────────────────────────────────
const PROF_LINES: Record<string, readonly string[]> = {
  Guard: ["My watch never ends.", "A still post is a safe post."],
  Farmer: [
    "The wheat grows tall this year — praise the King.",
    "Every furrow is a coin in next year's purse.",
  ],
  Miner: [
    "Stone for the King's walls — every day, every hour.",
    "The deep is cold but the deep is honest.",
  ],
  Priest: ["The Heavens are listening. Are you?", "Ten prayers before dusk. No fewer."],
  Healer: ["More fevers this season. The herbs run thin.", "A steady hand saves more than a sharp blade."],
};

// ── Trait-keyed wandering defaults ─────────────────────────────────────
const TRAIT_DEFAULTS: Record<CitizenTrait, readonly string[]> = {
  Coward: [
    "Did I hear a wolf? It sounded close…",
    "The shadows are longer than they were yesterday.",
    "Best to keep to the lit paths.",
  ],
  Zealot: [
    "The seasons turn because the Heavens will it so.",
    "Every step is a small prayer.",
    "The realm is sacred. The King is sacred.",
  ],
  Greedy: [
    "I could ask for double. Yes — double.",
    "A coin saved is a coin earned. A coin stolen is two.",
    "What is HE wearing? I want one.",
  ],
  Diligent: [
    "The seasons turn. The work continues.",
    "If it is worth doing, it is worth doing twice.",
    "There is always more to be done before sunset.",
  ],
};
const DEFAULT_LINES = [
  "The seasons turn. The work continues.",
  "Quiet day. Long day.",
] as const;

/**
 * Phase 20: build a state + trait-aware thought line for an NPC.
 *
 * @param c       the citizen
 * @param tickKey opaque rotation seed — pass `gameMonth` (or any value
 *                that changes every 5s of in-game time) so the line
 *                evolves over time without flickering each render.
 */
export function buildThought(c: Citizen, tickKey = 0): string {
  const seed = hash(c.id + ":" + tickKey);
  const trait: CitizenTrait = c.trait ?? "Diligent";
  const now = Date.now();

  // 1. Royalty / faction
  if (c.isKing) return pick(KING_LINES, seed);
  if (c.isDowagerQueen) return pick(DOWAGER_LINES, seed);
  if (c.isQueen) return pick(QUEEN_LINES, seed);
  if (c.isPrince) return pick(HEIR_LINES, seed);
  if (c.faction === "rebel" || c.isRebel) return pick(REBEL_LINES, seed);

  // 2. Acute reactive (Phase 20 PANIC / ADMIRE)
  if (typeof c.panicUntilMs === "number" && c.panicUntilMs > now) {
    if (trait === "Coward") return pick(PANIC_LINES_COWARD, seed);
    if (trait === "Zealot") return pick(PANIC_LINES_ZEALOT, seed);
    return pick(PANIC_LINES_GENERAL, seed);
  }
  if (typeof c.admireUntilMs === "number" && c.admireUntilMs > now) {
    if (trait === "Zealot") return pick(ADMIRE_LINES_ZEALOT, seed);
    return pick(ADMIRE_LINES_GENERAL, seed);
  }

  // 3. Behavioural state
  if (c.state === "MENTAL_BREAK") {
    if (c.breakKind === "DOOMSAYER") return pick(MENTAL_BREAK_LINES_DOOMSAYER, seed);
    if (c.breakKind === "RECLUSE") return pick(MENTAL_BREAK_LINES_RECLUSE, seed);
    if (c.breakKind === "THIEF") return pick(MENTAL_BREAK_LINES_THIEF, seed);
  }
  if (c.state === "COMBAT") return pick(COMBAT_LINES, seed);
  if (c.state === "FLEEING") return pick(FLEEING_LINES, seed);
  if (c.state === "SLEEPING") return pick(SLEEPING_LINES, seed);
  if (c.state === "PRAYING") return pick(PRAYING_LINES, seed);
  if (c.state === "ROGUE") return pick(ROGUE_LINES, seed);
  if (c.state === "IMPRISONED") return pick(IMPRISONED_LINES, seed);
  if (c.state === "HEALING") return pick(HEALING_LINES, seed);
  if (c.state === "DRINKING") return pick(DRINKING_LINES, seed);
  if (c.state === "CHATTING") return pick(CHATTING_LINES, seed);
  if (c.state === "SEEK_FOOD") return pick(SEEK_FOOD_LINES, seed);
  if (c.state === "WORKING" || c.state === "MINISTERING")
    return pick(WORKING_LINES, seed);

  // 4. Need pressure
  if (c.hunger > 80) return pick(HUNGER_LINES, seed);
  if (c.vanity > 80) return pick(VANITY_LINES, seed);
  if ((c.safety ?? 100) < 30) return pick(HOMELESS_LINES, seed);

  // 5. Royalist faction (after needs so a starving royalist doesn't say "Long live the King")
  if (c.faction === "royalist") return pick(ROYALIST_LINES, seed);

  // 6. Profession flavour
  if (c.profession && PROF_LINES[c.profession]) {
    return pick(PROF_LINES[c.profession], seed);
  }

  // 7. Trait-keyed quiet wandering default
  return pick(TRAIT_DEFAULTS[trait] ?? DEFAULT_LINES, seed);
}

/**
 * Phase 20: human-readable label for the NPC's "Current Action" — what the
 * UI shows above the thought. Shared between the tap modal and any
 * future on-screen action text.
 *
 * Adds the Phase-20 net-new PANIC and ADMIRE labels in front of the
 * existing state-based label so reactive states win when active.
 */
export function actionLabel(c: Citizen): string {
  const now = Date.now();
  if (typeof c.panicUntilMs === "number" && c.panicUntilMs > now) return "Panicking";
  if (typeof c.admireUntilMs === "number" && c.admireUntilMs > now) return "Admiring the Light";

  switch (c.state) {
    case "CHATTING": return "Socializing";
    case "MENTAL_BREAK":
      if (c.breakKind === "DOOMSAYER") return "Mental Break: Doomsayer";
      if (c.breakKind === "RECLUSE") return "Mental Break: Recluse";
      if (c.breakKind === "THIEF") return "Mental Break: Thief";
      return "Mental Break";
    case "PRAYING": return "Praying";
    case "SLEEPING": return "Sleeping";
    case "COMBAT": return "In Combat";
    case "DEAD": return "Deceased";
    case "FLEEING": return "Fleeing";
    case "SEEK_FOOD": return "Eating";
    case "ROGUE": return "Rogue";
    case "REBEL": return "Rebel";
    case "MOVING": return c.targetTile ? "Traveling" : "Wandering";
    case "WORKING": return "Working";
    case "MINISTERING": return "Ministering";
    case "STEALING": return "Stealing";
    case "ARRESTING": return "Arresting Thief";
    case "IMPRISONED": return "Imprisoned";
    case "HEALING": return "Treating Patient";
    case "DRINKING": return "At the Tavern";
    case "IDLE":
    default: return "Wandering";
  }
}
