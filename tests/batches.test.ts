import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FlameField, GlowField, updateBatches } from '../src/client/render/batches';

const attr = (field: GlowField, name: string) => (field.mesh.geometry as THREE.InstancedBufferGeometry).getAttribute(name) as THREE.InstancedBufferAttribute;
const drawn = (field: GlowField) => (field.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;

function setup() {
  const scene = new THREE.Scene();
  const ship = new THREE.Group();
  ship.position.set(100, 0, 0);
  ship.rotation.y = Math.PI / 2;
  scene.add(ship);
  const field = new GlowField(new THREE.Texture());
  scene.add(field.mesh);
  return { scene, ship, field };
}

describe('glow and flame fields', () => {
  it('places each glow in world space from its parent, with its colour, opacity and size', () => {
    const { ship, field } = setup();
    const g = field.add(ship, new THREE.Color(1, 0.5, 0.25), 2, new THREE.Vector3(0, 0, -10));
    g.opacity = 0.4;
    g.rotation = 1.2;
    updateBatches();
    expect(drawn(field)).toBe(1);
    expect(field.mesh.visible).toBe(true);
    // Nose 10 m ahead (−Z) of a ship turned a quarter left points down −X.
    const p = attr(field, 'aPos');
    expect(p.getX(0)).toBeCloseTo(90, 5);
    expect(p.getY(0)).toBeCloseTo(0, 5);
    expect(p.getZ(0)).toBeCloseTo(0, 5);
    expect([...attr(field, 'aColor').array.slice(0, 4)].map((x) => +x.toFixed(3))).toEqual([1, 0.5, 0.25, 0.4]);
    expect(attr(field, 'aShape').getX(0)).toBe(2);
    expect(attr(field, 'aShape').getY(0)).toBeCloseTo(1.2, 5);
    field.dispose();
  });

  it('follows the parent as it moves, frame after frame', () => {
    const { ship, field } = setup();
    field.add(ship, new THREE.Color(), 1, new THREE.Vector3());
    updateBatches();
    ship.position.set(0, 50, 0);
    updateBatches();
    expect(attr(field, 'aPos').getY(0)).toBeCloseTo(50, 5);
    field.dispose();
  });

  it('skips hidden, faded and removed glows, and glows of ships outside the scene', () => {
    const { scene, ship, field } = setup();
    const a = field.add(ship, new THREE.Color(), 1, new THREE.Vector3());
    const b = field.add(ship, new THREE.Color(), 1, new THREE.Vector3());
    const c = field.add(ship, new THREE.Color(), 1, new THREE.Vector3());
    a.visible = false;
    b.opacity = 0;
    updateBatches();
    expect(drawn(field)).toBe(1);
    field.remove(c);
    updateBatches();
    expect(drawn(field)).toBe(0);
    expect(field.mesh.visible).toBe(false);
    a.visible = true;
    ship.visible = false;
    updateBatches();
    expect(drawn(field)).toBe(0);
    ship.visible = true;
    scene.remove(ship);
    updateBatches();
    expect(drawn(field)).toBe(0);
    field.dispose();
  });

  it('grows past its first capacity', () => {
    const { ship, field } = setup();
    for (let i = 0; i < 600; i++) field.add(ship, new THREE.Color(), 1, new THREE.Vector3(i, 0, 0));
    updateBatches();
    expect(drawn(field)).toBe(600);
    expect(attr(field, 'aPos').count).toBeGreaterThanOrEqual(600);
    field.dispose();
  });

  it('draws nothing when the field itself is not in a drawn scene', () => {
    const { ship, field } = setup();
    field.add(ship, new THREE.Color(), 1, new THREE.Vector3());
    field.mesh.removeFromParent();
    updateBatches();
    expect(field.mesh.visible).toBe(false);
    field.dispose();
  });

  it('gives each flame its parent transform, scale, colour and power', () => {
    const { scene, ship } = setup();
    const geo = new THREE.ConeGeometry(1, 1, 8);
    const flames = new FlameField(geo, new THREE.MeshBasicMaterial());
    scene.add(flames.mesh);
    const f = flames.add(ship, new THREE.Vector3(0, 0, 5));
    f.scale.set(1, 1, 8);
    f.color.setRGB(0.2, 0.4, 0.6);
    f.power = 0.7;
    updateBatches();
    expect(flames.mesh.count).toBe(1);
    const m = new THREE.Matrix4();
    flames.mesh.getMatrixAt(0, m);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    m.decompose(pos, new THREE.Quaternion(), scale);
    // 5 m behind (+Z) the ship turned a quarter left is +X.
    expect(pos.x).toBeCloseTo(105, 5);
    expect(scale.z).toBeCloseTo(8, 5);
    expect((geo.getAttribute('aColor') as THREE.BufferAttribute).getY(0)).toBeCloseTo(0.4, 5);
    expect((geo.getAttribute('aPower') as THREE.BufferAttribute).getX(0)).toBeCloseTo(0.7, 5);
    flames.remove(f);
    updateBatches();
    expect(flames.mesh.count).toBe(0);
    expect(flames.mesh.visible).toBe(false);
    flames.dispose();
  });
});
