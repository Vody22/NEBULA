import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const KEEP = ['position', 'normal', 'uv', 'color'];

function flipWinding(geo: THREE.BufferGeometry) {
  for (const name of KEEP) {
    const attr = geo.getAttribute(name) as THREE.BufferAttribute | undefined;
    if (!attr) continue;
    const a = attr.array as Float32Array;
    const s = attr.itemSize;
    for (let t = 0; t < attr.count; t += 3) {
      for (let k = 0; k < s; k++) {
        const i1 = (t + 1) * s + k;
        const i2 = (t + 2) * s + k;
        const tmp = a[i1];
        a[i1] = a[i2];
        a[i2] = tmp;
      }
    }
  }
}

/**
 * Collapses every static mesh under `root` into one mesh per material.
 * A procedural ship goes from ~40 draw calls to ~5. Sprites, instanced
 * meshes and anything with userData.dynamic are left untouched.
 */
export function mergeByMaterial(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const victims: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o === root || !(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
    if (Array.isArray(o.material) || o.userData.dynamic) return;
    for (let p = o.parent; p && p !== root; p = p.parent) if (p.userData.dynamic) return;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!KEEP.includes(name)) g.deleteAttribute(name);
    if (!g.getAttribute('uv')) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.clearGroups();
    g.applyMatrix4(m);
    if (m.determinant() < 0) flipWinding(g);
    const list = buckets.get(o.material) ?? [];
    list.push(g);
    buckets.set(o.material, list);
    victims.push(o);
  });
  for (const v of victims) v.parent?.remove(v);
  for (const [mat, geos] of buckets) {
    // Vertex colours only survive on materials that read them; elsewhere every
    // geometry of the bucket needs the same attribute set.
    const tinted = (mat as THREE.MeshStandardMaterial).vertexColors === true;
    for (const g of geos) {
      if (!tinted) g.deleteAttribute('color');
      else if (!g.getAttribute('color')) {
        g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 3).fill(1), 3));
      }
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (merged) root.add(new THREE.Mesh(merged, mat));
  }
}
