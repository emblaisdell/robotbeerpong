//! A Robot Beer Pong player in real, freestanding Rust.
//!
//! Built with the actual `rustc` for the `riscv32im-unknown-none-elf` target
//! (no_std, no runtime), linked with rust's bundled lld, then `llvm-objcopy`'d
//! to a flat binary the simulator loads at address 0. See build.sh / README.md.
//!
//! Same control law as the built-in Lobber: linear tip-speed model + a PD swing
//! with an elbow whip. `ecall` (the `yield_tick` below) ends each 240 Hz tick;
//! registers persist across it, so an ordinary `loop {}` *is* the control loop.

#![no_std]
#![no_main]

use core::panic::PanicInfo;
use core::ptr::{read_volatile, write_volatile};

// ---- robot ABI: memory-mapped registers (see src/constants.js) ----
const MMIO: usize = 0x1_0000;
const S_BEARING: usize = 0x04;
const S_RANGE: usize = 0x08;
const S_YAW: usize = 0x10;
const S_YAW_VEL: usize = 0x14;
const S_SHOULDER: usize = 0x18;
const S_SHOULDER_VEL: usize = 0x1c;
const S_ELBOW: usize = 0x20;
const S_ELBOW_VEL: usize = 0x24;
const A_TQ_YAW: usize = 0x40;
const A_TQ_SHOULDER: usize = 0x44;
const A_TQ_ELBOW: usize = 0x48;
const A_RELEASE: usize = 0x4c;

#[inline(always)]
fn rd(off: usize) -> i32 {
    unsafe { read_volatile((MMIO + off) as *const i32) }
}
#[inline(always)]
fn wr(off: usize, v: i32) {
    unsafe { write_volatile((MMIO + off) as *mut i32, v) }
}
/// End this control tick; resume at the next instruction next tick.
#[inline(always)]
fn yield_tick() {
    unsafe { core::arch::asm!("ecall", options(nomem, nostack, preserves_flags)) }
}

const WINDBACK: i32 = -1450;
const RELEASE_ANGLE: i32 = -785;
const ELBOW_COCK: i32 = 1100;

#[no_mangle]
#[link_section = ".text.start"] // keep _start physically first (entry is pc=0)
pub extern "C" fn _start() -> ! {
    let range = rd(S_RANGE);
    let yaw_target = rd(S_BEARING);
    // Lobber's linear tip-speed model: no sqrt needed.
    let wstar = range * 294 / 1000 + 1374;
    let mut phase: i32 = 0;

    loop {
        // ---- yaw: PD to the bearing ----
        let yaw = rd(S_YAW);
        let yawv = rd(S_YAW_VEL);
        wr(A_TQ_YAW, ((yaw_target - yaw) * 200 - yawv * 40) / 1000);

        // ---- elbow whip: cock to ELBOW_COCK in phase 0, else straighten ----
        let et = if phase == 0 { ELBOW_COCK } else { 0 };
        let el = rd(S_ELBOW);
        let elv = rd(S_ELBOW_VEL);
        wr(A_TQ_ELBOW, ((et - el) * 220 - elv * 40) / 1000);

        // ---- shoulder: wind back, swing, release, follow through ----
        let sh = rd(S_SHOULDER);
        let shv = rd(S_SHOULDER_VEL);
        let st;
        if phase == 0 {
            st = ((WINDBACK - sh) * 260 - shv * 50) / 1000;
            // advance only when wound back AND the shoulder has settled
            if sh <= WINDBACK + 120 && shv <= 250 && shv >= -250 {
                phase = 1;
            }
        } else if phase == 1 {
            st = (wstar - shv) * 120 / 1000;
            if sh >= RELEASE_ANGLE && shv > 0 {
                wr(A_RELEASE, 1);
                phase = 2;
            }
        } else {
            // follow-through: ease the shoulder back toward a ready pose
            st = ((0 - sh) * 200 - shv * 40) / 1000;
        }
        wr(A_TQ_SHOULDER, st);

        yield_tick();
    }
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}
