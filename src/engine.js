// The match engine: pure simulation, no rendering. It assembles two RISC-V
// players, runs a turn at a time, applies the inebriation handicap, resolves
// throws through the physics module, and tracks the score. The view layer
// consumes the per-turn events it returns; this whole file runs headless in
// Node, which is how the game is smoke-tested.

import { assemble, CPU } from './riscv.js';
import { MMIO_EQU, getPlayer } from './players.js';
import {
  MEM_SIZE, MMIO_BASE, STACK_TOP, INSTR_BUDGET,
  S_BEARING, S_RANGE, S_DRINKS, S_YAW, S_PITCH, S_GRAVITY, S_RNG, S_CUPS,
  A_YAW, A_PITCH, A_POWER, A_FIRE, A_LOG, GRAVITY, MM_PER_UNIT,
} from './constants.js';
import { rackPositions, bearingRange, launchVelocity, originOf } from './physics.js';

// Deterministic PRNG so a given seed replays identically.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One robot: its assembled program, its rack (the cups it must defend), and how
// many of its own cups have been sunk (= how drunk it is).
class Robot {
  constructor(label, side, playerId) {
    this.label = label;       // 'A' / 'B'
    this.side = side;         // -1 / +1
    this.playerId = playerId;
    const player = getPlayer(playerId);
    this.player = player;
    const { code } = assemble(player.source, MMIO_EQU);
    this.code = code;         // clean image, reloaded every turn
    this.cpu = new CPU({ memSize: MEM_SIZE, mmioBase: MMIO_BASE, device: null });
    this.cups = rackPositions(side);
    this.drinks = 0;
  }
  aliveCups() { return this.cups.filter((c) => c.alive); }
  defeated() { return this.aliveCups().length === 0; }
}

export class Match {
  constructor({ playerA = 'sniper', playerB = 'lobber', seed = 1 } = {}) {
    this.rngState = (seed >>> 0) || 1;
    this.rand = mulberry32(this.rngState);
    this.robots = {
      A: new Robot('A', -1, playerA),
      B: new Robot('B', +1, playerB),
    };
    this.turnIndex = 0;
    this.current = 'A';
    this.winner = null;
    this.log = [];
  }

  opponentOf(label) { return label === 'A' ? this.robots.B : this.robots.A; }

  // Gaussian-ish noise (sum of uniforms), scaled by stddev.
  noise(stddev) {
    return (this.rand() + this.rand() + this.rand() - 1.5) * stddev * 0.8165;
  }

  // Build the device that backs MMIO for one turn. Sensor reads return noisy
  // values (worse the drunker the robot); actuator writes are captured.
  makeDevice(robot, target, drinks) {
    const truth = bearingRange(robot.side, target);
    const out = { yaw: 0, pitch: 0, power: 0, fired: false, logs: [] };
    const self = this;
    const sensorBearingNoise = 18 * drinks; // mrad
    const sensorRangeNoise = 90 * drinks;   // mm
    return {
      captured: out,
      read32(addr) {
        switch (addr) {
          case S_BEARING: return Math.round(truth.bearing + self.noise(sensorBearingNoise));
          case S_RANGE: return Math.max(1, Math.round(truth.range + self.noise(sensorRangeNoise)));
          case S_DRINKS: return drinks;
          case S_YAW: return Math.round(self.noise(8 * drinks));
          case S_PITCH: return Math.round(self.noise(8 * drinks));
          case S_GRAVITY: return GRAVITY * MM_PER_UNIT;
          case S_CUPS: return self.opponentOf(robot.label).aliveCups().length;
          case S_RNG: return (self.rand() * 0xffffffff) | 0;
          default: return 0;
        }
      },
      write32(addr, value) {
        switch (addr) {
          case A_YAW: out.yaw = value | 0; break;
          case A_PITCH: out.pitch = value | 0; break;
          case A_POWER: out.power = value | 0; break;
          case A_FIRE: if (value) out.fired = true; break;
          case A_LOG: out.logs.push(value | 0); break;
        }
      },
    };
  }

  // Scribble on the program image to model corrupted memory / random byte flips.
  // Tuned so total failure is rare and the result is comedic, not fatal.
  corruptMemory(robot, drinks) {
    if (drinks <= 0) return 0;
    let flipped = 0;
    const len = robot.cpu.mem.length;
    // A few random byte flips anywhere in low memory (code + data).
    const tries = drinks;
    for (let i = 0; i < tries; i++) {
      if (this.rand() < 0.10 * drinks) {
        const addr = Math.floor(this.rand() * Math.min(len, 0x4000));
        robot.cpu.mem[addr] = Math.floor(this.rand() * 256);
        flipped++;
      }
    }
    return flipped;
  }

  // Run the player and produce the *launch* for this turn. The outcome (which
  // cup, if any) is decided later by the rigid-body simulation and fed back via
  // applyOutcome — the physics is the authority on whether a cup is made.
  computeThrow() {
    if (this.winner) return null;
    const robot = this.robots[this.current];
    const opponent = this.opponentOf(this.current);
    const drinks = robot.drinks;

    // Pick the nearest live opponent cup to aim at (fills the bearing sensor).
    const origin = originOf(robot.side);
    const targets = opponent.aliveCups();
    let target = targets[0];
    let bestD = Infinity;
    for (const c of targets) {
      const d = Math.hypot(c.x - origin.x, c.z - origin.z);
      if (d < bestD) { bestD = d; target = c; }
    }

    // Load a fresh program image, corrupt it, run the player.
    robot.cpu.load(robot.code);
    const flipped = this.corruptMemory(robot, drinks);
    const device = this.makeDevice(robot, target, drinks);
    robot.cpu.device = device;
    robot.cpu.reset(0, STACK_TOP);
    const ran = robot.cpu.run(INSTR_BUDGET);
    const cmd = device.captured;

    const event = {
      turn: this.turnIndex,
      thrower: robot.label,
      side: robot.side,
      oppSide: opponent.side,
      playerId: robot.playerId,
      drinks,
      origin,
      target: { x: target.x, z: target.z },
      instr: ran,
      corrupted: flipped,
      log: cmd.logs.slice(),
    };

    if (!cmd.fired) {
      // The program never pulled the trigger (corruption / crash / infinite
      // loop). The arm twitches and fumbles the ball — physics will miss.
      const yaw = Math.round(this.noise(400));
      const power = Math.round(600 + this.rand() * 400);
      event.fizzle = true;
      event.command = { yawMrad: yaw, pitchMrad: 300, power };
      event.velocity = launchVelocity(robot.side, yaw, 300, power);
      return event;
    }

    // Actuator handicap: over/under-actuation (scale error) plus aim bias.
    const yawMrad = Math.round(cmd.yaw * (1 + this.noise(0.02 * drinks)) + this.noise(20 * drinks));
    const pitchMrad = Math.round(cmd.pitch + this.noise(14 * drinks));
    const power = Math.max(0, Math.round(cmd.power * (1 + this.noise(0.05 * drinks))));
    event.intended = { yawMrad: cmd.yaw, pitchMrad: cmd.pitch, power: cmd.power };
    event.command = { yawMrad, pitchMrad, power };
    event.velocity = launchVelocity(robot.side, yawMrad, pitchMrad, power);
    return event;
  }

  // Apply the physics result to the score and advance the turn.
  //   result: { result: 'sink' | 'miss', cupIndex }
  applyOutcome(result) {
    const robot = this.robots[this.current];
    const opponent = this.opponentOf(this.current);
    const info = { result: result.result, cupIndex: result.cupIndex, winner: null };

    if (result.result === 'sink' && result.cupIndex >= 0) {
      const cup = opponent.cups[result.cupIndex];
      if (cup && cup.alive) {
        cup.alive = false;
        opponent.drinks += 1; // the victim drinks — and gets worse
        info.sunkCup = { side: opponent.side, index: result.cupIndex, x: cup.x, z: cup.z };
        info.victim = opponent.label;
      }
    }

    if (opponent.defeated()) { this.winner = this.current; info.winner = this.current; }
    this.turnIndex++;
    this.current = this.current === 'A' ? 'B' : 'A';
    return info;
  }

  // Live opponent cups (rack positions + indices) for building the physics world.
  liveTargetCups() {
    return this.opponentOf(this.current).aliveCups().map((c) => ({ index: c.index, x: c.x, z: c.z }));
  }

  // Convenience snapshot for the UI.
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
