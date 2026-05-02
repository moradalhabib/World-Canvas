# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### `artifacts/god-sim` — God Simulator (web)

A canvas-rendered medieval god-game where the player presides over a small civilization (royalty, peasants, soldiers) on a tiled biome map.

**Rendering — Phase 13 (TRUE 2:1 dimetric isometric):**
- Tiles are drawn as diamond polygons in 2:1 dimetric (Age-of-Empires) projection.
- Module-level helpers (top of `src/game/GameEngine.ts`): `worldToIso(col, row, ts, rows) → {sx, sy}` and its inverse `isoToWorld(sx, sy, ts, rows) → {col, row}`. Iso bbox utility: `isoWorldBounds(cols, rows, ts)`.
- Projection formulas: `sx = (col - row) * ts/2 + xOffset`, `sy = (col + row) * ts/4 + yOffset`, where `xOffset = (rows - 1) * ts/2 + ts/2` and `yOffset = ts/4`.
- **Pick math (CRITICAL):** integer (col, row) values map to tile **CENTERS** in iso, not NW-corners. The diamond for tile (col0, row0) spans col ∈ [col0-0.5, col0+0.5] and row ∈ [row0-0.5, row0+0.5]. `handleTap` therefore uses `Math.round` (NOT `Math.floor`) on the inverted coords. Flooring would bias every click into the NW-adjacent tile.
- **Depth-sort:** render() builds a per-frame entity queue sorted by `row + col` ascending. Buildings sort at `row + col`; citizens sort at `row + col + 0.01` so NPCs draw on top of the building they occupy.
- **Anchoring:** building sprite anchor = `(sx - ts/2, sy - ts*0.6)`; citizen foot anchor = `(sx, sy - ts*0.32)`.
- **Terrain:** `rebuildTerrainLayer` paints diamond polygons to an offscreen canvas sized to the iso bbox. Transitions/strips are skipped in Phase 13 v1 (acceptable per architect review). Meteor/architect tile changes flip a `terrainDirty` flag for a single full rebuild on next frame.
- All god-power VFX spawn sites (smiteCitizen, smiteBuilding, blessCitizen, no-target lightning, castMeteor fireburst) project through `worldToIso`.
- Storage migration: `storage.ts` v8 resets the camera on load so legacy top-down camera offsets don't strand the iso world off-screen.
- The 8-direction walk cycle / facing logic from Phase 12 is preserved verbatim — Phase 13 only changed the (cx, cy) anchor calculation.

**Game logic** (civic needs, hunger, NPC state machines, royalty bloodline, dynastic events) lives in `src/game/civilization.ts` + `src/game/npc.ts` and was **not** modified by Phase 13.

**Phase 12 — Societal Fabric Engine (genetics + psychology + rumor mill):**
- Genetics: every `Citizen` has a `lastName` from `LAST_NAMES` (in `npc.ts`). Civilian children inherit the mother's surname; royal heirs inherit the King's (the dynasty's "House Crown" / "House Iron"). Trait inheritance is 50/50 from a parent — see `inheritTrait` and `inheritLastName` in `royalty.ts`.
- Psychology: `Citizen.mood` (0–100) is updated each month inside `tickCitizenMonth`. Hunger > 80 and safety < 20 each drain 10 mood; skills.level ≥ 10 buffs +5; passive +2 regen when no stressor. At mood == 0 the NPC enters `state = "MENTAL_BREAK"` with a trait-driven `breakKind`: Zealot → DOOMSAYER (drains -1 faith from citizens within 3 tiles each month via `tickDoomsayerAura`), Coward → RECLUSE (paths home, hides for 3 months — `breakUntilMonth`), Greedy → THIEF (paths to `civ.founded`, loots 100 gold on arrival, +vanity, mood resets to 60). Diligent has no break (just bounces mood up to 25).
- Rumor Mill: `runRumorMill(state)` in `npc.ts` is gated by a `rumorAccMs` accumulator in `GameEngine.loop` to fire ONCE PER ~1000 ms (≈ 60 ticks @ 60 FPS) — DO NOT call this every frame. It bucket-hashes citizens at 2-tile resolution and only checks the 9 neighboring buckets, keeping it ≈ O(N). Pairs in IDLE/MOVING within chebyshev distance 2 get a 10% chance to flip into `state = "CHATTING"` for 2000 ms (`chatUntilMs` against `state.time.totalRealMs`). Contagion at chat start: rebel→royalist 25% +15 dissent (flip to rebel at dissent ≥ 80 + vanity ≥ 60); faith < 20 carrier drains -5 faith from believer.
- Render overlays: `drawSingleCitizen` draws a "..." pill bubble for CHATTING and a colored glyph (`!` doomsayer / `?` recluse / `$` thief) for MENTAL_BREAK above the head, after the lifeScale restore.
- Inspect modal (`App.tsx`) shows `firstName lastName`, an italic micro-state line, and a green→yellow→red mood bar.
- Storage: bumped to **v9**. `normalizeCitizens` backfills `lastName` / `mood = 100` / `dissent = 0` and clears partial transient state (`breakKind`, `chatUntilMs`) when the saved state doesn't match. Saves from v3–v8 still load.
- CRITICAL clock invariant: CHATTING expiry uses `state.time.totalRealMs` (advanced every frame in the engine loop). `tickCitizenMovement` MUST pass `this.state` into `updateCitizenMovement` — without it the function falls back to `performance.now()` (which resets on page reload) and citizens get stuck CHATTING forever.
- CRITICAL state-machine invariant: when a RECLUSE arrives at their home, `updateCitizenMovement` must NOT reset their state to IDLE — they have to stay MENTAL_BREAK so `tickCitizenMonth`'s `breakUntilMonth` timer can run.

**Phase 13 Climate — Dynamic Climate & Ecosystem Engine** (NOTE: shares the "Phase 13" name with the iso-renderer phase above — this section covers the climate layer, the iso renderer is documented separately):
- `Season` (`SPRING`/`SUMMER`/`AUTUMN`/`WINTER`) and `WeatherKind` (`CLEAR`/`RAIN`/`SNOW`/`THUNDERSTORM`) types live in `src/game/types.ts`. `GameState` carries `currentSeason`, `currentWeather`, `lastWeatherRollMonth`. The `Particle` type for weather VFX is also exported there but is NEVER serialized — it's a runtime-only screen-space struct used by the engine's particle pool.
- `monthToSeason(month)` is exported from `src/game/storage.ts` and is the SINGLE SOURCE OF TRUTH for the season mapping (Mar–May Spring, Jun–Aug Summer, Sep–Nov Autumn, Dec–Feb Winter).
- Storage: bumped to **v10**. `loadState` backfills `currentSeason` from `monthToSeason(time.gameMonth)`, defaults `currentWeather` to `CLEAR`, and seeds `lastWeatherRollMonth` from the current absolute month. Saves from v3–v9 still load.
- Weather rolls in `GameEngine.tickDayNight()` ONLY when transitioning to "day" (i.e. once per game-day at dawn) — see `refreshSeasonAndWeather()`. Per-season pools sum to 1.0; Winter never rolls RAIN/THUNDERSTORM, Spring/Summer/Autumn never roll SNOW. Season transitions write a chronicle ("The realm turns from autumn to winter."); weather changes are silent (the HUD pill is the player's signal).
- Particle engine lives ENTIRELY on the `GameEngine` class (`weatherParticles`, `weatherSpawnAcc`, `lightningFlashUntilMs`, `lastLightningStrikeMs`) — never persisted. Hard-capped at `PARTICLE_MAX = 200`. `tickClimate(dtMs)` runs every frame from the main loop (after `tickSparks`, before `runRumorMill`); spawn rates are per-millisecond with a fractional accumulator. Rain spawns from both top edge and right edge so the diagonal stream looks continuous as wind blows it off-screen left. Snow uses `baseX + sin(phase) * SNOW_WOBBLE_AMP` for the drift effect.
- Lightning (THUNDERSTORM only): two independent rolls per frame — `LIGHTNING_FLASH_CHANCE_PER_FRAME = 0.01` (1% — cosmetic white flash gated by `LIGHTNING_COOLDOWN_MS = 1200`) and `LIGHTNING_STRIKE_CHANCE_PER_FRAME = 0.0015` (~1 per 11s — picks a random tile and calls `traumatizeAdjacent(state, col, row)` from `npc.ts`). The strike helper sets `mood = 0` and `state = "FLEEING"` for every non-king, non-sleeping NPC within Chebyshev distance 1 of the impact tile, then chronicles the names. The King is shielded ("palace lightning rod"). All transient Phase-12 state (`breakKind`, `chatUntilMs`, etc.) is cleared on traumatize so FLEEING is a clean state.
- Render order in `render()`: terrain → entity queue → sparks → `ctx.restore()` → night overlay → manual winterActive overlay → **seasonal tint overlay** (`seasonTintColor()` — green Spring, amber Autumn, icy blue Winter, neutral Summer) → vignette → **weather VFX layer** (`renderWeatherFx()` — particles, then lightning flash). Particles render LAST so they sit above all overlays; the lightning flash deliberately blows out the entire scene including overlays. All weather rendering is screen-space (no camera transform) — pan/zoom never warps the rain angle.
- Gameplay hooks (do NOT duplicate these — they all check `state.currentSeason` / `state.currentWeather` directly):
  - **Civic wheat production** (`civilization.ts` — `tickCivilizationMonth` accepts a `seasonCropMul` param): 1.5× in Spring/Autumn, 0× in Winter, 1× in Summer. Manual `winterActive` Chronomancer power FORCES `mul = 0` regardless of season.
  - **Per-citizen farmer goods** (`npc.ts` — `tickEconomyAndFaction` line ~447): same multiplier applied directly inside the Farmer branch. Composes multiplicatively with `masteryMul` and `traitYieldMul` (Diligent).
  - **Outdoor movement speed** (`npc.ts` — `updateCitizenMovement`): `speedMul *= 0.9` if `currentWeather` is RAIN/SNOW/THUNDERSTORM. SLEEPING NPCs never reach this branch (the function early-returns above), so no extra indoor check needed.
  - **Mood drains** (`npc.ts` — `tickCitizenMonth` mood block): natural Winter OR manual `winterActive` → `MOOD_DRAIN_WINTER = 5` per month, doubled if `!homeBuildingId` (homeless). Wet weather → `MOOD_DRAIN_WET = 2` per month (no SLEEPING check needed — the function early-returns for SLEEPING NPCs above).
  - **Lightning trauma**: see above — fires from `tryLightningStrike()` in the engine, calls `traumatizeAdjacent` exported from `npc.ts`.
- HUD (`App.tsx`): two new pills next to the existing Day/Night pill — Season (green/yellow/orange/blue with emoji) and Weather (clear/rain/snow/storm with emoji). State seeded on engine init AND on every `onTimeUpdate` callback.
- Performance budget: the particle pool cap + the once-per-second rumor mill gate are the two FPS-critical constraints. Profile against the existing 56–60 FPS baseline; if `tickClimate` regresses below 50 FPS in a thunderstorm, drop `PARTICLE_SPAWN_PER_MS_THUNDERSTORM` first.

**Phase 13 Climate — Post-architect fixes (CRITICAL invariants):**
- `saveState()` in `storage.ts` MUST include `currentSeason`, `currentWeather`, `lastWeatherRollMonth`. The serialization sites are easy to miss when adding new GameState fields — always grep `SerializedState` and `saveState` together when extending state.
- `simulateMonth()` resyncs `state.currentSeason = monthToSeason(time.gameMonth)` at the TOP of the function, BEFORE any season-dependent ticks (`tickCivilizationMonth`, `tickCitizenMonth`). Without this, boundary months (e.g. Feb→Mar transition) would simulate crops & mood under the OLD season — `tickDayNight` only refreshes at dawn, which can lag by half a game-day. The dawn refresh in `refreshSeasonAndWeather()` is now defensive only — it skips the chronicle entry because `simulateMonth` already wrote it.
- `tickClimate()` runs every frame regardless of `timeScale` (visual particles + cosmetic lightning flash always animate). BUT the gameplay-mutating `tryLightningStrike()` call is GATED on `state.time.timeScale > 0` — pausing must not let the world traumatize NPCs from under the player.
- `traumatizeAdjacent()` MUST assign a real flee path (not just set state="FLEEING"). The existing FLEEING state-machine in `npc.ts` will idle without a `c.path` to follow. The helper computes a goal tile in the direction opposite the strike (radius 6/4/3/2 with progressive fallback) and calls `findPath` from `pathfinding.ts`. King is shielded; SLEEPING/DEAD citizens are skipped.
