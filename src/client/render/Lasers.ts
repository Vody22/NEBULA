import * as THREE from 'three';
import type { FactionId } from '../../shared/sim/types';

interface Bolt {
  id: number;
  p0: THREE.Vector3;
  v: THREE.Vector3;
  t0: number;
  life: number;
}

const MAX = 600;

const boltVert = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
// Across the ribbon: a white-hot core inside a coloured glow. Along it: the
// head is brightest and the tail fades out.
const boltFrag = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uGlow;
varying vec2 vUv;
void main(){
  float c = abs(vUv.x - 0.5) * 2.0;
  float core = exp(-c * c * 70.0);
  float glow = exp(-c * c * 7.0);
  float along = vUv.y;
  float body = smoothstep(0.0, 0.75, along) * (1.0 - smoothstep(0.96, 1.0, along));
  gl_FragColor = vec4((uCore * core + uGlow * glow * 0.55) * body, 1.0);
}`;

/**
 * Renders laser bolts from 'shot' events. Bolts are ballistic, so the client
 * reconstructs them exactly from (position, velocity, time) with no per-tick
 * network traffic. Each bolt is a ribbon turned toward the camera.
 */
export class Lasers {
  readonly group = new THREE.Group();
  private bolts: Record<FactionId, Bolt[]> = { union: [], raiders: [] };
  private meshes: Record<FactionId, THREE.InstancedMesh>;
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private side = new THREE.Vector3();
  private view = new THREE.Vector3();
  private up = new THREE.Vector3();

  constructor() {
    // Ribbon in the XY plane: x across (0..1 in uv.x), y along, tail at y = 0.
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    const make = (core: THREE.Color, glow: THREE.Color) => {
      const mesh = new THREE.InstancedMesh(
        geo,
        new THREE.ShaderMaterial({
          vertexShader: boltVert,
          fragmentShader: boltFrag,
          uniforms: { uCore: { value: core }, uGlow: { value: glow } },
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          side: THREE.DoubleSide,
        }),
        MAX,
      );
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
      return mesh;
    };
    this.meshes = {
      union: make(new THREE.Color(5, 7, 9), new THREE.Color(0.5, 1.6, 5)),
      raiders: make(new THREE.Color(9, 6, 4), new THREE.Color(5, 1.1, 0.3)),
    };
  }

  add(id: number, faction: FactionId, pos: [number, number, number], vel: [number, number, number], t0: number, life: number) {
    const list = this.bolts[faction];
    if (list.length >= MAX) list.shift();
    list.push({ id, p0: new THREE.Vector3(...pos), v: new THREE.Vector3(...vel), t0, life });
  }

  clear() {
    this.bolts.union.length = 0;
    this.bolts.raiders.length = 0;
  }

  remove(id: number) {
    for (const f of ['union', 'raiders'] as FactionId[]) {
      const list = this.bolts[f];
      const i = list.findIndex((b) => b.id === id);
      if (i >= 0) {
        list.splice(i, 1);
        return;
      }
    }
  }

  update(time: number, camPos: THREE.Vector3) {
    for (const f of ['union', 'raiders'] as FactionId[]) {
      const list = this.bolts[f];
      const mesh = this.meshes[f];
      let n = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        const age = time - b.t0;
        if (age > b.life) {
          list.splice(i, 1);
          continue;
        }
        if (age < 0) continue;
        const speed = b.v.length();
        // Stretch the bolt but never draw it behind the muzzle.
        const len = Math.min(30, speed * Math.max(age, 0.004));
        this.dir.copy(b.v).divideScalar(speed);
        this.p.copy(b.p0).addScaledVector(b.v, age).addScaledVector(this.dir, -len);
        // Face the camera; far bolts widen so they stay a couple of pixels thick.
        this.view.subVectors(camPos, this.p);
        const dist = this.view.length();
        this.side.crossVectors(this.dir, this.view).normalize();
        const width = Math.max(1.6, dist * 0.004);
        this.up.copy(this.dir).multiplyScalar(len);
        this.side.multiplyScalar(width);
        this.view.crossVectors(this.side, this.up).normalize();
        this.m.makeBasis(this.side, this.up, this.view).setPosition(this.p);
        mesh.setMatrixAt(n, this.m);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
