// Find the integer ballistics constant the "sniper" strategy bakes in.
//
// The sniper aims yaw = bearing, fires at a fixed pitch, and computes launch
// speed v_mm = isqrt(g_mm * R_mm * FRAC / 1000). We sweep FRAC and report the
// value that sinks the most opponent cups when sober. Run: node tools/calibrate.mjs
import { COURT, GRAVITY, MM_PER_UNIT } from '../src/constants.js';
import { rackPositions, bearingRange, launchVelocity, simulate } from '../src/physics.js';

const PITCH_MRAD = 785; // ~45 degrees
const THROWER = -1;     // robot A at -Z throws at B's rack (+1)
const cups = rackPositions(+1);
const g_mm = GRAVITY * MM_PER_UNIT;

function isqrt(n) {
  if (n < 0) return 0;
  let x = Math.floor(Math.sqrt(n));
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

// Per-cup: the exact power needed (search), and the geometry.
console.log('cup  bearing(mrad)  range(mm)  exactPow(mm/s)');
const exact = [];
for (const c of cups) {
  const { bearing, range } = bearingRange(THROWER, c);
  // binary-search the power that lands closest to this cup centre
  let best = null;
  for (let pow = 1000; pow <= 12000; pow += 10) {
    const vel = launchVelocity(THROWER, bearing, PITCH_MRAD, pow);
    const r = simulate({ x: 0, y: 14, z: THROWER * COURT.robotZ }, vel, [{ ...c, alive: true }]);
    const d = Math.hypot(r.landing.x - c.x, r.landing.z - c.z);
    if (!best || d < best.d) best = { pow, d, res: r.result };
  }
  exact.push({ bearing, range, pow: best.pow });
  console.log(
    `${c.index}    ${String(bearing).padStart(8)}     ${String(range).padStart(6)}      ${best.pow} (${best.res}, miss ${best.d.toFixed(2)})`,
  );
}

// Sweep FRAC for v = isqrt(g_mm * range * FRAC / 1000)
let bestFrac = null;
for (let frac = 400; frac <= 1600; frac++) {
  let sunk = 0;
  for (const c of cups) {
    const { bearing, range } = bearingRange(THROWER, c);
    const pow = isqrt(Math.floor((g_mm * range * frac) / 1000));
    const vel = launchVelocity(THROWER, bearing, PITCH_MRAD, pow);
    const r = simulate({ x: 0, y: 14, z: THROWER * COURT.robotZ }, vel, cups.map((k) => ({ ...k, alive: true })));
    if (r.result === 'sink' && r.cupIndex === c.index) sunk++;
  }
  if (!bestFrac || sunk > bestFrac.sunk) bestFrac = { frac, sunk };
}
console.log(`\nGRAVITY=${GRAVITY}  PITCH=${PITCH_MRAD}mrad`);
console.log(`best FRAC=${bestFrac.frac}/1000  sinks ${bestFrac.sunk}/${cups.length} cups when sober`);

// Show the actual result per cup at the chosen FRAC.
const frac = bestFrac.frac;
console.log('\nverify @ best FRAC:');
for (const c of cups) {
  const { bearing, range } = bearingRange(THROWER, c);
  const pow = isqrt(Math.floor((g_mm * range * frac) / 1000));
  const vel = launchVelocity(THROWER, bearing, PITCH_MRAD, pow);
  const r = simulate({ x: 0, y: 14, z: THROWER * COURT.robotZ }, vel, cups.map((k) => ({ ...k, alive: true })));
  console.log(`  cup ${c.index}: pow=${pow}  -> ${r.result} cup=${r.cupIndex}`);
}
