import type { ShipClassId } from './types';

export interface ShipClass {
  id: ShipClassId;
  label: string;
  radius: number;
  hull: number;
  shield: number;
  shieldRegen: number; // per second
  shieldDelay: number; // seconds after damage before regen
  energy: number;
  energyRegen: number;
  maxSpeed: number;
  boostSpeed: number;
  mainAccel: number;
  boostAccel: number;
  strafeAccel: number;
  strafeSpeed: number;
  /** Max rotation rates (rad/s) */
  pitchRate: number;
  yawRate: number;
  rollRate: number;
  /** How quickly angular velocity reaches the requested rate (1/s). */
  angularResponse: number;
  boostCost: number; // energy per second
  weapon: {
    damage: number;
    interval: number; // seconds between shots (alternating hardpoints)
    speed: number;
    life: number;
    energyCost: number;
    /** Local-space muzzle offsets (meters). */
    hardpoints: [number, number, number][];
  };
  bounty: number;
}

export const SHIP_CLASSES: Record<ShipClassId, ShipClass> = {
  falcon: {
    id: 'falcon',
    label: 'Falcon Mk.II',
    radius: 9,
    hull: 260,
    shield: 220,
    shieldRegen: 28,
    shieldDelay: 3,
    energy: 100,
    energyRegen: 16,
    maxSpeed: 210,
    boostSpeed: 470,
    mainAccel: 95,
    boostAccel: 260,
    strafeAccel: 55,
    strafeSpeed: 70,
    pitchRate: 1.75,
    yawRate: 1.25,
    rollRate: 2.8,
    angularResponse: 5,
    boostCost: 22,
    weapon: {
      damage: 14,
      interval: 0.085,
      speed: 1400,
      life: 1.35,
      energyCost: 1.6,
      hardpoints: [
        [-4.6, -0.6, -6.5],
        [4.6, -0.6, -6.5],
      ],
    },
    bounty: 0,
  },
  warden: {
    id: 'warden',
    label: 'Warden',
    radius: 9,
    hull: 240,
    shield: 200,
    shieldRegen: 22,
    shieldDelay: 3.5,
    energy: 100,
    energyRegen: 14,
    maxSpeed: 200,
    boostSpeed: 420,
    mainAccel: 85,
    boostAccel: 220,
    strafeAccel: 45,
    strafeSpeed: 60,
    pitchRate: 1.5,
    yawRate: 1.1,
    rollRate: 2.4,
    angularResponse: 4,
    boostCost: 22,
    weapon: {
      damage: 11,
      interval: 0.12,
      speed: 1300,
      life: 1.3,
      energyCost: 1.4,
      hardpoints: [
        [-4.6, -0.6, -6.5],
        [4.6, -0.6, -6.5],
      ],
    },
    bounty: 0,
  },
  raider: {
    id: 'raider',
    label: 'Raider',
    radius: 7.5,
    hull: 120,
    shield: 80,
    shieldRegen: 14,
    shieldDelay: 4,
    energy: 100,
    energyRegen: 14,
    maxSpeed: 225,
    boostSpeed: 430,
    mainAccel: 105,
    boostAccel: 240,
    strafeAccel: 60,
    strafeSpeed: 70,
    pitchRate: 1.6,
    yawRate: 1.2,
    rollRate: 2.8,
    angularResponse: 4.5,
    boostCost: 20,
    weapon: {
      damage: 8,
      interval: 0.16,
      speed: 1150,
      life: 1.4,
      energyCost: 1.5,
      hardpoints: [
        [-3.2, 0, -5.5],
        [3.2, 0, -5.5],
      ],
    },
    bounty: 150,
  },
  marauder: {
    id: 'marauder',
    label: 'Marauder',
    radius: 14,
    hull: 420,
    shield: 260,
    shieldRegen: 18,
    shieldDelay: 4,
    energy: 140,
    energyRegen: 16,
    maxSpeed: 165,
    boostSpeed: 320,
    mainAccel: 60,
    boostAccel: 150,
    strafeAccel: 35,
    strafeSpeed: 45,
    pitchRate: 0.9,
    yawRate: 0.75,
    rollRate: 1.4,
    angularResponse: 3,
    boostCost: 20,
    weapon: {
      damage: 16,
      interval: 0.22,
      speed: 1050,
      life: 1.6,
      energyCost: 2,
      hardpoints: [
        [-7, -1, -10],
        [7, -1, -10],
        [0, 2.5, -12],
      ],
    },
    bounty: 450,
  },
};
