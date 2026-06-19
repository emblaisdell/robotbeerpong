// Headless match simulation — the RISC-V joint controllers drive the real arm
// dynamics, and the rigid-body cup physics decides outcomes.
// Run: node tools/test-engine.mjs
import { Match } from '../src/engine.js';
import { PLAYERS } from '../src/players.js';

function resolveTurn(m) {
  const r = m.simulateTurn();
  if (!r) return null;
  const info = m.applyOutcome(r.outcome);
  return { r, info };
}

// 1) Sober accuracy: drinks pinned to 0, each controller should clear the rack.
function soloAccuracy(playerId, maxTurns = 40) {
  const m = new Match({ playerA: playerId, playerB: playerId, seed: 7 });
  let sinks = 0, throws = 0, fired = 0;
  for (let i = 0; i < maxTurns && !m.robots.B.defeated(); i++) {
    m.current = 'A';
    m.robots.A.drinks = 0;
    const { r, info } = resolveTurn(m);
    throws++;
    if (r.fired) fired++;
    if (info.result === 'sink') sinks++;
  }
  return { sinks, throws, fired, cleared: m.robots.B.defeated() };
}

console.log('Sober solo accuracy (torque-control swing, real physics):');
for (const p of PLAYERS) {
  const r = soloAccuracy(p.id);
  console.log(`  ${p.name.padEnd(7)} sank ${r.sinks}/6 in ${r.throws} throws (fired ${r.fired})  cleared=${r.cleared}`);
}

// 2) Head-to-head across seeds.
console.log('\nHead-to-head (Sniper vs Lobber), 5 seeds:');
let aWins = 0, bWins = 0;
for (let seed = 1; seed <= 5; seed++) {
  const m = new Match({ playerA: 'sniper', playerB: 'lobber', seed });
  let guard = 0;
  while (!m.winner && guard < 400) { resolveTurn(m); guard++; }
  if (m.winner === 'A') aWins++; else if (m.winner === 'B') bWins++;
  const s = m.state();
  console.log(`  seed ${seed}: winner=${m.winner} turns=${s.turn} drinks A=${s.A.drinks} B=${s.B.drinks}`);
}
console.log(`  totals: Sniper(A)=${aWins}  Lobber(B)=${bWins}`);

// 3) Every pairing terminates.
console.log('\nAll pairings terminate:');
let ok = true;
for (const a of PLAYERS) for (const b of PLAYERS) {
  const m = new Match({ playerA: a.id, playerB: b.id, seed: 3 });
  let guard = 0;
  while (!m.winner && guard < 800) { resolveTurn(m); guard++; }
  ok = ok && !!m.winner;
  console.log(`  ${a.name} vs ${b.name}: ${m.winner ? 'winner ' + m.winner : 'NO WINNER'} in ${m.turnIndex} turns`);
}
console.log(ok ? '\nAll matches terminated.' : '\nSOME MATCHES HUNG');
process.exit(ok ? 0 : 1);
