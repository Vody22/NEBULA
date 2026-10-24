import { Quaternion, Vector3 } from 'three';
import { bodyProps, type BodyKind } from '../../shared/physics/bodies';
import { collidePair, shipProps, type Solid, type SolidProps } from '../../shared/physics/collide';
import { unpackParts, type ShipSnapshot } from '../../shared/net/protocol';
import { stepShipPhysics } from '../../shared/sim/shipPhysics';
import { stepShipSystems } from '../../shared/sim/shipSystems';
import type { StaticGrid } from '../../shared/sim/spatialGrid';
import { intactParts, neutralInput, type Ship, type ShipInput } from '../../shared/sim/types';
import { unpackMods } from '../../shared/sim/upgrades';
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
const _oldPos = new Vector3();
const _oldRot = new Quaternion();
const _oldVel = new Vector3();
const _from = new Vector3();
const _bodyFrom = new Vector3();
const _spinQ = new Quaternion();
const _axis = new Vector3();

/** A resting loose body as prediction sees it: where the server last left it, and a working copy. */
interface RestingBody extends Solid {
  id: number;
  props: SolidProps;
  rest: { p: Vector3; q: Quaternion };
  /** Struck by our predicted ship: it drifts in the copy until the next reconciliation. */
  moving: boolean;
}

/** Only resting bodies this close to the ship are tested (m). */
const BODY_RANGE = 120;

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
  /** Velocity interpolated like the pose (camera pull-back, FOV and dust use it). */
  readonly renderVelocity = new Vector3();
  /**
   * Simulated pose one tick earlier. The simulation runs at 60 Hz; on a
   * 120–240 Hz screen the rendered ship is interpolated between the last two
   * ticks, otherwise it moves only on some frames and visibly judders.
   */
  private prevPosition = new Vector3();
  private prevRotation = new Quaternion();
  private prevVelocity = new Vector3();
  /** Size of the last correction, for diagnostics (m). */
  lastCorrection = 0;
  corrections = 0;
  /**
   * Loose bodies at rest (v0.8): bumping into one is predicted with the
   * same impulse as on the server; moving bodies, like other ships, come
   * from the server alone.
   */
  private bodies: RestingBody[] = [];

  constructor(private grid: StaticGrid) {}

  /** The loose bodies the last snapshot left at rest. */
  setRestingBodies(list: { id: number; kind: BodyKind; scale: number; position: Vector3; rotation: Quaternion }[]) {
    const old = new Map(this.bodies.map((b) => [b.id, b]));
    this.bodies = list.map((b) => {
      const r = old.get(b.id) ?? {
        id: b.id,
        props: bodyProps(b.kind, b.scale),
        rest: { p: new Vector3(), q: new Quaternion() },
        position: new Vector3(),
        velocity: new Vector3(),
        rotation: new Quaternion(),
        angularVelocity: new Vector3(),
        spin: new Vector3(),
        moving: false,
      };
      r.rest.p.copy(b.position);
      r.rest.q.copy(b.rotation);
      return r;
    });
    this.resetBodies();
  }

  private resetBodies() {
    for (const b of this.bodies) {
      b.position.copy(b.rest.p);
      b.rotation.copy(b.rest.q);
      b.velocity.set(0, 0, 0);
      b.spin.set(0, 0, 0);
      b.moving = false;
    }
  }

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
      mods: unpackMods(s.u),
      faction: s.faction,
      ownerId: s.owner,
      position: new Vector3(),
      velocity: new Vector3(),
      rotation: new Quaternion(),
      angularVelocity: new Vector3(),
      spin: new Vector3(),
      parts: intactParts(),
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
      mining: null,
      mineProgress: 0,
    };
    this.posError.set(0, 0, 0);
    this.rotError.identity();
  }

  private keepPrevious() {
    this.prevPosition.copy(this.ship!.position);
    this.prevRotation.copy(this.ship!.rotation);
    this.prevVelocity.copy(this.ship!.velocity);
  }

  private load(s: ShipSnapshot) {
    const ship = this.ship!;
    ship.classId = s.classId;
    ship.mods = unpackMods(s.u);
    ship.position.set(s.p[0], s.p[1], s.p[2]);
    ship.velocity.set(s.v[0], s.v[1], s.v[2]);
    ship.rotation.set(s.q[0], s.q[1], s.q[2], s.q[3]).normalize();
    ship.angularVelocity.set(s.w[0], s.w[1], s.w[2]);
    if (s.s) ship.spin.set(s.s[0], s.s[1], s.s[2]);
    else ship.spin.set(0, 0, 0);
    unpackParts(s.d, ship.parts);
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
    if (this.ship) {
      this.keepPrevious();
      this.simulate(copy);
    }
  }

  private simulate(input: ShipInput) {
    const ship = this.ship!;
    Object.assign(ship.input, input);
    _from.copy(ship.position);
    stepShipPhysics(ship, TICK_DT);
    // Collisions with the static world are predicted (the server decides the damage).
    stepShipSystems(ship, TICK_DT, this.grid, _from);
    this.collideBodies(ship);
    if (input.fire) ship.sinceFire = 0;
  }

  /** Our ship against the resting bodies nearby, as the server does it (collidePair, both masses). */
  private collideBodies(ship: Ship) {
    if (!this.bodies.length) return;
    const props = shipProps(ship);
    for (const b of this.bodies) {
      _bodyFrom.copy(b.position);
      if (b.moving) {
        b.position.addScaledVector(b.velocity, TICK_DT);
        const w = b.spin.length();
        if (w > 1e-6) b.rotation.multiply(_spinQ.setFromAxisAngle(_axis.copy(b.spin).divideScalar(w), w * TICK_DT)).normalize();
      }
      if (b.position.distanceToSquared(ship.position) > BODY_RANGE * BODY_RANGE) continue;
      const c = collidePair(ship, props, b, b.props, _from, _bodyFrom, TICK_DT);
      if (c && c.speed > 0) b.moving = true;
    }
  }

  /** Server state for our ship (acknowledging inputs up to `ackSeq`). */
  reconcile(s: ShipSnapshot, ackSeq: number) {
    if (!this.ship || this.ship.id !== s.id) {
      this.adopt(s);
      this.load(s);
      this.history = this.history.filter((h) => h.seq > ackSeq);
      for (const h of this.history) this.simulate(h.input);
      this.keepPrevious();
      return;
    }
    const ship = this.ship;
    _simBefore.copy(ship.position);
    _before.copy(ship.position).add(this.posError);
    _beforeRot.copy(this.rotError).multiply(ship.rotation);
    _oldPos.copy(ship.position);
    _oldRot.copy(ship.rotation);
    _oldVel.copy(ship.velocity);

    this.load(s);
    let i = 0;
    while (i < this.history.length && this.history[i].seq <= ackSeq) i++;
    if (i) this.history.splice(0, i);
    // The replay starts from the server's state: the resting bodies too.
    this.resetBodies();
    for (const h of this.history) this.simulate(h.input);

    // The previous tick moves with the correction, so interpolation stays continuous.
    this.prevPosition.add(_oldPos.subVectors(ship.position, _oldPos));
    this.prevVelocity.add(_oldVel.subVectors(ship.velocity, _oldVel));
    this.prevRotation.premultiply(_q.copy(ship.rotation).multiply(_oldRot.invert())).normalize();

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

  /**
   * Smoothed pose to render this frame. `alpha` (0..1) is how far the render
   * clock is between the last tick and the next one.
   */
  update(dt: number, alpha = 1) {
    const ship = this.ship;
    if (!ship) return;
    const k = Math.exp(-SMOOTHING * dt);
    this.posError.multiplyScalar(k);
    this.rotError.slerp(_q.identity(), 1 - k);
    const t = Math.min(1, Math.max(0, alpha));
    this.renderPosition.lerpVectors(this.prevPosition, ship.position, t).add(this.posError);
    _q.slerpQuaternions(this.prevRotation, ship.rotation, t);
    this.renderRotation.copy(this.rotError).multiply(_q).normalize();
    this.renderVelocity.lerpVectors(this.prevVelocity, ship.velocity, t);
  }
}
