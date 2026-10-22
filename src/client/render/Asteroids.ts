import * as THREE from 'three';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../shared/rng';
import type { AsteroidDef } from '../../shared/sim/zone';
import { makeCloudTexture } from './textures';

function makeRockGeometry(seed: number, detail: number, octaves: number) {
  const rand = mulberry32(seed);
  const noise = new SimplexNoise({ random: rand });
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = BufferGeometryUtils.mergeVertices(geo);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const stretch = new THREE.Vector3(0.85 + rand() * 0.25, 0.8 + rand() * 0.2, 0.85 + rand() * 0.25);
  const craters: { c: THREE.Vector3; r: number }[] = [];
  for (let i = 0; i < 9; i++) {
    craters.push({ c: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), r: 0.15 + rand() * 0.35 });
  }
  const base = new THREE.Color().setHSL(0.07 + rand() * 0.04, 0.12 + rand() * 0.1, 0.15 + rand() * 0.06);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let h = 0;
    let amp = 0.35;
    let f = 1.1;
    for (let o = 0; o < octaves; o++) {
      h += noise.noise3d(v.x * f + seed, v.y * f, v.z * f) * amp;
      f *= 2.1;
      amp *= 0.48;
    }
    for (const cr of craters) {
      const d = v.distanceTo(cr.c);
      if (d < cr.r) {
        const t = d / cr.r;
        h -= (1 - t * t) * 0.12 * cr.r * 2;
        if (t > 0.75) h += (t - 0.75) * 0.15;
      }
    }
    const r = 1 + h;
    v.multiplyScalar(r).multiply(stretch);
    pos.setXYZ(i, v.x, v.y, v.z);
    const shade = 0.75 + h * 0.9 + noise.noise3d(v.x * 6, v.y * 6, v.z * 6) * 0.08;
    colors[i * 3] = base.r * shade;
    colors[i * 3 + 1] = base.g * shade;
    colors[i * 3 + 2] = base.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Asteroid belt: a few procedurally displaced rock meshes, instanced.
 * Big rocks use a high-detail set so silhouettes stay convincing up close.
 */
export class Asteroids {
  readonly group = new THREE.Group();
  private sets: { mesh: THREE.InstancedMesh; defs: AsteroidDef[] }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private axis = new THREE.Vector3();

  constructor(defs: AsteroidDef[], beltCenter: THREE.Vector3) {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.93,
      metalness: 0.05,
      envMapIntensity: 0.2,
    });
    const variants = 4;
    for (const big of [false, true]) {
      for (let v = 0; v < variants; v++) {
        const list = defs.filter((d) => d.variant === v && d.radius >= 140 === big);
        if (!list.length) continue;
        const geo = makeRockGeometry(100 + v * 17 + (big ? 7 : 0), big ? 18 : 6, big ? 6 : 3);
        const mesh = new THREE.InstancedMesh(geo, mat, list.length);
        mesh.frustumCulled = false;
        this.sets.push({ mesh, defs: list });
        this.group.add(mesh);
      }
    }
    this.update(0);

    // Faint dust clouds drifting inside the belt add depth and parallax.
    const dustTex = makeCloudTexture(5);
    const rand = mulberry32(99);
    for (let i = 0; i < 40; i++) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: dustTex,
          color: new THREE.Color().setHSL(0.55 + rand() * 0.35, 0.6, 0.5),
          transparent: true,
          opacity: 0.08 + rand() * 0.08,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          rotation: rand() * Math.PI * 2,
        }),
      );
      const a = rand() * Math.PI * 2;
      const r = rand() * 3200;
      sp.position.set(Math.cos(a) * r, (rand() - 0.5) * 600, Math.sin(a) * r * 0.75).add(beltCenter);
      sp.scale.setScalar(900 + rand() * 1800);
      this.group.add(sp);
    }
  }

  update(time: number) {
    for (const set of this.sets) {
      set.defs.forEach((d, i) => {
        this.axis.set(d.spinAxis[0], d.spinAxis[1], d.spinAxis[2]);
        this.q.setFromAxisAngle(this.axis, time * d.spinSpeed + d.variant);
        this.s.setScalar(d.radius);
        this.m.compose(d.position, this.q, this.s);
        set.mesh.setMatrixAt(i, this.m);
      });
      set.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
