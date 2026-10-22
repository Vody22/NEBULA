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

  emit(p: THREE.Vector3, v: THREE.Vector3, c0: THREE.Color, c1: THREE.Color, size0: number, size1: number, life: number, drag = 0, alpha = 1) {
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
    part.age = 0;
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
      if (!part.alive) {
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

interface Shockwave {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  size: number;
}

interface Debris {
  mesh: THREE.Mesh;
  v: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  life: number;
}

const rnd = () => Math.random() * 2 - 1;
const randDir = (out: THREE.Vector3) => {
  do out.set(rnd(), rnd(), rnd());
  while (out.lengthSq() > 1 || out.lengthSq() < 0.01);
  return out.normalize();
};

/** Explosions, sparks, muzzle flashes, impacts, smoke, debris and flash lights. */
export class Effects {
  readonly group = new THREE.Group();
  private glow: ParticlePool;
  private smoke: ParticlePool;
  private waves: Shockwave[] = [];
  private debris: Debris[] = [];
  private lights: { light: THREE.PointLight; age: number; life: number; peak: number }[] = [];
  private v = new THREE.Vector3();
  private d = new THREE.Vector3();
  private debrisMat: THREE.MeshStandardMaterial;
  private waveMat: THREE.MeshBasicMaterial;

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
    this.glow = new ParticlePool(5000, true, soft);
    this.smoke = new ParticlePool(1500, false, puff);
    this.group.add(this.smoke.points, this.glow.points);

    this.waveMat = new THREE.MeshBasicMaterial({
      map: makeRadialTexture([
        [0, 'rgba(255,255,255,0)'],
        [0.75, 'rgba(255,255,255,0)'],
        [0.92, 'rgba(255,255,255,0.9)'],
        [1, 'rgba(255,255,255,0)'],
      ]),
      color: new THREE.Color(0.9, 0.6, 0.4),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x55504c, metalness: 0.6, roughness: 0.6, emissive: new THREE.Color(0.6, 0.2, 0.05) });
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffaa66, 0, 900, 1.6);
      this.group.add(light);
      this.lights.push({ light, age: 1, life: 1, peak: 0 });
    }
  }

  setPixelScale(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.glow.material.uniforms.uScale.value = s;
    this.smoke.material.uniforms.uScale.value = s;
  }

  private flashLight(pos: THREE.Vector3, peak: number, life: number, color: THREE.Color) {
    const slot = this.lights.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    slot.light.position.copy(pos);
    slot.light.color.copy(color);
    slot.age = 0;
    slot.life = life;
    slot.peak = peak;
  }

  explosion(pos: THREE.Vector3, scale: number, vel = new THREE.Vector3()) {
    const hot = new THREE.Color(2.2, 1.5, 0.8);
    const orange = new THREE.Color(1.3, 0.42, 0.08);
    const red = new THREE.Color(0.35, 0.05, 0.01);
    for (let i = 0; i < 45 * scale; i++) {
      randDir(this.d);
      this.v.copy(this.d).multiplyScalar((20 + Math.random() * 90) * scale).add(vel.clone().multiplyScalar(0.5));
      this.glow.emit(pos, this.v, i % 3 ? orange : hot, red, (4 + Math.random() * 5) * scale, (14 + Math.random() * 16) * scale, 0.7 + Math.random() * 0.9, 1.5);
    }
    // core flash
    this.glow.emit(pos, vel.clone().multiplyScalar(0.5), new THREE.Color(4, 3.2, 2.4), new THREE.Color(0.8, 0.25, 0.08), 12 * scale, 40 * scale, 0.3, 0);
    // sparks
    const spark = new THREE.Color(5, 3, 1.2);
    for (let i = 0; i < 70 * scale; i++) {
      randDir(this.d);
      this.v.copy(this.d).multiplyScalar(120 + Math.random() * 260).add(vel);
      this.glow.emit(pos, this.v, spark, new THREE.Color(1.5, 0.3, 0), 1.2, 0.6, 0.6 + Math.random() * 1.2, 0.6);
    }
    // smoke
    for (let i = 0; i < 26 * scale; i++) {
      randDir(this.d);
      this.v.copy(this.d).multiplyScalar((6 + Math.random() * 24) * scale).add(vel.clone().multiplyScalar(0.3));
      this.smoke.emit(pos, this.v, new THREE.Color(0.12, 0.1, 0.09), new THREE.Color(0.05, 0.05, 0.06), 8 * scale, 34 * scale, 2.5 + Math.random() * 2.5, 0.6, 0.5);
    }
    // shockwave rings
    for (let k = 0; k < 2; k++) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.waveMat.clone());
      mesh.position.copy(pos);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), randDir(this.d));
      this.group.add(mesh);
      this.waves.push({ mesh, age: 0, life: 0.8 + k * 0.3, size: (55 + k * 30) * scale });
    }
    // debris chunks
    for (let i = 0; i < 10 * scale; i++) {
      const s = 0.4 + Math.random() * 1.6;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.4, s * 1.4), this.debrisMat);
      mesh.position.copy(pos);
      this.group.add(mesh);
      this.debris.push({ mesh, v: randDir(new THREE.Vector3()).multiplyScalar(30 + Math.random() * 90).add(vel.clone().multiplyScalar(0.6)), spin: new THREE.Vector3(rnd(), rnd(), rnd()).multiplyScalar(6), age: 0, life: 4 + Math.random() * 3 });
    }
    this.flashLight(pos, 3e4 * scale, 0.8, new THREE.Color(1, 0.6, 0.3));
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

  muzzle(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color) {
    this.glow.emit(pos, vel, color, new THREE.Color(0, 0, 0), 3.5, 1.2, 0.06);
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
    this.glow.update(dt);
    this.smoke.update(dt);
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.age += dt;
      const t = w.age / w.life;
      if (t >= 1) {
        this.group.remove(w.mesh);
        w.mesh.geometry.dispose();
        (w.mesh.material as THREE.Material).dispose();
        this.waves.splice(i, 1);
        continue;
      }
      const e = 1 - Math.pow(1 - t, 3);
      w.mesh.scale.setScalar(w.size * e + 1);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      if (d.age > d.life) {
        this.group.remove(d.mesh);
        d.mesh.geometry.dispose();
        this.debris.splice(i, 1);
        continue;
      }
      d.mesh.position.addScaledVector(d.v, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      d.mesh.scale.setScalar(Math.min(1, (d.life - d.age) / 0.6));
    }
    for (const l of this.lights) {
      l.age += dt;
      const t = Math.min(1, l.age / l.life);
      l.light.intensity = l.peak * (1 - t) * (1 - t);
    }
  }
}
