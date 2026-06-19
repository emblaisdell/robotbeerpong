// RobotC — a tiny C-like language that compiles to RV32IM assembly for the
// Robot Beer Pong CPU (src/riscv.js). The emitted text uses only the mnemonics,
// pseudo-instructions and MMIO constant names the in-browser assembler accepts,
// so `assemble(compile(src), MMIO_EQU)` produces a runnable player image.
//
//   compile(source, opts?) -> assembly text (string)
//
// The language is deliberracetely small but real:
//   * one numeric type: `int` (32-bit, signed) — the machine is integer-only.
//   * globals (persist across `yield()` ticks), compile-time `const int`s,
//     and functions with parameters, locals and recursion.
//   * if/else, while, for, break/continue, return.
//   * full C integer operator set with C precedence, including short-circuit
//     && / ||, the bitwise/shift ops, and compound assignment (+= … >>=).
//   * built-ins wired to the robot ABI:
//       read(addr)        -> lw   (load a sensor / any word)
//       write(addr, val)  -> sw   (drive an actuator / any word)
//       yield()           -> ecall (end this control tick, resume next tick)
//       halt()            -> ebreak (crash/stop the turn)
//       abs(x)            -> branchless-ish |x|
//   * every MMIO register name from src/constants.js (S_YAW, A_TQ_YAW, …) is a
//     predefined constant, so you write `read(S_RANGE)` directly.
//
// Codegen is a straightforward stack machine: every expression leaves its
// result in a0, binary operators spill the left operand to the RISC-V stack.
// `s0` is the frame pointer; locals/params live in the frame, globals in a data
// section after the code. No register allocator, no optimiser — just correct,
// readable output you can diff against hand-written assembly.

import {
  S_TICK, S_BEARING, S_RANGE, S_GRAVITY, S_YAW, S_YAW_VEL, S_SHOULDER,
  S_SHOULDER_VEL, S_ELBOW, S_ELBOW_VEL, S_DRINKS, S_CUPS, S_RNG, S_ARMLEN, S_HELD,
  A_TQ_YAW, A_TQ_SHOULDER, A_TQ_ELBOW, A_RELEASE, A_LOG,
} from '../../src/constants.js';

// MMIO names injected as compile-time constants (mirrors players.js MMIO_EQU).
const MMIO_CONSTS = {
  S_TICK, S_BEARING, S_RANGE, S_GRAVITY, S_YAW, S_YAW_VEL, S_SHOULDER,
  S_SHOULDER_VEL, S_ELBOW, S_ELBOW_VEL, S_DRINKS, S_CUPS, S_RNG, S_ARMLEN, S_HELD,
  A_TQ_YAW, A_TQ_SHOULDER, A_TQ_ELBOW, A_RELEASE, A_LOG,
};

const BUILTINS = { read: 1, write: 2, yield: 0, halt: 0, abs: 1 };

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------
const KEYWORDS = new Set([
  'int', 'void', 'const', 'if', 'else', 'while', 'for', 'return',
  'break', 'continue',
]);

// Operators / punctuation, longest first so the scanner is greedy.
const SYMBOLS = [
  '<<=', '>>=',
  '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '|', '^',
  '(', ')', '{', '}', ';', ',',
];

function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  const push = (t, v) => toks.push({ t, v, line });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    // comments
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    // numbers (hex or decimal)
    if (c >= '0' && c <= '9') {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j])) j++;
        push('num', parseInt(src.slice(i, j), 16) | 0);
      } else {
        while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
        push('num', parseInt(src.slice(i, j), 10) | 0);
      }
      i = j; continue;
    }
    // identifiers / keywords
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      push(KEYWORDS.has(word) ? 'kw' : 'id', word);
      i = j; continue;
    }
    // operators / punctuation
    let matched = null;
    for (const s of SYMBOLS) {
      if (src.startsWith(s, i)) { matched = s; break; }
    }
    if (!matched) throw new Error(`lex error (line ${line}): unexpected character '${c}'`);
    push('sym', matched);
    i += matched.length;
  }
  push('eof', null);
  return toks;
}

// ---------------------------------------------------------------------------
// Parser  ->  AST
// ---------------------------------------------------------------------------
// Binary operator precedence (higher binds tighter). Assignment and the unary
// operators are handled separately.
const BINPREC = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

function parse(toks) {
  let p = 0;
  const peek = (k = 0) => toks[p + k];
  const next = () => toks[p++];
  const atEnd = () => peek().t === 'eof';
  function expect(t, v) {
    const tok = peek();
    if (tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new Error(`parse error (line ${tok.line}): expected ${v ?? t}, got '${tok.v}'`);
    }
    return next();
  }
  const isSym = (v) => peek().t === 'sym' && peek().v === v;
  const isKw = (v) => peek().t === 'kw' && peek().v === v;

  // ---- expressions ----
  function parsePrimary() {
    const tok = peek();
    if (tok.t === 'num') { next(); return { k: 'num', v: tok.v }; }
    if (tok.t === 'id') {
      next();
      if (isSym('(')) { // call
        next();
        const args = [];
        if (!isSym(')')) {
          do { args.push(parseAssignExpr()); } while (isSym(',') && next());
        }
        expect('sym', ')');
        return { k: 'call', name: tok.v, args, line: tok.line };
      }
      return { k: 'var', name: tok.v, line: tok.line };
    }
    if (isSym('(')) { next(); const e = parseAssignExpr(); expect('sym', ')'); return e; }
    throw new Error(`parse error (line ${tok.line}): unexpected '${tok.v}'`);
  }

  function parseUnary() {
    if (peek().t === 'sym' && ['!', '~', '-', '+'].includes(peek().v)) {
      const op = next().v;
      return { k: 'un', op, e: parseUnary() };
    }
    return parsePrimary();
  }

  function parseBinary(minPrec) {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      if (tok.t !== 'sym' || !(tok.v in BINPREC)) break;
      const prec = BINPREC[tok.v];
      if (prec < minPrec) break;
      next();
      const right = parseBinary(prec + 1); // left-associative
      if (tok.v === '&&') left = { k: 'logand', l: left, r: right };
      else if (tok.v === '||') left = { k: 'logor', l: left, r: right };
      else left = { k: 'bin', op: tok.v, l: left, r: right };
    }
    return left;
  }

  function parseAssignExpr() {
    const left = parseBinary(1);
    if (peek().t === 'sym' && ASSIGN_OPS.has(peek().v)) {
      const op = next().v;
      if (left.k !== 'var') throw new Error(`parse error: assignment to non-variable`);
      const rhs = parseAssignExpr();
      if (op === '=') return { k: 'assign', name: left.name, e: rhs };
      // desugar  x op= e   ->   x = x op e
      const binop = op.slice(0, -1);
      return { k: 'assign', name: left.name, e: { k: 'bin', op: binop, l: { k: 'var', name: left.name }, r: rhs } };
    }
    return left;
  }

  // ---- statements ----
  function parseBlock() {
    expect('sym', '{');
    const body = [];
    while (!isSym('}') && !atEnd()) body.push(parseStmt());
    expect('sym', '}');
    return { k: 'block', body };
  }

  function parseVarDecl() {
    expect('kw', 'int');
    const name = expect('id').v;
    let init = null;
    if (isSym('=')) { next(); init = parseAssignExpr(); }
    expect('sym', ';');
    return { k: 'vardecl', name, init };
  }

  function parseStmt() {
    if (isSym('{')) return parseBlock();
    if (isSym(';')) { next(); return { k: 'empty' }; }
    if (isKw('int')) return parseVarDecl();
    if (isKw('if')) {
      next(); expect('sym', '('); const c = parseAssignExpr(); expect('sym', ')');
      const then = parseStmt();
      let els = null;
      if (isKw('else')) { next(); els = parseStmt(); }
      return { k: 'if', c, then, els };
    }
    if (isKw('while')) {
      next(); expect('sym', '('); const c = parseAssignExpr(); expect('sym', ')');
      return { k: 'while', c, body: parseStmt() };
    }
    if (isKw('for')) {
      next(); expect('sym', '(');
      let init = null;
      if (isSym(';')) next();
      else if (isKw('int')) init = parseVarDecl(); // consumes its own ';'
      else { init = { k: 'expr', e: parseAssignExpr() }; expect('sym', ';'); }
      const c = isSym(';') ? null : parseAssignExpr(); expect('sym', ';');
      const post = isSym(')') ? null : parseAssignExpr(); expect('sym', ')');
      return { k: 'for', init, c, post, body: parseStmt() };
    }
    if (isKw('return')) {
      next();
      const e = isSym(';') ? null : parseAssignExpr();
      expect('sym', ';');
      return { k: 'return', e };
    }
    if (isKw('break')) { next(); expect('sym', ';'); return { k: 'break' }; }
    if (isKw('continue')) { next(); expect('sym', ';'); return { k: 'continue' }; }
    const e = parseAssignExpr(); expect('sym', ';');
    return { k: 'expr', e };
  }

  // ---- top level ----
  const decls = [];
  while (!atEnd()) {
    if (isKw('const')) {
      next(); expect('kw', 'int');
      const name = expect('id').v;
      expect('sym', '=');
      const e = parseAssignExpr();
      expect('sym', ';');
      decls.push({ k: 'const', name, e });
      continue;
    }
    // function or global: <type> name ...
    const typeTok = peek();
    if (!(isKw('int') || isKw('void'))) {
      throw new Error(`parse error (line ${typeTok.line}): expected a declaration, got '${typeTok.v}'`);
    }
    const type = next().v;
    const name = expect('id').v;
    if (isSym('(')) {
      next();
      const params = [];
      if (!isSym(')')) {
        do {
          // accept `int name` or bare `void`
          if (isKw('void')) { next(); break; }
          expect('kw', 'int');
          params.push(expect('id').v);
        } while (isSym(',') && next());
      }
      expect('sym', ')');
      const body = parseBlock();
      decls.push({ k: 'func', name, params, body, type });
    } else {
      if (type !== 'int') throw new Error(`parse error (line ${typeTok.line}): global '${name}' must be int`);
      let init = null;
      if (isSym('=')) { next(); init = parseAssignExpr(); }
      expect('sym', ';');
      decls.push({ k: 'global', name, init });
    }
  }
  return decls;
}

// ---------------------------------------------------------------------------
// Constant folding (for `const int` and global initializers)
// ---------------------------------------------------------------------------
function foldConst(node, consts) {
  switch (node.k) {
    case 'num': return node.v | 0;
    case 'var':
      if (node.name in consts) return consts[node.name] | 0;
      throw new Error(`'${node.name}' is not a compile-time constant`);
    case 'un': {
      const v = foldConst(node.e, consts) | 0;
      switch (node.op) {
        case '-': return (-v) | 0;
        case '+': return v;
        case '~': return (~v) | 0;
        case '!': return v ? 0 : 1;
      }
      break;
    }
    case 'bin': {
      const a = foldConst(node.l, consts) | 0, b = foldConst(node.r, consts) | 0;
      switch (node.op) {
        case '+': return (a + b) | 0;
        case '-': return (a - b) | 0;
        case '*': return Math.imul(a, b);
        case '/': return b === 0 ? -1 : (a / b) | 0;
        case '%': return b === 0 ? a : (a % b) | 0;
        case '&': return (a & b) | 0;
        case '|': return (a | b) | 0;
        case '^': return (a ^ b) | 0;
        case '<<': return (a << (b & 31)) | 0;
        case '>>': return (a >> (b & 31)) | 0;
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
      }
      break;
    }
  }
  throw new Error(`expression is not a compile-time constant`);
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------
export function compile(source, opts = {}) {
  const decls = parse(lex(source));

  // ---- gather top-level symbol tables ----
  const consts = Object.assign(Object.create(null), MMIO_CONSTS);
  const globals = new Map();   // name -> { init }
  const funcs = new Map();     // name -> decl
  for (const d of decls) {
    if (d.k === 'const') {
      if (d.name in consts || globals.has(d.name)) throw new Error(`duplicate name '${d.name}'`);
      consts[d.name] = foldConst(d.e, consts) | 0;
    } else if (d.k === 'global') {
      if (d.name in consts || globals.has(d.name)) throw new Error(`duplicate name '${d.name}'`);
      globals.set(d.name, d);
    } else if (d.k === 'func') {
      if (d.name in BUILTINS) throw new Error(`cannot redefine built-in '${d.name}'`);
      if (funcs.has(d.name)) throw new Error(`duplicate function '${d.name}'`);
      funcs.set(d.name, d);
    }
  }
  if (!funcs.has('main')) throw new Error(`program has no main()`);

  let labelN = 0;
  const newLabel = (hint) => `.L${labelN++}_${hint}`;

  const out = ['# --- generated by RobotC (lang/robotc/compiler.mjs) ---'];
  // Bootstrap: enter main; if it ever returns, stop the turn.
  out.push('start:');
  out.push('    call fn_main');
  out.push('    ebreak');
  out.push('');

  for (const d of decls) if (d.k === 'func') genFunc(d);

  // ---- data section ----
  if (globals.size) {
    out.push('');
    out.push('# --- globals ---');
    for (const [name, g] of globals) {
      const init = g.init ? foldConst(g.init, consts) | 0 : 0;
      out.push(`gv_${name}:`);
      out.push(`    .word ${init}`);
    }
  }

  return out.join('\n') + '\n';

  // -------------------------------------------------------------------------
  function genFunc(fn) {
    const body = [];
    const emit = (s) => body.push(s === '' ? '' : '    ' + s);
    const label = (l) => body.push(l + ':');

    // scope chain for locals/params
    const scopes = [Object.create(null)];
    let slotCount = 0, maxSlots = 0;
    const pushScope = () => scopes.push(Object.create(null));
    const popScope = () => { const s = scopes.pop(); slotCount -= Object.keys(s).filter((n) => s[n].kind === 'local').length; };
    function declareLocal(name) {
      const off = -4 * (slotCount + 1);
      scopes[scopes.length - 1][name] = { kind: 'local', off };
      slotCount++; if (slotCount > maxSlots) maxSlots = slotCount;
      return off;
    }
    function resolve(name) {
      for (let i = scopes.length - 1; i >= 0; i--) if (name in scopes[i]) return scopes[i][name];
      if (globals.has(name)) return { kind: 'global' };
      if (name in consts) return { kind: 'const', val: consts[name] };
      return null;
    }

    // params: arg0 at s0+8, arg1 at s0+12, ...
    fn.params.forEach((pname, i) => { scopes[0][pname] = { kind: 'param', off: 8 + 4 * i }; });

    const epi = `.epi_${fn.name}`;
    const loops = [];

    genStmt(fn.body);

    // ---- stitch prologue + body + epilogue ----
    out.push(`fn_${fn.name}:`);
    out.push('    addi sp, sp, -4');
    out.push('    sw   ra, 0(sp)');
    out.push('    addi sp, sp, -4');
    out.push('    sw   s0, 0(sp)');
    out.push('    mv   s0, sp');
    if (maxSlots) out.push(`    addi sp, sp, -${4 * maxSlots}`);
    for (const l of body) out.push(l);
    out.push(`${epi}:`);
    out.push('    mv   sp, s0');
    out.push('    lw   s0, 0(sp)');
    out.push('    addi sp, sp, 4');
    out.push('    lw   ra, 0(sp)');
    out.push('    addi sp, sp, 4');
    out.push('    ret');
    out.push('');

    // ---- statement / expression generators (capture emit/label/scopes) ----
    function genStmt(node) {
      switch (node.k) {
        case 'block': {
          pushScope();
          for (const s of node.body) genStmt(s);
          popScope();
          break;
        }
        case 'vardecl': {
          const off = declareLocal(node.name);
          if (node.init) { genExpr(node.init); emit(`sw   a0, ${off}(s0)`); }
          else emit(`sw   zero, ${off}(s0)`);
          break;
        }
        case 'expr': genExpr(node.e); break;
        case 'empty': break;
        case 'if': {
          const lElse = newLabel('else'), lEnd = newLabel('endif');
          genExpr(node.c);
          emit(`beqz a0, ${node.els ? lElse : lEnd}`);
          genStmt(node.then);
          if (node.els) { emit(`j    ${lEnd}`); label(lElse); genStmt(node.els); }
          label(lEnd);
          break;
        }
        case 'while': {
          const lTop = newLabel('while'), lEnd = newLabel('endwhile');
          loops.push({ brk: lEnd, cont: lTop });
          label(lTop);
          genExpr(node.c); emit(`beqz a0, ${lEnd}`);
          genStmt(node.body);
          emit(`j    ${lTop}`);
          label(lEnd);
          loops.pop();
          break;
        }
        case 'for': {
          pushScope();
          if (node.init) genStmt(node.init);
          const lTop = newLabel('for'), lPost = newLabel('forpost'), lEnd = newLabel('endfor');
          loops.push({ brk: lEnd, cont: lPost });
          label(lTop);
          if (node.c) { genExpr(node.c); emit(`beqz a0, ${lEnd}`); }
          genStmt(node.body);
          label(lPost);
          if (node.post) genExpr(node.post);
          emit(`j    ${lTop}`);
          label(lEnd);
          loops.pop();
          popScope();
          break;
        }
        case 'return':
          if (node.e) genExpr(node.e);
          emit(`j    ${epi}`);
          break;
        case 'break':
          if (!loops.length) throw new Error('break outside loop');
          emit(`j    ${loops[loops.length - 1].brk}`);
          break;
        case 'continue':
          if (!loops.length) throw new Error('continue outside loop');
          emit(`j    ${loops[loops.length - 1].cont}`);
          break;
        default: throw new Error(`internal: bad stmt ${node.k}`);
      }
    }

    function push() { emit('addi sp, sp, -4'); emit('sw   a0, 0(sp)'); }
    function pop(r) { emit(`lw   ${r}, 0(sp)`); emit('addi sp, sp, 4'); }

    function genExpr(node) {
      switch (node.k) {
        case 'num': emit(`li   a0, ${node.v}`); break;
        case 'var': loadVar(node.name); break;
        case 'assign': genExpr(node.e); storeVar(node.name); break;
        case 'un':
          genExpr(node.e);
          if (node.op === '-') emit('neg  a0, a0');
          else if (node.op === '!') emit('seqz a0, a0');
          else if (node.op === '~') emit('not  a0, a0');
          // '+' is a no-op
          break;
        case 'logand': {
          const lFalse = newLabel('andF'), lEnd = newLabel('andE');
          genExpr(node.l); emit(`beqz a0, ${lFalse}`);
          genExpr(node.r); emit('snez a0, a0'); emit(`j    ${lEnd}`);
          label(lFalse); emit('li   a0, 0');
          label(lEnd);
          break;
        }
        case 'logor': {
          const lTrue = newLabel('orT'), lEnd = newLabel('orE');
          genExpr(node.l); emit(`bnez a0, ${lTrue}`);
          genExpr(node.r); emit('snez a0, a0'); emit(`j    ${lEnd}`);
          label(lTrue); emit('li   a0, 1');
          label(lEnd);
          break;
        }
        case 'bin':
          genExpr(node.l); push();
          genExpr(node.r); pop('a1');     // a1 = left, a0 = right
          binop(node.op);
          break;
        case 'call': genCall(node); break;
        default: throw new Error(`internal: bad expr ${node.k}`);
      }
    }

    function binop(op) {
      switch (op) {
        case '+': emit('add  a0, a1, a0'); break;
        case '-': emit('sub  a0, a1, a0'); break;
        case '*': emit('mul  a0, a1, a0'); break;
        case '/': emit('div  a0, a1, a0'); break;
        case '%': emit('rem  a0, a1, a0'); break;
        case '&': emit('and  a0, a1, a0'); break;
        case '|': emit('or   a0, a1, a0'); break;
        case '^': emit('xor  a0, a1, a0'); break;
        case '<<': emit('sll  a0, a1, a0'); break;
        case '>>': emit('sra  a0, a1, a0'); break;
        case '<': emit('slt  a0, a1, a0'); break;
        case '>': emit('slt  a0, a0, a1'); break;
        case '<=': emit('slt  a0, a0, a1'); emit('xori a0, a0, 1'); break;
        case '>=': emit('slt  a0, a1, a0'); emit('xori a0, a0, 1'); break;
        case '==': emit('sub  a0, a1, a0'); emit('seqz a0, a0'); break;
        case '!=': emit('sub  a0, a1, a0'); emit('snez a0, a0'); break;
        default: throw new Error(`internal: bad binop ${op}`);
      }
    }

    function loadVar(name) {
      const r = resolve(name);
      if (!r) throw new Error(`undefined name '${name}'`);
      if (r.kind === 'const') emit(`li   a0, ${r.val}`);
      else if (r.kind === 'global') { emit(`la   t0, gv_${name}`); emit('lw   a0, 0(t0)'); }
      else emit(`lw   a0, ${r.off}(s0)`);
    }
    function storeVar(name) {
      const r = resolve(name);
      if (!r) throw new Error(`undefined name '${name}'`);
      if (r.kind === 'const') throw new Error(`cannot assign to const '${name}'`);
      if (r.kind === 'global') { emit(`la   t0, gv_${name}`); emit('sw   a0, 0(t0)'); }
      else emit(`sw   a0, ${r.off}(s0)`);
    }

    function genCall(node) {
      const { name, args } = node;
      if (name in BUILTINS) {
        const want = BUILTINS[name];
        if (args.length !== want) throw new Error(`${name}() expects ${want} args, got ${args.length}`);
        switch (name) {
          case 'read': genExpr(args[0]); emit('lw   a0, 0(a0)'); break;
          case 'write':
            genExpr(args[0]); push();           // addr
            genExpr(args[1]); pop('a1');         // a1 = addr, a0 = value
            emit('sw   a0, 0(a1)');
            break;
          case 'yield': emit('ecall'); emit('li   a0, 0'); break;
          case 'halt': emit('ebreak'); break;
          case 'abs': {
            genExpr(args[0]);
            const lPos = newLabel('abs');
            emit(`bgez a0, ${lPos}`); emit('neg  a0, a0'); label(lPos);
            break;
          }
        }
        return;
      }
      const fn2 = funcs.get(name);
      if (!fn2) throw new Error(`call to undefined function '${name}'`);
      if (args.length !== fn2.params.length) {
        throw new Error(`${name}() expects ${fn2.params.length} args, got ${args.length}`);
      }
      // push args right-to-left so arg0 ends up at the lowest address (s0+8)
      for (let i = args.length - 1; i >= 0; i--) { genExpr(args[i]); push(); }
      emit(`call fn_${name}`);
      if (args.length) emit(`addi sp, sp, ${4 * args.length}`);
      // result already in a0
    }
  }
}

export { MMIO_CONSTS };
