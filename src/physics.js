// Pure ballistics + court geometry. No Three.js, no RISC-V — just maths, so it
// can be unit-tested and reused by both the engine and the calibration tool.
//
// Frames: each robot reasons in a *local* frame where +z points across the
// table toward the opponent and +y is up. Side = -1 is the robot at -Z
// (faces +Z); side = +1 is the robot at +Z (faces -Z). worldFromLocal() maps
// a local vector into world space by a 180° yaw for the +Z robot.

import {
  COURT, GRAVITY, BALL_RADIUS, LAUNCH_HEIGHT, MM_PER_UNIT, MRAD, rackLayout,
} from './constants.js';

// Hand / launch origin for a robot in world space.
export function originOf(side) {
  return { x: 0, y: LAUNCH_HEIGHT, z: side * COURT.robotZ };
}

// Map a local vector (forward = +z) into world space.
export function worldFromLocal(v, side) {
  return side < 0 ? { x: v.x, y: v.y, z: v.z } : { x: -v.x, y: v.y, z: -v.z };
}
// Inverse: world delta -> local frame.
export function localFromWorld(v, side) {
  return side < 0 ? { x: v.x, y: v.y, z: v.z } : { x: -v.x, y: v.y, z: -v.z };
}

// World positions of the cups a given side *defends* (the opponent throws at
// these). The triangle apex points toward centre court.
export function rackPositions(side) {
  const layout = rackLayout();
  const r = COURT.cupRowGap;
  const backZ = 2 * r; // local z of the front (apex) cup in rackLayout terms
  return layout.map((c, i) => {
    // The apex cup (c.z == backZ) sits nearest centre court at cupNearZ; the
    // back row recedes toward the owning robot. Place on the owner's own half.
    const dist = COURT.cupNearZ + (backZ - c.z);
    return {
      x: side * c.x,
      y: COURT.cupMouthHeight,
      z: side * dist,
      alive: true,
      index: i,
    };
  });
}

// Bearing (mrad, signed, 0 = straight ahead) and range (mm, horizontal) from a
// robot to a world point. Used to fill the sensor registers.
export function bearingRange(side, targetWorld) {
  const o = originOf(side);
  const rel = localFromWorld({ x: targetWorld.x - o.x, z: targetWorld.z - o.z, y: 0 }, side);
  const bearing = Math.round(Math.atan2(rel.x, rel.z) * MRAD);
  const range = Math.round(Math.hypot(rel.x, rel.z) * MM_PER_UNIT);
  return { bearing, range };
}

// Convert actuator command (yaw/pitch in mrad, power in mm/s) to a world
// launch velocity (world units / s).
export function launchVelocity(side, yawMrad, pitchMrad, powerMmps) {
  const yaw = yawMrad / MRAD;
  const pitch = pitchMrad / MRAD;
  const speed = powerMmps / MM_PER_UNIT; // mm/s -> world u/s
  const local = {
    x: speed * Math.cos(pitch) * Math.sin(yaw),
    y: speed * Math.sin(pitch),
    z: speed * Math.cos(pitch) * Math.cos(yaw),
  };
  return worldFromLocal(local, side);
}

// Integrate a throw. Returns the outcome plus a sampled trajectory for the view.
//   cups: array of {x, z, alive} the ball can fall into (opponent's rack).
export function simulate(origin, vel, cups, opts = {}) {
  const dt = opts.dt ?? 1 / 240;
  const maxT = opts.maxT ?? 6;
  const g = GRAVITY;
  const p = { ...origin };
  const v = { ...vel };
  const points = [{ x: p.x, y: p.y, z: p.z }];
  let prevY = p.y;

  for (let t = 0; t < maxT; t += dt) {
    prevY = p.y;
    v.y -= g * dt;
    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
    points.push({ x: p.x, y: p.y, z: p.z });

    // Sink test: descending through the cup mouth plane, within catch radius.
    if (v.y < 0 && prevY >= COURT.cupMouthHeight && p.y <= COURT.cupMouthHeight) {
      for (const c of cups) {
        if (!c.alive) continue;
        const d = Math.hypot(p.x - c.x, p.z - c.z);
        if (d <= COURT.cupCatchRadius) {
          return { result: 'sink', cupIndex: c.index, landing: { x: p.x, z: p.z }, points };
        }
      }
    }
    // Table / floor hit.
    if (p.y <= BALL_RADIUS) {
      // settle exactly on the table for a tidy landing marker
      p.y = BALL_RADIUS;
      points[points.length - 1] = { x: p.x, y: p.y, z: p.z };
      const onTable = Math.abs(p.x) <= COURT.tableHalfWidth && Math.abs(p.z) <= COURT.robotZ;
      return { result: onTable ? 'miss' : 'offtable', cupIndex: -1, landing: { x: p.x, z: p.z }, points };
    }
  }
  return { result: 'timeout', cupIndex: -1, landing: { x: p.x, z: p.z }, points };
}
