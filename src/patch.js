import * as THREE from 'three';
import { COMMON } from './glsl/common.js';
import { U } from './uniforms.js';

let keyCounter = 0;

/**
 * Patch a built-in three.js material so it shares the world's lighting model:
 * aerial perspective fog, terrain self-shadow + cloud shadow on the main light,
 * stylized painterly toon ramp with warm-key / cool-shadow separation, and
 * access to all world uniforms/functions.
 */
export function patchMaterial(mat, opts = {}) {
  const key = 'wm' + keyCounter++;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, opts.uniforms || {});
    let vs = shader.vertexShader;
    let fs = shader.fragmentShader;

    vs = vs.replace(
      '#include <common>',
      '#include <common>\n' + COMMON + '\nvarying vec3 vWPos;\n' + (opts.vertexPars || '')
    );
    vs = vs.replace(
      '#include <fog_vertex>',
      `#include <fog_vertex>
      {
        vec4 w_wp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          w_wp = instanceMatrix * w_wp;
        #endif
        vWPos = (modelMatrix * w_wp).xyz;
      }`
    );
    for (const [a, b] of opts.vertex || []) {
      if (!vs.includes(a)) console.warn('patch: vertex token missing', a);
      vs = vs.replace(a, b);
    }

    fs = fs.replace(
      '#include <common>',
      '#include <common>\n' + COMMON + '\nvarying vec3 vWPos;\n' + (opts.fragmentPars || '')
    );
    // stylized, painterly soft-banded direct lighting (warm lit planes, cool luminous sky shadows)
    const wrap = (opts.toonWrap ?? 0.35).toFixed(3);
    const lo = (opts.toonLo ?? 0.18).toFixed(3), hi = (opts.toonHi ?? 0.62).toFixed(3);
    fs = fs.replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
      void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
        float ndl = dot( geometryNormal, directLight.direction );
        float w = ( ndl + ${wrap} ) / ( 1.0 + ${wrap} );
        float distR = smoothstep( 1150.0, 2300.0, length( geometryPosition ) );
        float rampNear = smoothstep( ${lo}, ${hi}, w );
        // crisp graphic 3-value-step BotW/Ghibli mountain shading: bold shadow plane / clean mid facet / sunlit plane (KILLS melted-wax smooth gradients!)
        float band1 = smoothstep( 0.06, 0.13, w );
        float band2 = smoothstep( 0.36, 0.44, w );
        float rampFar = band1 * 0.38 + band2 * 0.62;
        float ramp = mix( rampNear, rampFar, distR );
        vec3 irradiance = ramp * directLight.color;
        reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
        vec3 H = normalize( directLight.direction + geometryViewDir );
        // ZERO glossy plastic specular on matte terrain, rock, snow or grass (roughness >= 0.62)!
        float specMask = smoothstep( 0.62, 0.14, material.roughness );
        float sp = pow( max( dot( geometryNormal, H ), 0.0 ), 48.0 ) * specMask;
        reflectedLight.directSpecular += directLight.color * sp * 0.22 * ramp;
      }
      #undef RE_Direct
      #define RE_Direct RE_Direct_Toon
    `);
    // luminous cool-blue/violet indirect sky shadows (prevents flat grey or muddy olive shadows)
    fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      {
        float li = dot(reflectedLight.indirectDiffuse, vec3(0.2126, 0.7152, 0.0722));
        vec3 ind = max(mix(vec3(li), reflectedLight.indirectDiffuse, 1.28), 0.0);
        // crisp cool-blue/lavender luminous shadows (clean lavender at dawn, NEVER murky teal-green!)
        vec3 coolTint = mix(vec3(0.95, 1.00, 1.15), vec3(0.98, 0.86, 1.26), max(uGolden, uDusk * 0.85));
        coolTint = mix(coolTint, vec3(1.06, 0.90, 1.24), uDawn * 0.85);
        reflectedLight.indirectDiffuse = ind * coolTint * mix(1.07, 1.0, uNight);
      }`);
    const sunVis = opts.sunVis !== false;
    fs = fs.replace(
      'void main() {',
      `void main() {
        float w_sunVis = ${sunVis ? 'w_terrainShadow(vWPos) * w_cloudShadow(vWPos)' : '1.0'};`
    );
    fs = fs.replace(
      '#include <lights_fragment_begin>',
      THREE.ShaderChunk.lights_fragment_begin.replace(
        'getDirectionalLightInfo( directionalLight, directLight );',
        'getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= w_sunVis;'
      )
    );
    fs = fs.replace(
      '#include <fog_fragment>',
      (opts.beforeFog || '') + '\n gl_FragColor.rgb = w_applyAtmosphere(gl_FragColor.rgb, vWPos);'
    );
    for (const [a, b] of opts.fragment || []) {
      if (!fs.includes(a)) console.warn('patch: fragment token missing', a);
      fs = fs.replace(a, b);
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    if (opts.onShader) opts.onShader(shader);
  };
  return mat;
}
