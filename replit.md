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

### Phase 15 — Visual Spec Override (Dark Royal theme + procedural detail)
Concept-art override pass — premium hand-illustrated isometric look. Adds five visual layers without touching simulation, perf, or save format.

- **Procedural terrain clutter** baked into the cached `terrainLayer` (zero per-frame cost). `drawTerrainClutter` runs inside `rebuildTerrainLayer`'s tile loop and uses a deterministic mulberry32 RNG seeded by `(row, col)` — same tile always renders the same scatter, never flickers on rebuild (meteor / architect brush). Biome pools:
  - `grass`: white/yellow wildflowers, pebble clusters with highlights, grass tufts, occasional saplings.
  - `forest`: pine saplings (triangle canopy + trunk), moss patches, mossy pebbles.
  - `desert`: bleached rocks, dry tufts.
  - `snow`: snow drifts with shadow rim, dark twigs.
  - Skipped on water/mountain/crater — those biomes already have full-tile texture.
  - Each prop is rejection-sampled to stay inside the diamond footprint (`|dx|/(ts/2) + |dy|/(ts/4) ≤ 0.82`) so it never bleeds into neighbor tiles when the layer is blitted.
- **Interior furniture stamps** in `drawBuildingFloor` → `drawInteriorFurniture`. Drawn on the FLOOR layer (sortKey −0.10) so it sits BEHIND the citizen sprite (sortKey +0.01) but inside the back wall (sortKey −0.05), giving the dollhouse cutaway a furnished interior whenever the roof fades to 0.25α. Per-building variants:
  - `residential` (house_free/middle/high): bed (frame + mattress + pillow) + wooden table. `house_high` flips `ornate=true` for gold-trimmed bed and a gold goblet on the table.
  - `tavern`: bar counter with three mugs + barrel with two iron bands.
  - `apothecary`: two potion shelves with green/red/blue vials + mortar & pestle.
  - `dungeon`: iron-bar grate (4 vertical bars in a frame) + straw pile + iron manacle ring.
  - `production farm/bakery`: stack of three grain sacks + wheat sheaf.
  - `production mine`: dark ore chunk pile with a tiny gleam + pickaxe leaning on the wall.
  - `production lumber_camp`: stack of three logs with tree-ring marks on the visible end.
  - Generic `service` fallback: simple bench (safety net for future service buildings).
  - **Warning**: the building-type switch is gated on the real `BuildingId` union — DO NOT add `else if (t === "house" | "mill" | "quarry" | "lumber" | "church" | "temple")` branches; those IDs do not exist and TS will fail with TS2367. The full union is in `types.ts` line 164: `house_free | house_middle | house_high | farm | bakery | lumber_camp | mine | well | dungeon | apothecary | tavern`.
- **King royal cape** added to `buildCompositeSprite` when `c.isKing` (only the actual king, not queens / dowagers — keeps his silhouette unmistakable). Crimson trapezoid drape (wider at the bottom) with gold trim down both edges, ermine collar (white fur band with 5 black tail spots), gold sash diagonal across the chest. **Critical**: after drawing the collar band, the body silhouette is RE-filled with the existing `grad` linear gradient (still in scope from the earlier body draw) below the collar so the tunic stays visible — moving the cape draw block above the body fill or out of `buildCompositeSprite` will break this and the king's torso will go solid white.
- **Dark Royal CSS theme** — `:root` now defines `--royal-gold / --royal-gold-dim / --royal-gold-bright / --royal-charcoal{,-2,-3} / --royal-parchment{,-2} / --royal-ink` color tokens. Re-skinning the whole HUD is a one-block edit.
  - `body { font-family: "Cormorant Garamond", "EB Garamond", "Cinzel", Georgia, serif }` — sets the elegant serif as the UI default.
  - `.hud-time / .hud-resources / .hud-needs / .time-controls`: charcoal vertical-gradient backgrounds with single gold border + inset gold inlay + heavier black drop-shadow. NO backdrop-filter — the parchment/wood texture is the depth.
  - `.hud-date`: Cinzel small-caps in `--royal-gold-bright`. `.resource-val / .need-val`: Cinzel tabular-nums in `--royal-parchment`. `.needs-title`: Cinzel small-caps + gold underline.
  - `.hud-needs::before / ::after`: ornate gold corner brackets (top-left + bottom-right, 14×14 with 2px gold borders on two sides).
  - `.time-btn.active`: gold gradient + bright gold border + soft gold glow — replaces the previous white-on-glass active state.
- **Royal Chronicle parchment scroll** — new classes `.royal-chronicle / .chronicle-title / .chronicle-entry / .chronicle-year / .chronicle-text`. Background is a stacked radial+linear gradient producing aged parchment (#d8bf91 → #b89860 with bottom darkening). Border is a 3px dark-wood outer frame + inset 1px gold inlay + inset 30px brown vignette. Title is Cinzel small-caps in dark charcoal with light-cream text-shadow (looks embossed on parchment). Years are small-caps Cinzel; entry text is italic Cormorant. Custom thin gold scrollbar.
  - Chronicle JSX in `App.tsx` was refactored from inline styles to these classes — DO NOT re-introduce inline `background:` / `color:` props on the `<div className="royal-chronicle">` or you'll override the parchment.
- **Hunger spawn verified clean** — `npc.ts:198 hunger: 0`, `civilization.ts:55 hunger: { value: 0, ... }`. Screenshot confirms Civic Needs Hunger = 0 at year 1. No bug.

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

### Phase 16 — Living World & VFX Overhaul (terrain seasonality + fauna + divine VFX polish)
Visual fidelity pass on top of Phase 15. **Five new visual layers, no simulation impact, no save-format change beyond the new `animals` field.** Measured at 57 FPS on the same baseline as Phase 15.

- **Seasonal terrain palette** — `getTileColorsForSeason(season)` and `getTileSpecklesForSeason(season)` in `types.ts` return per-biome `Record<TileType, string>` palettes that swap the grass/forest base tints (and clutter speckle pools) across SPRING/SUMMER/AUTUMN/WINTER. `buildBiomePatterns(season)` rebuilds the biome pattern cache + assigns `liveTileColors` whenever the season changes. `simulateMonth()`'s season-change branch calls `buildBiomePatterns(liveSeason)` AND sets `terrainDirty = true` so the cached `terrainLayer` is regenerated with the new palette on the next frame. **Critical**: `liveTileColors` is the single source of truth used inside `rebuildTerrainLayer` (`g.fillStyle = pat || this.liveTileColors[tile.type]`) — never inline `TILE_COLORS` there or seasonal switching breaks silently.
- **Mountain cliffs + water foam baked into terrain** — both run inside `rebuildTerrainLayer`'s tile loop (zero per-frame cost, lives in the cached layer image).
  - `drawMountainCliff(g, ts, row, col)` — clips to the diamond, paints a darker south-facing triangle with a 2-stop linear gradient, then 2-3 jagged crack strokes seeded by `(row, col)` (deterministic) and a top-ridge highlight.
  - `drawWaterFoam(g, ts, grid, row, col)` — 4-neighbor land check (N/E/S/W via the actual iso-projection mapping: top-right diamond edge = `(row-1, col)` neighbor, NOT visual N), draws an inner bright foam stroke + outer haze along each abutting edge.
- **Animated water surface** — `drawAnimatedWater(ctx, ts, cam)` runs each frame between the terrain blit and the entity queue. Iterates ALL water tiles (rejects by iso-projected camera bounds), capped at 96 paints/frame, draws 2 sine-displaced quadratic strokes per tile keyed by `waterAnimPhase + (r, c)` so adjacent tiles ripple out of sync. `waterAnimPhase` advances per real-frame ms in the loop (independent of `timeScale` — water keeps moving when paused, intentional). All strokes batched into a single `ctx.beginPath()/stroke()` for efficiency.
- **Divine impact VFX** — every `spawnLightning(x, y)` call (smite citizen, smite building, meteor) now ALSO triggers (a) the same screen-wide white flash that thunderstorms use (`lightningFlashUntilMs`) and (b) a 350ms screen shake at 6px amplitude (`screenShakeUntilMs` + `screenShakeIntensity`). Pre-Phase-16 the flash only fired from THUNDERSTORM weather rolls. Shake is applied as `ctx.translate(shakeDx / cam.zoom, ...)` BEFORE the camera translate so jitter is in screen-space px (zoom-independent), with linear ease-out by remaining time.
- **Bless light shafts** — `lightShafts: { x, y, until, born }[]` field. `blessCitizen` pushes one shaft at the iso-projected NPC chest height, lifetime 900ms with ease-out fade. `renderLightShafts(ctx, ts)` draws each as a 6-tile-tall trapezoidal beam (narrow top → wide foot) with a vertical golden gradient (`rgba(255,230,140) → rgba(255,200,90)`) using `globalCompositeOperation = "lighter"` so the shaft blooms additively over particles. Drawn AFTER `renderSparks` so the rising motes appear silhouetted INSIDE the beam. Shafts are GC'd in the loop tail by filtering on `until > nowMs`.
- **Speed vignette + thunderstorm darkening** — when `timeScale === 2`, render() draws a second radial gradient pass (`rgba(0,0,0,0)` → `rgba(0,0,0,0.32)`) on top of the baseline vignette to telegraph fast-forward with tunnel-vision feel. `renderWeatherFx` draws a `rgba(15,25,50,0.32)` cool-blue rect BEFORE rain/snow particles when `currentWeather === "THUNDERSTORM"` so candlelit windows + lightning bolts pop against a properly stormy sky.
- **Sheep fauna** — `Animal { id, kind: "sheep", row, col, targetRow, targetCol, progress, dir, nextWanderMs, grazingUntilMs }` in `types.ts`; new `state.animals: Animal[]` field on `GameState`. Sheep wander on `grass`/`forest` tiles using a simple lerp (no pathfinder): pick a random adjacent grass/forest tile every 2-5s, lerp `progress 0→1` at ~1.6s/tile @ 1× (`stepProgressPerMs = 0.000625 * speedMul`). Speed scales with `timeScale` — at 0× sheep crawl at 0.25× rather than freezing, so paused worlds still feel alive. Render as a fluffy white oval body + 3 wool tufts + 4 dark legs + dark head whose offset depends on `dir` (0=N, 1=E, 2=S, 3=W). Eye dot drawn for E/W/S facing only. Pushed into the scene queue at `sortKey = visRow + visCol + 0.005` — BELOW citizens (`+0.01`) so an NPC walking past one draws on top correctly.
- **Storage v12** — `CURRENT_VERSION 11 → 12`. `spawnInitialAnimals(grid, count)` exported helper picks N random grass/forest tiles. `createDefaultState` seeds 10 sheep; `loadState` migration list extended (v2-v11 → v12) and the rebuild block uses `Array.isArray(s.animals) ? s.animals : spawnInitialAnimals(grid, 10)` so old saves backfill but v12+ saves preserve persisted herd identity. Save block writes `state.animals ?? []`.
- **Phase 16 critical invariants**:
  - `buildBiomePatterns(season)` MUST be called from the constructor AND from `simulateMonth`'s season-change branch. Without the constructor call, `liveTileColors` keeps the SUMMER fallback even though the actual season may be WINTER on first load.
  - Sheep `grazingUntilMs` is only checked inside `drawSheep` (head dip) and `tickAnimals` (idle gating). Don't reuse it as a "paused" flag elsewhere or you'll freeze sheep mid-step.
  - `lightShafts` is filtered in the LOOP tail, not inside `renderLightShafts` — keeping the render pass pure-read prevents reentrancy bugs if the render is ever called twice in a frame (e.g. screenshot capture).
  - Screen shake's `ctx.translate(shakeDx / cam.zoom, ...)` divide-by-zoom is essential — without it, shake amplitude scales with zoom and feels seasick at zoom 2.0×.
  - **`loadState` citizen hydration MUST list every accepted version** — when bumping `CURRENT_VERSION`, ALSO add the previous version to the `s.version === N` chain inside the citizen-restore branch (line ~314 of `storage.ts`). The v12 bump originally omitted `s.version === 11` and v11 saves silently fell through to `spawnInitialCitizens`, wiping the entire population on upgrade. The migration gate at the top of `loadState` accepting a version is NOT enough — citizens, buildings, animals, etc. each have their own restore branch, and any branch that omits the previous version will reset that subsystem. Architect-flagged ship blocker, fixed before release.

## Phase 17 — Master VFX & Ecosystem Override
Built on top of Phase 16. All five spec items shipped without breaking the 60 FPS budget. Phase 16 baseline was 57 FPS, Phase 17 holds at ~58 FPS warm.

- **True 3D extruded cliffs** — `drawCliffExtrusion` runs as a SECOND pass after every tile in `rebuildTerrainLayer` is filled. Each mountain tile's south-east and south-west diamond edges are extruded vertically downward by `ts*0.40`, painting parallelogram cliff faces over any non-mountain neighbor below. SE face uses a brighter sun-hit gradient (`#7a8290 → #363a42`); SW face uses a shaded gradient (`#5d6470 → #22252b`). Two horizontal stratification bands per face for stone texture, plus a dark seam down the south-vertex ridge. Faces hide when the corresponding lower-neighbor is also a mountain (no painting on contiguous peaks). The whole extrusion is BAKED into the cached terrainLayer — zero per-frame cost.
- **Animated 3-frame coastline foam** — `drawAnimatedFoam` replaces the Phase-16 baked `drawWaterFoam` call. Per-frame, iterates only visible water tiles (cap 96), three batched stroke passes (outer haze / mid / inner crest), with frame index `Math.floor(waterAnimPhase / (2π/3)) % 3` brightening one of the three layers each frame. Synced to the same `waterAnimPhase` the water surface uses, so foam pulses in time with the wave overlay. Measured cost: <0.3ms per frame.
- **Wolf fauna** — `AnimalKind` widened to `"sheep" | "wolf"`. `drawWolf` renders gray angular silhouette with elongated body, perked triangle ears (always visible), pointed snout (E/S/W), bushy tail, yellow predator eyes. Wolves and sheep share `tickAnimals` wandering logic and the same depth-sorted scene queue (`sortKey + 0.005`). Renderer dispatches via `animal.kind === "wolf" ? drawWolf : drawSheep`.
- **Sheep at 50% adult-human size + 2-frame graze loop** — `bodyW = ts * 0.21` (citizen `bodyW = ts * 0.42`, exact 50%). Body height, leg dimensions, and head radius scaled proportionally. While `grazingUntilMs > now`, head alternates between "down strong dip" (`+ts*0.045`) and "up small lift" (`-ts*0.005`) every 500ms via `Math.floor(now/500) % 2` — reads as a real bobbing graze, not a frozen pose.
- **Smite VFX upgrade** — `spawnLightning` now starts the bolt at `cam.y - ts*0.5` (top of camera viewport in world coords) so the bolt visibly enters from off-screen sky. Bumped to 14 jagged segments with `(1 - t*0.5)` jitter taper (chaotic at top, clean at impact). Screen shake bumped to 500ms / 7px (was 350ms / 6px). Both `smiteCitizen` and `smiteBuilding` now flip the target tile to `crater` texture and call `redrawTerrainTile` — the spec's "scorched_earth" effect, reusing the existing crater palette.
- **Bless beam color + 2-second particles** — `renderLightShafts` gradient normalized to spec gold: `rgba(255, 215, 0, *)` at every stop, with peak alpha `0.40 * t` (ease-out). Bless particles bumped from 18 sparks @ 700ms to 12 sparks @ 2000ms, with stronger upward bias (`-0.025*ts` baseline vy) and gentler radial spread, reading as a sustained holy aura instead of a quick puff.

### Phase 17 critical invariants
- **Cliff extrusion MUST run in a separate post-pass**, not inside the per-tile loop. Iso row-major iteration draws row r before row r+1, and the extrusion extends DOWN past the diamond into row r+1's footprint — if drawn inside the loop, the next row's tile fill would overpaint the cliff. The `drawCliffExtrusion` second pass after all tile fills guarantees the extrusion is the LAST thing drawn at the cliff's location.
- **`drawAnimatedFoam` and `drawAnimatedWater` share the same 96-tile cap**. Both are independent per-frame iterations, so the worst-case combined budget is 96 + 96 = 192 visible water tiles touched per frame. On a 100×100 grid with typical maps this is fine; if a future grid scales up, consider a shared visible-water-tile precompute.
- **`AnimalKind` widening to `"sheep" | "wolf"` is FORWARD-COMPATIBLE for v12 saves** — old serialized animals all have `kind: "sheep"` so they parse cleanly. The migration path injects 4 fresh wolves into the existing herd (preserving every persisted sheep's id/position/grazing state). Don't ever try to "wolfify" an existing sheep on migration — that would break sheep identity continuity.
- **CURRENT_VERSION bumps MUST update both the migration gate AND every per-subsystem restore branch.** Phase 17 bumped 12 → 13 and added `s.version === 12` to the migration gate (line ~334) AND to the citizen-restore branch (line ~346). Skipping the second add would silently wipe the v12 citizen population on Phase 17 upgrade.
- **Smite scorch reuses the `crater` tile type, not a new "scorched_earth" type.** `crater` already has the burnt-black palette + matching speckle/border colors and is supported by every renderer pass. Adding a new tile type would require palette overrides in every season's `getTileColorsForSeason` etc. — high cost for visually identical result.

## Phase 18 — UI/UX Refinement & Screen Real Estate Recovery
Pure UI polish, zero gameplay changes. Goal: surface-area reduction so the world is the focal point.

- **Royal Chronicle relocated** (Phase 17b started this, Phase 18 finalized) — moved from top-right to BOTTOM-right corner (`bottom: 80px, right: 14px`), 20vw width with `min/max-width: 200/280px` clamp, `max-height: 25vh` so it never eats more than a quarter of the screen. Background is `rgba(20,20,20,0.6)` with `backdrop-filter: blur(2px)` so the world reads through. Slim 4px webkit scrollbar (was 6px). Visible entry cap dropped 6 → 5 in BOTH `App.tsx` paths (the `onTimeUpdate` callback at line ~217 AND the initial-mount effect at line ~236) — miss either and one of the two state-sync paths leaks the old cap.
- **Chronicle minimize/expand toggle** — `chronicleMinimized` React state + a "❖ / ✦" gold-leaf button on the title bar. When minimized: `.royal-chronicle.minimized { max-height: 36px; padding: 6px 12px; overflow: hidden }` + `.chronicle-title { border-bottom: none }`. The entry list is conditionally rendered (`!chronicleMinimized && chronicle.map(...)`) so React unmounts the entry DOM nodes entirely when collapsed (cheaper than display:none for long histories).
- **Civic Needs panel collapsed by default** — only the primary `Hunger` row is visible; the other 5 needs (Safety/Social/Vanity/Faith/Leisure) are `.need-row.secondary` with `display: none` when the panel has the `.collapsed` class. Both `:hover` (CSS) and click (`needsExpanded` React state → `.expanded` class) reveal the secondary rows. Click toggles a pin so touch users can keep it open. The panel keeps its 60% scale (`transform: scale(0.6)` with `transform-origin: left center` from Phase 17b) so it stays anchored to the left edge.
- **Pointer-events fix** — `.hud-needs` was `pointer-events: none` (Phase 15 default for HUD overlays), which would have blocked the new hover/click toggle. Phase 18 flips it to `pointer-events: auto` and keeps the panel small enough (~110×80px collapsed at 0.6 scale) that the lost map area is negligible. The "pointer-events: none on transparent areas" spec applies to the GAPS between panels, not the panels themselves.
- **Background opacity bump** — both `.hud-needs` and `.royal-chronicle` moved from `rgba(20,20,20,0.5)` (Phase 17b) → `rgba(20,20,20,0.6)` (Phase 18) for slightly stronger contrast against busy world backgrounds without losing the see-through quality.

## Phase 19 — "Townsmen" Quality Overhaul & Balance Patch
Visual fidelity pass + a deliberate balance change to make the realm more forgiving of brief food shortages.

- **Hunger drain `* 3` → `* 1.2`** in `civilization.ts` line ~160 — exactly 60% reduction per spec. Pre-Phase-19 a brief 3-unit bread deficit added 9 points/month to civic hunger; now it adds 3.6. Combined with the Phase 11 `* 8 → * 3` cut, the realm has roughly 7× the original headroom to construct farms/bakeries before civic hunger crosses 80. Citizens still individually starve at the per-NPC drain rate (`npc.ts`); only the civic panel rate is softened. NO migration needed — value is read live each tick.
- **+25% canvas saturation** — `.game-canvas { filter: saturate(1.25) }`. CSS `filter` is GPU-composited so it has zero render-loop cost; UI panels stack ABOVE the canvas in DOM order so they're unaffected. Greens now read as rich emerald, terracotta deserts pop, water tints are deeper blue.
- **Tilt-shift miniature effect** — two `.tilt-shift-band` divs (top-15% / bottom-15% of the viewport) absolutely positioned over the canvas with `backdrop-filter: blur(2.5px)` and a `mask-image: linear-gradient(... black 40%, transparent 100%)` so the blur fades smoothly to crisp at the centre band. `pointer-events: none` so map clicks pass through unchanged. The effect frames the centre of the screen as the "in-focus" subject of a miniature toy set diorama. `z-index: 1` so HUD panels (no z-index, default) and the toolbar (positioned children) all paint above it.
- **Custom Divine Cursor reticle** — `.game-root[data-active-power="..."] .game-canvas { cursor: url(...svg...) 16 16, crosshair }` for each of the 3 active powers (`architect`, `judge`, `wrath`). Each SVG is inline-encoded as a data URI (no extra HTTP requests, picks up power's palette colour: green / gold / red). `data-active-power={activePower}` is set on `.game-root` from React state, so the cursor swaps the moment a power button is clicked. When no power is active the default `grab` cursor remains.
- **Letter glyph removal** — both center category letters (the white "F" / "B" / "H" rendered when zoom > 0.7) AND the well's center letter overlay are gone from `GameEngine.ts` (lines ~1131 and ~1701). The Phase-14 special-building badges with halos remain because they use ICONOGRAPHIC symbols (`‖` for dungeon, `+` for apothecary, `🍺` for tavern), not letter placeholders. Building identity now flows entirely from silhouette, roof color, door/window detail, and the per-NPC speech bubbles (which keep their `fillText` since they're dialogue, not labels).

### Phase 19 critical invariants
- **Hunger constant lives in `civilization.ts:160` ONLY.** There's no `HUNGER_DRAIN_PER_DAY` named constant; the multiplier is inline in the `if (breadEaten < breadDemand)` branch. Don't search for a const that doesn't exist — change the inline `* 1.2` if you ever need to retune.
- **`.game-canvas { filter: saturate(...) }` MUST be on the canvas itself, not on `.game-root`.** Putting the filter on the parent would also apply it to UI panels (oversaturated red dissent badges, neon-yellow chronicle gold). The canvas-only scope keeps the saturation purely on the rendered world.
- **Tilt-shift bands use `backdrop-filter` not `filter`.** `filter: blur()` would only blur the band's own background (transparent → no effect). `backdrop-filter` blurs what's BEHIND the band (the canvas pixels) which is what we actually want. Safari requires the `-webkit-` prefix on both `backdrop-filter` and `mask-image`.
- **Letter glyph removal preserved the iconographic badges** for tavern/dungeon/apothecary because removing those would break the only above-roof identifier those special buildings have. If you ever add a new building "category" letter, route it through the badge system (halo + icon glyph) rather than re-introducing a center-tile letter overlay.
- **Custom cursor SVG hotspots are at (16, 16)** — the centre of the 32×32 viewBox. If you change the SVG size, update the hotspot to match or the click point will drift from the visible reticle centre.

## Data Persistence
Storage is versioned (currently v13) with backward compatibility for older saves (v2-v12 migrate cleanly). New fields are backfilled during state loading (`normalizeCitizens`, `spawnInitialAnimals`). Critical clock invariants are maintained for real-time driven events.

# External Dependencies

-   **PostgreSQL**: Relational database for storing game state.
-   **Drizzle ORM**: Object-relational mapper for interacting with PostgreSQL.
-   **Zod**: Schema declaration and validation library, used for API validation and type inference.
-   **Orval**: OpenAPI spec code generator for generating API hooks and Zod schemas.
-   **Express**: Web application framework for the API server.