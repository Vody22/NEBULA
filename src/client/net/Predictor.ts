import { Quaternion, Vector3 } from 'three';
import type { ShipSnapshot } from '../../shared/net/protocol';
import { stepShipPhysics } from '../../shared/sim/shipPhysics';
import { stepShipSystems } from '../../shared/sim/shipSystems';
import type { StaticGrid } from '../../shared/sim/spatialGrid';
import { neutralInput, type Ship, type ShipInput } from '../../shared/sim/types';
import { TICK_DT } from '../../shared/sim/world';

/** Beyond this the correction is a teleport (respawn, big collision), not smoothed. */
const SNAP_DISTANCE = 40;
/** How fast the visual correction offset fades (1/s). */
const SMOOTHING = 12;
const MAX_HISTORY = 240;

const _q = new Quaternion();
const _before = new Vector3();
const _simBefore = new Vector3();
const _beforeRot = new Quaternion();

/**
 * Client-side prediction for the local player's ship. Every input tick the
 * ship is simulated immediately with the same shared physics as the server;
 * when a snapshot arrives the prediction is rewound to the server state and
 * the unacknowledged inputs are replayed. Any residual error is blended out
 * visually instead of snapping.
 */
export class Predictor {
  ship: Ship | null = null;
  private history: { seq: number; input: ShipInput }[] = [];
  /** Visual offset (predicted render pose minus simulated pose), fading to zero. */
  readonly posError = new Vector3();
  readonly rotError = new Quaternion();
  readonly renderPosition = new Vector3();
  readonly renderRotation = new Quaternion();
  /** Size of the last correction, for diagnostics (m). */
  lastCorrection = 0;
  corrections = 0;

  constructor(private grid: StaticGrid) {}

  get active() {
    return this.ship !== null;
  }

  reset() {
    this.ship = null;
    this.history.length = 0;
    this.posError.set(0, 0, 0);
    this.rotError.identity();
  }

  private adopt(s: ShipSnapshot) {
    this.ship = {
      id: s.id,
      name: s.name,
      classId: s.classId,
      faction: s.faction,
      ownerId: s.owner,
      position: new Vector3(),
      velocity: new Vector3(),
      rotation: new Quaternion(),
      angularVelocity: new Vector3(),
      hull: s.hull,
      shield: s.shield,
      energy: s.energy,
      alive: true,
      boosting: s.boosting,
      input: neutralInput(),
      weaponCooldown: 0,
      nextHardpoint: 0,
      sinceDamage: 999,
      sinceFire: 999,
      weaponsLocked: s.weaponsLocked,
      lastAttacker: null,
      pvp: s.pvp,
      lastPvpCombat: -999,
    };
    this.posError.set(0, 0, 0);
    this.rotError.identity();
  }

  private load(s: ShipSnapshot) {
    const ship = this.ship!;
    ship.position.set(s.p[0], s.p[1], s.p[2]);
    ship.velocity.set(s.v[0], s.v[1], s.v[2]);
    ship.rotation.set(s.q[0], s.q[1], s.q[2], s.q[3]).normalize();
    ship.angularVelocity.set(s.w[0], s.w[1], s.w[2]);
    ship.energy = s.energy;
    ship.boosting = s.boosting;
    ship.hull = s.hull;
    ship.shield = s.shield;
    ship.weaponsLocked = s.weaponsLocked;
    // Firing pauses energy regeneration on the server; mirror it roughly.
    ship.sinceFire = s.firing ? 0 : 999;
  }

  /** One fixed input tick: record the input and simulate it at once. */
  step(seq: number, input: ShipInput) {
    // Recorded even before our ship is known: the first snapshot replays them.
    const copy = { ...input };
    this.history.push({ seq, input: copy });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    if (this.ship) this.simulate(copy);
  }

  private simulate(input: ShipInput) {
    const ship = this.ship!;
    Object.assign(ship.input, input);
    stepShipPhysics(ship, TICK_DT);
    stepShipSystems(ship, TICK_DT, this.grid);
    if (input.fire) ship.sinceFire = 0;
  }

  /** Server state for our ship (acknowledging inputs up to `ackSeq`). */
  reconcile(s: ShipSnapshot, ackSeq: number) {
    if (!this.ship || this.ship.id !== s.id) {
      this.adopt(s);
      this.load(s);
      this.history = this.history.filter((h) => h.seq > ackSeq);
      for (const h of this.history) this.simulate(h.input);
      return;
    }
    const ship = this.ship;
    _simBefore.copy(ship.position);
    _before.copy(ship.position).add(this.posError);
    _beforeRot.copy(this.rotError).multiply(ship.rotation);

    this.load(s);
    let i = 0;
    while (i < this.history.length && this.history[i].seq <= ackSeq) i++;
    if (i) this.history.splice(0, i);
    for (const h of this.history) this.simulate(h.input);

    // Keep the rendered pose where it was and let the offset fade out.
    this.lastCorrection = _simBefore.distanceTo(ship.position);
    if (this.lastCorrection > 0.05) this.corrections++;
    this.posError.subVectors(_before, ship.position);
    if (this.posError.length() > SNAP_DISTANCE) {
      this.posError.set(0, 0, 0);
      this.rotError.identity();
    } else {
      this.rotError.copy(_beforeRot).multiply(_q.copy(ship.rotation).invert());
    }
  }

  /** Smoothed pose to render this frame. */
  update(dt: number) {
    const ship = this.ship;
    if (!ship) return;
    const k = Math.exp(-SMOOTHING * dt);
    this.posError.multiplyScalar(k);
    this.rotError.slerp(_q.identity(), 1 - k);
    this.renderPosition.copy(ship.position).add(this.posError);
    this.renderRotation.copy(this.rotError).multiply(ship.rotation).normalize();
  }
}
