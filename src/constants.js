// Shared constants for Robot Beer Pong.
//
// Single source of truth for the memory-mapped IO ABI (used by both the
// RISC-V players and the simulation bridge), the fixed-point conventions,
// and the court layout. Keeping these in one module guarantees the
// assembly strategies and the engine agree on addresses and units.

// --- Fixed-point conventions -------------------------------------------------
// RV32I is integer-only (bare-metal, no FPU), so the whole ABI is integers.
//   * angles   are in milliradians   (1 rad      = 1000)
//   * lengths  are in millimetres     (1 world u  = 100 mm  => 1 world unit = 1 dm)
//   * speeds   are in mm per second
// The bridge converts between these and Three.js world units / radians.
export const MM_PER_UNIT = 100;       // 1 world unit == 100 mm
export const MRAD = 1000;             // milliradians per radian
export const PI_MRAD = 3142;          // pi in milliradians (round)

// --- Memory map --------------------------------------------------------------
export const MEM_SIZE = 0x20000;      // 128 KiB of CPU memory
export const TEXT_BASE = 0x0000;      // programs are loaded here, pc starts here
export const STACK_TOP = 0x0F000;     // initial sp (grows down, below MMIO)
export const MMIO_BASE = 0x10000;     // [MMIO_BASE, MMIO_BASE+0x1000) is device space

// Sensor registers (read-only from the program's point of view).
export const S_BEARING = MMIO_BASE + 0x00; // mrad, signed, to nearest live target cup
export const S_RANGE   = MMIO_BASE + 0x04; // mm, ground distance to that cup
export const S_DRINKS  = MMIO_BASE + 0x08; // how inebriated this robot is (cups lost)
export const S_YAW     = MMIO_BASE + 0x0c; // mrad, current waist yaw (with sensor error)
export const S_PITCH   = MMIO_BASE + 0x10; // mrad, current arm pitch (with sensor error)
export const S_GRAVITY = MMIO_BASE + 0x14; // mm/s^2, gravity (so players can do ballistics)
export const S_RNG     = MMIO_BASE + 0x18; // a changing pseudo-random word
export const S_CUPS    = MMIO_BASE + 0x1c; // opponent cups still standing

// Actuator registers (write).
export const A_YAW     = MMIO_BASE + 0x20; // mrad, commanded waist yaw
export const A_PITCH   = MMIO_BASE + 0x24; // mrad, commanded arm elevation at release
export const A_POWER   = MMIO_BASE + 0x28; // mm/s, commanded launch speed
export const A_FIRE    = MMIO_BASE + 0x2c; // write 1 -> execute the throw, then halt turn
export const A_LOG     = MMIO_BASE + 0x30; // write a value -> appears in the debug log

// --- Physics -----------------------------------------------------------------
// Tuned so throws arc nicely across the court and land in cups. Gravity is
// exposed to players via S_GRAVITY for honest ballistics.
export const GRAVITY = 26;            // world units / s^2 (downward)
export const BALL_RADIUS = 0.45;      // world units (ball.glb is ~radius 0.45)
export const LAUNCH_HEIGHT = 14;      // world units, height the ball leaves the hand

// --- Court layout ------------------------------------------------------------
// A long table along +Z. Robot A stands at -Z and throws toward +Z; Robot B
// mirrors it. Each player's *own* cups sit in front of them; you score by
// sinking the *opponent's* cups, which makes the opponent drink.
export const COURT = {
  tableHalfWidth: 9,    // X half-extent of the table
  robotZ: 30,           // robots sit at +/- this Z
  cupNearZ: 14,         // nearest rack row distance from centre
  cupRowGap: 3.0,       // Z spacing between triangle rows
  cupColGap: 3.0,       // X spacing within a row
  cupScale: 0.7,        // scale applied to cup.glb
  cupCatchRadius: 1.9,  // world units; how close to cup centre counts as a sink
  cupMouthHeight: 2.2,  // world units; cup rim height above table
};

// Standard 6-cup rack (3-2-1 triangle) positions in a robot-local frame where
// +z points across the table toward the opponent. Returned as {x, z} offsets
// from the rack apex anchor. Row 0 (3 cups) is closest to the owner.
export function rackLayout() {
  const g = COURT.cupColGap, r = COURT.cupRowGap;
  return [
    { x: -g, z: 0 }, { x: 0, z: 0 }, { x: g, z: 0 },       // back row of 3
    { x: -g / 2, z: r }, { x: g / 2, z: r },               // middle row of 2
    { x: 0, z: 2 * r },                                     // front cup
  ];
}

// Turn execution budget: a player program may run at most this many
// instructions per turn before it is forcibly halted (infinite-loop guard).
export const INSTR_BUDGET = 200000;
