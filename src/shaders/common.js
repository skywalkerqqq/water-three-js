// ---------------------------------------------------------------------------
//  Shared GLSL building blocks
//  Every shader in the project imports the same noise / sky / ocean functions
//  so that reflections, refractions and the sky dome all stay perfectly
//  consistent with one another.
// ---------------------------------------------------------------------------

/* Hashing + value noise with analytic derivatives (after Inigo Quilez). */
export const NOISE = /* glsl */ `
  float hash21(vec2 p){
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  vec2 hash22(vec2 p){
    vec3 q = vec3(dot(p, vec2(127.1, 311.7)),
                  dot(p, vec2(269.5, 183.3)),
                  dot(p, vec2(419.2, 371.9)));
    return fract(sin(q.xy) * 43758.5453);
  }

  // Returns value in .x and its 2D gradient in .yz.
  vec3 noised(vec2 x){
    vec2 p = floor(x);
    vec2 f = fract(x);
    vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    float a = hash21(p + vec2(0.0, 0.0));
    float b = hash21(p + vec2(1.0, 0.0));
    float c = hash21(p + vec2(0.0, 1.0));
    float d = hash21(p + vec2(1.0, 1.0));
    float k1 = b - a;
    float k2 = c - a;
    float k3 = a - b - c + d;
    float n  = a + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
    vec2  g  = du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);
    return vec3(n, g);
  }

  const mat2 FBM_M = mat2(1.6, 1.2, -1.2, 1.6);

  float fbm(vec2 p, int oct){
    float amp = 0.5, sum = 0.0;
    for (int i = 0; i < 8; i++){
      if (i >= oct) break;
      sum += amp * noised(p).x;
      p = FBM_M * p;
      amp *= 0.5;
    }
    return sum;
  }
`;

/* Analytic, always-stable atmosphere. Used by the sky dome AND by the ocean
   for reflections, so the horizon and the sun match exactly. Returns HDR
   radiance (the sun disk is intentionally very bright for bloom / glints). */
export const ATMOSPHERE = /* glsl */ `
  // Requires fbm() (from NOISE) and a 'uTime' uniform to be declared by the
  // shader that includes this chunk (used for drifting clouds).
  vec3 atmosphere(vec3 dir, vec3 sunDir){
    dir = normalize(dir);
    float up      = clamp(dir.y, -1.0, 1.0);
    float sunAmt  = max(dot(dir, sunDir), 0.0);
    float sunElev = clamp(sunDir.y, 0.0, 1.0);

    // Rayleigh-style gradient: a genuinely blue sky so that water reflections
    // read as ocean-blue rather than washing out to white haze.
    vec3 zenith  = mix(vec3(0.06, 0.19, 0.52), vec3(0.09, 0.28, 0.66), sunElev);
    vec3 horizon = mix(vec3(0.44, 0.56, 0.75), vec3(0.60, 0.74, 0.90), sunElev);
    float h = pow(clamp(1.0 - up, 0.0, 1.0), 2.6);
    vec3 col = mix(zenith, horizon, h);

    // Warm band low on the horizon toward the sun (stronger when sun is low).
    vec3 warm = vec3(1.0, 0.72, 0.45);
    col = mix(col, warm, h * pow(sunAmt, 2.5) * (0.75 - 0.5 * sunElev));

    // Ground haze for reflection rays that point below the horizon.
    col = mix(col, vec3(0.05, 0.10, 0.15), smoothstep(0.0, -0.22, up));

    // ---- High wispy cirrus streaks (above the cumulus, always present) ----
    if (up > 0.02){
      float tc = 2600.0 / max(up, 0.03);
      vec2 cp2 = dir.xz * tc * 0.00035 + uTime * vec2(0.0035, 0.001);
      // Anisotropic frequency stretches the noise into long combed filaments.
      float ci = fbm(vec2(cp2.x * 0.55, cp2.y * 3.2), 4);
      float cir = smoothstep(0.52, 0.82, ci) * smoothstep(0.02, 0.18, up);
      vec3 cirCol = mix(vec3(0.98, 1.0, 1.06), vec3(1.15, 0.88, 0.68), (1.0 - sunElev) * 0.75);
      col = mix(col, cirCol, cir * 0.30);
    }

    // ---- Drifting cumulus clouds on a plane (also seen in reflections) ----
    if (up > 0.04){
      float t = 900.0 / max(up, 0.05);                 // ray → cloud plane
      vec2 cp = dir.xz * t * 0.0011 + uTime * vec2(0.006, 0.004);
      float base = fbm(cp, 5);
      float det  = fbm(cp * 2.9 + 4.0, 4);
      float density = base * 0.7 + det * 0.3;
      float cov = smoothstep(0.48, 0.66, density) * uCloudCover; // faded when volumetric is on
      cov *= smoothstep(0.05, 0.26, up);               // thin out at the horizon
      // Self-shadowing: bright sunlit tops, cooler/darker bases.
      float shade = smoothstep(0.46, 0.82, density);
      vec3 cloudDark = mix(vec3(0.36, 0.40, 0.50), vec3(0.55, 0.44, 0.42), (1.0 - sunElev));
      vec3 cloudCol  = mix(cloudDark, vec3(1.12, 1.08, 1.02), shade);
      cloudCol += vec3(1.0, 0.82, 0.55) * pow(sunAmt, 4.0) * 0.7; // silver lining
      col = mix(col, cloudCol, cov);
    }

    // Mie forward-scatter glow around the sun.
    vec3 sunTint = mix(vec3(1.00, 0.52, 0.24), vec3(1.00, 0.96, 0.88), sunElev);
    float glow = pow(sunAmt, 8.0) * 0.35 + pow(sunAmt, 90.0) * 0.6;
    col += sunTint * glow * (0.6 + 0.4 * h);

    // The sun disk itself — crisp and very bright (drives glints + bloom).
    float disk = smoothstep(0.99955, 0.99978, sunAmt);
    col += sunTint * disk * 14.0;

    return max(col, vec3(0.0));
  }
`;

/* Gerstner ocean — THE single source of truth for the wave field.
 *
 * The spectrum is authored ONCE on the CPU (Ocean._syncWaves) and uploaded as a
 * uniform array, so the vertex shader, the beach/seabed shaders and the CPU
 * buoyancy solver all integrate the *same* harmonics. Before, the same sum was
 * hand-written four times (GLSL ×2, JS ×2) and drifted apart; worse, each wave
 * recomputed hash21() per vertex (2 hashes × 40 waves × 361k vertices/frame).
 *
 * sampleOcean() also takes the size of the mesh cell it is being evaluated on:
 * harmonics shorter than ~2 cells cannot be represented by that cell and are
 * faded out (a geometric mip bias). That is what stops the far field from
 * shimmering/aliasing without touching the near-field detail or the physics.
 */
export const OCEAN_WAVES = /* glsl */ `
  #define MAX_WAVES 40

  uniform float uTime;
  uniform float uWaveCount;                  // active harmonics (float: GUI-bound)
  uniform vec4  uWaves[MAX_WAVES];           // xy = direction, z = wavenumber k, w = amplitude A
  uniform float uWavePhase[MAX_WAVES];       // per-harmonic phase offset (rad)
  uniform float uChoppy;                     // total horizontal steepness budget
  uniform float uSpeed;                      // global time scale
  uniform float uSurfaceY;                   // mean water level

  struct WaveSample {
    vec3  displacement;
    vec3  normal;
    float fold;      // Jacobian determinant; <~0 where the surface pinches → foam
    float height;    // vertical displacement only
  };

  // cellSize = world size (m) of the grid cell this sample sits on.
  // 0.0 = no LOD (full detail) — used by callers that need the true surface.
  WaveSample sampleOcean(vec2 pos, float cellSize){
    vec3  disp = vec3(0.0);
    vec3  nrm  = vec3(0.0, 1.0, 0.0); // running normal (subtract slopes)
    float jxx = 1.0, jzz = 1.0, jxz = 0.0;
    float n = max(uWaveCount, 1.0);

    for (int i = 0; i < MAX_WAVES; i++){
      if (float(i) >= uWaveCount) break;

      vec4  w  = uWaves[i];
      float k  = w.z;
      float A0 = w.w;
      if (A0 <= 1e-6) continue;

      // Geometric LOD: fade harmonics the local cell cannot carry.
      float A = A0;
      if (cellSize > 0.0){
        A *= smoothstep(1.5, 3.0, 6.2831853 / max(k * cellSize, 1e-4));
      }
      if (A <= 1e-5) continue;

      // Steepness budget: sum over harmonics of Q*k*A == uChoppy, so crests
      // sharpen but the surface can never self-intersect. Q must be derived
      // from the UNFADED amplitude, otherwise the horizontal displacement
      // (Q*A) would not fade with the LOD.
      float Q = uChoppy / max(k * A0 * n, 1e-3);
      float WA = k * A;

      // Deep-water dispersion: ω = sqrt(g·k).
      float arg = k * dot(w.xy, pos) + uTime * sqrt(9.81 * k) * uSpeed + uWavePhase[i];
      float s = sin(arg);
      float c = cos(arg);

      disp.x += Q * A * w.x * c;
      disp.z += Q * A * w.y * c;
      disp.y += A * s;

      // Analytic surface normal (GPU Gems 1, ch.1 "Effective Water Simulation").
      nrm.x -= w.x * WA * c;
      nrm.z -= w.y * WA * c;
      nrm.y -= Q * WA * s;

      // Jacobian of the horizontal map → foam where it folds.
      jxx -= Q * w.x * w.x * WA * s;
      jzz -= Q * w.y * w.y * WA * s;
      jxz -= Q * w.x * w.y * WA * s;
    }

    WaveSample o;
    o.displacement = disp;
    o.normal = normalize(nrm);
    o.height = disp.y;
    o.fold = jxx * jzz - jxz * jxz;
    return o;
  }

  // Vertical-only surface height (same spectrum, no horizontal displacement).
  // Lets the beach / seabed know exactly where the rendered water stands.
  float oceanHeight(vec2 pos){
    float h = 0.0;
    for (int i = 0; i < MAX_WAVES; i++){
      if (float(i) >= uWaveCount) break;
      vec4 w = uWaves[i];
      h += w.w * sin(w.z * dot(w.xy, pos) + uTime * sqrt(9.81 * w.z) * uSpeed + uWavePhase[i]);
    }
    return uSurfaceY + h;
  }
`;

/* Multi-scale ripple slope from scrolling value-noise gradients — the crisp
   roughness the vertex grid is too coarse to resolve.

   `foot` (world metres covered by one pixel, i.e. the ray differential) makes
   this a procedural mip chain: each octave is faded out as soon as its features
   shrink below ~2 pixels, and the loop breaks because the octaves only get
   finer. That does two things at once — it stops the horizon shimmering, and it
   keeps the *coarse* octaves alive at any distance, so the far sea still has
   believable roughness instead of collapsing into a mirror once the geometry
   LOD has run out of representable wavelengths.

   Returns the slope (dHeight/dx, dHeight/dz); the caller scales it by its own
   strength, which keeps the near/far mix tunable from one place. */
export const DETAIL_NORMAL = /* glsl */ `
  vec2 detailSlope(vec2 p, float t, float foot){
    vec2 g = vec2(0.0);
    float amp = 1.0;
    float freq = 1.0;                  // octave frequency multiplier (p space)
    mat2 m = mat2(1.7, 1.1, -1.1, 1.7);
    vec2 flow = uWindDir * t * 0.6;
    for (int i = 0; i < 6; i++){
      // World size of this octave's features: p is pre-scaled by uDetailScale.
      float feat = 1.0 / (freq * max(uDetailScale, 1e-4));
      if (foot > 0.0 && feat < 2.0 * foot) break;
      vec3 n = noised(p + flow);
      g += amp * n.yz;
      p = m * p;
      freq *= 2.02;
      flow = -flow * 0.85;
      amp *= 0.55;
    }
    return g;
  }
`;

/* The island's terrain heightfield, shared by the beach, the seabed and the
   foam simulation so they all agree on where the shoreline is. Requires the
   uniforms uCenter/uRinner/uRouter/uSeabedY/uPeakY and the sculpt set below. */
export const TERRAIN = /* glsl */ `
  ${NOISE}
  uniform vec2  uCenter;
  uniform float uRinner;
  uniform float uRouter;
  uniform float uSeabedY;
  uniform float uPeakY;
  uniform float uShoreA;   // shoreline phase terms (rad), seed-driven
  uniform float uShoreB;
  uniform float uShoreC;

  // Angular shoreline modulation: stretches the island into bays and headlands.
  // Pure trig (no noise) so the CPU mirror in Island.js can match it EXACTLY —
  // the GPU terrain, the CPU heightfield, buoyancy and shadow baking all agree.
  float shoreMod(vec2 p){
    float th = atan(p.y - uCenter.y, p.x - uCenter.x);
    return 1.0
      + 0.22 * sin(th * 2.0 + uShoreA)
      + 0.11 * sin(th * 3.0 + uShoreB)
      + 0.07 * sin(th * 5.0 + uShoreC);
  }

  // World-space procedural terrain height at xz (no player edits).
  float islandHeight(vec2 p){
    float d = distance(p, uCenter);
    float m = shoreMod(p);
    float land = smoothstep(uRouter * m, uRinner * m, d);   // 1 inside → 0 outside
    float base = mix(uSeabedY, uPeakY, land);
    // Dunes + finer sand relief; stronger on the exposed land.
    float n = fbm(p * 0.02, 5) * 4.0 + fbm(p * 0.11, 4) * 1.1;
    base += n * (0.35 + 0.65 * land);
    return base;
  }

  uniform sampler2D uSculptTex;
  uniform vec2  uSculptMin;
  uniform vec2  uSculptSize;
  uniform float uSculptScale;

  // Player-editable sand delta (metres) sampled from the sculpt texture.
  float sculptDelta(vec2 p){
    vec2 uv = (p - uSculptMin) / uSculptSize;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return (texture2D(uSculptTex, uv).r - 0.5) / uSculptScale;
  }
  float sculptMoist(vec2 p){
    vec2 uv = (p - uSculptMin) / uSculptSize;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
    return texture2D(uSculptTex, uv).g;
  }

  // Final terrain height = procedural base + sculpted sand.
  float terrainHeight(vec2 p){
    return islandHeight(p) + sculptDelta(p);
  }
`;

/* Animated underwater caustics (a cleaned, tileable take on the classic
   layered-ripple caustic). Returns a 0..1 intensity. */
export const CAUSTICS = /* glsl */ `
  float caustics(vec2 uv, float t){
    vec2 p = mod(uv * 6.2831853, 6.2831853) - 250.0;
    vec2 i = vec2(p);
    float c = 1.0;
    float inten = 0.0045;
    for (int n = 0; n < 3; n++){
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y),
                   sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten),
                             p.y / (cos(i.y + tt) / inten)));
    }
    c /= 3.0;
    c = 1.17 - pow(c, 1.4);
    float v = pow(abs(c), 8.0);
    return clamp(v, 0.0, 1.0);
  }
`;

// Physical-ish absorption coefficients for clear ocean water (per metre),
// reused by the ocean surface and the underwater fog so the palette matches.
export const WATER_TINT = /* glsl */ `
  const vec3 ABSORB = vec3(0.45, 0.09, 0.04);   // red dies fast; blue travels but deep still darkens
  const vec3 SCATTER = vec3(0.11, 0.28, 0.36);  // in-scattered teal
`;

/* Cloud shadows on the sea: sample the SAME 3D fBm the volumetric clouds march
   (same rotation matrix / lacunarity / drift), sliced at the layer's midplane
   along the sun ray, so shadow patches line up with the clouds overhead and
   drift with them. uCloudCoverage arrives pre-multiplied for the midplane. */
export const CLOUD_SHADOW = /* glsl */ `
  uniform float uCloudShadow;    // strength; 0 disables the whole path
  uniform float uCloudPlaneY;    // altitude of the sampling plane
  uniform float uCloudScale;     // clouds' uNoiseScale
  uniform float uCloudCoverage;  // clouds' coverage at the midplane
  uniform vec3  uCloudDrift;     // clouds' accumulated wind drift

  float csHash13(vec3 p){
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float csVnoise(vec3 x){
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(csHash13(i + vec3(0,0,0)), csHash13(i + vec3(1,0,0)), f.x),
          mix(csHash13(i + vec3(0,1,0)), csHash13(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(csHash13(i + vec3(0,0,1)), csHash13(i + vec3(1,0,1)), f.x),
          mix(csHash13(i + vec3(0,1,1)), csHash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float csFbm(vec3 p){
    float v = 0.0, a = 0.5;
    mat3 m = mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64);
    for (int i = 0; i < 4; i++) { v += a * csVnoise(p); p = m * p * 2.02; a *= 0.5; }
    return v;
  }

  // Returns 0 = clear sky, 1 = fully shadowed.
  float cloudShadowAmt(vec3 wp, vec3 sunDir){
    if (uCloudShadow <= 0.001 || sunDir.y < 0.06) return 0.0;
    vec3 p = wp + sunDir * ((uCloudPlaneY - wp.y) / sunDir.y);
    float n = csFbm(p * uCloudScale + uCloudDrift);
    float th = 1.0 - uCloudCoverage;
    float d = smoothstep(th - 0.14, th + 0.22, n);
    return d * uCloudShadow;
  }
`;
