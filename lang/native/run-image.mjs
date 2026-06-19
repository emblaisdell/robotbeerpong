#!/usr/bin/env node
// Load a flat RV32IM binary (from C or Rust) and run it on the real Robot Beer
// Pong CPU — no assembler involved, the bytes ARE the program image.
//
//   node lang/native/run-image.mjs <player.bin>            # mock-device smoke test
//   node lang/native/run-image.mjs --match <player.bin>    # play a real turn vs the engine
//   node lang/native/run-image.mjs --ticks N <player.bin>
//
// This is the loader that proves the native pipeline: the engine's CPU.load()
// takes a Uint8Array at base 0, exactly what objcopy -O binary produced.

import { readFileSync } from 'node:fs';
import { CPU } from '../../src/riscv.js';
import { Match } from '../../src/engine.js';
import {
  MEM_SIZE, MMIO_BASE, STACK_TOP, CTRL,
  S_TICK, S_BEARING, S_RANGE, S_GRAVITY, S_YAW, S_YAW_VEL, S_SHOULDER,
  S_SHOULDER_VEL, S_ELBOW, S_ELBOW_VEL, S_DRINKS, S_CUPS, S_RNG, S_ARMLEN, S_HELD,
  A_TQ_YAW, A_TQ_SHOULDER, A_TQ_ELBOW, A_RELEASE, A_LOG,
} from '../../src/constants.js';

const args = process.argv.slice(2);
let useMatch = false, ticks = 12, bin = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--match') useMatch = true;
  else if (args[i] === '--ticks') ticks = +args[++i];
  else bin = args[i];
}
if (!bin) { console.error('usage: node lang/native/run-image.mjs [--match] [--ticks N] <player.bin>'); process.exit(2); }

const code = new Uint8Array(readFileSync(bin));
console.log(`loaded ${bin} (${code.length} bytes)`);

if (useMatch) {
  // Drop the image straight into a real robot and simulate one turn.
  const m = new Match({ playerA: 'lobber', playerB: 'lobber', seed: 7 });
  m.current = 'A';
  m.robots.A.drinks = 0;
  m.robots.A.code = code;            // <-- native image instead of assembled source
  const r = m.simulateTurn();
  console.log(`\nfull-engine turn: fired=${r.fired} crashed=${r.crashed} frames=${r.armFrames.length}`);
  if (r.release) {
    const v = r.release.vel;
    console.log(`release tip=(${r.release.tip.x.toFixed(2)}, ${r.release.tip.y.toFixed(2)}, ${r.release.tip.z.toFixed(2)})`);
    console.log(`release vel=(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`);
  }
  console.log(`outcome: ${r.outcome.result}${r.outcome.cupIndex >= 0 ? ' (cup ' + r.outcome.cupIndex + ')' : ''}`);
  process.exit(0);
}

// --- mock-device smoke test: drive plausible sensors, print actuator writes ---
const sensors = {
  [S_TICK]: 0, [S_BEARING]: 120, [S_RANGE]: 2600, [S_GRAVITY]: 2600,
  [S_YAW]: 0, [S_YAW_VEL]: 0, [S_SHOULDER]: 0, [S_SHOULDER_VEL]: 0,
  [S_ELBOW]: 0, [S_ELBOW_VEL]: 0, [S_DRINKS]: 0, [S_CUPS]: 6,
  [S_RNG]: 0x12345678, [S_ARMLEN]: 1700, [S_HELD]: 1,
};
const writes = [];
const device = { read32: (a) => sensors[a] | 0, write32: (a, v) => writes.push({ a, v: v | 0 }) };
const cpu = new CPU({ memSize: MEM_SIZE, mmioBase: MMIO_BASE, device });
cpu.load(code);
cpu.reset(0, STACK_TOP);

const NAME = { [A_TQ_YAW]: 'TQ_YAW', [A_TQ_SHOULDER]: 'TQ_SHOULDER', [A_TQ_ELBOW]: 'TQ_ELBOW', [A_RELEASE]: 'RELEASE', [A_LOG]: 'LOG' };
console.log(`running ${ticks} ticks on the mock device\n`);
for (let t = 0; t < ticks; t++) {
  sensors[S_TICK] = t;
  sensors[S_SHOULDER] = -1450 + t * 180;          // pretend the arm swings up
  sensors[S_SHOULDER_VEL] = t < 6 ? -200 : 900;
  writes.length = 0;
  cpu.yielded = false;
  cpu.run(CTRL.perTickBudget);
  console.log(`tick ${String(t).padStart(2)}: ${writes.map((w) => `${NAME[w.a] ?? '0x' + w.a.toString(16)}=${w.v}`).join('  ')}`);
  if (cpu.halted) { console.log('  (halted)'); break; }
}
