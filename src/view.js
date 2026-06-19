// Three.js rendering layer. Loads the GLB models, builds the court, animates
// the robot arms, and runs the rigid-body ball/cup simulation (CupWorld). The
// physics it steps here *is* the authority on the outcome: the ball collides
// with cup-shaped colliders, settles in, and the made cup is reported back so
// the engine can score it.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COURT, BALL_RADIUS, CTRL } from './constants.js';
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

    // Articulated joints, driven each frame from the engine's recorded angles:
    // waist = yaw, arm = shoulder pitch, hand = elbow pitch.
    const waist = model.getObjectByName('Waist');
    const arm = model.getObjectByName('Arm');
    const hand = model.getObjectByName('Hand');
    const robot = { group, model, side, waist, arm, hand };
    this.scene.add(group);
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

  // Replay one simulated turn. `turn` is the engine's record: armFrames (joint
  // angles + held-ball tip over the control loop) and ballFrames (ball + cup
  // bodies during flight). `done(outcome)` fires when it's all settled.
  playThrow(turn, done, speed = 1) {
    this.speed = speed;
    this.onTurnDone = done;
    const robot = turn.thrower === 'A' ? this.robots.A : this.robots.B;
    this._resetCups();
    this.oppSide = String(turn.oppSide);

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
    this.ball.rotation.set(0, 0, 0);
    // If the program never fired, don't replay seconds of flailing — show ~1s.
    const armLen = turn.fired ? turn.armFrames.length : Math.min(turn.armFrames.length, 240);
    this.anim = {
      turn, robot, armLen,
      phase: turn.armFrames.length ? 'play' : 'end',
      i: 0, settleT: 0, popped: false,
    };
    if (turn.armFrames.length) { this.ball.visible = true; this._applyJoints(robot, turn.armFrames[0]); }
  }

  // Drive the GLB joints from a recorded arm frame.
  _applyJoints(r, f) {
    if (r.waist) r.waist.rotation.y = f.yaw * (r.side < 0 ? 1 : -1);
    if (r.arm) r.arm.rotation.z = -f.shoulder;
    if (r.hand) r.hand.rotation.z = -f.elbow;
  }

  update() {
    const dt = Math.min(0.05, this.clock.getDelta()) * this.speed;
    this.controls.update();
    this._updateDyingCups(dt);

    const a = this.anim;
    if (a) {
      const r = a.robot;
      const turn = a.turn;
      if (a.phase === 'play') {
        // One timeline at the control-tick rate. The arm keeps moving the whole
        // time (wind-up, swing, release, follow-through). The ball is held at the
        // tip until releaseIndex, then follows its own rigid-body timeline while
        // the arm follows through.
        a.i += dt / CTRL.dt;
        const idx = Math.min(a.armLen - 1, Math.floor(a.i));
        this._applyJoints(r, turn.armFrames[idx]);
        const rel = turn.releaseIndex;
        if (rel < 0 || idx < rel) {
          this.ball.visible = true;
          const f = turn.armFrames[idx];
          this.ball.position.set(f.tipX, f.tipY, f.tipZ); // held at the tip
        } else {
          const bi = Math.min(turn.ballFrames.length - 1, idx - rel);
          const bf = turn.ballFrames[bi];
          if (bf) {
            this.ball.visible = true;
            this.ball.position.set(bf.ball.x, bf.ball.y, bf.ball.z);
            this.ball.quaternion.set(bf.ball.qx, bf.ball.qy, bf.ball.qz, bf.ball.qw);
            for (const cs of bf.cups) {
              const g = this.cupMeshes[this.oppSide][cs.index];
              if (g && !g.userData.dying) {
                g.position.set(cs.x, cs.y, cs.z);
                g.quaternion.set(cs.qx, cs.qy, cs.qz, cs.qw);
              }
            }
          }
          // Pop the made cup the moment the ball settles, then let the arm keep
          // following through / returning to its ready pose.
          if (!a.popped && turn.settleIndex >= 0 && idx >= turn.settleIndex) {
            a.popped = true;
            if (turn.outcome.result === 'sink' && turn.outcome.cupIndex >= 0) {
              const g = this.cupMeshes[this.oppSide][turn.outcome.cupIndex];
              if (g) g.userData.dying = true;
              this.ball.visible = false;
            }
          }
        }
        if (a.i >= a.armLen - 1) a.phase = 'end';
      } else if (a.phase === 'end') {
        // The made cup was already popped at settleIndex; if the program never
        // fired or never settled, pop here as a fallback. Then report the outcome.
        if (!a.popped) {
          a.popped = true;
          if (turn.outcome.result === 'sink' && turn.outcome.cupIndex >= 0) {
            const g = this.cupMeshes[this.oppSide][turn.outcome.cupIndex];
            if (g) g.userData.dying = true;
          }
          this.ball.visible = false;
        }
        a.settleT += dt;
        if (a.settleT >= 0.4) {
          const cb = this.onTurnDone;
          this.anim = null; this.onTurnDone = null;
          if (this.ball) this.ball.visible = false;
          if (cb) cb(turn.outcome);
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
