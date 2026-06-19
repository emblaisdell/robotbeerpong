# RobotC

A tiny C-like language that compiles to RV32IM assembly for the Robot Beer Pong
CPU. It's small enough to read in one sitting but real enough to re-express
every hand-written player — the example ports of Sniper, Lobber and YOLO compile
to assembly that drives the match engine *byte-for-byte identically* to the
hand-written versions (proven by `test-robotc.mjs`).

```c
// aim at the nearest cup, wind up, swing, release — see examples/
const int ELBOW_COCK = 1100;
int phase;

void main() {
    int yawTarget = read(S_BEARING);
    phase = 0;
    while (1) {
        write(A_TQ_YAW, ((yawTarget - read(S_YAW)) * 200 - read(S_YAW_VEL) * 40) / 1000);
        // ... shoulder phase machine ...
        yield();          // end this control tick
    }
}
```

## Usage

```bash
# compile a .rc file to assembly (prints to stdout)
node lang/robotc/cli.mjs lang/robotc/examples/sniper.rc

# assemble + run a few ticks on the real CPU with a mock arm (smoke test)
node lang/robotc/cli.mjs --run --ticks 10 lang/robotc/examples/minimal.rc

# run the test suite (language unit tests + parity vs hand-written players)
node lang/robotc/test-robotc.mjs
```

From JavaScript:

```js
import { compile, MMIO_CONSTS } from './lang/robotc/compiler.mjs';
import { assemble } from './src/riscv.js';
const asm = compile(sourceString);
const { code } = assemble(asm, MMIO_CONSTS);   // -> Uint8Array, ready for the CPU
```

To make a RobotC program selectable in the game, compile it and add the
resulting assembly as a `source` entry in `PLAYERS`
([`src/players.js`](../../src/players.js)) — the engine doesn't care whether the
assembly was typed by hand or generated.

## The language

One numeric type: **`int`** (32-bit, signed) — the machine has no FPU.

### Top level

```c
const int NAME = <constant expression>;   // compile-time constant (no storage)
int counter;                               // global, zero-initialized
int gain = 200;                            // global with a constant initializer
int add(int a, int b) { return a + b; }    // function
void main() { ... }                        // required entry point
```

Globals live in a data section after the code and **persist across `yield()`
ticks** — that's how a controller keeps a phase variable between ticks. `const
int`s fold at compile time and emit no memory. `main()` is required; when it
returns (or falls off the end) the turn stops.

### Statements

`if` / `else`, `while`, `for(init; cond; post)`, `break`, `continue`,
`return [expr]`, blocks `{ … }` with nested scopes and shadowing, local
declarations `int x = …;`, and expression statements.

### Expressions

Full C integer operator set with C precedence:

- arithmetic `+ - * / %` (division truncates toward zero, matching RV32M)
- comparison `< <= > >= == !=` (result 0/1)
- bitwise `& | ^ ~`, shifts `<< >>` (`>>` is arithmetic / sign-preserving)
- logical `&& || !` with **short-circuit** evaluation
- assignment `=` and compound `+= -= *= /= %= &= |= ^= <<= >>=`
- unary `- + ~ !`, parentheses, function calls

### Built-ins (the robot ABI)

| Call | Emits | Meaning |
|------|-------|---------|
| `read(addr)` | `lw` | load a sensor (or any word) |
| `write(addr, val)` | `sw` | drive an actuator (or any word) |
| `yield()` | `ecall` | end this tick; resume next tick with globals intact |
| `halt()` | `ebreak` | stop the turn (crash) |
| `abs(x)` | — | `|x|` |

Every MMIO register name from [`src/constants.js`](../../src/constants.js) is a
predefined constant: `S_TICK S_BEARING S_RANGE S_GRAVITY S_YAW S_YAW_VEL
S_SHOULDER S_SHOULDER_VEL S_ELBOW S_ELBOW_VEL S_DRINKS S_CUPS S_RNG S_ARMLEN
S_HELD A_TQ_YAW A_TQ_SHOULDER A_TQ_ELBOW A_RELEASE A_LOG`. So you write
`read(S_RANGE)` and `write(A_TQ_YAW, t)` directly.

## How codegen works

A deliberately simple **stack machine**, no register allocator and no optimiser,
so the output is easy to diff against hand assembly:

- every expression computes its result into `a0`;
- a binary operator evaluates the left side, spills it to the RISC-V stack,
  evaluates the right side, pops the left into `a1`, and combines;
- `s0` is the frame pointer; parameters and locals live in the call frame,
  globals in the data section reached via `la`;
- calls use a cdecl-ish convention: arguments pushed right-to-left, callee saves
  `ra`/`s0`, result returned in `a0`. Recursion works (see the `fact`/`gcd`
  tests).

The `isqrt` the Sniper needs is written *in RobotC itself*
([`examples/sniper.rc`](examples/sniper.rc)) rather than provided as a magic
intrinsic — a good demonstration that the language is expressive enough for the
real work.

## A bug we found

Generating code exercised the assembler harder than the hand-written players
ever did and surfaced a latent bug in [`src/riscv.js`](../../src/riscv.js): the
`la` pseudo-instruction (and `li` of a symbol) reserved **two** words in pass 1
but `encodeLi` emitted only **one** when the address happened to fit in 12 bits.
That left a stray `0x00000000` (an illegal instruction) in the image. The
hand-written players never tripped it because they only `li` large MMIO
constants and never use `la`; RobotC reaches globals with `la gv_name`, whose
address is small. The fix makes `la`/`li`-of-symbol always emit the two words
pass 1 reserved. (`docs/robot-isa.md` § 6 lists `la` as a supported pseudo-op,
so this is a real fix, not just a compiler workaround.)

## Limits / non-goals

No pointers, arrays, structs, or `char`/string types — it's `int`-only by
design, like the machine. No standard library beyond the built-ins. The output
is correct and readable, not fast or small; if you want tight code, hand-write
the hot loop. These are deliberate: the point is a clear, faithful path from a
familiar language down to the robot target.
