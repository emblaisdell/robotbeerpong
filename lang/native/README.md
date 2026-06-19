# Native players — real C and Rust toolchains

Unlike [`lang/robotc/`](../robotc/) (a toy compiler that emits the assembler's
text dialect), this directory uses **real, off-the-shelf compilers** end to end:

```
   player.c  --clang/gcc (riscv32, rv32im)-->  ELF  --llvm-objcopy-->  player.bin
   player.rs --rustc     (riscv32im-none) -->  ELF  --llvm-objcopy-->  player.bin
                                                                          |
                                          run-image.mjs loads the flat   v
                                          bytes straight onto the CPU at addr 0
```

No project assembler is involved — the bytes `objcopy` produces *are* the
program image the simulated CPU runs.

## Why this works against a "toy" CPU

The CPU (`src/riscv.js`) is a bare RV32IM core: it zeroes RAM, loads a flat
image at address 0, sets `pc = 0` and `sp = 0x0F000`, and runs. So the native
build is constrained to match:

- **`-march=rv32im` (no `c`!).** The simulator decodes only 32-bit instructions,
  so the compressed extension must be off — hence the Rust target
  `riscv32im-unknown-none-elf`, not `imc`/`imac`.
- **Freestanding, no libc, no startup.** `-nostdlib -ffreestanding`; we provide
  `_start` ourselves.
- **`_start` must be at offset 0.** The CPU ignores the ELF entry point and just
  runs from address 0, so the [linker script](link.ld) keeps `_start` (in its
  own `.text.start` section) first.
- **No 64-bit math.** That would call `libgcc`/`compiler-builtins` helpers that
  don't exist here. Stick to `int`/`i32`.
- **`ecall` = yield.** Not a syscall — it pauses until the next 240 Hz tick with
  registers intact, so an ordinary infinite loop *is* the control loop.

Globals work normally: initialized data rides in the flat image, `.bss` is
already zero because the CPU clears RAM before loading.

## Build & run

### Rust (installs entirely in userland, no sudo)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
rustup target add riscv32im-unknown-none-elf
rustup component add llvm-tools

sh lang/native/rust/build.sh                       # -> rust/player.bin
node lang/native/run-image.mjs --match lang/native/rust/player.bin
```

### C (needs a RISC-V C toolchain — one apt command)

Either toolchain works; pick one:

```bash
sudo apt-get install clang lld llvm                                   # clang path
# or:
sudo apt-get install gcc-riscv64-unknown-elf binutils-riscv64-unknown-elf

sh lang/native/c/build.sh                          # -> c/player.bin
node lang/native/run-image.mjs --match lang/native/c/player.bin
```

`build.sh` autodetects the compiler and reuses any available `objcopy`
(binutils, llvm, **or** the one rustup's `llvm-tools` installs — it's
target-agnostic), so if you already set up Rust you only need `clang`/`gcc`.

### Test

```bash
node lang/native/test-native.mjs   # builds what's installed; asserts it fires a real throw
```

## Running a quick smoke test (no engine)

```bash
node lang/native/run-image.mjs --ticks 10 lang/native/rust/player.bin
```

drives a mock arm and prints the actuator writes per tick — handy for seeing the
windback → swing → `RELEASE` sequence without the full physics.

## A note on the example players

`player.c` / `player.rs` implement the **Lobber** control law (linear tip-speed
model + PD swing with an elbow whip). They're standalone example players, not
golden copies: the built-in control law is actively tuned in
[`src/players.js`](../../src/players.js), so a port matches it byte-for-byte only
until the next tweak. `test-native.mjs` therefore asserts the durable property —
*it builds with real tools, loads on the real CPU, and fires a real throw* — and
reports exact parity only as a bonus.

## Wiring a native player into the game

The browser game assembles assembly *strings* from `PLAYERS`. A native player is
prebuilt bytes instead, so it needs a small loader hook: have the engine accept a
`Uint8Array` image (as `run-image.mjs` does via `robot.code`) alongside the
existing `source` path. Left out of `src/` on purpose — it's a one-liner you can
add when you want native players selectable in the UI.
