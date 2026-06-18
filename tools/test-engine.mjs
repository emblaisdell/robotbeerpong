// Headless match simulation — verifies the players actually play.
// Run: node tools/test-engine.mjs
import { Match } from '../src/engine.js';
import { PLAYERS } from '../src/players.js';

// 1) Sober accuracy: with drinks disabled, each strategy should sink the rack
// in a reasonable number of throws (no opponent firing back).
function soloAccuracy(playerId, maxTurns = 40) {
  const m = new Match({ playerA: playerId, playerB: playerId, seed: 7 });
  // Freeze A's drinks at 0 by never letting B score: we just run A's turns.
  let sinks = 0, throws = 0;
  for (let i = 0; i < maxTurns && !m.robots.B.defeated(); i++) {
    m.current = 'A';
    m.robots.A.drinks = 0; // keep sober for the accuracy probe
    const e = m.runTurn();
    throws++;
    if (e.result === 'sink') sinks++;
  }
  return { sinks, throws, cleared: m.robots.B.defeated() };
}

console.log('Sober solo accuracy (clearing a 6-cup rack):');
for (const p of PLAYERS) {
  const r = soloAccuracy(p.id);
  console.log(`  ${p.name.padEnd(7)} sank ${r.sinks}/6 in ${r.throws} throws  cleared=${r.cleared}`);
}

// 2) Full head-to-head matches across seeds: should always terminate with a
// winner and a believable drink count.
console.log('\nHead-to-head (Sniper vs Lobber), 5 seeds:');
let aWins = 0, bWins = 0;
for (let seed = 1; seed <= 5; seed++) {
  const m = new Match({ playerA: 'sniper', playerB: 'lobber', seed });
  let guard = 0;
  while (!m.winner && guard < 500) { m.runTurn(); guard++; }
  if (m.winner === 'A') aWins++; else if (m.winner === 'B') bWins++;
  const s = m.state();
  console.log(`  seed ${seed}: winner=${m.winner} turns=${s.turn} drinks A=${s.A.drinks} B=${s.B.drinks}`);
}
console.log(`  totals: Sniper(A)=${aWins}  Lobber(B)=${bWins}`);

// 3) Every match across all pairings terminates (no infinite games).
console.log('\nAll pairings terminate:');
let ok = true;
for (const a of PLAYERS) for (const b of PLAYERS) {
  const m = new Match({ playerA: a.id, playerB: b.id, seed: 3 });
  let guard = 0;
  while (!m.winner && guard < 1000) { m.runTurn(); guard++; }
  const done = !!m.winner;
  ok = ok && done;
  console.log(`  ${a.name} vs ${b.name}: ${done ? 'winner ' + m.winner : 'NO WINNER'} in ${m.turnIndex} turns`);
}
console.log(ok ? '\nAll matches terminated.' : '\nSOME MATCHES HUNG');
process.exit(ok ? 0 : 1);
