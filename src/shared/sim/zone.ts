import { Vector3 } from 'three';
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
  name: string;
  position: Vector3;
  ringRadius: number;
  ringTube: number;
  coreRadius: number;
  spineLength: number;
}

export interface ZoneDef {
  id: string;
  name: string;
  seed: number;
  sunDirection: Vector3; // direction *towards* the sun
  station: StationDef;
  planets: PlanetDef[];
  asteroids: AsteroidDef[];
  beltCenter: Vector3;
  colliders: StaticCollider[];
  playerSpawn: Vector3;
}

export function buildZone(seed = 1337): ZoneDef {
  const rand = mulberry32(seed);
  const station: StationDef = {
    name: 'Station Aurora-7',
    position: new Vector3(0, 0, 0),
    ringRadius: 560,
    ringTube: 46,
    coreRadius: 170,
    spineLength: 1100,
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
  // Keep the station approach clear.
  const clear = asteroids.filter((a) => a.position.distanceTo(station.position) > station.ringRadius + 600 + a.radius);

  const colliders: StaticCollider[] = [];
  for (const a of clear) {
    // Rocks are displaced meshes; use ~85% of the nominal radius so contacts feel fair.
    colliders.push({ kind: 'asteroid', center: a.position, radius: a.radius * 0.85 });
  }
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
  for (const p of planets) colliders.push({ kind: 'planet', center: p.position, radius: p.radius });

  return {
    id: 'aurora',
    name: 'Secteur Aurora',
    seed,
    sunDirection: new Vector3(-0.8, 0.35, 0.12).normalize(),
    station,
    planets,
    asteroids: clear,
    beltCenter,
    colliders,
    playerSpawn: new Vector3(0, 60, 1100),
  };
}
