# Stillwater — progress log

Run it: `npm run dev` → http://127.0.0.1:5173/ (click to begin). Hourly screenshot sets: `captures/hourly/index.html`.

## Direction
Stylized, painterly alpine valley in the spirit of the reference image the user supplied
(saturated azure sky, big puffy cumulus, lush bright greens, fluffy round tree crowns, warm dirt
paths, cool blue shadows). Calm walking/trekking: a trail from a trailhead past a lake, through a
saddle, up to a summit viewpoint. Time of day flows; sit on benches to watch it pass.

## Log
- **Session start** — engine: GPU-generated terrain (2 km walkable + 32 km far ring, quadtree LOD),
  A*-planned switchback trail carved into the terrain, physically based sky LUT, lake with planar
  reflections, GPU grass/flowers, instanced trees/rocks, props (signpost, benches, cairns, prayer
  flags), birds, fireflies, procedural audio (wind, birds, footsteps, generative music), post FX.
- **Realism pass** (rejected by user as too low quality) — see `captures/review-01/`.
- **Stylized pivot** — toon-ramp lighting on every material, fluffy clump-based trees (leaf cards on
  spherical-normal blobs), 3D cumulus clouds, saturated sky, painterly shared grass palette,
  vivid tonemap with split toning, bushes.
- **Bugs fixed** — black screen (bad exposure input), reversed-depth breaking the depth test,
  orange fog band at sunset, lake "stripes" (mirror camera looked the wrong way), causeway across
  the lake, dark flower flecks, blotchy snow.
- **Review #1 (fresh Opus): NO, 5.5/10** — weak summit payoff, smeared mountains, plain cottage, foliage breakup, sparse forest, decal path, ball clouds, little life.
- **Fixes** — storybook cottage (stone, timber, shutters, warm windows, lantern, smoke, moss), alpenglow, art-directed aerial perspective, camera-facing flowers along the trail, ferns/logs/toadstools, butterflies, bigger sheep, near-camera foliage fade, toon-banded terrain light, 3D cumulus.
- **Review #2: NO, 6/10** — long views wash out, times of day too similar, cottage polish, crude sheep, ball clouds, one-note greens, bark artifacts, decal path.
- **Fixes** — opaque unified cumulus with ragged edges, sunset sky band + bigger sun + per-time shadow tint, stars/Milky Way, woolly sheep + grazing horses, smaller varied path pebbles, waterfall/stream landmark (Dijkstra-routed down a mountain flank into the lake, with spray + sound), reflection/skirt/winding bug fixes.
- **Review #3: NO, 6.5/10** · **Review #4: NO, 7/10** · **Review #5: NO, 6.5/10** — recurring asks: summit payoff, melted-clay mountains, fake water, forest feel, horses.
- **Fixes** — waterfall that reads from the lake (Fresnel stream, streaked falls, spray), procedural bark, saturation-preserving shadows, sunset/sunrise sky bands, prayer flags framing the summit view with a cairn, irregular ridged summit, NaN 'double sun' bug, horses rebuilt from capsules, saddle sightline cleared, fences fixed, terraced cliff-band mountains, low valley clouds, closed forest canopy over the trail, emerald/hay grass variation, iGPU 'low' preset (no planar reflection, lighter trees, cheaper clouds).
- **Review #6: NO, 6.5** · **#7: NO, 6.5** · **#8: NO, 6.5** — plateau; recurring: mountains, sunset grading, water, horses, clouds.
- **Fixes** — painterly far mountains (smoothed far normals, coherent grass/stone/snow bands, cooler stone), forest light shafts + leaf litter + dappled light, cottage flagstone path & clutter, sheep moved to open pasture with spacing, lofted horses with blaze/socks, real waterfall (flanking wet rocks, plunge pool, mist), reeds on the shore, printed prayer flags, clouds lifted into towering banks behind the peaks with soft alpha-to-coverage edges, moonlit night clouds, Milky Way seam fix, local-only terrain shadows so golden light reaches the valley, distinct groves & meadows, fresher golden-hour greens.
- **Review #9: NO, 6.5** · **#10: NO, 7 (best)** · **#11: NO, 6.5**.
- **Fixes** — sunset notch carved into the western range (sun sets into a V-gap from the summit), distance-softened toon ramp (no far blotches), real 24 m cliff waterfall with rock buttresses + plunge pool + mist + clear sightline, wooden footbridge where trail crosses the stream, chunky stylized ponies matching the puffy sheep, smooth rounded rocks, smooth far-tree silhouettes, canopy masses instead of speckle, warm sun glow in the haze, hue-preserving golden light, lantern posts along the trail, moonlit translucent night clouds, faster bush clusters near the lake.
- **Review #12: NO, 6.5** · **#13: NO, 6.5** ("whipped-cream mountains").
- **Fixes** — sharp ridged peaks (squared ridged noise, crisper far normals, slope-driven rock on crests, lower crisp snow line, stronger crest rim light), clean far zone painting, chartreuse→green golden grade, orange/lilac sunset clouds, cottage lit only by windows at dusk, flagstones on the ground, tapered pony legs with hooves, varied prayer-flag prints + second strand, mossy cliff, rocks kept out of the falls.
- **Review #14: NO, 6.5**.
- **Fixes** — dedicated curved waterfall sheet in front of a cracked-block cliff, curvature crevices/lit crests on mountains, dappled sun pools in the forest, ponies removed (every reviewer rejected them; sheep carry the pastoral feel), deeper less-lime grass, pollen motes only glint when backlit (were reading as daytime stars), peach sunset cloud tops, bigger cottage & better framing, lake jetty + rowboat, distant wildflower specks in far meadows, warmer rocks.
- **Review #15: NO, 7 (ties best)**.
- **Fixes** — mip-aware foliage alpha (cards no longer vanish at distance exposing bare branches), branch skeletons removed, thicker trunks, calmer unified tree hues, aerial perspective layering the mid-ground, patchy pebble/sand shoreline, coloured (not grey) shadows, bushes hugging the cottage foundation, better forest framing, slimmer sheep legs.
- **Review #16: NO, 7**.
- **Fixes** — golden hour: brighter warm key + violet-blue sky fill + exposure lift, half the mist/haze at low sun, chartreuse pulled to green; far slopes banded by altitude (no blotches); luminous peach sunset clouds; no pancake boulders.
- **Review #17: NO, 7**.
- **Fixes** — triplanar cliff texturing, aerial perspective starts at 2.5 km (foothills keep colour), less smeared far lighting, softer yellow-green forest dapples, lighter ferns, sheep faces (eyes, muzzle) + lambs, backlit cloud rims; new lake-at-sunset reflection shot; waterfall now framed from the stream bank through the trees.
- **Review #18: NO, 7**.
- **Fixes** — far mountains: green climbs higher, darker warm-grey stone with subtle broken strata, crisp snow; golden-hour lit greens keep saturation with teal shade; summit foreground boulders + second cairn; unified cloud cluster shading; warm light spill around the cottage at dusk.
- **Review #19: NO, 7**.
- **Fixes** — removed near-camera summit boulders (read as untextured slabs) and framed the summit higher; smaller canopy cores so leaf cards dominate (no foil facets), calmer lime, gentler backlight; waterfall cliff raised to ~44 m; calmer stream bank; cloud shadows fade fast with distance; amber (not pink) night window light; longer jetty; woolly sheep legs with dark hooves.
- **Review #20: NO, 6.5**. Changed approach: structural fixes instead of tweaks.
- **Fixes** — trees rebuilt as painterly canopies (flat-toned lobed leaf atlas, crown-dominant normals, fewer/larger cards, smooth cores), visible branches into lower clumps, root flare, no trunk seam, clean near-camera cut (no jelly blobs/speckle); waterfall cliff widened into a broad escarpment with stylized columnar rock and mossy ledges, wider water sheet; meadow stones fewer, raised and less tilted (no ghost/sticker rocks).
- **Review #21: NO, 7** (waterfall cliff read as a concrete drum/dam).
- **Fixes** — escarpment reshaped: vertical rock only near the fall, jagged brink, easing into slope sideways; broken/tilted ledges and softer rock columns; meadow macro mosaic (ochre dry grass, cool moss); cloud shadows kept on the valley at distance (off the snow); summit shot moved to 17:30 (crisp snow, cloud-shadowed valley). Low-preset fps on HD 520 measured 14.8 in headless capture mode.
- **Review #22: NO, 6.5**.
- **Fixes** — new lake-shore dressing (src/world/shore.js): wind-swaying reed beds with cattails in drifts along the waterline, lily-pad rafts with pink/white flowers in the shallows, kept clear of jetty and bench; stream foam and colour fade with distance (no white staircase from the lake); pebble texture on the stream bank (no asphalt); trees cleared from the waterfall sightline; cottage night light spill now a soft amber pool (no lime ring); title overlay reduced to a soft gradient behind the text.
- **Review #23: NO, 7**.
- **Fixes** — distant mountains cel-shaded on smoothed big forms (crisp lavender shadow shapes instead of soft crumpled-paper gradients), stretched strata removed; waterfall water now curls over a visible lip with a ragged top edge and a soft spray plume at the base; stepping-stone path to the cottage door kept clear of grass and flowers.
- **Review #24 (review-28): NO, 7**. Payoff frames (falls, forest, summit, dawn) are the weakest; the walk-along frames are lovely. Loop paused here at the owner's request — see handoff.md for the full state and next steps.
