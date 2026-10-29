import * as THREE from 'three';

// Procedural gulls — a handful of dark V-shaped silhouettes circling the island
// on tilted elliptical orbits. Each wing flaps in the vertex shader (aFlap
// weights the wing-tip vertices), and the body banks into the turn. A few draw
// calls total; the birds are read as silhouettes, so flat colour is enough.
export class Birds {
  constructor(scene, center = new THREE.Vector2(0, -110), count = 9) {
    this.scene = scene;
    this.center = center;
    this.birds = [];

    const geo = buildGull();
    for (let i = 0; i < count; i++) {
      const mat = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uPhase: { value: Math.random() * 6.283 },
          uColor: { value: new THREE.Color().setHSL(0.56, 0.08, 0.14 + Math.random() * 0.08) },
        },
        vertexShader: /* glsl */ `
          attribute float aFlap;
          uniform float uTime;
          uniform float uPhase;
          void main(){
            vec3 p = position;
            float flap = sin(uTime * 6.5 + uPhase) * 0.5 + 0.5;
            p.y += aFlap * flap * 0.85;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          void main(){ gl_FragColor = vec4(uColor, 1.0); }
        `,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.birds.push({
        mesh,
        rx: 68 + Math.random() * 62,
        rz: 46 + Math.random() * 42,
        h: 16 + Math.random() * 16,
        w: 0.22 + Math.random() * 0.22,      // angular speed (rad/s)
        phase: Math.random() * 6.283,
        bank: (Math.random() < 0.5 ? -1 : 1) * (0.18 + Math.random() * 0.14),
        scale: 1.0 + Math.random() * 0.7,
      });
    }
  }

  update(time) {
    for (const b of this.birds) {
      const a = time * b.w + b.phase;
      const x = this.center.x + Math.cos(a) * b.rx;
      const z = this.center.y + Math.sin(a) * b.rz;
      const y = b.h + Math.sin(a * 2.1 + b.phase) * 2.2;

      b.mesh.position.set(x, y, z);

      // Head into the tangent of the orbit (lookAt points +z at the target).
      const da = 0.05;
      const nx = this.center.x + Math.cos(a + da) * b.rx;
      const nz = this.center.y + Math.sin(a + da) * b.rz;
      b.mesh.lookAt(nx, y + Math.sin((a + da) * 2.1 + b.phase) * 2.2, nz);
      b.mesh.rotateZ(b.bank);   // bank into the turn
      b.mesh.scale.setScalar(b.scale);
      b.mesh.material.uniforms.uTime.value = time;
    }
  }

  dispose() {
    for (const b of this.birds) {
      b.mesh.material.dispose();
    }
    this.birds[0]?.mesh.geometry.dispose();
  }
}

// A gull as two triangles: body at the origin, head toward +z, wings swept
// back and up. aFlap is 0 at the body and 1 at the wing tips, so the vertex
// shader lifts the tips while the body stays still.
function buildGull() {
  // positions (x, y, z):  body(0), left root(1), left tip(2), right root(3), right tip(4)
  const pos = new Float32Array([
     0.00,  0.00,  0.00,
     0.00,  0.10, -0.30,
    -0.95,  0.34, -2.10,
     0.00,  0.10, -0.30,
     0.95,  0.34, -2.10,
  ]);
  const flap = new Float32Array([
    0.0,   // body
    0.25,  // left root
    1.0,   // left tip
    0.25,  // right root
    1.0,   // right tip
  ]);
  const idx = new Uint16Array([0, 1, 2, 0, 3, 4]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aFlap', new THREE.BufferAttribute(flap, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}
