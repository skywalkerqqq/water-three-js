import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Procedural coconut palms — tall and detailed.
//
// Trunk: one continuous, smooth mesh (rings swept along a gentle arc) rather
// than a stack of cylinder segments — no seams, no saw-tooth silhouette. Base
// flare + smooth taper, gently curved so the palm leans.
//
// Crown: a radial fan of pinnate (feather) fronds — a tapering midrib with pairs
// of tapered, faintly down-curling leaflets swept forward off it. Most fronds are
// green; a few "old" ones go yellow-brown and hang lower. A small cluster of
// coconuts sits at the crown centre. The crown is anchored to the actual trunk
// top (bend included), so it never drifts off the stem.
//
// Real coconut palms run 15–25 m tall; at scale 1.1–1.7 against a ~350 m island
// this reads as a proper tree rather than a shrub.

const TRUNK_H = 13.0;       // trunk height at scale 1
const TRUNK_BEND = 0.95;    // +x offset of the trunk top at scale 1 (the lean)

const OLD_SLOTS = new Set([3, 8, 12]);   // which crown angles are the "old" fronds
const FROND_N = 14;                      // fronds per crown

export class PalmTrees {
  constructor(scene, heightAt, { max = 40 } = {}) {
    this.scene = scene;
    this.heightAt = heightAt;
    this.max = max;
    this.items = [];

    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x9a7856, roughness: 0.94, metalness: 0.0 });
    const frondMat = new THREE.MeshStandardMaterial({
      color: 0x4aa254, roughness: 0.78, metalness: 0.0, side: THREE.DoubleSide,
      emissive: 0x14351d, emissiveIntensity: 1.2,   // leaf translucency — never pure black
    });
    const oldFrondMat = new THREE.MeshStandardMaterial({
      color: 0xb09140, roughness: 0.82, metalness: 0.0, side: THREE.DoubleSide,
      emissive: 0x3a3010, emissiveIntensity: 1.0,
    });
    const coconutMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.85, metalness: 0.0 });

    this.trunks = new THREE.InstancedMesh(buildTrunk(), trunkMat, max);
    this.fronds = new THREE.InstancedMesh(buildFronds(false), frondMat, max);
    this.oldFronds = new THREE.InstancedMesh(buildFronds(true), oldFrondMat, max);
    this.coconuts = new THREE.InstancedMesh(buildCoconuts(), coconutMat, max);
    this.all = [this.trunks, this.fronds, this.oldFronds, this.coconuts];
    for (const m of this.all) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      scene.add(m);
    }

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._tq = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this.TRUNK_H = TRUNK_H;
  }

  // Scatter palms across the dry beach band and lower dunes. Rejected with a
  // spacing check so they don't clump.
  scatter(count = 22, spacing = 12.0) {
    this.items.length = 0;
    let placed = 0, guard = 0;
    const maxGuard = count * 50;
    while (placed < count && guard++ < maxGuard) {
      const x = (Math.random() - 0.5) * 340;
      const z = -110 + (Math.random() - 0.5) * 300;
      const y = this.heightAt(x, z);
      if (y < 1.8 || y > 6.0) continue;   // beach back edge → lower dunes
      let ok = true;
      for (const t of this.items) {
        if (Math.hypot(t.x - x, t.z - z) < spacing) { ok = false; break; }
      }
      if (!ok) continue;
      const scale = 1.1 + Math.random() * 0.6;   // 1.1 … 1.7
      this.items.push({ x, z, y, scale, yaw: Math.random() * Math.PI * 2, phase: Math.random() * 6.283, lean: 0.05 + Math.random() * 0.07 });
      placed++;
    }
    this._rebuild();
  }

  // Crown sits at the actual top of the (leaning) trunk, so it never drifts off.
  // Orientation is yaw + per-frame sway (not the trunk lean — the frond fan stays
  // roughly level while the stem curves).
  _crownMatrix(it, tiltX, tiltZ) {
    // Trunk transform: same as the trunk instance matrix below.
    this._e.set(it.lean, it.yaw, it.lean * 0.7);
    this._tq.setFromEuler(this._e);
    // Trunk top in local space → scale → rotate → add trunk base.
    this._p.set(TRUNK_BEND, TRUNK_H, 0).multiplyScalar(it.scale).applyQuaternion(this._tq);
    this._p.x += it.x; this._p.y += it.y; this._p.z += it.z;
    // Crown orientation.
    this._e.set(tiltX, it.yaw, tiltZ);
    this._q.setFromEuler(this._e);
    this._s.setScalar(it.scale);
    return this._m.compose(this._p, this._q, this._s);
  }

  _rebuild() {
    const n = Math.min(this.items.length, this.max);
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      // Trunk — a pronounced lean (palms arc toward the sea / light).
      this._e.set(it.lean, it.yaw, it.lean * 0.7);
      this._q.setFromEuler(this._e);
      this._p.set(it.x, it.y, it.z);
      this._s.setScalar(it.scale);
      this._m.compose(this._p, this._q, this._s);
      this.trunks.setMatrixAt(i, this._m);

      // Crown at the trunk top (fronds sway every frame in update()).
      this.fronds.setMatrixAt(i, this._crownMatrix(it, 0, 0));
      this.oldFronds.setMatrixAt(i, this._m);
      this.coconuts.setMatrixAt(i, this._m);
    }
    for (const m of this.all) m.count = n;
    for (const m of this.all) m.instanceMatrix.needsUpdate = true;
  }

  // Sway the crowns with the wind. `wind` ~ 0 (calm) … 2 (storm) — main.js
  // derives it from the ocean's amplitude so the trees answer the waves.
  update(time, wind = 1) {
    const n = this.fronds.count;
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      const tiltX = Math.sin(time * 1.5 + it.phase) * 0.06 * wind;
      const tiltZ = Math.cos(time * 1.2 + it.phase * 1.7) * 0.05 * wind;
      this._crownMatrix(it, tiltX, tiltZ);
      this.fronds.setMatrixAt(i, this._m);
      this.oldFronds.setMatrixAt(i, this._m);
      this.coconuts.setMatrixAt(i, this._m);
    }
    if (n) {
      this.fronds.instanceMatrix.needsUpdate = true;
      this.oldFronds.instanceMatrix.needsUpdate = true;
      this.coconuts.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const m of this.all) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }
}

// A smooth, continuous trunk: rings swept up a gently curving centre line, with a
// smooth base flare + taper. One mesh, so there are no segment seams or saw-tooth
// steps in the silhouette.
function buildTrunk() {
  const SEG = 20;      // radial resolution
  const RINGS = 46;    // rings along the height
  const pos = [];
  const idx = [];

  const bendX = (t) => TRUNK_BEND * t * t;      // smooth quadratic lean
  const radius = (t) => {
    const taper = 0.40 - 0.24 * t;              // 0.40 → 0.16
    const flare = 0.13 * Math.exp(-t * 9);      // flared root
    const bulge = 0.018 * Math.sin(Math.PI * t);
    return taper + flare + bulge;
  };

  const BURY = 1.2;   // extend the base below the sand so no open ring edge shows
  for (let j = 0; j <= RINGS; j++) {
    const t = j / RINGS;
    const y = -BURY + t * (TRUNK_H + BURY);
    const tt = Math.max(0, y / TRUNK_H);   // bend/taper use the above-ground part
    const cx = bendX(tt);
    const r = radius(tt);
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      pos.push(cx + Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * SEG + i;
      const b = j * SEG + ((i + 1) % SEG);
      const c = (j + 1) * SEG + i;
      const d = (j + 1) * SEG + ((i + 1) % SEG);
      idx.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// A radial fan of pinnate fronds. When `old` is true only the dying fronds are
// built (a separate mesh + material, so they can go yellow-brown); otherwise
// the live green ones. Both share the same angular slots so the crown is one
// consistent fan split across two meshes.
function buildFronds(old) {
  const parts = [];
  for (let k = 0; k < FROND_N; k++) {
    if (OLD_SLOTS.has(k) !== old) continue;
    const geo = buildPinnateFrond();
    // Three elevation tiers (arch high / mid / hang low) so the crown is a full
    // rounded fountain rather than a flat upward-bowl; old fronds hang low.
    const pitch = old ? -0.05 : (-0.12 + (k % 3) * 0.28);
    geo.rotateX(-pitch);              // negative → tilt the tip upward
    geo.rotateY((k / FROND_N) * Math.PI * 2);
    parts.push(geo);
  }
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
}

function buildPinnateFrond() {
  const LEN = 7.5;        // frond length (m)
  const DROOP = 4.2;      // tip sag (m)
  const PAIRS = 26;       // leaflet pairs per frond
  const pos = [];
  const nor = [];
  const idx = [];
  const UP = [0, 1, 0];
  let v = 0;

  const quad = (a, b, c, d) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let i = 0; i < 4; i++) nor.push(UP[0], UP[1], UP[2]);
    idx.push(v, v + 1, v + 2, v + 2, v + 3, v);
    v += 4;
  };

  // Rachis — a narrow tapering midrib from root (z=0) to tip (z=LEN), sagging.
  const SEG = 40;
  for (let i = 0; i < SEG; i++) {
    const t0 = i / SEG, t1 = (i + 1) / SEG;
    const z0 = t0 * LEN, z1 = t1 * LEN;
    const y0 = -DROOP * t0 * t0, y1 = -DROOP * t1 * t1;
    const w0 = 0.09 - 0.06 * t0, w1 = 0.09 - 0.06 * t1;
    quad([-w0, y0, z0], [w0, y0, z0], [w1, y1, z1], [-w1, y1, z1]);
  }

  // Leaflets — tapered, faintly down-curling blades (two segments each), swept
  // forward off the rachis and shrinking toward the tip. Wide enough at the base
  // to nearly touch their neighbours, so the crown reads full, not skeletal.
  const SWEEP = 0.85;  // forward sweep angle (rad)
  const DROP = 0.32;   // downward droop angle (rad)
  const CURL = 0.22;   // extra downward curl at the tip
  const sinD = Math.sin(DROP);
  for (let i = 0; i < PAIRS; i++) {
    const t = (i + 0.5) / PAIRS;
    const z = t * LEN;
    const y = -DROOP * t * t;
    const L = 1.15 - 0.82 * t;  // leaflet length 1.15 → 0.33 m
    const Wb = 0.30 - 0.15 * t; // full width at the rachis
    const Wt = 0.07;            // full width at the tip
    for (const s of [1, -1]) {
      const dx = s * Math.sin(SWEEP), dz = Math.cos(SWEEP);
      const wdx = dz, wdz = -dx;   // horizontal width dir (unit, ⊥ length)
      const root = [s * 0.04, y, z];
      const f1 = 0.55;
      const mid = [root[0] + dx * L * f1, y - sinD * L * f1 - CURL * L * f1 * f1, z + dz * L * f1];
      const tip = [root[0] + dx * L, y - sinD * L - CURL * L, z + dz * L];
      const Wm = Wb + (Wt - Wb) * f1;
      // segment A: root → mid
      quad(
        [root[0] - wdx * Wb * 0.5, root[1], root[2] - wdz * Wb * 0.5],
        [root[0] + wdx * Wb * 0.5, root[1], root[2] + wdz * Wb * 0.5],
        [mid[0] + wdx * Wm * 0.5, mid[1], mid[2] + wdz * Wm * 0.5],
        [mid[0] - wdx * Wm * 0.5, mid[1], mid[2] - wdz * Wm * 0.5],
      );
      // segment B: mid → tip (curls further down)
      quad(
        [mid[0] - wdx * Wm * 0.5, mid[1], mid[2] - wdz * Wm * 0.5],
        [mid[0] + wdx * Wm * 0.5, mid[1], mid[2] + wdz * Wm * 0.5],
        [tip[0] + wdx * Wt * 0.5, tip[1], tip[2] + wdz * Wt * 0.5],
        [tip[0] - wdx * Wt * 0.5, tip[1], tip[2] - wdz * Wt * 0.5],
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
}

// A small cluster of three coconuts at the crown centre.
function buildCoconuts() {
  const parts = [];
  const r = 0.30;
  const spots = [[0, 0.1, 0], [r * 0.8, -0.1, 0.1], [-r * 0.8, -0.1, -0.1]];
  for (const [x, y, z] of spots) {
    const c = new THREE.SphereGeometry(r, 10, 8);
    c.translate(x, y - r * 0.4, z);
    parts.push(c);
  }
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  geo.computeVertexNormals();
  return geo;
}
