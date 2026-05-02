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
