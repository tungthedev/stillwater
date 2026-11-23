# Stillwater — handoff for visual polish

You are picking up a procedural Three.js walking/trekking demo that has been through 24 rounds of
"fix → capture → independent Opus art review". The bar set by the owner: a **fresh** Opus reviewer
must answer `NEXT LEVEL: YES`. Every reviewer so far has said NO; scores have plateaued at
**6.5–7 / 10** for the last ~12 rounds. Your job is to break that plateau.

Read this file, then `PROGRESS.md` (round-by-round log of every fix), then look at the latest
review set in `captures/review-28/` next to the style reference `captures/reference.png`.

> **Repo note:** only `captures/review-28/` is committed. Older review sets, the hourly sets and
> the style reference image (`captures/reference.png`, third-party art supplied by the owner) are
> kept locally and are not in the public repo. Ask the owner for the reference image if you're
> working from a fresh clone. The reviewer prompt in §4 needs it.

---

## 1. The brief

- Owner's words: *"a super immersive 3d game demo in threejs, theme is walking, trekking, calm,
  viewing the landscape. Make it beyond the imagination."*
- Style pivot from the owner: **stylized, not realism.** Match `captures/reference.png` (painterly
  Unreal scene: saturated azure sky, big puffy cumulus, lush greens, fluffy round foliage, cozy
  cottage, animals, flowers).
- **Everything is procedural.** No imported models, textures or audio. Geometry, textures (canvas),
  sound and music are all generated in code. Keep it that way.
- Route: trailhead + storybook cottage + sheep → lake with jetty → waterfall → forest → saddle
  viewpoint → summit with prayer flags. Full day/night cycle; benches let you sit and watch time pass.

## 2. Run it

```
npm install
npm run dev            # http://127.0.0.1:5173/  (click to begin). The tools/ scripts target this one
npm run dev:lan        # LAN-accessible: http://<this-machine-ip>:5174/ (binds 0.0.0.0)
```

| Key | Action |
|---|---|
| WASD / mouse | walk / look |
| Shift | run |
| Q | auto-walk along the trail |
| E | sit on a nearby bench |
| Esc | pause; quality selector |

- Add `?q=low|medium|high|ultra` to force a quality preset (`src/config.js` → `QUALITY`).
- Owner's machine: **Intel HD 520 iGPU, Windows 10.** Low preset measures ~15–21 fps headless.
  Dynamic resolution is on (`src/main.js`). Don't regress the low preset.
- Debug handle: `window.__game` exposes `env, player, trail, hf, camera, U, sky, renderer, post,
  terrain, scene, water, trees, grass, streamPlan, village, stream`.

## 3. Tooling (all in `tools/`, all drive installed Chrome headless via puppeteer-core)

Chrome path is hard-coded: `C:/Program Files/Google/Chrome/Application/chrome.exe`. The dev
server must be running.

| Tool | Use |
|---|---|
| `node tools/shoot.mjs [name or query ...]` | Screenshot named shots from the `SHOTS` map, or raw query strings (`node tools/shoot.mjs "bench=2&time=17.3&pitch=-0.07"`). Env: `OUT` (dir, default `captures/`), `Q` (default `ultra`), `W`/`H` (1600×900), `BASE`. A shot takes ~45 s; the full 16-shot set takes ~12–15 min, so run it in the background. |
| `node tools/playtest.mjs` | Real input flow: click, Q, W. Prints `errs`; it **must be `[]`** after every change. |
| `node tools/probe.mjs "<url>" "<js expr>"` | Evaluate an expression in a loaded page (for example, an fps measurement). |
| `node tools/crop.mjs in.png x y w h scale out.png` | Zoom into a detail. Reviewers point at pixel coordinates; crop them before deciding a fix. |
| `node tools/hourly.mjs` | Was left running in the background for the owner: writes a set every hour to `captures/hourly/<stamp>/` plus a contact sheet `captures/hourly/index.html`. Stop it if you don't need it. |

**Capture URL parameters** (parsed in `src/main.js`):
- **Placement:**
  - `time=<hours>`.
  - `trail=`/`trailf=<0..1>` puts you on the trail.
  - `pos=x,z`.
  - `yaw`, `pitch`.
  - `bench=0|1|2` (lake / saddle / summit) with `byaw` offset, or `sit`.
- **Points of interest:**
  - `poi=cottage|sheep|horses|forest|stream|falls|fallsStream`, with `ang`, `dist`, `sf`, `dn`, `side`.
  - `faceMoon=1`.
- **UI and timing:** `title=1`, `hud=1`, `frames=N`, `lamp`.
- **Disable systems:** `no=grass,trees,clouds,rocks,terrain,refl,shadow,birds,motes,fly,props,sky,spray,mist` (useful for isolating artifacts).
- **Weather and quality:** `wind`, `cloud`, `scale`, `q`.
- **Reversed depth:** `rd` is opt-in only. It broke terrain when it was on by default.

**Gotcha:** `SHOTS` contains `summitWest` twice. The second definition (`pos=-770,-790&yaw=1.12…`)
wins. Clean that up if you touch the file.

## 4. Review protocol (keep it identical so scores stay comparable)

1. Capture: `OUT=captures/review-NN node tools/shoot.mjs title trailhead cottage cottageDusk sheep pasture meadow lake lakeSunset falls forest saddle summit summitWest dawn night`
2. Run `node tools/playtest.mjs` and confirm `errs: []`.
3. Spawn a **fresh** reviewer (general-purpose agent, model **opus**, background) with exactly this prompt (change only the folder):

> You are an independent, demanding art director / game reviewer. Judge a browser game demo from its screenshots. Do NOT edit any files.
>
> Context: "Stillwater" is a Three.js (WebGL) first-person walking/trekking demo — calm, about walking a trail through a stylized alpine valley and viewing the landscape: trailhead with a storybook cottage, fences, grazing sheep → lake with a jetty → waterfall → forest → saddle viewpoint → summit with prayer flags. Everything is procedural (no imported art assets — geometry, textures, sound and music are all generated in code), real time, with a full day/night cycle. The owner asked for something "beyond imagination" and supplied a style reference: B:\Projects\test-claude\captures\reference.png (stylized painterly Unreal scene: saturated azure sky, big puffy clouds, lush greens, fluffy foliage, cozy cottage, animals, flowers).
>
> Screenshots (1600x900, highest quality) are in B:\Projects\test-claude\captures\review-NN\ : title.png (title screen over drone shot), trailhead.png, cottage.png, cottageDusk.png, sheep.png, pasture.png, meadow.png, lake.png (seated on bench, letterboxed), lakeSunset.png, falls.png (waterfall seen from the stream bank), forest.png, saddle.png (seated), summit.png (seated, late afternoon), summitWest.png (seated, looking into the sunset), dawn.png, night.png. View every one with the Read tool, and the reference.
>
> Deliver:
> 1. A one-line verdict exactly `NEXT LEVEL: YES` or `NEXT LEVEL: NO` — YES only if a seasoned player would genuinely call this a top-tier, standout stylized walking experience as shown in these frames. Be strict, but judge it fairly as a real-time, fully procedural WebGL demo (not against hand-authored AAA assets or offline renders).
> 2. Score out of 10 for visual quality/art direction.
> 3. What works (brief).
> 4. The 8 most impactful remaining problems, ranked, each naming the screenshot(s), what exactly you see, and a specific actionable fix.
> Under 650 words.

4. Append the verdict and your fixes to `PROGRESS.md`.

## 5. Score history

| Review # | Set | Score | Note |
|---|---|---|---|
| 1–3 | review-01…04 | 5.5 → 6 → 6.5 | realism attempt, then the stylized pivot |
| 4–16 | review-05…20 | 6.5–7 | lighting, clouds, vegetation, village, animals |
| 17 | review-21 | 7 | |
| 18 | review-22 | 7 | |
| 19 | review-23 | 7 | |
| 20 | review-24 | 6.5 | trees then rebuilt as painterly canopies |
| 21 | review-25 | 7 | waterfall cliff read as a concrete drum, then reshaped |
| 22 | review-26 | 6.5 | |
| 23 | review-27 | 7 | |
| 24 | review-28 | 7 | latest set; see §7 |

**What every reviewer praises:** the daytime meadow, trailhead and cottage compositions (flower
carpets, a path leading the eye, the signpost); the cloud-ball sheep; the lake reflection and
glint; cottageDusk and night (warm windows, fireflies, chimney smoke, moon); the title
typography; the letterboxed seated views. **Protect these frames.** Several "fixes" have
regressed them before.

## 6. Architecture map

| File | Responsibility |
|---|---|
| `src/main.js` | Orchestration, world build order, capture-param handling, POI cameras, sightline clearing (`trees.clearArea` for benches and the falls), dynamic resolution, render loop |
| `src/config.js` | `WORLD` (size 4096 m walkable, far ring 32 km, lake ellipse, start, summit, water level 22) and `QUALITY` presets |
| `src/uniforms.js` | `U`: the global uniform registry shared by every patched material |
| `src/glsl/common.js` | Shared GLSL: height/normal sampling, `w_grassColor`, `w_cloudShadow`, `w_sky`, `w_applyAtmosphere` (haze, valley mist, aerial-perspective layer, warm sun glow), `w_yard` |
| `src/patch.js` | `patchMaterial(mat, opts)` injects the toon direct-light model (`rampNear` crisp, `rampFar` cel band blended by distance 700–3000 m), saturated indirect light, terrain and cloud shadowing, and atmosphere into `MeshStandardMaterial` |
| `src/post.js` | HDR post: mip bloom, godrays, lens ghosts, `stylTone` tonemap, golden-hour green grade (`uGoldenK`), split toning, vignette, grain, letterbox |
| `src/env.js` | Sun and moon ephemeris, light colour and intensity, exposure, fog and haze, mist, per-time grade (wb, sat, contrast, shadow tint), `uGolden` and `uAlpenglow` |
| `src/world/heightmap.js` | GPU heightmap generation (near 2048² over 4096 m with CPU readback; far 2048² over 32 km), `HeightField` (height, normal, `trailAt`, `isPath`). Heightmap G channel = trail mask (negative values = stream bed) |
| `src/world/terrain.js` | CDLOD quadtree terrain plus the big `terrainSurface()` shader (grass palettes, far painting, rock/cliff/snow, trail, stream bed with pebbles, shore, curvature, dapples, alpenglow, cottage AO and light spill) |
| `src/world/trail.js` | A* trail and carving |
| `src/world/stream.js` | Dijkstra stream, **escarpment carving** for the waterfall (`carveStream`: brink at 68 % of the stream, H = 44 m, R = 95, jagged brink, vertical face only near the fall), stream ribbon shader (foam fades with distance) |
| `src/world/waterfall.js` | Flanking rocks, buttresses, plunge pool, mist particles, curved sheet with a lip |
| `src/world/water.js` | Lake: planar reflection (skipped on low), Fresnel, glint |
| `src/world/shore.js` | Reed beds and lily-pad rafts around the lake (new; avoids the jetty and bench) |
| `src/world/sky.js`, `clouds.js` | Sky LUT and dome (sunset band, stars, Milky Way, moon); instanced icosphere cumulus |
| `src/world/fluffy.js`, `trees.js` | Painterly tree builder (flat-toned lobed leaf atlas, crown-dominant normals, smooth cores, branches, root flare); tree LODs (hi / mid / lo / billboard), material, `clearArea`, collision |
| `src/world/grass.js`, `undergrowth.js`, `rocks.js` | GPU grass and flowers (toroidal patch around the camera); ferns, logs, butterflies, light shafts; instanced rocks |
| `src/world/village.js`, `cottage.js`, `animals.js`, `props.js` | Cottage, yard, flagstone path (`uYardPath` keeps grass off it), fences, lanterns, chimney smoke; sheep herds; benches, signpost, cairns, prayer flags, jetty and rowboat |
| `src/world/fauna.js`, `audio.js`, `player.js`, `ui.js` | Birds and motes; procedural audio and music; controller; HUD |
| `src/world/foliage.js` | **Unused legacy.** Safe to delete |

**Conventions and gotchas**
- **New uniforms:** add the uniform to `U` in `uniforms.js` **and** declare it in `common.js`'s GLSL header.
- **GLSL keyword:** `flat` is reserved. Name a variable that and the shader fails to compile.
- **NaN handling:** NaNs bloom into visible squares. `w_sky`, the sky output and the bloom downsample are all sanitized; keep it that way.
- **Terrain map seam:** the near and far height maps blend at 1828–2028 m from the origin.
- **Foliage near the camera:** it is cut hard at 3.4 m. A dithered fade was tried and produced white-noise speckle.
- **Editing method:** most edits were made with small Node string-replace scripts. Check that every anchor actually matched.

## 7. Where it stands — latest review (#24, `captures/review-28/`)

**Verdict: `NEXT LEVEL: NO`, 7/10.** The reviewer's framing is the single most useful sentence
from 24 reviews: *"The frames you see along the walk (trailhead, cottage, pasture, meadow, night)
are lovely. The payoff frames (falls, forest, summit, dawn) are the weakest, and that is
backwards for a trekking game."*

**Praised:**
- Sky close to the reference.
- Dense, joyful flower meadows.
- Readable half-timbered cottage; cottageDusk is the best mood shot.
- Charming, well-grounded sheep.
- Beautiful night shot.
- Lake glint and reflections.
- Restrained title typography.

**Its ranked problems, with my notes:**

1. **Mountains read as smeared plaster** (title, trailhead, meadow, saddle, lake, lakeSunset).
   - **What it sees:** soft, blurred surfaces under faceted silhouettes; grass, rock and snow blend through mint and lavender washes.
   - **Cloud shadows:** they land as dark navy ink blots on the slope behind the cottage in trailhead and on the right-hand peak in meadow.
   - **Fixes:** crisp height and slope masks for the snow and grass lines with brushy edge noise; triplanar stroke-style rock with strata; fractal ridge detail; lighter, less saturated cloud shadows.
   - **My note:** cloud shadows are now strong in the valley at every distance (`w_cloudShadow` in `common.js`, `hiF` term). Lighten them to roughly 0.3 and desaturate the shadow tint. The cel-shaded far ramp went in this round; build on it rather than reverting it.
2. **Summit payoff is flat** (summit).
   - **What it sees:** a uniform green basin with noisy tree texture; nothing in the foreground; one pole with stiff flags on a taut line.
   - **Fixes:** a cairn, boulders and the bench in the foreground; two or three poles with sagging lines and fluttering cloth flags; a winding river, the waterfall plume and cottage smoke as landmarks in the valley; more relief.
   - **Implementation notes:**
     - Flags live in `props.js`.
     - Foreground rocks need real textured geometry. Plain `rockGeometry` placed right at the camera reads as untextured slabs; look at `rocks.js` `rockMaterial` and give it a proper close-range texture.
3. **Waterfall is weak** (falls).
   - **What it sees:** a grey slab cliff with stretched vertical smears; a thin white ribbon of water; mist floating free as a grey puff; a flat cyan stream with a hard edge against the gravel.
   - **Fixes:** a wider, tiered fall with flow-map foam; a plunge pool with a foam ring and spray; mossy, layered rock ledges; edge foam around rocks in the stream.
   - **My notes:**
     - The vertical smears come from the columnar cliff shader in `terrain.js`, which samples noise stretched along y. Add horizontal block breaks or switch to triplanar stroke rock.
     - The pool exists in `waterfall.js` but is hidden behind terrain from the falls camera.
4. **Forest is murky and dull** (forest).
   - **What it sees:** an olive-dark palette; plain blurry trunks; smeared canopy cards; clone-stamped ferns; dapples like leopard spots.
   - **Fixes:** volumetric light shafts and warm light pools; moss and root flare on trunks; mushrooms, flowers and logs; vary fern scale and tint; soft leaf-shaped dapple gobos.
5. **Low-sun grading breaks** (dawn, summitWest, lakeSunset).
   - **What it sees:** neon-lime valley grass under pink light at dawn; olive shadows and washed-out bloom in summitWest, plus a pink smear on the lower-right hill; muddy grey water in lakeSunset.
   - **Fix:** a per-time-of-day grade with blue-violet shadows, desaturated greens at low sun, warm rim light on silhouettes, and less haze and bloom.
6. **Distant trees look obviously procedural** (title, meadow, lake, summit).
   - **What it sees:** evenly scattered lollipop trees; far forests that read as moss or noise.
   - **Fix:** clustered placement with clearings, mixed species colours (larch gold, dark conifers), larger soft canopy impostors far away.
7. **Grass looks like a shag rug** (sheep, pasture, dawn).
   - **What it sees:** one hue, identical blades, no clumping; a dark repeating comb pattern at dawn.
   - **Fix:** low-frequency hue and value noise, dry tips, clover patches, varied clump height.
8. **Shorelines and props are thin** (lake, lakeSunset, trailhead, cottage).
   - **What it sees:** a blurry beige shore ring with no shallows; flat reed cards; a tiny jetty; a cottage alone on bare grass; an unreadable sign.
   - **Fixes:** turquoise shallows graded by depth, wet sand, shore rocks; a bigger jetty with a rowboat; ivy, a mossy roof, a woodpile, a garden, a shed and daytime chimney smoke for the cottage; larger sign lettering.

**Notes for the next agent:**
- **No depth of field.** The reviewer blames "depth-of-field blur" for soft near foliage, but there is no DOF pass. The softness comes from magnifying the **512² canvas leaf atlas** (`fluffy.js` `fluffyAtlas`, W = H = 512). Raising it to 1024 or 2048 is a cheap win for close-ups. The terrain also looks soft near the camera because of the render scale (`scale` in `QUALITY`); captures use `ultra`.
- **Daytime chimney smoke:** it exists (`village.js`, point sprites) but is nearly invisible against a bright sky. Raise its alpha and darken it slightly in daytime.
- **The rowboat:** `props.js` already builds one at the end of the jetty, but it is too small to read from the bench.

## 8. Recurring complaints across all reviews, most frequent first, with suggested approaches

1. **Distant terrain and mountains.**
   - **Complaints:** they read as "crumpled paper / airbrushed / smeared clay"; mid-distance slopes are "huge smooth green with nothing on them"; far forests are a "noise/moss carpet".
   - **Done:** far mountains are now cel-shaded on heavily smoothed normals (the crisp lavender shadow shapes in `patch.js` `rampFar` and the far-normal smoothing in `terrain.js`); cloud shadows are kept off snow; there is a macro ochre/moss mosaic.
   - **Next ideas:** grouped far-forest impostor groves with a lit top and shaded side, plus clearings; instanced rock-outcrop and scree meshes on steep mid-distance slopes; a visible treeline; 3–4 graded aerial-perspective bands tinted toward the sky, not green.
2. **Golden hour and dawn colour.**
   - **Complaints:** mid-ground turns olive and murky while lit foliage goes acid lime; summitWest foliage is lit lime while backlit.
   - **Done:** many scalar tweaks in `env.js` and `post.js`; they hit a ceiling.
   - **Next idea:** a proper per-time-of-day 3D LUT (or a hue-preserving grade keyed on `uGolden` / `dusk`) with a warm key and violet shadows, and darker backlit foliage.
3. **Waterfall set piece.**
   - **Done:** escarpment with a columnar cliff, lip, spray, pool, and a clear sightline.
   - **Remaining asks:** tiered or wider fall, foam rings, wet rocks, flow-mapped stream ripples.
4. **Summit payoff.**
   - **Complaints:** flags are stiff cards on a bare pole; the foreground is empty; the valley reads as a flat golf course.
   - **Avoid:** foreground boulders placed close to the camera read as untextured slabs and were removed.
   - **Next ideas:** subdivided cloth flags with flutter, several lines out from a cairn, a valley cloud-sea or layered haze below.
5. **Forest interior.**
   - **Complaints:** flat canopy ceiling, a bare Y-branch, trunk tops cut into the canopy, a single fern species, uniform dapples.
   - **Next ideas:** mushrooms, logs, mossy rocks, more undergrowth species, light shafts.
6. **Ground cover.**
   - **Complaints:** grass looks like "wallpaper/astroturf" and flowers sit at an even density right up to the trail.
   - **Next ideas:** single-species drifts with gaps, tall feature plants (lupins, foxgloves), thinning near the trail, colour variation at blade tips.
7. **Cottage.**
   - **Complaints:** a clean blockout with a LEGO-stepped gable edge, a blank sign, little clutter, and no daytime smoke.
   - **Next ideas:** woodpile, well, washing line, ivy, roof sag, a tree behind the house.
8. **Lake shore.**
   - **Complaints:** a uniform "bathtub" sand ring, a tiny jetty, glint blowing out to pure white.
   - **Done:** reeds and lily pads.
   - **Next ideas:** noisy shore width, grass reaching the water in places, clamped glint.
9. **Clouds.** Stacked shells and hard flat bottoms in some frames; they look like plasticine at dusk.

**Tried and reverted. Don't repeat these:**
- Horses and ponies: criticised every time.
- Low valley cloud puffs.
- Pushing golden-hour saturation: went neon lime.
- Regular strata stripes on far rock: read as zebra or stretched.
- A radial, drum-shaped escarpment: read as a concrete dam.
- Heavy point-sprite mist: a grey block clipped by the terrain.
- Near-camera summit boulders.
- Dithered foliage fade.
- Aerial-perspective veil starting at about 700 m: a milky grey band across the mountains.

## 9. Suggested plan for the next agent

1. Read `captures/review-28/` and the §7 issues. Crop every pointed-at detail before fixing it.
2. Target the frames that drag the average down: **summit, summitWest, dawn, lakeSunset, falls,
   forest.** The meadow, trailhead, cottage and night frames are already near the bar.
3. Make **structural** changes, not more scalar tweaks. The last ~12 rounds of tweaks moved the
   score by about ±0.5.
4. After each batch, reshoot only the affected shots, compare them with the previous set side by
   side, run playtest, then do a full capture and a fresh reviewer.
