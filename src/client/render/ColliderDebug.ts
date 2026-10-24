import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bodyProps } from '../../shared/physics/bodies';
import { HITBOXES, type PartId } from '../../shared/physics/hitboxes';
import type { MaterialId } from '../../shared/physics/materials';
import { rockCollision } from '../../shared/physics/rocks';
import { spinOf } from '../../shared/physics/shapes';
import type { ShipClassId, StaticCollider } from '../../shared/sim/types';
import type { ClientBody } from './BodyViews';

/**
 * Collision shapes drawn over the scene (v0.8, `?colliders`): the walls,
 * structures and rocks as the physics sees them (the rocks turning with
 * their models), each ship's hit spheres coloured by part, and the loose
 * bodies' spheres. For checking that what a ship hits is what the player sees.
 */

/** Rocks drawn within this distance of the camera (m). */
const ROCK_RANGE = 2500;

const MATERIAL_COLOR: Record<MaterialId, number> = {
  metal: 0x6fb7ff,
  rock: 0xc9945a,
  metalRock: 0xe0b070,
  ice: 0xbff0ff,
  hull: 0xffffff,
  debris: 0x9fe08a,
};
const PART_COLOR: Record<PartId, number> = { cockpit: 0x40e8ff, hull: 0xffffff, wingL: 0xffe040, wingR: 0xffe040, engines: 0xff7a30 };

/** Three great circles of a unit sphere, as line segments. */
function sphereLines(segments = 24) {
  const pts: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < segments; i++) {
      for (const k of [i, i + 1]) {
        const a = (k / segments) * Math.PI * 2;
        const c = Math.cos(a);
        const s = Math.sin(a);
        if (axis === 0) pts.push(c, s, 0);
        else if (axis === 1) pts.push(c, 0, s);
        else pts.push(0, c, s);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** The wireframe of a collider's shape, in world coordinates. */
function colliderLines(c: StaticCollider): THREE.BufferGeometry {
  const s = c.shape;
  let g: THREE.BufferGeometry;
  if (!s || s.t === 'sphere') {
    g = sphereLines(c.radius > 200 ? 64 : 24);
    g.scale(s ? s.r : c.radius, s ? s.r : c.radius, s ? s.r : c.radius);
  } else if (s.t === 'box') {
    g = new THREE.EdgesGeometry(new THREE.BoxGeometry(s.h[0] * 2, s.h[1] * 2, s.h[2] * 2));
  } else if (s.t === 'cylinder') {
    g = new THREE.EdgesGeometry(new THREE.CylinderGeometry(s.r, s.r, s.h * 2, 24, 1), 1);
  } else if (s.t === 'torus') {
    g = new THREE.WireframeGeometry(new THREE.TorusGeometry(s.R, s.r, 6, 64));
    g.rotateX(Math.PI / 2);
  } else if (s.t === 'capsule') {
    const a = new THREE.Vector3(...s.a);
    const b = new THREE.Vector3(...s.b);
    const len = a.distanceTo(b);
    g = new THREE.EdgesGeometry(new THREE.CapsuleGeometry(s.r, len, 3, 10), 20);
    // CapsuleGeometry runs along Y: turn it onto a→b and centre it between them.
    const dir = b.clone().sub(a).normalize();
    if (len > 1e-6) g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  } else {
    throw new Error('rocks turn: drawn one by one');
  }
  if (c.rot) g.applyQuaternion(c.rot);
  g.translate(c.center.x, c.center.y, c.center.z);
  // Only positions: the lines of every collider of a material are merged into one draw.
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  return g.index ? g.toNonIndexed() : g;
}

export class ColliderDebug {
  readonly group = new THREE.Group();
  private unit = sphereLines();
  private shipLines = new Map<number, THREE.Group>();
  private bodyLines = new Map<number, THREE.Group>();
  private mats = new Map<number, THREE.LineBasicMaterial>();
  private rocks: { c: StaticCollider; lines: THREE.LineSegments | null }[] = [];
  private rockShapes = new Map<string, THREE.BufferGeometry>();

  constructor(colliders: StaticCollider[]) {
    const byMaterial = new Map<MaterialId, THREE.BufferGeometry[]>();
    for (const c of colliders) {
      // Planets are far too big to read as lines.
      if (c.kind === 'planet') continue;
      if (c.shape?.t === 'rock') {
        this.rocks.push({ c, lines: null });
        continue;
      }
      let list = byMaterial.get(c.material);
      if (!list) byMaterial.set(c.material, (list = []));
      list.push(colliderLines(c));
    }
    for (const [mat, list] of byMaterial) {
      const lines = new THREE.LineSegments(mergeGeometries(list)!, this.mat(MATERIAL_COLOR[mat], 0.55));
      lines.frustumCulled = false;
      this.group.add(lines);
      for (const g of list) g.dispose();
    }
    this.group.renderOrder = 10;
  }

  private mat(color: number, opacity = 0.9) {
    const key = color * 10 + Math.round(opacity * 9);
    let m = this.mats.get(key);
    if (!m) this.mats.set(key, (m = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, fog: false, toneMapped: false })));
    return m;
  }

  /** A rock family's collision surface as the physics reads it (unit rock). */
  private rockShape(v: number, big: boolean) {
    const key = `${v}:${big}`;
    let g = this.rockShapes.get(key);
    if (g) return g;
    const table = rockCollision(v, big);
    const ico = new THREE.IcosahedronGeometry(1, big ? 5 : 3);
    const pos = ico.attributes.position as THREE.BufferAttribute;
    const u = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      table.surfacePoint(u.fromBufferAttribute(pos, i).normalize(), u);
      pos.setXYZ(i, u.x, u.y, u.z);
    }
    g = new THREE.WireframeGeometry(ico);
    ico.dispose();
    this.rockShapes.set(key, g);
    return g;
  }

  private spheres(list: { at: THREE.Vector3; r: number; color: number }[]) {
    const g = new THREE.Group();
    for (const s of list) {
      const l = new THREE.LineSegments(this.unit, this.mat(s.color));
      l.position.copy(s.at);
      l.scale.setScalar(s.r);
      l.frustumCulled = false;
      g.add(l);
    }
    this.group.add(g);
    return g;
  }

  /** Each frame: the rocks near the camera at sim time `time`, and the hit spheres of the ships and bodies drawn this frame. */
  update(
    ships: Iterable<{ id: number; classId: ShipClassId; position: THREE.Vector3; rotation: THREE.Quaternion }>,
    bodies: Iterable<ClientBody>,
    time: number,
    camera: THREE.Vector3,
  ) {
    for (const r of this.rocks) {
      const near = r.c.center.distanceTo(camera) - r.c.radius < ROCK_RANGE;
      if (!near) {
        if (r.lines) r.lines.visible = false;
        continue;
      }
      const shape = r.c.shape as { t: 'rock'; v: number; big: boolean; s: number };
      if (!r.lines) {
        r.lines = new THREE.LineSegments(this.rockShape(shape.v, shape.big), this.mat(MATERIAL_COLOR[r.c.material], 0.45));
        r.lines.frustumCulled = false;
        r.lines.position.copy(r.c.center);
        r.lines.scale.setScalar(shape.s);
        this.group.add(r.lines);
      }
      r.lines.visible = true;
      spinOf(r.c, time, r.lines.quaternion);
    }
    const seen = new Set<number>();
    for (const s of ships) {
      seen.add(s.id);
      let g = this.shipLines.get(s.id);
      if (!g || g.userData.classId !== s.classId) {
        if (g) this.group.remove(g);
        g = this.spheres(HITBOXES[s.classId].map((h) => ({ at: h.at, r: h.r, color: PART_COLOR[h.part] })));
        g.userData.classId = s.classId;
        this.shipLines.set(s.id, g);
      }
      g.position.copy(s.position);
      g.quaternion.copy(s.rotation);
    }
    for (const [id, g] of this.shipLines) {
      if (seen.has(id)) continue;
      this.group.remove(g);
      this.shipLines.delete(id);
    }
    seen.clear();
    for (const b of bodies) {
      seen.add(b.id);
      let g = this.bodyLines.get(b.id);
      if (!g) {
        g = this.spheres(bodyProps(b.kind, b.scale).spheres.map((h) => ({ at: h.at, r: h.r, color: 0x7dff9a })));
        this.bodyLines.set(b.id, g);
      }
      g.position.copy(b.position);
      g.quaternion.copy(b.rotation);
    }
    for (const [id, g] of this.bodyLines) {
      if (seen.has(id)) continue;
      this.group.remove(g);
      this.bodyLines.delete(id);
    }
  }

  dispose() {
    const shared = new Set<THREE.BufferGeometry>([this.unit, ...this.rockShapes.values()]);
    this.group.traverse((o) => {
      const l = o as THREE.LineSegments;
      if (l.isLineSegments && !shared.has(l.geometry)) l.geometry.dispose();
    });
    for (const g of shared) g.dispose();
    for (const m of this.mats.values()) m.dispose();
  }
}
