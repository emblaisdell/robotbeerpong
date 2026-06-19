# `lang/` — higher-level languages for the robot target

The robots in Robot Beer Pong are driven by **RV32IM machine code**. Until now
the only way to write a player was to hand-write assembly and feed it to the
in-browser assembler ([`src/riscv.js`](../src/riscv.js)). This directory adds
*compilers* — front ends in friendlier languages that emit that same assembly
text, so anything here is a drop-in player.

The contract every language targets is the robot ABI documented in
[`docs/robot-isa.md`](../docs/robot-isa.md): a program is a per-tick control
loop that reads sensor MMIO registers, writes actuator torques, and calls
`ecall` (here spelled `yield()`) to end each tick. A "compiler" is just a
function `source -> assembly string`; the existing
`assemble(source, MMIO_EQU)` turns it into a runnable image.

## Languages

| Dir | Approach | Toolchain | Status |
|-----|----------|-----------|--------|
| [`robotc/`](robotc/) | **RobotC** — a small C-like language; a from-scratch compiler that emits the assembler's text dialect | none (pure JS, in-browser) | ✅ Sniper/Lobber/YOLO ports + full test suite |
| [`native/`](native/) | **Real C and Rust** — `clang`/`gcc` and `rustc` → ELF → `objcopy` → flat binary loaded straight onto the CPU | real RISC-V toolchain (`rustc` userland; `clang`/`gcc` via apt) | ✅ Rust verified end-to-end; C ready (one apt install) |

Two genuinely different points on the spectrum:

- **`robotc/`** owns the whole pipeline in a few hundred lines of dependency-free
  JS that runs in the browser with no build step — at the cost of being a
  *toy* language (`int`-only, no real C/Rust semantics).
- **`native/`** uses real, production compilers and the actual `riscv32im`
  backend — at the cost of a native toolchain and a build step that emits flat
  binaries (so it bypasses the in-repo assembler entirely).

New front ends (a Forth, a Lisp, a BASIC, …) can be added as sibling
directories following the same shape.

## Why a new directory instead of touching `src/`

`src/` is the game. The compilers are tooling *around* the target, so they live
apart and depend on `src/` (the assembler, the CPU, the constants) rather than
the other way around. The one change made to `src/` was a genuine assembler bug
fix that generated code exposed — see `robotc/README.md` § "A bug we found".
