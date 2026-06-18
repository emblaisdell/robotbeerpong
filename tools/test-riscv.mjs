// Sanity tests for the RV32I core + assembler. Run: node tools/test-riscv.mjs
import { assemble, CPU } from '../src/riscv.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if ((got | 0) === (want | 0)) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${got}, want ${want}`); }
}

// Simple device: a few MMIO words.
function makeCpu(src, equ) {
  const { code, symbols } = assemble(src, equ);
  const store = new Map();
  const device = {
    read32: (a) => store.get(a) | 0,
    write32: (a, v) => store.set(a, v | 0),
  };
  const cpu = new CPU({ memSize: 0x20000, mmioBase: 0x10000, device });
  cpu.load(code);
  cpu.reset(0, 0x0f000);
  return { cpu, store, symbols };
}

// 1) arithmetic + li of large constants
{
  const { cpu } = makeCpu(`
    li a0, 123456
    li a1, -1000
    add a2, a0, a1
    li a3, 7
    li a4, 3
    sub a5, a3, a4   # 4
    mv a6, a2
    ecall
  `);
  cpu.run(1000);
  eq('add large', cpu.x[12], 122456);
  eq('sub', cpu.x[15], 4);
}

// 2) branches + loop: sum 1..10 = 55
{
  const { cpu } = makeCpu(`
    li t0, 0       # sum
    li t1, 1       # i
    li t2, 11      # limit
  loop:
    bge t1, t2, done
    add t0, t0, t1
    addi t1, t1, 1
    j loop
  done:
    mv a0, t0
    ecall
  `);
  cpu.run(10000);
  eq('loop sum', cpu.x[10], 55);
}

// 3) memory load/store
{
  const { cpu } = makeCpu(`
    li t0, 0x800
    li t1, 0xdead
    sw t1, 0(t0)
    lw t2, 0(t0)
    mv a0, t2
    ecall
  `);
  cpu.run(1000);
  eq('mem roundtrip', cpu.x[7], 0xdead);
}

// 4) MMIO read/compute/write
{
  const { cpu, store } = makeCpu(`
    .equ IN,  0x10000
    .equ OUT, 0x10004
    li t0, IN
    lw a0, 0(t0)
    slli a0, a0, 1     # double it
    li t1, OUT
    sw a0, 0(t1)
    ecall
  `);
  store.set(0x10000, 21);
  cpu.run(1000);
  eq('mmio double', store.get(0x10004), 42);
}

// 5) integer sqrt (binary digit-by-digit) — used by the "sniper" strategy.
{
  const src = `
    .equ N,   0x10000
    .equ OUT, 0x10004
    li s0, N
    lw a0, 0(s0)       # n
    li a1, 0           # result
    li a2, 0x40000000  # bit
  align:
    bgtu a2, a0, nextbit   # while bit > n: bit >>= 2  (pseudo bgtu -> bltu swap)
    j body
  nextbit:
    srli a2, a2, 2
    bnez a2, align
  body:
    beqz a2, fin
    add a3, a1, a2     # res + bit
    bgtu a3, a0, else  # if n >= res+bit
    sub a0, a0, a3     # n -= res+bit
    srli a1, a1, 1
    add a1, a1, a2     # res = (res>>1)+bit
    j cont
  else:
    srli a1, a1, 1     # res >>= 1
  cont:
    srli a2, a2, 2     # bit >>= 2
    j body
  fin:
    li t0, OUT
    sw a1, 0(t0)
    mv a0, a1
    ecall
  `;
  for (const [n, want] of [[0, 0], [1, 1], [4, 2], [1000000, 1000], [2000000, 1414], [999999, 999]]) {
    const { code } = assemble(src);
    const store = new Map();
    const device = { read32: (a) => store.get(a) | 0, write32: (a, v) => store.set(a, v | 0) };
    const cpu = new CPU({ memSize: 0x20000, mmioBase: 0x10000, device });
    cpu.load(code); cpu.reset(0, 0x0f000);
    store.set(0x10000, n);
    cpu.run(100000);
    eq(`isqrt(${n})`, store.get(0x10004), want);
  }
}

// 6) RV32M: mul / div / rem
{
  const { cpu } = makeCpu(`
    li a0, 12345
    li a1, 1000
    mul a2, a0, a1     # 12345000
    div a3, a0, a1     # 12
    rem a4, a0, a1     # 345
    li a5, -20
    li a6, 3
    div a7, a5, a6     # -6 (trunc toward zero)
    ecall
  `);
  cpu.run(1000);
  eq('mul', cpu.x[12], 12345000);
  eq('div', cpu.x[13], 12);
  eq('rem', cpu.x[14], 345);
  eq('div neg', cpu.x[17], -6);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
