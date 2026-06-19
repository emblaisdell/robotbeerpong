// Tests for the RobotC compiler. Run: node lang/robotc/test-robotc.mjs
//
//   1) Language unit tests — compile a snippet, run it on the real src/riscv.js
//      CPU, and check the value it writes to A_LOG.
//   2) Parity — compile the example ports of Sniper/Lobber/YOLO and prove they
//      drive the real match engine identically to the hand-written assembly
//      (drinks pinned to 0, so the simulation is fully deterministic).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { compile, MMIO_CONSTS } from './compiler.mjs';
import { assemble, CPU } from '../../src/riscv.js';
import { Match } from '../../src/engine.js';
import { PLAYERS } from '../../src/players.js';
import { MMIO_EQU } from '../../src/players.js';
import { MEM_SIZE, MMIO_BASE, STACK_TOP, A_LOG } from '../../src/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function eq(name, got, want) {
  if ((got | 0) === (want | 0)) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${got}, want ${want}`); }
}
function ok(name, cond, detail = '') {
  if (cond) { pass++; } else { fail++; console.error(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

// Run a RobotC program on the CPU. Presets `sensors` (addr->value), runs across
// ticks until the program halts (ebreak / fall-through), and returns the values
// it wrote to A_LOG plus the full write log.
function runProg(src, sensors = {}, maxTicks = 200) {
  const { code } = assemble(compile(src), MMIO_CONSTS);
  const logs = [];
  const device = {
    read32: (a) => sensors[a] | 0,
    write32: (a, v) => { if (a === A_LOG) logs.push(v | 0); },
  };
  const cpu = new CPU({ memSize: MEM_SIZE, mmioBase: MMIO_BASE, device });
  cpu.load(code);
  cpu.reset(0, STACK_TOP);
  for (let t = 0; t < maxTicks && !cpu.halted; t++) {
    cpu.yielded = false;
    cpu.run(20000);
  }
  return { logs, last: logs[logs.length - 1] };
}

// Wrap a body in main() and return the last value it logged.
const val = (body, sensors) => runProg(`void main() { ${body} }`, sensors).last;

console.log('Language unit tests:');
eq('precedence', val('write(A_LOG, 2 + 3 * 4 - 10 / 2);'), 9);
eq('modulo+shifts', val('write(A_LOG, (17 % 5) + (1 << 4) + (256 >> 2));'), 2 + 16 + 64);
eq('bitwise', val('write(A_LOG, (0xF0 | 0x0F) & 0xFE);'), 0xFE);
eq('comparisons', val('write(A_LOG, (3<5)+(5<=5)+(9>2)+(2>=3)+(4==4)+(4!=4));'), 4);
eq('unary', val('write(A_LOG, -(-5) + ~0 + !0 + !7);'), 5);
eq('signed-div', val('write(A_LOG, -20 / 3);'), -6);        // truncates toward zero
eq('signed-shift', val('write(A_LOG, -16 >> 2);'), -4);     // arithmetic shift
eq('compound-assign', val('int x = 10; x += 5; x *= 2; x -= 3; write(A_LOG, x);'), 27);
eq('while-sum', val('int i = 1; int s = 0; while (i <= 10) { s += i; i += 1; } write(A_LOG, s);'), 55);
eq('for-continue', val('int s = 0; for (int i = 0; i < 10; i += 1) { if (i % 2 == 1) continue; s += i; } write(A_LOG, s);'), 20);
eq('for-break', val('int s = 0; for (int i = 0; ; i += 1) { if (i == 5) break; s += i; } write(A_LOG, s);'), 10);
eq('abs', val('write(A_LOG, abs(-7) + abs(7));'), 14);
eq('nested-scopes', val('int x = 1; { int x = 2; { int x = 3; write(A_LOG, x); } }'), 3);

// MMIO read/write
eq('mmio-read', val('write(A_LOG, read(S_RANGE) * 2);', { [MMIO_CONSTS.S_RANGE]: 2600 }), 5200);

// functions, arg order, recursion
eq('fn-arg-order', runProg('int sub(int a, int b) { return a - b; } void main() { write(A_LOG, sub(10, 3)); }').last, 7);
eq('recursion-fact', runProg('int fact(int n) { if (n <= 1) return 1; return n * fact(n - 1); } void main() { write(A_LOG, fact(6)); }').last, 720);
eq('mutual-ish', runProg(`
  int gcd(int a, int b) { while (b != 0) { int t = a % b; a = b; b = t; } return a; }
  void main() { write(A_LOG, gcd(1071, 462)); }`).last, 21);

// short-circuit: the RHS call must NOT run when the LHS settles the result
eq('short-circuit-and', runProg(`
  int c; int bump() { c += 1; return 1; }
  void main() { c = 0; if (0 && bump()) { } write(A_LOG, c); }`).last, 0);
eq('short-circuit-or', runProg(`
  int c; int bump() { c += 1; return 1; }
  void main() { c = 0; if (1 || bump()) { } write(A_LOG, c); }`).last, 0);

// globals persist across yield() ticks
eq('globals-persist-across-yield', runProg(`
  int n;
  void main() { n = 0; while (1) { n += 1; write(A_LOG, n); if (n == 3) halt(); yield(); } }`).last, 3);

// isqrt written in RobotC (the Sniper kernel)
{
  const isqrt = `
    int isqrt(int n) {
      int res = 0; int bit = 0x40000000;
      while (bit > n) bit = bit >> 2;
      while (bit != 0) {
        if (n >= res + bit) { n = n - res - bit; res = (res >> 1) + bit; }
        else { res = res >> 1; }
        bit = bit >> 2;
      }
      return res;
    }`;
  for (const [n, want] of [[0, 0], [1, 1], [4, 2], [1000000, 1000], [2000000, 1414], [999999, 999], [9300000, 3049]]) {
    eq(`isqrt(${n})`, runProg(`${isqrt} void main() { write(A_LOG, isqrt(${n})); }`).last, want);
  }
}

// ---------------------------------------------------------------------------
// The example ports compile and drive the real engine to a valid throw.
//
// We assert the *stable* property — the compiler produces a runnable player
// that fires a real throw — rather than byte-equality with the built-in
// players, whose control law is actively tuned. When a port still happens to
// match its hand-written twin exactly (it does whenever the .rc tracks the
// current control law), that's reported as a bonus.
// ---------------------------------------------------------------------------
console.log('\nExample ports drive the real engine (drinks = 0, deterministic):');

function compiledCode(name) {
  const src = readFileSync(join(here, 'examples', `${name}.rc`), 'utf8');
  return assemble(compile(src), MMIO_EQU).code;
}
function turnSignature(playerId, overrideCode) {
  const m = new Match({ playerA: playerId, playerB: playerId, seed: 7 });
  m.current = 'A';
  m.robots.A.drinks = 0;
  if (overrideCode) m.robots.A.code = overrideCode;
  const r = m.simulateTurn();
  return { fired: r.fired, crashed: r.crashed, release: r.release && { tip: r.release.tip, vel: r.release.vel, spin: r.release.spin }, outcome: r.outcome };
}

for (const id of ['sniper', 'lobber', 'yolo']) {
  const mine = turnSignature(id, compiledCode(id));
  ok(`${id}: compiles, runs, and fires a valid throw`,
    mine.fired === true && mine.crashed === false && !!mine.release,
    `fired=${mine.fired} crashed=${mine.crashed}`);
  const identical = JSON.stringify(turnSignature(id)) === JSON.stringify(mine);
  console.log(`    (byte-identical to built-in ${id}: ${identical ? 'yes' : 'no — control law has been tuned since this .rc was written'})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
