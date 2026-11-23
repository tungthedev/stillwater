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
   No pointer lock or keyboard input is required—the route starts automatically and works on touch-only devices.
3. When the route completes, tap **Copy JSON** (or **Select All** / **Download JSON**) on the result panel and save the file under:
   ```
   docs/perf/results/<YYYY-MM-DD>-<device>.json
   ```

### Headless CLI (local machine)

Verify the GPU renderer first (`tools/gpucheck.mjs` always prints the active renderer, even on software fallback):

```bash
node tools/gpucheck.mjs
```

All other `tools/chrome.mjs`-based tools (`tools/bench.mjs`, `tools/playtest.mjs`, `tools/shoot.mjs`, `tools/probe.mjs`) exit non-zero on `llvmpipe`/SwiftShader unless `ALLOW_SOFTWARE=1` is set.

Run a benchmark against a running dev server:

```bash
# Full route (4 fixed stops + 60 s auto-walk) on low tier
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
| `dur` | `60` | Auto-walk duration in seconds |
| `stopDur` | `3` | Minimum wall-clock seconds per fixed camera stop |
| `stopFrames` | unset | Exact frame count per fixed stop (overrides `stopDur` / `minFrames`) |
| `time` | `16.0` | Fixed time of day in hours (`env.timeScale = 0` throughout) |
| `sweep` | none | `scale` (repeats route at render scale `0.5`, `0.75`, `1.0`), `systems` (repeats route with each active system disabled), or `scale,systems` |
| `systems` | all active | Comma-separated subset of systems for `&sweep=systems` |

`src/dev/bench.js` is loaded via dynamic `import()` only when `?bench` is present and is never requested in a normal play session.

---

## Current Device Results

All runs below use `1280×720` viewport, `dpr 1`, fixed time of day `16.0`, full route (4 stops + 60 s walk) unless noted.

| Device | Tier | Internal size | AA | FPS | Frame p50 / p95 / p99 (ms) | Worst hitch (ms) | GPU p50 / p95 (ms) | Avg calls (all passes) | Avg tris (all passes) | Bottleneck label | Result file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | low | 768×432 (60%) | 0× | 7.1 | 133.3 / 416.6 / 433.4 | 549.9 | 142.3 / 152.8 | 120.9 | 6.42 M | **pixel-limited** (1.0/0.5 GPU ratio 1.80×; strong geometry floor) | `results/2026-11-23-intel-uhd730-low.json` |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | medium | 960×540 (75%) | 0× | 2.1 | 466.7 / 1466.7 / 1500.0 | 1500.0 | 493.5 / 504.5 | 170.7 | 34.88 M | _(sweeps run on low)_ | `results/2026-11-23-intel-uhd730-medium.json` |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | high | 1280×720 (100%) | 4× | 0.9 | 1099.9 / 3316.5 / 3333.2 | 3333.2 | 1105.1 / 1117.1 | 172.0 | 69.15 M | _(sweeps run on low)_ | `results/2026-11-23-intel-uhd730-high.json` |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | ultra | 1280×720 (100%) | 4× | 0.9 | 1133.3 / 3433.2 / 3499.8 | 3499.8 | 1161.1 / 1172.2 | 171.6 | 70.28 M | _(sweeps run on low)_ | `results/2026-11-23-intel-uhd730-ultra.json` |
| Owner's laptop _(pending — run over LAN)_ | low / medium / high | — | — | — | — | — | — | — | — | _pending_ | — |
| Owner's phone _(pending — run over LAN)_ | low / medium | — | — | — | — | — | — | — | — | _pending_ | — |
| SwiftShader _(software rendering: counts and height hash valid, frame times not a reference)_ | low (trailhead smoke) | 768×432 (60%) | 0× | N/A | N/A | N/A | N/A | 135.4 | 6.69 M | inconclusive (software) | `results/2026-11-23-swiftshader.json` |

### Intel UHD 730 — Per-Stop & Per-Pass Breakdown (`low`, `2026-11-23-intel-uhd730-low.json`)

| Stop | Frames | FPS | Frame p50 / p95 / p99 (ms) | Worst hitch (ms) | GPU p50 (ms) | skyLut calls | terrainShadow total calls | refl calls / tris | main calls / tris | post calls | Total calls / tris |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| trailhead | 22 | 7.2 | 133.3 / 416.7 / 433.4 | 433.4 | 142.3 | 1 | 2 | 0 / 0 | 122 / 6.67 M | 12 | 135.1 / 6.67 M |
| lake | 30 | 9.9 | 99.9 / 200.0 / 200.0 | 200.0 | 98.0 | 1 | 1 | 0 / 0 | 77 / 3.63 M | 12 | 90.0 / 3.63 M |
| forest | 19 | 5.8 | 150.0 / 466.6 / 466.6 | 466.6 | 153.4 | 1 | 1 | 0 / 0 | 60 / 7.84 M | 12 | 73.1 / 7.84 M |
| summit | 24 | 7.9 | 116.6 / 366.6 / 366.7 | 366.7 | 124.4 | 1 | 1 | 0 / 0 | 100 / 6.06 M | 12 | 113.0 / 6.06 M |
| walk (60 s, 36.0 m) | 419 | 7.0 | 133.3 / 416.6 / 433.4 | 549.9 | 142.5 | 1 | 1 | 0 / 0 | 112.0 / 6.57 M | 12 | 125.0 / 6.57 M |
| **Summary** | **514** | **7.1** | **133.3 / 416.6 / 433.4** | **549.9** | **142.3** | **1** | **6** | **0 / 0** | **107.9 / 6.42 M** | **12** | **120.9 / 6.42 M** |

JS Heap: `223.4 MB` used / `228.1 MB` total (`4192 MB` limit). GPU timer disjoint samples: `0 / 493`.

### Intel UHD 730 — Per-Pass Breakdown Across Tiers (full route averages)

| Tier | skyLut (calls / tris) | terrainShadow (total calls / avg) | reflection (avg calls / tris) | main (avg calls / tris) | post (avg calls / tris) | Total (avg calls / tris) |
| --- | --- | --- | --- | --- | --- | --- |
| low | 1.0 / 1 | 6 / 0.01 | 0.0 / 0 | 107.9 / 6.42 M | 12.0 / 12 | 120.9 / 6.42 M |
| medium | 1.0 / 1 | 6 / 0.04 | 46.0 / 15.60 M | 111.4 / 19.28 M | 12.3 / 12 | 170.7 / 34.88 M |
| high | 1.0 / 1 | 6 / 0.06 | 47.1 / 30.80 M | 111.5 / 38.34 M | 12.3 / 12 | 172.0 / 69.15 M |
| ultra | 1.0 / 1 | 6 / 0.07 | 47.1 / 30.72 M | 111.1 / 39.56 M | 12.3 / 12 | 171.6 / 70.28 M |

Key tier-scaling observation: enabling planar water reflections on `medium`+ (`reflEvery: 1`, triggered whenever `lakeD < 3500`, which covers the entire walkable valley including `forest`) adds **15.6 M triangles/frame** (`16.2 M` even at `forest`) and drives Intel UHD 730 GPU p50 from `142.3 ms` (`low`) to `493.5 ms` (`medium`, `3.5×`).

---

## Sweeps on Intel UHD 730 (`low`, 4 fixed stops, `2026-11-23-intel-uhd730-low-sweeps.json`)

### Scale Sweep (`0.5` / `0.75` / `1.0`)

| Scale | Internal size | Pixels | FPS | Frame p50 / p95 (ms) | GPU p50 (ms) | Ratio vs 0.5 | Avg tris | Avg calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.50 | 640×360 | 0.23 MP | 9.0 | 100.0 / 266.6 | 107.94 | 1.00× | 5.78 M | 102.2 |
| 0.75 | 960×540 | 0.52 MP | 6.1 | 150.0 / 383.4 | 149.90 | 1.39× | 5.81 M | 102.7 |
| 1.00 | 1280×720 | 0.92 MP | 4.6 | 183.3 / 533.4 | 194.67 | 1.80× | 5.85 M | 103.0 |

Classification: **`pixel-limited`** (`gpuMs.p50` ratio `1.804×` for `4×` pixels). Note also the large scale-independent floor (~78 ms at 0 pixels, driven by 5.8 M tris + 1024 shadow pass + vertex/geometry work) combined with a steep pixel slope (~126 ms/MP). Both fragment cost and geometry cost must drop to hit 30 fps (33.3 ms) on Intel UHD 730.

### Systems Sweep (ranked by GPU p50 saved on `low`, baseline GPU p50 = `124.25 ms`, frame p50 = `116.7 ms`)

`refl` and `msaa` are skipped on `low` because both are already disabled in the tier (`reflEvery: 0`, `msaa: 0`).

| Rank | System disabled | GPU p50 saved (ms) | GPU % saved | Frame p50 saved (ms) | Worst hitch (ms) | Tris saved | Calls saved | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `terrain` | 61.09 | 49.2% | 83.3 | 283.3 | 1.19 M | 1.5 | Largest single cost (~half of GPU frame) |
| 2 | `trees` | 36.03 | 29.0% | 33.4 | 300.0 | 2.99 M | 13.3 | Half of all scene triangles |
| 3 | `props` (+ village) | 30.83 | 24.8% | 33.5 | 383.3 | 388.2 k | 37.9 | Heavy cost across all 4 stops (even forest/lake) |
| 4 | `shadow` (sun shadow map) | 20.36 | 16.4% | 16.7 | 349.9 | 638.1 k | 20.5 | 1024² shadow pass |
| 5 | `grass` (+ flowers) | 2.60 | 2.1% | 0.0 | 433.4 | 469.1 k | 1.4 | 65k blades on low |
| 6 | `rocks` | 2.51 | 2.0% | 0.0 | 466.7 | 403.0 k | 7.4 | |
| 7 | `skyLut` | 0.72 | 0.6% | 0.1 | 450.0 | 13.2 k | 1.5 | 192×108 LUT every frame |
| 8 | `clouds` | 0.63 | 0.5% | 16.7 | 466.6 | 85.7 k | 0.9 | 12 clouds on low |
| 9 | `ferns` | 0.62 | 0.5% | 0.0 | 450.0 | 134.3 k | 1.3 | 1,800 ferns on low |
| 10 | `bloom` | 0.41 | 0.3% | 16.7 | 583.4 | 36.0 k | 11.2 | |
| 11 | `water` | -0.22 | -0.2% | -16.6 | 466.7 | -33.2 k | 1.2 | Noise (no reflection on low) |
| 12 | `ambRead` | -0.28 | -0.2% | -16.6 | 416.6 | -50.7 k | 0.0 | **C9 CPU-GPU stall**: disabling drops `cpuPassMs.sky` from `23–41 ms` to `0.15–0.19 ms` and cuts frame p95 from `400 ms` to `300 ms` |

---

## Height Data Hashes

Hash of `hf.h` (`Float32Array`, `2048 × 2048 = 4,194,304` samples, `nanCount = 0`).

| Device / Renderer | Exact IEEE-754 hash (`fnv64`) | Quantized 1 mm hash (`fnv64`) | Min / Max / Mean (m) | Match Intel UHD 730? |
| --- | --- | --- | --- | --- |
| Intel UHD 730 (RKL GT1, Mesa Vulkan) | `fnv64:50040ee3d4000487` | `fnv64:8bcda61e97c6a2d7` | `7.20 / 579.0186 / 204.0662` | reference (identical across all 5 runs) |
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
| Frame / GPU time (p50) | 133.3 ms frame / 142.3 ms GPU (7.1 fps) | 33.3 ms (30 fps) | **4.3× GPU speed-up** |
| Frame time p95 / worst hitch | 416.6 ms / 549.9 ms | < 45 ms / < 60 ms | **> 9× hitch reduction** (eliminating C9 `readRenderTargetPixels` stall) |
| Triangles / frame (all passes) | 6.42 M avg (7.84 M forest peak) | 1.0 M | **6.4× reduction** |
| Terrain triangles / frame | ~1.19 M (`systems:terrain` delta) | 0.35 M | **3.4× reduction** |
| Draw calls / frame | 120.9 avg (136 peak) | 250 | within budget |
| Internal pixels (`1280×720` @ 60%) | 0.33 MP (`768×432`) | 0.9 MP | currently running at 0.33 MP and still pixel-limited (1.80× at 1.0 scale) |

Top ranked optimization targets from the `low` systems sweep (Intel UHD 730):
1. **Terrain** (`-61.1 ms` GPU / `-49.2%`, `-1.19 M` tris): fragment shading cost and patch density.
2. **Trees** (`-36.0 ms` GPU / `-29.0%`, `-2.99 M` tris): dominates triangle count and adds alpha-tested overdraw.
3. **Props & village** (`-30.8 ms` GPU / `-24.8%`, `-37.9` calls): unexpectedly expensive across all 4 stops including forest/lake.
4. **Directional sun shadows** (`-20.4 ms` GPU / `-16.4%`, `-638 k` tris): 1024² shadow pass cost.
5. **Ambient readback (`ambRead`, C9)**: zero median GPU cost, but blocking `readRenderTargetPixels` every 12th frame adds `23–41 ms` avg CPU sky time (`~300–450 ms` periodic pipeline stalls) and raises frame p95 from `300 ms` to `400 ms`.
