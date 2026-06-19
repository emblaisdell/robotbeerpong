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

// The program is a real-time joint controller: it runs every tick (ecall =
// yield to the next tick), reads the live joint sensors, and writes a motor
// torque to each joint. The ball leaves at the arm's true end-effector velocity
// when the program writes A_RELEASE. Angles are mrad, rates mrad/s, lengths mm.

// Sensor registers (read-only), refreshed every tick (noisy when drunk).
export const S_TICK     = MMIO_BASE + 0x00; // tick counter since the turn began
export const S_BEARING  = MMIO_BASE + 0x04; // mrad to the nearest live target cup
export const S_RANGE    = MMIO_BASE + 0x08; // mm, ground distance to that cup
export const S_GRAVITY  = MMIO_BASE + 0x0c; // mm/s^2
export const S_YAW      = MMIO_BASE + 0x10; // mrad, waist yaw angle
export const S_YAW_VEL  = MMIO_BASE + 0x14; // mrad/s
export const S_SHOULDER = MMIO_BASE + 0x18; // mrad, shoulder angle (0 = straight up)
export const S_SHOULDER_VEL = MMIO_BASE + 0x1c; // mrad/s
export const S_ELBOW    = MMIO_BASE + 0x20; // mrad, elbow angle (relative to upper arm)
export const S_ELBOW_VEL = MMIO_BASE + 0x24; // mrad/s
export const S_DRINKS   = MMIO_BASE + 0x28; // inebriation level (own cups lost)
export const S_CUPS     = MMIO_BASE + 0x2c; // opponent cups still standing
export const S_RNG      = MMIO_BASE + 0x30; // changing pseudo-random word
export const S_ARMLEN   = MMIO_BASE + 0x34; // mm, shoulder->tip reach (for IK)
export const S_HELD     = MMIO_BASE + 0x38; // 1 while the magnet still holds the ball

// Actuator registers (write), latched each tick.
export const A_TQ_YAW      = MMIO_BASE + 0x40; // motor torque, clamped to +/-TAU_MAX.yaw
export const A_TQ_SHOULDER = MMIO_BASE + 0x44; // ... shoulder
export const A_TQ_ELBOW    = MMIO_BASE + 0x48; // ... elbow
export const A_RELEASE     = MMIO_BASE + 0x4c; // write 1 -> magnet lets go of the ball
export const A_LOG         = MMIO_BASE + 0x50; // write a value -> debug log

// Control-loop timing + per-tick instruction budget.
export const CTRL = {
  hz: 240,
  dt: 1 / 240,
  maxTicks: 900,        // ~3.75 s to wind up and release, else the turn fizzles
  perTickBudget: 6000,  // max instructions per tick (then forced yield)
};

// --- Physics -----------------------------------------------------------------
// Tuned so throws arc nicely across the court and land in cups. Gravity is
// exposed to players via S_GRAVITY for honest ballistics.
export const GRAVITY = 26;            // world units / s^2 (downward)
export const BALL_RADIUS = 0.45;      // world units (ball.glb is ~radius 0.45)
export const LAUNCH_HEIGHT = 17;      // world units; matches the magnet tip where
                                      // the ball is held, so release is seamless

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
  backstopInset: 8,     // world units in front of each robot; sim ends at this z-plane
};

// Rigid-body cup model. Each cup is a dynamic compound collider that matches
// the fitted cup mesh: a solid base, a flat inner floor the ball rests on, and
// a ring of wall boxes forming the open cone. Dimensions are world units for a
// cup fitted to height (cupMouthHeight + 0.4) — see view.js _fitAndGround.
export const CUP_PHYS = {
  rimY: 2.55,          // rim height (open top)
  floorY: 1.25,        // inner cavity floor height (ball rests here)
  innerR: 0.95,        // cavity (inner wall) radius
  outerR: 1.45,        // rim outer radius (matches the mesh rim)
  baseR: 0.78,         // foot radius of the solid lower body
  wallSegments: 12,    // boxes around the wall ring
  mass: 0.05,          // light plastic cup
  linearDamping: 0.4,
  angularDamping: 0.5,
};

// Ball rigid body (a ping-pong ball: light + lively).
export const BALL_PHYS = {
  mass: 0.008,
  restitution: 0.55,   // bounce off rims/table
  friction: 0.35,
};

// Contact tuning + when a ball counts as "settled in a cup".
export const PHYS = {
  fixedDt: 1 / 120,    // physics step
  maxSteps: 1200,      // ~10 s guard per throw
  restSpeed: 1.2,      // world u/s below which the ball is "at rest"
  restFrames: 30,      // consecutive at-rest frames -> settled
  cupRestitution: 0.3, // low, so rim shots drop in rather than bounce out
  cupFriction: 0.5,
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
