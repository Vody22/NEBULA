import { Quaternion, Vector3 } from 'three';
import { clamp, forwardOf, interceptPoint, segmentSphere } from '../math';
import type { Rng } from '../rng';
import { SHIP_CLASSES } from './shipClasses';
import type { EntityId, Ship, ShipInput } from './types';
import { neutralInput } from './types';
import type { World } from './world';

type AIState = 'patrol' | 'attack' | 'evade';

const _to = new Vector3();
const _aim = new Vector3();
const _local = new Vector3();
const _inv = new Quaternion();
const _fwd = new Vector3();
const _ahead = new Vector3();
const _away = new Vector3();
const _avoidDir = new Vector3();

/** Targets further than this from the AI's home are ignored, keeping fights near the action. */
const LEASH = 3800;

/**
 * NPC pilot. Produces a ShipInput every tick, exactly like a human client,
 * so NPCs go through the same physics and weapon rules as players.
 */
export class AIPilot {
  state: AIState = 'patrol';
  targetId: EntityId | null = null;
  private retargetIn = 0;
  private stateTime = 0;
  private evadeDir = new Vector3();
  private patrolPoint = new Vector3();
  private aimJitter = new Vector3();
  private jitterIn = 0;
  readonly input: ShipInput = neutralInput();

  constructor(
    readonly shipId: EntityId,
    private rng: Rng,
    /** 0..1: aim accuracy and aggressiveness. */
    readonly skill = 0.6,
    readonly home = new Vector3(),
    /** Where the leash is measured from (defaults to home). */
    readonly anchor = home,
  ) {
    this.pickPatrolPoint();
  }

  private pickPatrolPoint() {
    const r = this.rng;
    this.patrolPoint
      .set((r() - 0.5) * 2, (r() - 0.5) * 0.6, (r() - 0.5) * 2)
      .normalize()
      .multiplyScalar(600 + r() * 1400)
      .add(this.home);
  }

  update(world: World, dt: number): ShipInput {
    const inp = this.think(world, dt);
    const ship = world.ships.get(this.shipId);
    if (ship) this.avoidObstacles(world, ship);
    return inp;
  }

  /**
   * Looks ahead along the velocity; if the path crosses a static collider,
   * overrides steering to slide around it and eases off the throttle.
   */
  private avoidObstacles(world: World, ship: Ship) {
    const r = SHIP_CLASSES[ship.classId].radius;
    const speed = ship.velocity.length();
    const lookTime = 2.2;
    forwardOf(ship.rotation, _fwd);
    // Probe along the velocity (or the nose when slow).
    if (speed > 20) _ahead.copy(ship.velocity).multiplyScalar(lookTime);
    else _ahead.copy(_fwd).multiplyScalar(120);
    _ahead.add(ship.position);
    const mid = _away.addVectors(ship.position, _ahead).multiplyScalar(0.5);
    const reach = ship.position.distanceTo(_ahead) / 2 + 60;
    let worst = 2;
    let hit: { center: Vector3; radius: number } | null = null;
    for (const c of world.grid.query(mid, reach)) {
      const t = segmentSphere(ship.position, _ahead, c.center, c.radius + r + 35);
      if (t >= 0 && t < worst) {
        worst = t;
        hit = c;
      }
    }
    if (!hit) return;
    // Steer to the side of the obstacle we're already favouring.
    _away.subVectors(ship.position, hit.center);
    const dir = _avoidDir.copy(ship.velocity.lengthSq() > 400 ? ship.velocity : _fwd).normalize();
    const along = _away.dot(dir);
    _away.addScaledVector(dir, -along); // perpendicular component
    if (_away.lengthSq() < 1e-3) _away.set(0, 1, 0);
    _away.normalize().multiplyScalar(1.5).add(dir).normalize();
    this.steerToward(ship, _away, 3.5);
    this.input.fire = false;
    this.input.throttle = Math.min(this.input.throttle, worst < 0.4 ? 0.2 : 0.6);
    this.input.boost = false;
  }

  private think(world: World, dt: number): ShipInput {
    const ship = world.ships.get(this.shipId);
    const inp = this.input;
    if (!ship) return inp;
    this.stateTime += dt;
    this.retargetIn -= dt;
    this.jitterIn -= dt;

    if (this.retargetIn <= 0) {
      this.retargetIn = 1.5 + this.rng();
      this.targetId = this.findTarget(world, ship);
    }
    const target = this.targetId !== null ? world.ships.get(this.targetId) : undefined;
    if (!target || !target.alive) {
      this.targetId = null;
      if (this.state !== 'patrol') this.setState('patrol');
    } else if (this.state === 'patrol') {
      this.setState('attack');
    }

    inp.fire = false;
    inp.boost = false;
    inp.flightAssist = true;
    inp.strafeX = 0;
    inp.strafeY = 0;

    const cls = SHIP_CLASSES[ship.classId];

    if (this.state === 'patrol' || !target) {
      _to.subVectors(this.patrolPoint, ship.position);
      if (_to.length() < 200) this.pickPatrolPoint();
      this.steerToward(ship, _to.normalize(), 1.6);
      inp.throttle = 0.45;
      return inp;
    }

    _to.subVectors(target.position, ship.position);
    const dist = _to.length();

    if (this.state === 'attack') {
      const lead = interceptPoint(ship.position, ship.velocity, target.position, target.velocity, cls.weapon.speed, _aim) ?? _aim.copy(target.position);
      // Imperfect aim: a slowly varying offset that shrinks with skill.
      if (this.jitterIn <= 0) {
        this.jitterIn = 0.4 + this.rng() * 0.5;
        const spread = (1 - this.skill) * 0.045 * dist;
        this.aimJitter.set(this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5).multiplyScalar(spread * 2);
      }
      lead.add(this.aimJitter);
      const aimDir = lead.sub(ship.position).normalize();
      this.steerToward(ship, aimDir, 2.8);

      forwardOf(ship.rotation, _fwd);
      const dot = _fwd.dot(aimDir);
      inp.fire = dist < 1700 && dot > 0.993;

      // Approach fast, slow down for the gun run, and boost to close long gaps.
      inp.throttle = dist > 900 ? 1 : dist > 350 ? 0.75 : 0.35;
      inp.boost = dist > 2600 && ship.energy > 40;

      const lowHealth = ship.shield <= 0 && ship.hull < SHIP_CLASSES[ship.classId].hull * 0.45;
      if (dist < 160 || (this.stateTime > 9 && this.rng() < dt * 0.6) || (lowHealth && this.rng() < dt * 0.5)) {
        this.beginEvade(ship);
      }
    } else if (this.state === 'evade') {
      this.steerToward(ship, this.evadeDir, 2.5);
      inp.throttle = 1;
      inp.boost = ship.energy > 25;
      inp.strafeX = Math.sin(world.time * 2.3 + this.shipId) * 0.8;
      inp.roll = clamp(inp.roll + Math.sin(world.time * 1.7 + this.shipId), -1, 1);
      if (this.stateTime > 2.2 + this.rng() * 1.5 && dist > 600) this.setState('attack');
      if (this.stateTime > 6) this.setState('attack');
    }
    return inp;
  }

  private beginEvade(ship: Ship) {
    const r = this.rng;
    forwardOf(ship.rotation, _fwd);
    this.evadeDir.set(r() - 0.5, r() - 0.5, r() - 0.5).normalize().addScaledVector(_fwd, 0.6).normalize();
    this.setState('evade');
  }

  private setState(s: AIState) {
    this.state = s;
    this.stateTime = 0;
  }

  private findTarget(world: World, ship: Ship): EntityId | null {
    let best: EntityId | null = null;
    let bestScore = Infinity;
    for (const other of world.ships.values()) {
      if (!other.alive || other.faction === ship.faction) continue;
      const d = other.position.distanceTo(ship.position);
      if (d > 7000 || other.position.distanceTo(this.anchor) > LEASH) continue;
      // Prefer human pilots, whoever shot us last, and the current target (hysteresis).
      let score = d;
      if (other.ownerId !== null) score *= 0.6;
      if (other.id === ship.lastAttacker) score *= 0.5;
      if (other.id === this.targetId) score *= 0.7;
      if (score < bestScore) {
        bestScore = score;
        best = other.id;
      }
    }
    return best;
  }

  /** Bank-and-pull steering toward a world-space direction. */
  private steerToward(ship: Ship, dir: Vector3, gain: number) {
    _inv.copy(ship.rotation).invert();
    _local.copy(dir).applyQuaternion(_inv);
    const yawErr = Math.atan2(_local.x, -_local.z);
    const pitchErr = Math.atan2(_local.y, Math.hypot(_local.x, _local.z));
    const inp = this.input;
    inp.yaw = clamp(yawErr * gain, -1, 1);
    inp.pitch = clamp(pitchErr * gain, -1, 1);
    // Roll so that the target ends up "above" the canopy for hard turns.
    const offAxis = Math.hypot(_local.x, _local.y);
    inp.roll = offAxis > 0.25 ? clamp(Math.atan2(_local.x, _local.y) * 0.9, -1, 1) : 0;
  }
}
