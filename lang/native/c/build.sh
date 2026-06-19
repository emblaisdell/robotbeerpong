#!/usr/bin/env sh
# Build the C player to a flat binary for the Robot Beer Pong CPU.
#
#   cc (riscv32, rv32im) -> ELF -> objcopy -> player.bin
#
# Needs a real RISC-V C toolchain. Either works (no preference):
#   sudo apt-get install clang lld llvm
#   sudo apt-get install gcc-riscv64-unknown-elf binutils-riscv64-unknown-elf
#
# objcopy can come from llvm, binutils, OR a rustup `llvm-tools` install (it is
# target-agnostic), so this script reuses whichever is present.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LD="$DIR/../link.ld"

# --- pick a compiler ---
if command -v clang >/dev/null 2>&1; then
  CC="clang --target=riscv32-unknown-elf -fuse-ld=lld"
elif command -v riscv64-unknown-elf-gcc >/dev/null 2>&1; then
  CC="riscv64-unknown-elf-gcc"
elif command -v riscv64-linux-gnu-gcc >/dev/null 2>&1; then
  CC="riscv64-linux-gnu-gcc"
else
  echo "error: no RISC-V C compiler found." >&2
  echo "  sudo apt-get install clang lld llvm        # (clang path)" >&2
  echo "  sudo apt-get install gcc-riscv64-unknown-elf binutils-riscv64-unknown-elf" >&2
  exit 127
fi

# --- pick an objcopy (binutils, llvm, or rustup's llvm-tools) ---
if command -v riscv64-unknown-elf-objcopy >/dev/null 2>&1; then
  OBJCOPY="riscv64-unknown-elf-objcopy"
elif command -v llvm-objcopy >/dev/null 2>&1; then
  OBJCOPY="llvm-objcopy"
elif command -v rustc >/dev/null 2>&1; then
  OBJCOPY="$(rustc --print sysroot)/lib/rustlib/$(rustc -vV | sed -n 's/^host: //p')/bin/llvm-objcopy"
else
  echo "error: no objcopy found (install binutils/llvm, or rustup component add llvm-tools)" >&2
  exit 127
fi

echo "compiler: $CC"
echo "objcopy:  $OBJCOPY"

# rv32im (no compressed!), freestanding, no relaxation -> absolute addressing.
$CC -march=rv32im -mabi=ilp32 -mno-relax \
  -nostdlib -ffreestanding -fno-pic -fno-builtin -Os -Wall -Wextra \
  -Wl,-T,"$LD" -Wl,--no-relax -Wl,-e,_start \
  -o "$DIR/player.elf" "$DIR/player.c"

"$OBJCOPY" -O binary "$DIR/player.elf" "$DIR/player.bin"
echo "built $DIR/player.bin ($(wc -c < "$DIR/player.bin") bytes)"
