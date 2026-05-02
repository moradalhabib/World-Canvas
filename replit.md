# Overview

This project is a pnpm workspace monorepo utilizing TypeScript for a God Simulator web game. The game features a canvas-rendered medieval setting where players oversee a civilization on a tiled biome map. The project aims to develop a complex simulation game with detailed civic management, dynamic environmental elements, and intricate NPC behaviors.

The core vision is to create an engaging simulation experience that combines strategic oversight with emergent gameplay, driven by sophisticated NPC AI and a living, breathing game world. Future ambitions include expanding the simulation depth with features like crime, medicine, and leisure, and continuously refining the visual and systemic fidelity.

# User Preferences

I prefer iterative development and want to be asked before making major changes.

# System Architecture

## Core Technologies
- **Monorepo**: pnpm workspaces
- **Node.js**: 24
- **Package Manager**: pnpm
- **TypeScript**: 5.9
- **API Framework**: Express 5
- **Database**: PostgreSQL with Drizzle ORM
- **Validation**: Zod (v4) with `drizzle-zod`
- **API Codegen**: Orval (from OpenAPI spec)
- **Build Tool**: esbuild (CJS bundle)

## Game Engine & Rendering
The game uses a TRUE 2:1 dimetric isometric projection for rendering, similar to Age of Empires. Tiles are diamond polygons, and a critical pick math ensures accurate tile selection by mapping integer (col, row) values to tile centers using `Math.round` for inverted coordinates. Depth-sorting is implemented per-frame based on `row + col`, allowing NPCs to draw on top of buildings. Sprite anchoring is precisely defined for buildings and citizens. Terrain is rebuilt on an offscreen canvas, triggered by a `terrainDirty` flag. All visual effects are projected through `worldToIso`.

## Game Logic & NPC AI
The game simulates civic needs, hunger, and complex NPC state machines, including royalty bloodlines and dynastic events. Key features include:

-   **Genetics**: Citizens inherit surnames and traits (50/50 chance from parents).
-   **Psychology**: `Citizen.mood` is a dynamic value (0-100) affected by hunger, safety, skills, and passive regeneration. Low mood can trigger "MENTAL_BREAK" states like DOOMSAYER, RECLUSE, or THIEF, each with trait-driven behaviors.
-   **Rumor Mill**: A throttled system (`ONCE PER ~1000 ms`) for spreading rumors and contagion between chatting NPCs, affecting dissent and faith.
-   **State Machines**: Critical invariants ensure correct handling of NPC states, particularly for CHATTING and MENTAL_BREAK states, preventing perpetual loops or incorrect state transitions.
-   **Climate & Ecosystem Engine**: Introduces `Season` and `WeatherKind` with dynamic transitions and effects. Weather rolls at dawn, influencing crop production, movement speed, and mood. A particle engine handles weather VFX (rain, snow, lightning) with performance considerations. Lightning strikes can traumatize NPCs, forcing them to flee.
-   **Living City Expansion**: Adds `morality`, `health`, and `leisure` to citizens. Introduces new `CitizenState`s (STEALING, ARRESTING, IMPRISONED, HEALING, DRINKING) and `BuildingId`s (dungeon, apothecary, tavern). Implements crime and law enforcement, a medical engine with contagion mechanics, and a leisure system centered around taverns.
-   **Phase 14 critical invariants** (post-architect fixes):
    -   `updateCitizenMovement` arrival branch must auto-resolve `ARRESTING` and `HEALING` INLINE (mirroring the existing STEALING handler) before falling through to the IDLE reset. Without inline resolution the guard/doctor loses `arrestTargetId` / patient link and the resolution is delayed by a full game-month. The monthly `tickCrimeAndLaw` / `tickDoctors` remain as the safety net for interrupted paths.
    -   `startChat` must snapshot `chatPrevState = "DRINKING"` for tavern patrons pulled into rumor-mill chats; the CHATTING expiry branch in `updateCitizenMovement` must restore from `chatPrevState` (default IDLE). Without this a DRINKING patron flips to CHATTING and back to IDLE within seconds and never receives the monthly `+10 mood / -30 leisure` restore, silently breaking the tavern mechanic.
    -   `runRumorMill` accepts DRINKING in its eligible set — any future "in-place social" state must be added there too or the tavern accelerator silently skips those NPCs.

## UI/UX
The UI includes an inspect modal showing detailed citizen information (name, micro-state, mood bar) and HUD elements displaying current season and weather with emojis. Overlays for citizen states (chatting bubbles, mental break glyphs, sick aura, state-specific glyphs for new states like STEALING) are rendered with specific zoom-level visibility. Building signs are rendered for new building types.

### Phase 14b — Dollhouse Render (layered buildings + transparent roofs)
- Buildings (except wells and rubble) are now composed of three depth-sorted layers that interleave with citizens in the scene queue:
  - **Floor** at `sortKey = row + col − 0.10` — a wood/stone iso-diamond plank floor sized to the building footprint. Drop shadow is drawn here.
  - **Back-structure** at `sortKey = row + col − 0.05` — back-wall strip + right-side iso parallelogram (everything that visually sits behind the NPC).
  - **Citizen** at `sortKey = row + col + 0.01` — unchanged.
  - **Front+roof** at `sortKey = row + col + 0.50` — front wall, door, full gable roof, shingle texture, glyph badges, manor gold accent, night-window glow, and the center category letter glyph.
- The front+roof layer wraps the roof draw block in `ctx.save() / globalAlpha = roofAlpha / restore()`. `roofAlpha = 0.25` when an NPC stands on the building's tile, otherwise `1.0`. The front wall, glyph badges, manor accent, and category letter stay fully opaque so the building remains identifiable in cutaway mode.
- Occupancy is computed once per frame via a `Set<"row,col">` of all non-DEAD citizens, keyed on each citizen's LOGICAL tile (`c.row`, `c.col`) rather than their interpolated visual position. This gives the cutaway natural hysteresis — the roof opens the moment an NPC commits to a building tile and stays open until they've fully stepped off, avoiding any per-frame flicker as the visual sprite slides across a tile edge. O(N_citizens) build, O(1) lookup per building.
- `drawSingleBuilding` is now used ONLY for wells (round, no roof) and rubble (no layering). All other buildings push three queue entries directly from the render loop and skip `drawSingleBuilding` entirely.
- Building scale was bumped from `pad = ts * 0.15` (≈70% tile width) to `pad = ts * 0.07` (≈86% tile width) so houses fill their tile substantially. Floor/back/front methods all share this constant — change in one place to keep the layers aligned.
- Future renderer changes: any new building type that follows the iso-house silhouette must work with all three layered methods. New service buildings without a roof (like the well) need to be added to the `isLegacyCombined` predicate in the render loop.

## Data Persistence
Storage is versioned (currently v11) with backward compatibility for older saves. New fields are backfilled during state loading (`normalizeCitizens`). Critical clock invariants are maintained for real-time driven events.

# External Dependencies

-   **PostgreSQL**: Relational database for storing game state.
-   **Drizzle ORM**: Object-relational mapper for interacting with PostgreSQL.
-   **Zod**: Schema declaration and validation library, used for API validation and type inference.
-   **Orval**: OpenAPI spec code generator for generating API hooks and Zod schemas.
-   **Express**: Web application framework for the API server.