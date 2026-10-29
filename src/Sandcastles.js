import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Poured sandcastles.
//
// The sculpt field is a 520 m heightfield at ~1 m cells — far too coarse to hold
// a crenellated turret (the rim and the merlons are sub-cell). So the castle is
// an instanced prop, and the terrain only gets a low skirt of sand underneath it
// (Island.pourBucket), which keeps the castle bedded into the beach, casts the
// right shadow, and lets the existing erosion eat the base away.
//
// All the turrets share one merged unit geometry, so the whole sandcastle town
// is a single draw call. Wetness: once the water surface reaches a castle's
// foot it darkens, slumps and finally disappears — the sea washes it away.
export class Sandcastles {
  constructor(scene, heightAt, max = 48) {
    this.max = max;
    this.items = [];
    this._order = [];        // items in instance order — used for raycast picking
    this.heightAt = heightAt || (() => 0);
    this._dirty = true;

    const unit = buildTurret();
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.98, metalness: 0.0,
    });
    this.mesh = new THREE.InstancedMesh(unit, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    scene.add(this.mesh);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this.dry = new THREE.Color(0xd6c5a2);
    this.wetCol = new THREE.Color(0x7a6849);
  }

  // y is the terrain height at (x, z); R the turret radius in metres.
  // Pouring near an existing castle STACKS onto it (taller + a little wider)
  // instead of dropping a second, overlapping turret.
  // opts.protect: never washed away by the sea (used for the intro demo castle).
  add(x, z, y, R, opts = {}) {
    for (const it of this.items) {
      if (it.dead) continue;
      const d = Math.hypot(it.x - x, it.z - z);
      if (d < Math.max(it.R, R) * 0.7) {
        it.levels = Math.min((it.levels ?? 0) + 1, 8);
        it.R = Math.min(it.R * 1.05, (it.baseR ?? it.R) * 1.5);
        it.y = y - it.R * 0.06;        // re-bed onto the rising mound
        it.baseR = it.baseR ?? R;
        it.bump = 0.35;                // little "pop" as it grows
        it.grow = Math.max(it.grow, 0.6);
        this._dirty = true;
        return;
      }
    }
    if (this.items.length >= this.max) this.items.shift();
    const { tx, tz } = this._slopeTilt(x, z);
    this.items.push({
      x, z, y: y - R * 0.06,
      R, baseR: R,
      yaw: Math.random() * Math.PI * 2,
      tiltX: tx, tiltZ: tz,   // lean away from the downhill slope — looks bedded, not floating
      levels: 0,
      grow: 0,
      wet: 0,
      bump: 0,
      dead: false,
      protect: !!opts.protect,
      tint: 0.92 + Math.random() * 0.16,
    });
    this._dirty = true;
  }

  // Lean a castle slightly downhill so it never sits upright on a tilt. Magnitude
  // scales with the local slope, clamped so steep dunes don't topple the turret.
  _slopeTilt(x, z) {
    const gx = this.heightAt(x + 0.6, z) - this.heightAt(x - 0.6, z);
    const gz = this.heightAt(x, z + 0.6) - this.heightAt(x, z - 0.6);
    const sl = Math.hypot(gx, gz);
    const mag = Math.min(0.12, Math.atan2(sl, 1.2) * 0.06);
    const inv = sl > 1e-4 ? 1 / sl : 0;
    return { tx: -gx * inv * mag, tz: -gz * inv * mag };
  }

  // Raycast the instance mesh and return the castle under the pointer (or null).
  pick(ray) {
    if (this.mesh.count === 0) return null;
    const hits = ray.intersectObject(this.mesh, false);
    if (!hits.length || hits[0].instanceId == null) return null;
    return this._order[hits[0].instanceId] || null;
  }

  // Re-bed a (dragged) castle: settle onto the terrain, lean to the new slope,
  // and give it a little "thud" pop. (main.js kicks up a sand puff on landing.)
  rebed(it) {
    const { tx, tz } = this._slopeTilt(it.x, it.z);
    it.tiltX = tx; it.tiltZ = tz;
    it.y = this.heightAt(it.x, it.z) - it.R * 0.06;
    it.bump = Math.max(it.bump, 0.3);
    this._dirty = true;
  }

  // Something hit the town (a dropped body landing, or being dragged through).
  // Damage the turrets inside the impact radius: they tilt, slump like wet sand
  // and finally crumble. Returns how many were hit.
  hit(x, z, energy) {
    let n = 0;
    for (const it of this.items) {
      const radius = (it._r ?? it.R) + 1.2;   // visual radius + a body's worth of margin
      const d = Math.hypot(it.x - x, it.z - z);
      if (d > radius) continue;
      const k = Math.max(0, 1 - d / radius);
      it.integrity = (it.integrity ?? 1) - energy * k * 0.75;   // one hit hurts, two kill
      it.tiltX = (it.tiltX ?? 0) + (Math.random() - 0.5) * 0.22 * energy * k;
      it.tiltZ = (it.tiltZ ?? 0) + (Math.random() - 0.5) * 0.22 * energy * k;
      if (it.integrity < 0.45) it.wet = Math.max(it.wet, 1.15);   // slump apart
      if (it.integrity < 0) it.dead = true;
      n++;
    }
    if (n) this._dirty = true;
    return n;
  }

  // Solid height at a world point — the tallest castle covering it (the turret
  // top), or -Infinity if no castle stands there. Fed to the buoyancy solver so
  // dropped bodies collide with the castles instead of passing straight through
  // (the visual radius/height, cached in update(), are reused verbatim).
  heightAt(x, z) {
    let top = -Infinity;
    for (const it of this.items) {
      if (it.dead) continue;
      const r = it._r ?? (it.R * (0.55 + 0.45 * (it.grow ?? 1)));
      const d = Math.hypot(it.x - x, it.z - z);
      if (d > r) continue;
      const h = it._h ?? (r * 1.6 * (1 + 0.10 * (it.levels ?? 0)));
      const baseY = it._baseY ?? (it.y - Math.min(1, it.wet / 2.0) * it.R * 0.25);
      const t = baseY + h;
      if (t > top) top = t;
    }
    return top;
  }

  clear() {
    this.items.length = 0;
    this.mesh.count = 0;
    this._dirty = true;
  }

  // surfaceAt(x, z) → current water surface height (0 = sea level).
  update(dt, surfaceAt) {
    const list = this.items;
    let any = this._dirty;
    for (const it of list) {
      if (it.dead) continue;
      if (it.grow < 1) { it.grow = Math.min(1, it.grow + dt * 4.5); any = true; }
      if (it.bump > 0) { it.bump = Math.max(0, it.bump - dt * 1.4); any = true; }
      // Washed away once the water stands at its foot — unless it's protected
      // (the intro demo castle lives on regardless, so the beach is never empty).
      if (!it.protect) {
        if (surfaceAt && surfaceAt(it.x, it.z) > it.y + 0.12) {
          it.wet = Math.min(2.2, it.wet + dt * 0.55);
          any = true;
        } else if (it.wet > 0) {
          it.wet = Math.max(0, it.wet - dt * 0.12);   // dries slowly
          any = true;
        }
        if (it.wet >= 2.0) { it.dead = true; any = true; }
      }
    }
    if (list.some((i) => i.dead)) {
      this.items = list.filter((i) => !i.dead);
      any = true;
    }
    this._order = this.items;          // instance i ↔ this.items[i], for picking
    if (!any) return;

    // Rebuild the instance buffers (≤48 matrices — cheap enough to just redo).
    let n = 0;
    for (const it of this.items) {
      const slump = Math.min(1, it.wet / 2.0 + (1 - (it.integrity ?? 1)) * 0.85);
      const r = it.R * (0.55 + 0.45 * it.grow) * (1 - slump * 0.45);
      // Turrets are taller than they are wide — the unit geometry is 1 × 1, so
      // the height gets its own multiplier. Each stacked pour adds a level, so the
      // castle grows taller (and the bump gives it a little pop as it lands).
      const h = r * 1.6 * (1 + 0.10 * it.levels) * (1 - slump * 0.6) * (1 + (it.bump ?? 0) * 0.4);
      const baseY = it.y - slump * it.R * 0.25;
      // Cache the resolved size so heightAt() / hit() share the EXACT radius and
      // height the renderer uses — no drift between what you see and what collides.
      it._r = r;
      it._h = h;
      it._baseY = baseY;
      this._p.set(it.x, baseY, it.z);
      this._e.set((it.tiltX ?? 0) * (1 + slump * 2), it.yaw, (it.tiltZ ?? 0) * (1 + slump * 2));
      this._q.setFromEuler(this._e);
      // Unit turret is radius 1 / height 1; uniform xz scale + separate height.
      this._s.set(r, h, r);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(n, this._m);
      this._c.copy(this.dry).lerp(this.wetCol, Math.min(1, it.wet * 0.8)).multiplyScalar(it.tint);
      this.mesh.setColorAt(n, this._c);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this._dirty = false;
  }
}

// One unit turret: tapered wall, soft wavy top, irregular hand-patted merlons
// and a flared skirt that beds it into the sand. Radius 1, height 1.
//
// Everything is then run through a coherent-noise displacement so the silhouette
// loses its "machined cylinder" perfection — hand-packed wet sand bulges, dimples
// and slumps, and a perfectly smooth turret reads instantly as fake.
function buildTurret() {
  const parts = [];
  const SEG = 36;
  const rnd = mulberry32(0x5a4d);

  // Wall — tapered, and extended well below the sand so its foot is buried: the
  // turret rises straight out of the beach mound instead of sitting on a flared
  // "saucer" skirt (which read as a plate, not sand).
  const wallH = 1.35, wallTop = 0.84;
  const wall = new THREE.CylinderGeometry(0.84, 1.10, wallH, SEG, 9, true);
  wall.translate(0, wallTop - wallH / 2, 0);   // top ring at y = 0.84
  parts.push(wall);

  // Cap — a disc domed slightly upward so the top reads as a rounded pat of sand
  // rather than a machined flat lid.
  const cap = new THREE.CircleGeometry(0.84, SEG, 0, Math.PI * 2);
  cap.rotateX(-Math.PI / 2);
  cap.translate(0, 0.84, 0);
  {
    const cp = cap.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const r = Math.hypot(cp.getX(i), cp.getZ(i)) / 0.84;
      cp.setY(i, cp.getY(i) + (1 - r * r) * 0.05);
    }
    cp.needsUpdate = true;
  }
  parts.push(cap);

  // A soft rolled lip where the wall meets the top — removes the hard machined
  // rim (wet sand squeezed at the bucket mouth rolls over into a rounded edge).
  const lip = new THREE.TorusGeometry(0.84, 0.055, 8, SEG);
  lip.rotateX(Math.PI / 2);
  lip.translate(0, 0.84, 0);
  parts.push(lip);

  // Merlons — soft, rounded lumps around the rim (wet sand has no sharp edges):
  // varied size, barely leaned, bedded INTO the top, with rounded corners instead
  // of hard boxes. Near-evenly spaced so the crenellation still reads as a wall.
  const M = 10;
  for (let k = 0; k < M; k++) {
    const a = (k + 0.5) / M * Math.PI * 2;
    const w = 0.26 + rnd() * 0.10;    // tangential width
    const h = 0.20 + rnd() * 0.10;    // height
    const d = 0.18 + rnd() * 0.05;    // radial depth
    const box = roundBox(w, h, d, Math.min(w, h, d) * 0.28);
    box.rotateY(-(a + Math.PI / 2) + (rnd() - 0.5) * 0.06);
    box.rotateZ((rnd() - 0.5) * 0.05);       // just a hint of a thumb-press lean
    box.rotateX((rnd() - 0.5) * 0.04);
    const rr = 0.87 + rnd() * 0.04;
    box.translate(Math.cos(a) * rr, 0.84 + h * 0.5 - 0.07, Math.sin(a) * rr);
    parts.push(box);
  }

  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  geo.computeVertexNormals();

  // A gentle, low-frequency displacement so the silhouette isn't a perfect
  // cylinder — coarse undulation only (no high-frequency "grain", which read as
  // noise/dirt rather than sand).
  bumpGeometry(geo, 0.012);
  geo.computeVertexNormals();
  return geo;
}

// A box with rounded edges/corners — a soft sand lump instead of a hard block.
// Uses the rounded-box SDF: clamp each surface vertex to an inner box, then push
// it back out by the corner radius.
function roundBox(w, h, d, r) {
  const g = new THREE.BoxGeometry(w, h, d, 3, 3, 3);
  const pos = g.attributes.position;
  const hx = Math.max(1e-4, w / 2 - r), hy = Math.max(1e-4, h / 2 - r), hz = Math.max(1e-4, d / 2 - r);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const cx = Math.max(-hx, Math.min(hx, x));
    const cy = Math.max(-hy, Math.min(hy, y));
    const cz = Math.max(-hz, Math.min(hz, z));
    let dx = x - cx, dy = y - cy, dz = z - cz;
    const L = Math.hypot(dx, dy, dz) || 1;
    pos.setXYZ(i, cx + (dx / L) * r, cy + (dy / L) * r, cz + (dz / L) * r);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

// Smooth, low-frequency pseudo-noise — a gentle coherent undulation so the
// silhouette bulges organically without a noisy, gritty surface.
function coherentNoise(x, y, z) {
  return Math.sin(x * 4.1 + y * 3.3 + z * 2.7)
       * Math.sin(z * 4.9 - y * 3.1 + 1.3)
       + 0.6 * Math.sin(x * 7.7 - z * 6.3 + 2.1)
       * Math.sin(y * 6.1 + 0.7);
}

// Displace each vertex along its normal by `amp` × noise(position). Small enough
// to keep the form, large enough to kill the perfect-cylinder read.
function bumpGeometry(geo, amp) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    const d = coherentNoise(v.x, v.y, v.z) * amp;
    pos.setXYZ(i, v.x + n.x * d, v.y + n.y * d, v.z + n.z * d);
  }
  pos.needsUpdate = true;
}

// Tiny seeded RNG so the (instanced) turret geometry is stable across reloads.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
