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
