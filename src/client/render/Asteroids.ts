import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BIG_ROCK, ROCK_FAMILIES, rockShape, type RockFamily, type RockRelief, type RockShape } from '../../shared/physics/rocks';
import { mulberry32 } from '../../shared/rng';
import type { AsteroidDef } from '../../shared/sim/zone';
import { GlowField } from './batches';
import { NOISE_GLSL } from './glsl';
import { makeCloudTexture } from './textures';

/**
 * Rock families, picked by the asteroid's variant. The shapes come from
 * shared/physics/rocks.ts, where the physics reads the same surface: what a
 * ship hits is the rock drawn here.
 */
const PALETTE: Record<RockFamily, { base: [number, number, number]; dust: [number, number, number]; vein?: [number, number, number] }> = {
  // Carbonaceous: dark, rounded. Rubble piles: the same matter, lumpy.
  carbon: { base: [0.085, 0.078, 0.072], dust: [0.16, 0.145, 0.13] },
  rubble: { base: [0.1, 0.09, 0.08], dust: [0.18, 0.16, 0.14] },
  // Silicate: grey-beige, angular, fractured.
  silicate: { base: [0.22, 0.2, 0.17], dust: [0.3, 0.28, 0.24] },
  // Metallic: dark steel with bright veins (future mining deposits).
  metal: { base: [0.13, 0.135, 0.145], dust: [0.2, 0.19, 0.18], vein: [0.55, 0.56, 0.6] },
};

function makeRockGeometry(shape: RockShape, detail: number) {
  const noise = shape.noise;
  let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = BufferGeometryUtils.mergeVertices(geo);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const pal = PALETTE[shape.family];
  const relief: RockRelief = { r: 1, h: 0, crater: 0 };
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const { r, h, crater } = shape.relief(v, relief);
    v.multiplyScalar(r).multiply(shape.stretch);
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
    const mats: Record<RockFamily, THREE.MeshStandardMaterial> = {
      carbon: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.25 }),
      rubble: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.25 }),
      silicate: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02, envMapIntensity: 0.3 }),
      metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.65, envMapIntensity: 0.7 }),
    };
    for (const m of Object.values(mats)) addRockDetail(m, this.detail);
    for (const big of [false, true]) {
      for (let v = 0; v < ROCK_FAMILIES.length; v++) {
        const list = defs.filter((d) => d.variant === v && d.radius >= BIG_ROCK === big);
        if (!list.length) continue;
        const shape = rockShape(v, big);
        const geo = makeRockGeometry(shape, big ? 22 : 6);
        const mesh = new THREE.InstancedMesh(geo, mats[shape.family], list.length);
        mesh.frustumCulled = false;
        this.sets.push({ mesh, defs: list });
        this.group.add(mesh);
      }
    }
    this.update(0);

    // Faint dust clouds drifting inside the belt add depth and parallax.
    const dustTex = makeCloudTexture(5);
    // All of them in one draw call.
    const rand = mulberry32(99);
    const dust = new GlowField(dustTex, { toneMapped: true });
    const color = new THREE.Color();
    const pos = new THREE.Vector3();
    for (let i = 0; i < 40; i++) {
      color.setHSL(0.08 + rand() * 0.05, 0.08, 0.32);
      const opacity = 0.05 + rand() * 0.06;
      const rotation = rand() * Math.PI * 2;
      const a = rand() * Math.PI * 2;
      const r = rand() * 3200;
      pos.set(Math.cos(a) * r, (rand() - 0.5) * 600, Math.sin(a) * r * 0.75).add(beltCenter);
      const g = dust.add(this.group, color, 900 + rand() * 1800, pos);
      g.opacity = opacity;
      g.rotation = rotation;
    }
    this.group.add(dust.mesh);
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
