// The match engine. Each turn it runs the player as a real-time joint
// controller: every tick (240 Hz) it refreshes the joint sensors, runs the
// RISC-V program until it yields (ecall), reads the commanded motor torques,
// and integrates the arm dynamics. When the program writes A_RELEASE the ball
// leaves at the arm's true end-effector velocity, and the rigid-body cup
// simulation takes over. The whole turn is simulated up front and recorded as a
// timeline the view replays — deterministic and fully headless-testable.

import { assemble, CPU } from './riscv.js';
import { MMIO_EQU, getPlayer } from './players.js';
import { Arm, ARM } from './arm.js';
import { CupWorld } from './cupworld.js';
import {
  MEM_SIZE, MMIO_BASE, STACK_TOP, CTRL, PHYS, GRAVITY, MM_PER_UNIT,
  S_TICK, S_BEARING, S_RANGE, S_GRAVITY, S_YAW, S_YAW_VEL, S_SHOULDER,
  S_SHOULDER_VEL, S_ELBOW, S_ELBOW_VEL, S_DRINKS, S_CUPS, S_RNG, S_ARMLEN, S_HELD,
  A_TQ_YAW, A_TQ_SHOULDER, A_TQ_ELBOW, A_RELEASE, A_LOG,
} from './constants.js';
import { rackPositions, bearingRange, originOf } from './physics.js';

const RAD2MRAD = 1000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Robot {
  // `source` overrides the built-in program (used for the Custom editor). It may
  // throw an assembler error, which the caller surfaces to the user.
  constructor(label, side, playerId, source = null) {
    this.label = label;
    this.side = side;
    this.playerId = playerId;
    this.player = getPlayer(playerId);
    const { code } = assemble(source != null ? source : this.player.source, MMIO_EQU);
    this.code = code;
    this.cpu = new CPU({ memSize: MEM_SIZE, mmioBase: MMIO_BASE, device: null });
    this.arm = new Arm(side);
    this.cups = rackPositions(side);
    this.drinks = 0;
  }
  aliveCups() { return this.cups.filter((c) => c.alive); }
  defeated() { return this.aliveCups().length === 0; }
}

export class Match {
  constructor({ playerA = 'sniper', playerB = 'lobber', seed = 1, srcA = null, srcB = null } = {}) {
    this.rand = mulberry32((seed >>> 0) || 1);
    this.robots = { A: new Robot('A', -1, playerA, srcA), B: new Robot('B', +1, playerB, srcB) };
    this.turnIndex = 0;
    this.current = 'A';
    this.winner = null;
  }

  opponentOf(label) { return label === 'A' ? this.robots.B : this.robots.A; }
  noise(stddev) { return (this.rand() + this.rand() + this.rand() - 1.5) * stddev * 0.8165; }

  // Device backing the per-tick control ABI. Sensors read the live arm (with
  // inebriation noise); torque/release writes are captured.
  makeDevice(robot, truth, drinks) {
    const arm = robot.arm;
    const out = { tq: { yaw: 0, shoulder: 0, elbow: 0 }, release: false, logs: [] };
    const self = this;
    const aN = 6 * drinks, vN = 40 * drinks;     // angle / rate sensor noise
    return {
      captured: out,
      tick: 0,
      held: 1,
      read32(addr) {
        switch (addr) {
          case S_TICK: return this.tick;
          case S_BEARING: return Math.round(truth.bearing + self.noise(18 * drinks));
          case S_RANGE: return Math.max(1, Math.round(truth.range + self.noise(90 * drinks)));
          case S_GRAVITY: return GRAVITY * MM_PER_UNIT;
          case S_YAW: return Math.round(arm.yaw.a * RAD2MRAD + self.noise(aN));
          case S_YAW_VEL: return Math.round(arm.yaw.w * RAD2MRAD + self.noise(vN));
          case S_SHOULDER: return Math.round(arm.shoulder.a * RAD2MRAD + self.noise(aN));
          case S_SHOULDER_VEL: return Math.round(arm.shoulder.w * RAD2MRAD + self.noise(vN));
          case S_ELBOW: return Math.round(arm.elbow.a * RAD2MRAD + self.noise(aN));
          case S_ELBOW_VEL: return Math.round(arm.elbow.w * RAD2MRAD + self.noise(vN));
          case S_DRINKS: return drinks;
          case S_CUPS: return self.opponentOf(robot.label).aliveCups().length;
          case S_RNG: return (self.rand() * 0xffffffff) | 0;
          case S_ARMLEN: return Math.round((ARM.L1 + ARM.L2) * MM_PER_UNIT);
          case S_HELD: return this.held;
          default: return 0;
        }
      },
      write32(addr, value) {
        switch (addr) {
          case A_TQ_YAW: out.tq.yaw = value | 0; break;
          case A_TQ_SHOULDER: out.tq.shoulder = value | 0; break;
          case A_TQ_ELBOW: out.tq.elbow = value | 0; break;
          case A_RELEASE: if (value) out.release = true; break;
          case A_LOG: out.logs.push(value | 0); break;
        }
      },
    };
  }

  // Scribble on the program image to model corrupted memory (drunk).
  corruptMemory(robot, drinks) {
    if (drinks <= 0) return 0;
    let flipped = 0;
    for (let i = 0; i < drinks; i++) {
      if (this.rand() < 0.10 * drinks) {
        robot.cpu.mem[Math.floor(this.rand() * 0x4000)] = Math.floor(this.rand() * 256);
        flipped++;
      }
    }
    return flipped;
  }

  // Simulate one whole turn (control loop + ball physics) without mutating the
  // score. Returns the timeline for the view plus the outcome.
  simulateTurn() {
    if (this.winner) return null;
    const robot = this.robots[this.current];
    const opponent = this.opponentOf(this.current);
    const drinks = robot.drinks;

    // Nearest live opponent cup (fills the bearing/range sensors).
    const base = originOf(robot.side);
    const targets = opponent.aliveCups();
    let target = targets[0], bestD = Infinity;
    for (const c of targets) {
      const d = Math.hypot(c.x - base.x, c.z - base.z);
      if (d < bestD) { bestD = d; target = c; }
    }
    const truth = bearingRange(robot.side, target);

    // The arm is NOT reset between turns — it picks up from its last pose
    // (continuous, no teleporting). Only the CPU/program is reloaded.
    robot.cpu.load(robot.code);
    const flipped = this.corruptMemory(robot, drinks);
    robot.cpu.reset(0, STACK_TOP);
    const dev = this.makeDevice(robot, truth, drinks);
    robot.cpu.device = dev;

    const armFrames = [], ballFrames = [];
    let released = false, releaseIndex = -1, settleIndex = -1, release = null, crashed = false, world = null;
    let prevTau = { yaw: 0, shoulder: 0, elbow: 0 };
    let ballAccum = 0;
    const lagAlpha = 1 / (1 + 0.35 * drinks); // drunk -> laggier actuation
    const POST = 1000;                        // max ticks after release (flight ~2.6s + settle + follow-through)

    for (let tick = 0; tick < CTRL.maxTicks + POST; tick++) {
      if (!released && tick >= CTRL.maxTicks) break; // never fired -> fizzle

      dev.tick = tick;
      robot.cpu.yielded = false;
      robot.cpu.run(CTRL.perTickBudget);
      if (robot.cpu.halted) { crashed = true; break; } // crashed -> arm goes limp

      // Actuation handicap: scale error + bias + lag, all worse when drunk.
      const cmd = dev.captured.tq;
      const tau = {};
      for (const k of ['yaw', 'shoulder', 'elbow']) {
        const target = cmd[k] * (1 + this.noise(0.05 * drinks)) + this.noise(10 * drinks);
        tau[k] = prevTau[k] + (target - prevTau[k]) * lagAlpha;
      }
      prevTau = tau;
      robot.arm.step(tau, CTRL.dt);     // keep integrating even after release (follow-through)

      const tip = robot.arm.tip();
      armFrames.push({ ...robot.arm.state(), tipX: tip.x, tipY: tip.y, tipZ: tip.z, held: released ? 0 : 1 });

      if (!released && dev.captured.release) {
        released = true;
        releaseIndex = armFrames.length - 1;
        dev.held = 0;
        release = { tip, vel: robot.arm.tipVelocity(), spin: robot.arm.spin() };
        world = new CupWorld({ cups: opponent.aliveCups().map((c) => ({ index: c.index, x: c.x, z: c.z })) });
        world.launch({ origin: release.tip, velocity: release.vel, spin: release.spin });
      }

      if (released) {
        // Step the ball at its own rate (120 Hz) while the arm ticks at 240 Hz;
        // record one ball frame per arm frame so the two timelines stay aligned.
        // After the ball settles, world.step() is a no-op so the ball freezes
        // while the arm keeps following through and returning to its ready pose.
        ballAccum += CTRL.dt;
        while (ballAccum >= PHYS.fixedDt - 1e-9 && !world.done) { world.step(); ballAccum -= PHYS.fixedDt; }
        ballFrames.push({ ball: world.ballState(), cups: world.cupStates() });
        if (world.done && settleIndex < 0) settleIndex = armFrames.length - 1;
        // End once the ball has settled AND the arm is back at rest. The cap is
        // generous (the ball launches from behind the robot, so its flight alone
        // is ~2.6 s); a still-bouncing ball past the cap is finished by resolve().
        const restful = Math.abs(robot.arm.shoulder.a) < 0.10 && Math.abs(robot.arm.shoulder.w) < 0.4;
        if ((world.done && restful) || tick - releaseIndex > POST) break;
      }
    }
    if (world && !world.done) world.resolve();
    const outcome = world ? world.outcome : { result: 'miss', cupIndex: -1 };

    // The recorded tail already eased the arm back to ~rest (shown to the
    // viewer), so snap the engine state to exact rest. This keeps consecutive
    // throws identical (no swing drift) while staying visually continuous —
    // there's no teleport, the arm came home on screen.
    robot.arm.reset();

    return {
      turn: this.turnIndex,
      thrower: robot.label,
      side: robot.side,
      oppSide: opponent.side,
      playerId: robot.playerId,
      drinks,
      corrupted: flipped,
      crashed,
      fired: released,
      log: dev.captured.logs.slice(),
      armFrames,
      ballFrames,
      releaseIndex,
      settleIndex,
      release,
      outcome,
    };
  }

  // Apply a turn's outcome to the score and advance. Returns score info.
  applyOutcome(outcome) {
    const opponent = this.opponentOf(this.current);
    const info = { result: outcome.result, cupIndex: outcome.cupIndex, winner: null };
    if (outcome.result === 'sink' && outcome.cupIndex >= 0) {
      const cup = opponent.cups[outcome.cupIndex];
      if (cup && cup.alive) {
        cup.alive = false;
        opponent.drinks += 1;
        info.sunkCup = { side: opponent.side, index: outcome.cupIndex };
        info.victim = opponent.label;
      }
    }
    if (opponent.defeated()) { this.winner = this.current; info.winner = this.current; }
    this.turnIndex++;
    this.current = this.current === 'A' ? 'B' : 'A';
    return info;
  }

  state() {
    return {
      current: this.current,
      winner: this.winner,
      turn: this.turnIndex,
      A: { player: this.robots.A.playerId, drinks: this.robots.A.drinks, cups: this.robots.A.cups.map((c) => c.alive) },
      B: { player: this.robots.B.playerId, drinks: this.robots.B.drinks, cups: this.robots.B.cups.map((c) => c.alive) },
    };
  }
}
