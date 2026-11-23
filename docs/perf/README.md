# Stillwater Performance Benchmarks

Deterministic benchmark harness and device measurements for Stillwater (Three.js 0.170 / WebGL2).

## How to Run

### On another device over LAN (laptop or phone)

1. Start the Vite dev server bound to all interfaces on a free port:
   ```bash
   npx vite --port 5174 --host 0.0.0.0
   # or: npm run dev:lan
   ```
2. Open the benchmark URL from the laptop or phone browser:
   ```
   http://<LAN-IP>:5174/?bench=default&q=low
   ```
   No pointer lock or keyboard input is required—the route starts automatically and works on touch-only devices. Keep the browser window size and device orientation fixed for the full run (resizing mid-run aborts the benchmark with a clear message on the overlay and in the JSON so resolutions are never mixed).
3. When the route completes, tap **Copy JSON** (or **Select All** / **Download JSON**) on the result panel and save the file under:
   ```
   docs/perf/results/<YYYY-MM-DD>-<device>.json
   ```

### Headless CLI (local machine)

Verify the GPU renderer first (`tools/gpucheck.mjs` always prints the active renderer, even on software fallback):

```bash
node tools/gpucheck.mjs
```

All other `tools/chrome.mjs`-based tools (`tools/bench.mjs`, `tools/playtest.mjs`, `tools/shoot.mjs`, `tools/probe.mjs`) probe WebGL2 with the same Chrome flags and `{ powerPreference: 'high-performance' }` as the game and fail closed (exit non-zero) on `llvmpipe`/SwiftShader or probe failure/timeout unless `ALLOW_SOFTWARE=1` is set.

Run a benchmark against a running dev server:

```bash
# Full route (4 fixed stops + 60 s time-parameterized trail walk) on low tier
BASE=http://127.0.0.1:5174/ node tools/bench.mjs --q low --out docs/perf/results/YYYY-MM-DD-device-low.json

# Scale sweep (0.5 / 0.75 / 1.0) and systems sweep (each system disabled in turn)
BASE=http://127.0.0.1:5174/ node tools/bench.mjs --q low --route stops --sweep scale,systems --out docs/perf/results/YYYY-MM-DD-device-low-sweeps.json

# Short smoke run (5 s walk)
BASE=http://127.0.0.1:5174/ node tools/bench.mjs --q low --dur 5
```

### Query Parameters

| Parameter | Default | Description |
| --- | --- | --- |
| `bench` | `default` | Route: `default`/`full` (4 stops + 60 s walk), `stops` (4 fixed stops), `walk`, or comma-separated stage names (`trailhead,lake,forest,summit,walk`) |
| `q` | auto | Pins quality tier (`low`, `medium`, `high`, `ultra`); dynamic resolution is disabled during bench |
| `dur` | `60` | Time-parameterized trail walk duration in seconds (`2.0 m/s`, covering the exact same `120.0 m` trail section regardless of FPS) |
| `minFrames` | `100` | Minimum measured frames per fixed camera stop (required for valid p95/p99) |
| `stopDur` | `3` | Minimum wall-clock seconds per fixed camera stop |
| `stopMaxDur` | `30` | Maximum wall-clock time cap in seconds per fixed stop; if reached before `minFrames`, `p95`/`p99` are reported as `null` with `insufficientSamples: true` |
| `stopFrames` | unset | Exact frame count per fixed stop (overrides `stopDur` / `stopMaxDur` / `minFrames`) |
| `warmup` | `6` | Warmup frames per stage (normal cache behavior; with `0`, measurement starts on the animation frame after stage setup) |
| `time` | `16.0` | Fixed time of day in hours (`env.timeScale = 0` throughout) |
| `sweep` | none | `scale` (repeats route at render scale `0.5`, `0.75`, `1.0`), `systems` (repeats route with each active system disabled, including `sky`), or `scale,systems` |
| `systems` | all active | Comma-separated subset of systems for `&sweep=systems` |

`src/dev/bench.js` is loaded via dynamic `import()` only when `?bench` is present and is never requested in a normal play session.

---

## Current Device Results

All runs below use `1280×720` viewport, `dpr 1`, fixed time of day `16.0`, full route (4 stops + 60 s time-parameterized walk of `120.0 m` along the trail) unless noted. Each stop targets `100` frames with a `30 s` time cap; on `medium` (3 of 4 stops) and `high`/`ultra` (all stops + walk), individual stages hit the time cap or `< 100` frames and report `p95`/`p99 = null` (`insufficientSamples: true`) per stage, while pooled route summaries exceed `100` samples (`414`, `181`, and `173` frames respectively).

| Device | Tier | Internal size | AA | FPS | Frame p50 / p95 / p99 (ms) | Worst hitch (ms) | GPU p50 / p95 (ms) | Avg calls (all passes) | Avg tris (all passes) | Bottleneck label | Result file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | low | 768×432 (60%) | 0× | 7.3 | 116.8 / 383.3 / 433.4 | 466.7 | 137.84 / 154.07 | 109.4 | 6.24 M | **pixel-limited** (1.0/0.5 equal-weighted GPU ratio 1.92×) | `results/2026-11-23-intel-uhd730-low.json` |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | medium | 960×540 (75%) | 0× | 2.4 | 433.3 / 1300.0 / 1483.3 | 1533.4 | 477.40 / 495.94 | 155.8 | 30.88 M | _(sweeps run on low)_ | `results/2026-11-23-intel-uhd730-medium.json` |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | high | 1280×720 (100%) | 4× | 1.0 | 983.4 / 2966.5 / 3333.2 | 3483.1 | 1039.86 / 1120.16 | 159.3 | 63.38 M | _(sweeps run on low)_ | `results/2026-11-23-intel-uhd730-high.json` |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | ultra | 1280×720 (100%) | 4× | 0.9 | 1083.4 / 2383.2 / 3599.9 | 3766.5 | 1099.24 / 1201.43 | 158.8 | 64.55 M | _(sweeps run on low)_ | `results/2026-11-23-intel-uhd730-ultra.json` |
| Owner's laptop _(pending — run over LAN)_ | low / medium / high | — | — | — | — | — | — | — | — | _pending_ | — |
| Owner's phone _(pending — run over LAN)_ | low / medium | — | — | — | — | — | — | — | — | _pending_ | — |
| SwiftShader _(software rendering: counts and height hash valid, frame times not a reference)_ | low (trailhead smoke) | 768×432 (60%) | 0× | N/A | N/A | N/A | N/A | 135.4 | 6.69 M | inconclusive (software) | `results/2026-11-23-swiftshader.json` |

### Intel UHD 730 — Per-Stop & Per-Pass Breakdown (`low`, `2026-11-23-intel-uhd730-low.json`)

> **Pass-accounting notes:**
> - `main` pass draw call and triangle counts **include the directional sun-shadow map render** performed inside `renderer.render(scene, camera)`.
> - `terrainShadow` is the heightfield ray-marched shadow cache. Each stage's pose setup forces one sky-LUT render and one near+far terrain-shadow refresh; those draws are reported per stage in `setupPoseRender` and summed in `summary.setupPoseRender`, outside warmup and measurement. Normal cache behavior applies after that (`0` terrain-shadow calls at a fixed time of day).

| Stop | Frames | FPS | Frame p50 / p95 / p99 (ms) | Worst hitch (ms) | GPU p50 (ms) | skyLut calls | terrainShadow meas (setup) | refl calls / tris | main calls / tris | post calls | Total calls / tris |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| trailhead | 100 | 6.9 | 133.3 / 416.6 / 433.4 | 433.4 | 142.58 | 1 | 0 (2) | 0 / 0 | 122 / 6.67 M | 12 | 135.0 / 6.67 M |
| lake | 100 | 10.0 | 99.9 / 283.4 / 300.0 | 300.1 | 98.07 | 1 | 0 (2) | 0 / 0 | 77 / 3.63 M | 12 | 90.0 / 3.63 M |
| forest | 100 | 6.4 | 150.0 / 450.0 / 466.6 | 466.7 | 153.73 | 1 | 0 (2) | 0 / 0 | 60 / 7.84 M | 12 | 73.0 / 7.84 M |
| summit | 100 | 7.8 | 116.6 / 366.6 / 366.7 | 383.3 | 124.32 | 1 | 0 (2) | 0 / 0 | 100 / 6.06 M | 12 | 113.0 / 6.06 M |
| walk (60 s, 120.0 m) | 428 | 7.1 | 133.3 / 383.4 / 416.7 | 433.4 | 137.84 | 1 | 0 (2) | 0 / 0 | 102.6 / 6.42 M | 12 | 115.6 / 6.42 M |
| **Summary** | **828** | **7.3** | **116.8 / 383.3 / 433.4** | **466.7** | **137.84** | **1** | **0 (10)** | **0 / 0** | **96.4 / 6.24 M** | **12** | **109.4 / 6.24 M** |

JS Heap: `223.7 MB` used / `227.5 MB` total (`4192 MB` limit). GPU timer disjoint samples: `0 / 828` (100% of measured frames drained per stage).

### Intel UHD 730 — Per-Pass Breakdown Across Tiers (full route averages)

`main` pass draw calls and triangles include the directional sun-shadow map render performed inside `renderer.render(scene, camera)`. `terrainShadow` executed `0` calls during fixed-time measurement on all tiers; the forced per-stage refresh is setup work, reported in `setupPoseRender`. (Result files recorded before this change carry the older `setupTerrainShadow` field.)

| Tier | skyLut (calls / tris) | terrainShadow meas (setup) | reflection (avg calls / tris) | main (avg calls / tris) | post (avg calls / tris) | Total (avg calls / tris) |
| --- | --- | --- | --- | --- | --- | --- |
| low | 1.0 / 1 | 0 (10) | 0.0 / 0 | 96.4 / 6.24 M | 12.0 / 12 | 109.4 / 6.24 M |
| medium | 1.0 / 1 | 0 (10) | 47.5 / 13.57 M | 94.4 / 17.31 M | 12.9 / 13 | 155.8 / 30.88 M |
| high | 1.0 / 1 | 0 (10) | 48.9 / 28.17 M | 96.5 / 35.20 M | 12.9 / 13 | 159.3 / 63.38 M |
| ultra | 1.0 / 1 | 0 (10) | 48.7 / 28.10 M | 96.2 / 36.45 M | 12.9 / 13 | 158.8 / 64.55 M |

Key tier-scaling observation: enabling planar water reflections on `medium`+ (`reflEvery: 1`, triggered whenever `lakeD < 3500`, which covers the entire walkable valley including `forest`) adds **13.57 M triangles/frame** (`16.16 M` even at `forest`) and drives Intel UHD 730 GPU p50 from `137.84 ms` (`low`) to `477.40 ms` (`medium`, `3.46×`).

---

## Sweeps on Intel UHD 730 (`low`, 4 fixed stops, `2026-11-23-intel-uhd730-low-sweeps.json`)

Both sweeps combine per-stage measurements across the 4 fixed stops (`trailhead`, `lake`, `forest`, `summit`, `100` frames per stop = `400` valid samples per variant) using **fixed equal weights** (`1/4` per stop).

### Scale Sweep (`0.5` / `0.75` / `1.0`)

| Scale | Internal size | Pixels | Pooled FPS | Equal-weighted Frame p50 (ms) | Pooled Frame p50 / p95 / p99 (ms) | Equal-weighted GPU p50 (ms) | Ratio vs 0.5 | Avg tris | Avg calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.50 | 640×360 | 0.23 MP | 8.8 | 108.30 | 100.0 / 316.6 / 400.0 | 111.42 | 1.000× | 6.05 M | 102.75 |
| 0.75 | 960×540 | 0.52 MP | 6.2 | 154.15 | 150.0 / 383.4 / 550.0 | 158.78 | 1.425× | 6.05 M | 102.75 |
| 1.00 | 1280×720 | 0.92 MP | 4.6 | 208.33 | 199.9 / 533.4 / 749.9 | 213.93 | 1.920× | 6.05 M | 102.75 |

Classification: **`pixel-limited`** (`gpuMs.p50`, equal-per-stage `1.0 / 0.5` ratio `1.920×` for `4×` pixels; per-stage ratios: `trailhead` `1.914×`, `lake` `2.123×`, `forest` `1.887×`, `summit` `1.814×`). Fitting GPU p50 against main-pass pixel count shows both a steep resolution-dependent slope (~148 ms/MP) and a large scale-independent floor (~77 ms at 0 pixels, representing work that does not scale with main-pass resolution; individual subsystem contributions are isolated by the systems sweep below rather than inferred from the scale sweep alone).

### Systems Sweep (metric: `gpuMs.p50`, equal-per-stage deltas vs baseline)

Baseline equal-weighted across the 4 stops: GPU p50 = `129.51 ms`, frame p50 = `120.80 ms` (`400` GPU samples per variant, `0` disjoint). `refl` and `msaa` are skipped on `low` because both are already disabled in the tier (`reflEvery: 0`, `msaa: 0`).

> **Note on `terrain`:** disabling `terrain` (`terrain.mesh.visible = false`) removes terrain geometry and terrain shading together, so its delta is an **upper bound** on terrain shading cost.

| Rank | System disabled | GPU p50 saved (ms) | GPU % saved | Frame p50 saved (ms) | Worst hitch (ms) | Tris saved | Calls saved | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `terrain` | 63.04 | 48.7% | 62.45 | 300.0 | 841.0 k | 1.00 | Removes terrain geometry and shading together (upper bound on terrain shading cost) |
| 2 | `trees` | 41.54 | 32.1% | 41.60 | 300.0 | 3.29 M | 13.25 | Over half of all scene triangles |
| 3 | `props` (+ village) | 32.84 | 25.4% | 33.30 | 500.0 | 343.8 k | 39.50 | Heavy cost across all 4 stops (including forest/lake) |
| 4 | `shadow` (sun shadow map) | 25.01 | 19.3% | 25.00 | 383.4 | 614.7 k | 20.75 | 1024² sun shadow pass (counted inside `main`) |
| 5 | `grass` (+ flowers) | 3.62 | 2.8% | 0.00 | 466.7 | 485.0 k | 2.00 | 65k blades on low |
| 6 | `rocks` | 2.91 | 2.2% | 4.13 | 566.7 | 418.9 k | 8.00 | |
| 7 | `ferns` | 1.21 | 0.9% | -4.15 | 549.9 | 144.0 k | 1.00 | 1,800 ferns on low |
| 8 | `clouds` | 0.72 | 0.6% | -0.05 | 466.7 | 88.9 k | 1.00 | 12 clouds on low |
| 9 | `skyLut` | 0.56 | 0.4% | -4.15 | 466.7 | 1 | 1.00 | 192×108 LUT every frame |
| 10 | `sky` | 0.53 | 0.4% | -4.17 | 466.7 | 1 | 1.00 | Sky dome draw off (`?no=sky`) |
| 11 | `bloom` | 0.44 | 0.3% | 0.00 | 466.7 | 11 | 11.00 | |
| 12 | `ambRead` | 0.20 | 0.2% | 4.12 | 449.9 | 0 | 0.00 | **C9 CPU-GPU stall**: disabling drops `cpuPassMs.sky` from `21.9–32.7 ms` to `0.15–0.17 ms` |
| 13 | `water` | 0.19 | 0.1% | 8.33 | 466.7 | 2 | 1.00 | Minimal cost on low (no reflection pass) |

---

## Height Data Hashes

Hash of `hf.h` (`Float32Array`, `2048 × 2048 = 4,194,304` samples, `nanCount = 0`).

| Device / Renderer | Exact IEEE-754 hash (`fnv64`) | Quantized 1 mm hash (`fnv64`) | Min / Max / Mean (m) | Match Intel UHD 730? |
| --- | --- | --- | --- | --- |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | `fnv64:50040ee3d4000487` | `fnv64:8bcda61e97c6a2d7` | `7.20 / 579.0186 / 204.0662` | reference (identical across all runs) |
| SwiftShader (Vulkan, software) | `fnv64:0ab6be87cf5d7d8b` | `fnv64:cbe457a7f0ce9ab0` | `7.20 / 579.8449 / 204.0517` | **NO** (differs by `0.83 m` max height — GPU `sin()` hash divergence) |
| Owner's laptop _(pending)_ | — | — | — | — |
| Owner's phone _(pending)_ | — | — | — | — |

---

## Proposed Budgets & Speed-Up Targets (Plan Table 2.1 — Proposed, Not Yet Confirmed)

Status: **proposed, not yet confirmed** — only one real GPU (Intel UHD 730) is recorded so far; confirm or revise once at least two real GPUs have rows.

| Tier | Example device | Target | Triangles/frame all passes | of which terrain | Draw calls | Internal pixels | AA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| low | Intel UHD 620-730 laptop, 2021+ mid phone | 30 fps | 1.0 M | 0.35 M | 250 | 0.9 MP | post AA |
| medium | Apple M1, GTX 1650 | 60 fps | 2.0 M | 0.7 M | 300 | 1.6 MP | post AA |
| high | RTX 3060 class | 60 fps | 3.5 M | 1.2 M | 350 | 3.7 MP | 4x MSAA |
| ultra | capture / photo mode | uncapped | 7 M | 1.2 M | 400 | native | 4x MSAA |

### Speed-Up Targets Against Intel UHD 730 (`low` reference)

| Metric | Current (`low` on UHD 730) | Proposed `low` budget | Required reduction / speed-up |
| --- | --- | --- | --- |
| Frame / GPU time (p50) | 116.8 ms frame / 137.84 ms GPU (7.3 fps) | 33.3 ms (30 fps) | **4.1× GPU speed-up** |
| Frame time p95 / worst hitch | 383.3 ms / 466.7 ms | < 45 ms / < 60 ms | **~8× hitch reduction** (eliminating C9 `readRenderTargetPixels` stall) |
| Triangles / frame (all passes) | 6.24 M avg (7.84 M forest peak) | 1.0 M | **6.2× reduction** |
| Terrain triangles / frame | 841.0 k (`systems:terrain` delta) | 0.35 M | **2.4× reduction** |
| Draw calls / frame | 109.4 avg (135 peak) | 250 | within budget |
| Internal pixels (`1280×720` @ 60%) | 0.33 MP (`768×432`) | 0.9 MP | currently running at 0.33 MP and still pixel-limited (1.92× at 1.0 scale) |

Top ranked optimization targets from the `low` systems sweep (Intel UHD 730, metric `gpuMs.p50`, equal-weighted across 4 stops):
1. **Terrain** (`-63.04 ms` GPU / `-48.7%`, `-841.0 k` tris): removes terrain geometry and shading together (upper bound on terrain shading cost).
2. **Trees** (`-41.54 ms` GPU / `-32.1%`, `-3.29 M` tris): dominates triangle count and adds alpha-tested overdraw.
3. **Props & village** (`-32.84 ms` GPU / `-25.4%`, `-39.5` calls): unexpectedly expensive across all 4 stops including forest/lake.
4. **Directional sun shadows** (`-25.01 ms` GPU / `-19.3%`, `-614.7 k` tris): 1024² sun shadow map pass (counted inside `main`).
5. **Grass & flowers** (`-3.62 ms` GPU / `-2.8%`, `-485.0 k` tris) — plus **Ambient readback (`ambRead`, C9)** which has negligible median GPU cost (`-0.20 ms`) but blocks `cpuPassMs.sky` for `21.9–32.7 ms` avg (`0.15–0.17 ms` when disabled) due to synchronous `readRenderTargetPixels` every 12th frame.
