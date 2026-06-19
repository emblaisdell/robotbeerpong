#!/usr/bin/env node
// RobotC CLI — compile a .rc source file to RV32IM assembly, or run it.
//
//   node lang/robotc/cli.mjs <file.rc>                 # print assembly
//   node lang/robotc/cli.mjs --run [--ticks N] <file>  # assemble + run on the CPU
//   node lang/robotc/cli.mjs --asm <file.rc>           # same as default
//
// --run executes the program on the real src/riscv.js CPU with a tiny mock
// device that echoes sane sensor values, and prints what it wrote to the
// actuators — a quick smoke test without spinning up the full match engine.

import { readFileSync } from 'node:fs';
import { compile, MMIO_CONSTS } from './compiler.mjs';
import { assemble, CPU } from '../../src/riscv.js';
import {
  MEM_SIZE, MMIO_BASE, STACK_TOP, CTRL,
  A_TQ_YAW, A_TQ_SHOULDER, A_TQ_ELBOW, A_RELEASE, A_LOG,
} from '../../src/constants.js';

const args = process.argv.slice(2);
let mode = 'asm', ticks = 8, file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run') mode = 'run';
  else if (args[i] === '--asm') mode = 'asm';
  else if (args[i] === '--ticks') ticks = +args[++i];
  else file = args[i];
}
if (!file) {
  console.error('usage: node lang/robotc/cli.mjs [--run] [--ticks N] <file.rc>');
  process.exit(2);
}

const source = readFileSync(file, 'utf8');
let asm;
try {
  asm = compile(source);
} catch (e) {
  console.error(`compile error: ${e.message}`);
  process.exit(1);
}

if (mode === 'asm') {
  process.stdout.write(asm);
  process.exit(0);
}

// --- run: assemble and execute a handful of ticks against a mock device ---
const { code } = assemble(asm, MMIO_CONSTS);

// A mock arm that returns plausible, drifting sensor values so the controller
// has something to react to. Not the real physics — just a smoke test.
const sensors = {
  [MMIO_CONSTS.S_TICK]: 0,
  [MMIO_CONSTS.S_BEARING]: 120,
  [MMIO_CONSTS.S_RANGE]: 2600,
  [MMIO_CONSTS.S_GRAVITY]: 2600,
  [MMIO_CONSTS.S_YAW]: 0,
  [MMIO_CONSTS.S_YAW_VEL]: 0,
  [MMIO_CONSTS.S_SHOULDER]: 0,
  [MMIO_CONSTS.S_SHOULDER_VEL]: 0,
  [MMIO_CONSTS.S_ELBOW]: 0,
  [MMIO_CONSTS.S_ELBOW_VEL]: 0,
  [MMIO_CONSTS.S_DRINKS]: 0,
  [MMIO_CONSTS.S_CUPS]: 6,
  [MMIO_CONSTS.S_RNG]: 0x12345678,
  [MMIO_CONSTS.S_ARMLEN]: 1700,
  [MMIO_CONSTS.S_HELD]: 1,
};
const writes = [];
const device = {
  read32: (a) => sensors[a] | 0,
  write32: (a, v) => writes.push({ a, v: v | 0 }),
};
const cpu = new CPU({ memSize: MEM_SIZE, mmioBase: MMIO_BASE, device });
cpu.load(code);
cpu.reset(0, STACK_TOP);

const NAME = { [A_TQ_YAW]: 'TQ_YAW', [A_TQ_SHOULDER]: 'TQ_SHOULDER', [A_TQ_ELBOW]: 'TQ_ELBOW', [A_RELEASE]: 'RELEASE', [A_LOG]: 'LOG' };
console.log(`assembled ${code.length} bytes; running ${ticks} ticks\n`);
for (let t = 0; t < ticks; t++) {
  sensors[MMIO_CONSTS.S_TICK] = t;
  // let the arm drift a bit so the controller keeps reacting
  sensors[MMIO_CONSTS.S_SHOULDER] = -1450 + t * 180;
  sensors[MMIO_CONSTS.S_SHOULDER_VEL] = t < 6 ? -200 : 900;
  writes.length = 0;
  cpu.yielded = false;
  cpu.run(CTRL.perTickBudget);
  const shown = writes.map((w) => `${NAME[w.a] ?? '0x' + w.a.toString(16)}=${w.v}`).join('  ');
  console.log(`tick ${String(t).padStart(2)}: ${shown}`);
  if (cpu.halted) { console.log('  (program halted)'); break; }
}
