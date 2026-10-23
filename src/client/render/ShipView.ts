import * as THREE from 'three';
import type { ShipClassId } from '../../shared/sim/types';
import { FlameField, GlowField, type Flame, type Glow } from './batches';
import { buildShipModel, type ShipModel } from './ShipModels';
import { makeRadialTexture } from './textures';

let _glint: THREE.Texture | null = null;
const glint = () =>
  (_glint ??= makeRadialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.2, 'rgba(255,255,255,0.6)'],
    [1, 'rgba(255,255,255,0)'],
  ]));
const _torque = new THREE.Vector3();
const _w = new THREE.Vector3();
const _ray = new THREE.Raycaster();
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _n = new THREE.Matrix3();

/** Glowing weld of molten metal left by a hull hit: white, orange, red, then dark. */
const SCORCH_LIFE = 2.6;
const _hot = new THREE.Color(4, 3, 1.6);
const _warm = new THREE.Color(2.2, 0.6, 0.1);
const _cold = new THREE.Color(0.35, 0.04, 0);
function scorchColor(t: number, out: THREE.Color) {
  return t < 0.15 ? out.copy(_hot).lerp(_warm, t / 0.15) : out.copy(_warm).lerp(_cold, (t - 0.15) / 0.85);
}

// Every engine flame of every ship in the scene is one instance of the same
// cone: colour and power come per instance, the time is shared.
const flameVert = /* glsl */ `
attribute vec3 aColor;
attribute float aPower;
varying vec2 vUv;
varying vec3 vColor;
varying float vPower;
void main(){
  vUv = uv;
  vColor = aColor;
  vPower = aPower;
  vec4 p = vec4(position, 1.0);
  #ifdef USE_INSTANCING
  p = instanceMatrix * p;
  #endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}`;
const flameFrag = /* glsl */ `
uniform vec3 uCore;
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vPower;
void main(){
  float along = clamp(1.0 - vUv.y, 0.0, 1.0); // 1 at nozzle, 0 at tip
  float around = vUv.x;
  float flick = 0.85 + 0.15*sin(uTime*60.0 + around*25.0) * sin(uTime*37.0);
  float core = pow(along, 2.5);
  float bands = 0.75 + 0.25*sin(along*40.0 - uTime*80.0);
  vec3 col = mix(vColor, uCore, core) * (core*1.6 + along*0.7) * bands * flick * vPower;
  gl_FragColor = vec4(col, 1.0);
}`;

/** The glow points and engine flames of all the ships of one scene, a draw call each. */
interface ShipBatches {
  glows: GlowField;
  flames: FlameField;
  time: { value: number };
}
const batchesOf = new WeakMap<THREE.Scene, ShipBatches>();
function shipBatches(scene: THREE.Scene): ShipBatches {
  let b = batchesOf.get(scene);
  if (!b) {
    const geo = new THREE.ConeGeometry(1, 1, 20, 1, true);
    geo.translate(0, 0.5, 0);
    geo.rotateX(Math.PI / 2); // base at the nozzle, tip toward +Z (behind the ship)
    const time = { value: 0 };
    const mat = new THREE.ShaderMaterial({
      vertexShader: flameVert,
      fragmentShader: flameFrag,
      uniforms: { uCore: { value: new THREE.Color(2, 2, 2) }, uTime: time },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    });
    b = { glows: new GlowField(glint()), flames: new FlameField(geo, mat), time };
    scene.add(b.glows.mesh, b.flames.mesh);
    batchesOf.set(scene, b);
  }
  return b;
}

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
  // Fine cells, drawn as thin bright lines only where the field is excited.
  float cells = abs(sin(vLocal.x*46.0)*sin(vLocal.y*46.0)*sin(vLocal.z*46.0));
  float lines = 0.35 + 0.65 * smoothstep(0.55, 0.0, cells);
  // At rest the field is a faint film on the rim, almost invisible.
  vec3 col = uColor * fres * uFlash * 0.03;
  for (int i=0;i<4;i++){
    float age = uTime - uHits[i].w;
    if (age < 0.0 || age > 0.8) continue;
    float fade = 1.0 - age/0.8;
    float d = acos(clamp(dot(vLocal, uHits[i].xyz), -1.0, 1.0));
    // The impact excites the field around it, a ripple runs outward and dies.
    float near = exp(-d*d*14.0);
    float rd = (d - age*1.2)*12.0;
    float ring = exp(-rd*rd) * fade * near;
    float glow = near * fade * fade * (0.25 + fres);
    float spot = exp(-d*d*150.0) * max(0.0, 1.0 - age/0.2);
    col += uColor * (ring*1.4 + glow*0.5) * lines + vec3(1.0) * spot * 1.2;
  }
  gl_FragColor = vec4(col, 1.0);
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
  private batches: ShipBatches;
  private flames: { flame: Flame; radius: number }[] = [];
  /** Every glow point of this ship, to take out of the scene's field on dispose. */
  private glows: Glow[] = [];
  private shield: THREE.Mesh;
  private shieldMat: THREE.ShaderMaterial;
  private hitIndex = 0;
  private flash = 0;
  private trail: Trail;
  private throttleVis = 0;
  private strobes: Glow[] = [];
  private strobePhase = Math.random() * 1.4;
  /** RCS puffs and the axis each one turns the ship around (unit torque). */
  private rcs: { glow: Glow; torque: THREE.Vector3; level: number }[] = [];
  readonly light: THREE.PointLight | null;
  private scorches: { glow: Glow; age: number }[] = [];
  private scorchIndex = 0;
  /** Fires on a badly damaged hull, at points found on the surface once. */
  private fires: Glow[] = [];
  private damage = 0;
  /** The hull's meshes, for placing marks. */
  private hullMeshes: THREE.Object3D[] | null = null;

  constructor(readonly classId: ShipClassId, scene: THREE.Scene, private isLocal: boolean) {
    this.model = buildShipModel(classId);
    this.group.add(this.model.root);
    this.batches = shipBatches(scene);
    for (const n of this.model.navs ?? []) this.glow(n.color, n.size, n.pos);
    // The pilot's own strobes and thrusters would flicker right in front of the
    // chase camera: only other ships show them.
    for (const st of isLocal ? [] : this.model.strobes ?? []) {
      const g = this.glow(st.color, 1.1, st.pos);
      g.visible = false;
      this.strobes.push(g);
    }
    for (const r of isLocal ? [] : this.model.rcs ?? []) {
      const glow = this.glow(new THREE.Color(1.6, 1.8, 2.2), 0.6, r.pos.clone().addScaledVector(r.dir, 0.25));
      glow.visible = false;
      // Thrust pushes against the exhaust: torque = r × (−dir).
      const torque = new THREE.Vector3().crossVectors(r.pos, r.dir).negate().normalize();
      this.rcs.push({ glow, torque, level: 0 });
    }
    for (const e of this.model.engines) {
      const flame = this.batches.flames.add(this.group, e.pos);
      flame.color.copy(this.model.engineColor);
      this.flames.push({ flame, radius: e.radius });
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

  private glow(color: THREE.Color, size: number, pos: THREE.Vector3) {
    const g = this.batches.glows.add(this.group, color, size, pos);
    this.glows.push(g);
    return g;
  }

  /**
   * Where a ray from `worldPos` toward the ship's centre meets the hull, in
   * local coordinates, lifted a little off the surface. Null if it misses.
   */
  private hullPoint(worldPos: THREE.Vector3): THREE.Vector3 | null {
    this.group.updateMatrixWorld();
    _from.copy(worldPos);
    _dir.copy(this.group.position).sub(_from);
    const dist = _dir.length();
    if (dist < 1e-3) return null;
    // Start outside the shield so the ray always meets the outer skin first.
    _from.addScaledVector(_dir.normalize(), -this.model.shieldScale.z);
    _ray.set(_from, _dir);
    _ray.far = dist + this.model.shieldScale.z * 2;
    if (!this.hullMeshes) {
      const meshes: THREE.Object3D[] = [];
      this.model.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o);
      });
      this.hullMeshes = meshes;
    }
    const hit = _ray.intersectObjects(this.hullMeshes, false)[0];
    if (!hit) return null;
    const p = hit.point.clone();
    if (hit.face) p.addScaledVector(hit.face.normal.clone().applyMatrix3(_n.getNormalMatrix(hit.object.matrixWorld)).normalize(), 0.08);
    return this.group.worldToLocal(p);
  }

  /** A hull hit leaves a glowing mark on the ship that cools in a few seconds. */
  hullHit(worldPos: THREE.Vector3) {
    const local = this.hullPoint(worldPos);
    if (!local) return;
    let slot = this.scorches[this.scorchIndex++ % 6];
    if (!slot) {
      slot = { glow: this.glow(new THREE.Color(), 1, local), age: SCORCH_LIFE };
      this.scorches.push(slot);
    }
    slot.glow.position.copy(local);
    slot.age = 0;
  }

  /** 0 = intact, 1 = about to break up: fires break out on the hull below half. */
  setDamage(level: number) {
    this.damage = level;
    const want = level > 0.5 ? Math.min(4, Math.ceil((level - 0.5) * 8)) : 0;
    while (this.fires.length < want) {
      // A random point on the hull, found by casting toward the centre.
      const dir = new THREE.Vector3(Math.random() - 0.5, (Math.random() - 0.5) * 0.6, Math.random() - 0.5).normalize();
      const from = dir.multiplyScalar(this.model.shieldScale.z * 2).applyQuaternion(this.group.quaternion).add(this.group.position);
      const p = this.hullPoint(from) ?? new THREE.Vector3((Math.random() - 0.5) * 3, 0.5, Math.random() * 4);
      this.fires.push(this.glow(new THREE.Color(3, 1.1, 0.25), 1.4, p));
    }
    for (let i = 0; i < this.fires.length; i++) this.fires[i].visible = i < want;
  }

  /** Register a shield impact at a world position. */
  shieldHit(worldPos: THREE.Vector3, time: number) {
    const local = this.group.worldToLocal(worldPos.clone());
    local.divide(this.model.shieldScale).normalize();
    const slot = this.shieldMat.uniforms.uHits.value[this.hitIndex++ % 4] as THREE.Vector4;
    slot.set(local.x, local.y, local.z, time);
    this.flash = 1;
  }

  /** `angular`: local angular velocity (pitch, yaw, roll axes), rad/s, from the snapshot. */
  update(dt: number, time: number, throttle: number, boosting: boolean, camPos: THREE.Vector3, angular?: ArrayLike<number>) {
    const target = boosting ? 1.8 : Math.max(0.08, throttle);
    this.throttleVis += (target - this.throttleVis) * Math.min(1, dt * 6);
    const tv = this.throttleVis;
    this.batches.time.value = time;
    for (const { flame, radius } of this.flames) {
      const len = radius * (2 + tv * 7 + (boosting ? 6 : 0));
      flame.scale.set(radius * (0.75 + tv * 0.15), radius * (0.75 + tv * 0.15), len);
      flame.power = 0.12 + tv * 0.7;
      flame.color.copy(boosting ? this.model.boostColor : this.model.engineColor);
    }
    this.flash = Math.max(0, this.flash - dt * 2.5);
    this.shieldMat.uniforms.uTime.value = time;
    this.shieldMat.uniforms.uFlash.value = this.flash;
    this.shield.visible = this.flash > 0.001 || time - (this.shieldMat.uniforms.uHits.value as THREE.Vector4[]).reduce((m, h) => Math.max(m, h.w), -10) < 0.8;
    if (this.light) this.light.intensity = 40 + tv * 120;
    for (const sc of this.scorches) {
      sc.age += dt;
      const t = sc.age / SCORCH_LIFE;
      sc.glow.visible = t < 1;
      if (t < 1) {
        scorchColor(t, sc.glow.color);
        sc.glow.size = 1.4 - 0.6 * t;
      }
    }
    for (let i = 0; i < this.fires.length; i++) {
      const f = this.fires[i];
      if (!f.visible) continue;
      // Ragged flicker, different for each fire.
      const k = 0.6 + 0.25 * Math.sin(time * 23 + i * 7) + 0.15 * Math.sin(time * 41 + i * 3);
      f.size = (1 + this.damage) * k;
      f.opacity = 0.7 + 0.3 * k;
    }

    // Anti-collision: a double flash every 1.4 s.
    if (this.strobes.length) {
      const t = (time + this.strobePhase) % 1.4;
      const on = t < 0.05 || (t > 0.15 && t < 0.2);
      for (const g of this.strobes) g.visible = on;
    }
    // Manoeuvring thrusters fire on the side that drives the current rotation.
    if (this.rcs.length) {
      if (angular) _w.set(angular[0], angular[1], angular[2]);
      else _w.set(0, 0, 0);
      for (const r of this.rcs) {
        const drive = _torque.copy(r.torque).dot(_w);
        const target = Math.min(1, Math.max(0, (drive - 0.25) * 1.6));
        r.level += (target - r.level) * Math.min(1, dt * 6);
        r.glow.visible = r.level > 0.05;
        if (r.glow.visible) {
          r.glow.size = 0.35 + r.level * 0.8;
          r.glow.opacity = r.level;
        }
      }
    }

    const tail = new THREE.Vector3(0, 0, this.model.shieldScale.z * 0.9).applyQuaternion(this.group.quaternion).add(this.group.position);
    if (!this.isLocal) this.trail.update(tail, camPos, dt, 0.5 + tv * 0.6);
  }

  teleported() {
    this.trail.reset();
  }

  /** Hides or shows the ship and its contrail (destroyed, waiting to respawn). */
  setVisible(on: boolean) {
    this.group.visible = on;
    this.trail.mesh.visible = on && !this.isLocal;
    if (on) this.trail.reset();
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
    for (const g of this.glows) this.batches.glows.remove(g);
    for (const { flame } of this.flames) this.batches.flames.remove(flame);
    scene.remove(this.trail.mesh);
    this.trail.mesh.geometry.dispose();
  }
}
