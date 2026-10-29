import * as THREE from 'three';
import { NOISE, CAUSTICS, OCEAN_WAVES, TERRAIN } from './shaders/common.js';

// A sand island: a heightfield that rises from the seabed, through the
// waterline (making a beach), up to dry dunes. On top of the *procedural* base
// shape we layer a player-editable SCULPT field (a CPU float grid uploaded to a
// DataTexture). Brushing raises / lowers sand and wets it; the sea erodes any
// built-up sand that sits in the wave-reach band, so castles slowly wash away.
// `waveUniforms` are the ocean's wave-shape uniform objects (passed by
// reference) so the beach knows where the real wavy water surface is.
export class Island {
  constructor(sunDir, seabedDepth = 22, waveUniforms) {
    // ---- Sculpt grid (CPU-authoritative, mirrored to the GPU each edit) ----
    // 512² over 520 m ≈ 1 m cells. The old 256² (2 m cells) could not describe a
    // sandcastle: a bucket-sized pile only covered 4 cells, so every pour came
    // out as a blob. 1 m cells let a poured tower keep its rim, its taper and
    // its crenellations while staying cheap enough to simulate.
    this.N = 512;                              // grid resolution
    this.sMin = new THREE.Vector2(-260, -370); // world AABB of the island plane
    this.sSize = new THREE.Vector2(520, 520);
    this.sScale = 0.08;                        // delta decode: (r-0.5)/sScale → metres
    this.delta = new Float32Array(this.N * this.N);   // signed sand height (m)
    this.moist = new Float32Array(this.N * this.N);   // 0..1 water content
    this.base = new Float32Array(this.N * this.N);    // procedural base height (CPU mirror of islandHeight)
    this.seed = 0;
    this.texData = new Uint8Array(this.N * this.N * 4);
    for (let i = 0; i < this.N * this.N; i++) {
      this.texData[i * 4 + 0] = 128;          // delta 0
      this.texData[i * 4 + 1] = 0;            // moisture 0
      this.texData[i * 4 + 2] = 0;
      this.texData[i * 4 + 3] = 255;
    }
    this.sculptTex = new THREE.DataTexture(
      this.texData, this.N, this.N, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this.sculptTex.minFilter = THREE.LinearFilter;
    this.sculptTex.magFilter = THREE.LinearFilter;
    this.sculptTex.wrapS = THREE.ClampToEdgeWrapping;
    this.sculptTex.wrapT = THREE.ClampToEdgeWrapping;
    this.sculptTex.needsUpdate = true;

    // ---- Baked sun shadow over the terrain footprint ---------------------
    // The island owns a heightfield, so its cast shadow can be resolved
    // analytically: march the (cached) heightfield along the sun and store
    // "lit / occluded" per cell. Cheap enough to rebake whenever the sun moves,
    // and unlike a GPU shadow map it needs no depth-material plumbing and can be
    // shared by the water, the sand and the seabed. 128² over the 520 m
    // footprint = 4 m cells, blurred for a soft penumbra.
    this.shadowN = 128;
    this.shadowData = new Uint8Array(this.shadowN * this.shadowN * 4);
    for (let i = 0; i < this.shadowN * this.shadowN; i++) {
      this.shadowData[i * 4 + 0] = 255;
      this.shadowData[i * 4 + 3] = 255;
    }
    this.shadowTex = new THREE.DataTexture(
      this.shadowData, this.shadowN, this.shadowN, THREE.RGBAFormat, THREE.UnsignedByteType
    );
    this.shadowTex.minFilter = THREE.LinearFilter;
    this.shadowTex.magFilter = THREE.LinearFilter;
    this.shadowTex.wrapS = THREE.ClampToEdgeWrapping;
    this.shadowTex.wrapT = THREE.ClampToEdgeWrapping;
    this.shadowTex.needsUpdate = true;
    this._shadowDirty = true;
    this._lastBake = -1e9;

    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: sunDir.clone() },
      uCenter: { value: new THREE.Vector2(0, -110) },
      uRinner: { value: 70.0 },   // radius of the flat top
      uRouter: { value: 175.0 },  // radius where it meets the seabed
      uSeabedY: { value: -seabedDepth },
      uPeakY: { value: 7.0 },
      uShoreA: { value: 0.0 },    // shoreline phase terms (see _buildBase)
      uShoreB: { value: 1.3 },
      uShoreC: { value: 2.7 },
      uSandDry: { value: new THREE.Color(0.64, 0.55, 0.39) },
      uSandWet: { value: new THREE.Color(0.24, 0.19, 0.13) },
      uCausticColor: { value: new THREE.Color(1.0, 0.98, 0.85) },
      // Editable sculpt field
      uSculptTex: { value: this.sculptTex },
      uSculptMin: { value: this.sMin.clone() },
      uSculptSize: { value: this.sSize.clone() },
      uSculptScale: { value: this.sScale },
      // Baked terrain shadow (see bakeShadow): 1 = sun reaches, 0 = occluded.
      uShadowTex: { value: this.shadowTex },
      uShadowMin: { value: this.sMin.clone() },
      uShadowSize: { value: this.sSize.clone() },
      uShadowStrength: { value: 1.0 },
      // World-space swash field (wired up by main.js; R = foam, G = wet sand).
      uFoamTex: { value: null },
      uFoamCenter: { value: new THREE.Vector2() },
      uFoamSpan: { value: 240.0 },
      uFoamOn: { value: 1.0 },
      // Shared, by reference — the beach reads the exact same harmonics the
      // ocean surface is displaced with, so the shoreline truly coincides.
      uWaves: waveUniforms.uWaves,
      uWavePhase: waveUniforms.uWavePhase,
      uWaveCount: waveUniforms.uWaveCount,
      uChoppy: waveUniforms.uChoppy,
      uSpeed: waveUniforms.uSpeed,
      uSurfaceY: waveUniforms.uSurfaceY,
    };

    const common = TERRAIN;

    const material = new THREE.ShaderMaterial({
      toneMapped: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        precision highp float;
        ${common}
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        void main(){
          vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
          float h = terrainHeight(wp.xz);
          wp.y = h;
          // Normal via central differences of the (editable) height field.
          float e = 0.75;
          float hx = terrainHeight(wp.xz + vec2(e, 0.0));
          float hz = terrainHeight(wp.xz + vec2(0.0, e));
          vNormal = normalize(vec3(h - hx, e, h - hz));
          vWorldPos = wp;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3  uSunDir;
        uniform vec3  uSandDry;
        uniform vec3  uSandWet;
      uniform vec3  uCausticColor;
      ${common}
      ${OCEAN_WAVES}
      ${CAUSTICS}
      	uniform sampler2D uShadowTex;
      	uniform vec2  uShadowMin;
      	uniform vec2  uShadowSize;
      	uniform float uShadowStrength;

      // Baked terrain shadow: 1 = the sun is blocked here, 0 = full sun.
      float terrainShadow(vec2 p){
        vec2 uv = (p - uShadowMin) / uShadowSize;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
        return (1.0 - texture2D(uShadowTex, uv).r) * uShadowStrength;
      }

      uniform sampler2D uFoamTex;
      uniform vec2  uFoamCenter;
      uniform float uFoamSpan;
      uniform float uFoamOn;

      // Wet mark the swash leaves on the sand (world-space foam field).
      float foamWet(vec2 p){
        if (uFoamOn < 0.5) return 0.0;
        vec2 fuv = (p - uFoamCenter) / uFoamSpan + 0.5;
        if (fuv.x < 0.0 || fuv.x > 1.0 || fuv.y < 0.0 || fuv.y > 1.0) return 0.0;
        return texture2D(uFoamTex, fuv).g;
      }
        varying vec3 vWorldPos;
        varying vec3 vNormal;

        void main(){
          vec3 sunDir = normalize(uSunDir);
          vec3 N = normalize(vNormal);
          vec2 xz = vWorldPos.xz;
          float y = vWorldPos.y;

          // Water actually standing above this sand, from the real wavy surface.
          float submerged = oceanHeight(xz) - y;

          // Wet sand = smooth band tied to height above the mean waterline, OR
          // player-applied moisture (wet brush). (Ref: sunset-beach dry/wet sand.)
          float wetBand = smoothstep(2.2, -0.3, y);
          float moist = sculptMoist(xz);
          // The swash field leaves a dark wet band that slowly dries out. Read it
          // at full strength so its drying gradient shows as a real soft transition
          // up the beach rather than a single hard line.
          float wetness = clamp(max(max(wetBand, moist), foamWet(xz)), 0.0, 1.0);

          // Two-tone granular dry sand (coarse + fine grain).
          vec3 sand = uSandDry * (0.9 + 0.2 * fbm(xz * 0.02 + 17.0, 3));
          sand *= 0.82 + 0.34 * fbm(xz * 0.5, 3);
          sand = mix(sand, uSandWet, wetness);

          // Tide marks: faint darker bands just above the waterline.
          float tide = smoothstep(1.9, 0.2, y);
          float bands = 0.5 + 0.5 * sin(y * 8.0 + fbm(xz * 0.08, 3) * 6.0);
          sand = mix(sand, uSandWet * 0.8, tide * smoothstep(0.7, 0.95, bands) * 0.35);

          // Slope shading: darken steep lee faces, lift sun-facing crests
          // (ref: coastal-sand-dunes — colour varies by slope).
          float slope = 1.0 - N.y;
          float ndl = clamp(dot(N, sunDir), 0.0, 1.0);
          // Terrain shadow (baked): the dunes' own shadow, and the shadow the
          // island throws over the lagoon behind it.
          float sh = terrainShadow(xz);
          ndl *= 1.0 - sh;
          sand *= 1.0 - slope * 0.28 + ndl * 0.12;

          vec3 sky = vec3(0.35, 0.5, 0.7);
          vec3 color = sand * (0.42 * sky + 1.05 * ndl);

          // Caustics ONLY where water actually stands above the sand.
          if (submerged > 0.0){
            vec2 flow = sunDir.xz * uTime * 0.4;
            float c1 = caustics(xz * 0.05 + flow, uTime * 0.6);
            float c2 = caustics(xz * 0.085 - flow * 0.7 + 15.0, uTime * 0.8);
            float caus = min(c1, c2) + 0.35 * c1 * c2;
            float edge = smoothstep(0.0, 0.5, submerged);
            color += uCausticColor * caus * exp(-submerged * 0.06) * (0.4 + 0.8 * ndl) * edge * (1.0 - sh);
          } else {
            // Wet sheen on exposed sand: strongest on the freshly-wet (receding)
            // band, so the damp line glistens like wet sand instead of reading flat.
            float wG = foamWet(xz);
            float sheen = wG * 0.85 + moist * 0.6 + smoothstep(1.4, 0.0, y) * 0.18;
            vec3 H = normalize(sunDir + normalize(cameraPosition - vWorldPos));
            color += vec3(0.9) * pow(max(dot(N, H), 0.0), 40.0) * clamp(sheen, 0.0, 1.0) * 0.3 * (1.0 - sh);
          }

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    // Large enough to cover the whole island footprint with beach margin.
    const geo = new THREE.PlaneGeometry(520, 520, 320, 320);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.position.set(0, 0, -110);
    this.mesh.frustumCulled = false;

    this._buildBase(0);   // populate the CPU base-height cache
  }

  // Bilinear read of a N×N cell array laid over the sculpt AABB.
  _sampleGrid(arr, x, z) {
    const fx = (x - this.sMin.x) / this.sSize.x * this.N - 0.5;
    const fz = (z - this.sMin.y) / this.sSize.y * this.N - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    const tx = fx - i0, tz = fz - j0;
    const g = (ii, jj) => arr[this._idx(
      Math.max(0, Math.min(this.N - 1, ii)),
      Math.max(0, Math.min(this.N - 1, jj)),
    )];
    const d00 = g(i0, j0), d10 = g(i0 + 1, j0);
    const d01 = g(i0, j0 + 1), d11 = g(i0 + 1, j0 + 1);
    const a = d00 + (d10 - d00) * tx;
    const b = d01 + (d11 - d01) * tx;
    return a + (b - a) * tz;
  }

  // Terrain height straight off the cached grids (base + player edits) — the
  // same field the GPU renders, but ~20× cheaper than re-running the fbm.
  _gridHeight(x, z) {
    return this._sampleGrid(this.base, x, z) + this._sampleGrid(this.delta, x, z);
  }

  // Bake the terrain shadow for the current sun. O(N² · steps) array reads.
  bakeShadow(sunDir) {
    const N = this.shadowN;
    const sx = sunDir.x, sy = sunDir.y, sz = sunDir.z;
    const x0 = this.sMin.x, z0 = this.sMin.y;
    const w = this.sSize.x, h = this.sSize.y;
    const STEP = 14, STEPS = 16;          // march up to ~224 m
    const lit = this._shadowLit || (this._shadowLit = new Float32Array(N * N));
    lit.fill(1);

    if (sy > 0.02) {
      // Nothing on this island is taller than this, so a ray above it can stop.
      const topY = this.uniforms.uPeakY.value + 7.0;
      for (let j = 0; j < N; j++) {
        const cz = z0 + (j + 0.5) / N * h;
        for (let i = 0; i < N; i++) {
          const cx = x0 + (i + 0.5) / N * w;
          // Start just above the terrain — or above the water if it's deeper,
          // so a shallow lagoon floor can't self-occlude.
          const h0 = Math.max(this._gridHeight(cx, cz), 0) + 0.2;
          let k = 1;
          for (let s = 1; s <= STEPS; s++) {
            const t = s * STEP;
            const ry = h0 + sy * t;
            if (ry > topY) break;
            const rx = cx + sx * t, rz = cz + sz * t;
            if (rx < x0 || rx > x0 + w || rz < z0 || rz > z0 + h) break;
            if (this._gridHeight(rx, rz) > ry) { k = 0; break; }
          }
          lit[j * N + i] = k;
        }
      }
    }

    // Soften: two 3×3 box passes = a believable penumbra at these cell sizes.
    let src = lit;
    let dst = this._shadowTmp || (this._shadowTmp = new Float32Array(N * N));
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          let sum = 0, cnt = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || ii >= N || jj < 0 || jj >= N) continue;
              sum += src[jj * N + ii]; cnt++;
            }
          }
          dst[j * N + i] = sum / cnt;
        }
      }
      const t = src; src = dst; dst = t;
    }

    for (let k = 0; k < N * N; k++) {
      this.shadowData[k * 4 + 0] = Math.round(Math.max(0, Math.min(1, src[k])) * 255);
    }
    this.shadowTex.needsUpdate = true;
    this._shadowDirty = false;
    this._lastBake = performance.now();
  }

  // Lazy bake: the sun slider fires continuously, so coalesce to ~6 Hz.
  _maybeBakeShadow() {
    if (!this._shadowDirty) return;
    if (performance.now() - this._lastBake < 140) return;
    this.bakeShadow(this.uniforms.uSunDir.value);
  }

  // ---- CPU authoring of the sculpt grid ------------------------------------
  _idx(i, j) { return j * this.N + i; }

  _encode(i, j) {
    const k = this._idx(i, j);
    const d = Math.max(-6, Math.min(6, this.delta[k]));
    const m = Math.max(0, Math.min(1, this.moist[k]));
    this.texData[k * 4 + 0] = Math.round((d * this.sScale + 0.5) * 255);
    this.texData[k * 4 + 1] = Math.round(m * 255);
  }

  // CPU mirror of the GLSL shoreMod() in common.js — pure trig so the GPU and
  // CPU heightfields stay bit-compatible. Stretches the island into bays/heads.
  _shoreMod(gx, gz) {
    const u = this.uniforms;
    const th = Math.atan2(gz - u.uCenter.value.y, gx - u.uCenter.value.x);
    return 1
      + 0.22 * Math.sin(th * 2.0 + u.uShoreA.value)
      + 0.11 * Math.sin(th * 3.0 + u.uShoreB.value)
      + 0.07 * Math.sin(th * 5.0 + u.uShoreC.value);
  }

  // Procedural base terrain mirrored on the CPU (keeps erosion / collapse /
  // heightAt in agreement with the GPU's islandHeight()). Re-runnable with a
  // seed so "regenerate beach" yields a fresh shoreline.
  _buildBase(seed) {
    this.seed = seed;
    const u = this.uniforms;
    // Seed the shoreline phases so each beach has its own bays & headlands.
    u.uShoreA.value = ((seed * 1.7) % 6.2831853);
    u.uShoreB.value = ((seed * 2.3 + 1.0) % 6.2831853);
    u.uShoreC.value = ((seed * 3.1 + 2.0) % 6.2831853);
    const cx = u.uCenter.value.x, cz = u.uCenter.value.y;
    const router = u.uRouter.value, rinner = u.uRinner.value;
    const seabed = u.uSeabedY.value, peak = u.uPeakY.value;
    for (let j = 0; j < this.N; j++) {
      const gz = this.sMin.y + (j + 0.5) / this.N * this.sSize.y;
      for (let i = 0; i < this.N; i++) {
        const gx = this.sMin.x + (i + 0.5) / this.N * this.sSize.x;
        const dd = Math.hypot(gx - cx, gz - cz);
        const m = this._shoreMod(gx, gz);
        const land = smoothstep(router * m, rinner * m, dd);
        let base = seabed + (peak - seabed) * land;
        // NB: no seed offset here — this MUST match the GPU's islandHeight()
        // fbm exactly (the seed only shapes the shoreline phases above), so
        // erosion / shadow-baking / buoyancy all agree with what's rendered.
        const n = fbm2(gx * 0.02, gz * 0.02, 5) * 4.0
                + fbm2(gx * 0.11, gz * 0.11, 4) * 1.1;
        base += n * (0.35 + 0.65 * land);
        this.base[this._idx(i, j)] = base;
      }
    }
  }

  // Brush at a world point: sign +1 raises, -1 lowers; wet>0 also wets the sand.
  // peak=true uses a smoother, rounded mound profile (used by the Tower tool).
  sculptAt(wx, wz, radius, strength, sign, wet = 0, peak = false) {
    const cellsR = (radius / this.sSize.x) * this.N;
    const ci = (wx - this.sMin.x) / this.sSize.x * this.N;
    const cj = (wz - this.sMin.y) / this.sSize.y * this.N;
    const r = Math.ceil(cellsR) + 1;
    const i0 = Math.max(0, Math.floor(ci - r));
    const i1 = Math.min(this.N - 1, Math.ceil(ci + r));
    const j0 = Math.max(0, Math.floor(cj - r));
    const j1 = Math.min(this.N - 1, Math.ceil(cj + r));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const gx = this.sMin.x + (i + 0.5) / this.N * this.sSize.x;
        const gz = this.sMin.y + (j + 0.5) / this.N * this.sSize.y;
        const dist = Math.hypot(gx - wx, gz - wz);
        if (dist > radius) continue;
        const f = 1.0 - dist / radius;
        const fall = peak ? f * f * (3.0 - 2.0 * f) : f * f;   // smoother peaked mound
        const k = this._idx(i, j);
        this.delta[k] = Math.max(-6, Math.min(6,
          this.delta[k] + sign * strength * fall));
        if (wet > 0) this.moist[k] = Math.min(1, this.moist[k] + wet * f);
        this._encode(i, j);
      }
    }
    this.sculptTex.needsUpdate = true;
  }

  // Moisten / dry a patch (wet brush). amt < 0 dries.
  wetAt(wx, wz, radius, amt) {
    const cellsR = (radius / this.sSize.x) * this.N;
    const ci = (wx - this.sMin.x) / this.sSize.x * this.N;
    const cj = (wz - this.sMin.y) / this.sSize.y * this.N;
    const r = Math.ceil(cellsR) + 1;
    const i0 = Math.max(0, Math.floor(ci - r));
    const i1 = Math.min(this.N - 1, Math.ceil(ci + r));
    const j0 = Math.max(0, Math.floor(cj - r));
    const j1 = Math.min(this.N - 1, Math.ceil(cj + r));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const gx = this.sMin.x + (i + 0.5) / this.N * this.sSize.x;
        const gz = this.sMin.y + (j + 0.5) / this.N * this.sSize.y;
        const dist = Math.hypot(gx - wx, gz - wz);
        if (dist > radius) continue;
        const fall = 1.0 - dist / radius;
        const k = this._idx(i, j);
        this.moist[k] = Math.max(0, Math.min(1, this.moist[k] + amt * fall));
        this._encode(i, j);
      }
    }
    this.sculptTex.needsUpdate = true;
  }

  // Dump a bucket of packed sand. The pile is the frustum you actually get when
  // a tapered bucket is turned out — narrow end up, wide rim on the ground, a
  // rolled lip just inside the rim and (optionally) eight crenellations around
  // the top. Written as *added* height and marked wet, so settle() gives it the
  // near-vertical talus of damp sand, and erode() can still wash it away.
  pourBucket(wx, wz, R, H, crenellate = false, seed = 0) {
    const N = this.N;
    const i0 = Math.max(0, Math.floor((wx - R * 1.1 - this.sMin.x) / this.sSize.x * N));
    const i1 = Math.min(N - 1, Math.ceil((wx + R * 1.1 - this.sMin.x) / this.sSize.x * N));
    const j0 = Math.max(0, Math.floor((wz - R * 1.1 - this.sMin.y) / this.sSize.y * N));
    const j1 = Math.min(N - 1, Math.ceil((wz + R * 1.1 - this.sMin.y) / this.sSize.y * N));
    const TOP = 0.74;        // narrow-end radius, as a fraction of the rim
    const MERLONS = 8;
    let touched = 0, peak = 0;

    for (let j = j0; j <= j1; j++) {
      const gz = this.sMin.y + (j + 0.5) / N * this.sSize.y;
      for (let i = i0; i <= i1; i++) {
        const gx = this.sMin.x + (i + 0.5) / N * this.sSize.x;
        const dx = gx - wx, dz = gz - wz;
        const q = Math.hypot(dx, dz) / R;
        if (q > 1.06) continue;

        // Truncated cone: 1 at the rim, TOP where the flat top starts.
        const t = Math.max(0, Math.min(1, (1 - q) / (1 - TOP)));
        let h = H * Math.pow(t, 0.9);

        // Rolled lip: the little ridge the rim leaves around the shoulder.
        h += H * 0.07 * Math.exp(-Math.pow((q - 0.9) / 0.07, 2));

        // Crenellations — only across the flat top, so the skirt stays smooth.
        if (crenellate && q < TOP + 0.04) {
          const ang = Math.atan2(dz, dx) / (Math.PI * 2) + 0.5;
          const m = (ang * MERLONS) % 1;
          h *= m < 0.5 ? 1.0 : 0.78;
        }

        // Sand grain — keeps the wall from reading as a machined solid.
        h *= 0.965 + 0.07 * fbm2(gx * 0.8 + seed, gz * 0.8 - seed, 2);

        const k = this._idx(i, j);
        this.delta[k] = Math.max(-6, Math.min(6, this.delta[k] + h));
        this.moist[k] = Math.min(1, this.moist[k] + 0.85);
        this._encode(i, j);
        touched++;
        if (h > peak) peak = h;
      }
    }
    if (touched) {
      this.sculptTex.needsUpdate = true;
      this._shadowDirty = true;
    }
    return { cells: touched, peak };
  }

  // Flatten the brush footprint toward its average height (Smooth/flatten tool).
  smoothAt(wx, wz, radius, strength) {
    const cellsR = (radius / this.sSize.x) * this.N;
    const ci = (wx - this.sMin.x) / this.sSize.x * this.N;
    const cj = (wz - this.sMin.y) / this.sSize.y * this.N;
    const r = Math.ceil(cellsR) + 1;
    const i0 = Math.max(0, Math.floor(ci - r));
    const i1 = Math.min(this.N - 1, Math.ceil(ci + r));
    const j0 = Math.max(0, Math.floor(cj - r));
    const j1 = Math.min(this.N - 1, Math.ceil(cj + r));
    let sum = 0, cnt = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const gx = this.sMin.x + (i + 0.5) / this.N * this.sSize.x;
        const gz = this.sMin.y + (j + 0.5) / this.N * this.sSize.y;
        if (Math.hypot(gx - wx, gz - wz) > radius) continue;
        sum += this.delta[this._idx(i, j)];
        cnt++;
      }
    }
    if (cnt === 0) return;
    const mean = sum / cnt;
    const s = Math.min(1, strength);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const gx = this.sMin.x + (i + 0.5) / this.N * this.sSize.x;
        const gz = this.sMin.y + (j + 0.5) / this.N * this.sSize.y;
        const dist = Math.hypot(gx - wx, gz - wz);
        if (dist > radius) continue;
        const k = this._idx(i, j);
        this.delta[k] += (mean - this.delta[k]) * s * (1.0 - dist / radius);
        this._encode(i, j);
      }
    }
    this.sculptTex.needsUpdate = true;
  }

  // Thermal "collapse" — Sandcastle's signature. Dry loose sand relaxes toward
  // its repose angle (~32°) and slumps; wet/compacted sand clings and holds a
  // near-vertical slope. Mirrors the talus-angle step of Webgl-Erosion's thermal
  // erosion, but the talus is driven by the per-cell moisture field.
  settle(dt) {
    const N = this.N;
    const w = this.sSize.x / N;                 // world spacing between cells
    const rate = Math.min(1, dt * 6.0);         // collapse speed
    const dryT = 0.58 * w;                       // repose allowance for dry sand
    const wetT = 3.4 * w;                        // wet sand clings (near vertical)
    let touched = false;
    // Only the cells that actually moved get re-encoded (the beach is 512² now;
    // a full re-encode + upload every 0.18 s is pure waste when one brush stroke
    // touched a hundred cells).
    let mi = N, mj = N, xi = 0, xj = 0;
    // Alternate the sweep direction every step: a fixed scan order makes sand
    // creep towards -x/-z (a Gauss-Seidel bias you can see as a drift on a
    // perfectly symmetric mound). Flipping the order cancels it out.
    this._sweep = !this._sweep;
    const flip = this._sweep;
    for (let jj = 1; jj < N - 1; jj++) {
      const j = flip ? jj : N - 1 - jj;
      for (let ii = 1; ii < N - 1; ii++) {
        const i = flip ? ii : N - 1 - ii;
        const k = j * N + i;
        const h = this.base[k] + this.delta[k];
        // Steepest downhill neighbour.
        let bi = i, bj = j, bd = 0;
        const hl = this.base[k - 1] + this.delta[k - 1];
        if (h - hl > bd) { bd = h - hl; bi = i - 1; bj = j; }
        const hr = this.base[k + 1] + this.delta[k + 1];
        if (h - hr > bd) { bd = h - hr; bi = i + 1; bj = j; }
        const hu = this.base[k - N] + this.delta[k - N];
        if (h - hu > bd) { bd = h - hu; bi = i; bj = j - 1; }
        const hd = this.base[k + N] + this.delta[k + N];
        if (h - hd > bd) { bd = h - hd; bi = i; bj = j + 1; }
        if (bd <= 0) continue;
        const talus = dryT + (wetT - dryT) * this.moist[k];
        if (bd > talus) {
          const move = (bd - talus) * 0.5 * rate;
          this.delta[k] -= move;
          this.delta[bj * N + bi] += move;
          touched = true;
          if (i < mi) mi = i; if (i > xi) xi = i;
          if (j < mj) mj = j; if (j > xj) xj = j;
          if (bi < mi) mi = bi; if (bi > xi) xi = bi;
          if (bj < mj) mj = bj; if (bj > xj) xj = bj;
        }
      }
    }
    if (touched) {
      mi = Math.max(0, mi - 1); mj = Math.max(0, mj - 1);
      xi = Math.min(N - 1, xi + 1); xj = Math.min(N - 1, xj + 1);
      for (let j = mj; j <= xj; j++) for (let i = mi; i <= xi; i++) this._encode(i, j);
      this.sculptTex.needsUpdate = true;
    }
  }

  // Wipe all player edits and rebuild a fresh procedural beach.
  regenerate(seed) {
    const N = this.N;
    this._buildBase(seed);
    this.delta.fill(0);
    this.moist.fill(0);
    for (let k = 0; k < N * N; k++) this._encode(k % N, (k / N) | 0);
    this.sculptTex.needsUpdate = true;
    this._shadowDirty = true;
  }

  // Restore a sparse sculpt snapshot (undo support). `deltaPairs`/`moistPairs`
  // are [index, value] arrays; everything else is zeroed, then the whole field
  // is re-encoded so cleared cells also drop back to "no sand".
  restoreState(deltaPairs, moistPairs) {
    const N = this.N;
    this.delta.fill(0);
    this.moist.fill(0);
    for (let i = 0; i < deltaPairs.length; i++) this.delta[deltaPairs[i][0]] = deltaPairs[i][1];
    for (let i = 0; i < moistPairs.length; i++) this.moist[moistPairs[i][0]] = moistPairs[i][1];
    for (let k = 0; k < N * N; k++) this._encode(k % N, (k / N) | 0);
    this.sculptTex.needsUpdate = true;
    this._shadowDirty = true;
  }

  // Slow ambient changes: wet sand dries, and any built-up sand sitting in the
  // wave-reach band is washed back toward the shore by the sea. Wet/compacted
  // sand resists washing (it clings); dry loose sand is eaten quickly.
  erode(dt) {
    const N = this.N;
    const reachLo = -0.5, reachHi = 1.4;
    let touched = false;
    let mi = N, mj = N, xi = 0, xj = 0;
    for (let k = 0; k < N * N; k++) {
      const m = this.moist[k];
      if (m > 0) { this.moist[k] = Math.max(0, m - dt * 0.06); touched = true; }
      const d = this.delta[k];
      if (d <= 0.01) continue;
      const y = this.base[k] + d;
      if (y > reachLo && y < reachHi) {
        const reach = Math.max(0, 1.0 - Math.abs(y - 0.4) / 1.9); // strongest at waterline
        const eat = dt * (0.9 - 0.7 * m) * reach;                  // wet => slower
        this.delta[k] = Math.max(0, d - eat);
        touched = true;
      }
      if (touched) {
        const i = k % N, j = (k / N) | 0;
        if (i < mi) mi = i; if (i > xi) xi = i;
        if (j < mj) mj = j; if (j > xj) xj = j;
      }
    }
    if (touched) {
      mi = Math.max(0, mi - 1); mj = Math.max(0, mj - 1);
      xi = Math.min(N - 1, xi + 1); xj = Math.min(N - 1, xj + 1);
      for (let j = mj; j <= xj; j++) for (let i = mi; i <= xi; i++) this._encode(i, j);
      this.sculptTex.needsUpdate = true;
    }
  }

  update(time) {
    this.uniforms.uTime.value = time;
    this._maybeBakeShadow();
  }

  setSun(sunDir) {
    this.uniforms.uSunDir.value.copy(sunDir);
    this._shadowDirty = true;      // rebake on the next update (throttled)
  }

  // CPU mirror of terrainHeight(): procedural base + bilinearly sampled sculpt.
  heightAt(x, z) {
    const u = this.uniforms;
    const cx = u.uCenter.value.x;
    const cz = u.uCenter.value.y;
    const d = Math.hypot(x - cx, z - cz);
    const m = this._shoreMod(x, z);
    const land = smoothstep(u.uRouter.value * m, u.uRinner.value * m, d);
    let base = u.uSeabedY.value + (u.uPeakY.value - u.uSeabedY.value) * land;
    const n = fbm2(x * 0.02, z * 0.02, 5) * 4.0 + fbm2(x * 0.11, z * 0.11, 4) * 1.1;
    base += n * (0.35 + 0.65 * land);

    // Bilinear sample of the sculpt delta grid.
    const fx = (x - this.sMin.x) / this.sSize.x * this.N - 0.5;
    const fz = (z - this.sMin.y) / this.sSize.y * this.N - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    const tx = fx - i0, tz = fz - j0;
    const g = (ii, jj) => {
      const ci = Math.max(0, Math.min(this.N - 1, ii));
      const cj = Math.max(0, Math.min(this.N - 1, jj));
      return this.delta[this._idx(ci, cj)];
    };
    const d00 = g(i0, j0), d10 = g(i0 + 1, j0), d01 = g(i0, j0 + 1), d11 = g(i0 + 1, j0 + 1);
    const dx0 = d00 + (d10 - d00) * tx;
    const dx1 = d01 + (d11 - d01) * tx;
    const dSample = dx0 + (dx1 - dx0) * tz;
    return base + dSample;
  }
}

// --- CPU ports of the GLSL noise used by islandHeight() (common.js NOISE) ---
const _fr = (v) => v - Math.floor(v);
function _hash21(x, y) {
  let px = _fr(x * 123.34);
  let py = _fr(y * 456.21);
  const dt = px * (px + 45.32) + py * (py + 45.32);
  px += dt;
  py += dt;
  return _fr(px * py);
}
function _noise(x, y) {
  const px = Math.floor(x), py = Math.floor(y);
  const fx = x - px, fy = y - py;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = _hash21(px, py);
  const b = _hash21(px + 1, py);
  const c = _hash21(px, py + 1);
  const e = _hash21(px + 1, py + 1);
  const k1 = b - a, k2 = c - a, k3 = a - b - c + e;
  return a + k1 * ux + k2 * uy + k3 * ux * uy;
}
function fbm2(x, y, oct) {
  let amp = 0.5, sum = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * _noise(x, y);
    const nx = 1.6 * x - 1.2 * y;
    const ny = 1.2 * x + 1.6 * y;
    x = nx; y = ny;
    amp *= 0.5;
  }
  return sum;
}
function smoothstep(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
