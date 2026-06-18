// Three.js rendering layer. Loads the GLB models, builds the court, and
// animates the turn events produced by engine.js. It owns no game logic — it
// is handed a fully-resolved throw (origin, velocity, trajectory, result) and
// just makes it look good. Ball flight is recomputed from the same kinematics
// the engine used, so what you see matches what was scored.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COURT, GRAVITY, MRAD, BALL_RADIUS } from './constants.js';
import { rackPositions } from './physics.js';

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
      for (const m of this.cupMeshes[side]) this.scene.remove(m);
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
    // Face centre court. Robot A (-Z) looks toward +Z, robot B toward -Z.
    group.rotation.y = side < 0 ? 0 : Math.PI;

    // Find articulated nodes for cosmetic aiming/swing.
    const waist = model.getObjectByName('Waist');
    const arm = model.getObjectByName('Arm');
    const magnet = model.getObjectByName('Magnet');
    const robot = { group, model, side, waist, arm, magnet, baseArmX: arm ? arm.rotation.x : 0, baseYaw: 0 };
    this.scene.add(group);
    return robot;
  }

  _makeRack(side) {
    const cups = rackPositions(side);
    for (const c of cups) {
      const mesh = this.proto.cup.clone(true);
      this._fitAndGround(mesh, COURT.cupMouthHeight + 0.4, this.nativeSize.cup);
      mesh.position.x = c.x; mesh.position.z = c.z;
      // Classic red solo cup.
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.color = new THREE.Color(0xd63031);
          o.material.emissive = new THREE.Color(0x3a0a0a);
        }
      });
      mesh.userData = { side, index: c.index };
      this.scene.add(mesh);
      this.cupMeshes[String(side)][c.index] = mesh;
    }
  }

  // Start animating one engine turn. Calls done() when fully settled.
  playTurn(event, done, speed = 1) {
    this.speed = speed;
    this.onTurnDone = done;
    const robot = event.thrower === 'A' ? this.robots.A : this.robots.B;
    const flightTime = Math.max(0.2, (event.trajectory.length - 1) * (event.dt || 1 / 240));
    // Aim the waist toward the commanded yaw (cosmetic).
    const yaw = (event.command?.yawMrad || 0) / MRAD;
    this.anim = {
      event, robot, phase: 'windup', t: 0,
      windup: 0.32, throwT: 0.16, flightTime, settle: 0.6,
      yaw, ball: null, released: false,
    };
    // make/reset the flying ball
    if (!this.ball) {
      this.ball = this.proto.ball.clone(true);
      this.ball.scale.setScalar((BALL_RADIUS * 2) / this.nativeSize.ball.y);
      this.ball.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color = new THREE.Color(0xffffff); o.material.emissive = new THREE.Color(0x222222); } });
      this.scene.add(this.ball);
    }
    this.ball.visible = false;
  }

  _release() {
    const a = this.anim;
    a.released = true;
    a.phase = 'flight';
    a.t = 0;
    this.ball.visible = true;
    const o = a.event.origin;
    this.ball.position.set(o.x, o.y, o.z);
  }

  _finishFlight() {
    const a = this.anim;
    const ev = a.event;
    if (ev.result === 'sink' && ev.sunkCup) {
      const mesh = this.cupMeshes[String(ev.sunkCup.side)][ev.sunkCup.index];
      if (mesh) this._splash(mesh);
      this.ball.visible = false;
    } else {
      // leave the ball where it landed for a beat
    }
    a.phase = 'settle';
    a.t = 0;
  }

  // Pop a cup with a little particle splash + drop animation.
  _splash(mesh) {
    mesh.userData.dying = true;
    mesh.userData.vy = 6 + Math.random() * 3;
    mesh.userData.spin = (Math.random() - 0.5) * 8;
  }

  update() {
    const dt = Math.min(0.05, this.clock.getDelta()) * this.speed;
    this.controls.update();
    this._updateDyingCups(dt);

    const a = this.anim;
    if (a) {
      a.t += dt;
      const r = a.robot;
      if (a.phase === 'windup') {
        const k = Math.min(1, a.t / a.windup);
        if (r.waist) r.waist.rotation.y = a.yaw * (r.side < 0 ? 1 : -1) * k;
        if (r.arm) r.arm.rotation.x = r.baseArmX - 0.9 * k;     // wind back
        if (a.t >= a.windup) { a.phase = 'throw'; a.t = 0; }
      } else if (a.phase === 'throw') {
        const k = Math.min(1, a.t / a.throwT);
        if (r.arm) r.arm.rotation.x = r.baseArmX - 0.9 + 1.5 * k; // swing forward
        if (k >= 0.6 && !a.released) this._release();
        if (a.t >= a.throwT && !a.released) this._release();
      } else if (a.phase === 'flight') {
        const o = a.event.origin, v = a.event.velocity;
        const t = a.t;
        this.ball.position.set(o.x + v.x * t, o.y + v.y * t - 0.5 * GRAVITY * t * t, o.z + v.z * t);
        // ease the arm back to rest
        if (r.arm) r.arm.rotation.x += (r.baseArmX - r.arm.rotation.x) * Math.min(1, dt * 4);
        if (t >= a.flightTime) this._finishFlight();
      } else if (a.phase === 'settle') {
        if (r.waist) r.waist.rotation.y += (0 - r.waist.rotation.y) * Math.min(1, dt * 5);
        if (r.arm) r.arm.rotation.x += (r.baseArmX - r.arm.rotation.x) * Math.min(1, dt * 5);
        if (a.t >= a.settle) {
          const cb = this.onTurnDone;
          this.anim = null; this.onTurnDone = null;
          if (this.ball) this.ball.visible = false;
          if (cb) cb();
        }
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  _updateDyingCups(dt) {
    for (const side of ['-1', '1']) {
      for (const mesh of this.cupMeshes[side]) {
        if (mesh && mesh.userData.dying) {
          mesh.userData.vy -= GRAVITY * dt;
          mesh.position.y += mesh.userData.vy * dt;
          mesh.rotation.z += mesh.userData.spin * dt;
          mesh.scale.multiplyScalar(1 - dt * 0.6);
          if (mesh.position.y < -8) {
            this.scene.remove(mesh);
            mesh.userData.dying = false;
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
