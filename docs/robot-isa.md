# Robot Beer Pong - Robot ISA & Programming Guide

This is the contract between a **player program** (RISC-V machine code) and the
**robot** it drives. The robot is a bare-metal RV32IM machine - no OS, no
syscalls, no floating point - and it is a **real-time joint controller**: your
program runs every tick, reads the live joint sensors, and commands a motor
torque to each joint. The ball is thrown by the arm's actual motion, not by a
high-level "throw" command.

> **Source of truth:** every address/constant is defined once in
> [`src/constants.js`](../src/constants.js) (imported by both the asm and the
> sim) and the arm model in [`src/arm.js`](../src/arm.js). Reference controllers
> live in [`src/players.js`](../src/players.js).

---

## 1. Mental model: a control loop, not a command

Your program is **one long loop**. `ecall` does not end anything - it **yields
one tick** (~1/240 s of simulated time) and then your program resumes right
after it, with its registers and memory intact. So the shape is always:

```asm
start:
    # one-time setup (read range, compute targets) ...
loop:
    # read joint sensors, compute torques, write them ...
    ecall          # yield: the world advances one tick, sensors refresh
    j    loop
```

Each tick the engine: refreshes the sensor registers from the live arm, runs
your program until it `ecall`s (or hits the 6000-instruction budget), reads the
torques you wrote, and integrates the arm dynamics one step. When you write
`A_RELEASE`, the magnet lets go and the ball launches at the **end-effector's
true velocity**. The arm keeps simulating afterward (follow-through), and it is
**not reset between turns** - next turn it picks up from wherever it came to
rest.

You have up to ~900 ticks (~3.75 s) to wind up and release, or the turn fizzles.

---

## 2. The arm

Three revolute joints, each a torque-driven motor with inertia, viscous
damping, gravity, and hard angle limits:

| Joint | Sensor angle (0 =) | + direction | limit | torque ceiling |
|-------|--------------------|-------------|-------|----------------|
| yaw (waist)     | aimed straight at opponent | turns one way   | ±1.2 rad | ±60 |
| shoulder (arm)  | straight up                | tips toward cups | ±2.5 rad | ±220 |
| elbow (hand)    | inline with upper arm      | continues the bend | ±2.6 rad | ±90 |

The two segments are equal length; shoulder→tip reach is reported in `S_ARMLEN`
(1280 mm). The motor torque you write is clamped to the ceiling above; the joint
then obeys `ω += (τ − damping·ω − gravity(θ))·dt`, `θ += ω·dt`. You must actively
drive the joints - gravity will pull the arm down if you don't.

---

## 3. Sensor registers (read-only, refreshed each tick)

Read with `lw`. Integers in the fixed-point units of [§5](#5-units). Reads are
**noisy when you're drunk** (see [§7](#7-the-inebriation-handicap)).

| Name | Address | Unit | Meaning |
|------|---------|------|---------|
| `S_TICK`        | `0x10000` | count | ticks since the turn began |
| `S_BEARING`     | `0x10004` | mrad  | horizontal angle to the nearest live cup |
| `S_RANGE`       | `0x10008` | mm    | ground distance to that cup |
| `S_GRAVITY`     | `0x1000C` | mm/s² | gravity (currently 2600) |
| `S_YAW`         | `0x10010` | mrad  | waist angle |
| `S_YAW_VEL`     | `0x10014` | mrad/s | waist angular velocity |
| `S_SHOULDER`    | `0x10018` | mrad  | shoulder angle (0 = straight up) |
| `S_SHOULDER_VEL`| `0x1001C` | mrad/s | shoulder angular velocity |
| `S_ELBOW`       | `0x10020` | mrad  | elbow angle |
| `S_ELBOW_VEL`   | `0x10024` | mrad/s | elbow angular velocity |
| `S_DRINKS`      | `0x10028` | count | inebriation level (own cups lost) |
| `S_CUPS`        | `0x1002C` | count | opponent cups still standing |
| `S_RNG`         | `0x10030` | u32   | fresh pseudo-random word |
| `S_ARMLEN`      | `0x10034` | mm    | shoulder→tip reach (for IK) |
| `S_HELD`        | `0x10038` | 0/1   | 1 while the magnet still holds the ball |

## 4. Actuator registers (write, latched each tick)

| Name | Address | Meaning |
|------|---------|---------|
| `A_TQ_YAW`      | `0x10040` | yaw motor torque (clamped to ±60) |
| `A_TQ_SHOULDER` | `0x10044` | shoulder motor torque (±220) |
| `A_TQ_ELBOW`    | `0x10048` | elbow motor torque (±90) |
| `A_RELEASE`     | `0x1004C` | write 1 → the magnet lets go of the ball |
| `A_LOG`         | `0x10050` | write a value → debug log |

---

## 5. Units & fixed-point

Integer-only (no FPU): angles in **milliradians** (1 rad = 1000), angular
velocity in **mrad/s**, lengths in **mm** (1 world unit = 100 mm), gravity in
**mm/s²**. Torque is a unitless integer clamped to the ceilings above. Watch for
32-bit overflow - order your multiplies and divide early.

### Inverse kinematics hint

The throw is the tip velocity at release. For a straight arm rotating at the
shoulder, the tip speed is `v = ω · L` (L = `S_ARMLEN`), and the velocity points
perpendicular to the arm - so releasing while the shoulder leans **back** at
angle θ launches the ball up-forward at elevation θ. The reference controllers
therefore: pick a target tip speed `v` from the range (`v = isqrt(g·range·k)`),
convert it to a target shoulder angular velocity `wstar = v·1000 / S_ARMLEN`,
wind the shoulder back, drive its angular velocity to `wstar`, and release as it
swings up through a fixed lean-back angle (~−785 mrad → ~45° launch). The elbow
is whipped (cocked back, snapped straight) but is ~straight at release so it
doesn't change the speed.

---

## 6. Instruction set & assembler

RV32I + RV32M (`mul`/`div`/`rem`). `ecall` = yield one tick; `ebreak` /
illegal instruction = crash (the arm goes limp and the turn fizzles). The
in-browser assembler ([`src/riscv.js`](../src/riscv.js)) supports ABI register
names, the usual pseudo-instructions (`li`, `mv`, `j`, `call`, `ret`, `beqz`,
`bgt`, `bgtu`, `neg`, …), `offset(reg)` memory operands, and the `.word`,
`.byte`, `.equ`, `.align` directives. The MMIO names above are injected as
assembler constants. Execution starts at the `start:` label.

---

## 7. The inebriation handicap

You score by sinking your **opponent's** cups, which makes *them* drink - so the
loser gets drunk and plays worse. Everything below scales with `S_DRINKS`; at 0
none applies.

| What degrades | How, per drink |
|---------------|----------------|
| sensor reads (angles, velocities) | ± noise on every read |
| `S_BEARING` / `S_RANGE`           | ± noise (aim/range drift) |
| actuated torque                   | scale error + bias + **lag** (commands arrive late) |
| program memory                    | random byte-flips - can crash the controller mid-swing |

A precise controller is hit hardest by the sensor/torque noise wrecking its
release timing; a sturdier one rides it out longer. The handicap is tuned so
total failure is rare and the misfires are comedic.

---

## 8. A minimal controller

Wind the shoulder back, swing it forward at full torque, release as it passes
the launch angle - aimed straight ahead, fixed power. (The reference `SNIPER`
adds inverse ballistics, yaw aiming, an elbow whip, and a follow-through.)

```asm
start:
    li   s0, 0                 # phase: 0 = wind back, 1 = swing
loop:
    li   t0, S_SHOULDER
    lw   a1, 0(t0)             # shoulder angle
    bnez s0, swing

    # wind back toward -1450 mrad
    li   t3, -200             # constant back-torque
    li   t4, -1330
    bgt  t4, a1, swing_set    # reached? (-1330 > sh) -> switch
    j    write
swing_set:
    li   s0, 1
swing:
    li   t3, 220              # full forward torque
    li   t4, -785
    blt  a1, t4, write        # not up to release angle yet
    li   t0, A_RELEASE
    li   t5, 1
    sw   t5, 0(t0)            # let go
write:
    li   t0, A_TQ_SHOULDER
    sw   t3, 0(t0)
    ecall                     # yield one tick
    j    loop
```

---

## 9. Adding & testing a strategy

1. Add an entry to `PLAYERS` in [`src/players.js`](../src/players.js) (use the
   `MMIO_EQU` names).
2. Headless checks (`npm install` once for the physics engine):
   - `node tools/test-riscv.mjs` - CPU + assembler unit tests
   - `node tools/test-arm.mjs` - arm kinematics/dynamics
   - `node tools/proto-controller.mjs` - prototype/tune a control law in JS
   - `node tools/test-engine.mjs` - full matches (control loop + real physics)

The reference controllers were prototyped in `proto-controller.mjs` (matching
the asm's integer arithmetic exactly) and transcribed to assembly.
