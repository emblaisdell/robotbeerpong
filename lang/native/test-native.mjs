// Tests for the native (C / Rust) pipeline. Run: node lang/native/test-native.mjs
//
// For each language it tries to build the player to a flat binary, loads the
// bytes onto the real CPU via the match engine, and asserts the *stable*
// property: it runs and fires a real throw (fired, not crashed, real release
// velocity). It also reports whether the throw is byte-identical to the
// built-in Lobber — true whenever the player tracks the current control law,
// which is actively tuned, so it's informational rather than a pass condition.
// A language whose toolchain isn't installed is SKIPPED, not failed.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Match } from '../../src/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0, skip = 0;

function turn(overrideCode) {
  const m = new Match({ playerA: 'lobber', playerB: 'lobber', seed: 7 });
  m.current = 'A';
  m.robots.A.drinks = 0;
  if (overrideCode) m.robots.A.code = overrideCode;
  const r = m.simulateTurn();
  return { fired: r.fired, crashed: r.crashed, vel: r.release && r.release.vel, outcome: r.outcome };
}
const reference = JSON.stringify(turn(null));

function check(lang, dir) {
  const build = join(dir, 'build.sh');
  const bin = join(dir, 'player.bin');
  try {
    const out = execFileSync('sh', [build], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(`  ${lang}: ${out.trim().split('\n').pop()}\n`);
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString();
    if (e.status === 127 || /no RISC-V|no objcopy|not found/i.test(msg)) {
      skip++; console.log(`  ${lang}: SKIP (toolchain not installed)`); return;
    }
    fail++; console.error(`  ${lang}: BUILD FAILED\n${msg}`); return;
  }
  if (!existsSync(bin)) { fail++; console.error(`  ${lang}: no player.bin produced`); return; }

  const sig = turn(new Uint8Array(readFileSync(bin)));
  const fires = sig.fired === true && sig.crashed === false && !!sig.vel;
  if (fires) { pass++; console.log(`  ${lang}: OK — loads on the real CPU and fires a real throw`); }
  else { fail++; console.error(`  ${lang}: ran but did not fire a valid throw: ${JSON.stringify(sig)}`); }
  console.log(`    (byte-identical to built-in Lobber: ${JSON.stringify(sig) === reference ? 'yes' : 'no — control law tuned since written'})`);
}

console.log('Native pipeline (real toolchains -> flat binary -> real CPU):');
check('rust', join(here, 'rust'));
check('c', join(here, 'c'));

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail ? 1 : 0);
