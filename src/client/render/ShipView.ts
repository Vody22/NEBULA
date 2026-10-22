import * as THREE from 'three';
import type { ShipClassId } from '../../shared/sim/types';
import { buildShipModel, type ShipModel } from './ShipModels';

const flameVert = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const flameFrag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
void main(){
  float along = clamp(1.0 - vUv.y, 0.0, 1.0); // 1 at nozzle, 0 at tip
  float around = vUv.x;
  float flick = 0.85 + 0.15*sin(uTime*60.0 + around*25.0) * sin(uTime*37.0);
  float core = pow(along, 2.5);
  float bands = 0.75 + 0.25*sin(along*40.0 - uTime*80.0);
  vec3 col = mix(uColor, uCore, core) * (core*1.6 + along*0.7) * bands * flick * uPower;
  gl_FragColor = vec4(col, 1.0);
}`;

const shieldVert = /* glsl */ `
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vView;
void main(){
  vLocal = normalize(position);
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position,1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const shieldFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uFlash;
uniform vec4 uHits[4];
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vView;
void main(){
  float fres = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vView))), 0.0, 1.0), 2.5);
  float hex = 0.6 + 0.4*sin(vLocal.x*40.0)*sin(vLocal.y*40.0)*sin(vLocal.z*40.0);
  float a = fres * uFlash * 0.9 * hex;
  for (int i=0;i<4;i++){
    float age = uTime - uHits[i].w;
    if (age < 0.0 || age > 0.8) continue;
    float d = acos(clamp(dot(vLocal, uHits[i].xyz), -1.0, 1.0));
    float rd = (d - age*3.2)*7.0;
    float ring = exp(-rd*rd) * (1.0 - age/0.8);
    float spot = exp(-d*d*18.0) * (1.0 - age/0.35) * step(age, 0.35);
    a += (ring*1.3 + spot*2.5) * hex;
  }
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

const TRAIL_POINTS = 44;

/** Camera-facing ribbon following a point (engine contrail). */
class Trail {
  readonly mesh: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private geo = new THREE.BufferGeometry();
  private positions = new Float32Array(TRAIL_POINTS * 2 * 3);
  private alphas = new Float32Array(TRAIL_POINTS * 2);
  private sampleIn = 0;

  constructor(color: THREE.Color, private width: number) {
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * viewMatrix * vec4(position,1.0);} `,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * vA, 1.0);} `,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
  }

  reset() {
    this.pts.length = 0;
  }

  update(head: THREE.Vector3, camPos: THREE.Vector3, dt: number, intensity: number) {
    this.sampleIn -= dt;
    if (this.sampleIn <= 0 || this.pts.length === 0) {
      this.sampleIn = 0.025;
      this.pts.unshift(head.clone());
      if (this.pts.length > TRAIL_POINTS) this.pts.pop();
    } else {
      this.pts[0].copy(head);
    }
    const n = this.pts.length;
    const side = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const p = this.pts[Math.min(i, n - 1)];
      const q = this.pts[Math.min(i + 1, n - 1)];
      dir.subVectors(p, q);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      toCam.subVectors(camPos, p);
      side.crossVectors(dir, toCam).normalize();
      const t = i / (TRAIL_POINTS - 1);
      const w = this.width * (1 - t * 0.6);
      side.multiplyScalar(w);
      this.positions.set([p.x + side.x, p.y + side.y, p.z + side.z, p.x - side.x, p.y - side.y, p.z - side.z], i * 6);
      const a = i < n ? (1 - t) * (1 - t) * intensity : 0;
      this.alphas[i * 2] = a;
      this.alphas[i * 2 + 1] = a;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

/** Visual representation of one ship entity. */
export class ShipView {
  readonly group = new THREE.Group();
  readonly model: ShipModel;
  private flames: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; radius: number }[] = [];
  private shield: THREE.Mesh;
  private shieldMat: THREE.ShaderMaterial;
  private hitIndex = 0;
  private flash = 0;
  private trail: Trail;
  private throttleVis = 0;
  readonly light: THREE.PointLight | null;

  constructor(readonly classId: ShipClassId, scene: THREE.Scene, private isLocal: boolean) {
    this.model = buildShipModel(classId);
    this.group.add(this.model.root);

    const flameGeo = new THREE.ConeGeometry(1, 1, 20, 1, true);
    flameGeo.translate(0, 0.5, 0);
    flameGeo.rotateX(Math.PI / 2); // base at the nozzle, tip toward +Z (behind the ship)
    for (const e of this.model.engines) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: flameVert,
        fragmentShader: flameFrag,
        uniforms: {
          uColor: { value: this.model.engineColor.clone() },
          uCore: { value: new THREE.Color(2, 2, 2) },
          uTime: { value: 0 },
          uPower: { value: 1 },
        },
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(flameGeo, mat);
      mesh.position.copy(e.pos);
      this.group.add(mesh);
      this.flames.push({ mesh, mat, radius: e.radius });
    }

    this.shieldMat = new THREE.ShaderMaterial({
      vertexShader: shieldVert,
      fragmentShader: shieldFrag,
      uniforms: {
        uColor: { value: classId === 'falcon' || classId === 'warden' ? new THREE.Color(0.4, 1.1, 2.6) : new THREE.Color(2.6, 0.8, 0.4) },
        uTime: { value: 0 },
        uFlash: { value: 0 },
        uHits: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 1, -10)) },
      },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.shieldMat);
    this.shield.scale.copy(this.model.shieldScale);
    this.group.add(this.shield);

    const trailColor = this.model.engineColor.clone().multiplyScalar(0.12);
    this.trail = new Trail(trailColor, this.model.shieldScale.x * 0.07);
    // The local pilot's own contrail would stream straight into the chase camera.
    this.trail.mesh.visible = !isLocal;
    scene.add(this.trail.mesh);

    this.light = isLocal ? new THREE.PointLight(this.model.engineColor.clone().multiplyScalar(0.25), 0, 60, 2) : null;
    if (this.light) {
      this.light.position.set(0, 0, 11);
      this.group.add(this.light);
    }
    scene.add(this.group);
  }

  /** Register a shield impact at a world position. */
  shieldHit(worldPos: THREE.Vector3, time: number) {
    const local = this.group.worldToLocal(worldPos.clone());
    local.divide(this.model.shieldScale).normalize();
    const slot = this.shieldMat.uniforms.uHits.value[this.hitIndex++ % 4] as THREE.Vector4;
    slot.set(local.x, local.y, local.z, time);
    this.flash = 1;
  }

  update(dt: number, time: number, throttle: number, boosting: boolean, camPos: THREE.Vector3) {
    const target = boosting ? 1.8 : Math.max(0.08, throttle);
    this.throttleVis += (target - this.throttleVis) * Math.min(1, dt * 6);
    const tv = this.throttleVis;
    for (const f of this.flames) {
      const len = f.radius * (2 + tv * 7 + (boosting ? 6 : 0));
      f.mesh.scale.set(f.radius * (0.75 + tv * 0.15), f.radius * (0.75 + tv * 0.15), len);
      f.mat.uniforms.uTime.value = time;
      f.mat.uniforms.uPower.value = 0.12 + tv * 0.7;
      (f.mat.uniforms.uColor.value as THREE.Color).copy(boosting ? this.model.boostColor : this.model.engineColor);
    }
    this.flash = Math.max(0, this.flash - dt * 2.5);
    this.shieldMat.uniforms.uTime.value = time;
    this.shieldMat.uniforms.uFlash.value = this.flash;
    this.shield.visible = this.flash > 0.001 || time - (this.shieldMat.uniforms.uHits.value as THREE.Vector4[]).reduce((m, h) => Math.max(m, h.w), -10) < 0.8;
    if (this.light) this.light.intensity = 40 + tv * 120;

    const tail = new THREE.Vector3(0, 0, this.model.shieldScale.z * 0.9).applyQuaternion(this.group.quaternion).add(this.group.position);
    if (!this.isLocal) this.trail.update(tail, camPos, dt, 0.5 + tv * 0.6);
  }

  teleported() {
    this.trail.reset();
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    scene.remove(this.trail.mesh);
    this.trail.mesh.geometry.dispose();
  }
}
