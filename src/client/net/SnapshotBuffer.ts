import { Quaternion, Vector3 } from 'three';
import type { ShipSnapshot, WorldSnapshot } from '../../shared/net/protocol';

export interface InterpolatedShip {
  snap: ShipSnapshot;
  position: Vector3;
  rotation: Quaternion;
  velocity: Vector3;
}

const _qa = new Quaternion();
const _qb = new Quaternion();

/**
 * Keeps recent snapshots and renders the world slightly in the past,
 * interpolating between the two snapshots that straddle the render time.
 */
export class SnapshotBuffer {
  private snaps: WorldSnapshot[] = [];
  private cache = new Map<number, InterpolatedShip>();
  /** Render delay in seconds behind the newest snapshot. */
  delay: number;

  constructor(delay: number) {
    this.delay = delay;
  }

  push(s: WorldSnapshot) {
    const last = this.snaps[this.snaps.length - 1];
    if (last && s.tick <= last.tick) return;
    this.snaps.push(s);
    if (this.snaps.length > 30) this.snaps.shift();
  }

  get latest(): WorldSnapshot | undefined {
    return this.snaps[this.snaps.length - 1];
  }

  /**
   * Returns interpolated ships at `renderTime` (server clock).
   * Ships present only in the newer snapshot appear as-is.
   */
  sample(renderTime: number): Map<number, InterpolatedShip> {
    const out = this.cache;
    const n = this.snaps.length;
    if (n === 0) {
      out.clear();
      return out;
    }
    let a = this.snaps[0];
    let b = this.snaps[n - 1];
    for (let i = n - 1; i > 0; i--) {
      if (this.snaps[i - 1].time <= renderTime) {
        a = this.snaps[i - 1];
        b = this.snaps[i];
        break;
      }
    }
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - a.time) / span)) : 1;
    const prev = new Map(a.ships.map((s) => [s.id, s] as const));
    const alive = new Set<number>();
    for (const sb of b.ships) {
      alive.add(sb.id);
      let e = out.get(sb.id);
      if (!e) {
        e = { snap: sb, position: new Vector3(), rotation: new Quaternion(), velocity: new Vector3() };
        out.set(sb.id, e);
      }
      e.snap = sb;
      const sa = prev.get(sb.id) ?? sb;
      e.position.set(sa.p[0] + (sb.p[0] - sa.p[0]) * t, sa.p[1] + (sb.p[1] - sa.p[1]) * t, sa.p[2] + (sb.p[2] - sa.p[2]) * t);
      e.velocity.set(sa.v[0] + (sb.v[0] - sa.v[0]) * t, sa.v[1] + (sb.v[1] - sa.v[1]) * t, sa.v[2] + (sb.v[2] - sa.v[2]) * t);
      _qa.set(sa.q[0], sa.q[1], sa.q[2], sa.q[3]);
      _qb.set(sb.q[0], sb.q[1], sb.q[2], sb.q[3]);
      e.rotation.slerpQuaternions(_qa, _qb, t);
    }
    for (const id of out.keys()) if (!alive.has(id)) out.delete(id);
    return out;
  }
}
