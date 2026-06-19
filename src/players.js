// Candidate RISC-V "players" — now real-time joint controllers.
//
// Each program is RV32IM assembly that runs every tick (240 Hz). `ecall` yields
// to the next tick; registers persist across ticks, so the program is one long
// control loop. Each tick it reads the live joint sensors (angle + angular
// velocity, noisy when drunk) and writes a motor torque to each joint. When it
// writes A_RELEASE the magnet lets go and the ball leaves at the arm's true
// end-effector velocity — the swing *is* the throw.
//
// The shared control law:
//   once:  v = target tip speed for the range; wstar = v*1000/armlen (the
//          inverse-kinematics map from tip speed to shoulder angular velocity,
//          for a straight arm); yawTarget = bearing.
//   tick:  yaw  -> PD to yawTarget      elbow -> PD to 0 (keep arm straight)
//          shoulder: phase 0 wind back to WINDBACK, phase 1 drive angular
//          velocity to +wstar and RELEASE as it swings up through RELEASE_ANGLE
//          (which makes the tip velocity point up-forward at ~45°).
// Tuned in tools/proto-controller.mjs, then transcribed here.

import {
  S_TICK, S_BEARING, S_RANGE, S_GRAVITY, S_YAW, S_YAW_VEL, S_SHOULDER,
  S_SHOULDER_VEL, S_ELBOW, S_ELBOW_VEL, S_DRINKS, S_CUPS, S_RNG, S_ARMLEN, S_HELD,
  A_TQ_YAW, A_TQ_SHOULDER, A_TQ_ELBOW, A_RELEASE, A_LOG,
} from './constants.js';

export const MMIO_EQU = {
  S_TICK, S_BEARING, S_RANGE, S_GRAVITY, S_YAW, S_YAW_VEL, S_SHOULDER,
  S_SHOULDER_VEL, S_ELBOW, S_ELBOW_VEL, S_DRINKS, S_CUPS, S_RNG, S_ARMLEN, S_HELD,
  A_TQ_YAW, A_TQ_SHOULDER, A_TQ_ELBOW, A_RELEASE, A_LOG,
};

const WINDBACK = -1450;     // mrad: how far back the shoulder cocks
const RELEASE_ANGLE = -785; // mrad: release as the shoulder swings up through here
const ELBOW_COCK = 1100;    // mrad: elbow bend during wind-up (whip), straight by release

// Integer isqrt(a0) -> a0, clobbering a3,a4,a5. (Bit-by-bit.)
const ISQRT = `
    li   a3, 0
    li   a4, 0x40000000
iscan:
    bgtu a4, a0, ishift
    j    ibody
ishift:
    srli a4, a4, 2
    bnez a4, iscan
ibody:
    beqz a4, idone
    add  a5, a3, a4
    bgtu a5, a0, ilow
    sub  a0, a0, a5
    srli a3, a3, 1
    add  a3, a3, a4
    j    inext
ilow:
    srli a3, a3, 1
inext:
    srli a4, a4, 2
    j    ibody
idone:
    mv   a0, a3
`;

// The shared per-tick control loop. Expects s0=phase, s1=wstar, s2=yawTarget.
const LOOP = `
loop:
    # ---- yaw: PD to yawTarget ----
    li   t0, S_YAW
    lw   t1, 0(t0)
    li   t0, S_YAW_VEL
    lw   t2, 0(t0)
    sub  t3, s2, t1
    li   t4, 200
    mul  t3, t3, t4
    li   t4, 40
    mul  t5, t2, t4
    sub  t3, t3, t5
    li   t4, 1000
    div  t3, t3, t4
    li   t0, A_TQ_YAW
    sw   t3, 0(t0)

    # ---- elbow whip: PD to ELBOW_COCK while winding up (phase 0), else to 0,
    #      so the elbow bends back then snaps straight by release ----
    li   t6, 0
    bnez s0, elpd            # phase != 0 -> target straight
    li   t6, ${ELBOW_COCK}   # phase 0 -> cock the elbow back
elpd:
    li   t0, S_ELBOW
    lw   t1, 0(t0)
    sub  t1, t6, t1          # target - elbow
    li   t4, 220
    mul  t3, t1, t4
    li   t0, S_ELBOW_VEL
    lw   t2, 0(t0)
    li   t4, 40
    mul  t5, t2, t4
    sub  t3, t3, t5
    li   t4, 1000
    div  t3, t3, t4
    li   t0, A_TQ_ELBOW
    sw   t3, 0(t0)

    # ---- shoulder: phase machine ----
    li   t0, S_SHOULDER
    lw   a1, 0(t0)          # sh
    li   t0, S_SHOULDER_VEL
    lw   a2, 0(t0)          # shv
    bnez s0, ph1check

    # phase 0: wind back, PD to WINDBACK
    li   t4, ${WINDBACK}
    sub  t3, t4, a1
    li   t5, 260
    mul  t3, t3, t5
    li   t5, 50
    mul  t6, a2, t5
    sub  t3, t3, t6
    li   t5, 1000
    div  t3, t3, t5
    li   t5, ${WINDBACK + 120}
    bgt  a1, t5, shwrite    # sh > target -> not wound back enough, stay
    li   s0, 1              # -> swing phase
    j    shwrite

ph1check:
    li   t4, 2
    beq  s0, t4, ph2        # done

    # phase 1: drive shoulder angular velocity toward +wstar
    sub  t3, s1, a2
    li   t5, 120
    mul  t3, t3, t5
    li   t5, 1000
    div  t3, t3, t5
    # release once swinging up through RELEASE_ANGLE
    li   t5, ${RELEASE_ANGLE}
    blt  a1, t5, shwrite    # shoulder not yet up to release angle
    blez a2, shwrite        # not swinging forward yet
    li   t0, A_RELEASE
    li   t5, 1
    sw   t5, 0(t0)
    li   s0, 2
    j    shwrite

ph2:
    # released: momentum carries the arm forward (follow-through), then this PD
    # eases the shoulder back to the ready pose (0) so the next turn is clean.
    li   t4, 0
    sub  t4, t4, a1
    li   t5, 200
    mul  t3, t4, t5
    li   t5, 60
    mul  t6, a2, t5
    sub  t3, t3, t6
    li   t5, 1000
    div  t3, t3, t5

shwrite:
    li   t0, A_TQ_SHOULDER
    sw   t3, 0(t0)
    ecall                   # yield one tick
    j    loop
`;

// SNIPER — honest inverse ballistics: v = isqrt(g*range*1830/1000). The 1830
// factor (vs the ~1020 of a flat lob) puts the tip speed high enough that the
// arc clears the front cups and drops *directly* into the target at ~40°.
const SNIPER = `
start:
    li   t0, S_RANGE
    lw   s4, 0(t0)
    li   t0, S_GRAVITY
    lw   s5, 0(t0)
    li   t0, S_ARMLEN
    lw   s6, 0(t0)
    li   t0, S_BEARING
    lw   s2, 0(t0)          # yawTarget = bearing

    li   t1, 1830
    mul  a0, s4, t1
    li   t1, 1000
    div  a0, a0, t1
    mul  a0, a0, s5         # a0 = g*range*1080/1000
${ISQRT}
    li   t1, 1000
    mul  a0, a0, t1
    div  s1, a0, s6         # wstar = v*1000/armlen
    li   s0, 0
${LOOP}
`;

// LOBBER — cheap linear tip-speed model (no sqrt): wstar = range*392/1000 + 1847.
// A linear fit to Sniper's direct-arc target ang-velocities (no isqrt needed).
const LOBBER = `
start:
    li   t0, S_RANGE
    lw   s4, 0(t0)
    li   t0, S_BEARING
    lw   s2, 0(t0)
    li   t1, 392
    mul  a0, s4, t1
    li   t1, 1000
    div  a0, a0, t1
    li   t1, 1847
    add  s1, a0, t1         # wstar (linear)
    li   s0, 0
${LOOP}
`;

// YOLO — fixed swing speed, aims dead ahead with a little random jitter.
const YOLO = `
start:
    li   t0, S_RNG
    lw   t1, 0(t0)
    andi t1, t1, 255
    addi s2, t1, -128       # yawTarget = -128..127 mrad jitter
    li   s1, 2780           # fixed wstar (lobs short of a clean direct arc)
    li   s0, 0
${LOOP}
`;

export const PLAYERS = [
  { id: 'sniper', name: 'Sniper', blurb: 'Inverse ballistics + PD swing control. Precise — and precision is fragile.', source: SNIPER },
  { id: 'lobber', name: 'Lobber', blurb: 'Linear tip-speed model, same PD swing. Pragmatic and sturdy.', source: LOBBER },
  { id: 'yolo', name: 'YOLO', blurb: 'Fixed swing speed, random aim. Pure chaos when drunk.', source: YOLO },
];

export function getPlayer(id) {
  return PLAYERS.find((p) => p.id === id) || PLAYERS[0];
}

// A complete, working controller used as the default in the "Custom" editor —
// the same control law as Lobber, written out flat and commented so it's an
// easy base to edit. Full ABI + an explanation: docs/robot-isa.md.
export const STARTER = `# Custom robot — a real-time joint controller (RV32IM).
#
# Runs every tick (240 Hz). 'ecall' yields to the next tick; registers persist,
# so this is one long control loop. Each tick: read the joint sensors, write a
# motor torque to each joint; write A_RELEASE to let go of the ball, which then
# leaves at the arm's true end-effector velocity. Reference: docs/robot-isa.md
#
# This one aims at the nearest cup and picks a swing speed from the range, then
# winds the shoulder back, swings, and releases at ~45 degrees. EDIT IT.

start:
    li   t0, S_BEARING
    lw   s2, 0(t0)          # s2 = yaw target = bearing to the nearest cup

    li   t0, S_RANGE        # pick shoulder swing speed from the range (linear):
    lw   t1, 0(t0)          #   wstar = range*392/1000 + 1847   (mrad/s)
    li   t3, 392
    mul  t1, t1, t3
    li   t3, 1000
    div  t1, t1, t3
    li   t3, 1847
    add  s1, t1, t3         # s1 = target shoulder angular velocity

    li   s0, 0              # s0 = phase: 0 wind back, 1 swing, 2 follow through

loop:
    # ---- yaw: PD toward the cup bearing ----
    li   t0, S_YAW
    lw   t1, 0(t0)
    li   t0, S_YAW_VEL
    lw   t2, 0(t0)
    sub  t3, s2, t1
    li   t4, 200
    mul  t3, t3, t4
    li   t4, 40
    mul  t5, t2, t4
    sub  t3, t3, t5
    li   t4, 1000
    div  t3, t3, t4
    li   t0, A_TQ_YAW
    sw   t3, 0(t0)

    # ---- elbow whip: cock back (1100) while winding up, else straighten ----
    li   t6, 0
    bnez s0, elpd
    li   t6, 1100
elpd:
    li   t0, S_ELBOW
    lw   t1, 0(t0)
    sub  t1, t6, t1
    li   t4, 220
    mul  t3, t1, t4
    li   t0, S_ELBOW_VEL
    lw   t2, 0(t0)
    li   t4, 40
    mul  t5, t2, t4
    sub  t3, t3, t5
    li   t4, 1000
    div  t3, t3, t4
    li   t0, A_TQ_ELBOW
    sw   t3, 0(t0)

    # ---- shoulder: wind back, swing, release ----
    li   t0, S_SHOULDER
    lw   a1, 0(t0)
    li   t0, S_SHOULDER_VEL
    lw   a2, 0(t0)
    bnez s0, swing

    li   t4, -1450          # phase 0: wind back to -1450 mrad
    sub  t3, t4, a1
    li   t5, 260
    mul  t3, t3, t5
    li   t5, 50
    mul  t6, a2, t5
    sub  t3, t3, t6
    li   t5, 1000
    div  t3, t3, t5
    li   t5, -1330
    bgt  a1, t5, write
    li   s0, 1
    j    write

swing:
    li   t4, 2
    beq  s0, t4, follow
    sub  t3, s1, a2          # phase 1: drive shoulder velocity to +s1
    li   t5, 120
    mul  t3, t3, t5
    li   t5, 1000
    div  t3, t3, t5
    li   t5, -785            # release as it swings up through -785 mrad
    blt  a1, t5, write
    blez a2, write
    li   t0, A_RELEASE
    li   t5, 1
    sw   t5, 0(t0)
    li   s0, 2
    j    write

follow:
    li   t3, 0              # phase 2: motor off, follow through

write:
    li   t0, A_TQ_SHOULDER
    sw   t3, 0(t0)
    ecall
    j    loop
`;
