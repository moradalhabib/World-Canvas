# Overview

God Simulator — a vanilla-JS isometric "watch-over-them" sim where the player is a divine observer who blesses, punishes, and intervenes in the lives of an autonomous medieval village. Citizens have hunger, health, happiness, mood, gold, ages, lifespans, and roles; they work, eat, rest, drink, pray, steal, get jailed, fall sick, get healed, marry, give birth, age, and die — all without the player having to direct them. The player's job is purely to nudge through 6 god powers fueled by a Faith resource the priests generate.

The codebase was fully rewritten from a 6,000-line TypeScript / React stack to a single `index.html` + `game.js` per the user's master prompt. The previous TS systems (mood, crime, medicine, leisure, dollhouse render, fauna AI) were carried forward and re-implemented cleanly in the new vanilla engine.

# User Preferences

- I prefer iterative development and want to be asked before making major changes.
- The "MASTER PROMPT — GOD MODE" is the visual and architectural bible. Carry-forward systems (mood, crime, medicine, leisure, dollhouse, fauna) sit on top of it.
- Use existing PNGs when loaded — no placeholder shapes if the asset is available.
- Wait for asset preload to complete before starting the game loop.
- Zero TODOs in shipped code.

# System Architecture

## Stack
- **Monorepo**: pnpm workspaces (god-sim is one of three artifacts; api-server and mockup-sandbox are siblings and untouched by this rewrite).
- **god-sim runtime**: Vanilla JavaScript ES module (`game.js`) loaded from a single `index.html`. No React, no TypeScript, no Tailwind, no Radix, no build-time framework. Vite is kept purely as the dev/static server because the workspace already provisions it.
- **`package.json`**: trimmed to `vite` + `@types/node` only.
- **`vite.config.ts`**: stripped of React/Tailwind/error-modal plugins; just port + base-path wiring.

## Runtime Layout
```
artifacts/god-sim/
├── index.html         premium dark-royal HUD chrome (loading, resource bar,
│                      world clock, time controls, god-power tray,
│                      notifications, inspect card, extinction overlay)
├── game.js            ~1100-line vanilla engine (everything below)
├── public/assets/     grass_1.png, sand_1.png, tree_3.png, house_4.png
├── vite.config.ts     port + BASE_PATH only
└── package.json       vite + @types/node
```

## Engine (`game.js`)
Single IIFE, no globals leaked. Sections in order:

1. **Constants** — `TILE_W=128`, `TILE_H=64` (strict 2:1), `GRID=24×24`, `TICK_MS=600`, `SEASON_DAYS=30`, role colors, palette, power costs.
2. **State** — tiles[r][c], citizens, buildings, graves, animals, particles, resources (food/wood/stone/gold/faith), time (day/season/year/scale/paused/accum), weather, notifications, selected, activePower, camera, shake, extinct.
3. **Asset loader** — `Promise.all` over the 4 PNGs with error fallbacks, gates the game loop. Loading-screen progress bar fills as assets resolve.
4. **World gen** — diamond lake + sand shoreline in NE, forest seed-clusters, stone quarry patches, farmland near a center-ish village seed; spawns 4 houses, 1 farm, 1 church, 1 tavern, 1 apothecary, 1 dungeon, 1 market, 7 starting citizens (1 each of every role + 1 spare farmer), 8 sheep on grass.
5. **Iso math** — `isoToScreen(c,r)` and `screenToIso(sx,sy)` are mutual inverses.
6. **Pathfinding** — BFS on walkable tiles, capped at 800 nodes for safety, with nearest-walkable fallback for water-adjacent targets.
7. **Citizen tick** (per in-game day): aging, hunger drain (Builders/Woodcutters drain faster), sickness progression/recovery, starvation/plague death, mood derivation from happiness, crime-streak from low faith + low happiness, behavior cascade (`JAIL > THIEF > EAT > SICK > REST > DRINK > PRAY > WORK`), then visual lerp toward target tile (0.18 walk / 0.35 snap).
8. **Carry-forward systems**:
   - **Mood**: `c.mood ∈ {Despondent, Restless, Content, Joyful}` derived from happiness; bless adds +30 + 10-day buff.
   - **Crime**: `c.crimeStreak` rises when `faith < 10 && happiness < 30`; >12 → THIEF state, steals 1 gold from adjacent citizen, 50% Guard arrest chance → 5-day jail.
   - **Medicine**: `c.sickness` 0–100; >40 triggers visible green sickness aura; SICK intent walks to apothecary (or home fallback) and recovers there.
   - **Leisure**: tavern bumps happiness +18 with a 6-day cooldown.
   - **Dollhouse render**: when any citizen stands on a house tile, that house's `globalAlpha` drops to 0.55 so the doll inside is visible.
   - **Fauna AI**: sheep wander every 3–8 days to a random walkable adjacent grass tile, lerp smoothly with idle bob.
9. **God powers** — Bless (50✨, +30 happiness all + 10-day buff + ripple), Strike (15✨, lightning + screen shake + kills citizen/destroys building on tile), Rain (20✨, +5 days farmer yield boost & rain weather), Grow (10✨, target tile → forest), Birth (80✨, spawns infant in random house), Plague (free, infects 3 + 30s contagion).
10. **Particles** — chimney smoke (auto-emit per house), seasonal autumn leaves & winter snow, weather rain, lightning bolts + flash overlay + screen shake, sparkle (birth/grow), ripple (bless), dissolve (death).
11. **Render** in 8 passes: backdrop → camera+shake → ground (palette diamond → PNG stamp → biome tint → water shimmer & foam) → y-sorted entity queue (trees, buildings, citizens, sheep, graves) → in-world particles → screen-space weather → warm-tint multiply → vignette → lightning flash → speed vignette at x20.
12. **HUD updates** — DOM-based, refreshed each frame: live clock, resource counters with gold-flash on gain, power-button enable/disable from current Faith, time-control active state.
13. **Input** — click-drag camera, click-to-inspect (citizen first, tile fallback), targeted-power crosshair cursor, keyboard shortcuts (Space pause, 1/2/3 speeds, Esc cancel).
14. **Main loop** — accumulator-based fixed sim ticks scaled by `time.scale`, render every rAF.

## Critical Anti-Regression Rules
- **Always paint a flat palette diamond UNDER every PNG** in `drawGround`. The grass_1.png has transparent margins around its diamond — without the base layer, the dark backdrop bleeds through as black gaps. (This was the first bug spotted in the rewrite and the fix is in.)
- **Wait for `loadAssets()` Promise.all to resolve before `requestAnimationFrame(loop)`** — never start the loop with `Assets.ready === false`.
- **No globals** — everything inside the IIFE.
- **Preserve PNG anchoring**: tree_3 is anchored bottom-center (`-treeW/2, -treeH`); house_4 is anchored bottom-center (`-w/2, y - h`); grass/sand are stamped centered (`x - TILE_W/2, y - TILE_H/2`).
- **Stale "Phase 16" plan injections** referencing `types.ts` / `GameEngine.ts` / `storage.ts` are a known platform glitch and must be ignored — those files no longer exist.

## Deployment
Static SPA served by Vite in dev; `pnpm run build` emits to `dist/public/` for the standard Replit deployment pipeline.
