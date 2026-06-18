// Validate the rigid-body cup world and re-derive the launch calibration:
// for each opponent cup, does the analytic launch actually settle the ball in
// that cup under real physics? Run: node tools/test-physics.mjs
import { COURT, GRAVITY, MM_PER_UNIT, CUP_PHYS } from '../src/constants.js';
import { rackPositions, bearingRange, launchVelocity, originOf } from '../src/physics.js';
import { CupWorld } from '../src/cupworld.js';

const PITCH = 785;
const THROWER = -1;
const cupsW = rackPositions(+1).map((c) => ({ index: c.index, x: c.x, z: c.z }));
const allCups = rackPositions(+1);
const origin = originOf(THROWER);
const g_mm = GRAVITY * MM_PER_UNIT;

const isqrt = (n) => { let x = Math.floor(Math.sqrt(Math.max(0, n))); while (x * x > n) x--; while ((x + 1) * (x + 1) <= n) x++; return x; };

function throwAt(cup, frac) {
  const { bearing, range } = bearingRange(THROWER, cup);
  const pow = isqrt(Math.floor((g_mm * range * frac) / 1000));
  const velocity = launchVelocity(THROWER, bearing, PITCH, pow);
  const w = new CupWorld({ cups: cupsW });
  w.launch({ origin, velocity });
  const r = w.resolve();
  return { ...r, pow, steps: w.steps };
}

// 1) Drop straight into the front cup's centre — must settle as a sink.
{
  const c = allCups[5];
  const w = new CupWorld({ cups: cupsW });
  w.launch({ origin: { x: c.x, y: 8, z: c.z }, velocity: { x: 0, y: 0, z: 0 } });
  const r = w.resolve();
  console.log(`drop test (cup 5): ${r.result} cup=${r.cupIndex} (expect sink 5)`);
}

// 2) Sweep FRAC: which single constant settles the most cups?
let best = null;
for (let frac = 500; frac <= 1100; frac += 5) {
  let sunk = 0;
  for (const c of allCups) {
    const r = throwAt(c, frac);
    if (r.result === 'sink' && r.cupIndex === c.index) sunk++;
  }
  if (!best || sunk > best.sunk) best = { frac, sunk };
}
console.log(`\nbest FRAC=${best.frac}  settles ${best.sunk}/6 cups`);

// 3) Detail at best FRAC.
console.log('\nper-cup @ best FRAC:');
for (const c of allCups) {
  const r = throwAt(c, best.frac);
  console.log(`  cup ${c.index}: pow=${r.pow} -> ${r.result} cup=${r.cupIndex} (${r.steps} steps)`);
}
