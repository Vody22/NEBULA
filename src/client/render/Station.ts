import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng';
import type { StationDef } from '../../shared/sim/zone';
import { GlowField, type Glow } from './batches';
import { mergeByMaterial } from './merge';
import { makeShipSheet } from './shipTextures';
import { beam, makeWindowTexture, plating, truss } from './stationKit';
import { makeRadialTexture, makeSolarTexture } from './textures';

interface Blinker {
  glow: Glow;
  phase: number;
  rate: number;
  /** 'beacon': one slow pulse; 'strobe': a double white flash; 'chase': sequential approach light. */
  kind: 'beacon' | 'strobe' | 'chase';
}

interface Orbiter {
  mesh: THREE.Object3D;
  radius: number;
  height: number;
  speed: number;
  phase: number;
  wobble: number;
}

interface Approach {
  mesh: THREE.Object3D;
  x: number;
  y: number;
  phase: number;
}

/**
 * Station Aurora-7: a kilometre-scale industrial hub. Armoured core with
 * windows by deck, lattice spokes and glass walkways to the rotating habitat
 * ring, radiators, solar arrays, a hangar lit from inside with sequential
 * approach lights and a faint containment field, cargo yards with cranes and
 * containers, drones and approach traffic. Dimensions match the server
 * colliders in zone.ts (core, spine, ring); the rest is decoration.
 */
export class Station {
  readonly group = new THREE.Group();
  private ring = new THREE.Group();
  /** Fine detail, hidden beyond a few kilometres. */
  private detail = new THREE.Group();
  private blinkers: Blinker[] = [];
  /** Every blinker in one draw call, every shuttle and drone light in another. */
  private lights = new GlowField(blinkTex());
  private traffic: GlowField;
  private orbiters: Orbiter[] = [];
  private approaches: Approach[] = [];
  private mouthZ = 300;
  /** Landing pad where a docked ship is shown, and the bay floor height (station coordinates). */
  private pad = new THREE.Vector3();
  private _cam = new THREE.Vector3();

  constructor(def: StationDef) {
    const rand = mulberry32(777);
    const R = def.coreRadius;

    // ── Materials ──────────────────────────────────────────────────────
    // The Kepler sector's hubs: cooler, bluer plating and pale teal signal lines instead of amber.
    const kepler = def.livery === 'kepler';
    const sheet = makeShipSheet({ seed: 7, base: kepler ? '#a9b4c2' : '#b4b9c0' });
    const darkSheet = makeShipSheet({ seed: 9, base: '#5a5f67', dark: true, size: 512 });
    const windows = makeWindowTexture(41);
    const hullMat = new THREE.MeshStandardMaterial({
      map: sheet.map,
      normalMap: sheet.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughnessMap: sheet.orm,
      metalnessMap: sheet.orm,
      roughness: 1,
      metalness: 1,
      color: kepler ? 0xcdd6e2 : 0xd6d8dc,
    });
    // Habitat sections: the same plating with lit windows.
    const habMat = hullMat.clone();
    habMat.emissiveMap = windows;
    habMat.emissive = new THREE.Color(1.0, 0.85, 0.7);
    const darkMat = new THREE.MeshStandardMaterial({
      map: darkSheet.map,
      normalMap: darkSheet.normalMap,
      roughnessMap: darkSheet.orm,
      metalnessMap: darkSheet.orm,
      roughness: 1,
      // Painted steel rather than bare metal: bare metal mirrors black space.
      metalness: 0.45,
      color: 0xa4a8b0,
    });
    const strutMat = new THREE.MeshStandardMaterial({ color: 0x7d838a, metalness: 0.85, roughness: 0.45 });
    const solarMat = new THREE.MeshStandardMaterial({ map: makeSolarTexture(), metalness: 0.9, roughness: 0.25, envMapIntensity: 1.4 });
    const radiatorMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.2, roughness: 0.7, side: THREE.DoubleSide });
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0c1c28,
      roughness: 0.1,
      metalness: 0,
      clearcoat: 1,
      transparent: true,
      opacity: 0.45,
      envMapIntensity: 2,
    });
    // Emissive trims stay thin and dim: signals, not decoration.
    const amber = new THREE.MeshBasicMaterial({ color: kepler ? new THREE.Color(0.5, 1.45, 1.3) : new THREE.Color(1.6, 0.95, 0.42), toneMapped: false });
    const cyan = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 1.2, 2.0), toneMapped: false });
    // Hangar bay: matte deck plating lit by its own strips, no sky reflection.
    const hangarInside = new THREE.MeshStandardMaterial({
      map: darkSheet.map,
      color: 0x6a6e75,
      metalness: 0,
      roughness: 0.9,
      envMapIntensity: 0.2,
      side: THREE.BackSide,
      emissive: new THREE.Color(0.05, 0.045, 0.04),
    });
    const field = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.12, 0.35, 0.7),
      transparent: true,
      opacity: 0.07,
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

    // ── Core: armoured hub in stacked sections with visible joints ──────
    const prof: [number, number][] = [
      [0.0, -1.25], [0.35, -1.2], [0.55, -1.0], [0.62, -0.85], [0.9, -0.7], [1.0, -0.4], [1.02, -0.1],
      [1.08, 0.0], [1.02, 0.1], [1.0, 0.4], [0.9, 0.7], [0.62, 0.85], [0.55, 1.0], [0.35, 1.2], [0.0, 1.25],
    ];
    const lathe = (pts: [number, number][], scale = 1) =>
      new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x * R * scale, y * R)), 96);
    // Armour bands (painted) and the habitat belt with windows between them.
    const upper = prof.filter(([, y]) => y >= 0.42);
    const lower = prof.filter(([, y]) => y <= -0.42);
    const belt = prof.filter(([, y]) => y >= -0.42 && y <= 0.42);
    add(plating(lathe(upper), 2 * Math.PI * R, 0.9 * R), hullMat);
    add(plating(lathe(lower), 2 * Math.PI * R, 0.9 * R), hullMat);
    add(plating(lathe(belt, 1.004), 2 * Math.PI * R, 0.9 * R), habMat);
    // Dark joint rings at the section seams.
    for (const y of [-0.42, 0.42]) {
      const seam = new THREE.TorusGeometry(R * 0.985, 3, 6, 96);
      seam.rotateX(Math.PI / 2);
      seam.translate(0, y * R, 0);
      add(seam, darkMat);
    }
    // One thin amber line at the equator.
    const eq = new THREE.TorusGeometry(R * 1.083, 0.9, 6, 128);
    eq.rotateX(Math.PI / 2);
    add(eq, amber);

    // ── Spine: dark structural column, habitat and machinery modules ────
    const spineR = 42;
    add(plating(new THREE.CylinderGeometry(spineR, spineR, def.spineLength, 48, 1), 2 * Math.PI * spineR, def.spineLength), darkMat);
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const y = sgn * (R * 1.3 + i * 85);
        const kind = i % 3;
        let geo: THREE.BufferGeometry;
        let mat: THREE.Material = hullMat;
        if (kind === 0) {
          geo = plating(new THREE.CylinderGeometry(75, 75, 50, 32), 2 * Math.PI * 75, 50);
          mat = habMat;
        } else if (kind === 1) {
          // Octagonal machinery block.
          geo = plating(new THREE.CylinderGeometry(72, 72, 60, 8), 2 * Math.PI * 72, 60);
          mat = darkMat;
        } else {
          geo = plating(new THREE.CylinderGeometry(60, 70, 40, 32), 2 * Math.PI * 70, 40);
          mat = habMat;
        }
        geo.rotateY(i * 0.4);
        geo.translate(0, y, 0);
        add(geo, mat);
        // Collars between modules.
        const collar = new THREE.CylinderGeometry(spineR + 6, spineR + 6, 8, 32);
        collar.translate(0, y + sgn * 38, 0);
        add(collar, strutMat);
      }
      const cap = plating(new THREE.ConeGeometry(70, 120, 32), 2 * Math.PI * 70, 120);
      if (sgn < 0) cap.rotateX(Math.PI);
      cap.translate(0, sgn * (def.spineLength / 2 + 50), 0);
      add(cap, hullMat);
      const mast = new THREE.CylinderGeometry(2, 4, 260, 6);
      mast.translate(0, sgn * (def.spineLength / 2 + 230), 0);
      add(mast, strutMat);
      // Red beacon at each end, white strobe on the mast.
      this.addBlinker(new THREE.Vector3(0, sgn * (def.spineLength / 2 + 362), 0), new THREE.Color(5, 0.5, 0.35), 55, 0.7, rand(), 'beacon');
      this.addBlinker(new THREE.Vector3(0, sgn * (def.spineLength / 2 + 180), 0), new THREE.Color(4, 4, 4.4), 40, 0.6, rand(), 'strobe');
    }

    // ── Solar arrays on the upper spine, radiators on the lower spine ───
    for (const sgn of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        for (const g of truss(new THREE.Vector3(sgn * 44, 380 + k * 55, 0), new THREE.Vector3(sgn * 300, 380 + k * 55, 0), 6, 18, 0.7)) add(g, strutMat);
        const panel = new THREE.BoxGeometry(220, 1.2, 48);
        panel.rotateX(0.35);
        panel.translate(sgn * 200, 380 + k * 55, 0);
        add(panel, solarMat);
      }
      this.addBlinker(new THREE.Vector3(sgn * 312, 435, 0), new THREE.Color(5, 0.5, 0.35), 26, 0.7, rand(), 'beacon');
      // Radiator wings: thin panels with ribs, edge-on to the sun.
      for (let k = 0; k < 2; k++) {
        const y = -380 - k * 70;
        for (const g of truss(new THREE.Vector3(0, y, sgn * 44), new THREE.Vector3(0, y, sgn * 230), 5, 16, 0.6)) add(g, strutMat);
        const rad = new THREE.PlaneGeometry(180, 46);
        rad.rotateY(Math.PI / 2);
        rad.translate(0, y + 28, sgn * 140);
        add(rad, radiatorMat);
        for (let r = 0; r < 12; r++) {
          const rib = new THREE.BoxGeometry(1.2, 46, 1.2);
          rib.translate(0, y + 28, sgn * (54 + r * 15.6));
          add(rib, strutMat, this.detail);
        }
      }
    }

    // ── Rotating habitat ring, lattice spokes, glass walkways ───────────
    const ringGeo = plating(new THREE.TorusGeometry(def.ringRadius, def.ringTube, 48, 256), 2 * Math.PI * def.ringRadius, 2 * Math.PI * def.ringTube);
    ringGeo.rotateX(Math.PI / 2);
    add(ringGeo, habMat, this.ring);
    // Armour joints every 30° around the ring.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const joint = new THREE.TorusGeometry(def.ringTube * 1.03, 2.5, 6, 48);
      // The joint wraps the tube: its axis follows the ring's tangent.
      joint.rotateY(-a);
      joint.translate(Math.cos(a) * def.ringRadius, 0, Math.sin(a) * def.ringRadius);
      add(joint, darkMat, this.ring);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const dirv = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const from = dirv.clone().multiplyScalar(R * 0.98);
      const to = dirv.clone().multiplyScalar(def.ringRadius - def.ringTube * 0.8);
      for (const g of truss(from, to, 16, 20, 1.3)) add(g, strutMat, this.ring);
      // Pressurised walkway beside the truss, with its light strip.
      const side = new THREE.Vector3(-dirv.z, 0, dirv.x).multiplyScalar(18);
      const tube = new THREE.CylinderGeometry(5, 5, to.distanceTo(from), 16, 1, true);
      tube.rotateZ(Math.PI / 2);
      tube.rotateY(-a);
      tube.translate((from.x + to.x) / 2 + side.x, 0, (from.z + to.z) / 2 + side.z);
      add(tube, glassMat, this.ring);
      add(beam(from.clone().add(side).setY(-3.5), to.clone().add(side).setY(-3.5), 0.5), amber, this.ring);
      // Habitat pods on the ring.
      const pa = a + 0.26;
      // Pressure hull lying along the ring: a capsule thicker than the tube.
      const podR = def.ringTube * 1.18;
      const pod = plating(new THREE.CapsuleGeometry(podR, 90, 8, 32), 2 * Math.PI * podR, 90 + 2 * podR);
      pod.rotateZ(Math.PI / 2);
      pod.rotateY(-pa + Math.PI / 2);
      pod.translate(Math.cos(pa) * def.ringRadius, 0, Math.sin(pa) * def.ringRadius);
      add(pod, hullMat, this.ring);
      for (const e of [-1, 1]) {
        const band = new THREE.TorusGeometry(podR * 1.01, 2.2, 6, 48);
        band.rotateY(-pa + Math.PI);
        band.translate(Math.cos(pa) * def.ringRadius + Math.cos(pa + Math.PI / 2) * e * 45, 0, Math.sin(pa) * def.ringRadius + Math.sin(pa + Math.PI / 2) * e * 45);
        add(band, darkMat, this.ring);
      }
      // Red anti-collision lights on the outer rim.
      this.addBlinker(
        new THREE.Vector3(Math.cos(a) * (def.ringRadius + def.ringTube + 4), 0, Math.sin(a) * (def.ringRadius + def.ringTube + 4)),
        new THREE.Color(5, 0.5, 0.35),
        26,
        0.8,
        i / 6,
        'beacon',
        this.ring,
      );
    }
    this.group.add(this.ring);

    // ── Hangar facing the player spawn (+Z): lit from inside ────────────
    const hangar = new THREE.Group();
    const HW = 200;
    const HH = 110;
    const HD = 160;
    const wall = 14;
    const shell: [number, number, number, number, number, number][] = [
      [HW, wall, HD, 0, HH / 2 - wall / 2, 0],
      [HW, wall, HD, 0, -HH / 2 + wall / 2, 0],
      [wall, HH, HD, -HW / 2 + wall / 2, 0, 0],
      [wall, HH, HD, HW / 2 - wall / 2, 0, 0],
      [HW, HH, wall, 0, 0, -HD / 2 + wall / 2],
    ];
    for (const [w, h, d, x, y, z] of shell) {
      const b = plating(new THREE.BoxGeometry(w, h, d), Math.max(w, d), Math.max(h, d));
      b.translate(x, y, z);
      add(b, hullMat, hangar);
    }
    // Interior: a dim bay, ceiling light strips and floor guide lines.
    const bay = new THREE.BoxGeometry(HW - wall * 2 - 2, HH - wall * 2 - 2, HD - wall - 1);
    bay.translate(0, 0, wall / 2);
    add(bay, hangarInside, hangar);
    for (let i = 0; i < 6; i++) {
      const strip = new THREE.BoxGeometry(HW - wall * 2 - 20, 1, 2);
      strip.translate(0, HH / 2 - wall - 1, -HD / 2 + wall + 12 + i * 22);
      add(strip, amber, hangar);
    }
    for (const sx of [-1, 1]) {
      const line = new THREE.BoxGeometry(1.5, 0.6, HD - wall - 10);
      line.translate(sx * 30, -HH / 2 + wall + 0.5, wall / 2);
      add(line, cyan, hangar);
    }
    // Structural ribs along the walls and ceiling, every 22 m.
    const innerW = HW - wall * 2;
    const innerH = HH - wall * 2;
    for (let i = 0; i < 6; i++) {
      const z = -HD / 2 + wall + 12 + i * 22 + 11;
      for (const sx of [-1, 1]) {
        const rib = new THREE.BoxGeometry(3, innerH - 2, 3);
        rib.translate(sx * (innerW / 2 - 2.5), 0, z);
        add(rib, darkMat, hangar);
      }
      const top = new THREE.BoxGeometry(innerW - 4, 3, 3);
      top.translate(0, innerH / 2 - 2.5, z);
      add(top, darkMat, hangar);
    }
    // Two landing pads (cyan rings) and a control room window on the back wall.
    for (const px of [-40, 40]) {
      const pad = new THREE.RingGeometry(13, 14.2, 48);
      pad.rotateX(-Math.PI / 2);
      pad.translate(px, -innerH / 2 + 0.7, 10);
      add(pad, cyan, hangar);
    }
    const control = new THREE.BoxGeometry(innerW * 0.6, 6, 1);
    control.translate(0, innerH / 2 - 16, -HD / 2 + wall + 0.6);
    add(control, amber, hangar);
    // Heavy mouth frame with side buttresses.
    for (const sx of [-1, 1]) {
      const side = new THREE.BoxGeometry(10, HH + 16, 10);
      side.translate(sx * (HW / 2 + 3), 0, HD / 2 - 2);
      add(side, darkMat, hangar);
      const fin = plating(new THREE.BoxGeometry(8, HH * 0.8, HD * 0.7), HD * 0.7, HH * 0.8);
      fin.translate(sx * (HW / 2 + 4), 0, -HD * 0.1);
      add(fin, hullMat, hangar);
    }
    const frameTop = new THREE.BoxGeometry(HW + 16, 10, 10);
    frameTop.translate(0, HH / 2 + 3, HD / 2 - 2);
    add(frameTop, darkMat, hangar);
    const frameBot = frameTop.clone().translate(0, -HH - 6, 0);
    add(frameBot, darkMat, hangar);
    const fieldPlane = new THREE.PlaneGeometry(HW - wall * 2, HH - wall * 2);
    fieldPlane.translate(0, 0, HD / 2 - 1);
    add(fieldPlane, field, hangar);
    // Approach arms with sequential lights running toward the mouth.
    for (const sx of [-1, 1]) {
      for (const g of truss(new THREE.Vector3(sx * 95, -58, HD / 2), new THREE.Vector3(sx * 95, -58, HD / 2 + 380), 8, 20, 0.8)) add(g, strutMat, hangar);
      for (let i = 0; i < 10; i++) {
        this.addBlinker(new THREE.Vector3(sx * 95, -50, HD / 2 + 380 - i * 40), new THREE.Color(0.5, 2.0, 4.5), 9, 0.8, i * 0.07, 'chase', hangar);
      }
    }
    // Its back wall stands just clear of the core's equator.
    const hangarZ = R * 1.08 + HD / 2 - wall + 4;
    hangar.position.set(0, 0, hangarZ);
    this.mouthZ = hangarZ + HD / 2;
    this.pad.set(-40, -innerH / 2, hangarZ + 10);
    // Docking is decided by the server from the shared zone: keep them together.
    if (Math.abs(def.position.z + this.mouthZ - def.dock.mouth.z) > 2) console.warn('NEBULA: entrée du hangar et zone d’amarrage décalées', this.mouthZ, def.dock.mouth.z);
    this.group.add(hangar);

    // ── Cargo yards beside the hangar: platforms, gantry cranes, containers
    const containers: { x: number; y: number; z: number; ry: number; c: THREE.Color }[] = [];
    const palette = [0xb5562a, 0x2f5f8a, 0xc9c9c4, 0x6b7076, 0x8a7a2e, 0x7a2f2f].map((h) => new THREE.Color(h));
    for (const sx of [-1, 1]) {
      const px = sx * 190;
      const py = -70;
      const pz = R + 70;
      const deckGeo = plating(new THREE.BoxGeometry(70, 5, 110), 70, 110);
      deckGeo.translate(px, py, pz);
      add(deckGeo, darkMat);
      // Support truss from the deck into the core, clear of the hangar.
      for (const g of truss(new THREE.Vector3(px - sx * 35, py, pz - 30), new THREE.Vector3(sx * 110, py + 5, R * 0.75), 8, 16, 0.8)) add(g, strutMat);
      // Gantry crane: two legs and a lattice boom.
      const cx = px - sx * 28;
      for (const lz of [-50, 50]) {
        for (const g of truss(new THREE.Vector3(cx, py + 3, pz + lz), new THREE.Vector3(cx, py + 40, pz + lz), 4, 10, 0.5)) add(g, strutMat, this.detail);
      }
      for (const g of truss(new THREE.Vector3(cx, py + 42, pz - 53), new THREE.Vector3(cx, py + 42, pz + 53), 5, 10, 0.5)) add(g, strutMat, this.detail);
      const trolley = new THREE.BoxGeometry(8, 5, 7);
      trolley.translate(cx + sx * 5, py + 38, pz + 10);
      add(trolley, hullMat, this.detail);
      this.addBlinker(new THREE.Vector3(cx, py + 47, pz - 53), new THREE.Color(5, 0.5, 0.35), 8, 0.9, rand(), 'beacon', this.detail);
      // Container stacks (12 × 2.6 × 2.6 m).
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 7; col++) {
          const h = 1 + Math.floor(rand() * 3);
          for (let k = 0; k < h; k++) {
            containers.push({
              x: px + sx * 8 + col * 3.2 * sx,
              y: py + 3 + 1.3 + k * 2.65,
              z: pz - 40 + row * 14,
              ry: Math.PI / 2,
              c: palette[Math.floor(rand() * palette.length)],
            });
          }
        }
      }
    }
    const boxMat = new THREE.MeshStandardMaterial({ map: darkSheet.map, color: 0xffffff, metalness: 0.4, roughness: 0.6 });
    const crates = new THREE.InstancedMesh(new THREE.BoxGeometry(12, 2.6, 2.6), boxMat, containers.length);
    const m4 = new THREE.Matrix4();
    containers.forEach((ct, i) => {
      m4.makeRotationY(ct.ry).setPosition(ct.x, ct.y, ct.z);
      crates.setMatrixAt(i, m4);
      crates.setColorAt(i, ct.c);
    });
    this.detail.add(crates);

    // Comm dishes under the core.
    for (let i = 0; i < 3; i++) {
      const dish = new THREE.SphereGeometry(40, 32, 16, 0, Math.PI * 2, 0, Math.PI / 3);
      const a = i * 2.1 + 0.6;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * 60, -R * 1.25 - 10 - i * 40, Math.sin(a) * 60),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 0.75, a, 0)),
        new THREE.Vector3(1, 1, 1),
      );
      dish.applyMatrix4(m);
      add(dish, radiatorMat);
    }

    // ── Traffic: shuttles around the station, drones by the ring, arrivals
    const glint = makeRadialTexture([
      [0, 'rgba(255,255,255,1)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
    const shuttleGeo = new THREE.BoxGeometry(6, 3, 14);
    const shuttleMat = new THREE.MeshStandardMaterial({ color: 0xd8dde4, metalness: 0.6, roughness: 0.4 });
    this.traffic = new GlowField(glint);
    const engine = new THREE.Color(1, 2.5, 5);
    const makeCraft = (scale: number, light: THREE.Color) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(shuttleGeo, shuttleMat);
      body.scale.setScalar(scale);
      g.add(body);
      this.traffic.add(g, light, 9 * scale, new THREE.Vector3(0, 0, 8 * scale));
      g.userData.dynamic = true;
      return g;
    };
    for (let i = 0; i < 12; i++) {
      const g = makeCraft(1, engine);
      this.group.add(g);
      this.orbiters.push({
        mesh: g,
        radius: def.ringRadius + 120 + rand() * 500,
        height: (rand() - 0.5) * 500,
        speed: (0.02 + rand() * 0.03) * (rand() < 0.5 ? 1 : -1),
        phase: rand() * Math.PI * 2,
        wobble: 30,
      });
    }
    const droneLight = new THREE.Color(2.5, 2.5, 2.2);
    for (let i = 0; i < 10; i++) {
      const g = makeCraft(0.25, droneLight);
      this.detail.add(g);
      this.orbiters.push({
        mesh: g,
        radius: def.ringRadius + (rand() - 0.5) * 140,
        height: def.ringTube + 12 + rand() * 30,
        speed: (0.01 + rand() * 0.02) * (rand() < 0.5 ? 1 : -1),
        phase: rand() * Math.PI * 2,
        wobble: 6,
      });
    }
    for (let i = 0; i < 3; i++) {
      const g = makeCraft(1.4, engine);
      this.group.add(g);
      this.approaches.push({ mesh: g, x: (i - 1) * 40, y: -20 + i * 15, phase: i / 3 });
    }

    // Static parts → a handful of draw calls (the ring rotates and the
    // detail group switches off with distance, so each is merged on its own).
    this.ring.userData.dynamic = true;
    this.detail.userData.dynamic = true;
    this.group.add(this.detail, this.lights.mesh, this.traffic.mesh);
    mergeByMaterial(this.group);
    mergeByMaterial(this.ring);
    mergeByMaterial(this.detail);
    this.group.position.copy(def.position);
  }

  /**
   * The docked view, in world coordinates: the pilot's ship on the left pad,
   * nose to the mouth, and a camera inside the bay near the mouth, drifting
   * slowly. The station screen covers the right of the picture.
   */
  dockedView(time: number, ship: THREE.Vector3, cam: THREE.Vector3, target: THREE.Vector3) {
    const o = this.group.position;
    ship.copy(this.pad).add(o).setY(o.y + this.pad.y + 4.2);
    cam.set(this.pad.x + 22 + Math.sin(time * 0.07) * 2, this.pad.y + 11 + Math.sin(time * 0.05), this.pad.z + 32).add(o);
    target.copy(ship).add(_look.set(19, 1, -4));
  }

  /** The way a ship parked in the bay faces: out of the mouth (+Z). */
  parkedRotation(out: THREE.Quaternion) {
    return out.setFromAxisAngle(_up, Math.PI);
  }

  private addBlinker(pos: THREE.Vector3, color: THREE.Color, size: number, rate: number, phase: number, kind: Blinker['kind'], parent: THREE.Object3D = this.group) {
    this.blinkers.push({ glow: this.lights.add(parent, color, size, pos), phase, rate, kind });
  }

  update(time: number, camPos?: THREE.Vector3) {
    // v0.8: the ring no longer turns. Its spokes swept through the hangar, which the
    // collision shapes (physics/structures.ts) would turn into a spoke sweeping docked ships.
    if (camPos) this.detail.visible = this._cam.copy(camPos).sub(this.group.position).length() < 5000;
    for (const b of this.blinkers) {
      const t = (((time * b.rate - b.phase) % 1) + 1) % 1;
      let on: number;
      if (b.kind === 'strobe') on = t < 0.04 || (t > 0.12 && t < 0.16) ? 1 : 0;
      else if (b.kind === 'chase') on = t < 0.1 ? 1 : 0.1;
      else on = 0.15 + 0.85 * Math.exp(-((t - 0.1) ** 2) / 0.004);
      b.glow.opacity = on;
    }
    for (const s of this.orbiters) {
      const a = s.phase + time * s.speed;
      const x = Math.cos(a) * s.radius;
      const z = Math.sin(a) * s.radius;
      s.mesh.position.set(x, s.height + Math.sin(a * 3) * s.wobble, z);
      const dx = -Math.sin(a) * Math.sign(s.speed);
      const dz = Math.cos(a) * Math.sign(s.speed);
      s.mesh.lookAt(s.mesh.position.x - dx, s.mesh.position.y, s.mesh.position.z - dz);
    }
    // Arrivals: from 3 km out, slowing down into the hangar mouth, then the next one.
    // They pass under the habitat ring, then climb to the mouth.
    const mouthZ = this.mouthZ;
    for (const a of this.approaches) {
      const t = (time / 70 + a.phase) % 1;
      const ease = 1 - (1 - t) * (1 - t);
      const z = 3000 - (3000 - mouthZ + 40) * ease;
      const under = THREE.MathUtils.smoothstep(z, mouthZ + 60, 720);
      a.mesh.position.set(a.x * (1 - ease), a.y * (1 - ease) - 140 * under, z);
      a.mesh.rotation.set(0, 0, 0);
      a.mesh.visible = t < 0.97;
    }
  }
}

const _look = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
let _blink: THREE.Texture | null = null;
function blinkTex() {
  return (_blink ??= makeRadialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.15, 'rgba(255,255,255,0.8)'],
    [0.4, 'rgba(255,255,255,0.15)'],
    [1, 'rgba(255,255,255,0)'],
  ]));
}
