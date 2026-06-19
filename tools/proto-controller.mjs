// Prototype the torque-control swing in JS, tune it against the real arm +
// cup physics, then transcribe the logic/constants to RV32 asm in players.js.
//
// Control law (per tick), integer-friendly so it ports cleanly:
//   once: v = isqrt(g*range*FRAC/1000); wstar = v*1000/armlen; yawTarget=bearing
//   yaw   : PD to bearing            elbow: PD to 0 (keep the arm straight)
//   shoulder: phase 0 wind back to `windback`, phase 1 drive ang.vel -> +wstar,
//             release when shoulder crosses `releaseAngle` moving forward.
// Run: node tools/proto-controller.mjs
import { Arm, ARM } from '../src/arm.js';
import { CupWorld } from '../src/cupworld.js';
import { GRAVITY, MM_PER_UNIT, CTRL } from '../src/constants.js';
import { rackPositions, bearingRange, originOf } from '../src/physics.js';

const isqrt = (n) => { let x = Math.floor(Math.sqrt(Math.max(0, n))); while (x * x > n) x--; while ((x + 1) * (x + 1) <= n) x++; return x; };
const idiv = (a, b) => Math.trunc(a / b);   // RISC-V signed div truncates toward zero
const g_mm = GRAVITY * MM_PER_UNIT;

// This mirrors the RV32 asm in players.js EXACTLY (rounded integer sensors,
// truncating division, combined numerators) so the tuned FRAC ports verbatim.
function controller(p) {
  let phase = 0, wstar = 0, yawT = 0, inited = false;
  return (s) => {
    if (!inited) {
      const t = idiv(s.range * p.FRAC, 1000) * g_mm; // asm order: (range*FRAC)/1000 then *g
      wstar = idiv(isqrt(t) * 1000, s.armlen);
      yawT = s.bearing; inited = true;
    }
    const tqY = idiv(200 * (yawT - s.yaw) - 40 * s.yawv, 1000);
    const elbowTarget = phase === 0 ? p.cock : 0;
    const tqE = idiv(220 * (elbowTarget - s.el) - 40 * s.elv, 1000);
    let tqS = 0, release = false;
    if (phase === 0) {
      tqS = idiv(260 * (p.windback - s.sh) - 50 * s.shv, 1000);
      if (s.sh <= p.windback + 120) phase = 1;
    } else if (phase === 1) {
      tqS = idiv(120 * (wstar - s.shv), 1000);
      if (s.sh >= p.releaseAngle && s.shv > 0) { release = true; phase = 2; }
    }
    return { yaw: tqY, shoulder: tqS, elbow: tqE, release, wstar };
  };
}

function sense(arm, truth) {
  return {
    bearing: truth.bearing, range: truth.range, armlen: Math.round((ARM.L1 + ARM.L2) * MM_PER_UNIT),
    yaw: Math.round(arm.yaw.a * 1000), yawv: Math.round(arm.yaw.w * 1000),
    sh: Math.round(arm.shoulder.a * 1000), shv: Math.round(arm.shoulder.w * 1000),
    el: Math.round(arm.elbow.a * 1000), elv: Math.round(arm.elbow.w * 1000),
  };
}

function throwAt(cup, p) {
  const arm = new Arm(-1);
  const truth = bearingRange(-1, cup);
  const ctl = controller(p);
  let release = null, lastWstar = 0;
  for (let t = 0; t < CTRL.maxTicks; t++) {
    const cmd = ctl(sense(arm, truth));
    lastWstar = cmd.wstar;
    arm.step({ yaw: cmd.yaw, shoulder: cmd.shoulder, elbow: cmd.elbow }, CTRL.dt);
    if (cmd.release) { release = { tip: arm.tip(), vel: arm.tipVelocity(), spin: arm.spin(), ticks: t, elA: Math.round(arm.elbow.a * 1000), elW: Math.round(arm.elbow.w * 1000) }; break; }
  }
  if (!release) return { result: 'nofire', wstar: lastWstar };
  const w = new CupWorld({ cups: rackPositions(+1).map((c) => ({ index: c.index, x: c.x, z: c.z })) });
  w.launch({ origin: release.tip, velocity: release.vel, spin: release.spin });
  const r = w.resolve();
  const speed = Math.hypot(release.vel.x, release.vel.y, release.vel.z);
  const elev = Math.atan2(release.vel.y, Math.hypot(release.vel.x, release.vel.z)) * 180 / Math.PI;
  return { ...r, speed: speed.toFixed(1), elev: elev.toFixed(0), ticks: release.ticks, wstar: lastWstar };
}

const cups = rackPositions(+1);
const base = {
  KpY: 200, KdY: 40, KpE: 220, KdE: 40, KpS: 260, KdS: 50, Kv: 120,
  windback: -1450, releaseAngle: -785, cock: 1100,
};

// 2-D sweep over release angle (arc height) x FRAC (speed) for the gated swing.
let best = null;
for (const releaseAngle of [-740, -800, -860, -920, -980]) {
  for (let FRAC = 1000; FRAC <= 1360; FRAC += 20) {
    let sunk = 0;
    for (const c of cups) { const r = throwAt(c, { ...base, releaseAngle, FRAC }); if (r.result === 'sink' && r.cupIndex === c.index) sunk++; }
    if (!best || sunk > best.sunk) { best = { releaseAngle, FRAC, sunk }; }
  }
}
console.log(`best releaseAngle=${best.releaseAngle} FRAC=${best.FRAC} settles ${best.sunk}/6`);
for (const c of cups) {
  const r = throwAt(c, { ...base, releaseAngle: best.releaseAngle, FRAC: best.FRAC });
  console.log(`  cup ${c.index}: ${r.result} cup=${r.cupIndex} speed=${r.speed} elev=${r.elev}° ticks=${r.ticks}`);
}
