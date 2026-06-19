// Robot Beer Pong ABI for freestanding C — the memory-mapped registers and the
// per-tick yield, matching src/constants.js. Include this, talk to the robot
// through ordinary volatile loads/stores. No libc, no startup: see player.c.
#ifndef ROBOT_H
#define ROBOT_H

#include <stdint.h>

#define MMIO_BASE 0x10000u
#define REG(off) (*(volatile int32_t *)(MMIO_BASE + (off)))

// ---- sensors (read) ----
#define S_TICK         REG(0x00)  // tick counter since the turn began
#define S_BEARING      REG(0x04)  // mrad to the nearest live target cup
#define S_RANGE        REG(0x08)  // mm to that cup
#define S_GRAVITY      REG(0x0c)  // mm/s^2
#define S_YAW          REG(0x10)  // mrad waist yaw
#define S_YAW_VEL      REG(0x14)  // mrad/s
#define S_SHOULDER     REG(0x18)  // mrad shoulder angle (0 = straight up)
#define S_SHOULDER_VEL REG(0x1c)  // mrad/s
#define S_ELBOW        REG(0x20)  // mrad elbow angle
#define S_ELBOW_VEL    REG(0x24)  // mrad/s
#define S_DRINKS       REG(0x28)  // inebriation level
#define S_CUPS         REG(0x2c)  // opponent cups still standing
#define S_RNG          REG(0x30)  // fresh pseudo-random word each read
#define S_ARMLEN       REG(0x34)  // mm shoulder->tip reach (for IK)
#define S_HELD         REG(0x38)  // 1 while the magnet still holds the ball

// ---- actuators (write) ----
#define A_TQ_YAW       REG(0x40)  // motor torque, clamped
#define A_TQ_SHOULDER  REG(0x44)
#define A_TQ_ELBOW     REG(0x48)
#define A_RELEASE      REG(0x4c)  // write 1 -> let go of the ball
#define A_LOG          REG(0x50)  // debug log

// End this control tick; execution resumes at the next instruction next tick,
// with all registers/state intact. The "memory" clobber keeps the compiler
// from reordering MMIO accesses across the yield.
static inline void robot_yield(void) {
    __asm__ volatile("ecall" ::: "memory");
}

#endif // ROBOT_H
