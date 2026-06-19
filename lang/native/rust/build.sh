#!/usr/bin/env sh
# Build the Rust player to a flat binary for the Robot Beer Pong CPU.
#
#   rustc (riscv32im-unknown-none-elf) -> ELF -> llvm-objcopy -> player.bin
#
# Requires: rustup with the target + llvm-tools (userland, no sudo):
#   rustup target add riscv32im-unknown-none-elf
#   rustup component add llvm-tools
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$HOME/.cargo/env" 2>/dev/null || true

HOST="$(rustc -vV | sed -n 's/^host: //p')"
SYSROOT="$(rustc --print sysroot)"
OBJCOPY="$SYSROOT/lib/rustlib/$HOST/bin/llvm-objcopy"

# Target rv32im (NOT imc/imac): the simulator decodes only 32-bit instructions,
# so the compressed extension must stay off. relocation-model=static + leaving
# __global_pointer$ undefined keeps all data access absolute (no gp setup).
rustc --edition 2021 --target riscv32im-unknown-none-elf \
  -C opt-level=s -C overflow-checks=off -C panic=abort \
  -C relocation-model=static \
  -C link-arg=-T"$DIR/../link.ld" \
  -C link-arg=--entry=_start \
  -o "$DIR/player.elf" "$DIR/player.rs"

"$OBJCOPY" -O binary "$DIR/player.elf" "$DIR/player.bin"
echo "built $DIR/player.bin ($(wc -c < "$DIR/player.bin") bytes)"
