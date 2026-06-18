// Rigid-body world for one throw: a table, the live cups (dynamic compound
// colliders matching the cup mesh), and the ball. Pure physics over cannon-es —
// no Three.js — so the exact same simulation runs live in the browser view and
// headless in Node tests. Whoever steps it is the authority on the outcome.

import * as CANNON from 'cannon-es';
import {
  GRAVITY, BALL_RADIUS, COURT, CUP_PHYS, BALL_PHYS, PHYS,
} from './constants.js';

// Build one cup as a dynamic compound body: a solid base/foot, a flat inner
// floor the ball rests on, and a ring of wall boxes forming the open cone.
function buildCup(material, x, z) {
  const body = new CANNON.Body({
    mass: CUP_PHYS.mass, material,
    linearDamping: CUP_PHYS.linearDamping,
    angularDamping: CUP_PHYS.angularDamping,
  });
  body.position.set(x, 0, z);

  // Solid lower body (foot) from y=0 to the cavity floor.
  const baseH = CUP_PHYS.floorY;
  body.addShape(
    new CANNON.Box(new CANNON.Vec3(CUP_PHYS.baseR, baseH / 2, CUP_PHYS.baseR)),
    new CANNON.Vec3(0, baseH / 2, 0),
  );
  // Inner floor disc — the ball comes to rest on its top face at floorY.
  const floorTh = 0.12;
  body.addShape(
    new CANNON.Box(new CANNON.Vec3(CUP_PHYS.innerR, floorTh / 2, CUP_PHYS.innerR)),
    new CANNON.Vec3(0, CUP_PHYS.floorY - floorTh / 2, 0),
  );
  // Wall ring: N boxes around the cone, inner face at innerR, outer at outerR.
  const n = CUP_PHYS.wallSegments;
  const wallH = CUP_PHYS.rimY - CUP_PHYS.floorY;
  const midY = (CUP_PHYS.rimY + CUP_PHYS.floorY) / 2;
  const rMid = (CUP_PHYS.innerR + CUP_PHYS.outerR) / 2;
  const radialHalf = (CUP_PHYS.outerR - CUP_PHYS.innerR) / 2;
  const tangHalf = rMid * Math.tan(Math.PI / n) * 1.06; // slight overlap, no gaps
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const off = new CANNON.Vec3(Math.cos(a) * rMid, midY, Math.sin(a) * rMid);
    const q = new CANNON.Quaternion();
    q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -a); // local +x -> radial outward
    body.addShape(new CANNON.Box(new CANNON.Vec3(radialHalf, wallH / 2, tangHalf)), off, q);
  }
  body.updateMassProperties();
  return body;
}

export class CupWorld {
  // cups: [{ index, x, z }] — only the cups still standing.
  constructor({ cups }) {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.solver.iterations = 20;
    world.allowSleep = false;
    this.world = world;

    const ballMat = new CANNON.Material('ball');
    const cupMat = new CANNON.Material('cup');
    const groundMat = new CANNON.Material('ground');
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat, cupMat, { restitution: PHYS.cupRestitution, friction: PHYS.cupFriction }));
    world.addContactMaterial(new CANNON.ContactMaterial(ballMat, groundMat, { restitution: BALL_PHYS.restitution, friction: BALL_PHYS.friction }));
    world.addContactMaterial(new CANNON.ContactMaterial(cupMat, groundMat, { restitution: 0.0, friction: 0.8 }));
    world.addContactMaterial(new CANNON.ContactMaterial(cupMat, cupMat, { restitution: 0.0, friction: 0.6 }));

    // Table top: an infinite static plane at y=0 (off-table is judged by bounds).
    const ground = new CANNON.Body({ mass: 0, material: groundMat });
    ground.addShape(new CANNON.Plane());
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(ground);

    // Backstop: an invisible wall just in front of the *target* robot (behind
    // its rack) so overshot balls stop there instead of phasing through the
    // robot, which has no collider. Only on the opponent's side — a wall in
    // front of the thrower would block its own launch. Low restitution so it
    // deadens the ball rather than ricocheting it back across the table.
    // The opponent's side (+1 / -1): the ball travels toward it.
    this.oppSide = cups.length ? (Math.sign(cups[0].z) || 1) : 1;
    this.backstopZ = COURT.robotZ - COURT.backstopInset;
    if (cups.length) {
      const oppSide = this.oppSide;
      const wallMat = new CANNON.Material('wall');
      world.addContactMaterial(new CANNON.ContactMaterial(ballMat, wallMat, { restitution: 0.1, friction: 0.5 }));
      const hy = COURT.backstopHeight / 2;
      const wall = new CANNON.Body({ mass: 0, material: wallMat });
      wall.addShape(new CANNON.Box(new CANNON.Vec3(COURT.tableHalfWidth + 2, hy, 0.25)));
      wall.position.set(0, hy, oppSide * (COURT.robotZ - COURT.backstopInset));
      world.addBody(wall);
    }

    this.ballMat = ballMat;
    this.cups = [];
    for (const c of cups) {
      const body = buildCup(cupMat, c.x, c.z);
      body.cupIndex = c.index;
      world.addBody(body);
      this.cups.push({ index: c.index, body });
    }

    this.ball = null;
    this.restCount = 0;
    this.steps = 0;
    this.done = false;
    this.outcome = null;
    this.inPlay = false; // true once the ball is between the two backstops
  }

  // Launch the ball. spin: optional { axis:{x,y,z}, rate } (rad/s).
  launch({ origin, velocity, spin }) {
    const body = new CANNON.Body({ mass: BALL_PHYS.mass, material: this.ballMat });
    body.addShape(new CANNON.Sphere(BALL_RADIUS));
    body.position.set(origin.x, origin.y, origin.z);
    body.velocity.set(velocity.x, velocity.y, velocity.z);
    if (spin && spin.axis && spin.rate) {
      body.angularVelocity.set(spin.axis.x * spin.rate, spin.axis.y * spin.rate, spin.axis.z * spin.rate);
    }
    this.world.addBody(body);
    this.ball = body;
  }

  // Advance one fixed step. Returns 'flying' | 'settled' | 'miss'.
  step() {
    if (this.done) return this.outcome.result === 'sink' ? 'settled' : 'miss';
    this.world.step(PHYS.fixedDt);
    this.steps++;
    const b = this.ball;
    if (!b) return 'flying';

    // Off the table sideways or below the floor -> miss.
    if (Math.abs(b.position.x) > COURT.tableHalfWidth + 2 || b.position.y < -3) {
      return this._finish('miss', -1);
    }
    // Once the ball has flown into the field (between the backstops), stop it if
    // it then reaches *either* backstop plane — it never proceeds to a robot
    // (which has no collider), whether overshooting forward or bouncing back.
    if (!this.inPlay && Math.abs(b.position.z) < this.backstopZ) this.inPlay = true;
    if (this.inPlay && Math.abs(b.position.z) >= this.backstopZ) {
      return this._finish('miss', -1);
    }

    const speed = b.velocity.length();
    if (speed < PHYS.restSpeed) this.restCount++; else this.restCount = 0;

    if (this.restCount >= PHYS.restFrames || this.steps >= PHYS.maxSteps) {
      // Settled. Inside a (still-upright) cup?
      const made = this._cupContaining(b.position);
      if (made >= 0) return this._finish('sink', made);
      return this._finish('miss', -1);
    }
    return 'flying';
  }

  _cupContaining(p) {
    if (p.y > CUP_PHYS.rimY || p.y < 0) return -1;
    for (const c of this.cups) {
      // Use the cup's *current* position (it may have been nudged).
      const cp = c.body.position;
      // Only count cups still roughly upright.
      const up = new CANNON.Vec3(0, 1, 0);
      c.body.quaternion.vmult(up, up);
      if (up.y < 0.6) continue;
      const d = Math.hypot(p.x - cp.x, p.z - cp.z);
      if (d <= CUP_PHYS.innerR + BALL_RADIUS) return c.index;
    }
    return -1;
  }

  _finish(result, cupIndex) {
    this.done = true;
    this.outcome = { result, cupIndex };
    return result === 'sink' ? 'settled' : 'miss';
  }

  // Run headless to completion; returns { result, cupIndex }.
  resolve() {
    while (!this.done && this.steps < PHYS.maxSteps) this.step();
    return this.outcome || { result: 'miss', cupIndex: -1 };
  }

  ballState() {
    const b = this.ball;
    if (!b) return null;
    return {
      x: b.position.x, y: b.position.y, z: b.position.z,
      qx: b.quaternion.x, qy: b.quaternion.y, qz: b.quaternion.z, qw: b.quaternion.w,
    };
  }

  cupStates() {
    return this.cups.map((c) => ({
      index: c.index,
      x: c.body.position.x, y: c.body.position.y, z: c.body.position.z,
      qx: c.body.quaternion.x, qy: c.body.quaternion.y, qz: c.body.quaternion.z, qw: c.body.quaternion.w,
    }));
  }
}
