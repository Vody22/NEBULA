import { Quaternion, Vector3 } from 'three';
import { clamp } from '../math';
import { statsOf } from './upgrades';
import type { Ship } from './types';

const _q = new Quaternion();
const _axis = new Vector3();
const _localVel = new Vector3();
const _desired = new Vector3();
const _invRot = new Quaternion();

/** Moves `current` toward `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/**
 * Integrates one ship for `dt` seconds from its current input.
 * Pure function of (state, input, dt): the same code will run on the
 * authoritative server and in client-side prediction.
 */
export function stepShipPhysics(ship: Ship, dt: number) {
  const cls = statsOf(ship);
  const input = ship.input;

  // --- Rotation: angular velocity eases toward the requested rate (inertia).
  const targetPitch = clamp(input.pitch, -1, 1) * cls.pitchRate;
  const targetYaw = -clamp(input.yaw, -1, 1) * cls.yawRate;
  const targetRoll = -clamp(input.roll, -1, 1) * cls.rollRate;
  const k = 1 - Math.exp(-cls.angularResponse * dt);
  const av = ship.angularVelocity;
  av.x += (targetPitch - av.x) * k;
  av.y += (targetYaw - av.y) * k;
  av.z += (targetRoll - av.z) * k;

  const angle = av.length() * dt;
  if (angle > 1e-7) {
    _axis.copy(av).normalize();
    _q.setFromAxisAngle(_axis, angle);
    ship.rotation.multiply(_q).normalize();
  }

  // --- Energy & boost
  const wantsBoost = input.boost && ship.energy > 1;
  ship.boosting = wantsBoost;
  if (wantsBoost) {
    ship.energy = Math.max(0, ship.energy - cls.boostCost * dt);
  }

  // --- Translation, computed in the ship's local frame.
  _invRot.copy(ship.rotation).invert();
  _localVel.copy(ship.velocity).applyQuaternion(_invRot);

  const throttle = clamp(input.throttle, -0.4, 1);
  const sx = clamp(input.strafeX, -1, 1);
  const sy = clamp(input.strafeY, -1, 1);
  const fwdAccel = wantsBoost ? cls.boostAccel : cls.mainAccel;
  const speedCap = wantsBoost ? cls.boostSpeed : cls.maxSpeed;

  if (input.flightAssist) {
    // Flight assist: thrusters chase a desired local velocity with limited
    // authority per axis. Turning therefore produces a visible drift.
    const forwardSpeed = wantsBoost ? cls.boostSpeed : throttle * cls.maxSpeed;
    _desired.set(sx * cls.strafeSpeed, sy * cls.strafeSpeed, -forwardSpeed);
    _localVel.x = approach(_localVel.x, _desired.x, cls.strafeAccel * dt);
    _localVel.y = approach(_localVel.y, _desired.y, cls.strafeAccel * dt);
    // Decelerating from boost uses retro thrusters (slightly weaker).
    const zAuthority = _localVel.z < _desired.z ? cls.mainAccel * 0.8 : fwdAccel;
    _localVel.z = approach(_localVel.z, _desired.z, zAuthority * dt);
  } else {
    // Newtonian: thrust is pure acceleration, nothing damps the drift.
    const main = wantsBoost ? 1 : throttle;
    _localVel.z -= main * fwdAccel * dt;
    _localVel.x += sx * cls.strafeAccel * dt;
    _localVel.y += sy * cls.strafeAccel * dt;
  }

  ship.velocity.copy(_localVel).applyQuaternion(ship.rotation);
  const speed = ship.velocity.length();
  const hardCap = Math.max(speedCap, cls.boostSpeed);
  if (speed > hardCap) ship.velocity.multiplyScalar(hardCap / speed);

  ship.position.addScaledVector(ship.velocity, dt);
}
