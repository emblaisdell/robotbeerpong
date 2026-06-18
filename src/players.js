// Candidate RISC-V "players" for Robot Beer Pong.
//
// Each strategy is real RV32IM assembly that the in-browser CPU executes every
// turn. It reads the robot's sensors (bearing/range to the nearest live cup,
// gravity, drinks, a noise word) from memory-mapped registers, decides on a
// throw, writes the actuators, and pulls the trigger by storing 1 to A_FIRE.
//
// The strategies differ in *how* they aim, which makes the inebriation handicap
// play out differently for each — exactly the kind of comparison the benchmark
// is meant to surface.

import {
  S_BEARING, S_RANGE, S_DRINKS, S_YAW, S_PITCH, S_GRAVITY, S_RNG, S_CUPS,
  A_YAW, A_PITCH, A_POWER, A_FIRE, A_LOG,
} from './constants.js';

// Symbol table handed to the assembler so the asm can use the ABI names.
export const MMIO_EQU = {
  S_BEARING, S_RANGE, S_DRINKS, S_YAW, S_PITCH, S_GRAVITY, S_RNG, S_CUPS,
  A_YAW, A_PITCH, A_POWER, A_FIRE, A_LOG,
};

// Shared throw-pitch (~45°, the calibrated angle) in milliradians.
const PITCH = 785;

// ---------------------------------------------------------------------------
// 1) SNIPER — honest ballistics.
// Aims straight at the nearest cup's bearing and solves for launch speed:
//   v = isqrt( g * range * 0.775 )     (the 0.775 folds in the launch-height
// correction found by tools/calibrate.mjs). Integer sqrt is done bit-by-bit.
// Deadly when sober; its precision is exactly what inebriation noise wrecks.
// ---------------------------------------------------------------------------
const SNIPER = `
start:
    li   t0, S_BEARING
    lw   s1, 0(t0)          # s1 = bearing (mrad)
    li   t0, S_RANGE
    lw   s2, 0(t0)          # s2 = range (mm)
    li   t0, S_GRAVITY
    lw   s3, 0(t0)          # s3 = gravity (mm/s^2)

    # a0 = g * range * 775 / 1000   (ordered to avoid 32-bit overflow)
    li   t1, 775
    mul  a0, s2, t1
    li   t1, 1000
    div  a0, a0, t1
    mul  a0, a0, s3

    # a0 = isqrt(a0)
    li   a1, 0              # result
    li   a2, 0x40000000    # bit
scan:
    bgtu a2, a0, shift
    j    body
shift:
    srli a2, a2, 2
    bnez a2, scan
body:
    beqz a2, done
    add  a3, a1, a2
    bgtu a3, a0, lower
    sub  a0, a0, a3
    srli a1, a1, 1
    add  a1, a1, a2
    j    next
lower:
    srli a1, a1, 1
next:
    srli a2, a2, 2
    j    body
done:
    mv   s4, a1            # s4 = power (mm/s)

    li   t0, A_YAW
    sw   s1, 0(t0)         # aim at the cup
    li   t0, A_PITCH
    li   t1, ${PITCH}
    sw   t1, 0(t0)
    li   t0, A_POWER
    sw   s4, 0(t0)
    li   t0, A_FIRE
    li   t1, 1
    sw   t1, 0(t0)         # throw
    ecall
`;

// ---------------------------------------------------------------------------
// 2) LOBBER — cheap linear model.
// No sqrt: approximates launch speed with a straight line fit to the rack,
//   v = range * 394/1000 + 1277.
// Accurate near the middle of the rack, a touch off at the extremes — a
// pragmatic engineer's robot. Still aims at the true bearing.
// ---------------------------------------------------------------------------
const LOBBER = `
start:
    li   t0, S_BEARING
    lw   s1, 0(t0)
    li   t0, S_RANGE
    lw   s2, 0(t0)

    li   t1, 394
    mul  a0, s2, t1
    li   t1, 1000
    div  a0, a0, t1
    li   t1, 1277
    add  a0, a0, t1        # a0 = power

    li   t0, A_YAW
    sw   s1, 0(t0)
    li   t0, A_PITCH
    li   t1, ${PITCH}
    sw   t1, 0(t0)
    li   t0, A_POWER
    sw   a0, 0(t0)
    li   t0, A_FIRE
    li   t1, 1
    sw   t1, 0(t0)
    ecall
`;

// ---------------------------------------------------------------------------
// 3) YOLO — fixed power, hope and a prayer.
// Barely reads its sensors: throws roughly straight ahead with a little
// random jitter and a constant mid-rack power. Surprisingly okay against the
// front cups, gloriously chaotic once drunk. The control group.
// ---------------------------------------------------------------------------
const YOLO = `
start:
    li   t0, S_RNG
    lw   a0, 0(t0)
    andi a0, a0, 127       # 0..127
    addi a0, a0, -64       # -64..63 mrad of jitter
    li   t0, A_YAW
    sw   a0, 0(t0)         # ~straight ahead

    li   t0, A_PITCH
    li   t1, ${PITCH}
    sw   t1, 0(t0)
    li   t0, A_POWER
    li   t1, 3120          # fixed, tuned for the middle of the rack
    sw   t1, 0(t0)
    li   t0, A_FIRE
    li   t1, 1
    sw   t1, 0(t0)
    ecall
`;

export const PLAYERS = [
  { id: 'sniper', name: 'Sniper', blurb: 'Solves ballistics with integer sqrt. Precise — and precision is fragile.', source: SNIPER },
  { id: 'lobber', name: 'Lobber', blurb: 'Linear power approximation. A pragmatic, sturdy thrower.', source: LOBBER },
  { id: 'yolo', name: 'YOLO', blurb: 'Fixed power, random jitter, no ballistics. Pure chaos when drunk.', source: YOLO },
];

export function getPlayer(id) {
  return PLAYERS.find((p) => p.id === id) || PLAYERS[0];
}
