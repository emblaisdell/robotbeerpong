// Verify the arm's forward kinematics + Jacobian, and probe the dynamics so we
// know a swing can reach court-clearing tip speeds. Run: node tools/test-arm.mjs
import { Arm, ARM } from '../src/arm.js';

// 1) Jacobian check: tipVelocity() should equal the finite difference of tip().
{
  const arm = new Arm(-1);
  arm.yaw = { a: 0.2, w: 0.5 };
  arm.shoulder = { a: 0.6, w: 1.3 };
  arm.elbow = { a: -0.4, w: -0.7 };
  const p0 = arm.tip();
  const v = arm.tipVelocity();
  const h = 1e-6;
  // advance angles by w*h (pure kinematics, no dynamics)
  const a2 = new Arm(-1);
  a2.yaw = { a: 0.2 + 0.5 * h, w: 0.5 };
  a2.shoulder = { a: 0.6 + 1.3 * h, w: 1.3 };
  a2.elbow = { a: -0.4 + -0.7 * h, w: -0.7 };
  const p1 = a2.tip();
  const fd = { x: (p1.x - p0.x) / h, y: (p1.y - p0.y) / h, z: (p1.z - p0.z) / h };
  const err = Math.hypot(v.x - fd.x, v.y - fd.y, v.z - fd.z);
  console.log(`Jacobian vs finite-diff error: ${err.toFixed(4)} (analytic v=[${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}])`);
  console.log(err < 1e-2 ? '  OK' : '  FAIL');
}

// 2) Rest tip height sanity (arm straight up).
{
  const arm = new Arm(-1);
  const t = arm.tip();
  console.log(`\nrest tip: y=${t.y.toFixed(2)} z=${t.z.toFixed(2)} (expect y≈${ARM.baseH + ARM.L1 + ARM.L2}, z≈-30)`);
}

// 3) Swing probe: wind the shoulder back, then drive it forward at max torque,
// recording peak tip speed and the launch elevation when speed crosses 30 u/s.
{
  const dt = 1 / 240;
  const arm = new Arm(-1);
  let phase = 'wind', best = 0, crossing = null;
  for (let i = 0; i < 1200; i++) {
    let tau = { yaw: 0, shoulder: 0, elbow: 0 };
    if (phase === 'wind') {
      tau.shoulder = -ARM.tauMax.shoulder;       // wind back
      tau.elbow = -ARM.tauMax.elbow;
      if (arm.shoulder.a <= -1.4) phase = 'throw';
    } else {
      tau.shoulder = ARM.tauMax.shoulder;        // swing forward
      tau.elbow = ARM.tauMax.elbow;
    }
    arm.step(tau, dt);
    const v = arm.tipVelocity();
    const speed = Math.hypot(v.x, v.y, v.z);
    const elevation = Math.atan2(v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI;
    best = Math.max(best, speed);
    if (phase === 'throw' && !crossing && speed >= 30 && arm.shoulder.a > 0) {
      crossing = { speed: speed.toFixed(1), elevDeg: elevation.toFixed(0), shoulderDeg: (arm.shoulder.a * 180 / Math.PI).toFixed(0) };
    }
    if (arm.shoulder.a >= ARM.limit.shoulder - 0.01) break;
  }
  console.log(`\nswing probe: peak tip speed ${best.toFixed(1)} u/s (need ~30-32 to clear the court)`);
  console.log(`  first 30 u/s crossing forward of vertical:`, crossing || '(never)');
}
