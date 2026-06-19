# Robot beer pong

// WIP description details to come

I want a fun whimsical LLM benchmark.

We simulate bare-metal robot arms running RISC-V (simulated with QEMU).  This includes actuators and angle/angular velocity sensor.  I want this to be realistic but fun.

These two robots are programmed ahead of time (by a coding LLM) and play beer pong against each other.

Each 'drink' comes with some penalty (simulating inebriation)
- Sensor readings have increased error
- Actuation lags
- Over- or under-actuation
- Segments of memory are corrupted
- Random bytes are corrupted

The exact types and magnitudes are tuned so that complete failure is avoidable and the final motion is comedic.

## For now

For now, the game should be a browser 3D JS game based on the models in web-models.

For now, you (the LLM) should just write a few candidate RISC-V "players"/"strategies" to start.

---

## Running it

It's a zero-build browser game (Three.js loads from a CDN via an import map).
You just need any static file server so the `.glb` models and ES modules load
over HTTP:

```sh
python3 -m http.server 8099
# then open http://localhost:8099/
```

Pick a strategy for each robot, hit **▶ Play match**, and watch. Drag to orbit,
scroll to zoom. **Step** advances one throw at a time; the speed buttons scale
the animation.

## What's here / design decisions

**No QEMU - a real RV32IM interpreter in the browser instead.** QEMU is a
full-system emulator and can't run natively in a tab; but the part the game
actually needs is small - a CPU that executes the players' machine code and
talks to the robot through memory-mapped registers. So `src/riscv.js` is a
faithful RV32I + M (multiply/divide) core plus a small assembler. Each player's
*real machine code* is executed instruction-by-instruction, looping every
control tick (`ecall` yields to the next tick). (A future QEMU-fidelity path
would be a WASM RISC-V core running gcc-built ELFs - not needed to play.)

**The robot is bare-metal - and the program is a real-time controller.** Players
don't issue a high-level "throw" command. They run a control loop: every tick
(240 Hz) the program reads the live joint sensors (angles + angular velocities)
and writes a **motor torque** to each joint (`src/arm.js` integrates the arm
dynamics - inertia, gravity, damping, limits). `ecall` yields one tick; registers
persist across ticks, so the program *is* the loop. When it writes `A_RELEASE`,
the ball leaves at the arm's **true end-effector velocity** - the swing is the
throw, computed by forward kinematics from the joint motion. The arm keeps
simulating afterward (follow-through) and is continuous across turns.

| Sensors (read each tick) | | Actuators (write) | |
|---|---|---|---|
| `S_SHOULDER` / `S_SHOULDER_VEL` | joint angle + rate | `A_TQ_SHOULDER` | shoulder motor torque |
| `S_ELBOW` / `S_ELBOW_VEL`, `S_YAW`/… | the other joints | `A_TQ_ELBOW`, `A_TQ_YAW` | elbow / waist torque |
| `S_BEARING`, `S_RANGE`, `S_GRAVITY`, `S_ARMLEN` | for inverse kinematics | `A_RELEASE` | let go of the ball |

The ABI lives in `src/constants.js` (single source of truth for both the asm and
the sim), and is documented for player authors in
[docs/robot-isa.md](docs/robot-isa.md).

**Inebriation.** You score by sinking your *opponent's* cups, which makes the
*opponent* drink - so the loser snowballs. Drinks (in `src/engine.js`) corrupt
sensor reads (noise on every joint reading), actuation (torque scale + bias +
*lag*), and program memory (byte flips that can crash the controller mid-swing).
Tuned so total failure is rare and the misfires are comedic.

## The candidate players (`src/players.js`)

All three share a PD swing controller (wind back → drive shoulder angular
velocity → release at the launch angle, with an elbow whip). They differ in how
they pick the target speed:

- **Sniper** - honest inverse ballistics: `isqrt(g·range·k)` → target tip speed →
  shoulder angular velocity via the Jacobian. Precise; the sensor/torque noise
  wrecks its release timing.
- **Lobber** - a cheap linear tip-speed model (no sqrt). Sturdy and pragmatic.
- **YOLO** - fixed swing speed, random aim. The control group; chaotic once drunk.

Sniper and Lobber throw **direct** - a high arc that clears the front cups and
drops straight in, no bank shot (YOLO lobs shorter and scatters). That's the
hard way: the landing window for a full-table throw into a cup mouth is tiny, so
even sober they sink ~3-4 of 6 and miss the rest. The misses are the point - you
score by sinking the *opponent's* cups, the loser drinks and gets shakier, and
the snowball resolves every match (verified: all pairings terminate). Sniper's
tighter ballistics beat Lobber head-to-head.

## Layout

```
index.html            UI shell + Three.js import map
src/constants.js      MMIO ABI, court layout, fixed-point units
src/riscv.js          RV32IM interpreter + assembler (ecall = yield a tick)
src/players.js        the candidate RISC-V joint controllers (assembly)
src/arm.js            torque-driven 3-joint arm dynamics + forward kinematics
src/physics.js        court geometry + bearing/range helpers
src/cupworld.js       rigid-body world (cannon-es): cup colliders + ball
src/engine.js         per-tick control loop + arm dynamics + ball physics + scoring
src/view.js           Three.js scene; replays the recorded joint/ball timeline
src/main.js           UI wiring + render loop
tools/                node test + tuning harnesses (no browser needed)
```

The browser needs no install (Three.js and cannon-es load from a CDN). The
headless Node checks need the physics engine locally, so run `npm install` once,
then:

```sh
node tools/test-riscv.mjs        # CPU + assembler unit tests
node tools/test-arm.mjs          # arm kinematics + dynamics
node tools/proto-controller.mjs  # prototype/tune a control law (matches the asm)
node tools/test-engine.mjs       # full matches: control loop + real physics
```
