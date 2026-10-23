import { Line3, Vector3 } from 'three';
import type { StationId } from '../economy/market';
import { mulberry32 } from '../rng';
import type { StaticCollider } from './types';

/**
 * A zone is the static layout of one region of space. It is generated
 * deterministically from a seed so the server and every client build the
 * exact same world (colliders on the server, visuals on the client)
 * without shipping geometry over the network.
 */
export interface PlanetDef {
  name: string;
  position: Vector3;
  radius: number;
  kind: 'gas' | 'rocky' | 'ice';
  colorA: [number, number, number];
  colorB: [number, number, number];
  atmosphere: [number, number, number];
  rings: boolean;
  seed: number;
}

export interface AsteroidDef {
  position: Vector3;
  radius: number;
  /** Visual-only rotation parameters */
  spinAxis: [number, number, number];
  spinSpeed: number;
  variant: number;
}

export interface StationDef {
  id: StationId;
  name: string;
  /** 'hub': the Aurora-7 model; 'outpost': the Ferro-9 mining depot. */
  kind: 'hub' | 'outpost';
  /** Turn of the model about +Y (rad); its hangar opens on local +Z. */
  yaw: number;
  position: Vector3;
  ringRadius: number;
  ringTube: number;
  coreRadius: number;
  spineLength: number;
  /** Docking: a ship slower than DOCK_MAX_SPEED within `radius` of the hangar mouth may dock. */
  dock: DockDef;
}

export interface DockDef {
  /** Hangar mouth, world coordinates. */
  mouth: Vector3;
  radius: number;
  /** Unit vector pointing out of the hangar (undocking ships leave along it). */
  out: Vector3;
}

export const DOCK_MAX_SPEED = 50;
/** Undocking ships appear this far out of the mouth, moving outward at UNDOCK_SPEED. */
export const UNDOCK_DISTANCE = 70;
export const UNDOCK_SPEED = 30;

export interface ZoneDef {
  id: string;
  name: string;
  seed: number;
  sunDirection: Vector3; // direction *towards* the sun
  /** The main station (Aurora-7). */
  station: StationDef;
  /** Every station a ship can dock at, the main one first. */
  stations: StationDef[];
  planets: PlanetDef[];
  asteroids: AsteroidDef[];
  beltCenter: Vector3;
  colliders: StaticCollider[];
  playerSpawn: Vector3;
}

export function buildZone(seed = 1337): ZoneDef {
  const rand = mulberry32(seed);
  // The hangar of the station model (Station.ts) opens on +Z, its mouth at
  // coreRadius × 1.08 + depth 160 − wall 14 + 4 ≈ 334 m from the centre.
  const station: StationDef = {
    id: 'aurora',
    name: 'Station Aurora-7',
    kind: 'hub',
    yaw: 0,
    position: new Vector3(0, 0, 0),
    ringRadius: 560,
    ringTube: 46,
    coreRadius: 170,
    spineLength: 1100,
    dock: { mouth: new Vector3(0, 0, 334), radius: 220, out: new Vector3(0, 0, 1) },
  };

  const planets: PlanetDef[] = [
    {
      name: 'Kerys',
      position: new Vector3(-26000, -6500, -52000),
      radius: 14000,
      kind: 'gas',
      colorA: [0.85, 0.52, 0.32],
      colorB: [0.35, 0.18, 0.28],
      atmosphere: [1.0, 0.55, 0.35],
      rings: true,
      seed: 11,
    },
    {
      name: 'Thalassa',
      position: new Vector3(30000, 7000, -26000),
      radius: 5200,
      kind: 'rocky',
      colorA: [0.12, 0.34, 0.55],
      colorB: [0.45, 0.42, 0.3],
      atmosphere: [0.35, 0.65, 1.0],
      rings: false,
      seed: 23,
    },
    {
      name: 'Nyx',
      position: new Vector3(23500, 9800, -19000),
      radius: 1100,
      kind: 'ice',
      colorA: [0.75, 0.8, 0.86],
      colorB: [0.42, 0.45, 0.52],
      atmosphere: [0.6, 0.75, 1.0],
      rings: false,
      seed: 37,
    },
  ];

  const beltCenter = new Vector3(2600, -250, -3800);
  const asteroids: AsteroidDef[] = [];
  const count = 520;
  for (let i = 0; i < count; i++) {
    // Flattened ellipsoidal cluster, denser in the middle.
    const a = rand() * Math.PI * 2;
    const r = Math.pow(rand(), 0.7) * 3000;
    const y = (rand() - 0.5) * 2 * 420 * (1 - r / 3600);
    const pos = new Vector3(Math.cos(a) * r, y, Math.sin(a) * r * 0.75).add(beltCenter);
    const big = rand() < 0.04;
    const radius = big ? 160 + rand() * 220 : 6 + Math.pow(rand(), 2.2) * 90;
    const ax = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    asteroids.push({
      position: pos,
      radius,
      spinAxis: [ax.x, ax.y, ax.z],
      spinSpeed: (rand() * 0.25 + 0.02) * (big ? 0.15 : 1),
      variant: Math.floor(rand() * 4),
    });
  }
  const ferro = buildFerro(station.position, beltCenter);
  // Keep the station approaches clear: around each station and along the depot's approach lane.
  const lane = new Line3(ferro.dock.mouth, ferro.dock.mouth.clone().addScaledVector(ferro.dock.out, 1400));
  const onLane = new Vector3();
  const clear = asteroids.filter(
    (a) =>
      a.position.distanceTo(station.position) > station.ringRadius + 600 + a.radius &&
      a.position.distanceTo(ferro.position) > FERRO_CLEARANCE + a.radius &&
      lane.closestPointToPoint(a.position, true, onLane).distanceTo(a.position) > 160 + a.radius,
  );

  const colliders: StaticCollider[] = [];
  clear.forEach((a, index) => {
    // Rocks are displaced meshes; use ~85% of the nominal radius so contacts feel fair.
    colliders.push({ kind: 'asteroid', center: a.position, radius: a.radius * 0.85, index });
  });
  colliders.push({ kind: 'station', center: station.position.clone(), radius: station.coreRadius });
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    colliders.push({
      kind: 'station',
      center: new Vector3(0, (i / 4) * (station.spineLength / 2), 0),
      radius: 70,
    });
  }
  const ringSegments = 40;
  for (let i = 0; i < ringSegments; i++) {
    const t = (i / ringSegments) * Math.PI * 2;
    colliders.push({
      kind: 'station',
      center: new Vector3(Math.cos(t) * station.ringRadius, 0, Math.sin(t) * station.ringRadius),
      radius: station.ringTube + 6,
    });
  }
  for (const c of FERRO_PARTS) colliders.push({ kind: 'station', center: ferroPoint(ferro, c[0], c[1], c[2]), radius: c[3] });
  for (const p of planets) colliders.push({ kind: 'planet', center: p.position, radius: p.radius });

  return {
    id: 'aurora',
    name: 'Secteur Aurora',
    seed,
    sunDirection: new Vector3(-0.8, 0.35, 0.12).normalize(),
    station,
    stations: [station, ferro],
    planets,
    asteroids: clear,
    beltCenter,
    colliders,
    playerSpawn: new Vector3(0, 60, 1100),
  };
}

/** Nothing floats closer than this to the depot's centre (m). */
const FERRO_CLEARANCE = 520;
/** Hangar mouth of the depot model (Outpost.ts), on local +Z. */
export const FERRO_MOUTH_Z = 130;

/**
 * Solid parts of the depot model, local coordinates (hangar on +Z) and
 * radius: habitat stack, refinery, ore silos and the drill head. The hangar
 * itself is open, like Aurora-7's.
 */
const FERRO_PARTS: [number, number, number, number][] = [
  [0, 0, -45, 62],
  [0, 78, -45, 48],
  [0, -78, -45, 48],
  [-165, -10, -55, 72],
  [140, 0, -85, 62],
  [0, -70, -430, 30],
];

/** A point of the depot model in world coordinates. */
export function ferroPoint(st: StationDef, x: number, y: number, z: number, out = new Vector3()) {
  const c = Math.cos(st.yaw);
  const s = Math.sin(st.yaw);
  return out.set(x * c + z * s, y, -x * s + z * c).add(st.position);
}

/**
 * Dépôt Ferro-9: the mining depot at the far edge of the belt, about 7.5 km
 * from Aurora-7, its hangar turned toward the hub.
 */
function buildFerro(hub: Vector3, beltCenter: Vector3): StationDef {
  const position = beltCenter.clone().add(new Vector3(2400, 150, -2000));
  const toHub = hub.clone().sub(position).setY(0).normalize();
  const st: StationDef = {
    id: 'ferro',
    name: 'Dépôt Ferro-9',
    kind: 'outpost',
    yaw: Math.atan2(toHub.x, toHub.z),
    position,
    ringRadius: 0,
    ringTube: 0,
    coreRadius: 62,
    spineLength: 0,
    dock: { mouth: new Vector3(), radius: 170, out: toHub },
  };
  ferroPoint(st, 0, 0, FERRO_MOUTH_Z, st.dock.mouth);
  return st;
}
