// A real articulated robot arm with torque-driven joint dynamics. This is the
// thing the RISC-V program actually controls: it writes a motor torque to each
// joint every tick, and the arm responds with inertia, gravity, damping, and
// joint limits. The ball, when released, leaves at the end-effector's true
// velocity (forward kinematics + Jacobian) — the throw *is* the arm's motion.
//
// Geometry (world units) is derived from robot.glb at its in-scene scale (0.8):
// shoulder pivot at y=baseH, then two equal segments to the magnet tip.
//
// Joint angles (radians):
//   yaw      — waist rotation about vertical; 0 aims straight at the opponent.
//   shoulder — upper-arm angle from straight-up; + tips toward the opponent.
//   elbow    — forearm angle relative to the upper arm; + continues the bend.

import { GRAVITY, COURT } from './constants.js';
import { worldFromLocal } from './physics.js';

export const ARM = {
  baseH: 3.2, L1: 6.4, L2: 6.4,        // geometry
  // Dynamics — inertias, viscous damping, gravity-torque coefficients, motor
  // torque ceilings, and joint limits. Tuned (tools/test-arm.mjs) so a full
  // swing reaches court-clearing tip speeds and a controller can manage it.
  I: { yaw: 5, shoulder: 8, elbow: 2.5 },
  damp: { yaw: 2.0, shoulder: 1.2, elbow: 0.8 },
  grav: { shoulder: 9, elbow: 3 },     // peak gravity torque (arm horizontal)
  tauMax: { yaw: 60, shoulder: 220, elbow: 90 },
  limit: { yaw: 1.2, shoulder: 2.5, elbow: 2.6 },
};

export class Arm {
  constructor(side) {
    this.side = side; // -1 (robot A, faces +Z) / +1 (robot B, faces -Z)
    this.reset();
  }

  reset() {
    this.yaw = { a: 0, w: 0 };
    this.shoulder = { a: 0, w: 0 };
    this.elbow = { a: 0, w: 0 };
  }

  // Integrate one step under the commanded torques (semi-implicit Euler).
  // tau: { yaw, shoulder, elbow } (engine units, clamped to tauMax).
  step(tau, dt) {
    this._stepJoint(this.yaw, tau.yaw, ARM.I.yaw, ARM.damp.yaw, 0, ARM.tauMax.yaw, ARM.limit.yaw, dt);
    // Gravity torque grows with how far the segment is tipped from vertical.
    const gSh = ARM.grav.shoulder * Math.sin(this.shoulder.a);
    this._stepJoint(this.shoulder, tau.shoulder, ARM.I.shoulder, ARM.damp.shoulder, gSh, ARM.tauMax.shoulder, ARM.limit.shoulder, dt);
    const gEl = ARM.grav.elbow * Math.sin(this.shoulder.a + this.elbow.a);
    this._stepJoint(this.elbow, tau.elbow, ARM.I.elbow, ARM.damp.elbow, gEl, ARM.tauMax.elbow, ARM.limit.elbow, dt);
  }

  _stepJoint(j, tau, I, damp, grav, tauMax, limit, dt) {
    const t = Math.max(-tauMax, Math.min(tauMax, tau || 0));
    const alpha = (t - damp * j.w - grav) / I;
    j.w += alpha * dt;
    j.a += j.w * dt;
    if (j.a > limit) { j.a = limit; if (j.w > 0) j.w = 0; }
    else if (j.a < -limit) { j.a = -limit; if (j.w < 0) j.w = 0; }
  }

  // In-plane tip position (forward toward opponent, up) before yaw/side mapping.
  _plane() {
    const s = this.shoulder.a, e = this.shoulder.a + this.elbow.a;
    const f = ARM.L1 * Math.sin(s) + ARM.L2 * Math.sin(e);
    const u = ARM.baseH + ARM.L1 * Math.cos(s) + ARM.L2 * Math.cos(e);
    return { f, u, s, e };
  }

  // World position of the end-effector (magnet tip).
  tip() {
    const { f, u } = this._plane();
    const y = this.yaw.a;
    const local = { x: f * Math.sin(y), y: u, z: f * Math.cos(y) };
    const w = worldFromLocal(local, this.side);
    return { x: w.x, y: u, z: this.side * COURT.robotZ + w.z };
  }

  // World velocity of the tip from the joint angular velocities (the Jacobian).
  // This is the ball's launch velocity at release.
  tipVelocity() {
    const s = this.shoulder.a, e = this.shoulder.a + this.elbow.a;
    const ws = this.shoulder.w, we = this.shoulder.w + this.elbow.w;
    // d/dt of the in-plane (f, u).
    const vf = ARM.L1 * ws * Math.cos(s) + ARM.L2 * we * Math.cos(e);
    const vu = -ARM.L1 * ws * Math.sin(s) - ARM.L2 * we * Math.sin(e);
    const { f } = this._plane();
    const y = this.yaw.a, wy = this.yaw.w;
    // Forward velocity along the aim direction + tangential from the yaw rate.
    const local = {
      x: vf * Math.sin(y) + wy * f * Math.cos(y),
      y: vu,
      z: vf * Math.cos(y) - wy * f * Math.sin(y),
    };
    return worldFromLocal(local, this.side);
  }

  // Angular velocity of the tip frame (for ball spin), world axis + rate.
  spin() {
    // The dominant spin is the forearm's absolute angular rate about the
    // horizontal axis perpendicular to the throw plane.
    const rate = this.shoulder.w + this.elbow.w;
    // That perpendicular axis in world: local +x (lateral), mapped by side.
    const ax = worldFromLocal({ x: 1, y: 0, z: 0 }, this.side);
    return { axis: ax, rate };
  }

  // Snapshot for the renderer / sensors.
  state() {
    return {
      yaw: this.yaw.a, shoulder: this.shoulder.a, elbow: this.elbow.a,
      yawW: this.yaw.w, shoulderW: this.shoulder.w, elbowW: this.elbow.w,
    };
  }
}
