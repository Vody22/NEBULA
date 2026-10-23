import * as THREE from 'three';
import { makeRadialTexture } from './textures';

const pointVert = /* glsl */ `
attribute float size;
attribute vec4 color4;
uniform float uScale;
varying vec4 vColor;
void main(){
  vColor = color4;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * uScale / max(-mv.z, 0.1);
  gl_Position = projectionMatrix * mv;
}`;
const pointFragAdd = /* glsl */ `
uniform sampler2D uMap;
varying vec4 vColor;
void main(){
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor.rgb * t.a * vColor.a, 1.0);
}`;
const pointFragAlpha = /* glsl */ `
uniform sampler2D uMap;
varying vec4 vColor;
void main(){
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

interface Particle {
  alive: boolean;
  p: THREE.Vector3;
  v: THREE.Vector3;
  c0: THREE.Color;
  c1: THREE.Color;
  size0: number;
  size1: number;
  life: number;
  age: number;
  drag: number;
  alpha: number;
}

/** CPU-simulated particle pool rendered as one draw call. */
class ParticlePool {
  readonly points: THREE.Points;
  private parts: Particle[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private cursor = 0;
  readonly material: THREE.ShaderMaterial;

  constructor(private max: number, additive: boolean, map: THREE.Texture) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    for (let i = 0; i < max; i++) {
      this.parts.push({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), c0: new THREE.Color(), c1: new THREE.Color(), size0: 1, size1: 1, life: 1, age: 0, drag: 0, alpha: 1 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color4', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: pointVert,
      fragmentShader: additive ? pointFragAdd : pointFragAlpha,
      uniforms: { uMap: { value: map }, uScale: { value: 600 } },
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  /** `delay` (s) holds the particle back, invisible, before it starts. */
  emit(p: THREE.Vector3, v: THREE.Vector3, c0: THREE.Color, c1: THREE.Color, size0: number, size1: number, life: number, drag = 0, alpha = 1, delay = 0) {
    const part = this.parts[this.cursor];
    this.cursor = (this.cursor + 1) % this.max;
    part.alive = true;
    part.p.copy(p);
    part.v.copy(v);
    part.c0.copy(c0);
    part.c1.copy(c1);
    part.size0 = size0;
    part.size1 = size1;
    part.life = life;
    part.age = -delay;
    part.drag = drag;
    part.alpha = alpha;
  }

  update(dt: number) {
    const c = new THREE.Color();
    for (let i = 0; i < this.max; i++) {
      const part = this.parts[i];
      if (part.alive) {
        part.age += dt;
        if (part.age >= part.life) part.alive = false;
      }
      if (!part.alive || part.age < 0) {
        this.size[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      const t = part.age / part.life;
      if (part.drag) part.v.multiplyScalar(Math.exp(-part.drag * dt));
      part.p.addScaledVector(part.v, dt);
      this.pos[i * 3] = part.p.x;
      this.pos[i * 3 + 1] = part.p.y;
      this.pos[i * 3 + 2] = part.p.z;
      c.copy(part.c0).lerp(part.c1, t);
      this.col[i * 4] = c.r;
      this.col[i * 4 + 1] = c.g;
      this.col[i * 4 + 2] = c.b;
      this.col[i * 4 + 3] = part.alpha * (1 - t) * Math.min(1, t * 12 + 0.2);
      this.size[i] = part.size0 + (part.size1 - part.size0) * t;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color4.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
  }
}

interface Debris {
  mesh: THREE.Mesh;
  v: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  life: number;
  /** Seconds it keeps burning (ember and smoke trail). */
  burn: number;
  emitAcc: number;
}

interface Pending {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  scale: number;
  delay: number;
}

const _lightColor = new THREE.Color();
const rnd = () => Math.random() * 2 - 1;
const randDir = (out: THREE.Vector3) => {
  do out.set(rnd(), rnd(), rnd());
  while (out.lengthSq() > 1 || out.lengthSq() < 0.01);
  return out.normalize();
};

/** Explosions, sparks, muzzle flashes, impacts, smoke, burning debris and flash lights. */
export class Effects {
  readonly group = new THREE.Group();
  private glow: ParticlePool;
  private smoke: ParticlePool;
  private debris: Debris[] = [];
  private pending: Pending[] = [];
  /** Lights 0-2 flash for explosions and hits, light 3 for the player's own guns. */
  private lights: { light: THREE.PointLight; age: number; life: number; peak: number }[] = [];
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();
  private debrisMat: THREE.MeshStandardMaterial;
  private debrisGeos: THREE.BufferGeometry[];
  private warm: THREE.Mesh | null = null;
  /** Particle count multiplier (graphics quality). */
  density = 1;

  constructor() {
    const soft = makeRadialTexture([
      [0, 'rgba(255,255,255,1)'],
      [0.25, 'rgba(255,255,255,0.7)'],
      [0.6, 'rgba(255,255,255,0.15)'],
      [1, 'rgba(255,255,255,0)'],
    ], 128);
    const puff = makeRadialTexture([
      [0, 'rgba(255,255,255,0.9)'],
      [0.5, 'rgba(255,255,255,0.4)'],
      [1, 'rgba(255,255,255,0)'],
    ], 128);
    this.glow = new ParticlePool(6000, true, soft);
    this.smoke = new ParticlePool(1800, false, puff);
    this.group.add(this.smoke.points, this.glow.points);

    // Torn hull plates and structural chunks.
    this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x8a8580, metalness: 0.7, roughness: 0.5, emissive: new THREE.Color(0.25, 0.07, 0.015) });
    this.debrisGeos = [
      new THREE.BoxGeometry(1, 0.12, 1.3),
      new THREE.BoxGeometry(0.6, 0.6, 1.6),
      new THREE.TetrahedronGeometry(0.8),
      new THREE.CylinderGeometry(0.25, 0.35, 1.8, 6),
    ];
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffaa66, 0, 900, 1.6);
      this.group.add(light);
      this.lights.push({ light, age: 1, life: 1, peak: 0 });
    }
  }

  /**
   * Debris only exists during explosions: while `on`, a hidden piece sits in
   * the scene so the renderer can compile its shader ahead of the first kill.
   */
  warmUp(on: boolean) {
    if (on && !this.warm) {
      this.warm = new THREE.Mesh(this.debrisGeos[0], this.debrisMat);
      this.warm.scale.setScalar(1e-4);
      this.group.add(this.warm);
    } else if (!on && this.warm) {
      this.group.remove(this.warm);
      this.warm = null;
    }
  }

  setPixelScale(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.glow.material.uniforms.uScale.value = s;
    this.smoke.material.uniforms.uScale.value = s;
  }

  private flashLight(pos: THREE.Vector3, peak: number, life: number, color: THREE.Color, distance = 900, slot?: number) {
    const l = slot !== undefined ? this.lights[slot] : this.lights.slice(0, 3).reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    l.light.position.copy(pos);
    l.light.color.copy(color);
    l.light.distance = distance;
    l.age = 0;
    l.life = life;
    l.peak = peak;
  }

  /**
   * A ship blowing up: white flash, a fireball that cools from yellow to deep
   * red, one or two secondary blasts, torn plates trailing embers and smoke,
   * and a dust cloud that lingers for several seconds.
   */
  explosion(pos: THREE.Vector3, scale: number, vel = new THREE.Vector3()) {
    const n = this.density;
    // Flash: blinding for a few frames, then the light it casts fades.
    this.glow.emit(pos, vel, new THREE.Color(6, 5, 4), new THREE.Color(1.5, 0.6, 0.2), 30 * scale, 90 * scale, 0.16);
    this.glow.emit(pos, vel, new THREE.Color(3, 2.4, 1.6), new THREE.Color(0.6, 0.2, 0.05), 14 * scale, 50 * scale, 0.45);
    this.fireball(pos, vel, scale);
    // Sparks: hot metal flung out fast.
    const spark = new THREE.Color(6, 3.4, 1.2);
    const sparkEnd = new THREE.Color(1.2, 0.2, 0);
    for (let i = 0; i < 80 * scale * n; i++) {
      randDir(this.d);
      this.v.copy(this.d).multiplyScalar(120 + Math.random() * 300).add(vel);
      this.glow.emit(pos, this.v, spark, sparkEnd, 1.3, 0.5, 0.5 + Math.random() * 1.4, 0.5);
    }
    // Secondary blasts as fuel and ammunition go up.
    const extra = 1 + Math.floor(Math.random() * 2 + (scale > 1.4 ? 2 : 0));
    for (let k = 0; k < extra; k++) {
      this.pending.push({
        pos: pos.clone().add(randDir(new THREE.Vector3()).multiplyScalar((3 + Math.random() * 6) * scale)),
        vel: vel.clone(),
        scale: scale * (0.45 + Math.random() * 0.3),
        delay: 0.12 + k * 0.17 + Math.random() * 0.1,
      });
    }
    // Torn plates and chunks, some still burning.
    for (let i = 0; i < Math.max(4, 14 * scale * n); i++) {
      const s = (0.5 + Math.random() * 2) * Math.min(scale, 1.6);
      const mesh = new THREE.Mesh(this.debrisGeos[i % this.debrisGeos.length], this.debrisMat);
      mesh.scale.setScalar(s);
      mesh.position.copy(pos);
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.group.add(mesh);
      this.debris.push({
        mesh,
        v: randDir(new THREE.Vector3()).multiplyScalar(20 + Math.random() * 80).add(vel.clone().multiplyScalar(0.6)),
        spin: new THREE.Vector3(rnd(), rnd(), rnd()).multiplyScalar(4),
        age: 0,
        life: 5 + Math.random() * 4,
        burn: Math.random() < 0.6 ? 0.8 + Math.random() * 1.8 : 0,
        emitAcc: 0,
      });
    }
    // Dust and smoke: grey-brown, faintly lit, drifting apart for seconds.
    for (let i = 0; i < 34 * scale * n; i++) {
      randDir(this.d);
      this.v.copy(this.d).multiplyScalar((5 + Math.random() * 22) * scale).add(vel.clone().multiplyScalar(0.3));
      const c0 = new THREE.Color(0.32, 0.27, 0.23);
      this.smoke.emit(pos, this.v, c0, new THREE.Color(0.1, 0.1, 0.11), 10 * scale, (40 + Math.random() * 30) * scale, 4 + Math.random() * 4, 0.35, 0.55, 0.08 + Math.random() * 0.25);
    }
    this.flashLight(pos, 4e4 * scale, 1.1, new THREE.Color(1, 0.62, 0.32), 900 * Math.sqrt(scale));
  }

  /** Billowing fire: overlapping puffs that grow and cool from yellow to red. */
  private fireball(pos: THREE.Vector3, vel: THREE.Vector3, scale: number) {
    const n = this.density;
    const hot = new THREE.Color(3.2, 2.2, 1.1);
    const orange = new THREE.Color(2.2, 0.85, 0.2);
    const ember = new THREE.Color(0.4, 0.06, 0.01);
    // Many overlapping puffs with a dense core, so it reads as one billowing
    // mass rather than separate balls.
    for (let i = 0; i < 110 * scale * n + 10; i++) {
      randDir(this.d);
      const r = Math.pow(Math.random(), 0.8);
      this.v.copy(this.d).multiplyScalar((6 + r * 42) * scale).add(vel.clone().multiplyScalar(0.5));
      const p = this.d.clone().multiplyScalar(r * 4 * scale).add(pos);
      const life = 0.7 + Math.random() * 1.1 * (1.2 - r * 0.5);
      this.glow.emit(p, this.v, i % 3 ? orange : hot, ember, (4 + Math.random() * 5) * scale, (12 + Math.random() * 14) * scale, life, 2.2, 0.7, Math.random() * 0.1);
    }
  }

  shieldSparks(pos: THREE.Vector3, color: THREE.Color) {
    for (let i = 0; i < 10; i++) {
      randDir(this.d);
      this.v.copy(this.d).multiplyScalar(30 + Math.random() * 60);
      this.glow.emit(pos, this.v, color, new THREE.Color(0, 0, 0), 1.6, 0.4, 0.25 + Math.random() * 0.25, 2);
    }
    this.glow.emit(pos, this.v.set(0, 0, 0), color.clone().multiplyScalar(1.5), new THREE.Color(0, 0, 0), 6, 14, 0.18);
  }

  hullHit(pos: THREE.Vector3) {
    const hot = new THREE.Color(7, 4, 1.5);
    for (let i = 0; i < 16; i++) {
      randDir(this.d);
      this.v.copy(this.d).multiplyScalar(40 + Math.random() * 120);
      this.glow.emit(pos, this.v, hot, new THREE.Color(1, 0.2, 0), 1.0, 0.4, 0.3 + Math.random() * 0.5, 1);
    }
    this.glow.emit(pos, this.v.set(0, 0, 0), new THREE.Color(5, 2.5, 1), new THREE.Color(0.5, 0.1, 0), 5, 12, 0.25);
    this.smoke.emit(pos, this.v.set(rnd(), rnd(), rnd()).multiplyScalar(5), new THREE.Color(0.15, 0.13, 0.12), new THREE.Color(0.06, 0.06, 0.06), 3, 14, 1.2, 0.5, 0.5);
  }

  impact(pos: THREE.Vector3, color: THREE.Color) {
    for (let i = 0; i < 8; i++) {
      randDir(this.d);
      this.v.copy(this.d).multiplyScalar(20 + Math.random() * 50);
      this.glow.emit(pos, this.v, color, new THREE.Color(0, 0, 0), 1.2, 0.3, 0.3, 2);
    }
    this.smoke.emit(pos, this.v.set(rnd(), rnd(), rnd()).multiplyScalar(4), new THREE.Color(0.35, 0.3, 0.27), new THREE.Color(0.2, 0.18, 0.16), 4, 18, 1.5, 0.4, 0.35);
  }

  /** `light`: the player's own guns light up the hull around the muzzle. */
  muzzle(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color, light = false) {
    this.glow.emit(pos, vel, new THREE.Color(5, 5, 5), color, 2.2, 0.8, 0.05);
    this.glow.emit(pos, vel, color, new THREE.Color(0, 0, 0), 5, 2, 0.08);
    if (light) this.flashLight(pos, 600, 0.07, _lightColor.copy(color).multiplyScalar(1 / Math.max(color.r, color.g, color.b)), 40, 3);
  }

  /** Damaged ships trail smoke and embers. */
  damageTrail(pos: THREE.Vector3, vel: THREE.Vector3, severity: number) {
    if (Math.random() < severity) {
      this.v.copy(vel).multiplyScalar(0.2).add(this.d.set(rnd(), rnd(), rnd()).multiplyScalar(4));
      this.smoke.emit(pos, this.v, new THREE.Color(0.1, 0.09, 0.08), new THREE.Color(0.04, 0.04, 0.05), 2.5, 12, 1.6, 0.3, 0.6);
    }
    if (Math.random() < severity * 0.6) {
      this.v.copy(vel).multiplyScalar(0.3).add(this.d.set(rnd(), rnd(), rnd()).multiplyScalar(10));
      this.glow.emit(pos, this.v, new THREE.Color(5, 1.6, 0.3), new THREE.Color(0.4, 0.05, 0), 1.2, 0.3, 0.5, 0.5);
    }
  }

  update(dt: number) {
    // Secondary blasts whose time has come.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const b = this.pending[i];
      b.delay -= dt;
      if (b.delay > 0) continue;
      this.pending.splice(i, 1);
      this.glow.emit(b.pos, b.vel, new THREE.Color(4, 3, 2), new THREE.Color(0.8, 0.25, 0.05), 12 * b.scale, 40 * b.scale, 0.22);
      this.fireball(b.pos, b.vel, b.scale);
      this.flashLight(b.pos, 1.5e4 * b.scale, 0.5, new THREE.Color(1, 0.55, 0.25));
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age > d.life) {
        this.group.remove(d.mesh);
        this.debris.splice(i, 1);
        continue;
      }
      d.mesh.position.addScaledVector(d.v, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      if (d.age > d.life - 0.6) d.mesh.scale.multiplyScalar(Math.max(0, 1 - dt / Math.max(0.01, d.life - d.age)));
      // Burning pieces trail embers and a thin smoke line while they cool.
      if (d.age < d.burn) {
        const heat = 1 - d.age / d.burn;
        d.emitAcc += dt * 60 * this.density;
        while (d.emitAcc >= 1) {
          d.emitAcc--;
          this.v.copy(d.v).multiplyScalar(0.15).add(this.d.set(rnd(), rnd(), rnd()).multiplyScalar(2));
          this.glow.emit(d.mesh.position, this.v, new THREE.Color(4 * heat + 0.6, 1.6 * heat + 0.15, 0.3 * heat), new THREE.Color(0.3, 0.03, 0), 1.8 * heat + 0.5, 0.3, 0.35 + 0.3 * heat, 0.5);
          if (Math.random() < 0.3) {
            this.smoke.emit(d.mesh.position, this.v, new THREE.Color(0.22, 0.2, 0.18), new THREE.Color(0.08, 0.08, 0.09), 1.2, 6, 1.5 + Math.random(), 0.4, 0.45);
          }
        }
      }
    }
    this.glow.update(dt);
    this.smoke.update(dt);
    for (const l of this.lights) {
      l.age += dt;
      const t = Math.min(1, l.age / l.life);
      l.light.intensity = l.peak * (1 - t) * (1 - t);
    }
  }
}
