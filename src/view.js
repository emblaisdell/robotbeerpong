// Three.js rendering layer. Loads the GLB models, builds the court, animates
// the robot arms, and runs the rigid-body ball/cup simulation (CupWorld). The
// physics it steps here *is* the authority on the outcome: the ball collides
// with cup-shaped colliders, settles in, and the made cup is reported back so
// the engine can score it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COURT, MRAD, BALL_RADIUS, LAUNCH_HEIGHT, PHYS } from './constants.js';
import { rackPositions } from './physics.js';
import { CupWorld } from './cupworld.js';

const MODELS = {
  robot: 'web-models/robot.glb',
  cup: 'web-models/cup.glb',
  ball: 'web-models/ball.glb',
};

export class GameView {
  constructor(container) {
    this.container = container;
    this.clock = new THREE.Clock();
    this.anim = null;        // current turn animation state
    this.onTurnDone = null;
    this.speed = 1;
    this.cupMeshes = { '-1': [], '1': [] };
    this.robots = {};
    this._initScene();
  }

  _initScene() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10131a);
    this.scene.fog = new THREE.Fog(0x10131a, 80, 200);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 500);
    this.camera.position.set(38, 34, 62);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 4, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    // Lighting.
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202028, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(30, 60, 40);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const d = 60;
    key.shadow.camera.left = -d; key.shadow.camera.right = d;
    key.shadow.camera.top = d; key.shadow.camera.bottom = -d;
    key.shadow.camera.far = 200;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x4466ff, 0.5);
    rim.position.set(-40, 20, -30);
    this.scene.add(rim);

    this._buildCourt();

    addEventListener('resize', () => this._resize());
  }

  _buildCourt() {
    // Floor.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Table.
    const tlen = (COURT.robotZ + 6) * 2;
    const twid = (COURT.tableHalfWidth + 1) * 2;
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(twid, 1.0, tlen),
      new THREE.MeshStandardMaterial({ color: 0x2c6e49, roughness: 0.6, metalness: 0.05 }),
    );
    table.position.y = -0.5;
    table.receiveShadow = true;
    this.scene.add(table);

    // Centre line.
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(twid, 0.06, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xeaf6ff, emissive: 0x224466, emissiveIntensity: 0.4 }),
    );
    line.position.y = 0.02;
    this.scene.add(line);
  }

  async load() {
    const loader = new GLTFLoader();
    const load = (url) => new Promise((res, rej) => loader.load(url, (g) => res(g), undefined, rej));
    const [robot, cup, ball] = await Promise.all([load(MODELS.robot), load(MODELS.cup), load(MODELS.ball)]);
    this.proto = {
      robot: robot.scene,
      cup: cup.scene,
      ball: ball.scene,
    };
    this._tintShadows(this.proto.robot);
    this._tintShadows(this.proto.cup);
    this._tintShadows(this.proto.ball);
    // Native bounding sizes, so we can normalize to sensible world dimensions
    // regardless of how the GLBs were authored.
    const size = (o) => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    this.nativeSize = { robot: size(this.proto.robot), cup: size(this.proto.cup), ball: size(this.proto.ball) };
  }

  // Scale `obj` so its height is `targetH`, then drop it so its base sits at y=0.
  _fitAndGround(obj, targetH, native) {
    obj.scale.setScalar(targetH / native.y);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.y -= box.min.y;
    return obj;
  }

  _tintShadows(root) {
    root.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
  }

  // Build/rebuild robots and cups for a fresh match.
  setupMatch(playerIds) {
    // remove previous
    for (const k of ['A', 'B']) if (this.robots[k]) this.scene.remove(this.robots[k].group);
    for (const side of ['-1', '1']) {
      for (const m of this.cupMeshes[side]) if (m) this.scene.remove(m);
      this.cupMeshes[side] = [];
    }

    this.robots.A = this._makeRobot(-1, playerIds.A);
    this.robots.B = this._makeRobot(+1, playerIds.B);
    this._makeRack(-1);
    this._makeRack(+1);
  }

  _makeRobot(side, label) {
    const group = new THREE.Group();
    const model = this.proto.robot.clone(true);
    // Normalize the arm to a realistic height and stand it on the table.
    this._fitAndGround(model, 16, this.nativeSize.robot);
    group.add(model);
    group.position.set(0, 0, side * COURT.robotZ);
    // The model's "front" is its local +X, so yaw it a quarter turn to face the
    // opponent down the court (A at -Z looks toward +Z, B at +Z toward -Z).
    group.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;

    // Find articulated nodes for cosmetic aiming/swing. With the body turned,
    // the shoulder now swings about the arm's local Z to throw down the court.
    const waist = model.getObjectByName('Waist');
    const arm = model.getObjectByName('Arm');
    const hand = model.getObjectByName('Hand');
    const magnet = model.getObjectByName('Magnet');
    const robot = {
      group, model, side, waist, arm, hand, magnet, baseYaw: 0,
      baseArmZ: arm ? arm.rotation.z : 0,
      baseHandZ: hand ? hand.rotation.z : 0,
      // B is A turned 180°, so the same swing sign carries both hands toward
      // their own opponent's cups.
      swingSign: -1,
    };
    this.scene.add(group);
    // Measure where the magnet tip rests so the held ball sits a fixed amount
    // *beyond* it and the ball's rest height equals the physics LAUNCH_HEIGHT
    // (making release seamless).
    group.updateMatrixWorld(true);
    if (magnet) {
      const p = new THREE.Vector3();
      magnet.getWorldPosition(p);
      robot.magnetRestY = p.y;
      robot.ballBeyond = LAUNCH_HEIGHT - p.y; // local +Y offset along the arm tip
    } else {
      robot.magnetRestY = LAUNCH_HEIGHT;
      robot.ballBeyond = 0;
    }
    return robot;
  }

  _makeRack(side) {
    const cups = rackPositions(side);
    for (const c of cups) {
      // Wrap the cup in a group whose origin sits at the cup's base centre,
      // matching the physics body's frame so we can drive it rigidly.
      const group = new THREE.Group();
      group.position.set(c.x, 0, c.z);
      group.userData = { side, index: c.index, home: { x: c.x, z: c.z } };

      const mesh = this.proto.cup.clone(true);
      this._fitAndGround(mesh, COURT.cupMouthHeight + 0.4, this.nativeSize.cup);
      mesh.position.x = 0; mesh.position.z = 0; // centred inside the group
      // The cup.glb is already authored as a red solo cup: a 2-colour palette
      // texture (red body, white rim/foot) drives the outside, so we leave the
      // texture alone. The only thing it can't express is the *inside* — the
      // cup is a single-walled shell, so the interior shares the body's red UV.
      // We override just the inner-facing faces (and cavity floor) to white in
      // the shader, leaving the authored lip exactly as modelled.
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.onBeforeCompile = (shader) => {
            shader.vertexShader = 'varying vec3 vLocalPos;\nvarying vec3 vLocalNormal;\n' + shader.vertexShader
              .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLocalPos = position;')
              .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vLocalNormal = objectNormal;');
            shader.fragmentShader = 'varying vec3 vLocalPos;\nvarying vec3 vLocalNormal;\n' + shader.fragmentShader
              .replace('#include <color_fragment>',
                ['#include <color_fragment>',
                  '{',
                  // Radial component of the (un-normalized) surface normal: clearly
                  // negative only on inner-facing walls. Not normalizing the normal
                  // avoids noise on the near-vertical rim/ridge faces.
                  '  float radial = dot(vLocalNormal.xz, normalize(vLocalPos.xz + 1e-5));',
                  '  bool inside = radial < -0.25;',
                  // The cavity floor: upward-facing faces near the central axis.
                  '  bool floor = vLocalNormal.y > 0.5 && length(vLocalPos.xz) < 1.0;',
                  '  if (inside || floor) diffuseColor.rgb = vec3(0.95, 0.96, 0.97);',
                  '}'].join('\n  '));
          };
          o.material.customProgramCacheKey = () => 'cup-white-inside';
          o.material.needsUpdate = true;
        }
      });
      group.add(mesh);
      this.scene.add(group);
      this.cupMeshes[String(side)][c.index] = group;
    }
  }

  // Reset every still-standing cup to its rack position (upright), undoing any
  // knocks from the previous throw.
  _resetCups() {
    for (const side of ['-1', '1']) {
      for (const g of this.cupMeshes[side]) {
        if (g && !g.userData.dying) {
          g.position.set(g.userData.home.x, 0, g.userData.home.z);
          g.quaternion.identity();
          g.scale.setScalar(1);
        }
      }
    }
  }

  // Animate one throw. `liveCups` are the opponent's standing cups
  // [{index,x,z}]; `done(outcome)` fires when the ball has settled, with the
  // physics result { result:'sink'|'miss', cupIndex }.
  playThrow(event, liveCups, done, speed = 1) {
    this.speed = speed;
    this.onTurnDone = done;
    const robot = event.thrower === 'A' ? this.robots.A : this.robots.B;
    const yaw = (event.command?.yawMrad || 0) / MRAD;

    // Reset knocked cups, then build the rigid-body world for this throw.
    this._resetCups();
    this.world = new CupWorld({ cups: liveCups });
    this.oppSide = String(event.oppSide);

    this.anim = {
      event, robot, phase: 'windup', t: 0,
      windup: 0.32, throwT: 0.16, settle: 0.7,
      yaw, released: false, physAccum: 0, outcome: null,
      prevMagQuat: null, spinAxis: null, spinRate: 0, // ball spin from the arm
    };
    // make the ball, then have the magnet hold it just beyond the arm tip
    if (!this.ball) {
      this.ball = this.proto.ball.clone(true);
      this.ball.scale.setScalar((BALL_RADIUS * 2) / this.nativeSize.ball.y);
      // flat shading so the icosphere facets catch the light and the spin reads
      this.ball.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.color = new THREE.Color(0xffffff);
          o.material.emissive = new THREE.Color(0x202020);
          o.material.flatShading = true;
          o.material.needsUpdate = true;
        }
      });
      this.scene.add(this.ball);
    }
    this.ball.rotation.set(0, 0, 0);   // fresh orientation each throw
    this.ball.visible = true;
    this._holdBall(robot);
  }

  // Measure the magnet's angular velocity (world frame) from its rotation over
  // one frame — the spin the ball will inherit when the magnet lets go.
  _trackSpin(r, a, dt) {
    if (!r.magnet) return;
    const cur = new THREE.Quaternion();
    r.magnet.getWorldQuaternion(cur);
    if (a.prevMagQuat && dt > 1e-5) {
      const dq = cur.clone().multiply(a.prevMagQuat.clone().invert()).normalize();
      const w = Math.min(1, Math.max(-1, dq.w));
      const angle = 2 * Math.acos(Math.abs(w));
      const s = Math.sqrt(Math.max(0, 1 - w * w));
      if (s > 1e-4 && angle > 1e-5) {
        const sign = w < 0 ? -1 : 1;
        a.spinAxis = new THREE.Vector3(dq.x / s, dq.y / s, dq.z / s).multiplyScalar(sign).normalize();
        a.spinRate = Math.min(45, angle / dt); // clamp to a sane visual max
      }
    }
    a.prevMagQuat = cur.clone();
  }

  // Place the ball just beyond the magnet, tracking the arm as it swings.
  _holdBall(r) {
    if (!r.magnet) return;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    r.magnet.getWorldPosition(p);
    r.magnet.getWorldQuaternion(q);
    const off = new THREE.Vector3(0, r.ballBeyond, 0).applyQuaternion(q);
    this.ball.position.copy(p).add(off);
  }

  // The magnet lets go: hand the ball (with its spin) to the physics world.
  // Its held rest position equals event.origin, so the hand-off is seamless.
  _releasePhysics() {
    const a = this.anim;
    a.released = true;
    a.phase = 'physics';
    a.physAccum = 0;
    this.ball.visible = true;
    const spin = a.spinAxis
      ? { axis: { x: a.spinAxis.x, y: a.spinAxis.y, z: a.spinAxis.z }, rate: a.spinRate }
      : null;
    this.world.launch({ origin: a.event.origin, velocity: a.event.velocity, spin });
  }

  // Ball has come to rest: record the outcome, pop the made cup.
  _finishPhysics() {
    const a = this.anim;
    a.outcome = this.world.outcome || { result: 'miss', cupIndex: -1 };
    if (a.outcome.result === 'sink' && a.outcome.cupIndex >= 0) {
      const g = this.cupMeshes[this.oppSide][a.outcome.cupIndex];
      if (g) g.userData.dying = true;   // pull the made cup
      this.ball.visible = false;
    }
    a.phase = 'settle';
    a.t = 0;
  }

  // Sync the Three.js meshes to the physics bodies.
  _syncPhysics() {
    const bs = this.world.ballState();
    if (bs) { this.ball.position.set(bs.x, bs.y, bs.z); this.ball.quaternion.set(bs.qx, bs.qy, bs.qz, bs.qw); }
    for (const cs of this.world.cupStates()) {
      const g = this.cupMeshes[this.oppSide][cs.index];
      if (g && !g.userData.dying) {
        g.position.set(cs.x, cs.y, cs.z);
        g.quaternion.set(cs.qx, cs.qy, cs.qz, cs.qw);
      }
    }
  }

  update() {
    const dt = Math.min(0.05, this.clock.getDelta()) * this.speed;
    this.controls.update();
    this._updateDyingCups(dt);

    const a = this.anim;
    if (a) {
      a.t += dt;
      const r = a.robot;
      // Swing angles s: 0 rest, <0 wound back, >0 thrown forward (toward cups).
      // The shoulder (arm) leads; the elbow (hand) lags then snaps for a whip.
      const setSwing = (s) => { if (r.arm) r.arm.rotation.z = r.baseArmZ + r.swingSign * s; };
      const setElbow = (s) => { if (r.hand) r.hand.rotation.z = r.baseHandZ + r.swingSign * s; };
      const restArmZ = r.baseArmZ, restHandZ = r.baseHandZ;
      if (a.phase === 'windup') {
        const k = Math.min(1, a.t / a.windup);
        if (r.waist) r.waist.rotation.y = a.yaw * (r.side < 0 ? 1 : -1) * k;
        setSwing(-0.9 * k);                                    // shoulder winds back
        setElbow(-0.6 * k);                                    // elbow cocks back
        this._holdBall(r); this._trackSpin(r, a, dt);         // magnet still holds it
        if (a.t >= a.windup) { a.phase = 'throw'; a.t = 0; }
      } else if (a.phase === 'throw') {
        const k = Math.min(1, a.t / a.throwT);
        setSwing(-0.9 + 1.5 * k);                              // shoulder swings forward
        setElbow(-0.6 + 1.7 * (k * k));                        // elbow snaps late (whip)
        if (!a.released) { this._holdBall(r); this._trackSpin(r, a, dt); } // carried + spun up
        if (k >= 0.6 && !a.released) this._releasePhysics();
        if (a.t >= a.throwT && !a.released) this._releasePhysics();
      } else if (a.phase === 'physics') {
        // Step the rigid-body world at a fixed rate (scaled by playback speed),
        // syncing the ball + cup meshes to the bodies. Physics decides the rest.
        a.physAccum += dt;
        let guard = 0;
        while (a.physAccum >= PHYS.fixedDt && !this.world.done && guard < 16) {
          this.world.step();
          a.physAccum -= PHYS.fixedDt;
          guard++;
        }
        this._syncPhysics();
        // ease shoulder and elbow back to rest while the ball is airborne
        if (r.arm) r.arm.rotation.z += (restArmZ - r.arm.rotation.z) * Math.min(1, dt * 4);
        if (r.hand) r.hand.rotation.z += (restHandZ - r.hand.rotation.z) * Math.min(1, dt * 4);
        if (this.world.done) this._finishPhysics();
      } else if (a.phase === 'settle') {
        if (r.waist) r.waist.rotation.y += (0 - r.waist.rotation.y) * Math.min(1, dt * 5);
        if (r.arm) r.arm.rotation.z += (restArmZ - r.arm.rotation.z) * Math.min(1, dt * 5);
        if (r.hand) r.hand.rotation.z += (restHandZ - r.hand.rotation.z) * Math.min(1, dt * 5);
        if (a.t >= a.settle) {
          const cb = this.onTurnDone;
          const outcome = a.outcome || { result: 'miss', cupIndex: -1 };
          this.anim = null; this.onTurnDone = null;
          if (this.ball) this.ball.visible = false;
          if (cb) cb(outcome);
        }
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  // A made cup is pulled: it sinks into the table and shrinks away, then is
  // removed so it no longer participates in physics or resets.
  _updateDyingCups(dt) {
    for (const side of ['-1', '1']) {
      const arr = this.cupMeshes[side];
      for (let i = 0; i < arr.length; i++) {
        const g = arr[i];
        if (g && g.userData.dying) {
          g.userData.dieT = (g.userData.dieT || 0) + dt;
          g.position.y -= 7 * dt;                  // sink through the table
          g.scale.multiplyScalar(1 - Math.min(0.9, dt * 3));
          if (g.userData.dieT > 0.5) {
            this.scene.remove(g);
            arr[i] = null;
          }
        }
      }
    }
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
