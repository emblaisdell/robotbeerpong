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

**No QEMU — a real RV32IM interpreter in the browser instead.** QEMU is a
full-system emulator and can't run natively in a tab; but the part the game
actually needs is small — a CPU that executes the players' machine code and
talks to the robot through memory-mapped registers. So `src/riscv.js` is a
faithful RV32I + M (multiply/divide) core plus a small assembler. Each player's
*real machine code* is executed instruction-by-instruction every turn. (A
future QEMU-fidelity path would be a WASM RISC-V core running gcc-built ELFs —
not needed to play.)

**The robot is bare-metal.** Players are integer-only RV32IM assembly. They poke
hardware registers (memory-mapped IO) for sensors and actuators — exactly how a
real bare-metal robot would:

| Sensors (read) | | Actuators (write) | |
|---|---|---|---|
| `S_BEARING` | mrad to nearest live cup | `A_YAW` | commanded waist yaw |
| `S_RANGE` | mm to that cup | `A_PITCH` | arm elevation |
| `S_GRAVITY` | mm/s² (for ballistics) | `A_POWER` | launch speed (mm/s) |
| `S_DRINKS`, `S_RNG`, `S_CUPS`, … | | `A_FIRE` | store 1 → throw |

The ABI lives in `src/constants.js` (single source of truth for both the asm and
the sim).

**Inebriation.** You score by sinking your *opponent's* cups, which makes the
*opponent* drink — so the loser snowballs. Drinks (in `src/engine.js`) corrupt
sensor reads (noise), actuation (over/under-actuation + aim bias), and program
memory (random byte flips that can make the program crash and *fumble* the
ball). Tuned so total failure is rare and the misfires are comedic.

## The candidate players (`src/players.js`)

- **Sniper** — honest ballistics: aims at the true bearing and solves for launch
  speed with an integer `isqrt`. Deadly sober; its precision is what the noise
  wrecks.
- **Lobber** — a cheap linear power model (no sqrt). Sturdy and pragmatic.
- **YOLO** — fixed power, random jitter, basically ignores its sensors. The
  control group; gloriously chaotic once drunk.

Both Sniper and Lobber clear a 6-cup rack in 6 throws when sober (verified).

## Layout

```
index.html            UI shell + Three.js import map
src/constants.js      MMIO ABI, court layout, fixed-point units
src/riscv.js          RV32IM interpreter + assembler
src/players.js        the candidate RISC-V strategies (assembly)
src/physics.js        pure ballistics + court geometry
src/engine.js         headless match engine + inebriation penalties
src/view.js           Three.js scene, model loading, animation
src/main.js           UI wiring + render loop
tools/                node test + calibration harnesses (no browser needed)
```

Run the headless checks with:

```sh
node tools/test-riscv.mjs    # CPU + assembler unit tests
node tools/test-engine.mjs   # full matches, sober accuracy, termination
node tools/calibrate.mjs     # re-derive the ballistics constant
```
