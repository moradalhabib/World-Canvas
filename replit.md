# Overview

This project is a pnpm workspace monorepo for a God Simulator web game using TypeScript. The game features a canvas-rendered medieval setting where players manage a civilization on a tiled biome map. The primary goal is to deliver a complex simulation game with detailed civic management, dynamic environmental elements, and intricate NPC behaviors, combining strategic oversight with emergent gameplay. The long-term vision includes expanding simulation depth with features like crime, medicine, and leisure, continuously refining visual and systemic fidelity.

# User Preferences

I prefer iterative development and want to be asked before making major changes.

# System Architecture

## Core Technologies
- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **Package Manager**: pnpm
- **TypeScript**: 5.9
- **API Framework**: Express 5
- **Database ORM**: Drizzle ORM
- **Validation**: Zod
- **API Codegen**: Orval (from OpenAPI spec)
- **Build Tool**: esbuild

## Game Engine & Rendering
The game utilizes a TRUE 2:1 dimetric isometric projection for rendering, inspired by Age of Empires. It features diamond-shaped tiles with precise pick math, per-frame depth-sorting based on `row + col`, and accurate sprite anchoring for buildings and citizens. Terrain is rebuilt on an offscreen canvas upon changes. The rendering system includes:
- **Dollhouse Render**: Buildings are composed of three depth-sorted layers (floor, back-structure, front+roof) to interleave with citizens. Roofs become transparent (`roofAlpha = 0.25`) when an NPC is on the tile.
- **Visual Overhaul**: Incorporates premium hand-illustrated isometric aesthetics with procedural terrain clutter, interior furniture stamps for buildings, and a unique royal cape for the King.
- **VFX Overhaul**: Implements seasonal terrain palettes, animated water surfaces with foam, divine impact VFX (screen flash, shake), blessing light shafts, and speed vignettes.
- **3D Extruded Cliffs**: Mountain tiles feature vertically extruded cliff faces baked into the terrain layer.
- **Fauna**: Includes animated sheep and wolves with wandering logic and grazing animations.
- **UI/UX**: Features an inspect modal for citizen details, HUD elements for season/weather, and state-specific overlays (chatting bubbles, mental break glyphs, sick aura). The UI adopts a "Dark Royal" CSS theme with elegant serifs and gold accents, including a Royal Chronicle parchment scroll. UI panels like the Chronicle and Civic Needs are designed for minimal screen real estate usage, with collapse/expand functionality and backdrop filters for transparency. The canvas uses a saturation filter and tilt-shift effect for a "miniature" feel. Custom power-specific cursors are implemented.

## Game Logic & NPC AI
The game simulates civic needs, hunger, and complex NPC state machines. Key logic features include:
- **Genetics**: Citizens inherit surnames and traits.
- **Psychology**: Dynamic `Citizen.mood` system with mental break states (DOOMSAYER, RECLUSE, THIEF) triggered by low mood.
- **Rumor Mill**: A throttled system for spreading rumors and contagion among chatting NPCs.
- **State Machines**: Critical invariants ensure correct handling of NPC states, particularly for CHATTING and MENTAL_BREAK.
- **Climate & Ecosystem Engine**: Dynamic seasons and weather influencing gameplay and NPC mood. Includes a particle engine for weather VFX.
- **Living City Expansion**: Adds `morality`, `health`, and `leisure` mechanics, new NPC states (STEALING, ARRESTING, IMPRISONED, HEALING, DRINKING), and associated buildings (dungeon, apothecary, tavern). This includes crime, law enforcement, a medical engine with contagion, and a leisure system.
- **Cognitive Engine**: Implements state+trait-driven thought libraries for NPCs (`buildThought`, `actionLabel`) and reactive AI responses (PANIC from divine smite, ADMIRE from divine bless) which reuse existing FLEEING states or modify `admireUntilMs` timers.
- **Balance Changes**: Adjusted hunger drain to be more forgiving.

## Character Animation & Visual Progression
Citizen rendering includes:
- **Limb Animation**: Beefier, higher-contrast limbs with distinct foot rects and increased swing amplitude for walking.
- **Gestures**: CHATTING NPCs perform a talking gesture (arm bob), and WORKING specialists exhibit a focus pulse (arm dip).
- **Accessories**: The King has a unique gold drop-shadow. Builder-type specialists (without other professions) are shown with a hammer accessory. Mastery skill ≥ 5 (but < 10) gets a subtle gold halo on the profession tool — telegraphing rising mastery before they reach the gold/diamond tool tier at L10.
- **Badge System**: Replaced all text-based overhead indicators on NPCs with pure shape badges for states like alert, recluse, thief, imprisoned, healing, and drinking.

## Phase 21 — Masterpiece Integration: Life, Growth & Construction
- **Faster Generational Pace**: `ADULT_AGE` lowered 18 → 5. Lifecycle is now infant 0-2, child 2-5, adult 5-60, elder 60+. Dynasties now turn over on a Townsmen-style timescale instead of real-decades.
- **Immigration**: New `tryImmigration()` in `royalty.ts` runs once per game-year. When the realm's average citizen mood ≥ 80 AND ≥ 3-5 game-years (deterministic per-window jitter) have elapsed since the last wave, 1-3 already-adult Grade-1 peasants spawn at a random grass tile on the map edge with a Chronicle entry: "Travelers drawn by our prosperity have arrived." `GameState.lastImmigrationYear` tracks the cooldown (storage v14 backfill anchors it to the current game-year so older saves don't get a free wave on load).
- **Construction Scaffolding**: New `Building.complete` and `Building.constructionWorkMs` fields. Newly placed buildings start as scaffolded foundations — they produce nothing, house nobody, and contribute zero need-satisfaction until a per-frame accumulator (`tickConstruction`) credits 30,000 ms of cumulative living-citizen presence on the tile. Completion logs a Chronicle entry. Production/housing iteration in `civilization.ts` skips incomplete buildings entirely. Storage v14 migration backfills `complete:true` on every legacy building so existing realms don't freeze.
- **Scaffolding Visual**: Incomplete buildings render as a dark-dirt foundation diamond + four wooden corner posts + crossing horizontal scaffold beams + a gold construction progress bar at the foundation's leading edge. Wall + roof rendering is fully suppressed for incomplete builds.
- **Half-Timbered Buildings**: Residential and service building front walls now feature dark-wood Tudor-style beams — two vertical edge beams, a horizontal mid-girt, and a diagonal cross brace on the left half. Production buildings keep the plain plank look so the silhouettes still differentiate.
- **Tilt-Shift + Saturation**: Already shipped in Phase 19 (`index.css` lines 53-85): two soft `backdrop-filter: blur(2.5px)` bands on the top + bottom 15% of the canvas, plus `filter: saturate(1.25)` on the canvas. Spec confirmed match.

## Phase 20.6 — Dynasty & Biology
- **Infant LifeStage**: New "infant" tier (ages 0..2) added to `LifeStage` union. `getLifeStage` is now a 4-way classifier (infant / child / adult / elder). Constants live in `royalty.ts` (`INFANT_AGE = 2`, `ADULT_AGE = 18`, `ELDER_AGE = 60`).
- **Infant Render**: Drawn as a swaddled bundle (cream ellipse + pink head, no limbs, no overlays). Bypasses the composite sprite + limb pipeline via an early-out branch in `drawSingleCitizen`. Wrapped in its own `ctx.save()/restore()` so the fillStyle/strokeStyle changes don't leak into the next NPC.
- **Infant Behavior**: Skipped by `tickEconomyAndFaction` and `tickCitizenMonth`. Path/pathIndex/progress are zeroed on every brain tick so the baby stays at the spawn tile (their parent's location). Hunger never rises for infants — per spec they "drain parent energy" rather than eating their own ration.
- **Reproduction Gating**: `tryCivilianReproduction` (in `royalty.ts`) now requires both parents to have mood ≥ 40 AND be within 3 tiles of a house (the relaxed "in-the-same-House-at-NIGHT" check). Breed chance bumped 0.4 → 0.85, per-year cap 2 → 3 so the population actually grows.
- **Birth Chronicle**: Reworded to user spec — `A new soul, [Name] [LastName], has joined the realm of King [KingName].` Pulls the king name via `findKing()`.
- **Hunger Pacing**: `HUNGER_RISE_PER_MONTH` 6 → 2, `HUNGER_RISE_JITTER` 4 → 2. Net reduction vs Phase 1 baseline ≈ 73%. Reproduction can outpace starvation under typical food + housing setups.
- **Composite Sprite Cache**: `subtleGlowTier` (level 5..9 band) is now part of the cache signature at bit 13, so a 4→5 levelup correctly invalidates and rebuilds the cached sprite with the new gold halo. Prior versions only tracked the master tier (≥10) and would silently miss the L5 transition until an unrelated change forced eviction.

## Data Persistence
Game state is stored and versioned, with backward compatibility migrations for older saves. New fields are backfilled during state loading. Reactive timers (`panicUntilMs`, `admireUntilMs`) are stored as wall-clock timestamps on the Citizen object, designed to be harmlessly false if stale from older saves, thus avoiding the need for version bumps for these specific features.

# External Dependencies

-   **PostgreSQL**: Relational database.
-   **Drizzle ORM**: For database interaction.
-   **Zod**: For schema declaration and validation.
-   **Orval**: For OpenAPI spec code generation.
-   **Express**: For the API server.