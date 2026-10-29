import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { OCEAN_WAVES, TERRAIN } from './shaders/common.js';

// World-space foam & wetness field — the piece that makes a beach feel like a
// beach instead of a screensaver.
//
// A 384² texture covers a 240 m window that follows the camera (clipmap-style):
//   R = foam — whitecaps from breaking crests and the swash sheet, advected by
//              the wind, decaying over a couple of seconds;
//   G = wet  — the dark wet mark the water leaves on the sand, decaying slowly.
// Both are injected where the water actually is: the swash test reads the SAME
// terrainHeight() and oceanHeight() the renderers use, so the band (and its
// wet mark) follows the run-up surge up and down the beach automatically.
//
// Injection samples the real wave spectrum (sampleOcean) for crest/fold foam, so
// trails persist behind breaking waves instead of popping with a procedural
// mask. Semi-Lagrangian advection (backtrace + linear sample) is unconditionally
// stable, and the re-centre term keeps history anchored as the window follows
// the camera.
export class FoamField {
  constructor(renderer, oceanUniforms, islandUniforms, { size = 384, span = 240 } = {}) {
    this.renderer = renderer;
    this.quad = new FullScreenQuad();
    this.size = size;
    this.span = span;
    this.texel = span / size;
    this.enabled = true;
    this.center = new THREE.Vector2(0, 0);
    this._prevCenter = new THREE.Vector2(0, 0);

    const mk = () => new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.rtA = mk();
    this.rtB = mk();

    this.uniforms = {
      tPrev: { value: null },
      uFoamOn: { value: 1 },
      uFoamCenter: { value: this.center },     // shared object: render() writes it
      uPrevCenter: { value: this._prevCenter },
      uSpan: { value: span },
      uTexel: { value: this.texel },
      uDt: { value: 0 },
      uFoamLife: { value: 2.4 },
      uWetLife: { value: 9.0 },
      uFoamGain: { value: 1.9 },
      uWindDir: { value: new THREE.Vector2(1, 0.55).normalize() },

      // Shared by reference — same objects the ocean/beach read, so a UI change
      // can never desynchronise the foam sources from the rendered water.
      uTime: oceanUniforms.uTime,
      uWaves: oceanUniforms.uWaves,
      uWavePhase: oceanUniforms.uWavePhase,
      uWaveCount: oceanUniforms.uWaveCount,
      uChoppy: oceanUniforms.uChoppy,
      uSpeed: oceanUniforms.uSpeed,
      uSurfaceY: oceanUniforms.uSurfaceY,
      uCenter: islandUniforms.uCenter,
      uRinner: islandUniforms.uRinner,
      uRouter: islandUniforms.uRouter,
      uSeabedY: islandUniforms.uSeabedY,
      uPeakY: islandUniforms.uPeakY,
      uShoreA: islandUniforms.uShoreA,
      uShoreB: islandUniforms.uShoreB,
      uShoreC: islandUniforms.uShoreC,
      uSculptTex: islandUniforms.uSculptTex,
      uSculptMin: islandUniforms.uSculptMin,
      uSculptSize: islandUniforms.uSculptSize,
      uSculptScale: islandUniforms.uSculptScale,
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tPrev;
        uniform float uFoamOn, uSpan, uTexel, uDt, uFoamLife, uWetLife, uFoamGain;
        uniform vec2 uFoamCenter, uPrevCenter, uWindDir;

        ${OCEAN_WAVES}
        ${TERRAIN}

        void main(){
          if (uFoamOn < 0.5 || uDt <= 0.0) { gl_FragColor = texture2D(tPrev, vUv); return; }

          vec2 wp = uFoamCenter + (vUv - 0.5) * uSpan;

          // Semi-Lagrangian backtrace: wind drift + the correction for the
          // window having followed the camera since last frame.
          vec2 flow = uWindDir * 0.42;
          vec2 backUV = vUv + (uFoamCenter - uPrevCenter) / uSpan - flow * uDt / uSpan;
          vec4 prev = texture2D(tPrev, backUV);
          float foam = prev.r * exp(-uDt / uFoamLife);
          float wet  = prev.g * exp(-uDt / uWetLife);

          // --- sources -------------------------------------------------
          // Breaking crests → foam that trails behind as it advects.
          WaveSample w = sampleOcean(wp, uTexel * 2.0);
          float foldE  = smoothstep(0.22, -0.15, w.fold);
          float crestE = smoothstep(0.55, 1.6, w.height);
          foam += (foldE * 1.15 + crestE * 0.5) * uDt * uFoamGain;

          // Water depth over the sand. Because oceanHeight reads uSurfaceY, this
          // whole band rides up and down with the run-up surge automatically.
          float depth = oceanHeight(wp) - terrainHeight(wp);

          // Wet sand line. Where water stands → fully wet. Just above the
          // waterline we hold the running max while it decays, so the wet mark
          // is a *soft gradient* drying out up the beach — not a hard cutoff.
          // The lower edge is blurred slightly below the surface so the damp
          // sand blends into the standing water instead of meeting it at a line.
          float wetNow = smoothstep(-0.05, 0.16, depth);
          wet = max(wet * exp(-uDt / uWetLife), wetNow);

          // Foam at the moving waterline. A thin gaussian right at depth ≈ 0
          // means the swash deposits a bright line on the wet edge; as the wave
          // retreats that line is left behind and lingers, then decays — the
          // receding foam streak a real beach shows.
          float waterline = exp(-depth * depth / (2.0 * 0.085 * 0.085));
          foam += waterline * uDt * uFoamGain * 1.7;

          // A narrow sheet of broken-wave whitewater just past the waterline
          // (thinner than before, so it reads as a defined edge, not a slab).
          float swash = smoothstep(-0.02, 0.05, depth) * (1.0 - smoothstep(0.10, 0.5, depth));
          foam += swash * uDt * uFoamGain * 1.4;

          gl_FragColor = vec4(clamp(foam, 0.0, 1.0), clamp(wet, 0.0, 1.0), 0.0, 1.0);
        }
      `,
    });

    // Zero-fill both buffers so the first advected sample isn't garbage.
    const clearMat = new THREE.ShaderMaterial({
      vertexShader: `void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; void main(){ gl_FragColor = vec4(0.0); }`,
    });
    const prevRT = renderer.getRenderTarget();
    this.quad.material = clearMat;
    renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
    renderer.setRenderTarget(this.rtB); this.quad.render(renderer);
    renderer.setRenderTarget(prevRT);
    clearMat.dispose();
  }

  get texture() { return this.rtA.texture; }

  render(dt, camPos) {
    // Re-centre the window on a texel grid (no shimmer), remembering the old
    // centre so the shader can re-anchor history.
    this._prevCenter.copy(this.center);
    const t = this.texel;
    this.center.set(
      Math.round(camPos.x / t) * t,
      Math.round(camPos.z / t) * t,
    );

    const u = this.uniforms;
    u.tPrev.value = this.rtA.texture;
    u.uDt.value = dt;
    u.uFoamOn.value = this.enabled ? 1 : 0;

    const prev = this.renderer.getRenderTarget();
    this.quad.material = this.material;
    this.renderer.setRenderTarget(this.rtB);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(prev);

    const tmp = this.rtA; this.rtA = this.rtB; this.rtB = tmp;   // rtA = newest
  }

  setSize() { /* fixed resolution — nothing to do on window resize */ }

  dispose() {
    this.rtA.dispose(); this.rtB.dispose();
    this.material.dispose();
  }
}
