import type { Vector3 } from 'three';
import type { StaticCollider } from './types';

/**
 * Uniform hash grid for static colliders. Large colliders (planets) are kept
 * in a separate list and always tested.
 */
export class StaticGrid {
  private cells = new Map<string, StaticCollider[]>();
  private large: StaticCollider[] = [];
  private result: StaticCollider[] = [];
  private seen = new Set<StaticCollider>();

  constructor(colliders: StaticCollider[], private cellSize = 500) {
    for (const c of colliders) {
      if (c.radius > cellSize * 2) {
        this.large.push(c);
        continue;
      }
      const min = this.cellCoords(c.center.x - c.radius, c.center.y - c.radius, c.center.z - c.radius);
      const max = this.cellCoords(c.center.x + c.radius, c.center.y + c.radius, c.center.z + c.radius);
      for (let x = min[0]; x <= max[0]; x++)
        for (let y = min[1]; y <= max[1]; y++)
          for (let z = min[2]; z <= max[2]; z++) {
            const key = `${x},${y},${z}`;
            let list = this.cells.get(key);
            if (!list) this.cells.set(key, (list = []));
            list.push(c);
          }
    }
  }

  private cellCoords(x: number, y: number, z: number): [number, number, number] {
    const s = this.cellSize;
    return [Math.floor(x / s), Math.floor(y / s), Math.floor(z / s)];
  }

  /** Colliders whose cells overlap a sphere. Returned array is reused. */
  query(p: Vector3, radius: number): StaticCollider[] {
    this.result.length = 0;
    this.seen.clear();
    const min = this.cellCoords(p.x - radius, p.y - radius, p.z - radius);
    const max = this.cellCoords(p.x + radius, p.y + radius, p.z + radius);
    for (let x = min[0]; x <= max[0]; x++)
      for (let y = min[1]; y <= max[1]; y++)
        for (let z = min[2]; z <= max[2]; z++) {
          const list = this.cells.get(`${x},${y},${z}`);
          if (!list) continue;
          for (const c of list) {
            if (this.seen.has(c)) continue;
            this.seen.add(c);
            this.result.push(c);
          }
        }
    for (const c of this.large) this.result.push(c);
    return this.result;
  }
}
