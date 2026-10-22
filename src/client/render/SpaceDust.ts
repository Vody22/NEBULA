import * as THREE from 'three';

const COUNT = 1400;
const BOX = 260;

/**
 * Static micro-debris around the camera, drawn as motion-blurred streaks.
 * It is the main cue for speed and inertia in empty space.
 */
export class SpaceDust {
  readonly lines: THREE.LineSegments;
  private seeds = new Float32Array(COUNT * 3);
  private pos = new Float32Array(COUNT * 6);
  private col = new Float32Array(COUNT * 6);

  constructor() {
    for (let i = 0; i < COUNT * 3; i++) this.seeds[i] = Math.random() * BOX * 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.lines.frustumCulled = false;
  }

  update(camPos: THREE.Vector3, velocity: THREE.Vector3) {
    const speed = velocity.length();
    const streak = 0.035;
    const sx = velocity.x * streak, sy = velocity.y * streak, sz = velocity.z * streak;
    const vis = Math.min(1, 0.25 + speed / 250);
    const S = BOX * 2;
    for (let i = 0; i < COUNT; i++) {
      // World-fixed positions wrapped into a box centred on the camera.
      const x = camPos.x + ((((this.seeds[i * 3] - camPos.x) % S) + S) % S) - BOX;
      const y = camPos.y + ((((this.seeds[i * 3 + 1] - camPos.y) % S) + S) % S) - BOX;
      const z = camPos.z + ((((this.seeds[i * 3 + 2] - camPos.z) % S) + S) % S) - BOX;
      const o = i * 6;
      this.pos[o] = x;
      this.pos[o + 1] = y;
      this.pos[o + 2] = z;
      this.pos[o + 3] = x - sx - 0.15;
      this.pos[o + 4] = y - sy;
      this.pos[o + 5] = z - sz;
      const dx = x - camPos.x, dy = y - camPos.y, dz = z - camPos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / BOX;
      const a = Math.max(0, 1 - d) * vis * 0.55;
      this.col[o] = this.col[o + 3] = a * 0.75;
      this.col[o + 1] = this.col[o + 4] = a * 0.85;
      this.col[o + 2] = this.col[o + 5] = a;
    }
    const g = this.lines.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}
