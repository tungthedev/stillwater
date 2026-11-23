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
uniform sampler2D uHeightTex;   // near heightmap: r = height, g = trail mask
uniform sampler2D uFarHeightTex;// far heightmap: r = height
uniform sampler2D uBiomeTex;    // r = forest, g = flowers, b = tall meadow
uniform sampler2D uShadowNear;  // terrain self-shadow, near
uniform sampler2D uShadowFar;   // terrain self-shadow, far
uniform sampler2D uSkyLUT;      // sky-view LUT (equirect, nonlinear elevation)
uniform sampler2D uNoiseTex;    // tileable rgba fbm
uniform float uWorldSize;
uniform float uFarSize;
uniform float uWaterLevel;
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
uniform float uAlpenglow;
uniform vec4 uAOSpot;
uniform vec4 uYardPath;
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
float w_heightNear(vec2 xz){ return texture(uHeightTex, xz / uWorldSize + 0.5).r; }
float w_heightFar(vec2 xz){ return texture(uFarHeightTex, xz / uFarSize + 0.5).r; }
float w_nearBlend(vec2 xz){
  float e = max(abs(xz.x), abs(xz.y));
  return smoothstep(uWorldSize*0.5 - 220.0, uWorldSize*0.5 - 20.0, e);
}
float w_height(vec2 xz){
  float t = w_nearBlend(xz);
  float hn = w_heightNear(xz);
  float hf = w_heightFar(xz);
  return mix(hn, hf, t);
}
vec3 w_normal(vec2 xz, float e){
  float hx0 = w_height(xz - vec2(e, 0.0)), hx1 = w_height(xz + vec2(e, 0.0));
  float hz0 = w_height(xz - vec2(0.0, e)), hz1 = w_height(xz + vec2(0.0, e));
  return normalize(vec3(hx0 - hx1, 2.0*e, hz0 - hz1));
}
// painterly meadow palette shared by terrain and grass blades
vec3 w_grassColor(vec2 xz, float h){
  vec4 a = texture(uNoiseTex, xz * 0.0013 + 0.11);
  vec4 b = texture(uNoiseTex, xz * 0.0071 + 0.37);
  float t = a.r * 0.62 + b.g * 0.38;
  vec3 c0 = vec3(0.05, 0.21, 0.04);
  vec3 c1 = vec3(0.14, 0.39, 0.07);
  vec3 c2 = vec3(0.31, 0.47, 0.12);
  vec4 big = texture(uNoiseTex, xz * 0.00045 + 0.6);
  vec3 c = mix(c0, c1, smoothstep(0.28, 0.55, t));
  c = mix(c, c2, smoothstep(0.58, 0.8, t) * 0.7);
  c = mix(c, vec3(0.05, 0.26, 0.09), smoothstep(0.5, 0.75, big.g) * 0.55);   // emerald drifts
  c = mix(c, vec3(0.36, 0.44, 0.12), smoothstep(0.55, 0.8, big.b) * 0.4);    // sunlit hay
  vec4 mac = texture(uNoiseTex, xz * 0.00021 + 0.83);
  c = mix(c, vec3(0.42, 0.42, 0.13), smoothstep(0.6, 0.78, mac.r) * 0.45);   // ochre dry grass
  c = mix(c, vec3(0.05, 0.2, 0.12), smoothstep(0.62, 0.8, mac.g) * 0.4);    // cool moss
  c *= vec3(0.96, 0.94, 1.0);
  c = mix(c, vec3(0.46, 0.52, 0.2), smoothstep(700.0, 1050.0, h + (a.b - 0.5) * 200.0));
  return c;
}
float w_trailRaw(vec2 xz){
  vec2 uv = xz / uWorldSize + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  return texture(uHeightTex, uv).g;
}
float w_trail(vec2 xz){ return abs(w_trailRaw(xz)); }
vec4 w_biome(vec2 xz){
  vec2 uv = xz / uWorldSize + 0.5;
  vec4 b = texture(uBiomeTex, uv);
  float t = w_nearBlend(xz);
  // beyond the near map: forests on lower slopes, procedurally
  return mix(b, vec4(0.55, 0.0, 0.3, 0.0), t);
}
float w_terrainShadow(vec3 wp){
  if (uLightDir.y < -0.02) return 0.0;
  float t = w_nearBlend(wp.xz);
  float sn = texture(uShadowNear, wp.xz / uWorldSize + 0.5).r;
  float sf = texture(uShadowFar, wp.xz / uFarSize + 0.5).r;
  float sh = mix(sn, sf, t);
  return mix(sh, 1.0, 0.55 * smoothstep(1500.0, 4000.0, length(wp - cameraPosition)));
}
// --- clouds (2D layer at altitude) ---
const float CLOUD_ALT = 2600.0;
float w_cloudDensityAt(vec2 xz){
  vec2 p = (xz + uCloudOffset) * 0.00011;
  vec4 a = texture(uNoiseTex, p);
  vec4 b = texture(uNoiseTex, p * 3.7 + a.xy * 0.12 + 0.37);
  float n = a.r * 0.62 + a.g * 0.25 + b.b * 0.13 + b.a * 0.05;
  float cov = uCloudCover;
  return smoothstep(1.0 - cov, 1.0 - cov + 0.34, n);
}
float w_cloudShadow(vec3 wp){
  vec3 L = uLightDir;
  if (L.y < 0.02) return 1.0;
  vec2 xz = wp.xz + L.xz / L.y * (CLOUD_ALT - wp.y);
  float d = w_cloudDensityAt(xz);
  float far = smoothstep(500.0, 1800.0, length(wp - cameraPosition));
  float hiF = far * smoothstep(650.0, 950.0, wp.y);
  return 1.0 - mix(mix(0.55, 0.42, far), 0.03, hiF) * smoothstep(0.2, 0.55, d);
}
// --- sky LUT & aerial perspective ---
vec2 w_lutUV(vec3 dir){
  float az = atan(dir.z, dir.x);
  float el = asin(clamp(dir.y, -1.0, 1.0));
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963);
  return vec2(az / 6.2831853 + 0.5, v);
}
vec3 w_sky(vec3 dir){
  vec3 c = texture(uSkyLUT, w_lutUV(dir)).rgb * uSkyScale;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  return min(c, vec3(40.0));
}
vec3 w_applyAtmosphere(vec3 col, vec3 wp){
  vec3 d = wp - cameraPosition;
  float dist = length(d);
  vec3 dir = d / max(dist, 1e-3);
  // exponential height haze, analytic integral along the ray
  float fh = uFogFalloff;
  float y0 = cameraPosition.y;
  float k = dir.y * dist * fh;
  float integ = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
  float od = min(dist * exp(-y0 * fh) * integ, 9000.0 + dist * 0.25);
  vec3 ext = exp(-od * uFogBeta);
  // low valley mist hugging the water level (density 1 at the water, scale height 35 m)
  float mf = 1.0 / 35.0;
  float ya = cameraPosition.y - uWaterLevel;
  float yb = wp.y - uWaterLevel;
  float dy = yb - ya;
  float avgD = abs(dy) > 0.5 ? (exp(-max(min(ya, yb), 0.0) * mf) - exp(-max(max(ya, yb), 0.0) * mf)) / (abs(dy) * mf) : exp(-max(ya, 0.0) * mf);
  float odm = uMist * dist * avgD;
  float extm = exp(-odm * 0.0022);
  vec3 hd = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.85 + 0.03 + max(-dir.y, 0.0) * 0.6, dir.z));
  vec3 insc = w_sky(hd);
  { float li = dot(insc, vec3(0.2126, 0.7152, 0.0722)); insc = max(mix(vec3(li), insc, 1.15), 0.0); insc.g = min(insc.g, (insc.r + insc.b) * 0.56);
    insc = mix(insc, vec3(li) * vec3(1.12, 0.86, 0.82), uGolden * 0.45 * smoothstep(0.1, -0.15, dir.y)); }
  float shadowAir = w_terrainShadow(wp);
  vec3 zenA = w_sky(vec3(0.0, 1.0, 0.0));
  vec3 coolAir = mix(vec3(dot(zenA, vec3(0.2126, 0.7152, 0.0722))), zenA, 0.55) * 1.6;
  float sunwardA = pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uLightDir.x, 0.0, uLightDir.z) + 1e-4)), 0.0), 2.0);
  insc = mix(min(insc, coolAir), insc, 0.25 + 0.75 * max(shadowAir, sunwardA * 0.8));
  vec3 zen = w_sky(vec3(0.0, 1.0, 0.0));
  float zl = dot(zen, vec3(0.2126, 0.7152, 0.0722));
  vec3 mistCol = mix(vec3(zl), zen, 0.4) * 1.6 + uLightColor * 0.06 * pow(max(dot(dir, uLightDir), 0.0), 4.0);
  col = col * ext + insc * (1.0 - ext);
  col = col * extm + mistCol * (1.0 - extm);
  // art-directed aerial perspective: distant ridges step back into cool (or sun-warmed) haze
  {
    vec3 cool = w_sky(normalize(vec3(dir.x, 0.22, dir.z)));
    float lc = dot(cool, vec3(0.2126, 0.7152, 0.0722));
    cool = mix(vec3(lc), cool, 1.05) * vec3(0.9, 1.0, 1.1);
    cool.r = min(cool.r, cool.g * 0.98);
    float sunward = pow(max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uLightDir.x, 0.0, uLightDir.z))), 0.0), 3.0) * smoothstep(-0.05, 0.1, uLightDir.y);
    vec3 tint = mix(cool, insc, 0.35 + 0.4 * sunward * uGolden);
    tint.g = min(tint.g, (tint.r + tint.b) * 0.58);
    float layer = smoothstep(2500.0, 14000.0, dist) * (0.5 - 0.22 * uGolden);
    col = mix(col, tint, layer);
  }
  // warm glow toward the low sun, swallowing far ridges near the sun into light
  {
    float sd = max(dot(dir, uSunDir), 0.0);
    float glowA = (pow(sd, 14.0) * 0.38 + pow(sd, 60.0) * 0.6) * (1.0 - exp(-dist * 1.6e-4)) * uGolden * smoothstep(-0.05, 0.02, uSunDir.y);
    col = mix(col, uSunColor * vec3(1.0, 0.82, 0.6) * 1.4 + w_sky(normalize(vec3(uSunDir.x, 0.05, uSunDir.z))) * 0.5, clamp(glowA, 0.0, 0.6));
  }
  return col;
}
`;

export const COMMON = NOISE + WORLD_PARS + WORLD_FUNCS;
