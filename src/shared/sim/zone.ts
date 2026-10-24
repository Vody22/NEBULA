import { Line3, Vector3 } from 'three';
import type { StationId } from '../economy/market';
import { mulberry32 } from '../rng';
import { sectorSeed, type SectorId } from '../sectors';
import { BIG_ROCK, rockCollision } from '../physics/rocks';
import { depotColliders, hubColliders } from '../physics/structures';
import { oreOf, PLATINUM_CHANCE } from './mining';
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
  /** The rock turns about this unit axis at `spinSpeed` rad/s, from the angle `variant` at time 0 (drawn and collided alike). */
  spinAxis: [number, number, number];
  spinSpeed: number;
  variant: number;
}

export interface StationDef {
  id: StationId;
  name: string;
  /** 'hub': the Aurora-7 model; 'outpost': the Ferro-9 mining depot. */
  kind: 'hub' | 'outpost';
  /** Paint scheme of the model: Aurora's and Ferro's ('standard'), or the Kepler sector's ('kepler'). */
  livery: 'standard' | 'kepler';
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

/** How a sector's sky looks (baked by the client's Sky.ts). */
export interface SkyDef {
  /** Direction of the luminous nebula core. */
  core: Vector3;
  /** Nebula colours: hot core, middle, outer edge. */
  colors: [[number, number, number], [number, number, number], [number, number, number]];
  /** Colour of the star's light (sRGB). */
  sun: [number, number, number];
  /** Seed of the bright star field (another sector, other stars). */
  stars: number;
}

export interface ZoneDef {
  id: SectorId;
  name: string;
  seed: number;
  sunDirection: Vector3; // direction *towards* the sun
  sky: SkyDef;
  /** The main station (Aurora-7). */
  station: StationDef;
  /** Every station a ship can dock at, the main one first. */
  stations: StationDef[];
  planets: PlanetDef[];
  asteroids: AsteroidDef[];
  beltCenter: Vector3;
  colliders: StaticCollider[];
  playerSpawn: Vector3;
  /** Where ships arrive from a hyperspace jump (well clear of the stations, facing the hub). */
  jumpPoint: Vector3;
  /** Pirate raids here start this many steps more dangerous (v0.7). */
  danger: number;
  /** Share of the ore mined on metallic rocks that comes out as platinum. */
  platinum: number;
}

/** The zone of a sector, from the server's base seed. */
export function buildSector(id: SectorId, base = 1337): ZoneDef {
  return id === 'kepler' ? buildKepler(sectorSeed('kepler', base)) : buildZone(sectorSeed('aurora', base));
}

/** The zone a client builds from a welcome or sector message (seed already the zone's own). */
export function zoneOf(id: SectorId, seed: number): ZoneDef {
  return id === 'kepler' ? buildKepler(seed) : buildZone(seed);
}

/** Aurora's sky: the system's first look (Visual direction, step 2). */
const AURORA_SKY: SkyDef = {
  core: new Vector3(0.32, 0.38, 0.87).normalize(),
  colors: [
    [0.3, 0.72, 0.95],
    [0.58, 0.1, 0.42],
    [0.16, 0.14, 0.5],
  ],
  // 0xfff0dc, the light Aurora always had.
  sun: [1, 240 / 255, 220 / 255],
  stars: 4242,
};

export function buildZone(seed = 1337): ZoneDef {
  const rand = mulberry32(seed);
  // The hangar of the station model (Station.ts) opens on +Z, its mouth at
  // coreRadius × 1.08 + depth 160 − wall 14 + 4 ≈ 334 m from the centre.
  const station = hubStation('aurora', 'Station Aurora-7', 'standard');

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
  const asteroids = belt(rand, beltCenter, 520, 0.04, () => Math.floor(rand() * 4));
  const ferro = outpostStation('ferro', 'Dépôt Ferro-9', 'standard', beltCenter.clone().add(new Vector3(2400, 150, -2000)), station.position);
  const jumpPoint = new Vector3(0, 150, 2600);
  const clear = clearApproaches(asteroids, station, ferro, jumpPoint);

  return {
    id: 'aurora',
    name: 'Secteur Aurora',
    seed,
    sunDirection: new Vector3(-0.8, 0.35, 0.12).normalize(),
    sky: AURORA_SKY,
    station,
    stations: [station, ferro],
    planets,
    asteroids: clear,
    beltCenter,
    colliders: zoneColliders(clear, station, ferro, planets),
    playerSpawn: new Vector3(0, 60, 1100),
    jumpPoint,
    danger: 0,
    platinum: PLATINUM_CHANCE,
  };
}

/**
 * Secteur Kepler (v0.7), one hyperspace jump from Aurora: a younger system
 * under a blue-white star, in a gold and teal nebula. The Kepler-4 hub (the
 * same class of station as Aurora-7) at the centre, the Vesta-2 ice depot at
 * the far edge of a denser belt, rich in metallic rocks and platinum. Pirate
 * raids here are a step harder than in Aurora.
 */
export function buildKepler(seed: number): ZoneDef {
  const rand = mulberry32(seed);
  const station = hubStation('kepler', 'Station Kepler-4', 'kepler');
  const planets: PlanetDef[] = [
    {
      name: 'Hespéra',
      position: new Vector3(38000, -9000, 46000),
      radius: 16000,
      kind: 'gas',
      colorA: [0.36, 0.66, 0.64],
      colorB: [0.1, 0.2, 0.3],
      atmosphere: [0.45, 0.85, 0.95],
      rings: true,
      seed: 53,
    },
    {
      name: 'Cendre',
      position: new Vector3(-30000, 5500, 21000),
      radius: 4400,
      kind: 'rocky',
      colorA: [0.55, 0.32, 0.2],
      colorB: [0.26, 0.2, 0.17],
      atmosphere: [1.0, 0.62, 0.4],
      rings: false,
      seed: 61,
    },
    {
      name: 'Opale',
      position: new Vector3(-25500, 8200, 17000),
      radius: 950,
      kind: 'ice',
      colorA: [0.82, 0.86, 0.9],
      colorB: [0.5, 0.56, 0.62],
      atmosphere: [0.7, 0.85, 1.0],
      rings: false,
      seed: 67,
    },
  ];
  const beltCenter = new Vector3(-3300, 300, 3600);
  // Denser, with more big rocks, and two in five metallic (iron-nickel, platinum).
  const asteroids = belt(rand, beltCenter, 600, 0.05, () => (rand() < 0.4 ? 3 : Math.floor(rand() * 4)));
  const vesta = outpostStation('vesta', 'Dépôt Vesta-2', 'kepler', beltCenter.clone().add(new Vector3(-2500, -120, 2100)), station.position);
  const jumpPoint = new Vector3(0, 150, 2600);
  const clear = clearApproaches(asteroids, station, vesta, jumpPoint);
  return {
    id: 'kepler',
    name: 'Secteur Kepler',
    seed,
    sunDirection: new Vector3(0.62, 0.3, -0.72).normalize(),
    sky: {
      core: new Vector3(-0.55, 0.2, -0.81).normalize(),
      colors: [
        [0.95, 0.76, 0.42],
        [0.08, 0.42, 0.4],
        [0.07, 0.11, 0.36],
      ],
      sun: [0.86, 0.92, 1.0],
      stars: 9191,
    },
    station,
    stations: [station, vesta],
    planets,
    asteroids: clear,
    beltCenter,
    colliders: zoneColliders(clear, station, vesta, planets),
    playerSpawn: new Vector3(0, 60, 1100),
    jumpPoint,
    danger: 1,
    platinum: PLATINUM_CHANCE * 2.5,
  };
}

/**
 * A hub station at the origin (the hub colliders and the model assume it).
 * The hangar of the model (Station.ts) opens on +Z, its mouth at
 * coreRadius × 1.08 + depth 160 − wall 14 + 4 ≈ 334 m from the centre.
 */
function hubStation(id: StationId, name: string, livery: StationDef['livery']): StationDef {
  return {
    id,
    name,
    kind: 'hub',
    livery,
    yaw: 0,
    position: new Vector3(0, 0, 0),
    ringRadius: 560,
    ringTube: 46,
    coreRadius: 170,
    spineLength: 1100,
    dock: { mouth: new Vector3(0, 0, 334), radius: 220, out: new Vector3(0, 0, 1) },
  };
}

/** A flattened ellipsoidal cluster of rocks, denser in the middle. */
function belt(rand: () => number, center: Vector3, count: number, bigShare: number, variant: () => number): AsteroidDef[] {
  const asteroids: AsteroidDef[] = [];
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.pow(rand(), 0.7) * 3000;
    const y = (rand() - 0.5) * 2 * 420 * (1 - r / 3600);
    const pos = new Vector3(Math.cos(a) * r, y, Math.sin(a) * r * 0.75).add(center);
    const big = rand() < bigShare;
    const radius = big ? 160 + rand() * 220 : 6 + Math.pow(rand(), 2.2) * 90;
    const ax = new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    asteroids.push({
      position: pos,
      radius,
      spinAxis: [ax.x, ax.y, ax.z],
      spinSpeed: (rand() * 0.25 + 0.02) * (big ? 0.15 : 1),
      variant: variant(),
    });
  }
  return asteroids;
}

/** Keeps the approaches clear: around each station, along the depot's approach lane, and at the jump arrival point. */
function clearApproaches(asteroids: AsteroidDef[], hub: StationDef, depot: StationDef, jumpPoint: Vector3): AsteroidDef[] {
  const lane = new Line3(depot.dock.mouth, depot.dock.mouth.clone().addScaledVector(depot.dock.out, 1400));
  const onLane = new Vector3();
  return asteroids.filter(
    (a) =>
      a.position.distanceTo(hub.position) > hub.ringRadius + 600 + a.radius &&
      a.position.distanceTo(depot.position) > FERRO_CLEARANCE + a.radius &&
      a.position.distanceTo(jumpPoint) > 500 + a.radius &&
      lane.closestPointToPoint(a.position, true, onLane).distanceTo(a.position) > 160 + a.radius,
  );
}

/** v0.8: an asteroid collides as it is drawn (relief, proportions) and turns as it is drawn (Asteroids.ts). */
export function asteroidCollider(a: AsteroidDef, index: number): StaticCollider {
  const big = a.radius >= BIG_ROCK;
  return {
    kind: 'asteroid',
    center: a.position,
    radius: a.radius * rockCollision(a.variant, big).bound,
    material: oreOf(a.variant) === 'ironNickel' ? 'metalRock' : 'rock',
    index,
    shape: { t: 'rock', v: a.variant, big, s: a.radius },
    spin: a.spinSpeed,
    spinAxis: new Vector3(...a.spinAxis).normalize(),
    spinPhase: a.variant,
  };
}

function zoneColliders(asteroids: AsteroidDef[], hub: StationDef, depot: StationDef, planets: PlanetDef[]): StaticCollider[] {
  const colliders: StaticCollider[] = [];
  asteroids.forEach((a, index) => colliders.push(asteroidCollider(a, index)));
  // v0.8: the stations' real shapes (walls, hangar, spine, ring, panels), see physics/structures.ts.
  colliders.push(...hubColliders(hub), ...depotColliders(depot, FERRO_MOUTH_Z));
  for (const p of planets) colliders.push({ kind: 'planet', center: p.position, radius: p.radius, material: p.kind === 'ice' ? 'ice' : 'rock' });
  return colliders;
}

/** Nothing floats closer than this to a depot's centre (m). */
const FERRO_CLEARANCE = 520;
/** Hangar mouth of the depot model (Outpost.ts), on local +Z. */
export const FERRO_MOUTH_Z = 130;

/** A point of the depot model in world coordinates. */
export function ferroPoint(st: StationDef, x: number, y: number, z: number, out = new Vector3()) {
  const c = Math.cos(st.yaw);
  const s = Math.sin(st.yaw);
  return out.set(x * c + z * s, y, -x * s + z * c).add(st.position);
}

/**
 * A mining depot (the Ferro-9 model) at the far edge of a belt, its hangar
 * turned toward the hub: Ferro-9 about 7.5 km from Aurora-7, Vesta-2 about
 * 7.4 km from Kepler-4.
 */
function outpostStation(id: StationId, name: string, livery: StationDef['livery'], position: Vector3, hub: Vector3): StationDef {
  const toHub = hub.clone().sub(position).setY(0).normalize();
  const st: StationDef = {
    id,
    name,
    kind: 'outpost',
    livery,
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
