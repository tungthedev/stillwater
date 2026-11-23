# Stillwater — Agent Guide

Procedural Three.js 0.170 (WebGL2, Vite 5, plain ES modules) walking demo being turned into a game base.

## Commands

Setup on a fresh checkout: `npm ci`. Browser tools need Chrome or Chromium (found in the usual install paths; set `CHROME_PATH` otherwise).

- `npm run dev` — Vite dev server; pick your own free port with `npm run dev -- --port <n> --strictPort` (without `--strictPort` Vite silently moves to the next port and `BASE` points at someone else's server) (`5173` is used by other sessions on the shared machine).
- `npm run check` — lint + typecheck + unit tests + production build + headless smoke. Must exit 0 before any merge.
- `npm run lint`, `npm run typecheck`, `npm test` — individual checks.
- `npm run diff` — reshoots the 16 golden shots at `ultra` and `low` against `captures/golden-ultra/` and `captures/golden-low/`, and writes a side-by-side sheet under `captures/`. Goldens are renderer-specific; a shot over threshold is re-baselined only with owner approval.
- `npm run shots [name ...]` — screenshots via `tools/shoot.mjs` (pass `BASE=http://127.0.0.1:<port>/` for your dev server; optional `OUT`, `Q`, `W`, `H`); the 16 pinned shots live in `tools/shots.json`.
- `npm run bench` / `node tools/bench.mjs --q <tier> [--route default|stops|<stop,...>] [--sweep scale,systems] [--out <file>]` (without `--out` it prints the JSON) — deterministic benchmark (pass `BASE=http://127.0.0.1:<port>/`; see `docs/perf/README.md`). In the browser: `?bench=<route>&q=<tier>`.
- `BASE=http://127.0.0.1:<port>/ node tools/playtest.mjs` — headless walk; exits non-zero on page errors.
- `node tools/gpucheck.mjs` — prints the WebGL renderer, software or not. The shot, bench and playtest tools refuse to run on software rendering (`llvmpipe`/SwiftShader) or when the renderer probe fails, unless `ALLOW_SOFTWARE=1`.

URL flags: `?q=low|medium|high|ultra`, `?capture` (shot mode), `?bench`, `?no=<system,...>`, `?debug` (the debug HUD is on by default today and is being changed to show only with `?debug`).

## GPU Queue

One GPU is shared by every agent on the reference machine.
Every tool that opens a browser runs through `gpu-run` (one machine-wide lock); `tools/chrome.mjs` does this automatically via `tools/gpulock.mjs` when `gpu-run` is installed, and does nothing elsewhere (CI).

## Architecture (Target Layer Shape)

These folders are being introduced by the roadmap (today most code is in `src/main.js` and `src/world/`):

| Layer | Path | Owns | Must not |
| --- | --- | --- | --- |
| Engine | `src/engine/` | renderer setup, frame loop (fixed-step sim + render), system registry, tier table + benchmark, post chain, input actions, capability checks | know about valleys, sheep or benches |
| World | `src/world/` | world data (heights, trail, stream, biome, placements) and the systems that draw it | read input or DOM |
| Game | `src/game/` | player, interactions, session state machine, save data | touch WebGL objects directly |
| Content | `src/content/` | level data: world config, POIs, scenery edits, shot list | contain logic |
| Dev | `src/dev/` | capture mode, debug HUD, bench driver; loaded only by `?capture`, `?bench`, `?debug` | load in a normal play session |

- **System contract:** `create(ctx)` returns `{ update(frame), dispose(), setTier?(tier) }`.
- **Sources of truth:** `src/engine/quality.js` for every tier number; `src/content/` for everything placed by hand; `WorldData` for anything gameplay queries.
- **Tier parity:** placement and collision are the same on every tier; a tier only changes what is drawn.

## Performance Budgets

| Tier | Example device | Target | Triangles/frame all passes | of which terrain | Draw calls | Internal pixels | AA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| low | Intel UHD 620-730 laptop, 2021+ mid phone | 30 fps | 1.0 M | 0.35 M | 250 | 0.9 MP | post AA |
| medium | Apple M1, GTX 1650 | 60 fps | 2.0 M | 0.7 M | 300 | 1.6 MP | post AA |
| high | RTX 3060 class | 60 fps | 3.5 M | 1.2 M | 350 | 3.7 MP | 4x MSAA |
| ultra | capture / photo mode | uncapped | 7 M | 1.2 M | 400 | native | 4x MSAA |

Reference devices: Intel UHD 730 on this machine (`low`), Apple M1 Pro on Asahi Linux (`medium`). Current numbers: `docs/perf/README.md`.

## Conventions & Gotchas

- **Uniforms:** add every new shared world uniform to `U` in `src/uniforms.js` and declare it in the GLSL header (`WORLD_PARS`) in `src/glsl/common.js`.
- **GLSL reserved word:** `flat` is a reserved GLSL word; naming a variable `flat` fails shader compilation.
- **NaN sanitising:** NaNs bloom into visible squares; keep `w_sky` (`src/glsl/common.js`), sky output (`src/world/sky.js`), and bloom downsample (`src/post.js`) sanitized.
- **Height-map seam:** the near and far height maps blend over 1828–2028 m measured along the larger absolute horizontal coordinate, `max(|x|, |z|)`, so the seam is a square (`w_nearBlend` in `src/glsl/common.js`).
- **Comments:** comments say why, never review history.
- **Visual changes:** a visual change ships with `diff` and `bench` output.

## References & Shared Machine Rules

- **History (not instructions):** `docs/history/PROGRESS.md` (50 KB review log) and `docs/history/handoff.md` (review-24 handoff with stale parts).
- **Visual reference:** `captures/review-46/` is the human visual reference.
- **Shared machine:** kill only your own PIDs; never `pkill`/`killall` by name; never change networking; start dev servers on your own free port (not `5173`).
