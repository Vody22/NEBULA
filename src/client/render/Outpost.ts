import * as THREE from 'three';
import { FERRO_MOUTH_Z, type StationDef } from '../../shared/sim/zone';
import { GlowField, type Glow } from './batches';
import { mergeByMaterial } from './merge';
import { radiatorSkin, siloSkin } from './depotSkins';
import { bayBanner, furnishHangar } from './hangarKit';
import { hullSkin } from './hullSkin';
import { makeShipSheet } from './shipTextures';
import { makeWindowTexture, plating, truss } from './stationKit';
import { makeRadialTexture } from './textures';

interface Blinker {
  glow: Glow;
  phase: number;
  rate: number;
  kind: 'beacon' | 'strobe' | 'chase';
}

// Hangar of the depot: smaller than Aurora-7's, same construction.
const HW = 130;
const HH = 76;
const HD = 100;
const WALL = 10;
/** The hangar's centre, so that its mouth lands on FERRO_MOUTH_Z. */
const HANGAR_Z = FERRO_MOUTH_Z - HD / 2;

/**
 * Dépôt Ferro-9: a working mining depot, a fraction of Aurora-7's size.
 * Habitat stack with a few lit decks, an ore refinery, four ore silos, a long
 * drill arm reaching into the belt, radiators, and a small hangar facing the
 * hub with sequential approach lights. Parts and sizes match the server
 * colliders (FERRO_PARTS in zone.ts). A procedural model built in code, not
 * a finished art asset.
 */
export class Outpost {
  readonly group = new THREE.Group();
  /** Fine detail, hidden beyond a few kilometres. */
  private detail = new THREE.Group();
  private drill = new THREE.Group();
  private lights: GlowField;
  private blinkers: Blinker[] = [];
  private pad = new THREE.Vector3(-28, -HH / 2 + WALL, HANGAR_Z + 8);
  private _cam = new THREE.Vector3();

  constructor(def: StationDef) {
    this.lights = new GlowField(
      makeRadialTexture([
        [0, 'rgba(255,255,255,1)'],
        [0.15, 'rgba(255,255,255,0.8)'],
        [0.4, 'rgba(255,255,255,0.15)'],
        [1, 'rgba(255,255,255,0)'],
      ]),
    );
    // Worn, darker plating than the hub: a frontier industrial site.
    const sheet = makeShipSheet({ seed: 21, base: '#9fa3a6' });
    const darkSheet = makeShipSheet({ seed: 23, base: '#4f535a', dark: true, size: 512 });
    const hullMat = new THREE.MeshStandardMaterial({
      map: sheet.map,
      normalMap: sheet.normalMap,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: sheet.orm,
      metalnessMap: sheet.orm,
      roughness: 1,
      metalness: 1,
      color: 0xc4c2bd,
    });
    const habMat = hullMat.clone();
    habMat.emissiveMap = makeWindowTexture(57);
    habMat.emissive = new THREE.Color(1.0, 0.82, 0.62);
    const darkMat = new THREE.MeshStandardMaterial({
      map: darkSheet.map,
      normalMap: darkSheet.normalMap,
      roughnessMap: darkSheet.orm,
      metalnessMap: darkSheet.orm,
      roughness: 1,
      metalness: 0.45,
      color: 0x9a9890,
    });
    // Hazard-painted structure: the depot's signature colour.
    // Kepler's ice depot wears blue hazard paint where Ferro-9 wears ochre.
    const ochreMat = new THREE.MeshStandardMaterial({ color: def.livery === 'kepler' ? 0x2f78a8 : 0xb5822e, metalness: 0.3, roughness: 0.65 });
    // The same paint on plated surfaces: worn panels, chipped edges.
    const paintSheet = makeShipSheet({ seed: 31, base: def.livery === 'kepler' ? '#3a7fae' : '#bf8a34', size: 512 });
    const paintMat = new THREE.MeshStandardMaterial({
      map: paintSheet.map,
      normalMap: paintSheet.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughnessMap: paintSheet.orm,
      metalnessMap: paintSheet.orm,
      roughness: 1,
      metalness: 0.5,
    });
    const strutMat = new THREE.MeshStandardMaterial({ color: 0x6f747a, metalness: 0.85, roughness: 0.5 });
    const radiatorMat = radiatorSkin(17);
    const amber = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 0.9, 0.35), toneMapped: false });
    const field = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.7, 0.4, 0.1),
      transparent: true,
      opacity: 0.06,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.group) => {
      const m = new THREE.Mesh(geo, mat);
      parent.add(m);
      return m;
    };
    const cyl = (r: number, h: number, x: number, y: number, z: number, mat: THREE.Material, parent?: THREE.Object3D, seg = 32) => {
      const g = plating(new THREE.CylinderGeometry(r, r, h, seg, 1), Math.PI * 2 * r, h);
      g.translate(x, y, z);
      return add(g, mat, parent);
    };

    // ── Habitat stack (collider spheres at y 0 and ±78) ──────────────────
    const hx = 0;
    const hz = -45;
    cyl(56, 74, hx, 0, hz, habMat);
    cyl(42, 52, hx, 70, hz, habMat);
    cyl(42, 52, hx, -70, hz, habMat);
    for (const y of [-38, 38]) cyl(60, 6, hx, y, hz, darkMat);
    for (const y of [-97, 97]) {
      const cap = new THREE.SphereGeometry(42, 32, 10, 0, Math.PI * 2, 0, Math.PI / 2);
      if (y < 0) cap.rotateX(Math.PI);
      cap.scale(1, 0.35, 1);
      cap.translate(hx, y - Math.sign(y) * 1, hz);
      add(plating(cap, 260, 60), hullMat);
    }
    // Antenna mast and beacon on top.
    cyl(1.6, 70, hx, 140, hz, strutMat, this.group, 6);
    this.addBlinker(new THREE.Vector3(hx, 176, hz), new THREE.Color(5, 0.6, 0.4), 9, 0.5, 0, 'beacon');
    this.addBlinker(new THREE.Vector3(hx, -112, hz), new THREE.Color(5, 5, 5), 7, 0.7, 0.3, 'strobe');

    // ── Hangar facing the hub (+Z) ────────────────────────────────────
    const hangar = new THREE.Group();
    const shell: [number, number, number, number, number, number][] = [
      [HW, WALL, HD, 0, HH / 2 - WALL / 2, 0],
      [HW, WALL, HD, 0, -HH / 2 + WALL / 2, 0],
      [WALL, HH, HD, -HW / 2 + WALL / 2, 0, 0],
      [WALL, HH, HD, HW / 2 - WALL / 2, 0, 0],
      [HW, HH, WALL, 0, 0, -HD / 2 + WALL / 2],
    ];
    for (const [w, h, d, x, y, z] of shell) {
      const b = plating(new THREE.BoxGeometry(w, h, d), Math.max(w, d), Math.max(h, d));
      b.translate(x, y, z);
      add(b, hullMat, hangar);
    }
    const innerW = HW - WALL * 2;
    const innerH = HH - WALL * 2;
    const kepler = def.livery === 'kepler';
    const tag = def.name.replace(/^Dépôt\s+/i, '').toUpperCase();
    // Outer skin of the shell: plates, livery, name, lights.
    {
      const style = { base: kepler ? [150, 160, 172] : [160, 158, 152], accent: kepler ? '#2f78a8' : '#b5822e', seed: kepler ? 71 : 37 };
      const face = (m: THREE.Mesh, rx: number, ry: number, x: number, y: number, z: number) => {
        m.geometry.rotateX(rx);
        m.geometry.rotateY(ry);
        m.geometry.translate(x, y, z);
        hangar.add(m);
      };
      face(hullSkin({ w: HW, h: HD, maxPx: 1024, name: tag, nameSize: 16 }, style), -Math.PI / 2, 0, 0, HH / 2 + 0.05, 0);
      face(hullSkin({ w: HW, h: HD, maxPx: 512 }, { ...style, seed: style.seed + 1 }), Math.PI / 2, 0, 0, -HH / 2 - 0.05, 0);
      for (const sx of [-1, 1]) {
        face(
          hullSkin({ w: HD, h: HH, maxPx: 1024, band: 0.6, windows: true, name: tag, nameSize: 8, lights: true, mouth: sx < 0 ? 'right' : 'left' }, { ...style, seed: style.seed + 3 + sx }),
          0,
          sx < 0 ? -Math.PI / 2 : Math.PI / 2,
          sx * (HW / 2 + 0.05),
          0,
          0,
        );
      }
    }
    hangar.add(
      furnishHangar(
        {
          w: HW,
          h: HH,
          d: HD,
          wall: WALL,
          accent: kepler ? '#3fa6d6' : '#d9902a',
          light: new THREE.Color(2.4, 2.1, 1.7),
          name: tag,
          bay: 'D1',
          pads: [[this.pad.x, 8]],
          ribEvery: 20,
          seed: kepler ? 91 : 19,
        },
        darkMat,
      ),
    );
    const banner = bayBanner(`DÉPÔT ${tag}`, kepler ? '#3fa6d6' : '#d9902a', 70);
    banner.position.set(0, HH / 2 + 12, HD / 2 + 2.2);
    hangar.add(banner);
    // Ochre mouth frame.
    for (const sx of [-1, 1]) {
      const post = plating(new THREE.BoxGeometry(8, HH + 10, 8), 8, HH + 10);
      post.translate(sx * (HW / 2 + 2), 0, HD / 2 - 2);
      add(post, paintMat, hangar);
    }
    const lintel = plating(new THREE.BoxGeometry(HW + 12, 8, 8), HW + 12, 8);
    lintel.translate(0, HH / 2 + 2, HD / 2 - 2);
    add(lintel, paintMat, hangar);
    add(lintel.clone().translate(0, -HH - 4, 0), paintMat, hangar);
    const fieldPlane = new THREE.PlaneGeometry(innerW, innerH);
    fieldPlane.translate(0, 0, HD / 2 - 1);
    add(fieldPlane, field, hangar);
    // Short approach arms with chase lights toward the mouth.
    for (const sx of [-1, 1]) {
      for (const g of truss(new THREE.Vector3(sx * 62, -40, HD / 2), new THREE.Vector3(sx * 62, -40, HD / 2 + 200), 6, 20, 0.6)) add(g, strutMat, hangar);
      for (let i = 0; i < 6; i++) {
        this.addBlinker(new THREE.Vector3(sx * 62, -34, HD / 2 + 200 - i * 36), new THREE.Color(4.5, 2.2, 0.5), 7, 0.8, i * 0.08, 'chase', hangar);
      }
    }
    hangar.position.set(0, 0, HANGAR_Z);
    this.group.add(hangar);
    // Pressurised tunnel from the hangar's back wall to the habitat.
    const tunnel = plating(new THREE.BoxGeometry(26, 22, 40), 40, 26);
    tunnel.translate(0, 0, HANGAR_Z - HD / 2 - 10);
    add(tunnel, darkMat);

    // ── Refinery (collider at -165, -10, -55) ─────────────────────────
    const ref = plating(new THREE.BoxGeometry(120, 64, 96), 120, 96);
    ref.translate(-165, -10, -55);
    add(ref, darkMat);
    const hopper = new THREE.CylinderGeometry(34, 14, 40, 8, 1);
    hopper.translate(-165, 42, -55);
    add(plating(hopper, 180, 40), paintMat);
    for (let i = 0; i < 3; i++) cyl(6, 46, -205 + i * 40, 40, -92, strutMat, this.group, 12);
    // Furnace vents: a dull amber glow on the side facing the belt.
    for (let i = 0; i < 4; i++) {
      const vent = new THREE.BoxGeometry(14, 3, 1);
      vent.translate(-195 + i * 20, -22, -104);
      add(vent, amber);
    }
    for (const g of truss(new THREE.Vector3(-105, 0, -50), new THREE.Vector3(-56, 0, -45), 10, 12, 0.9)) add(g, strutMat);

    // ── Ore silos (collider at 140, 0, -85) ───────────────────────────
    // Two painted variants, so neighbours differ; the wall texture wraps
    // once around (no plating rescale).
    const siloMats = [1, 2].map((n) =>
      siloSkin({
        circumference: Math.PI * 2 * 19,
        height: 108,
        code: `${kepler ? 'GL' : 'FE'}-0${n}`,
        cargo: kepler ? 'GLACE BRUTE' : 'MINERAI BRUT',
        accent: kepler ? '#3a7fae' : '#bf8a34',
        bands: [14, 54, 94],
        seed: (kepler ? 140 : 40) + n,
      }),
    );
    [
      [-24, -24],
      [24, -24],
      [-24, 24],
      [24, 24],
    ].forEach(([dx, dz], i) => {
      const g = new THREE.CylinderGeometry(19, 19, 108, 40, 1);
      g.rotateY(i * 1.3);
      g.translate(140 + dx, 0, -85 + dz);
      add(g, siloMats[i % 2]);
      for (const y of [-40, 0, 40]) cyl(20, 3, 140 + dx, y, -85 + dz, paintMat);
    });
    for (const g of truss(new THREE.Vector3(55, 10, -55), new THREE.Vector3(100, 10, -75), 10, 12, 0.9)) add(g, strutMat);

    // ── Radiators on the habitat's flanks ─────────────────────────────
    for (const sx of [-1, 1]) {
      for (const g of truss(new THREE.Vector3(sx * 40, 70, hz), new THREE.Vector3(sx * 150, 120, hz), 5, 15, 0.5)) add(g, strutMat, this.detail);
      const panel = new THREE.PlaneGeometry(90, 38);
      panel.rotateX(-Math.PI / 2);
      panel.rotateZ(sx * 0.42);
      panel.translate(sx * 105, 100, hz);
      add(panel, radiatorMat, this.detail);
    }

    // ── Drill arm into the belt (collider at 0, -70, -430) ────────────
    for (const g of truss(new THREE.Vector3(0, -40, -100), new THREE.Vector3(0, -70, -400), 12, 25, 1)) add(g, ochreMat);
    const housing = plating(new THREE.CylinderGeometry(20, 24, 34, 16, 1), 140, 34);
    housing.rotateX(Math.PI / 2);
    housing.translate(0, -70, -405);
    add(housing, darkMat);
    const bit = new THREE.ConeGeometry(16, 40, 10, 1);
    bit.rotateX(-Math.PI / 2);
    bit.translate(0, 0, -20);
    add(bit, strutMat, this.drill);
    this.drill.position.set(0, -70, -422);
    this.drill.userData.dynamic = true;
    this.group.add(this.drill);
    for (const sx of [-1, 1]) {
      this.lights.add(this.group, new THREE.Color(5, 3, 1.2), 14, new THREE.Vector3(sx * 22, -60, -415));
    }
    this.addBlinker(new THREE.Vector3(0, -48, -400), new THREE.Color(5, 0.6, 0.4), 6, 0.6, 0.5, 'beacon');

    // Strobes on the extremities, as on every structure in the sector.
    for (const p of [
      [-225, -10, -55],
      [165, 60, -85],
      [0, -70, -450],
    ]) {
      this.addBlinker(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Color(5, 5, 5), 8, 0.6, Math.random(), 'strobe');
    }

    this.detail.userData.dynamic = true;
    this.group.add(this.detail, this.lights.mesh);
    mergeByMaterial(this.group);
    mergeByMaterial(this.detail);
    mergeByMaterial(this.drill);
    // After merging: the model is built in its own frame, then placed.
    this.group.position.copy(def.position);
    this.group.rotation.y = def.yaw;
  }

  private addBlinker(pos: THREE.Vector3, color: THREE.Color, size: number, rate: number, phase: number, kind: Blinker['kind'], parent: THREE.Object3D = this.group) {
    this.blinkers.push({ glow: this.lights.add(parent, color, size, pos), phase, rate, kind });
  }

  /** Same framing as Aurora-7's hangar, scaled to the smaller bay (world coordinates). */
  dockedView(time: number, ship: THREE.Vector3, cam: THREE.Vector3, target: THREE.Vector3) {
    this.group.updateMatrixWorld();
    const p = this.pad;
    this.group.localToWorld(ship.set(p.x, p.y + 4.2, p.z));
    this.group.localToWorld(cam.set(p.x + 20 + Math.sin(time * 0.07) * 2, p.y + 10 + Math.sin(time * 0.05), p.z + 30));
    this.group.localToWorld(target.set(p.x + 17, p.y + 5.2, p.z - 4));
  }

  /** The way a ship parked in the bay faces: out of the mouth. */
  parkedRotation(out: THREE.Quaternion) {
    return out.setFromAxisAngle(_up, this.group.rotation.y + Math.PI);
  }

  update(time: number, camPos?: THREE.Vector3) {
    this.drill.rotation.z = time * 1.4;
    if (camPos) this.detail.visible = this._cam.copy(camPos).sub(this.group.position).length() < 5000;
    for (const b of this.blinkers) {
      const t = (((time * b.rate - b.phase) % 1) + 1) % 1;
      let on: number;
      if (b.kind === 'strobe') on = t < 0.04 || (t > 0.12 && t < 0.16) ? 1 : 0;
      else if (b.kind === 'chase') on = t < 0.1 ? 1 : 0.1;
      else on = 0.15 + 0.85 * Math.exp(-((t - 0.1) ** 2) / 0.004);
      b.glow.opacity = on;
    }
  }
}

const _up = new THREE.Vector3(0, 1, 0);
