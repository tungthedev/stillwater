// Shared GLSL: noise, terrain sampling, atmosphere, clouds.
// Uniforms are declared here and provided by the global uniform registry (src/uniforms.js).

export const NOISE = /* glsl */ `
float n_hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 n_hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float n_hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
// value noise with analytic derivatives, returns (value[-1,1], d/dx, d/dy)
vec3 n_noised(vec2 x){
  vec2 i = floor(x); vec2 f = fract(x);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 du = 30.0*f*f*(f*(f-2.0)+1.0);
  float a = n_hash12(i), b = n_hash12(i+vec2(1.0,0.0)), c = n_hash12(i+vec2(0.0,1.0)), d = n_hash12(i+vec2(1.0,1.0));
  float k1 = b-a, k2 = c-a, k4 = a-b-c+d;
  return vec3(-1.0 + 2.0*(a + k1*u.x + k2*u.y + k4*u.x*u.y), 2.0*du*vec2(k1 + k4*u.y, k2 + k4*u.x));
}
float n_noise(vec2 x){
  vec2 i = floor(x); vec2 f = fract(x); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(n_hash12(i), n_hash12(i+vec2(1,0)), u.x), mix(n_hash12(i+vec2(0,1)), n_hash12(i+vec2(1,1)), u.x), u.y);
}
`;

// Uniform block shared by world materials.
export const WORLD_PARS = /* glsl */ `
uniform sampler2D uHeightTex;   // near heightmap: r = height, g = trail mask (split: r + g = height, b = trail mask)
uniform sampler2D uFarHeightTex;// far heightmap: r = height (split: r + g = height)
uniform sampler2D uBiomeTex;    // r = forest, g = flowers, b = tall meadow
uniform sampler2D uShadowNear;  // terrain self-shadow, near
uniform sampler2D uShadowFar;   // terrain self-shadow, far
uniform sampler2D uSkyLUT;      // sky-view LUT (equirect, nonlinear elevation)
uniform sampler2D uNoiseTex;    // tileable rgba fbm
uniform float uWorldSize;
uniform float uFarSize;
uniform float uWaterLevel;
uniform float uHeightSplit;     // 0 = float32, 1 = half-float coarse (r) + remainder (g), 2 = same split filtered by hand
uniform float uTime;
uniform vec3 uSunDir;           // to sun
uniform vec3 uLightDir;         // to the active main light (sun or moon)
uniform vec3 uSunColor;
uniform vec3 uLightColor;
uniform vec3 uFogBeta;
uniform float uFogFalloff;
uniform float uMist;
uniform float uCloudCover;
uniform vec2 uCloudOffset;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uNight;
uniform float uSkyScale;
uniform vec3 uHorizonCol;
uniform float uGolden;
uniform float uDusk;
uniform float uDawn;
uniform float uAlpenglow;
uniform vec4 uAOSpot;
uniform vec4 uYardPath;
uniform vec4 uWarmLight;        // xyz = cottage lantern/porch pos, w = intensity
uniform vec4 uWarmLight2;       // xyz = gate lantern pos, w = intensity
uniform vec4 uWarmLight3;       // xyz = cottage ground-floor window front, w = intensity
uniform vec4 uWaterfall;        // xyz = waterfall foot pos, w = radius
// 1 on the cottage's stepping-stone path & dooryard, 0 elsewhere
float w_yard(vec2 xz){
  if (dot(uYardPath.zw, uYardPath.zw) < 1e-3) return 0.0;
  vec2 d = xz - uYardPath.xy;
  float L2 = dot(uYardPath.zw, uYardPath.zw);
  float t = clamp(dot(d, uYardPath.zw) / L2, 0.0, 1.0);
  float r = length(d - uYardPath.zw * t);
  float w = mix(1.6, 1.0, t);
  return 1.0 - smoothstep(w * 0.7, w, r);
}
`;

export const WORLD_FUNCS = /* glsl */ `
// Bilinear by hand for GPUs whose filter unit loses the split's precision (caps self-test).
vec4 w_texelBilerp(sampler2D s, vec2 uv){
  ivec2 res = textureSize(s, 0);
  vec2 p = clamp(uv * vec2(res) - 0.5, vec2(0.0), vec2(res) - 1.0);
  ivec2 i0 = ivec2(floor(p));
  ivec2 i1 = min(i0 + ivec2(1), res - ivec2(1));
  vec2 f = p - vec2(i0);
  return mix(mix(texelFetch(s, i0, 0), texelFetch(s, ivec2(i1.x, i0.y), 0), f.x),
             mix(texelFetch(s, ivec2(i0.x, i1.y), 0), texelFetch(s, i1, 0), f.x), f.y);
}
vec4 w_heightTexel(sampler2D s, vec2 uv){ return uHeightSplit > 1.5 ? w_texelBilerp(s, uv) : texture(s, uv); }
// Split storage: r + g is the height (g is 0 for desktop R32F far maps, and uHeightSplit
// zeroes the near map's g, which holds the trail mask there).
float w_heightNear(vec2 xz){
  vec4 t = w_heightTexel(uHeightTex, xz / uWorldSize + 0.5);
  return t.r + min(uHeightSplit, 1.0) * t.g;
}
float w_heightFar(vec2 xz){
  vec4 t = w_heightTexel(uFarHeightTex, xz / uFarSize + 0.5);
  return t.r + t.g;
}
float w_nearBlend(vec2 xz){
  float e = max(abs(xz.x), abs(xz.y));
  return smoothstep(uWorldSize*0.5 - 220.0, uWorldSize*0.5 - 20.0, e);
}
float w_height(vec2 xz){
  float t = w_nearBlend(xz);
  if (t <= 0.0) return w_heightNear(xz);
  if (t >= 1.0) return w_heightFar(xz);
  return mix(w_heightNear(xz), w_heightFar(xz), t);
}
vec3 w_normal(vec2 xz, float e){
  float hx0 = w_height(xz - vec2(e, 0.0)), hx1 = w_height(xz + vec2(e, 0.0));
  float hz0 = w_height(xz - vec2(0.0, e)), hz1 = w_height(xz + vec2(0.0, e));
  return normalize(vec3(hx0 - hx1, 2.0*e, hz0 - hz1));
}
// painterly meadow palette shared by terrain and grass blades (rich Ghibli/BotW multi-hue ground tapestry — NEVER a flat single-tone green slab!)
vec3 w_grassColor(vec2 xz, float h){
  vec4 a = texture(uNoiseTex, xz * 0.0014 + 0.11);
  vec4 b = texture(uNoiseTex, xz * 0.0075 + 0.37);
  vec4 big = texture(uNoiseTex, xz * 0.00052 + 0.6);
  vec4 mac = texture(uNoiseTex, xz * 0.00026 + 0.83);
  vec4 patchM = texture(uNoiseTex, xz * 0.0034 + 0.19);
  float t = a.r * 0.54 + b.g * 0.46;
  vec3 c0 = vec3(0.042, 0.195, 0.052); // deep lush emerald-clover shadow
  vec3 c1 = vec3(0.135, 0.375, 0.072); // vibrant sunlit meadow green
  vec3 c2 = vec3(0.36, 0.46, 0.11);    // warm sun-kissed spring hay-gold
  vec3 c = mix(c0, c1, smoothstep(0.20, 0.56, t));
  c = mix(c, c2, smoothstep(0.50, 0.80, t) * 0.82);
  // sweeping painterly BotW meadow value & hue drifts (breaks up title.png right meadow & lake.png shore!)
  c = mix(c, vec3(0.036, 0.215, 0.095), smoothstep(0.42, 0.74, big.g) * 0.68);
  c = mix(c, vec3(0.44, 0.45, 0.13), smoothstep(0.46, 0.76, big.b) * 0.62);
  c = mix(c, vec3(0.49, 0.41, 0.15), smoothstep(0.50, 0.76, mac.r) * 0.58);
  c = mix(c, vec3(0.052, 0.24, 0.105), smoothstep(0.48, 0.76, patchM.b) * 0.52);
  // subtle warm wildflower-drift meadow tint in sunny valley hollows
  c = mix(c, vec3(0.28, 0.42, 0.12), smoothstep(0.58, 0.82, patchM.r) * 0.42);
  // alpine heather / sunlit upland grass shift
  c = mix(c, vec3(0.42, 0.46, 0.18), smoothstep(640.0, 1020.0, h + (a.b - 0.5) * 180.0));
  return c;
}
float w_trailRaw(vec2 xz){
  vec2 uv = xz / uWorldSize + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  vec4 t = w_heightTexel(uHeightTex, uv);
  return uHeightSplit > 0.5 ? t.b : t.g;
}
float w_trail(vec2 xz){ return abs(w_trailRaw(xz)); }
vec4 w_biome(vec2 xz){
  vec2 uv = xz / uWorldSize + 0.5;
  vec4 b = texture(uBiomeTex, uv);
  float t = w_nearBlend(xz);
  return mix(b, vec4(0.55, 0.0, 0.3, 0.0), t);
}
float w_terrainShadow(vec3 wp){
  if (uLightDir.y < -0.02) return 0.0;
  float t = w_nearBlend(wp.xz);
  float sn = texture(uShadowNear, wp.xz / uWorldSize + 0.5).r;
  float sf = texture(uShadowFar, wp.xz / uFarSize + 0.5).r;
  float sh = mix(sn, sf, t);
  // fade out coarse raymarched uShadowFar blobs on distant mountains (ZERO dark oval ink stains while keeping crisp ridge shadows!)
  return mix(sh, 1.0, 0.86 * smoothstep(1400.0, 3200.0, length(wp - cameraPosition)));
}
// --- clouds (soft sweeping shadow bands over the valley, NEVER dark blots on mountains) ---
const float CLOUD_ALT = 2600.0;
float w_cloudDensityAt(vec2 xz){
  vec2 p = (xz + uCloudOffset) * 0.000048;
  vec4 a = texture(uNoiseTex, p);
  vec4 b = texture(uNoiseTex, p * 2.2 + a.xy * 0.12 + 0.37);
  float n = a.r * 0.70 + a.g * 0.20 + b.b * 0.10;
  float cov = uCloudCover;
  return smoothstep(1.0 - cov - 0.08, 1.0 - cov + 0.46, n);
}
float w_cloudShadow(vec3 wp){
  vec3 L = uLightDir;
  if (L.y < 0.03) return 1.0;
  vec2 xz = wp.xz + L.xz / max(L.y, 0.12) * (CLOUD_ALT - wp.y);
  float d = w_cloudDensityAt(xz);
  float far = smoothstep(400.0, 1800.0, length(wp - cameraPosition));
  // broad sweeping sunlit & cloud-shadowed valley bands in summit.png while keeping ALL mountain ranges 100% stain-free!
  float mountainFade = 1.0 - smoothstep(220.0, 400.0, wp.y);
  float strength = mix(0.24, 0.44, far) * mountainFade * smoothstep(0.03, 0.16, L.y);
  return 1.0 - strength * smoothstep(0.18, 0.74, d);
}
// Warm lantern/window light as a cheap analytic term instead of real-time lights: a tight dusk
// pool plus a wider ground pool that only grows at night. Falls off fast above the centre so
// roofs and canopies stay in twilight tones.
float w_warmPool(vec3 wp, vec4 L, float duskR, float duskK, float nightR, float nightK){
  vec3 d = wp - L.xyz;
  float r = length(d * vec3(1.0, 1.45, 1.0));
  float aboveFade = exp(-max(d.y - 0.50, 0.0) * 0.82);
  float duskPool = exp(-r * r / (2.0 * duskR * duskR)) * (1.0 - smoothstep(duskR * 1.8, duskR * 2.9, r)) * duskK;
  float nightYard = exp(-r * r / (2.0 * nightR * nightR)) * (1.0 - smoothstep(nightR * 1.15, nightR * 2.0, r)) * uNight * nightK;
  return (duskPool + nightYard) * aboveFade * L.w;
}
vec3 w_warmSpill(vec3 wp){
  if (uWarmLight.w <= 0.001) return vec3(0.0);
  float k = w_warmPool(wp, uWarmLight, 5.2, 0.042, 14.0, 0.125)
          + w_warmPool(wp, uWarmLight2, 3.6, 0.034, 7.0, 0.075)
          + w_warmPool(wp, uWarmLight3, 3.4, 0.240, 6.0, 0.120);
  return vec3(1.0, 0.58, 0.22) * k;
}
// --- sky LUT & aerial perspective ---
vec2 w_lutUV(vec3 dir){
  float az = atan(dir.z, dir.x);
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float u = clamp(fract(az / 6.2831853 + 0.5), 0.003, 0.997);
  float v = clamp(0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963), 0.005, 0.995);
  return vec2(u, v);
}
vec3 w_sky(vec3 dir){
  vec3 c = textureLod(uSkyLUT, w_lutUV(dir), 0.0).rgb * uSkyScale;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  return min(c, vec3(40.0));
}
// Every atmosphere step is linear in the surface colour (col * k + c * (1 - k) or a mix), so the whole
// chain folds into one multiply-add. That lets small geometry evaluate it per vertex and apply it per pixel.
void w_atmosphere(vec3 wp, out vec3 atmMul, out vec3 atmAdd){
  vec3 d = wp - cameraPosition;
  float dist = length(d);
  vec3 dir = d / max(dist, 1e-3);
  // exponential height haze, analytic integral along the ray
  float fh = uFogFalloff;
  float y0 = cameraPosition.y;
  float k = dir.y * dist * fh;
  float integ = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
  float od = min(dist * exp(-y0 * fh) * integ, 8500.0 + dist * 0.22);
  vec3 ext = exp(-od * uFogBeta);
  // low valley mist pooling softly in the lake basin & troughs (luminous, never muddy)
  float mf = 1.0 / 55.0;
  float ya = cameraPosition.y - (uWaterLevel + 8.0);
  float yb = wp.y - (uWaterLevel + 8.0);
  float dy = yb - ya;
  float avgD = abs(dy) > 0.5 ? (exp(-max(min(ya, yb), 0.0) * mf) - exp(-max(max(ya, yb), 0.0) * mf)) / (abs(dy) * mf) : exp(-max(ya, 0.0) * mf);
  float odm = uMist * dist * avgD;
  float extm = exp(-odm * 0.0018);

  vec3 hd = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.8 + 0.04 + max(-dir.y, 0.0) * 0.55, dir.z));
  vec3 insc = w_sky(hd);
  {
    float li = dot(insc, vec3(0.2126, 0.7152, 0.0722));
    insc = max(mix(vec3(li), insc, 1.18), 0.0);
    insc.g = min(insc.g, (insc.r + insc.b) * 0.55);
    // crisp azure-cool in day, warm apricot-rose at golden/dawn, velvety violet-indigo at dusk
    vec3 goldAir = vec3(li) * mix(vec3(1.14, 0.84, 0.80), vec3(1.16, 0.90, 0.84), uDawn);
    insc = mix(insc, goldAir, uGolden * 0.42 * smoothstep(0.15, -0.15, dir.y));
    vec3 duskAir = vec3(max(li, 0.02)) * vec3(0.88, 0.74, 1.24);
    insc = mix(insc, duskAir, uDusk * 0.35 * (1.0 - uNight));
  }
  // keep aerial haze a clean, flat, un-rippled colour gradient at mid/far distances (kills see-through water-sheet banding in summit.png & dawn.png!)
  // Branches below skip work whose weight is exactly zero, so they change cost, not colour.
  float shadowAir = dist < 1400.0 ? mix(w_terrainShadow(wp), 1.0, smoothstep(500.0, 1400.0, dist)) : 1.0;
  vec3 zen = w_sky(vec3(0.0, 1.0, 0.0));
  float zl = dot(zen, vec3(0.2126, 0.7152, 0.0722));
  vec3 coolAir = mix(vec3(zl), zen, 0.65) * vec3(0.88, 0.97, 1.15) * 1.55;
  float sunwardA = pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z) + 1e-4), normalize(vec3(uLightDir.x, 0.0, uLightDir.z) + 1e-4)), 0.0), 2.0);
  insc = mix(min(insc, coolAir), insc, 0.45 + 0.55 * max(shadowAir, sunwardA * 0.8));

  vec3 mistCol = mix(vec3(zl), zen, 0.55) * vec3(0.92, 0.98, 1.16) * 1.55 + uLightColor * 0.05 * pow(max(dot(dir, uLightDir), 0.0), 4.0);
  // dawn valley mist: luminous pale lavender-rose sky glow (ZERO murky teal-green!)
  mistCol = mix(mistCol, mistCol * vec3(1.16, 0.94, 1.14), uDawn * 0.72);
  mistCol = mix(mistCol, mistCol * vec3(1.08, 0.92, 1.06), uGolden * (1.0 - uDawn) * 0.55);

  atmMul = ext * extm;
  atmAdd = (insc * (1.0 - ext)) * extm + mistCol * (1.0 - extm);

  // Firewatch / BotW 3-plane aerial perspective:
  // Distant mountains ALWAYS step LIGHTER & BLUER than the mid-distance, and base valleys lift into airy sky mist (NEVER a dark teal wall!)
  if (dist > 1450.0) {
    vec3 skyHor = w_sky(normalize(vec3(dir.x, 0.14, dir.z)));
    vec3 skyMid = w_sky(normalize(vec3(dir.x, 0.28, dir.z)));
    float lh = dot(skyHor, vec3(0.2126, 0.7152, 0.0722));
    // luminous airy cerulean-periwinkle aerial light (brighter than dark valley foliage -> true depth recession!)
    vec3 airyBlue = max(mix(vec3(lh), mix(skyHor, skyMid, 0.45), 1.12) * vec3(0.92, 0.98, 1.18), vec3(0.0));
    airyBlue = mix(airyBlue, vec3(max(lh, 0.06)) * vec3(1.14, 0.94, 1.18), uDawn * 0.68);
    airyBlue = mix(airyBlue, vec3(max(lh, 0.05)) * vec3(1.08, 0.86, 1.14), uGolden * (1.0 - uDawn) * 0.55);
    airyBlue = mix(airyBlue, vec3(max(lh, 0.03)) * vec3(0.90, 0.78, 1.24), uDusk * 0.55 * (1.0 - uNight));
    float sunward = pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z) + 1e-4), normalize(vec3(uLightDir.x, 0.0, uLightDir.z) + 1e-4)), 0.0), 3.0) * smoothstep(-0.05, 0.1, uLightDir.y);
    float goldEve = uGolden * (1.0 - uDawn);

    // Layer 1: soft luminous low valley-basin mist separating foothills from valley floor (strictly low in basin at dawn — ZERO lavender mountain wall!)
    float highLook = smoothstep(200.0, 380.0, cameraPosition.y) * smoothstep(0.05, -0.18, dir.y);
    float lowBasinMist = exp(-max(wp.y - uWaterLevel - 18.0, 0.0) / mix(260.0, 92.0, uDawn));
    float peakCrisp = 1.0 - mix(0.42, 0.68, max(uDawn, goldEve)) * smoothstep(520.0, 1450.0, wp.y);
    float range1 = smoothstep(1450.0, 3600.0, dist) * (0.10 + 0.32 * lowBasinMist) * peakCrisp * (1.0 - 0.56 * highLook) * (1.0 - 0.48 * uNight);
    vec3 tint1 = mix(airyBlue * 1.06, insc * 1.04, 0.22 + 0.34 * sunward * goldEve);
    float a1 = clamp(range1, 0.0, 0.40);
    atmMul *= 1.0 - a1; atmAdd = atmAdd * (1.0 - a1) + tint1 * a1;

    // Layer 2: crisp mid-sierra Firewatch depth plane (keeps dawn & sunset mountain faces sharp and high-contrast!)
    float lowSunClear = 1.0 - max(uDawn * 0.60, goldEve * 0.54);
    float range2 = smoothstep(3500.0, 7200.0, dist) * (0.16 + 0.18 * lowBasinMist) * peakCrisp * lowSunClear * (1.0 - 0.42 * uNight);
    vec3 tint2 = mix(airyBlue * 1.12, insc * 1.06, 0.28 + 0.34 * sunward * goldEve);
    float a2 = clamp(range2, 0.0, 0.38);
    atmMul *= 1.0 - a2; atmAdd = atmAdd * (1.0 - a2) + tint2 * a2;

    // Layer 3: far high sierra pale cerulean-violet horizon plane (distinct 3rd skyline silhouette with razor-clear sunlit peaks!)
    float peakClear = smoothstep(1150.0, 1950.0, wp.y);
    float range3 = smoothstep(6800.0, 14200.0, dist) * mix(0.42, 0.22, peakClear) * lowSunClear * (1.0 - 0.36 * uNight);
    vec3 tint3 = mix(airyBlue * 1.18, insc * 1.08, 0.30 + 0.38 * sunward * goldEve);
    float a3 = clamp(range3, 0.0, 0.48);
    atmMul *= 1.0 - a3; atmAdd = atmAdd * (1.0 - a3) + tint3 * a3;
  }
  // restrained warm sun-glow in the sunset V-notch (preserves crisp flanking mountain silhouettes!)
  if (uGolden > 0.0 && dot(dir, uSunDir) > 0.0) {
    float sd = max(dot(dir, uSunDir), 0.0);
    float ridgeH = smoothstep(140.0, 500.0, wp.y);
    float glowA = (pow(sd, 34.0) * 0.18 + pow(sd, 110.0) * 0.36) * (1.0 - exp(-dist * 1.2e-4)) * uGolden * (1.0 - uDawn * 0.65) * smoothstep(-0.05, 0.02, uSunDir.y) * (0.35 + 0.65 * ridgeH);
    vec3 sunAir = uSunColor * vec3(1.0, 0.78, 0.50) * 1.28 + w_sky(normalize(vec3(uSunDir.x, 0.06, uSunDir.z))) * 0.42;
    float a4 = clamp(glowA, 0.0, 0.30);
    atmMul *= 1.0 - a4; atmAdd = atmAdd * (1.0 - a4) + sunAir * a4;
  }
}
vec3 w_applyAtmosphere(vec3 col, vec3 wp){
  vec3 atmMul, atmAdd;
  w_atmosphere(wp, atmMul, atmAdd);
  return col * atmMul + atmAdd;
}
`;

export const COMMON = NOISE + WORLD_PARS + WORLD_FUNCS;
