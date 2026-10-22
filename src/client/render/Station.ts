import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';
import type { StationDef } from '../../shared/sim/zone';
import { makeHullTextures, makeRadialTexture, makeSolarTexture } from './textures';

interface Blinker {
  sprite: THREE.Sprite;
  phase: number;
  rate: number;
}

interface Shuttle {
  mesh: THREE.Object3D;
  radius: number;
  height: number;
  speed: number;
  phase: number;
}

/**
 * Station Aurora-7: a kilometre-scale hub with a rotating habitat ring,
 * central spine, docking hangar, solar arrays, navigation beacons and
 * shuttle traffic. Dimensions match the server colliders in zone.ts.
 */
export class Station {
  readonly group = new THREE.Group();
  private ring = new THREE.Group();
  private blinkers: Blinker[] = [];
  private shuttles: Shuttle[] = [];

  constructor(def: StationDef) {
    const rand = mulberry32(777);
    const hull = makeHullTextures({ base: '#9aa1aa', accent: '#c25a1c', seed: 3, lights: '#ffd9a0', size: 1024 });
    const hullMat = new THREE.MeshStandardMaterial({
      map: hull.map,
      roughnessMap: hull.roughnessMap,
      emissiveMap: hull.emissiveMap,
      emissive: new THREE.Color(2.2, 1.8, 1.3),
      metalness: 0.65,
      roughness: 0.55,
    });
    for (const t of [hull.map, hull.roughnessMap, hull.emissiveMap!]) t.repeat.set(4, 4);
    const dark = makeHullTextures({ base: '#3b4048', accent: '#1f7fd6', seed: 8, lights: '#7fd0ff', dark: true, size: 1024 });
    const darkMat = new THREE.MeshStandardMaterial({
      map: dark.map,
      roughnessMap: dark.roughnessMap,
      emissiveMap: dark.emissiveMap,
      emissive: new THREE.Color(1.5, 2.4, 3.2),
      metalness: 0.75,
      roughness: 0.5,
    });
    for (const t of [dark.map, dark.roughnessMap, dark.emissiveMap!]) t.repeat.set(3, 3);
    const solarMat = new THREE.MeshStandardMaterial({ map: makeSolarTexture(), metalness: 0.9, roughness: 0.25, envMapIntensity: 1.4 });
    const glowBlue = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.6, 3.5), toneMapped: false });
    const glowOrange = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.5, 1.6, 0.5), toneMapped: false });

    // --- Core: lathe profile for a sculpted hub
    const prof: THREE.Vector2[] = [];
    const R = def.coreRadius;
    const pts: [number, number][] = [
      [0.0, -1.25], [0.35, -1.2], [0.55, -1.0], [0.62, -0.85], [0.9, -0.7], [1.0, -0.4], [1.02, -0.1],
      [1.08, 0.0], [1.02, 0.1], [1.0, 0.4], [0.9, 0.7], [0.62, 0.85], [0.55, 1.0], [0.35, 1.2], [0.0, 1.25],
    ];
    for (const [x, y] of pts) prof.push(new THREE.Vector2(x * R, y * R));
    const core = new THREE.Mesh(new THREE.LatheGeometry(prof, 96), hullMat);
    this.group.add(core);
    // equatorial light band
    const band = new THREE.Mesh(new THREE.TorusGeometry(R * 1.085, 3.2, 8, 128), glowOrange);
    band.rotation.x = Math.PI / 2;
    this.group.add(band);

    // --- Spine with stacked modules
    const spineR = 42;
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(spineR, spineR, def.spineLength, 48, 1), darkMat);
    this.group.add(spine);
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const y = sgn * (R * 1.3 + i * 85);
        const kind = i % 3;
        let mod: THREE.Mesh;
        if (kind === 0) mod = new THREE.Mesh(new THREE.CylinderGeometry(75, 75, 50, 12), hullMat);
        else if (kind === 1) mod = new THREE.Mesh(new THREE.BoxGeometry(110, 60, 110), darkMat);
        else mod = new THREE.Mesh(new THREE.CylinderGeometry(60, 70, 40, 24), hullMat);
        mod.position.y = y;
        mod.rotation.y = i * 0.4;
        this.group.add(mod);
        const ringLight = new THREE.Mesh(new THREE.TorusGeometry(kind === 1 ? 80 : 78, 1.6, 6, 64), i % 2 ? glowBlue : glowOrange);
        ringLight.rotation.x = Math.PI / 2;
        ringLight.position.y = y + 28;
        this.group.add(ringLight);
      }
      // Spine caps with antenna masts
      const cap = new THREE.Mesh(new THREE.ConeGeometry(70, 120, 24), hullMat);
      cap.position.y = sgn * (def.spineLength / 2 + 50);
      if (sgn < 0) cap.rotation.x = Math.PI;
      this.group.add(cap);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(2, 4, 260, 6), darkMat);
      mast.position.y = sgn * (def.spineLength / 2 + 230);
      this.group.add(mast);
      this.addBlinker(new THREE.Vector3(0, sgn * (def.spineLength / 2 + 360), 0), new THREE.Color(5, 0.6, 0.4), 70, 1.1, rand());
    }

    // --- Solar arrays on the upper spine
    for (const sgn of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(260, 6, 6), darkMat);
        arm.position.set(sgn * 170, 380 + k * 55, 0);
        this.group.add(arm);
        const panel = new THREE.Mesh(new THREE.BoxGeometry(220, 2, 48), solarMat);
        panel.position.set(sgn * 200, 380 + k * 55, 0);
        panel.rotation.x = 0.35;
        this.group.add(panel);
      }
    }

    // --- Rotating habitat ring + spokes
    const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(def.ringRadius, def.ringTube, 48, 256), hullMat);
    ringMesh.rotation.x = Math.PI / 2;
    this.ring.add(ringMesh);
    // window strips on the inner and outer faces
    for (const off of [-def.ringTube * 0.98, def.ringTube * 0.98]) {
      const w = new THREE.Mesh(new THREE.TorusGeometry(def.ringRadius + off, 2.2, 6, 256), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.2, 1.6), toneMapped: false }));
      w.rotation.x = Math.PI / 2;
      this.ring.add(w);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const len = def.ringRadius - R;
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, len, 16), darkMat);
      spoke.position.set(Math.cos(a) * (R + len / 2), 0, Math.sin(a) * (R + len / 2));
      spoke.rotation.z = Math.PI / 2;
      spoke.rotation.y = -a;
      this.ring.add(spoke);
      // ring segments / habitat pods
      const pod = new THREE.Mesh(new THREE.BoxGeometry(120, def.ringTube * 2.4, def.ringTube * 2.4), darkMat);
      pod.position.set(Math.cos(a + 0.26) * def.ringRadius, 0, Math.sin(a + 0.26) * def.ringRadius);
      pod.rotation.y = -(a + 0.26) + Math.PI / 2;
      this.ring.add(pod);
      this.addBlinker(new THREE.Vector3(Math.cos(a) * (def.ringRadius + def.ringTube + 4), 0, Math.sin(a) * (def.ringRadius + def.ringTube + 4)), i % 2 ? new THREE.Color(0.4, 4, 0.8) : new THREE.Color(5, 0.5, 0.4), 30, 0.8, i / 6, this.ring);
    }
    this.group.add(this.ring);

    // --- Docking hangar facing the player spawn (+Z)
    const hangar = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(200, 110, 160), hullMat);
    hangar.add(frame);
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(160, 70), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.7, 1.6), toneMapped: false }));
    mouth.position.z = 80.5;
    hangar.add(mouth);
    const inner = new THREE.Mesh(new THREE.PlaneGeometry(150, 62), new THREE.MeshBasicMaterial({ color: 0x050a12 }));
    inner.position.z = 81;
    hangar.add(inner);
    // guide lights along the approach
    for (let i = 0; i < 8; i++) {
      for (const sx of [-1, 1]) {
        this.addBlinker(new THREE.Vector3(sx * 95, -50, 100 + i * 45), new THREE.Color(0.6, 2.5, 5), 10, 2.0, i * 0.1, hangar);
      }
    }
    const arms = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 380), darkMat);
    for (const sx of [-1, 1]) {
      const a = arms.clone();
      a.position.set(sx * 95, -58, 260);
      hangar.add(a);
    }
    hangar.position.set(0, 0, R + 50);
    this.group.add(hangar);

    // Comm dishes
    for (let i = 0; i < 3; i++) {
      const dish = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16, 0, Math.PI * 2, 0, Math.PI / 3), hullMat);
      dish.material = hullMat;
      const a = i * 2.1 + 0.6;
      dish.position.set(Math.cos(a) * 60, -R * 1.25 - 10 - i * 40, Math.sin(a) * 60);
      dish.rotation.set(Math.PI * 0.75, a, 0);
      this.group.add(dish);
    }

    // --- Shuttle traffic
    const shuttleGeo = new THREE.BoxGeometry(6, 3, 14);
    const shuttleMat = new THREE.MeshStandardMaterial({ color: 0xd8dde4, metalness: 0.6, roughness: 0.4 });
    const tail = new THREE.SpriteMaterial({ map: makeRadialTexture([[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]), color: new THREE.Color(1, 2.5, 5), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    for (let i = 0; i < 14; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(shuttleGeo, shuttleMat));
      const t = new THREE.Sprite(tail);
      t.position.z = 8;
      t.scale.setScalar(9);
      g.add(t);
      this.group.add(g);
      this.shuttles.push({
        mesh: g,
        radius: def.ringRadius + 120 + rand() * 500,
        height: (rand() - 0.5) * 500,
        speed: (0.02 + rand() * 0.03) * (rand() < 0.5 ? 1 : -1),
        phase: rand() * Math.PI * 2,
      });
    }

    this.group.position.copy(def.position);
  }

  private addBlinker(pos: THREE.Vector3, color: THREE.Color, size: number, rate: number, phase: number, parent: THREE.Object3D = this.group) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: blinkTex(),
        color,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    sprite.position.copy(pos);
    sprite.scale.setScalar(size);
    parent.add(sprite);
    this.blinkers.push({ sprite, phase, rate });
  }

  update(time: number) {
    this.ring.rotation.y = time * 0.02;
    for (const b of this.blinkers) {
      const t = (time * b.rate + b.phase) % 1;
      b.sprite.material.opacity = t < 0.12 ? 1 : 0.08;
    }
    for (const s of this.shuttles) {
      const a = s.phase + time * s.speed;
      const x = Math.cos(a) * s.radius;
      const z = Math.sin(a) * s.radius;
      s.mesh.position.set(x, s.height + Math.sin(a * 3) * 30, z);
      const dx = -Math.sin(a) * Math.sign(s.speed);
      const dz = Math.cos(a) * Math.sign(s.speed);
      s.mesh.lookAt(s.mesh.position.x - dx, s.mesh.position.y, s.mesh.position.z - dz);
    }
  }
}

let _blink: THREE.Texture | null = null;
function blinkTex() {
  return (_blink ??= makeRadialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.15, 'rgba(255,255,255,0.8)'],
    [0.4, 'rgba(255,255,255,0.15)'],
    [1, 'rgba(255,255,255,0)'],
  ]));
}
