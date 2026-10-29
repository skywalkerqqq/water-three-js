import * as THREE from 'three';

// A toy bucket: packs wet sand, flips over, and dumps a shaped pile.
//
// The sand itself is NOT geometry — when the bucket reaches the upside-down
// pose it fires `onDump(x, z)` and the island writes the pile into its sculpt
// heightfield (Island.pourBucket), so the castle is real terrain that the waves,
// the shadows and the buoyancy all see, and that the settle/erode simulation can
// then eat away.
//
// Local frame: origin at the rim/ground contact, body extends to +y, so a
// rotation of π about X puts the mouth on the ground with the closed bottom up —
// exactly how a kid turns a bucket out.
export class Bucket {
  constructor(scene) {
    this.radius = 3.4;
    this.height = this.radius * 1.2;
    this.state = 'idle';        // idle | tip | back
    this.t = 0;
    this.dumped = false;
    this.onDump = null;         // (x, z) => void
    this._visible = false;

    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xd8483a, roughness: 0.42, metalness: 0.06, side: THREE.DoubleSide,
      envMapIntensity: 0.6,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xf2f4f2, roughness: 0.38, metalness: 0.08,
    });
    const handleMat = new THREE.MeshStandardMaterial({
      color: 0x8d99a3, roughness: 0.32, metalness: 0.6,
    });
    this.sandMat = new THREE.MeshStandardMaterial({
      color: 0x9c7f52, roughness: 0.95, metalness: 0.0,
    });

    // Unit bucket (radius 1, height 1.2) — the whole group is scaled by `radius`.
    const H = 1.2;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.8, H, 24, 1, true), bodyMat);
    body.position.y = H * 0.5;
    this.group.add(body);

    const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.8, 24), bodyMat);
    bottom.rotation.x = Math.PI / 2;      // faces -y
    this.group.add(bottom);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.045, 6, 26), trimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = H;
    this.group.add(rim);

    // Wire handle: a half torus standing on the rim.
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.028, 5, 20, Math.PI), handleMat);
    handle.position.y = H;
    this.group.add(handle);

    // The packed sand inside — hides while the bucket is tipped over.
    this.sand = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.76, H * 0.9, 24), this.sandMat);
    this.sand.position.y = H * 0.47;
    this.group.add(this.sand);

    this._ground = 0;                     // y of the sand under the bucket
    this._pos = new THREE.Vector3();
    this.setRadius(this.radius);
  }

  setRadius(r) {
    this.radius = r;
    this.height = r * 1.2;
    this.group.scale.setScalar(r);
  }

  // Hover over a beach point (world x, terrain y, world z).
  hoverAt(x, y, z) {
    this._pos.set(x, y, z);
    if (this.state === 'idle') {
      this.group.position.set(x, y, z);
      this.group.rotation.x = 0;
    }
  }

  show() { this.group.visible = true; this._visible = true; }
  hide() { this.group.visible = false; this._visible = false; }

  get busy() { return this.state !== 'idle'; }

  // Start a pour. Returns false if one is already running (so a click can't
  // stack animations).
  pour() {
    if (this.state !== 'idle') return false;
    this.state = 'tip';
    this.t = 0;
    this.dumped = false;
    this.sand.visible = true;
    return true;
  }

  update(dt) {
    if (this.state === 'idle') return;
    this.t += dt;
    const Hgt = this.height;             // real world height (= radius * 1.2)

    let phi;
    if (this.state === 'tip') {
      const p = Math.min(1, this.t / 0.26);
      const e = p * p * (3 - 2 * p);
      phi = Math.PI * e;
      if (!this.dumped && p > 0.6) {
        this.dumped = true;
        this.sand.visible = false;
        if (this.onDump) this.onDump(this._pos.x, this._pos.z);
      }
      if (p >= 1) { this.state = 'back'; this.t = 0; }
    } else { // back
      const p = Math.min(1, this.t / 0.34);
      const e = 1 - (1 - p) * (1 - p);
      phi = Math.PI * (1 - e);
      if (p >= 1) {
        this.state = 'idle';
        this.group.rotation.x = 0;
        this.group.position.set(this._pos.x, this._pos.y, this._pos.z);
        this.sand.visible = true;
        return;
      }
    }
    // Lift with the tip so the mouth (and the whole bucket) never sinks below
    // the sand. The arc has the mouth exactly on the surface at full invert and
    // rises smoothly — no more clipping through the terrain.
    this.group.rotation.x = phi;
    this.group.position.y = this._pos.y + Hgt * (1 - Math.cos(phi)) * 0.5;
  }
}
