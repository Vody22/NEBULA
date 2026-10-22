import * as THREE from 'three';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../shared/rng';
import type { AsteroidDef } from '../../shared/sim/zone';
import { NOISE_GLSL } from './glsl';
import { makeCloudTexture } from './textures';

/**
 * Rock families, picked by the asteroid's variant (shared with the server,
 * visual only). Shapes stay within about 0.8–1.25 of the radius so the
 * collision sphere (0.85 × radius) keeps matching what the player sees.
 */
type Family = 'carbon' | 'rubble' | 'silicate' | 'metal';
const FAMILY: Family[] = ['carbon', 'rubble', 'silicate', 'metal'];

const PALETTE: Record<Family, { base: [number, number, number]; dust: [number, number, number]; vein?: [number, number, number] }> = {
  // Carbonaceous: dark, rounded. Rubble piles: the same matter, lumpy.
  carbon: { base: [0.085, 0.078, 0.072], dust: [0.16, 0.145, 0.13] },
  rubble: { base: [0.1, 0.09, 0.08], dust: [0.18, 0.16, 0.14] },
  // Silicate: grey-beige, angular, fractured.
  silicate: { base: [0.22, 0.2, 0.17], dust: [0.3, 0.28, 0.24] },
  // Metallic: dark steel with bright veins (future mining deposits).
  metal: { base: [0.13, 0.135, 0.145], dust: [0.2, 0.19, 0.18], vein: [0.55, 0.56, 0.6] },
};

function makeRockGeometry(family: Family, seed: number, detail: number, octaves: number) {
  const rand = mulberry32(seed);
  const noise = new SimplexNoise({ random: rand });
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = BufferGeometryUtils.mergeVertices(geo);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const pal = PALETTE[family];
  const stretch =
    family === 'silicate'
      ? new THREE.Vector3(0.8 + rand() * 0.3, 0.72 + rand() * 0.2, 0.9 + rand() * 0.3)
      : new THREE.Vector3(0.88 + rand() * 0.2, 0.84 + rand() * 0.16, 0.88 + rand() * 0.2);
  const craters: { c: THREE.Vector3; r: number }[] = [];
  const nCraters = family === 'silicate' ? 4 : family === 'metal' ? 5 : 11;
  for (let i = 0; i < nCraters; i++) {
    craters.push({ c: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), r: 0.12 + rand() * 0.32 });
  }
  // Silicate blocks: planar fractures give flat faces and sharp edges.
  const cuts: { n: THREE.Vector3; d: number }[] = [];
  if (family === 'silicate') {
    for (let i = 0; i < 9; i++) cuts.push({ n: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), d: 0.8 + rand() * 0.15 });
  }
  // Rubble piles: a few big lobes.
  const lobes: { c: THREE.Vector3; r: number }[] = [];
  if (family === 'rubble') {
    for (let i = 0; i < 5; i++) lobes.push({ c: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(), r: 0.5 + rand() * 0.4 });
  }
  const amp0 = family === 'carbon' ? 0.22 : family === 'metal' ? 0.18 : family === 'rubble' ? 0.16 : 0.12;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let h = 0;
    let amp = amp0;
    let f = 1.1;
    for (let o = 0; o < octaves; o++) {
      h += noise.noise3d(v.x * f + seed, v.y * f, v.z * f) * amp;
      f *= 2.1;
      amp *= 0.48;
    }
    for (const lb of lobes) {
      const d = v.distanceTo(lb.c);
      if (d < lb.r) h += (1 - (d / lb.r) ** 2) * 0.12;
    }
    let crater = 0;
    for (const cr of craters) {
      const d = v.distanceTo(cr.c);
      if (d < cr.r) {
        const t = d / cr.r;
        h -= (1 - t * t) * 0.1 * cr.r * 2;
        if (t > 0.75) h += (t - 0.75) * 0.14;
        crater = Math.max(crater, 1 - t);
      }
    }
    let r = 1 + h;
    for (const c of cuts) {
      const dn = v.dot(c.n);
      if (dn > 0.05) r = Math.min(r, c.d / dn);
    }
    r = Math.min(1.25, Math.max(0.8, r));
    v.multiplyScalar(r).multiply(stretch);
    pos.setXYZ(i, v.x, v.y, v.z);
    // Fine dust settles in hollows and craters; exposed relief stays darker.
    const hollow = Math.min(1, Math.max(0, -h * 4 + crater * 0.8));
    const grain = 0.9 + noise.noise3d(v.x * 7, v.y * 7, v.z * 7) * 0.1;
    let c0 = pal.base[0] + (pal.dust[0] - pal.base[0]) * hollow;
    let c1 = pal.base[1] + (pal.dust[1] - pal.base[1]) * hollow;
    let c2 = pal.base[2] + (pal.dust[2] - pal.base[2]) * hollow;
    if (pal.vein) {
      const vein = Math.pow(Math.max(0, 1 - Math.abs(noise.noise3d(v.x * 3.1 + 7, v.y * 3.1, v.z * 3.1))), 18);
      c0 += (pal.vein[0] - c0) * vein;
      c1 += (pal.vein[1] - c1) * vein;
      c2 += (pal.vein[2] - c2) * vein;
    }
    colors[i * 3] = c0 * grain;
    colors[i * 3 + 1] = c1 * grain;
    colors[i * 3 + 2] = c2 * grain;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Surface detail without textures: a small noise height field in object
 * space, turned into a bump through screen-space derivatives (one noise
 * evaluation per pixel). Scaled by each instance's size, so a 300 m block
 * and a 10 m rock both get relief at their own scale. Off on the Bas level.
 */
function addRockDetail(mat: THREE.MeshStandardMaterial, detail: { value: number }) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = detail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockPos;\nvarying float vRockScale;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRockPos = position;
#ifdef USE_INSTANCING
vRockScale = length(instanceMatrix[0].xyz);
#else
vRockScale = 1.0;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uDetail;
varying vec3 vRockPos;
varying float vRockScale;
${NOISE_GLSL}
float rockHeight(vec3 p){
  return snoise(p*4.0)*0.5 + snoise(p*9.5)*0.25 + snoise(p*23.0)*0.12;
}
vec3 rockBump(vec3 surf_pos, vec3 surf_norm, float h, float faceDir){
  vec3 dpx = dFdx(surf_pos);
  vec3 dpy = dFdy(surf_pos);
  vec3 sx = normalize(dpx);
  vec3 sy = normalize(dpy);
  // Height slope per meter along each screen axis.
  vec2 dH = vec2(dFdx(h) / max(length(dpx), 1e-4), dFdy(h) / max(length(dpy), 1e-4));
  vec3 r1 = cross(sy, surf_norm);
  vec3 r2 = cross(surf_norm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dH.x * r1 + dH.y * r2);
  return normalize(abs(det) * surf_norm - grad);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float rockH = 0.0;
if (uDetail > 0.5) {
  rockH = rockHeight(vRockPos);
  diffuseColor.rgb *= 0.86 + 0.28 * (rockH * 0.5 + 0.5);
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (uDetail > 0.5) normal = rockBump(-vViewPosition, normal, rockH * 0.035 * vRockScale, faceDirection);`,
      );
  };
}

/**
 * Asteroid belt: procedurally displaced rock meshes in four families,
 * instanced. Big rocks use a high-detail set so silhouettes hold up close.
 */
export class Asteroids {
  readonly group = new THREE.Group();
  private sets: { mesh: THREE.InstancedMesh; defs: AsteroidDef[] }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private detail = { value: 1 };

  constructor(defs: AsteroidDef[], beltCenter: THREE.Vector3) {
    const mats: Record<Family, THREE.MeshStandardMaterial> = {
      carbon: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.25 }),
      rubble: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.25 }),
      silicate: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02, envMapIntensity: 0.3 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.65, envMapIntensity: 0.7 }),
    };
    for (const m of Object.values(mats)) addRockDetail(m, this.detail);
    for (const big of [false, true]) {
      for (let v = 0; v < FAMILY.length; v++) {
        const list = defs.filter((d) => d.variant === v && d.radius >= 140 === big);
        if (!list.length) continue;
        const family = FAMILY[v];
        const geo = makeRockGeometry(family, 100 + v * 17 + (big ? 7 : 0), big ? 22 : 6, big ? 6 : 3);
        const mesh = new THREE.InstancedMesh(geo, mats[family], list.length);
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
          color: new THREE.Color().setHSL(0.08 + rand() * 0.05, 0.08, 0.32),
          transparent: true,
          opacity: 0.05 + rand() * 0.06,
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

  /** Per-pixel relief on (Moyen and above) or off (Bas). */
  setDetail(on: boolean) {
    this.detail.value = on ? 1 : 0;
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
