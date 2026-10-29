import * as THREE from 'three';
import {
  NOISE,
  OCEAN_WAVES,
  DETAIL_NORMAL,
  ATMOSPHERE,
  WATER_TINT,
  CLOUD_SHADOW,
} from './shaders/common.js';

export const MAX_FOAM_BODIES = 16;
// Must match `#define MAX_WAVES` in shaders/common.js.
export const MAX_WAVES = 40;

const fract = (v) => v - Math.floor(v);

// Default wave-field / look configuration. Everything the GUI tweaks lives here.
export const OCEAN_CONFIG = {
  windDir: new THREE.Vector2(1.0, 0.55).normalize(),
  waveCount: 26,
  windSpeed: 8.5,        // m/s at 10 m — fixes the JONSWAP peak frequency
  baseWavelength: 150.0, // metres — the longest swell
  amplitude: 0.72,       // calm tropical sea by default
  choppy: 0.5,
  dirSpread: 0.95,
  freqMul: 1.19,
  ampMul: 0.82,
  speed: 1.0,
  surfaceY: 0.0,
  refractStrength: 0.05,
  detailScale: 0.3,
  detailStrength: 0.14,
  clarity: 1.0,        // scales water absorption (higher = see deeper)
  depthFalloff: 0.16,  // how fast the water body darkens with depth
  sssStrength: 0.35,   // subsurface translucency amount
  ssrStrength: 0.85,   // screen-space reflection blend (scene reflected on water)
  sunGlitter: 0,       // shatters the reflected sun into sparkles (vs a solid streak)
  roughness: 0.08,     // micro-roughness of the GGX sun specular (glint size)
  contactFoam: 1.0,    // foam rings / wakes / splashes around floating objects
  foamThreshold: 0.2,
  foamSoftness: 0.4,
  crestFoamStart: 1.4, // wave height (m) at which whitecaps begin (calm = rare)
  shoreFoamWidth: 3.4, // water-column depth (m) over which shore foam builds
  foamCoverage: 1.0,   // overall foam amount
  foamEdge: 0.2,       // dissolve softness — high = soft, layered, feathered foam
  foamOpacity: 0.95,
  deepColor: new THREE.Color(0.0016, 0.032, 0.065), // dark saturated deep
  shallowColor: new THREE.Color(0.13, 0.56, 0.55),
  foamColor: new THREE.Color(0.95, 0.98, 1.0),
  sssColor: new THREE.Color(0.1, 0.52, 0.46),
};

export class Ocean {
  constructor(sunDir, resolution) {
    const c = OCEAN_CONFIG;

    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: sunDir.clone() },

      // ---- wave spectrum --------------------------------------------------
      // Authored on the CPU (see _syncWaves) and uploaded as flat arrays so the
      // GPU, the beach/seabed shaders and the buoyancy solver all integrate the
      // exact same harmonics.
      uWaves: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
      uWavePhase: { value: new Float32Array(MAX_WAVES) },
      uWaveCount: { value: c.waveCount },
      uChoppy: { value: c.choppy },
      uSpeed: { value: c.speed },
      uSurfaceY: { value: c.surfaceY },

      // Spectrum authoring knobs. No longer read by the shaders (the harmonics
      // are baked into uWaves each frame) but kept as shared uniform objects so
      // the GUI can bind to them and the island can follow the same water.
      uWindDir: { value: c.windDir.clone() },
      uBaseFreq: { value: (2.0 * Math.PI) / c.baseWavelength },
      uAmplitude: { value: c.amplitude },
      uWindSpeed: { value: c.windSpeed },
      uDirSpread: { value: c.dirSpread },
      uFreqMul: { value: c.freqMul },
      uAmpMul: { value: c.ampMul },

      // shading
      uResolution: { value: resolution.clone() },
      uPixAngle: { value: 0.002 },   // world size of one pixel at 1 m (set by setResolution)
      uRefractionTex: { value: null },
      uDepthTex: { value: null },
      uNear: { value: 0.1 },
      uFar: { value: 8000 },
      uCameraUnderwater: { value: 0 },
      uRefractStrength: { value: c.refractStrength },
      uDetailScale: { value: c.detailScale },
      uDetailStrength: { value: c.detailStrength },
      uClarity: { value: c.clarity },
      uDepthFalloff: { value: c.depthFalloff },
      uSSSStrength: { value: c.sssStrength },
      uSSRStrength: { value: c.ssrStrength },
      uSunGlitter: { value: c.sunGlitter },
      uRoughness: { value: c.roughness },
      uCloudCover: { value: 1.0 },
      uProjMatrix: { value: new THREE.Matrix4() },

      // contact foam sources (filled from FloatingBodies every frame)
      uContactFoam: { value: c.contactFoam },
      uBodyCount: { value: 0 },
      uBodies: { value: Array.from({ length: MAX_FOAM_BODIES }, () => new THREE.Vector4()) },
      uBodyVel: { value: Array.from({ length: MAX_FOAM_BODIES }, () => new THREE.Vector2()) },

      // cloud shadows (synced from the volumetric cloud layer; 0 = off)
      uCloudShadow: { value: 0.0 },
      uCloudPlaneY: { value: 450.0 },
      uCloudScale: { value: 0.002 },
      uCloudCoverage: { value: 0.35 },
      uCloudDrift: { value: new THREE.Vector3() },

      // Baked terrain shadow (owned by Island, wired up by main.js).
      // uShadowStren: 0 = ignore the mask, 1 = full shadow.
      uShadowTex: { value: null },
      uShadowMin: { value: new THREE.Vector2(-260, -370) },
      uShadowSize: { value: new THREE.Vector2(520, 520) },
      uShadowStren: { value: 0.0 },

      // World-space foam field (FoamField; ping-pongs, so main.js re-points the
      // texture every frame). R = accumulated foam, G = wet sand.
      uFoamTex: { value: null },
      uFoamCenter: { value: new THREE.Vector2() },
      uFoamSpan: { value: 240.0 },
      uFoamOn: { value: 1.0 },
      uFoamThreshold: { value: c.foamThreshold },
      uFoamSoftness: { value: c.foamSoftness },
      uCrestFoamStart: { value: c.crestFoamStart },
      uShoreFoamWidth: { value: c.shoreFoamWidth },
      uFoamCoverage: { value: c.foamCoverage },
      uFoamEdge: { value: c.foamEdge },
      uFoamOpacity: { value: c.foamOpacity },
      uDeepColor: { value: c.deepColor.clone() },
      uShallowColor: { value: c.shallowColor.clone() },
      uFoamColor: { value: c.foamColor.clone() },
      uSSSColor: { value: c.sssColor.clone() },
    };

    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        precision highp float;
        ${OCEAN_WAVES}
        attribute float aCell;   // world size of this vertex's grid cell (m)

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vFold;
        varying float vHeight;
        varying float vViewZ;

        void main(){
          vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          worldPos.y = uSurfaceY;

          WaveSample w = sampleOcean(worldPos.xz, aCell);
          vec3 displaced = worldPos + w.displacement;

          vWorldPos = displaced;
          vNormal   = w.normal;
          vFold     = w.fold;
          vHeight   = w.height;

          vec4 viewPos = viewMatrix * vec4(displaced, 1.0);
          vViewZ = viewPos.z;
          gl_Position = projectionMatrix * viewPos;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        #include <packing>

        // Uniforms first — the shared chunks below (detailNormal) reference them.
        uniform float uTime;
        uniform vec3  uSunDir;
        uniform vec2  uWindDir;
        uniform vec2  uResolution;
        uniform float uPixAngle;
        uniform sampler2D uRefractionTex;
        uniform sampler2D uDepthTex;
        uniform float uNear;
        uniform float uFar;
        uniform float uCameraUnderwater;
        uniform float uRefractStrength;
        uniform float uDetailScale;
        uniform float uDetailStrength;
        uniform float uClarity;
        uniform float uDepthFalloff;
        uniform float uSSSStrength;
        uniform float uSSRStrength;
        uniform float uSunGlitter;
        uniform float uRoughness;
        uniform float uCloudCover;
        uniform float uContactFoam;
        uniform int   uBodyCount;
        uniform vec4  uBodies[${MAX_FOAM_BODIES}];   // x, z, radius, foam strength
        uniform vec2  uBodyVel[${MAX_FOAM_BODIES}];  // horizontal velocity → wake direction
        uniform mat4  uProjMatrix;   // fragment prefix lacks projectionMatrix
        uniform float uFoamThreshold;
        uniform float uFoamSoftness;
        uniform float uCrestFoamStart;
        uniform float uShoreFoamWidth;
        uniform float uFoamCoverage;
        uniform float uFoamEdge;
        uniform float uFoamOpacity;
        uniform vec3  uDeepColor;
        uniform vec3  uShallowColor;
        uniform vec3  uFoamColor;
        uniform vec3  uSSSColor;
        uniform sampler2D uShadowTex;
        uniform vec2  uShadowMin;
        uniform vec2  uShadowSize;
        uniform float uShadowStren;   // 0 = off, 1 = full
        uniform sampler2D uFoamTex;
        uniform vec2  uFoamCenter;
        uniform float uFoamSpan;
        uniform float uFoamOn;

        ${NOISE}
        ${ATMOSPHERE}
        ${DETAIL_NORMAL}
        ${WATER_TINT}
        ${CLOUD_SHADOW}

        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vFold;
        varying float vHeight;
        varying float vViewZ;

        float fresnelF(float c, float f0){
          return f0 + (1.0 - f0) * pow(clamp(1.0 - c, 0.0, 1.0), 5.0);
        }
        // GGX / Trowbridge-Reitz normal distribution — physical glint shape.
        float dggx(float NoH, float a){
          float a2 = a * a;
          float d = (NoH * a2 - NoH) * NoH + 1.0;
          return a2 / (3.14159265 * d * d);
        }
        // Specular anti-aliasing (Toksvig / LEAN, as shipped in UE and Unity):
        // once the shading normal varies faster than a pixel the GGX lobe is
        // narrower than one pixel and the sun's highlight aliases into
        // fireflies. Widen the lobe by the screen-space normal variance, which
        // trades sub-pixel sparkle for a believable sheen exactly where it
        // would have aliased.
        float specAA(float rough, vec3 n){
          vec3 dx = dFdx(n);
          vec3 dy = dFdy(n);
          float v = 0.25 * (dot(dx, dx) + dot(dy, dy));
          return min(sqrt(rough * rough + v), 0.85);
        }
        float sceneEyeDepth(vec2 uv){
          float d = texture2D(uDepthTex, uv).x;
          return -perspectiveDepthToViewZ(d, uNear, uFar); // positive metres
        }

        // Baked terrain shadow (Island.bakeShadow): 1 = the sun is blocked at
        // this world xz by the island, 0 = open water with a clear sun line.
        float terrainShadow(vec2 p){
          if (uShadowStren <= 0.001) return 0.0;
          vec2 uv = (p - uShadowMin) / uShadowSize;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
          return (1.0 - texture2D(uShadowTex, uv).r) * uShadowStren;
        }

        // Screen-space reflection: march the reflection ray through the
        // pre-water colour+depth target so the island (and anything above water)
        // is mirrored on the surface. Returns rgb + a confidence in .a.
        #define SSR_STEPS 32
        vec4 ssr(vec3 ro, vec3 rd){
          float stepLen = 2.2;
          float prevDiff = -1.0;
          vec2  prevUV = vec2(0.0);
          for (int i = 1; i <= SSR_STEPS; i++){
            vec3 p = ro + rd * (stepLen * float(i));
            vec4 clip = uProjMatrix * viewMatrix * vec4(p, 1.0);
            if (clip.w <= 0.0) break;
            vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
            float sceneEye = sceneEyeDepth(uv);
            float rayEye = -(viewMatrix * vec4(p, 1.0)).z;
            float diff = rayEye - sceneEye;          // >0 → ray is behind the scene
            if (diff > 0.0 && diff < 6.0 && sceneEye < uFar * 0.97){
              // Refine between the last two samples for a cleaner hit.
              float t = prevDiff < 0.0 ? 1.0 : (-prevDiff / (diff - prevDiff));
              vec2 hitUV = mix(prevUV, uv, clamp(t, 0.0, 1.0));
              vec2 edge = smoothstep(0.0, 0.14, hitUV) * smoothstep(0.0, 0.14, 1.0 - hitUV);
              float conf = edge.x * edge.y * (1.0 - float(i) / float(SSR_STEPS) * 0.4);
              return vec4(texture2D(uRefractionTex, hitUV).rgb, conf);
            }
            prevDiff = diff;
            prevUV = uv;
            stepLen *= 1.06;                          // gently accelerate
          }
          return vec4(0.0);
        }

        void main(){
          vec3 sunDir = normalize(uSunDir);
          vec3 V = normalize(cameraPosition - vWorldPos);
          float sunElev = clamp(sunDir.y, 0.0, 1.0);
          float dist = length(cameraPosition - vWorldPos);

          // Base Gerstner normal + two scrolling ripple cascades for organic,
          // non-tiling detail: a coarse band (tens of metres — the roughness
          // that survives all the way to the horizon and keeps the far sea from
          // reading as a mirror) and a fine band (metres down to centimetres).
          //
          // Both are sampled with 'foot', the world size of this pixel: each
          // octave dies exactly when it goes sub-pixel. That is a procedural
          // mip chain, so there is no distance fade constant to tune and no
          // shimmer anywhere — the surface simply loses detail the way a
          // textured one would.
          vec3 N = normalize(vNormal);
          float foot = dist * uPixAngle / max(abs(dot(N, V)), 0.12);
          vec2 sCoarse = detailSlope(vWorldPos.xz * uDetailScale * 0.12, uTime, foot);
          vec2 sFine   = detailSlope(vWorldPos.xz * uDetailScale, uTime, foot);
          vec2 dsum = (sCoarse * 0.62 + sFine * 0.55) * uDetailStrength;
          // 1 = close to the viewer (crisp detail), 0 = kilometres away.
          float nearDetail = clamp(1.0 - foot * 0.02, 0.0, 1.0);
          N = normalize(vec3(N.x + dsum.x, N.y, N.z + dsum.y));
          vec3 Ns = N.y >= 0.0 ? N : -N;      // geometric up (points to the air)
          if (dot(N, V) < 0.0) N = -N;         // shading normal faces the viewer

          bool underwater = uCameraUnderwater > 0.5;
          vec2 screenUV = gl_FragCoord.xy / uResolution;
          vec3 color;
          float shoreFoam = 0.0;
          float cs = 0.0;   // cloud shadow amount (0 = clear, 1 = shadowed)
          float ts = 0.0;   // terrain shadow amount (island blocking the sun)

          if (!underwater){
            // ================= ABOVE WATER =================
            // Moving cloud shadows — big soft patches drifting across the sea.
            cs = cloudShadowAmt(vWorldPos, sunDir);
            // The island's own shadow, baked into a heightfield shadow map.
            ts = terrainShadow(vWorldPos.xz);
            // Jitter the reflection normal with faded high-frequency sparkle so
            // the reflected sun shatters into moving glitter instead of a solid
            // streak. Crucially the jitter is gated to the sun's reflection
            // lobe: jittering the *entire* sky reflection turns the whole sea
            // into uniform static as soon as the camera gets close to the
            // water (each pixel samples a different piece of sky).
            vec2 spk = detailSlope(vWorldPos.xz * uDetailScale * 16.0, uTime * 2.5, foot);
            vec3 R0 = reflect(-V, N);
            float lobe = pow(max(dot(R0, sunDir), 0.0), 16.0);
            vec3 Nr = normalize(N + vec3(spk.x, 0.0, spk.y) * uSunGlitter * (0.12 + 0.88 * lobe));
            vec3 R = reflect(-V, Nr);
            // Fold rays that dip below the horizon back up (mirror) instead of
            // clamping to a constant elevation.
            vec3 Rsky = R; Rsky.y = abs(Rsky.y);
            vec3 reflection = atmosphere(Rsky, sunDir);

            // Reflect the actual scene (island, seabed) via screen-space rays,
            // falling back to the sky where the ray finds nothing.
            if (uSSRStrength > 0.001){
              vec4 s = ssr(vWorldPos, R);
              reflection = mix(reflection, s.rgb, clamp(s.a, 0.0, 1.0) * uSSRStrength);
            }

            float fres = fresnelF(max(dot(N, V), 0.0), 0.02);

            // Refraction of the pre-rendered scene, attenuated by water column.
            float waterEye = -vViewZ;
            vec2  rUV = clamp(screenUV + N.xz * uRefractStrength, vec2(0.001), vec2(0.999));
            float sceneEye = sceneEyeDepth(rUV);
            if (sceneEye < waterEye){ rUV = screenUV; sceneEye = sceneEyeDepth(rUV); }
            float thickness = max(sceneEye - waterEye, 0.0);

            // Clear-water transmission: the seabed shows through, tinted and
            // dimmed by the water column. Bright turquoise over shallow sand,
            // fading to dark saturated deep — the tropical depth gradient.
            vec3 sceneCol = texture2D(uRefractionTex, rUV).rgb;
            vec3 T = exp(-(ABSORB / uClarity) * thickness);    // background transmittance
            vec3 waterCol = mix(uShallowColor, uDeepColor, 1.0 - exp(-thickness * uDepthFalloff));
            waterCol *= 0.5 + 0.5 * sunElev;
            vec3 transmitted = sceneCol * T + waterCol * (1.0 - T);

            color = mix(transmitted, reflection, fres);

            // Shoreline: a textured, advecting foam band where water gets shallow.
            float shore = smoothstep(uShoreFoamWidth, 0.12, thickness);
            float sTex = fbm(vWorldPos.xz * 0.5 - uWindDir * uTime * 0.6, 4);
            shoreFoam = shore * smoothstep(0.15, 0.55, sTex);

            // Subsurface translucency: a subtle glow through thin, back-lit
            // crests only — kept gentle so it never washes the sea cyan.
            float back  = pow(max(dot(V, -sunDir), 0.0), 4.0);
            float crest = smoothstep(0.4, 1.8, vHeight) * max(N.y, 0.0);
            color += uSSSColor * back * crest * sunElev * uSSSStrength * (1.0 - cs * 0.85) * (1.0 - ts);

            // GGX sun glints: physically-shaped sparkle whose size follows the
            // micro-roughness; slightly rougher in the distance so the horizon
            // reads as a soft streak instead of aliasing fireflies.
            vec3 H = normalize(V + sunDir);
            float rough = clamp(uRoughness + (1.0 - nearDetail) * 0.10, 0.02, 0.6);
            rough = specAA(rough, N);
            float D = dggx(max(dot(N, H), 0.0), rough * rough);
            float fh = fresnelF(max(dot(H, V), 0.0), 0.02);
            float sunNoL = max(dot(Ns, sunDir), 0.0);
            color += vec3(1.0, 0.94, 0.82) * D * fh * sunNoL * 3.0 * sunElev * (1.0 - cs * 0.9) * (1.0 - ts);

          } else {
            // ============ SEEN FROM BELOW (Snell's window) ============
            // Looking up, most of the upward cone shows the whole sky refracted
            // into a bright, rippling ceiling; only past the ~48.6° critical
            // angle does it fall back to the (still bright, sunlit) water volume.
            vec3 I = normalize(vWorldPos - cameraPosition); // toward the surface
            vec3 refr = refract(I, -Ns, 1.333);             // water -> air
            float ci = abs(dot(Ns, I));
            float fres = fresnelF(ci, 0.02);

            // Sunlit underwater ambient — bright turquoise near the surface,
            // never near-black, so the ceiling reads clear instead of a porthole.
            vec3 waterGlow = mix(uShallowColor, vec3(0.72, 0.92, 0.96), 0.35)
                           * (0.55 + 0.85 * sunElev);

            if (dot(refr, refr) < 1e-4){
              color = waterGlow;                            // total internal reflection
            } else {
              // The window: full sky, softened + lifted so it reads as a bright
              // luminous ceiling rather than hard, high-contrast cloud shapes.
              vec3 sky = atmosphere(refr, sunDir);
              float lum = max(sky.r, max(sky.g, sky.b));
              sky = mix(sky, vec3(0.80, 0.9, 1.0) * lum, 0.4);   // soften clouds
              sky *= 1.25;
              color = mix(waterGlow, sky, 1.0 - fres);
            }
            // Caustic shimmer dancing on the underside of the surface — the
            // silvery rippling highlights that make it read as water, not sky.
            float shimmer = fbm(vWorldPos.xz * 0.5 + uWindDir * uTime * 0.5, 4);
            shimmer = smoothstep(0.52, 0.92, shimmer);
            color += vec3(0.9, 0.98, 1.0) * shimmer * (1.0 - fres) * 0.35;

            // Overall lift + a bright band along the window edge.
            color += vec3(0.85, 0.95, 1.0) * (1.0 - fres) * 0.06;
          }

          // ================= FOAM (layered, both faces) =================
          // "Energy" = how much foam should exist here: from breaking folds,
          // whitecap crests, and the shoreline band.
          float breakE = smoothstep(uFoamThreshold, uFoamThreshold - uFoamSoftness, vFold);
          float crestE = smoothstep(uCrestFoamStart, uCrestFoamStart + 1.6, vHeight);

          // Contact foam: churn rings, trailing wakes and splash bursts around
          // the floating objects (positions fed in every frame).
          float contact = 0.0;
          if (uContactFoam > 0.001){
            for (int i = 0; i < ${MAX_FOAM_BODIES}; i++){
              if (i >= uBodyCount) break;
              vec4 B = uBodies[i];
              if (B.w < 0.01) continue;
              vec2 dp = vWorldPos.xz - B.xy;
              vec2 v = uBodyVel[i];
              float sp = length(v);
              if (sp > 0.25){
                // Fold trailing points onto a capsule behind the body → wake.
                vec2 vd = v / sp;
                float along = dot(dp, vd);
                dp -= vd * clamp(along, -B.z * min(2.0 + sp * 0.9, 7.0), 0.0);
              }
              float q = length(dp) / max(B.z, 0.1);
              contact += smoothstep(2.4, 0.85, q) * B.w;
            }
            contact = min(contact, 1.6) * uContactFoam;
          }

          // Persistent field foam — breaking crests and the swash sheet,
          // advected and decayed in world space (see FoamField). Edge-faded so
          // the field window doesn't pop when it recentres on the camera.
          float fieldFoam = 0.0;
          if (uFoamOn > 0.5){
            vec2 fuv = (vWorldPos.xz - uFoamCenter) / uFoamSpan + 0.5;
            if (fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0){
              vec2 fe = smoothstep(0.0, 0.05, fuv) * smoothstep(0.0, 0.05, 1.0 - fuv);
              fieldFoam = texture2D(uFoamTex, fuv).r * fe.x * fe.y;
            }
          }

          float energy = clamp((breakE + crestE * 0.7 + shoreFoam + contact + fieldFoam * 1.15) * uFoamCoverage, 0.0, 1.2);

          vec2 fp = vWorldPos.xz;
          vec2 flow = uWindDir * uTime * 0.4;
          // Stretch noise along the wind so foam forms streaks / trails.
          vec2 wperp = vec2(-uWindDir.y, uWindDir.x);
          vec2 sp = vec2(dot(fp, uWindDir), dot(fp, wperp) * 3.0);
          float tCoarse = fbm(sp * 0.12 + flow, 5);
          float tMid    = fbm(fp * 0.8 - flow * 1.3, 4);
          float tFine   = fbm(fp * 2.6 + flow * 0.7, 4);
          float tex = tCoarse * 0.58 + tMid * 0.30 + tFine * 0.12;

          // Dissolve: dense cap where energy is high; only the highest noise
          // peaks survive as it fades → soft, feathered, dissipating layers.
          float thr  = 1.0 - clamp(energy, 0.0, 1.0);
          float foam = smoothstep(thr - uFoamEdge, thr + uFoamEdge, tex);
          foam *= smoothstep(0.0, 0.12, energy);

          // A second, sparser layer of the brightest fresh foam on strong breaks.
          float fresh = smoothstep(0.62, 0.95, tMid)
                      * smoothstep(0.5, 1.0, breakE + shoreFoam + contact);
          foam = max(foam, fresh);

          // Gentle bubble breakup; thin foam is translucent (water shows through).
          // Foam is diffuse — shade it with the sun so it has form, not flat white.
          float bubbles = 0.74 + 0.34 * fbm(fp * 4.5 - flow, 3);
          float foamLight = 0.55 + 0.5 * max(dot(Ns, sunDir), 0.0) * (1.0 - ts);
          vec3 foamCol = uFoamColor * bubbles * foamLight;
          float density = smoothstep(0.05, 0.75, foam);
          foamCol = mix(mix(color, uFoamColor, 0.5), foamCol, density);
          color = mix(color, foamCol, clamp(foam, 0.0, 1.0) * uFoamOpacity);

          // ================= HORIZON / DISTANCE =================
          if (!underwater){
            // Cloud shadow dims the whole surface (water + foam) softly; the
            // aerial haze mixed in below stays unshadowed, as in reality.
            color *= (1.0 - cs * 0.30) * (1.0 - ts * 0.34);

            vec3 horizonDir = normalize(vec3(-V.x, 0.02, -V.z));
            // Cap the haze colour: the sun disk is intentionally ×14 bright for
            // glints/bloom, but it must NOT leak into the distance fog or it
            // paints a hard vertical beam straight down the sun's azimuth.
            vec3 fogCol = min(atmosphere(horizonDir, sunDir), vec3(1.6));
            float fogAmt = 1.0 - exp(-dist * 0.00045);
            color = mix(color, fogCol, clamp(fogAmt, 0.0, 1.0));
          } else {
            float fogAmt = 1.0 - exp(-dist * 0.02);
            color = mix(color, uDeepColor * 0.6, clamp(fogAmt, 0.0, 1.0));
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    // ---- Geometry: polar (radial) LOD grid -------------------------------
    // A uniform plane needs a cell size small enough for the shortest wave,
    // which over a 5 km disc means hundreds of thousands of vertices — and the
    // old 600×600 / 6 km grid still only managed 10 m cells, i.e. it could not
    // resolve anything shorter than ~30 m: all the chop was lost and the far
    // field shimmered. A polar grid with geometric ring spacing is scale
    // invariant: the cell is always ~3-4 % of the distance to the viewer, so
    // you get ~0.4 m cells where the camera looks and ~150 m cells at the
    // horizon, for a ninth of the triangles. This is the same trick as
    // "Projected Grid Water" (GPU Gems 3, ch. 2) / the concentric LOD rings in
    // Crest, Unity HDRP Water and UE5's water mesh.
    const RADIAL = {
      segments: 192,   // angular resolution
      r0: 0.5,         // innermost ring radius (m)
      growth: 1.045,   // ring spacing multiplier per ring
      rMax: 5000,      // outer radius (m) — well past where fog saturates
    };
    const geo = buildRadialGrid(RADIAL);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;

    this.grid = RADIAL;
    // Run-up: amplitude is a fraction of the 浪高 slider, so a storm surges more.
    this.surge = { enabled: true, amp: 0.28, w1: 0.55, w2: 1.31 };
    this._syncWaves();
  }

  // Build the harmonic table from a real wave spectrum.
  //
  // The harmonics are drawn from a JONSWAP spectrum instead of a hand-tuned
  // geometric ladder (A *= 0.82, k *= 1.19 per harmonic). Wind speed fixes the
  // peak frequency (ω_p = 0.877 g / U for a fully developed sea), the high-
  // frequency tail follows ω^-5, and the amplitudes come from sqrt(2·S(ω)·Δω) —
  // so raising the wind genuinely lengthens the period and narrows the band
  // instead of just scaling everything up. The band is then normalised to the
  // variance the old ladder produced, so every cinematic preset still looks the
  // same while its *shape* becomes physical.
  _syncWaves() {
    const u = this.uniforms;
    const n = Math.max(1, Math.min(MAX_WAVES, Math.round(u.uWaveCount.value)));
    const baseAngle = Math.atan2(u.uWindDir.value.y, u.uWindDir.value.x);
    const spread = u.uDirSpread.value;
    const W = u.uWaves.value;
    const P = u.uWavePhase.value;
    const G = 9.81;

    // --- frequency band: longest swell → capillary ---
    // Two-peak spectrum: a swell peak at the LONGEST wavelength in the band
    // (the 涌浪波长 slider = dominant swell period, like the old ladder) plus a
    // JONSWAP wind-sea peak set by the wind speed. Pure JONSWAP exp(-1.25(wp/ω)⁴)
    // kills everything below ω_p, which would erase the long tropical swell the
    // presets are built around — real seas are always swell + sea.
    const kMin = u.uBaseFreq.value;                       // from 涌浪波长
    const wMin = Math.sqrt(G * kMin);
    const wMax = Math.sqrt(G * (2 * Math.PI) / 0.35);     // λ = 35 cm
    const U = Math.max(2.0, u.uWindSpeed.value);
    const wp = 0.877 * G / U;                             // wind-sea peak (rad/s)
    const ws = wMin;                                      // swell peak
    const gamma = 3.3;
    const alpha = 0.0081;

    const dw = [];
    const S = [];
    for (let i = 0; i < n; i++) {
      // log-spaced in frequency, so the band is even in octaves
      const t = n === 1 ? 0 : i / (n - 1);
      const w = wMin * Math.pow(wMax / wMin, t);
      const sigma = w <= wp ? 0.07 : 0.09;
      const r = Math.exp(-Math.pow(w - wp, 2) / (2 * sigma * sigma * wp * wp));
      const base = (alpha * G * G) / Math.pow(w, 5);
      const sea = Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(gamma, r);
      const swell = Math.exp(-1.25 * Math.pow(ws / w, 4)) * 0.8;
      S.push(base * (sea + swell));
      dw.push(w);
    }
    // Δω per sample (midpoint rule), then A = sqrt(2 S Δω)
    const A = [];
    let m0 = 0;
    for (let i = 0; i < n; i++) {
      const lo = i === 0 ? dw[0] : (dw[i] + dw[i - 1]) * 0.5;
      const hi = i === n - 1 ? dw[n - 1] : (dw[i] + dw[i + 1]) * 0.5;
      const a = Math.sqrt(Math.max(0, 2 * S[i] * Math.abs(hi - lo)));
      A.push(a);
      m0 += 0.5 * a * a;
    }

    // Normalise to the variance the old ladder gave for the same 浪高 slider, so
    // the presets keep their look.
    let m0Ref = 0;
    let aRef = u.uAmplitude.value;
    for (let i = 0; i < n; i++) {
      m0Ref += 0.5 * aRef * aRef;
      aRef *= u.uAmpMul.value;
    }
    const scale = m0 > 1e-12 ? Math.sqrt(m0Ref / m0) : 0;
    const freqs = [];

    for (let i = 0; i < n; i++) {
      const w = dw[i];
      const r0 = this._hash21(i, 1.7);
      const r1 = this._hash21(i, 9.1);
      // Short waves fan out much wider than the swell (cos^2s directional spread).
      const sp = spread * (0.45 + 0.9 * Math.min(1.2, w / Math.max(wp, 1e-3)));
      const angle = baseAngle + (r0 * 2 - 1) * sp;
      const k = (w * w) / G;                 // deep-water dispersion
      W[i].set(Math.cos(angle), Math.sin(angle), k, A[i] * scale);
      P[i] = r1 * 6.2831853;
      freqs.push(+(2 * Math.PI / k).toFixed(1));   // wavelength, for the HUD
    }
    this.waveCount = n;
    this.peakWavelength = +((2 * Math.PI * G) / (wp * wp)).toFixed(1);
    this.spectrum = { wp: +wp.toFixed(3), hs: +(4 * Math.sqrt(m0 * scale * scale)).toFixed(2) };
  }

  // Rebuild the harmonic table only when an authoring knob actually changed.
  // Every CPU surface query goes through here too, so a GUI edit can never
  // leave the physics integrating last frame's spectrum.
  _syncIfDirty() {
    const u = this.uniforms;
    const s = this._sig || (this._sig = {});
    const w = u.uWindDir.value;
    if (
      s.n === u.uWaveCount.value &&
      s.f === u.uBaseFreq.value &&
      s.a === u.uAmplitude.value &&
      s.d === u.uDirSpread.value &&
      s.fm === u.uFreqMul.value &&
      s.am === u.uAmpMul.value &&
      s.ws === u.uWindSpeed.value &&
      s.wx === w.x && s.wy === w.y
    ) return;
    s.n = u.uWaveCount.value; s.f = u.uBaseFreq.value; s.a = u.uAmplitude.value;
    s.d = u.uDirSpread.value; s.fm = u.uFreqMul.value; s.am = u.uAmpMul.value;
    s.ws = u.uWindSpeed.value;
    s.wx = w.x; s.wy = w.y;
    this._syncWaves();
  }

  update(time, camera) {
    this.uniforms.uTime.value = time;
    this._syncIfDirty();

    // --- wave run-up -------------------------------------------------------
    // A slow surge of the *mean* level, which is what a wave set actually does
    // to a beach. uSurfaceY is the one level every consumer reads (ocean
    // geometry, the beach's shoreline test, the caustics mask, buoyancy), so the
    // waterline visibly advances and retreats up the sand with no extra
    // plumbing — and the foam field (see FoamField) is injected from it.
    const sc = this.surge;
    const amp = sc.enabled ? sc.amp * this.uniforms.uAmplitude.value : 0;
    const surge = amp * (0.62 * Math.sin(time * sc.w1) + 0.38 * Math.sin(time * sc.w2 + 1.7));
    this.uniforms.uSurfaceY.value = OCEAN_CONFIG.surfaceY + surge;
    this.surfaceY = this.uniforms.uSurfaceY.value;
    this.surgeNow = surge;

    // Follow the camera in xz. No grid snapping: the rings are not a regular
    // lattice, and the LOD fade has already flattened everything far enough
    // out that re-tessellation is invisible.
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
  }

  setSun(sunDir) {
    this.uniforms.uSunDir.value.copy(sunDir);
  }

  setResolution(w, h, fovDeg = 58) {
    this.uniforms.uResolution.value.set(w, h);
    // Solid angle of one pixel, expressed as the world size it covers at 1 m.
    // Drives the ripple LOD: `foot = distance * uPixAngle / cos(view angle)`.
    this.uniforms.uPixAngle.value =
      (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5)) / Math.max(h, 1);
  }

  // Exact CPU port of the GLSL hash21(vec2) in common.js.
  _hash21(a, b) {
    let px = fract(a * 123.34);
    let py = fract(b * 456.21);
    const d = px * (px + 45.32) + py * (py + 45.32);
    px += d;
    py += d;
    return fract(px * py);
  }

  // Full Gerstner sample at a REST position — the exact CPU port of
  // sampleOcean() above (cellSize = 0, i.e. full detail). Fills `out` with the
  // horizontal displacement (dx, dz), the vertical height, and the analytic
  // surface normal (nx, ny, nz).
  _gerstner(x, z, time, out) {
    this._syncIfDirty();
    const u = this.uniforms;
    const W = u.uWaves.value;
    const P = u.uWavePhase.value;
    const n = Math.max(this.waveCount, 1);
    const choppy = u.uChoppy.value;
    const speed = u.uSpeed.value;

    let dispX = 0, dispY = 0, dispZ = 0;
    let nx = 0, ny = 1, nz = 0;
    for (let i = 0; i < n; i++) {
      const w = W[i];
      const dx = w.x, dz = w.y, k = w.z, A = w.w;
      if (A <= 1e-6) continue;
      const Q = choppy / Math.max(k * A * n, 1e-3);
      const arg = k * (dx * x + dz * z) + time * Math.sqrt(9.81 * k) * speed + P[i];
      const s = Math.sin(arg);
      const c = Math.cos(arg);
      const WA = k * A;
      dispX += Q * A * dx * c;
      dispZ += Q * A * dz * c;
      dispY += A * s;
      nx -= dx * WA * c;
      nz -= dz * WA * c;
      ny -= Q * WA * s;
    }
    const inv = 1 / Math.hypot(nx, ny, nz);
    out.dx = dispX; out.dz = dispZ;
    out.h = u.uSurfaceY.value + dispY;
    out.nx = nx * inv; out.ny = ny * inv; out.nz = nz * inv;
    return out;
  }

  // Height of the VISIBLE water surface directly above world point (x,z).
  // Gerstner waves push vertices sideways, so the surface you see above (x,z)
  // came from a rest position offset by the horizontal displacement. Invert
  // that map with a few fixed-point iterations so buoyancy matches the crests.
  surfaceSample(x, z, time, out = {}) {
    let rx = x, rz = z;
    for (let it = 0; it < 4; it++) {
      this._gerstner(rx, rz, time, out);
      rx = x - out.dx;
      rz = z - out.dz;
    }
    // Final sample at the resolved rest position gives the height + normal
    // of the water actually rendered above (x,z).
    return this._gerstner(rx, rz, time, out);
  }

  // Vertical-only surface height (fast CPU port of oceanHeight(); ignores the
  // horizontal displacement). Used for camera-immersion / splash queries.
  heightAt(x, z, time) {
    this._syncIfDirty();
    const u = this.uniforms;
    const W = u.uWaves.value;
    const P = u.uWavePhase.value;
    const n = Math.max(this.waveCount, 1);
    const speed = u.uSpeed.value;
    let h = 0;
    for (let i = 0; i < n; i++) {
      const w = W[i];
      const arg = w.z * (w.x * x + w.y * z) + time * Math.sqrt(9.81 * w.z) * speed + P[i];
      h += w.w * Math.sin(arg);
    }
    return u.uSurfaceY.value + h;
  }
}

// ---------------------------------------------------------------------------
//  Polar LOD grid
//  Ring radii grow geometrically, so both the radial and the tangential cell
//  size stay a fixed fraction of the distance to the centre. The per-vertex
//  `aCell` attribute (the coarser of the two spacings) drives the wave LOD fade
//  in the vertex shader.
// ---------------------------------------------------------------------------
function buildRadialGrid({ segments, r0, growth, rMax }) {
  const radii = [0];
  let r = r0;
  while (r < rMax) {
    radii.push(r);
    r *= growth;
  }
  radii.push(rMax);
  const rings = radii.length - 1;

  const count = 1 + rings * segments; // +1 = centre vertex
  const pos = new Float32Array(count * 3);
  const cell = new Float32Array(count);

  // Centre vertex (r = 0): the innermost ring's tangential spacing is its cell.
  cell[0] = (2 * Math.PI * radii[1]) / segments;

  let v = 1;
  for (let i = 1; i <= rings; i++) {
    const rr = radii[i];
    const arc = (2 * Math.PI * rr) / segments;
    const radial = rr - radii[i - 1];
    const c = Math.max(arc, radial);
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      pos[v * 3 + 0] = Math.cos(a) * rr;
      pos[v * 3 + 1] = 0;
      pos[v * 3 + 2] = Math.sin(a) * rr;
      cell[v] = c;
      v++;
    }
  }

  const tris = segments * (1 + 2 * (rings - 1));
  const index = new Uint32Array(tris * 3);
  let t = 0;
  // Centre fan to the first ring.
  for (let j = 0; j < segments; j++) {
    const jn = (j + 1) % segments;
    index[t++] = 0;
    index[t++] = 1 + j;
    index[t++] = 1 + jn;
  }
  // Quad bands between consecutive rings.
  for (let i = 1; i < rings; i++) {
    const a0 = 1 + (i - 1) * segments;
    const b0 = 1 + i * segments;
    for (let j = 0; j < segments; j++) {
      const jn = (j + 1) % segments;
      const a = a0 + j, b = a0 + jn, c = b0 + j, d = b0 + jn;
      index[t++] = a; index[t++] = b; index[t++] = d;
      index[t++] = a; index[t++] = d; index[t++] = c;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rMax);
  return geo;
}
