import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { Sky } from './Sky.js';
import { Ocean, OCEAN_CONFIG, MAX_FOAM_BODIES } from './Ocean.js';
import { Floor } from './Floor.js';
import { Island } from './Island.js';
import { Particles } from './Particles.js';
import { Post } from './Post.js';
import { FloatingBodies } from './FloatingBodies.js';
import { Clouds } from './Clouds.js';
import { Bucket } from './Bucket.js';
import { Sandcastles } from './Sandcastles.js';
import { FoamField } from './FoamField.js';
import { PalmTrees } from './PalmTrees.js';
import { Birds } from './Birds.js';
import { AmbientAudio } from './Audio.js';

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
const container = document.getElementById('app');
const bootEl = document.getElementById('boot');
const hintEl = document.getElementById('hint');
const depthEl = document.getElementById('depth');
const depthStateEl = document.getElementById('depth-state');
const depthValEl = document.getElementById('depth-val');

const sizeW = () => window.innerWidth;
const sizeH = () => window.innerHeight;

// Surface any runtime/GPU error onto the boot screen instead of hanging on it.
function showFatal(msg) {
  const small = bootEl && bootEl.querySelector('small');
  if (small) small.textContent = String(msg).slice(0, 220);
  const h1 = bootEl && bootEl.querySelector('h1');
  if (h1) h1.textContent = 'Error';
  if (bootEl) bootEl.classList.remove('hidden');
}
window.addEventListener('error', (e) => showFatal(e.message || e.error));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

// ---------------------------------------------------------------------------
//  Renderer  (linear HDR pipeline — tone-mapping happens in the post composite)
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({
  // NB: the canvas never sees a triangle — the post pass blits one quad into
  // it — so context-level MSAA would cost 4× the framebuffer memory for zero
  // antialiasing. The multisampling lives on the render targets instead.
  antialias: false,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(sizeW(), sizeH());
renderer.toneMapping = THREE.NoToneMapping;
renderer.autoClear = true;
container.appendChild(renderer.domElement);

// Report GLSL compile/link errors to the boot overlay + console.
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  const log = (s, label) => {
    const info = gl.getShaderInfoLog(s) || '';
    if (info.trim()) console.error(`[${label}] ${info}`);
    return info;
  };
  const v = log(vs, 'vertex');
  const f = log(fs, 'fragment');
  showFatal('Shader error — see console. ' + (f || v));
};

// ---------------------------------------------------------------------------
//  Sun / time of day
// ---------------------------------------------------------------------------
const sunParams = { elevation: 22, azimuth: 108 };
const sunDir = new THREE.Vector3();
function updateSunDir() {
  const el = THREE.MathUtils.degToRad(sunParams.elevation);
  const az = THREE.MathUtils.degToRad(sunParams.azimuth);
  const h = Math.cos(el);
  sunDir.set(Math.cos(az) * h, Math.sin(el), Math.sin(az) * h).normalize();
}
updateSunDir();

// ---------------------------------------------------------------------------
//  Scene graph
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(58, sizeW() / sizeH(), 0.1, 8000);
camera.position.set(0, 14, 48);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 2, 0);
controls.minDistance = 3;
controls.maxDistance = 400;
controls.maxPolarAngle = Math.PI * 0.98;
controls.enablePan = true;
controls.screenSpacePanning = true; // let vertical pan carry the camera under
controls.autoRotateSpeed = 0.4;    // used by the cinematic-camera toggle

const FLOOR_DEPTH = 22;

const sky = new Sky(sunDir);
scene.add(sky.mesh);

const ocean = new Ocean(sunDir, new THREE.Vector2(sizeW(), sizeH()));
ocean.uniforms.uNear.value = camera.near;
ocean.uniforms.uFar.value = camera.far;
scene.add(ocean.mesh);

const floor = new Floor(sunDir, FLOOR_DEPTH);
scene.add(floor.mesh);

const island = new Island(sunDir, FLOOR_DEPTH, ocean.uniforms);
scene.add(island.mesh);

// The island bakes its own cast shadow over the terrain footprint; the water
// samples that mask so the lagoon behind the dunes goes dark instead of every
// drop of water being equally sunlit.
ocean.uniforms.uShadowTex.value = island.shadowTex;
ocean.uniforms.uShadowMin.value.copy(island.sMin);
ocean.uniforms.uShadowSize.value.copy(island.sSize);
ocean.uniforms.uShadowStren.value = 1.0;

// Sand bucket — the prop the player tips over to pour a castle tower.
// The turret itself is an instanced prop (a 1 m heightfield can't hold a
// crenellated rim), and the island gets a low skirt of sand underneath it so the
// castle is bedded into the beach and casts a shadow.
const castles = new Sandcastles(scene, (x, z) => island.heightAt(x, z));
const bucket = new Bucket(scene);
bucket.onDump = (x, z) => {
  const R = build.bucketR;
  const y0 = island.heightAt(x, z);   // ground BEFORE the mound
  island.pourBucket(x, z, R * 1.2, R * 0.16, false, Math.random() * 100);  // sand mound
  // Seat the tower at the ORIGINAL ground, not the mound top — the poured mound
  // then rises around its foot and buries the base, so there's no hard
  // cylinder-slicing-into-sand intersection line.
  castles.add(x, z, y0, R * 0.62);
  sandPuffs.spawn(x, y0, z, 14);
};

// World-space foam & wetness field — advected foam trails behind breaking crests,
// and the swash leaves a dark wet band on the sand that slowly dries.
const foam = new FoamField(renderer, ocean.uniforms, island.uniforms);

const particles = new Particles(5000, 160);
scene.add(particles.points);

// Sand-puff particles — spawned while sculpting for tactile "sand" feedback.
// A small pooled THREE.Points with a fade-by-life shader; harmless if WebGL
// point size is clamped on some GPUs (it simply draws smaller).
const sandPuffs = (() => {
  const MAX = 700;
  const pos = new Float32Array(MAX * 3);
  const life = new Float32Array(MAX);
  const vel = new Float32Array(MAX * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uSize: { value: 50 },
      uColor: { value: new THREE.Color(0.83, 0.73, 0.53) },
    },
    vertexShader: `
      attribute float aLife; varying float vLife; uniform float uSize;
      void main(){
        vLife = aLife;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Small dust motes — scaled by 1/distance and hard-clamped so they never
        // balloon into soft "balls" when the camera is close.
        gl_PointSize = clamp(uSize * (0.4 + 0.8 * aLife) / max(-mv.z, 2.0), 1.0, 10.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vLife; uniform vec3 uColor;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.08, r) * vLife * 0.7;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  let head = 0;
  function spawn(x, y, z, n) {
    for (let s = 0; s < n; s++) {
      const idx = head; head = (head + 1) % MAX;
      pos[idx * 3] = x + (Math.random() - 0.5) * 1.6;
      pos[idx * 3 + 1] = y + Math.random() * 0.6;
      pos[idx * 3 + 2] = z + (Math.random() - 0.5) * 1.6;
      vel[idx * 3] = (Math.random() - 0.5) * 3.2;
      vel[idx * 3 + 1] = 1.6 + Math.random() * 3.2;
      vel[idx * 3 + 2] = (Math.random() - 0.5) * 3.2;
      life[idx] = 1.0;
    }
  }
  function update(dt) {
    let any = false;
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) continue;
      any = true;
      life[i] -= dt * 1.7;
      if (life[i] < 0) life[i] = 0;
      vel[i * 3 + 1] -= 9.8 * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < -1.0) life[i] = 0;
    }
    if (any) {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aLife.needsUpdate = true;
    }
  }
  return { spawn, update };
})();

// Scattered seashells (ref: sunset-beach "scattered shells" + Arnab200
// rule-based placement on the beach band). Re-scattered on beach regenerate.
// A scallop rather than the old cone: a squashed hemisphere with radial rib
// striping baked into vertex colours, tinted per-instance from a shell palette.
function buildShellGeometry() {
  const geo = new THREE.SphereGeometry(0.5, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setY(i, y * 0.34);   // squash to a shallow scallop
    const ang = Math.atan2(z, x);
    const rib = 0.5 + 0.5 * Math.sin(ang * 9 + Math.hypot(x, z) * 6);
    colors[i * 3 + 0] = 1.0 - rib * 0.22;
    colors[i * 3 + 1] = 1.0 - rib * 0.20;
    colors[i * 3 + 2] = 1.0 - rib * 0.15;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.translate(0, 0.14, 0);   // nestle into the sand
  return geo;
}
let shells = null;
function scatterShells() {
  if (shells) { scene.remove(shells); shells.geometry.dispose(); shells.material.dispose(); }
  const COUNT = 90;
  const geo = buildShellGeometry();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02, side: THREE.DoubleSide });
  shells = new THREE.InstancedMesh(geo, mat, COUNT);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  const palette = [0xf5ede0, 0xf3dccb, 0xe9bca4, 0xd8e4ec];
  let placed = 0;
  let guard = 0;
  while (placed < COUNT && guard++ < COUNT * 30) {
    const x = (Math.random() - 0.5) * 480;
    const z = -110 + (Math.random() - 0.5) * 400;
    const y = island.heightAt(x, z);
    if (y < 0.15 || y > 2.8) continue;
    e.set(Math.random() * Math.PI, Math.random() * Math.PI * 2, 0);
    q.setFromEuler(e);
    const sc = 0.5 + Math.random() * 0.9;
    s.set(sc, sc, sc);
    p.set(x, y, z);
    m.compose(p, q, s);
    shells.setMatrixAt(placed, m);
    shells.setColorAt(placed, c.set(palette[(Math.random() * palette.length) | 0]));
    placed++;
  }
  shells.count = placed;
  shells.instanceMatrix.needsUpdate = true;
  if (shells.instanceColor) shells.instanceColor.needsUpdate = true;
  scene.add(shells);
}

// Little flags the player plants on the sand (ref: game-selection/threejs-castle flag).
// The cloth is a shader material that ripples along its length — pole end fixed,
// free edge waving in the breeze — so the flags read as alive instead of stiff.
const flagPoleGeo = new THREE.CylinderGeometry(0.07, 0.09, 3.4, 6);
const flagPoleMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4f, roughness: 0.8 });
const flagClothGeo = new THREE.PlaneGeometry(1.5, 0.95, 12, 1);
flagClothGeo.translate(0.75, 0, 0);   // x: 0 (pole) → 1.5 (free edge)
const flagClothMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0xe74c3c) },
    uSunDir: { value: sunDir.clone() },
  },
  vertexShader: /* glsl */ `
    uniform float uTime;
    varying float vWave;
    void main(){
      vec3 p = position;
      float t = clamp(p.x / 1.5, 0.0, 1.0);   // 0 at pole, 1 at free edge
      float w = sin(uTime * 3.2 - p.x * 4.0) * t * t * 0.55;
      p.z += w;
      vWave = w;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform vec3 uSunDir;
    varying float vWave;
    void main(){
      vec3 n = normalize(vec3(-vWave * 0.9, 0.15, 1.0));
      float ndl = clamp(dot(n, normalize(uSunDir)), 0.0, 1.0);
      gl_FragColor = vec4(uColor * (0.55 + 0.45 * ndl), 1.0);
    }
  `,
});
function placeFlag(x, z) {
  const y = island.heightAt(x, z) + 0.1;
  const g = new THREE.Group();
  const pole = new THREE.Mesh(flagPoleGeo, flagPoleMat);
  pole.position.y = 1.7;
  g.add(pole);
  const cloth = new THREE.Mesh(flagClothGeo, flagClothMat);
  cloth.position.set(0.04, 2.62, 0);
  g.add(cloth);
  g.position.set(x, y, z);
  scene.add(g);
}

scatterShells();

// Palm trees on the dry dunes + gulls circling overhead.
const trees = new PalmTrees(scene, (x, z) => island.heightAt(x, z));
trees.scatter(26);
const birds = new Birds(scene, new THREE.Vector2(0, -110), 9);
const audio = new AmbientAudio();

// A little demo castle so the scene reads "sandcastle beach" at a glance, and
// the crouch view has something to focus on. Picked on the beach band (1–2 m
// above the sea) so it sits above the surf but isn't out on the dry dunes.
function buildDemoCastle() {
  let cx = -32, cz = -118, best = -1;
  for (let i = 0; i < 300; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 112 + Math.random() * 44;
    const x = Math.cos(a) * r, z = -110 + Math.sin(a) * r;
    const y = island.heightAt(x, z);
    // Higher up the dry beach, clear of the wave run-up, so the surf never eats it.
    if (y > 2.4 && y < 4.2 && y > best) { best = y; cx = x; cz = z; }
  }
  const R = 3.4;
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    const x = cx + Math.cos(a) * R * 1.55;
    const z = cz + Math.sin(a) * R * 1.55;
    const y0 = island.heightAt(x, z);
    island.pourBucket(x, z, R * 1.2, R * 0.16, false, k * 7);
    castles.add(x, z, y0, R * 0.62, { protect: true });   // seated at original ground
  }
  const yc = island.heightAt(cx, cz);
  island.pourBucket(cx, cz, R * 1.5, R * 0.26, true, 99);
  castles.add(cx, cz, yc, R * 1.0, { protect: true });    // seated at original ground
  return { cx, cz };
}
function setupIntroCamera(cx, cz) {
  const y = island.heightAt(cx + 17, cz + 13) + 2.4;
  camera.position.set(cx + 17, Math.max(y, 3.2), cz + 13);
  controls.target.set(cx, island.heightAt(cx, cz) + 2.0, cz);
  controls.update();
}
const demo = buildDemoCastle();
setupIntroCamera(demo.cx, demo.cz);

// First-run invitation, shown once the boot screen clears.
function showInvite() {
  const el = document.createElement('div');
  el.textContent = '来堆一座你自己的沙堡吧';
  el.style.cssText =
    'position:fixed;left:50%;bottom:16%;transform:translateX(-50%);padding:10px 20px;' +
    'font:14px/1.5 system-ui,sans-serif;color:#eaf7fd;background:rgba(8,22,34,.55);' +
    'border:1px solid rgba(140,200,230,.25);border-radius:22px;backdrop-filter:blur(8px);' +
    'pointer-events:none;z-index:12;letter-spacing:.05em;transition:opacity 1s;';
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 4500);
  setTimeout(() => el.remove(), 5800);
}

// Lights — only the dropped primitives (MeshStandardMaterial) use these; the
// ocean/island/sky are raw ShaderMaterials and ignore scene lights.
const sunLight = new THREE.DirectionalLight(0xfff2e0, 3.0);
scene.add(sunLight, sunLight.target);
const skyLight = new THREE.HemisphereLight(0xbfe4ff, 0x24424e, 1.1);
scene.add(skyLight);

// Dropped, buoyant primitives (spheres / cubes).
const bodies = new FloatingBodies(scene);
// Bodies collide with the terrain AND the castles — a castle's solid height is
// its turret top, so dropped balls land on top and knock it over instead of
// passing straight through to the skirt underneath.
const terrainAt = (x, z) => {
  const t = island.heightAt(x, z);
  const c = castles.heightAt(x, z);
  return c > t ? c : t;
};
// A body slamming into the sand wrecks whatever it lands on.
bodies.onImpact = (x, z, e) => {
  castles.hit(x, z, e);
  sandPuffs.spawn(x, island.heightAt(x, z), z, 10);
};

function dropObject(type, x, z) {
  bodies.spawn(type, x, z, ocean.heightAt(x, z, time));
}
function dropAtTarget(type) {
  const t = controls.target;
  dropObject(type, t.x + (Math.random() - 0.5) * 10, t.z + (Math.random() - 0.5) * 10);
}

// ---------------------------------------------------------------------------
//  Render targets + render resolution
//
//  Two things were wrong with the old setup, and both are classic:
//   · `antialias: true` on the renderer only affects the DEFAULT framebuffer.
//     The scene is drawn into offscreen targets and blitted to the canvas by
//     the post pass, so that flag never antialiased a single triangle edge —
//     the horizon, the island silhouette and every foam edge were jagged.
//     Fix: multisampled render targets (WebGL2 MSAA, colour + depth resolve).
//   · the targets were sized in CSS pixels, so on any HiDPI display the whole
//     frame was rendered at half resolution and then upscaled. Fix: allocate at
//     device resolution × a user-controllable render scale, with a total pixel
//     budget so a 4K window can't melt the GPU.
// ---------------------------------------------------------------------------
const view = { scale: 1.0, msaa: 4, adaptive: true, paused: false, pr: 1 };
let perfScaleCtrl = null;   // assigned when the GUI is built
const PIXEL_BUDGET = 3.7e6; // ≈ 2560×1440 worth of fragments

function computeRenderPr() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let pr = dpr * view.scale;
  const px = sizeW() * sizeH() * pr * pr;
  if (px > PIXEL_BUDGET) pr *= Math.sqrt(PIXEL_BUDGET / px);
  return Math.max(0.4, pr);
}

function makeSceneRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    samples: view.msaa,          // 0 disables; depth is resolved too
  });
  rt.depthTexture = new THREE.DepthTexture(w, h);
  rt.depthTexture.type = THREE.UnsignedIntType;
  return rt;
}

let renderW = 1, renderH = 1;
let refractionRT = null;
let hdrRT = null;

// Initial allocation (device pixels, budget-capped).
view.pr = computeRenderPr();
renderW = Math.max(1, Math.round(sizeW() * view.pr));
renderH = Math.max(1, Math.round(sizeH() * view.pr));
refractionRT = makeSceneRT(renderW, renderH);
hdrRT = makeSceneRT(renderW, renderH);

ocean.uniforms.uRefractionTex.value = refractionRT.texture;
ocean.uniforms.uDepthTex.value = refractionRT.depthTexture;

const post = new Post(renderer, renderW, renderH, sunDir, OCEAN_CONFIG.deepColor);

// Volumetric sky clouds (on by default; half-res + temporal reprojection keeps
// them cheap). When on, the flat procedural clouds in the atmosphere fade back
// so the sky isn't doubled, and they cast moving shadows on the sea.
const clouds = new Clouds(renderer, renderW, renderH, { scale: 0.5 });

// (Re)allocate everything that depends on the render resolution.
function applyRenderSize() {
  view.pr = computeRenderPr();
  renderW = Math.max(1, Math.round(sizeW() * view.pr));
  renderH = Math.max(1, Math.round(sizeH() * view.pr));

  refractionRT.dispose();
  hdrRT.dispose();
  refractionRT = makeSceneRT(renderW, renderH);
  hdrRT = makeSceneRT(renderW, renderH);

  ocean.uniforms.uRefractionTex.value = refractionRT.texture;
  ocean.uniforms.uDepthTex.value = refractionRT.depthTexture;
  ocean.setResolution(renderW, renderH, camera.fov);
  post.setSize(renderW, renderH);
  clouds.setSize(renderW, renderH);
}
applyRenderSize();

const cloudShadowP = { strength: 0.5 };
function setCloudsEnabled(on) {
  clouds.enabled = on;
  const cover = on ? 0.25 : 1.0;
  sky.uniforms.uCloudCover.value = cover;
  ocean.uniforms.uCloudCover.value = cover;
  if (!on) ocean.uniforms.uCloudShadow.value = 0;
}

// ---------------------------------------------------------------------------
//  Sun propagation
// ---------------------------------------------------------------------------
function applySun() {
  updateSunDir();
  sky.setSun(sunDir);
  ocean.setSun(sunDir);
  floor.setSun(sunDir);
  island.setSun(sunDir);
  post.underwaterMat.uniforms.uSunDir.value.copy(sunDir);
  clouds.setSun(sunDir);
  flagClothMat.uniforms.uSunDir.value.copy(sunDir);
  // Point the primitives' key light along the sun; warmer & dimmer near sunset.
  sunLight.position.copy(sunDir).multiplyScalar(300);
  sunLight.target.position.set(0, 0, 0);
  sunLight.intensity = 0.6 + 3.0 * Math.max(sunDir.y, 0.0);
}

// ---------------------------------------------------------------------------
//  Cinematic presets — curated sun + water + wave + post looks.
// ---------------------------------------------------------------------------
const PRESETS = {
  'Tropical Noon': {
    sun: { el: 60, az: 125 }, amplitude: 0.7, choppy: 0.5, speed: 1.0, waveCount: 26,
    exposure: 1.05, bloom: 0.5, clarity: 1.3, depthFalloff: 0.16, sunGlitter: 0, sss: 0.35,
    deep: '#063049', shallow: '#5fc6c2', foam: '#f6fdff', foamCoverage: 0.9, crestFoamStart: 1.4,
    fog: 1.0, shafts: 0.05,
    roughness: 0.06, cloudCoverage: 0.34, saturation: 1.08,
  },
  'Golden Hour': {
    sun: { el: 8, az: 205 }, amplitude: 0.9, choppy: 0.6, speed: 0.9, waveCount: 26,
    exposure: 1.15, bloom: 0.95, clarity: 1.0, depthFalloff: 0.18, sunGlitter: 0.55, sss: 0.55,
    deep: '#08283b', shallow: '#3f9f9a', foam: '#fff1df', foamCoverage: 0.85, crestFoamStart: 1.5,
    fog: 1.0, shafts: 0.06,
    roughness: 0.09, cloudCoverage: 0.45, saturation: 1.1,
  },
  'Crimson Sunset': {
    sun: { el: 1.5, az: 250 }, amplitude: 1.0, choppy: 0.7, speed: 0.95, waveCount: 24,
    exposure: 1.2, bloom: 1.15, clarity: 0.9, depthFalloff: 0.2, sunGlitter: 0.6, sss: 0.5,
    deep: '#0e1524', shallow: '#33707a', foam: '#ffe4cf', foamCoverage: 0.9, crestFoamStart: 1.4,
    fog: 1.1, shafts: 0.05,
    roughness: 0.11, cloudCoverage: 0.52, saturation: 1.12,
  },
  'Blue Hour': {
    sun: { el: 2.5, az: 292 }, amplitude: 0.6, choppy: 0.5, speed: 0.8, waveCount: 24,
    exposure: 0.9, bloom: 0.6, clarity: 1.0, depthFalloff: 0.2, sunGlitter: 0.4, sss: 0.3,
    deep: '#050f1e', shallow: '#295a72', foam: '#dbe8f2', foamCoverage: 0.9, crestFoamStart: 1.5,
    fog: 1.1, shafts: 0.04,
    roughness: 0.08, cloudCoverage: 0.42, saturation: 1.0,
  },
  'Clear Dawn': {
    sun: { el: 14, az: 95 }, amplitude: 0.55, choppy: 0.45, speed: 0.85, waveCount: 26,
    exposure: 1.05, bloom: 0.7, clarity: 1.4, depthFalloff: 0.15, sunGlitter: 0.45, sss: 0.4,
    deep: '#073246', shallow: '#63c7c0', foam: '#eefaff', foamCoverage: 0.85, crestFoamStart: 1.6,
    fog: 1.0, shafts: 0.06,
    roughness: 0.06, cloudCoverage: 0.28, saturation: 1.06,
  },
  'Stormy Seas': {
    sun: { el: 18, az: 100 }, amplitude: 1.8, choppy: 1.05, speed: 1.6, waveCount: 32,
    exposure: 0.95, bloom: 0.4, clarity: 0.7, depthFalloff: 0.22, sunGlitter: 0.2, sss: 0.25,
    deep: '#0a1a20', shallow: '#38666a', foam: '#eef3f5', foamCoverage: 1.05, crestFoamStart: 1.3,
    fog: 1.35, shafts: 0.05,
    roughness: 0.22, cloudCoverage: 0.7, cloudDensity: 1.5, saturation: 0.92,
  },
};

function applyPreset(name) {
  const P = PRESETS[name];
  if (!P) return;
  const u = ocean.uniforms;
  if (P.sun) { sunParams.elevation = P.sun.el; sunParams.azimuth = P.sun.az; }
  const set = (k, v) => { if (v !== undefined) u[k].value = v; };
  set('uAmplitude', P.amplitude); set('uChoppy', P.choppy); set('uSpeed', P.speed);
  set('uWaveCount', P.waveCount); set('uClarity', P.clarity); set('uDepthFalloff', P.depthFalloff);
  set('uSunGlitter', P.sunGlitter); set('uSSSStrength', P.sss); set('uRoughness', P.roughness);
  set('uFoamCoverage', P.foamCoverage); set('uCrestFoamStart', P.crestFoamStart);
  if (P.deep) u.uDeepColor.value.set(P.deep);
  if (P.shallow) u.uShallowColor.value.set(P.shallow);
  if (P.foam) u.uFoamColor.value.set(P.foam);
  if (P.exposure !== undefined) post.compositeMat.uniforms.uExposure.value = P.exposure;
  if (P.bloom !== undefined) post.compositeMat.uniforms.uBloom.value = P.bloom;
  if (P.saturation !== undefined) post.compositeMat.uniforms.uSaturation.value = P.saturation;
  if (P.fog !== undefined) post.underwaterMat.uniforms.uFogStrength.value = P.fog;
  if (P.shafts !== undefined) post.underwaterMat.uniforms.uShaftDensity.value = P.shafts;
  if (P.cloudCoverage !== undefined) clouds.uniforms.uCoverage.value = P.cloudCoverage;
  if (P.cloudDensity !== undefined) clouds.uniforms.uDensity.value = P.cloudDensity;
  applySun();
  presetProxy.preset = name;   // keep the dropdown in sync (incl. programmatic calls)
  refreshColorCtrls();
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

// ---------------------------------------------------------------------------
//  GUI
// ---------------------------------------------------------------------------
const gui = new GUI({ title: '🌊 海洋' });

// Simple / expert toggle — hide the deep-dive folders until asked, so a first
// visitor sees only 预设 / 海浪 / 泡沫 / 物体 / 堆沙堡 instead of a wall of
// technical sliders (SSR, GGX, Beer–Lambert…).
const expertProxy = { expert: false };
gui.add(expertProxy, 'expert').name('🧰 专家模式').onChange((v) => applyExpertMode(v));

const colorCtrls = [];
function refreshColorCtrls() {
  for (const cc of colorCtrls) {
    cc.proxy.c = '#' + cc.uniform.value.getHexString();
    cc.ctrl.updateDisplay();
  }
}

const fPre = gui.addFolder('🌅 电影预设').close();
const presetProxy = { preset: 'Tropical Noon' };
const PRESET_LABELS = {
  '热带正午': 'Tropical Noon', '黄金时刻': 'Golden Hour', '绯红日落': 'Crimson Sunset',
  '蓝调时刻': 'Blue Hour', '清晨破晓': 'Clear Dawn', '风暴之海': 'Stormy Seas',
};
fPre.add(presetProxy, 'preset', PRESET_LABELS).name('预设').onChange(applyPreset);
fPre.add({ cinema: false }, 'cinema').name('电影相机（自动旋转）')
  .onChange((v) => (controls.autoRotate = v));

const fSun = gui.addFolder('☀️ 时间 / 太阳').close();
fSun.add(sunParams, 'elevation', -3, 89, 0.5).name('太阳高度角').onChange(applySun);
fSun.add(sunParams, 'azimuth', 0, 360, 1).name('太阳方位角').onChange(applySun);
const shadowP = { strength: 1 };
fSun.add(shadowP, 'strength', 0, 1, 0.05).name('岛屿投影').onChange((v) => {
  island.uniforms.uShadowStrength.value = v;
  ocean.uniforms.uShadowStren.value = v;
});

const fWaves = gui.addFolder('🌊 海浪').close();
fWaves.add(ocean.uniforms.uAmplitude, 'value', 0.1, 3.5, 0.05).name('浪高 (Hs)');
fWaves.add(ocean.uniforms.uWindSpeed, 'value', 2, 24, 0.5).name('风速 (m/s)')
  .onChange(() => console.log('峰波长', ocean.peakWavelength + ' m · Hs', ocean.spectrum.hs + ' m'));
fWaves.add(ocean.uniforms.uChoppy, 'value', 0.0, 1.4, 0.02).name('起伏 / 破碎');
fWaves.add(ocean.uniforms.uWaveCount, 'value', 4, 40, 1).name('波浪数量');
fWaves.add(ocean.uniforms.uSpeed, 'value', 0.0, 3.0, 0.05).name('速度');
fWaves.add(ocean.uniforms.uDirSpread, 'value', 0.0, 1.6, 0.02).name('方向扩散');
fWaves
  .add({ wl: OCEAN_CONFIG.baseWavelength }, 'wl', 40, 320, 5)
  .name('涌浪波长')
  .onChange((v) => (ocean.uniforms.uBaseFreq.value = (2 * Math.PI) / v));
const surgeP = ocean.surge;
fWaves.add(surgeP, 'enabled').name('涌浪上冲');
fWaves.add(surgeP, 'amp', 0.05, 0.6, 0.01).name('上冲幅度');

// lil-gui colour control bound to a THREE.Color uniform (sRGB picker ⇄ linear).
function addColorCtrl(folder, uniform, name) {
  const proxy = { c: '#' + uniform.value.getHexString() };
  const ctrl = folder.addColor(proxy, 'c').name(name).onChange((v) => uniform.value.set(v));
  colorCtrls.push({ ctrl, proxy, uniform });
}

const fSurf = gui.addFolder('💧 水面细节').close();
fSurf.add(ocean.uniforms.uDetailStrength, 'value', 0.0, 1.2, 0.02).name('波纹细节');
fSurf.add(ocean.uniforms.uDetailScale, 'value', 0.05, 1.2, 0.01).name('波纹密度');
fSurf.add(ocean.uniforms.uRefractStrength, 'value', 0.0, 0.12, 0.005).name('折射');
fSurf.add(ocean.uniforms.uSSRStrength, 'value', 0.0, 1.0, 0.02).name('反射 (SSR)');
fSurf.add(ocean.uniforms.uSunGlitter, 'value', 0.0, 1.0, 0.02).name('阳光闪烁');
fSurf.add(ocean.uniforms.uRoughness, 'value', 0.02, 0.5, 0.01).name('微粗糙度');

const fColor = gui.addFolder('🎨 水色').close();
fColor.add(ocean.uniforms.uClarity, 'value', 0.3, 3.0, 0.05).name('清澈度');
fColor.add(ocean.uniforms.uDepthFalloff, 'value', 0.03, 0.5, 0.01).name('深度衰减');
fColor.add(ocean.uniforms.uSSSStrength, 'value', 0.0, 1.5, 0.02).name('通透 / 次表面');
addColorCtrl(fColor, ocean.uniforms.uShallowColor, '浅水色');
addColorCtrl(fColor, ocean.uniforms.uDeepColor, '深水色');
addColorCtrl(fColor, ocean.uniforms.uFoamColor, '泡沫色');

const fFoam = gui.addFolder('🫧 泡沫').close();
fFoam.add(foam, 'enabled').name('泡沫记忆（世界场）');
fFoam.add(foam.uniforms.uFoamLife, 'value', 0.5, 6.0, 0.1).name('泡沫留存');
fFoam.add(foam.uniforms.uWetLife, 'value', 2.0, 20.0, 0.5).name('湿痕留存');
fFoam.add(ocean.uniforms.uFoamCoverage, 'value', 0.0, 2.0, 0.05).name('覆盖范围');
fFoam.add(ocean.uniforms.uFoamEdge, 'value', 0.02, 0.45, 0.01).name('柔和 / 分层');
fFoam.add(ocean.uniforms.uFoamOpacity, 'value', 0.3, 1.0, 0.02).name('不透明度');
fFoam.add(ocean.uniforms.uCrestFoamStart, 'value', 0.3, 3.0, 0.05).name('浪尖起泡');
fFoam.add(ocean.uniforms.uFoamThreshold, 'value', 0.0, 1.0, 0.02).name('破碎泡沫');
fFoam.add(ocean.uniforms.uShoreFoamWidth, 'value', 0.0, 8.0, 0.1).name('岸边泡沫宽度');
fFoam.add(ocean.uniforms.uContactFoam, 'value', 0.0, 2.0, 0.05).name('物体泡沫 / 尾迹');

const fObj = gui.addFolder('🧱 物体').close();
fObj.add({ s: () => dropAtTarget('sphere') }, 's').name('丢入球');
fObj.add({ c: () => dropAtTarget('cube') }, 'c').name('丢入方块');
fObj.add({ x: () => bodies.clear() }, 'x').name('清空物体');
fObj.add(bodies, 'gravity', 0, 45, 0.5).name('重力');

// ---- Sandcastle builder ------------------------------------------------
// Left-drag on the beach sculpts sand instead of orbiting. Hold the mode +
// radius/strength here; the pointer handlers below read this state.
const build = {
  enabled: false,
  mode: 'Raise',          // Raise | Lower | Wet | Dry | Smooth | Tower | Bucket | Flag
  radius: 14,
  strength: 1.2,
  wetMix: 0.6,            // how much moisture a Raise stroke adds
  bucketR: 3.4,           // bucket radius in metres (the pile scales with it)
};
const fBuild = gui.addFolder('🏖 堆沙堡').close();
fBuild.add(build, 'enabled').name('建造模式（按 B）');
fBuild.add(build, 'mode', {
  '堆沙': 'Raise', '挖沙': 'Lower', '打湿': 'Wet', '吹干': 'Dry',
  '压平': 'Smooth', '塔台': 'Tower', '沙桶倒沙': 'Bucket', '移动沙堡': 'Move', '插旗': 'Flag',
}).name('工具');
fBuild.add(build, 'radius', 4, 45, 1).name('笔刷半径');
fBuild.add(build, 'strength', 0.2, 4, 0.1).name('笔刷强度');
fBuild.add(build, 'wetMix', 0, 1, 0.05).name('堆沙时打湿');
fBuild.add(build, 'bucketR', 2.0, 8.0, 0.2).name('沙桶大小');
fBuild.add({ regen: () => { island.regenerate(Math.random() * 1000); castles.clear(); scatterShells(); trees.scatter(26); } }, 'regen').name('重新生成海滩');
fBuild.add({ save: saveScene }, 'save').name('💾 保存沙堡');
fBuild.add({ load: loadScene }, 'load').name('📂 读取沙堡');

// On-screen hint for the build controls.
const buildHint = document.createElement('div');
buildHint.style.cssText =
  'position:absolute;left:14px;bottom:14px;max-width:320px;padding:10px 13px;' +
  'font:13px/1.5 system-ui,sans-serif;color:#eaf6ff;background:rgba(8,22,34,.62);' +
  'border:1px solid rgba(140,200,230,.28);border-radius:10px;backdrop-filter:blur(6px);' +
  'pointer-events:none;transition:opacity .4s;z-index:5;';
buildHint.innerHTML =
  '<b>🏖 堆沙堡</b><br>' +
  '• 勾选「建造模式（按 <b>B</b>）」后，左键拖拽沙滩即可 <b>堆沙</b><br>' +
  '• <b>沙桶倒沙</b>：桶跟着指针走，点一下 = 倒置倒出一个小塔（再点一次可以叠高）<br>' +
  '• <b>移动沙堡</b>：选中后在小塔上按住拖动即可搬走，落到哪就嵌进哪的沙子（会顺着坡躺）<br>' +
  '• 工具：堆沙 / 挖沙 / 压平 / 塔台 / 沙桶 / 移动 / 打湿 / 吹干<br>' +
  '• 先用「打湿」浇湿，再用「塔台 / 沙桶」堆高——湿沙更暗、更结实、不易塌<br>' +
  '• 干沙（或水线附近）会被海浪慢慢冲垮';
container.appendChild(buildHint);
buildHint.style.opacity = '0';
// Called by every control in the build folder (lil-gui replaces the handler, so
// all of the folder's side effects live here).
function refreshBuildHint() {
  buildHint.style.opacity = build.enabled ? '1' : '0';
  bucket.setRadius(build.bucketR);
  if (!build.enabled || build.mode !== 'Bucket') bucket.hide();
}
fBuild.controllersRecursive().forEach((c) => c.onChange(refreshBuildHint));
window.addEventListener('keydown', (e) => {
  if (e.key === 'b' || e.key === 'B') { build.enabled = !build.enabled; refreshBuildHint(); gui.controllersRecursive().forEach((c) => c.updateDisplay()); }
});

const fClouds = gui.addFolder('☁️ 体积云').close();
const cu = clouds.uniforms;
fClouds.add({ on: true }, 'on').name('启用').onChange(setCloudsEnabled);
fClouds.add(cu.uSteps, 'value', 16, 80, 2).name('质量（步进）');
fClouds.add(cu.uCoverage, 'value', 0.1, 0.95, 0.01).name('覆盖率');
fClouds.add(cu.uDensity, 'value', 0.2, 3.0, 0.05).name('密度');
fClouds.add(cu.uNoiseScale, 'value', 0.002, 0.02, 0.0005).name('云团大小');
fClouds.add(cu.uHeightFalloff, 'value', 0.0, 1.0, 0.02).name('圆润度');
fClouds.add(cu.uDetail, 'value', 0.0, 1.0, 0.02).name('飘渺感');
fClouds.add(cu.uBase, 'value', 120, 900, 10).name('高度');
fClouds.add(cu.uHeight, 'value', 100, 700, 10).name('厚度');
fClouds.add(cu.uWindSpeed, 'value', 0.0, 0.15, 0.005).name('风速');
fClouds.add(cu.uSunStrength, 'value', 0.5, 6.0, 0.1).name('阳光强度');
fClouds.add(cu.uAmbient, 'value', 0.0, 1.2, 0.02).name('环境光');
fClouds.add(cloudShadowP, 'strength', 0.0, 1.0, 0.02).name('海面阴影');

const fUnder = gui.addFolder('🌊 水下').close();
fUnder.add(post.underwaterMat.uniforms.uShaftDensity, 'value', 0.0, 0.2, 0.005).name('神光密度');
fUnder.add(post.underwaterMat.uniforms.uFogStrength, 'value', 0.0, 2.0, 0.05).name('雾浓度');

const fPost = gui.addFolder('🎬 后期').close();
fPost.add(post.compositeMat.uniforms.uExposure, 'value', 0.3, 2.0, 0.02).name('曝光');
fPost.add(post.compositeMat.uniforms.uBloom, 'value', 0.0, 2.0, 0.02).name('泛光');
fPost.add(post, 'bloomStreak', 0.0, 1.0, 0.02).name('镜头光带');
fPost.add(post.compositeMat.uniforms.uSaturation, 'value', 0.5, 1.6, 0.02).name('饱和度');
fPost.add(post.compositeMat.uniforms.uContrast, 'value', 0.8, 1.3, 0.01).name('对比度');
fPost.add(post.compositeMat.uniforms.uGrain, 'value', 0.0, 0.2, 0.005).name('胶片颗粒');
fPost.add(post.compositeMat.uniforms.uCA, 'value', 0.0, 2.0, 0.05).name('镜头色散');
fPost.add(post.compositeMat.uniforms.uVignetteAir, 'value', 0.0, 0.6, 0.02).name('暗角');

const fPerf = gui.addFolder('⚙️ 性能 / 画质').close();
fPerf.add(view, 'msaa', { '关闭': 0, '2x': 2, '4x': 4, '8x': 8 }).name('抗锯齿 MSAA')
  .onChange(applyRenderSize);
perfScaleCtrl = fPerf.add(view, 'scale', 0.5, 1.0, 0.05).name('渲染倍率')
  .onChange(applyRenderSize);
fPerf.add(view, 'adaptive').name('帧率自适应降级');
fPerf.add(view, 'paused').name('暂停（空格）');
fPerf.add({ info: () => console.log(`render ${renderW}×${renderH} @ pr ${view.pr.toFixed(2)}`) }, 'info')
  .name('打印当前分辨率');

// Which folders only show in expert mode. Everything else is "simple".
function applyExpertMode(on) {
  for (const f of [fSun, fSurf, fColor, fClouds, fUnder, fPost, fPerf]) {
    if (on) f.show(); else f.hide();
  }
}
applyExpertMode(false);   // start in simple mode

// Help overlay (H) — full controls on demand instead of a one-time hint.
const helpEl = document.getElementById('help');
window.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') helpEl.hidden = !helpEl.hidden;
});
helpEl.addEventListener('click', (e) => { if (e.target === helpEl) helpEl.hidden = true; });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    view.paused = !view.paused;
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  }
});

gui.add({ dive: () => diveTo(-12) }, 'dive').name('▼ 潜入水下');
gui.add({ surface: () => diveTo(14) }, 'surface').name('▲ 返回水面');
gui.add({ sound: false }, 'sound').name('🔊 环境音').onChange((v) => (v ? audio.start() : audio.stop()));

// A kid-on-the-beach vantage: eye height ~0.95 m on the sand, looking across the
// castles. OrbitControls keeps working from here (minDistance is only 3).
function crouchHere(x, z) {
  let fwd = controls.target.clone().sub(camera.position);
  fwd.y = 0;
  if (fwd.lengthSq() < 0.01) fwd.set(0, 0, -1);
  fwd.normalize();
  diveTween = null;                       // cancel any dive in progress
  const y = island.heightAt(x, z) + 0.95;
  camera.position.set(x, y, z);
  controls.target.set(x + fwd.x * 14, y - 0.4, z + fwd.z * 14);
  controls.update();
}
function crouchToCastles() {
  const last = castles.items.length ? castles.items[castles.items.length - 1] : null;
  crouchHere(last ? last.x : 0, last ? last.z + 12 : -28);
}
gui.add({ crouch: crouchToCastles }, 'crouch').name('👦 蹲下来看沙堡');
window.addEventListener('keydown', (e) => {
  if (e.key === 'c' || e.key === 'C') crouchToCastles();
});

// ---- Save / load the whole scene --------------------------------------
// Castles + camera + sun + preset + the (sparse) sculpt edits, in localStorage.
// The sculpt field is 512², but only the cells the player actually touched are
// non-zero, so the sparse byte encoding stays a few dozen KB.
function saveScene() {
  const sculpt = [];
  const d = island.delta;
  for (let k = 0; k < d.length; k++) {
    if (Math.abs(d[k]) > 0.02) sculpt.push([k, Math.max(-128, Math.min(127, Math.round(d[k] * 20)))]);
  }
  const item = {
    v: 1, seed: island.seed, preset: presetProxy.preset,
    sun: { elevation: sunParams.elevation, azimuth: sunParams.azimuth },
    camera: { pos: camera.position.toArray().map((v) => +v.toFixed(2)), tgt: controls.target.toArray().map((v) => +v.toFixed(2)) },
    castles: castles.items.map((c) => [+c.x.toFixed(2), +c.z.toFixed(2), +c.R.toFixed(2)]),
    sculpt,
  };
  try {
    localStorage.setItem('waterthreejs.scene', JSON.stringify(item));
    console.log(`已保存（${(JSON.stringify(item).length / 1024).toFixed(0)} KB，sculpt ${sculpt.length} 格）`);
  } catch (e) { console.warn('保存失败', e); }
}
function loadScene() {
  const raw = localStorage.getItem('waterthreejs.scene');
  if (!raw) { console.log('没有存档'); return; }
  try {
    const item = JSON.parse(raw);
    if (item.v !== 1) return;
    if (item.preset) applyPreset(item.preset);
    if (item.sun) { sunParams.elevation = item.sun.elevation; sunParams.azimuth = item.sun.azimuth; applySun(); }
    island.regenerate(item.seed ?? Math.random() * 1000);
    castles.clear();
    if (item.sculpt) {
      for (const [k, b] of item.sculpt) island.delta[k] = b / 20;
      island.sculptTex.needsUpdate = true;
      island._shadowDirty = true;
    }
    if (item.castles) for (const [x, z, R] of item.castles) castles.add(x, z, island.heightAt(x, z), R);
    if (item.camera) { camera.position.fromArray(item.camera.pos); controls.target.fromArray(item.camera.tgt); controls.update(); }
    console.log(`已读取（城堡 ${item.castles ? item.castles.length : 0} 座）`);
  } catch (e) { console.warn('读取失败', e); }
}

// Camera dive/rise. Driven from the main render loop (not its own rAF chain),
// and it *owns* the camera for its duration: OrbitControls.update() re-derives
// the camera from its damped spherical state every frame, so running both at
// once makes the tween and the leftover damping fight over the transform.
let diveTween = null;
function diveTo(y) {
  const from = camera.position.clone();
  const fromT = controls.target.clone();
  diveTween = {
    from,
    fromT,
    to: new THREE.Vector3(from.x, y, from.z),
    toT: new THREE.Vector3(fromT.x, y < 0 ? y - 4 : 2, fromT.z),
    t: 0,
  };
}
function stepDive(dt) {
  const d = diveTween;
  d.t = Math.min(1, d.t + dt / 1.1);          // ~1.1 s, framerate independent
  const e = d.t * d.t * (3 - 2 * d.t);        // smoothstep
  camera.position.lerpVectors(d.from, d.to, e);
  controls.target.lerpVectors(d.fromT, d.toT, e);
  if (d.t >= 1) {
    diveTween = null;
    controls.update();                         // resync the orbit state
  }
}
// Any manual camera input cancels a dive in progress — otherwise the tween
// keeps overwriting the camera while the user fights it with the mouse.
renderer.domElement.addEventListener('pointerdown', () => { diveTween = null; }, { capture: true });
renderer.domElement.addEventListener('wheel', () => { diveTween = null; }, { passive: true });

// ---------------------------------------------------------------------------
//  Resize
// ---------------------------------------------------------------------------
function onResize() {
  const w = sizeW();
  const h = sizeH();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  applyRenderSize();
}
window.addEventListener('resize', onResize);

// Double-click the water to drop an object there (Shift = cube). Double-click
// avoids clashing with single-drag orbiting.
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();
renderer.domElement.addEventListener('dblclick', (ev) => {
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  _ray.setFromCamera(_ndc, camera);
  if (_ray.ray.intersectPlane(_plane, _hit)) {
    dropObject(ev.shiftKey ? 'cube' : 'sphere', _hit.x, _hit.z);
  }
});

// Click-drag an object to move it (drag on empty water still orbits the camera).
let dragBody = null;
let dragCastle = null;
let dragOffset = { dx: 0, dz: 0 };   // where the castle sits relative to the pointer's ground point
const _dragPlane = new THREE.Plane();
const _dragHit = new THREE.Vector3();
const _dragVel = new THREE.Vector3();
let _dragPrev = null;

function pointerNDC(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  _ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  _ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  pointerNDC(ev);
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(bodies.bodies.map((b) => b.mesh), false);
  if (!hits.length) return;                      // missed → let OrbitControls orbit
  dragBody = bodies.bodies.find((b) => b.mesh === hits[0].object);
  if (!dragBody) return;
  controls.enabled = false;                      // OrbitControls bails when disabled
  dragBody.dragging = true;
  dragBody.vx = dragBody.vy = dragBody.vz = 0;
  _dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), dragBody.mesh.position);
  _dragPrev = null;
  renderer.domElement.setPointerCapture(ev.pointerId);
}, { capture: true });

window.addEventListener('pointermove', (ev) => {
  if (!dragBody) return;
  pointerNDC(ev);
  _ray.setFromCamera(_ndc, camera);
  if (!_ray.ray.intersectPlane(_dragPlane, _dragHit)) return;
  const now = performance.now();
  if (_dragPrev) {
    const ddt = Math.max((now - _dragPrev.t) / 1000, 1 / 240);
    _dragVel.set((_dragHit.x - _dragPrev.x) / ddt, 0, (_dragHit.z - _dragPrev.z) / ddt);
  }
  _dragPrev = { x: _dragHit.x, z: _dragHit.z, t: now };
  dragBody.mesh.position.x = _dragHit.x;
  dragBody.mesh.position.z = _dragHit.z;
});

window.addEventListener('pointerup', () => {
  if (!dragBody) return;
  dragBody.dragging = false;
  dragBody.vx = THREE.MathUtils.clamp(_dragVel.x, -25, 25); // fling with the drag motion
  dragBody.vz = THREE.MathUtils.clamp(_dragVel.z, -25, 25);
  dragBody = null;
  controls.enabled = true;
  _dragVel.set(0, 0, 0);
});

// ---- Undo (snapshot the sculpt field + castles before each edit) ---------
const undoStack = [];
const UNDO_MAX = 30;
function snapshotState() {
  const d = [], m = [];
  const delta = island.delta, moist = island.moist;
  for (let k = 0; k < delta.length; k++) {
    if (delta[k] > 0.01 || delta[k] < -0.01) d.push([k, delta[k]]);
    if (moist[k] > 0.005) m.push([k, moist[k]]);
  }
  return { d, m, castles: castles.items.map((c) => [c.x, c.z, c.R]) };
}
function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}
function undo() {
  const s = undoStack.pop();
  if (!s) { console.log('没有可撤销的操作'); return; }
  island.restoreState(s.d, s.m);
  castles.clear();
  for (const [x, z, R] of s.castles) castles.add(x, z, island.heightAt(x, z), R);
  console.log('已撤销');
}
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
});
fBuild.add({ undo }, 'undo').name('↩ 撤销（Ctrl+Z）');

// Brush cursor — a translucent ring that rides the terrain and shows the brush
// radius, so the player can see exactly where sand is about to move.
const brushCursor = (() => {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.88, 1.0, 56),
    new THREE.MeshBasicMaterial({ color: 0x56dcff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })
  );
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(1.0, 56),
    new THREE.MeshBasicMaterial({ color: 0x56dcff, transparent: true, opacity: 0.10, depthWrite: false })
  );
  g.add(fill, ring);
  g.rotation.x = -Math.PI / 2;
  g.visible = false;
  g.renderOrder = 900;
  scene.add(g);
  return g;
})();
const CURSOR_MODES = ['Raise', 'Lower', 'Smooth', 'Tower', 'Wet', 'Dry', 'Flag'];
const _cursorPt = new THREE.Vector3();
let cursorPt = null;

// ---- Sandcastle sculpting (build mode) ---------------------------------
// The brush picks against the heightfield itself (beachPoint), so it lands on
// top of what you've already built — no more "floating" brush on slopes.
let sculpting = false;

// Pick the castle nearest the pointer's view ray (bounding-sphere test). A game
// style picker is more forgiving than exact InstancedMesh triangle hits and
// doesn't depend on the merged geometry's raycast behaviour.
const _pc = new THREE.Vector3();
function pickCastle(ev) {
  pointerNDC(ev);
  _ray.setFromCamera(_ndc, camera);
  const ro = _ray.ray.origin, rd = _ray.ray.direction;
  let best = null, bestT = Infinity;
  for (const it of castles.items) {
    if (it.dead) continue;
    _pc.set(it.x, it.y + it.R * 0.8, it.z);          // approximate turret centre
    const ocx = _pc.x - ro.x, ocy = _pc.y - ro.y, ocz = _pc.z - ro.z;
    const tca = ocx * rd.x + ocy * rd.y + ocz * rd.z;  // distance along the ray
    if (tca < 0) continue;
    const d2 = (ocx * ocx + ocy * ocy + ocz * ocz) - tca * tca;
    const r = it.R * 1.15;
    if (d2 > r * r) continue;                         // ray misses the turret
    if (tca < bestT) { bestT = tca; best = it; }
  }
  return best;
}

// The bucket needs a real point *on the sand* (so it can be placed on top of a
// castle you already built), so march the heightfield along the view ray
// instead of intersecting a flat plane.
const _beach = new THREE.Vector3();
const _rimPts = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
// Rest the bucket *in* the sand: the lowest terrain height under its rim, minus a
// little sink, so it doesn't hover on a slope.
function bucketRestY(x, z, r) {
  let lo = island.heightAt(x, z);
  for (let i = 0; i < _rimPts.length; i++) {
    const h = island.heightAt(x + _rimPts[i][0] * r, z + _rimPts[i][1] * r);
    if (h < lo) lo = h;
  }
  return lo - r * 0.05;
}
function beachPoint(ev, out = _beach) {
  pointerNDC(ev);
  _ray.setFromCamera(_ndc, camera);
  const o = _ray.ray.origin, d = _ray.ray.direction;
  let t = 0.5;
  for (let i = 0; i < 64; i++) {
    const step = 0.5 + t * 0.035;
    const tNext = t + step;
    const x = o.x + d.x * tNext, y = o.y + d.y * tNext, z = o.z + d.z * tNext;
    if (tNext > 900) break;
    if (y <= island.heightAt(x, z)) {
      // Bisect for a clean hit (the march step grows with distance).
      let lo = t, hi = tNext;
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) * 0.5;
        if (o.y + d.y * mid <= island.heightAt(o.x + d.x * mid, o.z + d.z * mid)) hi = mid;
        else lo = mid;
      }
      out.set(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi);
      return out;
    }
    t = tNext;
  }
  return null;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  if (dragBody) return;               // let an object drag win
  // Move-tool: pick a castle and drag it. Works with or without build mode so you
  // can rearrange the beach without leaving orbit available for empty clicks.
  if (build.mode === 'Move') {
    const it = pickCastle(ev);
    if (it) {
      pushUndo();
      dragCastle = it;
      // Remember where the castle sits relative to the pointer's ground point,
      // so it stays "in hand" instead of teleporting to the ray's landing spot.
      const g = beachPoint(ev);
      dragOffset = g ? { dx: it.x - g.x, dz: it.z - g.z } : { dx: 0, dz: 0 };
      controls.enabled = false;       // hold the camera still while dragging
      renderer.domElement.setPointerCapture(ev.pointerId);
    }
    return;
  }
  if (!build.enabled) return;         // everything below this point is sculpting
  if (build.mode === 'Bucket') {
    // Tap to tip the bucket over where it hovers. OrbitControls stays enabled so
    // the camera can still be moved by dragging.
    if (bucket.busy) return;
    const p = beachPoint(ev);
    if (!p) return;
    pushUndo();
    bucket.show();
    bucket.hoverAt(p.x, bucketRestY(p.x, p.z, build.bucketR), p.z);
    bucket.pour();
    return;
  }
  if (build.mode !== 'Flag') pushUndo();   // sculpting edits the terrain → undoable
  const p = beachPoint(ev);
  if (!p) return;
  sculpting = true;
  controls.enabled = false;            // don't orbit while building
  renderer.domElement.setPointerCapture(ev.pointerId);
  applySculpt(p);
}, { capture: true });

window.addEventListener('pointermove', (ev) => {
  if (dragCastle) {
    const p = beachPoint(ev);
    if (p) {
      // Keep the castle "in hand": offset the landing point by where it was
      // grabbed, so it glides with the pointer instead of teleporting under it.
      const lx = p.x + dragOffset.dx;
      const lz = p.z + dragOffset.dz;
      dragCastle.x = lx;
      dragCastle.z = lz;
      dragCastle.y = island.heightAt(lx, lz) - dragCastle.R * 0.06;  // hug the terrain
      castles._dirty = true;
    }
    return;
  }
  if (!sculpting) return;
  const p = beachPoint(ev);
  if (p) applySculpt(p);
});

window.addEventListener('pointerup', () => {
  if (dragCastle) {
    const it = dragCastle;
    // Realistic landing: settle onto the new spot, lean to its slope, and kick up
    // a little sand. (We skip re-pouring a collar so dragging leaves no terrain trail.)
    castles.rebed(it);
    sandPuffs.spawn(it.x, it.y, it.z, 10);
    dragCastle = null;
    controls.enabled = true;
    return;
  }
  if (!sculpting) return;
  sculpting = false;
  controls.enabled = true;
});

// Bucket follows the pointer across the beach while that tool is selected.
window.addEventListener('pointermove', (ev) => {
  if (!build.enabled || build.mode !== 'Bucket' || bucket.busy) return;
  const p = beachPoint(ev);
  if (p) {
    bucket.show();
    bucket.hoverAt(p.x, bucketRestY(p.x, p.z, build.bucketR), p.z);
  } else {
    bucket.hide();
  }
});

// Brush cursor follows the pointer for the sculpt tools (its own out vector so
// it never aliases the shared _beach result used by applySculpt).
window.addEventListener('pointermove', (ev) => {
  if (!build.enabled || !CURSOR_MODES.includes(build.mode)) { cursorPt = null; return; }
  cursorPt = beachPoint(ev, _cursorPt);
});

const lastFlag = { x: Infinity, z: Infinity };
function applySculpt(p) {
  const r = build.radius;
  const y = island.heightAt(p.x, p.z);
  switch (build.mode) {
    case 'Raise': island.sculptAt(p.x, p.z, r, build.strength * 0.03, +1, build.wetMix * 0.05); sandPuffs.spawn(p.x, y, p.z, 3); break;
    case 'Lower': island.sculptAt(p.x, p.z, r, build.strength * 0.03, -1, 0); sandPuffs.spawn(p.x, y, p.z, 3); break;
    case 'Tower': island.sculptAt(p.x, p.z, r * 0.7, build.strength * 0.06, +1, build.wetMix * 0.06, true); sandPuffs.spawn(p.x, y, p.z, 4); break;
    case 'Smooth':island.smoothAt(p.x, p.z, r, build.strength * 0.06); break;
    case 'Wet':   island.wetAt(p.x, p.z, r, 0.05); break;
    case 'Dry':   island.wetAt(p.x, p.z, r, -0.05); break;
    case 'Flag':  if (Math.hypot(p.x - lastFlag.x, p.z - lastFlag.z) > 3.5) { placeFlag(p.x, p.z); lastFlag.x = p.x; lastFlag.z = p.z; } break;
  }
}

// ---------------------------------------------------------------------------
//  Render loop
// ---------------------------------------------------------------------------
let lastNow = performance.now();
let time = 0;
let frame = 0;
let erodeAcc = 0;
let settleAcc = 0;
let dofLevel = 0;   // smoothed depth-of-field amount (crouch shots)
// Adaptive resolution: if the GPU can't hold ~30 fps, step the render scale
// down instead of dropping frames. (Standard console/engine behaviour.)
let perfAcc = 0;
let perfN = 0;
const invProjView = new THREE.Matrix4();

function setVisible(underwater, refractionPass) {
  if (refractionPass) {
    // Background behind the water: sky + floor only.
    ocean.mesh.visible = false;
    sky.mesh.visible = true;
    floor.mesh.visible = true;
    particles.points.visible = false;
  } else {
    ocean.mesh.visible = true;
    sky.mesh.visible = !underwater;
    floor.mesh.visible = true;
    particles.points.visible = underwater;
  }
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  // Pausing freezes the simulation clock (waves, foam, clouds, physics) while
  // the camera and GUI keep working — handy for composing a shot.
  const dt = view.paused ? 0 : Math.min((now - lastNow) / 1000, 0.05);
  time += dt;
  lastNow = now;

  // Adaptive render scale (only ever lowers, and only if the user left it on).
  if (view.adaptive) {
    perfAcc += dt; perfN++;
    if (perfAcc > 1.5) {
      const avg = perfAcc / perfN;
      if (avg > 0.034 && view.scale > 0.56) {   // < ~30 fps
        view.scale = Math.max(0.5, view.scale - 0.15);
        applyRenderSize();
        if (perfScaleCtrl) perfScaleCtrl.updateDisplay();
      }
      perfAcc = 0; perfN = 0;
    }
  }

  if (diveTween) stepDive(dt);
  else controls.update();

  // Rebuilds this frame's harmonic table and re-centres the LOD grid, so the
  // CPU surface queries below integrate exactly what the GPU is about to draw.
  ocean.update(time, camera);

  // Advance the foam/wetness field BEFORE the scene renders so the water and
  // the beach can sample this frame's result. The field follows the camera
  // (clipmap), so re-point the shared uniforms every frame — the texture
  // ping-pongs between two render targets.
  foam.render(dt, camera.position);
  ocean.uniforms.uFoamTex.value = foam.texture;
  ocean.uniforms.uFoamCenter.value.copy(foam.center);
  island.uniforms.uFoamTex.value = foam.texture;
  island.uniforms.uFoamCenter.value.copy(foam.center);

  // Surface immersion test (exact wave height at the camera column).
  const surfaceH = ocean.heightAt(camera.position.x, camera.position.z, time);
  const underwater = camera.position.y < surfaceH - 0.15;

  // Keep the camera above the seabed.
  if (camera.position.y < -FLOOR_DEPTH + 3) camera.position.y = -FLOOR_DEPTH + 3;

  floor.update(time, camera);
  island.update(time);
  erodeAcc += dt;
  if (erodeAcc >= 0.25) { island.erode(erodeAcc); erodeAcc = 0; }
  settleAcc += dt;
  if (settleAcc >= 0.18) { island.settle(settleAcc); settleAcc = 0; }
  sandPuffs.update(dt);
  bucket.update(dt);
  castles.update(dt, (x, z) => ocean.heightAt(x, z, time));
  particles.update(time, camera);
  sky.update(camera, time);
  flagClothMat.uniforms.uTime.value = time;
  bodies.update(dt, time, ocean, terrainAt);
  // Trees answer the wind, gulls circle on their own.
  trees.update(time, 0.5 + ocean.uniforms.uAmplitude.value * 0.8);
  birds.update(time);
  audio.update(ocean.uniforms.uAmplitude.value, ocean.uniforms.uWindSpeed.value);

  // Brush cursor — rides the terrain and scales to the brush radius.
  brushCursor.visible = build.enabled && CURSOR_MODES.includes(build.mode) && cursorPt !== null;
  if (brushCursor.visible) {
    brushCursor.position.set(cursorPt.x, island.heightAt(cursorPt.x, cursorPt.z) + 0.1, cursorPt.z);
    brushCursor.scale.setScalar(build.radius);
  }

  ocean.uniforms.uCameraUnderwater.value = underwater ? 1 : 0;
  ocean.uniforms.uProjMatrix.value.copy(camera.projectionMatrix);
  post.underwaterMat.uniforms.uTime.value = time;

  // Feed floating bodies into the ocean's contact-foam field (rings, wakes,
  // splash bursts). Strength blends wetness, speed and any recent splash.
  const ou = ocean.uniforms;
  const blist = bodies.bodies;
  const bn = Math.min(blist.length, MAX_FOAM_BODIES);
  ou.uBodyCount.value = bn;
  for (let i = 0; i < bn; i++) {
    const b = blist[i];
    const spd = Math.hypot(b.vx, b.vz);
    const wet = b.wet || 0;
    const strength = wet > 0.02
      ? Math.min(2, (0.3 + spd * 0.22 + (b.splash || 0)) * Math.min(wet * 3, 1))
      : Math.min(2, b.splash || 0);
    ou.uBodies.value[i].set(b.mesh.position.x, b.mesh.position.z, b.r * 1.15, strength);
    ou.uBodyVel.value[i].set(b.vx, b.vz);
  }

  // Sync the sea's cloud shadows with the volumetric layer (drift, coverage).
  if (clouds.enabled) {
    ou.uCloudShadow.value = cloudShadowP.strength;
    ou.uCloudPlaneY.value = cu.uBase.value + cu.uHeight.value * 0.5;
    ou.uCloudScale.value = cu.uNoiseScale.value;
    ou.uCloudCoverage.value = cu.uCoverage.value * (1 - cu.uHeightFalloff.value * 0.5);
    ou.uCloudDrift.value.copy(cu.uDrift.value);
  }

  renderer.setClearColor(OCEAN_CONFIG.deepColor, 1);

  // --- Pass A: refraction background (skip while submerged) ---
  if (!underwater) {
    setVisible(underwater, true);
    renderer.setRenderTarget(refractionRT);
    renderer.render(scene, camera);
  }

  // --- Pass B: full scene to HDR ---
  setVisible(underwater, false);
  renderer.setRenderTarget(hdrRT);
  renderer.render(scene, camera);

  // --- Volumetric clouds: raymarch a low-res HDR buffer from the scene depth ---
  if (clouds.enabled) clouds.render(dt, camera, hdrRT.depthTexture);

  // --- Post: underwater volumetrics + clouds + bloom + tone-map to screen ---
  invProjView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
  // Depth-of-field: pull focus onto the sandcastles when the camera is down at
  // eye level (the crouch vantage), melting the surf behind them.
  const dofTarget = (!underwater && camera.position.y < 2.5) ? 1 : 0;
  dofLevel += (dofTarget - dofLevel) * Math.min(1, dt * 6);
  post.compositeMat.uniforms.uDofAmount.value = dofLevel;
  post.compositeMat.uniforms.uFocusDist.value = camera.position.distanceTo(controls.target);
  post.render(hdrRT, {
    invProjView,
    cameraPos: camera.position,
    sunDir,
    time,
    underwater,
    surfaceY: OCEAN_CONFIG.surfaceY,
    cloudTexture: clouds.enabled ? clouds.texture : null,
  });

  // --- HUD ---
  const depthBelow = surfaceH - camera.position.y;
  depthStateEl.textContent = underwater ? '水下' : '水面之上';
  depthStateEl.style.color = underwater ? '#7fe0d0' : '#9be7ff';
  depthValEl.textContent = (underwater ? depthBelow : camera.position.y).toFixed(1) + ' m';

  frame++;
  if (frame === 2) {
    bootEl.classList.add('hidden');
    depthEl.hidden = false;
    showInvite();
    setTimeout(() => bootEl.remove(), 1200);
    setTimeout(() => (hintEl.style.opacity = '0'), 7000);
  }
}

// Small handle for debugging / automation (harmless in production).
window.OCEAN = { camera, controls, diveTo, crouchHere, saveScene, loadScene, sunParams, applySun, applyPreset, PRESETS, ocean, floor, island, post, bodies, dropObject, dropAtTarget, clouds, setCloudsEnabled, renderer, view, applyRenderSize, bucket, castles, build, foam, trees, birds, audio, undo, pushUndo, undoStack, brushCursor, buildDemoCastle, scatterShells, get renderSize() { return [renderW, renderH]; } };

applySun();
setCloudsEnabled(true); // volumetric clouds on by default (toggle in the GUI)
animate();
