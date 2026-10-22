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

/**
 * Renders laser bolts from 'shot' events. Bolts are ballistic, so the client
 * reconstructs them exactly from (position, velocity, time) with no per-tick
 * network traffic.
 */
export class Lasers {
  readonly group = new THREE.Group();
  private bolts: Record<FactionId, Bolt[]> = { union: [], raiders: [] };
  private meshes: Record<FactionId, THREE.InstancedMesh[]>;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private fwd = new THREE.Vector3(0, 0, 1);

  constructor() {
    const core = new THREE.CylinderGeometry(0.22, 0.22, 1, 6, 1);
    core.rotateX(Math.PI / 2);
    const halo = new THREE.CylinderGeometry(0.7, 0.7, 1, 8, 1);
    halo.rotateX(Math.PI / 2);
    const make = (geo: THREE.BufferGeometry, color: THREE.Color, opacity: number) => {
      const mesh = new THREE.InstancedMesh(
        geo,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
        MAX,
      );
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
      return mesh;
    };
    this.meshes = {
      union: [make(core, new THREE.Color(1.5, 4, 9), 1), make(halo, new THREE.Color(0.2, 0.6, 2.2), 0.5)],
      raiders: [make(core, new THREE.Color(9, 2.2, 0.8), 1), make(halo, new THREE.Color(2.4, 0.4, 0.15), 0.5)],
    };
  }

  add(id: number, faction: FactionId, pos: [number, number, number], vel: [number, number, number], t0: number, life: number) {
    const list = this.bolts[faction];
    if (list.length >= MAX) list.shift();
    list.push({ id, p0: new THREE.Vector3(...pos), v: new THREE.Vector3(...vel), t0, life });
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

  update(time: number) {
    for (const f of ['union', 'raiders'] as FactionId[]) {
      const list = this.bolts[f];
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
        const len = Math.min(26, speed * Math.max(age, 0.004));
        this.dir.copy(b.v).divideScalar(speed);
        this.p.copy(b.p0).addScaledVector(b.v, age).addScaledVector(this.dir, -len / 2);
        this.q.setFromUnitVectors(this.fwd, this.dir);
        this.s.set(1, 1, len);
        this.m.compose(this.p, this.q, this.s);
        for (const mesh of this.meshes[f]) mesh.setMatrixAt(n, this.m);
        n++;
      }
      for (const mesh of this.meshes[f]) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }
}
