// A small, faithful RV32I core + assembler — the in-browser stand-in for a
// bare-metal robot CPU. No QEMU, no FPU: integer-only machine code, executed
// instruction by instruction, talking to the robot through memory-mapped IO.
//
// Exports:
//   assemble(src, equ)  -> { code: Uint8Array, symbols, entry }
//   class CPU           -> loads code into flat memory, steps instructions,
//                          routes loads/stores in the MMIO window to a device.

// ---------------------------------------------------------------------------
// Register names (ABI + xN)
// ---------------------------------------------------------------------------
const ABI = {
  zero: 0, ra: 1, sp: 2, gp: 3, tp: 4,
  t0: 5, t1: 6, t2: 7,
  s0: 8, fp: 8, s1: 9,
  a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a6: 16, a7: 17,
  s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23, s8: 24, s9: 25, s10: 26, s11: 27,
  t3: 28, t4: 29, t5: 30, t6: 31,
};
function regNum(tok) {
  tok = tok.trim();
  if (tok in ABI) return ABI[tok];
  const m = /^x(\d+)$/.exec(tok);
  if (m) {
    const n = +m[1];
    if (n >= 0 && n < 32) return n;
  }
  throw new Error(`bad register: '${tok}'`);
}

// ---------------------------------------------------------------------------
// Encoders for each instruction format
// ---------------------------------------------------------------------------
const u32 = (x) => x >>> 0;
function encR(funct7, rs2, rs1, funct3, rd, opcode) {
  return u32((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
}
function encI(imm, rs1, funct3, rd, opcode) {
  return u32(((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);
}
function encS(imm, rs2, rs1, funct3, opcode) {
  const hi = (imm >> 5) & 0x7f, lo = imm & 0x1f;
  return u32((hi << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (lo << 7) | opcode);
}
function encB(imm, rs2, rs1, funct3, opcode) {
  const b12 = (imm >> 12) & 1, b11 = (imm >> 11) & 1;
  const b10_5 = (imm >> 5) & 0x3f, b4_1 = (imm >> 1) & 0xf;
  return u32((b12 << 31) | (b10_5 << 25) | (rs2 << 20) | (rs1 << 15) |
    (funct3 << 12) | (b4_1 << 8) | (b11 << 7) | opcode);
}
function encU(imm, rd, opcode) {
  return u32((imm & 0xfffff000) | (rd << 7) | opcode);
}
function encJ(imm, rd, opcode) {
  const b20 = (imm >> 20) & 1, b10_1 = (imm >> 1) & 0x3ff;
  const b11 = (imm >> 11) & 1, b19_12 = (imm >> 12) & 0xff;
  return u32((b20 << 31) | (b10_1 << 21) | (b11 << 20) | (b19_12 << 12) | (rd << 7) | opcode);
}

// Static encodings for the R/I-type ALU + system ops, keyed by mnemonic.
const R_OPS = {
  add: [0x00, 0x0], sub: [0x20, 0x0], sll: [0x00, 0x1], slt: [0x00, 0x2],
  sltu: [0x00, 0x3], xor: [0x00, 0x4], srl: [0x00, 0x5], sra: [0x20, 0x5],
  or: [0x00, 0x6], and: [0x00, 0x7],
};
// RV32M (multiply / divide). funct7 is always 0x01.
const M_OPS = {
  mul: 0x0, mulh: 0x1, mulhsu: 0x2, mulhu: 0x3,
  div: 0x4, divu: 0x5, rem: 0x6, remu: 0x7,
};
const I_ALU = { addi: 0x0, slti: 0x2, sltiu: 0x3, xori: 0x4, ori: 0x6, andi: 0x7 };
const I_SHIFT = { slli: [0x00, 0x1], srli: [0x00, 0x5], srai: [0x20, 0x5] };
const LOADS = { lb: 0x0, lh: 0x1, lw: 0x2, lbu: 0x4, lhu: 0x5 };
const STORES = { sb: 0x0, sh: 0x1, sw: 0x2 };
const BRANCHES = { beq: 0x0, bne: 0x1, blt: 0x4, bge: 0x5, bltu: 0x6, bgeu: 0x7 };

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------
// Two passes: pass 1 lays out addresses and collects labels; pass 2 encodes.
// Supports the RV32I instruction set plus common pseudo-instructions and the
// .word / .equ / .align / .text / .data directives. `equ` is an object of
// extra named constants injected by the caller (we use it for MMIO addresses).
export function assemble(src, equ = {}) {
  const symbols = Object.assign(Object.create(null), equ);
  // ---- tokenize into a list of {label?, op?, args[]} with addresses ----
  const lines = src.split('\n');
  const items = []; // {addr, op, args, line}
  let addr = 0;

  // immediate / symbol resolver (pass 2)
  function val(tok) {
    tok = tok.trim();
    if (tok === '') throw new Error('empty operand');
    // arithmetic: NAME+const / NAME-const, and bare numbers/symbols
    const m = /^([A-Za-z_.$][\w.$]*)\s*([+-])\s*(.+)$/.exec(tok);
    if (m && (m[1] in symbols)) {
      const base = symbols[m[1]];
      const off = val(m[3]);
      return m[2] === '+' ? base + off : base - off;
    }
    if (tok in symbols) return symbols[tok];
    if (/^-?0x[0-9a-fA-F]+$/.test(tok)) return parseInt(tok, 16) | 0;
    if (/^-?\d+$/.test(tok)) return parseInt(tok, 10) | 0;
    throw new Error(`undefined symbol or bad number: '${tok}'`);
  }

  // ---- pass 1: addresses + labels ----
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    // strip comments (# or ;) but not inside the line's only string-less context
    line = line.replace(/[#;].*$/, '').trim();
    if (!line) continue;

    // leading labels (possibly multiple, and possibly followed by an instr)
    let mLabel;
    while ((mLabel = /^([A-Za-z_.$][\w.$]*)\s*:\s*(.*)$/.exec(line))) {
      symbols[mLabel[1]] = addr;
      line = mLabel[2].trim();
      if (!line) break;
    }
    if (!line) continue;

    const sp = line.indexOf(' ');
    const op = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    const args = rest === '' ? [] : splitArgs(rest);

    if (op === '.equ' || op === '.set') {
      symbols[args[0]] = val(args[1]);
      continue;
    }
    if (op === '.align') {
      const a = 1 << val(args[0]);
      while (addr % a) addr++;
      continue;
    }
    if (op === '.text' || op === '.data' || op === '.globl' || op === '.global') {
      continue; // single flat segment; these are accepted and ignored
    }
    if (op === '.word') {
      items.push({ addr, op, args, li });
      addr += 4 * args.length;
      continue;
    }
    if (op === '.byte') {
      items.push({ addr, op, args, li });
      addr += args.length;
      continue;
    }
    // ordinary / pseudo instruction: expand to a count now so addresses are right
    const n = pseudoWords(op, args);
    items.push({ addr, op, args, li });
    addr += 4 * n;
  }

  // ---- pass 2: encode ----
  const words = new Map(); // addr -> u32  (for .text); .byte handled separately
  const bytes = new Map(); // addr -> u8
  let end = 0;

  for (const it of items) {
    const at = it.addr;
    try {
      if (it.op === '.word') {
        it.args.forEach((a, i) => { words.set(at + 4 * i, u32(val(a))); });
        end = Math.max(end, at + 4 * it.args.length);
        continue;
      }
      if (it.op === '.byte') {
        it.args.forEach((a, i) => { bytes.set(at + i, val(a) & 0xff); });
        end = Math.max(end, at + it.args.length);
        continue;
      }
      const encoded = encodeInstr(it.op, it.args, at, val);
      encoded.forEach((w, i) => words.set(at + 4 * i, u32(w)));
      end = Math.max(end, at + 4 * encoded.length);
    } catch (e) {
      throw new Error(`asm error (line ${it.li + 1}): ${e.message}`);
    }
  }

  // flatten to a byte image
  const code = new Uint8Array(end);
  for (const [a, w] of words) {
    code[a] = w & 0xff; code[a + 1] = (w >>> 8) & 0xff;
    code[a + 2] = (w >>> 16) & 0xff; code[a + 3] = (w >>> 24) & 0xff;
  }
  for (const [a, b] of bytes) code[a] = b;

  return { code, symbols, entry: symbols.start ?? symbols._start ?? 0 };
}

// split "a, b, c" honoring the offset(reg) syntax (no commas inside parens here)
function splitArgs(s) {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length);
}

// how many 4-byte words a (possibly pseudo) instruction expands to
function pseudoWords(op, args) {
  switch (op) {
    case 'li': {
      // 1 word if it fits in 12 bits, else 2 (lui+addi)
      const v = parseMaybe(args[1]);
      if (v !== null && v >= -2048 && v <= 2047) return 1;
      return 2;
    }
    case 'la': return 2;  // auipc + addi (here: lui+addi since flat & small)
    case 'call': return 2;
    case 'nop': case 'mv': case 'not': case 'neg': case 'seqz': case 'snez':
    case 'j': case 'jr': case 'ret': case 'beqz': case 'bnez': case 'blez':
    case 'bgez': case 'bltz': case 'bgtz':
      return 1;
    default:
      return 1;
  }
}
function parseMaybe(tok) {
  tok = (tok || '').trim();
  if (/^-?0x[0-9a-fA-F]+$/.test(tok)) return parseInt(tok, 16) | 0;
  if (/^-?\d+$/.test(tok)) return parseInt(tok, 10) | 0;
  return null;
}

// Encode one (pseudo)instruction at address `at`. Returns an array of words.
function encodeInstr(op, args, at, val) {
  const R = (i) => regNum(args[i]);
  const need = (n) => { if (args.length !== n) throw new Error(`${op} expects ${n} operands, got ${args.length}`); };

  // ----- pseudo-instructions -----
  switch (op) {
    case 'nop': return [encI(0, 0, 0, 0, 0x13)]; // addi x0,x0,0
    case 'mv': need(2); return [encI(0, R(1), 0x0, R(0), 0x13)]; // addi rd,rs,0
    case 'not': need(2); return [encI(-1, R(1), 0x4, R(0), 0x13)]; // xori rd,rs,-1
    case 'neg': need(2); return [encR(0x20, R(1), 0, 0x0, R(0), 0x33)]; // sub rd,x0,rs
    case 'seqz': need(2); return [encI(1, R(1), 0x3, R(0), 0x13)]; // sltiu rd,rs,1
    case 'snez': need(2); return [encR(0x00, R(1), 0, 0x3, R(0), 0x33)]; // sltu rd,x0,rs
    case 'li': {
      need(2);
      const v = val(args[1]) | 0;
      return encodeLi(R(0), v);
    }
    case 'la': {
      need(2);
      // flat address space and small images: just materialize the constant.
      return encodeLi(R(0), val(args[1]) | 0);
    }
    case 'j': { need(1); const off = val(args[0]) - at; return [encJ(off, 0, 0x6f)]; }
    case 'jr': { need(1); return [encI(0, R(0), 0x0, 0, 0x67)]; }
    case 'ret': { need(0); return [encI(0, 1, 0x0, 0, 0x67)]; } // jalr x0,0(ra)
    case 'call': {
      need(1);
      const off = val(args[0]) - at;
      // auipc ra, hi ; jalr ra, lo(ra)  -- but flat/small: use jal if in range
      return [encJ(off, 1, 0x6f), encI(0, 0, 0x0, 0, 0x13)]; // jal ra,target ; nop pad
    }
    case 'beqz': { need(2); const off = val(args[1]) - at; return [encB(off, 0, R(0), 0x0, 0x63)]; }
    case 'bnez': { need(2); const off = val(args[1]) - at; return [encB(off, 0, R(0), 0x1, 0x63)]; }
    case 'bltz': { need(2); const off = val(args[1]) - at; return [encB(off, 0, R(0), 0x4, 0x63)]; }
    case 'bgez': { need(2); const off = val(args[1]) - at; return [encB(off, 0, R(0), 0x5, 0x63)]; }
    case 'bgtz': { need(2); const off = val(args[1]) - at; return [encB(off, R(0), 0, 0x4, 0x63)]; } // blt x0,rs
    case 'blez': { need(2); const off = val(args[1]) - at; return [encB(off, R(0), 0, 0x5, 0x63)]; } // bge x0,rs
    case 'bgt': { need(3); const off = val(args[2]) - at; return [encB(off, R(0), R(1), 0x4, 0x63)]; } // blt rt,rs
    case 'ble': { need(3); const off = val(args[2]) - at; return [encB(off, R(0), R(1), 0x5, 0x63)]; } // bge rt,rs
    case 'bgtu': { need(3); const off = val(args[2]) - at; return [encB(off, R(0), R(1), 0x6, 0x63)]; } // bltu rt,rs
    case 'bleu': { need(3); const off = val(args[2]) - at; return [encB(off, R(0), R(1), 0x7, 0x63)]; } // bgeu rt,rs
  }

  // ----- real instructions -----
  if (op in R_OPS) { need(3); const [f7, f3] = R_OPS[op]; return [encR(f7, R(2), R(1), f3, R(0), 0x33)]; }
  if (op in M_OPS) { need(3); return [encR(0x01, R(2), R(1), M_OPS[op], R(0), 0x33)]; }
  if (op in I_ALU) { need(3); return [encI(val(args[2]), R(1), I_ALU[op], R(0), 0x13)]; }
  if (op in I_SHIFT) { need(3); const [f7, f3] = I_SHIFT[op]; const sh = val(args[2]) & 0x1f; return [encI((f7 << 5) | sh, R(1), f3, R(0), 0x13)]; }

  if (op === 'lui') { need(2); return [encU(val(args[1]) << 12, R(0), 0x37)]; }
  if (op === 'auipc') { need(2); return [encU(val(args[1]) << 12, R(0), 0x17)]; }

  if (op === 'jal') {
    if (args.length === 1) { const off = val(args[0]) - at; return [encJ(off, 1, 0x6f)]; }
    need(2); const off = val(args[1]) - at; return [encJ(off, R(0), 0x6f)];
  }
  if (op === 'jalr') {
    // jalr rd, rs1, imm  OR  jalr rd, imm(rs1)
    if (args.length === 2) {
      const m = /^(-?\w+)\((\w+)\)$/.exec(args[1]);
      if (m) return [encI(val(m[1]), regNum(m[2]), 0x0, R(0), 0x67)];
    }
    need(3); return [encI(val(args[2]), R(1), 0x0, R(0), 0x67)];
  }

  if (op in LOADS) { need(2); const [imm, rs1] = memOperand(args[1], val); return [encI(imm, rs1, LOADS[op], R(0), 0x03)]; }
  if (op in STORES) { need(2); const [imm, rs1] = memOperand(args[1], val); return [encS(imm, R(0), rs1, STORES[op], 0x23)]; }
  if (op in BRANCHES) { need(3); const off = val(args[2]) - at; return [encB(off, R(1), R(0), BRANCHES[op], 0x63)]; }

  if (op === 'ecall') return [encI(0, 0, 0x0, 0, 0x73)];
  if (op === 'ebreak') return [encI(1, 0, 0x0, 0, 0x73)];

  throw new Error(`unknown instruction: '${op}'`);
}

function encodeLi(rd, v) {
  if (v >= -2048 && v <= 2047) return [encI(v, 0, 0x0, rd, 0x13)]; // addi rd,x0,v
  // lui takes bits 31:12; addi adds the sign-extended low 12. Adjust hi for borrow.
  let hi = (v + 0x800) >>> 12;
  const lo = v - (hi << 12);
  return [encU(hi << 12, rd, 0x37), encI(lo, rd, 0x0, rd, 0x13)];
}

// parse "imm(reg)" or "(reg)" or "symbol" (-> imm=symbol, reg=x0)
function memOperand(tok, val) {
  const m = /^(.*?)\((\w+)\)$/.exec(tok.trim());
  if (m) {
    const imm = m[1].trim() === '' ? 0 : val(m[1]);
    return [imm, regNum(m[2])];
  }
  return [val(tok), 0]; // absolute address via x0
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------
export class CPU {
  constructor({ memSize, mmioBase, mmioSize = 0x1000, device }) {
    this.mem = new Uint8Array(memSize);
    this.x = new Int32Array(32);
    this.pc = 0;
    this.mmioBase = mmioBase >>> 0;
    this.mmioEnd = (mmioBase + mmioSize) >>> 0;
    this.device = device;       // { read32(addr), write32(addr, value) }
    this.halted = false;
    this.haltCode = 0;          // a0 at ecall
    this.instret = 0;
  }

  load(code, base = 0) {
    this.mem.fill(0);
    this.mem.set(code, base);
  }
  reset(pc = 0, sp = 0) {
    this.x.fill(0);
    this.x[2] = sp | 0; // sp
    this.pc = pc >>> 0;
    this.halted = false;
    this.haltCode = 0;
    this.instret = 0;
  }

  // ---- memory access with MMIO routing (little-endian) ----
  isMmio(a) { return a >= this.mmioBase && a < this.mmioEnd; }
  load32(a) {
    a >>>= 0;
    if (this.isMmio(a)) return this.device.read32(a) | 0;
    return (this.mem[a] | (this.mem[a + 1] << 8) | (this.mem[a + 2] << 16) | (this.mem[a + 3] << 24)) | 0;
  }
  store32(a, v) {
    a >>>= 0;
    if (this.isMmio(a)) { this.device.write32(a, v | 0); return; }
    this.mem[a] = v; this.mem[a + 1] = v >>> 8; this.mem[a + 2] = v >>> 16; this.mem[a + 3] = v >>> 24;
  }
  load16(a) { a >>>= 0; return (this.mem[a] | (this.mem[a + 1] << 8)); }
  load8(a) { a >>>= 0; return this.mem[a]; }
  store16(a, v) { a >>>= 0; this.mem[a] = v; this.mem[a + 1] = v >>> 8; }
  store8(a, v) { a >>>= 0; this.mem[a] = v; }

  // Run up to `budget` instructions or until halted. Returns instructions run.
  run(budget) {
    let n = 0;
    while (n < budget && !this.halted) { this.step(); n++; }
    return n;
  }

  step() {
    const x = this.x;
    const inst = this.load32(this.pc) >>> 0;
    let next = (this.pc + 4) >>> 0;
    const opcode = inst & 0x7f;
    const rd = (inst >>> 7) & 0x1f;
    const funct3 = (inst >>> 12) & 0x7;
    const rs1 = (inst >>> 15) & 0x1f;
    const rs2 = (inst >>> 20) & 0x1f;
    const funct7 = (inst >>> 25) & 0x7f;

    switch (opcode) {
      case 0x37: x[rd] = inst & 0xfffff000; break;           // LUI
      case 0x17: x[rd] = (this.pc + (inst & 0xfffff000)) | 0; break; // AUIPC
      case 0x6f: {                                           // JAL
        const imm = immJ(inst);
        x[rd] = next | 0;
        next = (this.pc + imm) >>> 0;
        break;
      }
      case 0x67: {                                           // JALR
        const imm = immI(inst);
        const t = next | 0;
        next = ((x[rs1] + imm) & ~1) >>> 0;
        x[rd] = t;
        break;
      }
      case 0x63: {                                           // BRANCH
        const imm = immB(inst);
        const a = x[rs1], b = x[rs2];
        let take = false;
        switch (funct3) {
          case 0x0: take = a === b; break;
          case 0x1: take = a !== b; break;
          case 0x4: take = a < b; break;
          case 0x5: take = a >= b; break;
          case 0x6: take = (a >>> 0) < (b >>> 0); break;
          case 0x7: take = (a >>> 0) >= (b >>> 0); break;
        }
        if (take) next = (this.pc + imm) >>> 0;
        break;
      }
      case 0x03: {                                           // LOAD
        const addr = (x[rs1] + immI(inst)) >>> 0;
        switch (funct3) {
          case 0x0: x[rd] = (this.load8(addr) << 24) >> 24; break;  // LB
          case 0x1: x[rd] = (this.load16(addr) << 16) >> 16; break; // LH
          case 0x2: x[rd] = this.load32(addr); break;               // LW
          case 0x4: x[rd] = this.load8(addr); break;                // LBU
          case 0x5: x[rd] = this.load16(addr); break;               // LHU
        }
        break;
      }
      case 0x23: {                                           // STORE
        const addr = (x[rs1] + immS(inst)) >>> 0;
        switch (funct3) {
          case 0x0: this.store8(addr, x[rs2]); break;  // SB
          case 0x1: this.store16(addr, x[rs2]); break; // SH
          case 0x2: this.store32(addr, x[rs2]); break; // SW
        }
        break;
      }
      case 0x13: {                                           // OP-IMM
        const imm = immI(inst);
        const a = x[rs1];
        switch (funct3) {
          case 0x0: x[rd] = (a + imm) | 0; break;                 // ADDI
          case 0x2: x[rd] = a < imm ? 1 : 0; break;               // SLTI
          case 0x3: x[rd] = (a >>> 0) < (imm >>> 0) ? 1 : 0; break; // SLTIU
          case 0x4: x[rd] = a ^ imm; break;                       // XORI
          case 0x6: x[rd] = a | imm; break;                       // ORI
          case 0x7: x[rd] = a & imm; break;                       // ANDI
          case 0x1: x[rd] = a << (imm & 0x1f); break;             // SLLI
          case 0x5: x[rd] = (funct7 & 0x20) ? (a >> (imm & 0x1f)) : (a >>> (imm & 0x1f)); break; // SRAI/SRLI
        }
        break;
      }
      case 0x33: {                                           // OP
        const a = x[rs1], b = x[rs2];
        if (funct7 === 0x01) { // RV32M
          switch (funct3) {
            case 0x0: x[rd] = Math.imul(a, b); break;                       // MUL
            case 0x1: x[rd] = Number((BigInt(a) * BigInt(b)) >> 32n) | 0; break; // MULH
            case 0x2: x[rd] = Number((BigInt(a) * BigInt(b >>> 0)) >> 32n) | 0; break; // MULHSU
            case 0x3: x[rd] = Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) | 0; break; // MULHU
            case 0x4: x[rd] = b === 0 ? -1 : (a === -2147483648 && b === -1 ? -2147483648 : (a / b) | 0); break; // DIV
            case 0x5: x[rd] = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0; break; // DIVU
            case 0x6: x[rd] = b === 0 ? a : (a === -2147483648 && b === -1 ? 0 : (a % b) | 0); break; // REM
            case 0x7: x[rd] = b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0; break; // REMU
          }
          break;
        }
        switch ((funct7 << 3) | funct3) {
          case (0x00 << 3) | 0x0: x[rd] = (a + b) | 0; break;   // ADD
          case (0x20 << 3) | 0x0: x[rd] = (a - b) | 0; break;   // SUB
          case (0x00 << 3) | 0x1: x[rd] = a << (b & 0x1f); break; // SLL
          case (0x00 << 3) | 0x2: x[rd] = a < b ? 1 : 0; break; // SLT
          case (0x00 << 3) | 0x3: x[rd] = (a >>> 0) < (b >>> 0) ? 1 : 0; break; // SLTU
          case (0x00 << 3) | 0x4: x[rd] = a ^ b; break;         // XOR
          case (0x00 << 3) | 0x5: x[rd] = a >>> (b & 0x1f); break; // SRL
          case (0x20 << 3) | 0x5: x[rd] = a >> (b & 0x1f); break;  // SRA
          case (0x00 << 3) | 0x6: x[rd] = a | b; break;         // OR
          case (0x00 << 3) | 0x7: x[rd] = a & b; break;         // AND
          default: break;
        }
        break;
      }
      case 0x73: {                                           // SYSTEM (ecall/ebreak)
        this.halted = true;
        this.haltCode = x[10]; // a0
        break;
      }
      default:
        // Illegal instruction: halt rather than run wild (drunk memory may corrupt code).
        this.halted = true;
        this.haltCode = -1;
        break;
    }

    x[0] = 0; // x0 hardwired to zero
    this.pc = next;
    this.instret++;
  }
}

// immediate decoders
function immI(i) { return i >> 20; }
function immS(i) { return ((i >> 25) << 5) | ((i >> 7) & 0x1f); }
function immB(i) {
  return ((i >> 31) << 12) | (((i >> 7) & 1) << 11) | (((i >> 25) & 0x3f) << 5) | (((i >> 8) & 0xf) << 1);
}
function immJ(i) {
  return ((i >> 31) << 20) | (((i >> 12) & 0xff) << 12) | (((i >> 20) & 1) << 11) | (((i >> 21) & 0x3ff) << 1);
}
