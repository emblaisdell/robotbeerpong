# Robot Beer Pong — Robot ISA & Programming Guide

This is the contract between a **player program** (RISC-V machine code) and the
**robot** it drives. If you want to write a new strategy, this is the reference.

The robot is a bare-metal RV32IM machine. It has no operating system, no
syscalls, no floating point. It talks to its sensors and actuators through
**memory-mapped IO** (MMIO): you read and write ordinary memory addresses, and
some of those addresses are wired to hardware instead of RAM.

> **Source of truth:** every address and constant below is defined once in
> [`src/constants.js`](../src/constants.js) and imported by both the assembler
> (as symbol names) and the simulation bridge ([`src/engine.js`](../src/engine.js)),
> so they cannot drift. The reference players live in
> [`src/players.js`](../src/players.js).

---

## 1. Mental model: one throw per turn

A match alternates turns. On your turn the robot:

1. **Resets.** Registers are zeroed, `pc = 0x0000`, `sp = 0x0F000`. A *fresh*
   copy of your program is loaded into memory (see [§8](#8-statelessness) — you
   do **not** keep state between turns).
2. **Runs your code** from address `0x0000` until you execute `ecall`, or until
   the instruction budget (200,000) is exhausted.
3. **Throws.** Whatever you last wrote to the actuator registers is used to
   launch the ball — *if* you wrote `1` to `A_FIRE`. If you never fired, the arm
   fumbles the ball (a wild, weak toss).

Your job each turn: read the sensors, compute a throw, write the actuators,
fire, halt. That's it.

```asm
start:
    # ... read sensors, compute yaw/pitch/power ...
    sw  s_yaw,   0(reg_A_YAW)     # aim
    sw  s_pitch, 0(reg_A_PITCH)   # elevation
    sw  s_power, 0(reg_A_POWER)   # speed
    li  t1, 1
    sw  t1, 0(reg_A_FIRE)         # release the magnet -> throw
    ecall                         # end the turn
```

---

## 2. Memory map

| Region        | Range                   | Notes                                  |
|---------------|-------------------------|----------------------------------------|
| Program / text| `0x00000` …             | Your code is loaded here; `pc` starts at `0`. |
| Data / heap   | … up to the stack       | Use `.word` / `.byte`, or scratch RAM. |
| Stack         | grows down from `0x0F000` | `sp` is initialised to `0x0F000`.    |
| **MMIO**      | `0x10000` … `0x10FFF`   | Sensor/actuator registers (below).     |
| Total RAM     | `0x20000` (128 KiB)     |                                        |

All accesses are little-endian. Loads/stores inside the MMIO window are routed
to the device, not RAM. Use word (`lw`/`sw`) access for registers.

---

## 3. Sensor registers (read-only)

Read with `lw`. Values are integers in the fixed-point units of [§5](#5-units).

| Name        | Address   | Unit      | Meaning |
|-------------|-----------|-----------|---------|
| `S_BEARING` | `0x10000` | mrad, signed | Horizontal angle to the **nearest live opponent cup**. `0` = straight ahead; positive = one way, negative = the other. |
| `S_RANGE`   | `0x10004` | mm        | Ground distance to that cup. |
| `S_DRINKS`  | `0x10008` | count     | How inebriated you are (= how many of *your* cups have been sunk). Drives every handicap in [§7](#7-the-inebriation-handicap). |
| `S_YAW`     | `0x1000C` | mrad      | Current waist (yaw) joint angle. At rest this is ~0 (plus sensor error). |
| `S_PITCH`   | `0x10010` | mrad      | Current arm (pitch) joint angle. |
| `S_GRAVITY` | `0x10014` | mm/s²     | Gravity, so you can do honest ballistics. Currently `2600`. |
| `S_RNG`     | `0x10018` | u32       | A fresh pseudo-random word each read. |
| `S_CUPS`    | `0x1001C` | count     | Opponent cups still standing (your targets remaining). |

Sensor reads are **noisy when you're drunk** — see [§7](#7-the-inebriation-handicap).
Read each register once into a register and reuse it; re-reading `S_BEARING`
gives a *different* noisy sample each time.

---

## 4. Actuator registers (write-only)

Write with `sw`. The throw uses the **last** value written to each before you halt.

| Name      | Address   | Unit  | Meaning |
|-----------|-----------|-------|---------|
| `A_YAW`   | `0x10020` | mrad  | Commanded waist yaw. `0` aims straight ahead; set it to `S_BEARING` to aim at the nearest cup. |
| `A_PITCH` | `0x10024` | mrad  | Launch elevation. `785` ≈ 45°, the range-maximising angle. |
| `A_POWER` | `0x10028` | mm/s  | Launch speed. This is what ballistics is about. |
| `A_FIRE`  | `0x1002C` | flag  | Write `1` to commit the throw. **No fire → the ball is fumbled.** |
| `A_LOG`   | `0x10030` | i32   | Debug: each value written appears in the match's play-by-play log. |

---

## 5. Units & fixed-point

RV32I has no FPU, so everything is integers:

- **Angles** — milliradians (`1 rad = 1000`; `π ≈ 3142`; `45° ≈ 785`).
- **Lengths** — millimetres (`1 world unit = 100 mm`).
- **Speeds** — mm per second.

Because there's no float and no overflow checking, watch your intermediate
magnitudes (a 32-bit signed int maxes at ~2.1 billion). Order your multiplies to
keep products small — e.g. divide before the final multiply.

### Ballistics hint

The launch turns `(yaw, pitch, power)` into a velocity and the ball flies under
`S_GRAVITY`. For a shot at 45°, range and speed relate (very nearly) by

```
power ≈ isqrt( gravity × range )        # then trimmed for launch height
```

The reference **Sniper** uses `power = isqrt(gravity × range × 737 / 1000)`,
where the `0.737` folds in the launch-height correction found by
[`tools/calibrate.mjs`](../tools/calibrate.mjs). Integer `isqrt` is a dozen
instructions (see Sniper's `scan:`/`body:` loop). The **Lobber** skips the sqrt
with a linear fit `power = range × 396 / 1000 + 1189`.

---

## 6. Instruction set & assembler

The CPU implements **RV32I + RV32M** (base integers plus `mul`/`mulh*`/`div[u]`/
`rem[u]`). `ecall` and `ebreak` **halt the turn**; the value in `a0` is reported
as the halt code but is otherwise unused.

The in-browser assembler ([`src/riscv.js`](../src/riscv.js)) accepts:

- **All RV32I/M instructions**, ABI register names (`a0`–`a7`, `t0`–`t6`,
  `s0`–`s11`, `sp`, `ra`, `zero`, …) and `x0`–`x31`.
- **Pseudo-instructions:** `li`, `la`, `mv`, `nop`, `not`, `neg`, `seqz`,
  `snez`, `j`, `jr`, `ret`, `call`, `beqz`, `bnez`, `bltz`, `bgez`, `bgtz`,
  `blez`, `bgt`, `ble`, `bgtu`, `bleu`.
- **Directives:** `.word`, `.byte`, `.equ` / `.set`, `.align`,
  `.text`/`.data`/`.globl` (accepted, single flat segment). Labels are `name:`.
- **Comments:** `#` or `;` to end of line.

Memory operands use the usual `offset(reg)` form; bare symbols assemble to an
absolute address via `x0`. Entry is the `start:` (or `_start:`) label, else `0`.

The MMIO names (`S_BEARING`, `A_FIRE`, …) are injected as assembler constants, so
you can write `li t0, A_FIRE` directly.

---

## 7. The inebriation handicap

You score by sinking your **opponent's** cups, which makes *them* drink. So the
robot that's losing gets drunk — and a drunk robot plays worse. Everything below
scales with `drinks` (= `S_DRINKS`); at `drinks = 0` none of it applies.

All noise is roughly Gaussian with the listed standard deviation.

| What degrades        | How, per drink |
|----------------------|----------------|
| `S_BEARING` reads    | ± `18 × drinks` mrad of noise, fresh each read. |
| `S_RANGE` reads      | ± `90 × drinks` mm of noise. |
| `S_YAW` / `S_PITCH`  | ± `8 × drinks` mrad of noise. |
| Actuated yaw         | over/under-actuation `×(1 ± 0.02·drinks)` **plus** a `± 20·drinks` mrad aim bias. |
| Actuated pitch       | `± 14 × drinks` mrad bias. |
| Actuated power       | over/under-actuation `×(1 ± 0.05·drinks)`. |
| Program memory       | up to `drinks` random byte-flips in `[0x0000, 0x4000)` each turn — can corrupt code/data and make you crash or fumble. |

The magnitudes are tuned so total failure stays *avoidable* and the misfires are
comedic, not fatal. A precise strategy (Sniper) is hurt most by the read/aim
noise; a robust one (Lobber) rides it out longer.

---

## 8. Statelessness

Every turn starts from a **fresh program image and zeroed registers**. Anything
you wrote to RAM last turn is gone; there are no persistent globals. If you want
"memory" across turns, you have to derive it from the sensors (e.g. `S_CUPS`,
`S_DRINKS`) — there is intentionally no hidden channel.

The instruction budget is **200,000 per turn**. Run past it without firing and
the turn ends in a fumble, so avoid unbounded loops.

---

## 9. A minimal player

Aim at the nearest cup, lob it at a fixed power, fire, done:

```asm
# minimal.s — aim at the nearest cup, throw at a fixed speed.
start:
    li   t0, S_BEARING
    lw   a0, 0(t0)          # a0 = bearing to nearest live cup (mrad)

    li   t0, A_YAW
    sw   a0, 0(t0)          # aim there

    li   t0, A_PITCH
    li   t1, 785            # ~45 degrees
    sw   t1, 0(t0)

    li   t0, A_POWER
    li   t1, 3000           # mm/s — a mid-rack lob
    sw   t1, 0(t0)

    li   t0, A_FIRE
    li   t1, 1
    sw   t1, 0(t0)          # release the magnet
    ecall                   # end the turn
```

For a version that actually *solves* for the right power from `S_RANGE` and
`S_GRAVITY`, read `SNIPER` in [`src/players.js`](../src/players.js).

---

## 10. Adding & testing a strategy

1. Add an entry to `PLAYERS` in [`src/players.js`](../src/players.js) with your
   assembly `source` (use the `MMIO_EQU` names — they're already in scope for the
   assembler).
2. It shows up automatically in the strategy dropdowns in the browser.
3. Headless checks (no browser needed):
   - `node tools/test-engine.mjs` — sober accuracy, head-to-head, termination.
   - `node tools/calibrate.mjs` — re-derive ballistics constants if you change
     court/gravity/launch-height.
   - `node tools/test-riscv.mjs` — CPU + assembler unit tests.

A "good when sober" strategy should clear a 6-cup rack in ~6 throws with
`drinks` forced to 0; the inebriation handicap is what separates the contenders.
```
