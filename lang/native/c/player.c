// A Robot Beer Pong player in real, freestanding C.
//
// Built with a real RISC-V C compiler (clang --target=riscv32 or
// riscv64-unknown-elf-gcc), linked freestanding, then objcopy'd to a flat
// binary the simulator loads at address 0. See build.sh / README.md.
//
// Same control law as the built-in Lobber (and the Rust sibling): a linear
// tip-speed model plus a PD swing with an elbow whip. The robot ABI lives in
// robot.h. `robot_yield()` (ecall) ends each 240 Hz tick; registers persist
// across it, so a plain for(;;) loop is the whole control loop.

#include "robot.h"

#define WINDBACK      (-1450)
#define RELEASE_ANGLE (-785)
#define ELBOW_COCK    (1100)

// _start must be physically first: the CPU begins at pc = 0 and ignores any ELF
// entry point. The linker script keeps the .text.start section at offset 0.
__attribute__((section(".text.start"), used, noreturn))
void _start(void) {
    int range = S_RANGE;
    int yaw_target = S_BEARING;
    // Lobber's linear tip-speed model: no sqrt.
    int wstar = range * 294 / 1000 + 1374;
    int phase = 0;

    for (;;) {
        // ---- yaw: PD to the bearing ----
        int yaw = S_YAW;
        int yawv = S_YAW_VEL;
        A_TQ_YAW = ((yaw_target - yaw) * 200 - yawv * 40) / 1000;

        // ---- elbow whip: cock to ELBOW_COCK in phase 0, else straighten ----
        int et = (phase == 0) ? ELBOW_COCK : 0;
        int el = S_ELBOW;
        int elv = S_ELBOW_VEL;
        A_TQ_ELBOW = ((et - el) * 220 - elv * 40) / 1000;

        // ---- shoulder: wind back, swing, release, follow through ----
        int sh = S_SHOULDER;
        int shv = S_SHOULDER_VEL;
        int st;
        if (phase == 0) {
            st = ((WINDBACK - sh) * 260 - shv * 50) / 1000;
            // advance only when wound back AND the shoulder has settled
            if (sh <= WINDBACK + 120 && shv <= 250 && shv >= -250) phase = 1;
        } else if (phase == 1) {
            st = (wstar - shv) * 120 / 1000;
            if (sh >= RELEASE_ANGLE && shv > 0) {
                A_RELEASE = 1;
                phase = 2;
            }
        } else {
            // follow-through: ease the shoulder back toward a ready pose
            st = ((0 - sh) * 200 - shv * 40) / 1000;
        }
        A_TQ_SHOULDER = st;

        robot_yield();
    }
}
