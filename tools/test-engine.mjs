// Headless match simulation — verifies the players actually play, with the
// rigid-body cup physics deciding outcomes. Run: node tools/test-engine.mjs
import { Match } from '../src/engine.js';
import { PLAYERS } from '../src/players.js';
import { CupWorld } from '../src/cupworld.js';

// Resolve one turn end-to-end: compute the launch, run the physics, score it.
function resolveTurn(m) {
  const ev = m.computeThrow();
  if (!ev) return null;
  const world = new CupWorld({ cups: m.liveTargetCups() });
  world.launch({ origin: ev.origin, velocity: ev.velocity });
  const outcome = world.resolve();
  const info = m.applyOutcome(outcome);
  return { ev, info };
}

// 1) Sober accuracy: with drinks pinned to 0, each strategy should clear a
// 6-cup rack in a reasonable number of throws (opponent never fires back).
function soloAccuracy(playerId, maxTurns = 40) {
  const m = new Match({ playerA: playerId, playerB: playerId, seed: 7 });
  let sinks = 0, throws = 0;
  for (let i = 0; i < maxTurns && !m.robots.B.defeated(); i++) {
    m.current = 'A';
    m.robots.A.drinks = 0; // keep sober for the accuracy probe
    const r = resolveTurn(m);
    throws++;
    if (r.info.result === 'sink') sinks++;
  }
  return { sinks, throws, cleared: m.robots.B.defeated() };
}

console.log('Sober solo accuracy (clearing a 6-cup rack, real physics):');
for (const p of PLAYERS) {
  const r = soloAccuracy(p.id);
  console.log(`  ${p.name.padEnd(7)} sank ${r.sinks}/6 in ${r.throws} throws  cleared=${r.cleared}`);
}

// 2) Head-to-head across seeds: terminate with a winner + believable drinks.
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
  const done = !!m.winner;
  ok = ok && done;
  console.log(`  ${a.name} vs ${b.name}: ${done ? 'winner ' + m.winner : 'NO WINNER'} in ${m.turnIndex} turns`);
}
console.log(ok ? '\nAll matches terminated.' : '\nSOME MATCHES HUNG');
process.exit(ok ? 0 : 1);
