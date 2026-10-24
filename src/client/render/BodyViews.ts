import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BODY_DEFS, BODY_KINDS, type BodyKind } from '../../shared/physics/bodies';
import { mulberry32 } from '../../shared/rng';
import type { BodyState } from '../../shared/sim/looseBodies';

/** A pose of a body at a server time. */
interface Sample {
  t: number;
  p: THREE.Vector3;
  q: THREE.Quaternion;
}

/** A loose body as the client knows it (v0.8): its recent poses from the snapshots, and how it is drawn now. */
export interface ClientBody {
  id: number;
  kind: BodyKind;
  scale: number;
  /** Oldest first. */
  samples: Sample[];
  /** Pose drawn this frame. */
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  /** Client clock (s) it appeared, for a short fade-in (wreckage, replaced cargo); -1: drawn at once. */
  born: number;
  /** Client clock (s) it began to fade out (cleared away), or -1. */
  dying: number;
}

const MAX_PER_KIND = 96;
/** Beyond this between two snapshots a body was put back somewhere, not moved: no sweep through space (m). */
const TELEPORT = 80;
const FADE_IN = 0.3;
const FADE_OUT = 1.2;

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** A box with vertex colour `shade` (multiplied by the instance colour). */
function box(w: number, h: number, d: number, shade: number, at: [number, number, number] = [0, 0, 0], rot?: THREE.Euler) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  g.translate(...at);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3).fill(shade);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** A cargo crate: a panelled box in a darker frame along its twelve edges. */
function crateGeometry() {
  const [hx, hy, hz] = BODY_DEFS.crate.half;
  const parts = [box(hx * 2 - 0.1, hy * 2 - 0.1, hz * 2 - 0.1, 1)];
  const t = 0.16;
  for (const sy of [-1, 1])
    for (const sz of [-1, 1]) {
      parts.push(box(hx * 2, t, t, 0.3, [0, sy * (hy - t / 2), sz * (hz - t / 2)]));
      parts.push(box(t, t, hz * 2, 0.3, [sy * (hx - t / 2), sz * (hy - t / 2), 0]));
      parts.push(box(t, hy * 2, t, 0.3, [sy * (hx - t / 2), 0, sz * (hz - t / 2)]));
    }
  // Latches and a stencilled band.
  parts.push(box(hx * 2 + 0.02, 0.28, 0.6, 0.85, [0, 0, 0]));
  return mergeGeometries(parts)!;
}

/** A freight container: corrugated sides, dark end frames and corner castings. */
function containerGeometry() {
  const [hx, hy, hz] = BODY_DEFS.container.half;
  const parts = [box(hx * 2 - 0.2, hy * 2 - 0.12, hz * 2 - 0.12, 1)];
  for (let x = -hx + 0.35; x < hx - 0.2; x += 0.42) {
    parts.push(box(0.16, hy * 2 - 0.3, hz * 2 + 0.02, 0.82, [x, 0, 0]));
  }
  for (const sx of [-1, 1]) {
    parts.push(box(0.22, hy * 2, hz * 2, 0.25, [sx * (hx - 0.11), 0, 0]));
    for (const sy of [-1, 1]) for (const sz of [-1, 1]) parts.push(box(0.36, 0.36, 0.36, 0.18, [sx * (hx - 0.18), sy * (hy - 0.18), sz * (hz - 0.18)]));
  }
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) parts.push(box(hx * 2, 0.14, 0.14, 0.3, [0, sy * (hy - 0.07), sz * (hz - 0.07)]));
  return mergeGeometries(parts)!;
}

/** A torn section of hull: bent plates over broken ribs, scorched unevenly. */
function wreckGeometry() {
  const rand = mulberry32(0x3ec4);
  const parts = [
    box(3.2, 0.14, 2.2, 0.8, [-0.4, 0, -0.2], new THREE.Euler(0.12, 0.3, 0.2)),
    box(2.2, 0.14, 1.5, 0.6, [1.1, 0.15, 0.5], new THREE.Euler(-0.25, -0.4, 0.35)),
    box(1.6, 0.12, 1.1, 0.45, [0, -0.1, 1.0], new THREE.Euler(0.4, 0.8, -0.2)),
  ];
  for (let i = 0; i < 4; i++) {
    parts.push(box(0.16, 0.5 + rand() * 0.4, 2 + rand(), 0.3, [-1.6 + i * 1.05, 0.25, 0], new THREE.Euler(rand() * 0.4, rand() * 0.6, rand() * 0.3)));
  }
  const g = mergeGeometries(parts)!;
  // Scorch: darken the vertices at random, more toward one end.
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < col.count; i += 3) {
    const k = 0.55 + 0.45 * rand() - Math.max(0, pos.getX(i) * 0.12);
    for (let j = 0; j < 3; j++) col.setXYZ(i + j, col.getX(i + j) * k, col.getY(i + j) * k, col.getZ(i + j) * k);
  }
  return g;
}

/** A boulder: a lumpy ball (unit radius). */
function boulderGeometry() {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 2);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const n = Math.sin(v.x * 5.1 + 1.3) * Math.sin(v.y * 4.3 + 0.7) * Math.sin(v.z * 3.7 + 2.1);
    v.multiplyScalar(0.9 + 0.16 * n + 0.05 * Math.sin(v.x * 13 + v.z * 11));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(1), 3));
  return g;
}

/** Paint of each kind, picked per body. */
const PAINT: Record<BodyKind, number[]> = {
  crate: [0xc8873a, 0x6f8a94, 0x9a9a92, 0xc9a43c, 0x5f7a5a],
  container: [0xa8432e, 0x2f5f8f, 0x4f7a4a, 0xc07b2c, 0x7c7f86],
  wreck: [0x6e6a66, 0x5d5955],
  boulder: [0x6b625a, 0x5b544e, 0x7a7068],
};

/**
 * Draws the loose bodies (v0.8): one instanced mesh per kind, poses
 * interpolated between snapshots like the ships, at rest when the server
 * stops listing them. Built with the sector so its shaders compile ahead.
 */
export class BodyViews {
  readonly group = new THREE.Group();
  readonly bodies = new Map<number, ClientBody>();
  private meshes = {} as Record<BodyKind, THREE.InstancedMesh>;
  /** Server time of the newest snapshot ingested. */
  latest = -Infinity;

  constructor() {
    const geos: Record<BodyKind, THREE.BufferGeometry> = { crate: crateGeometry(), container: containerGeometry(), wreck: wreckGeometry(), boulder: boulderGeometry() };
    for (const kind of BODY_KINDS) {
      const rock = kind === 'boulder';
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: rock ? 0 : kind === 'wreck' ? 0.7 : 0.45,
        roughness: rock ? 0.95 : kind === 'wreck' ? 0.6 : 0.55,
        flatShading: rock,
      });
      const mesh = new THREE.InstancedMesh(geos[kind], mat, MAX_PER_KIND);
      // Instance colours exist from the start, so the compiled shader is the one used.
      for (let i = 0; i < MAX_PER_KIND; i++) mesh.setColorAt(i, _c.set(0xffffff));
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.meshes[kind] = mesh;
      this.group.add(mesh);
    }
  }

  /**
   * The bodies of a snapshot at server time `time` (`full`: every body of
   * the sector is listed, the others are gone). Bodies new in a partial list
   * were just made (wreckage, replaced cargo): they fade in.
   */
  ingest(list: BodyState[] | undefined, full: boolean, time: number, now: number) {
    const seen = full ? new Set<number>() : null;
    const interval = Number.isFinite(this.latest) ? Math.min(0.2, Math.max(1 / 60, time - this.latest)) : 0.05;
    if (time > this.latest) this.latest = time;
    for (const s of list ?? []) {
      const [id, k, scale, x, y, z, qx, qy, qz, qw] = s;
      seen?.add(id);
      let b = this.bodies.get(id);
      const p = new THREE.Vector3(x, y, z);
      const q = new THREE.Quaternion(qx, qy, qz, qw).normalize();
      if (!b) {
        b = { id, kind: BODY_KINDS[k] ?? 'crate', scale, samples: [], position: p.clone(), rotation: q.clone(), born: full ? -1 : now, dying: -1 };
        this.bodies.set(id, b);
      }
      const last = b.samples[b.samples.length - 1];
      if (last && last.t >= time) continue;
      if (last && last.p.distanceTo(p) > TELEPORT) b.samples.length = 0;
      else if (last && time - last.t > interval * 2.5) {
        // It rested until the last snapshot: start moving from there, not from long ago.
        b.samples.push({ t: time - interval, p: last.p.clone(), q: last.q.clone() });
      }
      b.samples.push({ t: time, p, q });
      if (b.samples.length > 8) b.samples.shift();
    }
    if (seen) for (const [id, b] of this.bodies) if (!seen.has(id) && b.dying < 0) this.remove(id, now);
  }

  /** A body broke (`now` absent: at once) or was cleared away (fades out). */
  remove(id: number, now?: number) {
    const b = this.bodies.get(id);
    if (!b) return;
    if (now === undefined) this.bodies.delete(id);
    else if (b.dying < 0) b.dying = now;
  }

  /** True when the newest snapshot did not list the body: it rests (as far as we know). */
  resting(b: ClientBody) {
    const last = b.samples[b.samples.length - 1];
    return b.dying < 0 && (!last || last.t < this.latest);
  }

  clear() {
    this.bodies.clear();
    this.latest = -Infinity;
  }

  /** Poses at `renderTime` (server clock), drawn; `now`: client clock for the fades. */
  update(renderTime: number, now: number) {
    const counts: Record<BodyKind, number> = { crate: 0, container: 0, wreck: 0, boulder: 0 };
    for (const [id, b] of this.bodies) {
      const n = b.samples.length;
      if (n === 0) continue;
      // Not drawn before its first pose (wreckage appears with its explosion).
      if (renderTime < b.samples[0].t) continue;
      let i = n - 1;
      while (i > 0 && b.samples[i - 1].t > renderTime) i--;
      const s1 = b.samples[i];
      const s0 = i > 0 ? b.samples[i - 1] : s1;
      if (renderTime >= s1.t || s0 === s1) {
        b.position.copy(s1.p);
        b.rotation.copy(s1.q);
      } else {
        const t = Math.max(0, Math.min(1, (renderTime - s0.t) / (s1.t - s0.t)));
        b.position.lerpVectors(s0.p, s1.p, t);
        b.rotation.slerpQuaternions(s0.q, s1.q, t);
      }
      let k = b.scale;
      if (b.born >= 0) k *= Math.min(1, (now - b.born) / FADE_IN + 0.05);
      if (b.dying >= 0) {
        const f = 1 - (now - b.dying) / FADE_OUT;
        if (f <= 0) {
          this.bodies.delete(id);
          continue;
        }
        k *= f;
      }
      const mesh = this.meshes[b.kind];
      const slot = counts[b.kind];
      if (slot >= MAX_PER_KIND) continue;
      counts[b.kind]++;
      _m.compose(b.position, b.rotation, _s.setScalar(k));
      mesh.setMatrixAt(slot, _m);
      const paint = PAINT[b.kind];
      mesh.setColorAt(slot, _c.set(paint[id % paint.length]));
    }
    for (const kind of BODY_KINDS) {
      const mesh = this.meshes[kind];
      mesh.count = counts[kind];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    for (const kind of BODY_KINDS) {
      const mesh = this.meshes[kind];
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
