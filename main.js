// MAC0623 — A3 Navigation in VR
//
// Technique 1: WIM (World-in-Miniature). A scaled clone of the house lives in
//              the left hand; the red person marker is grabbed with the right
//              trigger and, on release, the viewpoint jumps there.
// Technique 2: Joystick. Left thumbstick = continuous locomotion, relative to
//              the head's heading.
//
// Task: walk to the green circle (beacon) and confirm (grip) while inside it.
//
// Scene graph:
//   scene
//    |- lights
//    |- world  (house, furniture, beacon)   <- everything navigable
//    '- xrRig  (camera, controllers, grips) <- moving the rig moves the viewpoint
//   The miniature is a clone of `world` (shared geometry/materials) hung on the
//   left grip. Because world is at the origin with identity transform, a
//   position in the miniature's local space == the same position in the world.

import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOUSE = { x0: -9, x1: 9, z0: -5, z1: 5 }; // metres
const ENV_SIZE = 18; // longest side of the house
const WALL_H = 2.6;
const WALL_T = 0.15;

const CONFIRM_RADIUS = 1.0; // m — beacon circle radius == confirm tolerance
const MIN_BEACON_DIST = 8.0; // m — beacon always spawns at least this far away
const TRIALS_PER_TECHNIQUE = 2;
const START_POS = { x: 0, z: 0 }; // where the head is placed at session start

const JOYSTICK_SPEED = 2.0; // m/s at full deflection
const JOYSTICK_DEADZONE = 0.15;

const WIM_SCALE = 0.35 / ENV_SIZE; // house ≈ 35 cm across in the hand
const MARKER_HEIGHT = 0.055; // person marker height in the hand (m)
const PERSON_MODEL_HEIGHT = 1.16; // height of the person mesh in its own units
const MINI_BEACON_BOOST = 2.0; // beacon is drawn this much wider in the miniature
const GRAB_RADIUS = 0.1; // m, controller-to-marker distance to grab

// Free floor spots (no furniture) where the beacon can appear.
const SPAWN_SPOTS = [
  // living room
  [-5.5, 3.4], [-4.4, 0.6], [-4.5, -3.3],
  // bedroom
  [0, 1.5], [-1.5, 0.2], [1.8, 1.8], [0, 3.2],
  // kitchen / dining
  [4.2, 2.0], [7.4, 3.3], [7.5, -2.2],
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let scene, camera, renderer, world, beacon, xrRig;
let mini, miniHolder, marker, personMat;
let controllers = [];
let dragController = null;

const _head = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _lastHeadXZ = new THREE.Vector2();

// ---------------------------------------------------------------------------
// World building
// ---------------------------------------------------------------------------

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...opts }));
  }
  return matCache.get(key);
}

function shade(color, f) {
  return new THREE.Color(color).multiplyScalar(f).getHex();
}

function addBox(parent, w, h, d, color, x, y, z, opts) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function addCyl(parent, rTop, rBot, h, color, x, y, z, opts) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, 16), mat(color, opts));
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// ---- furniture (each faces local +Z) ----

function makeSofa(width, color) {
  const g = new THREE.Group();
  const dark = shade(color, 0.8);
  addBox(g, width, 0.4, 0.9, color, 0, 0.2, 0);
  addBox(g, width, 0.55, 0.22, dark, 0, 0.675, -0.34);
  addBox(g, 0.22, 0.3, 0.9, dark, -(width / 2 - 0.11), 0.55, 0);
  addBox(g, 0.22, 0.3, 0.9, dark, width / 2 - 0.11, 0.55, 0);
  const n = Math.max(1, Math.round((width - 0.44) / 0.7));
  const cw = (width - 0.44) / n;
  for (let i = 0; i < n; i++) {
    addBox(g, cw - 0.04, 0.12, 0.6, shade(color, 1.15), -((width - 0.44) / 2) + cw * (i + 0.5), 0.46, 0.08);
  }
  return g;
}

function makeBed(blanketColor) {
  const g = new THREE.Group();
  addBox(g, 1.6, 0.35, 2.1, 0x6b4a2b, 0, 0.175, 0);
  addBox(g, 1.6, 0.9, 0.1, 0x5a3d22, 0, 0.45, -1.05);
  addBox(g, 1.5, 0.2, 1.95, 0xf4f1ea, 0, 0.45, 0.02);
  addBox(g, 1.52, 0.08, 1.2, blanketColor, 0, 0.58, 0.35);
  addBox(g, 0.6, 0.12, 0.35, 0xffffff, -0.35, 0.6, -0.8);
  addBox(g, 0.6, 0.12, 0.35, 0xffffff, 0.35, 0.6, -0.8);
  return g;
}

function makeTV() {
  const g = new THREE.Group();
  addBox(g, 1.2, 0.5, 0.4, 0x5b3a22, 0, 0.25, 0);
  addBox(g, 1.1, 0.65, 0.05, 0x0c0c0c, 0, 0.85, 0);
  addBox(g, 1.0, 0.55, 0.01, 0x2255aa, 0, 0.85, 0.03, { emissive: 0x1a3c88, emissiveIntensity: 0.9 });
  addBox(g, 0.1, 0.1, 0.04, 0x222222, 0, 0.55, -0.02);
  return g;
}

function makeTable(w, d, h, color) {
  const g = new THREE.Group();
  addBox(g, w, 0.06, d, color, 0, h - 0.03, 0);
  const lx = w / 2 - 0.06, lz = d / 2 - 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addBox(g, 0.06, h - 0.06, 0.06, shade(color, 0.75), sx * lx, (h - 0.06) / 2, sz * lz);
  }
  return g;
}

function makeChair(color) {
  const g = new THREE.Group();
  addBox(g, 0.45, 0.05, 0.45, color, 0, 0.45, 0);
  addBox(g, 0.45, 0.5, 0.05, color, 0, 0.7, -0.2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addBox(g, 0.05, 0.43, 0.05, shade(color, 0.7), sx * 0.19, 0.215, sz * 0.19);
  }
  return g;
}

function makePlant() {
  const g = new THREE.Group();
  addCyl(g, 0.2, 0.16, 0.4, 0xb5651d, 0, 0.2, 0);
  const leaves = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), mat(0x2f8f3a));
  leaves.position.y = 0.85;
  g.add(leaves);
  return g;
}

function makeLamp() {
  const g = new THREE.Group();
  addCyl(g, 0.18, 0.18, 0.04, 0x333333, 0, 0.02, 0);
  addCyl(g, 0.02, 0.02, 1.4, 0x333333, 0, 0.72, 0);
  const shadeMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.25, 0.3, 16, 1, true),
    mat(0xfff0b0, { emissive: 0xffe08a, emissiveIntensity: 0.6, side: THREE.DoubleSide })
  );
  shadeMesh.position.y = 1.55;
  g.add(shadeMesh);
  return g;
}

function makeBookshelf() {
  const g = new THREE.Group();
  addBox(g, 1.4, 2.0, 0.35, 0x6b4a2b, 0, 1.0, 0);
  const palette = [0xc0392b, 0x2e6fb5, 0xe0b030, 0x2f8f3a, 0x8e44ad, 0xe67e22];
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 8; i++) {
      addBox(g, 0.12, 0.3, 0.08, palette[(i + r * 3) % palette.length], -0.6 + i * 0.17, 0.35 + r * 0.45, 0.18);
    }
  }
  return g;
}

function makeWardrobe() {
  const g = new THREE.Group();
  addBox(g, 1.8, 2.0, 0.6, 0x8a6d4b, 0, 1.0, 0);
  addBox(g, 0.02, 1.9, 0.02, 0x2a1f14, 0, 1.0, 0.31);
  addBox(g, 0.04, 0.25, 0.04, 0xd4af37, -0.1, 1.0, 0.32);
  addBox(g, 0.04, 0.25, 0.04, 0xd4af37, 0.1, 1.0, 0.32);
  return g;
}

function makeFridge() {
  const g = new THREE.Group();
  addBox(g, 0.8, 1.9, 0.7, 0xe8e8ee, 0, 0.95, 0);
  addBox(g, 0.78, 0.02, 0.02, 0x555555, 0, 1.25, 0.36);
  addBox(g, 0.04, 0.5, 0.05, 0x888888, 0.3, 1.5, 0.38);
  addBox(g, 0.04, 0.5, 0.05, 0x888888, 0.3, 0.8, 0.38);
  return g;
}

function makeCounter(len) {
  const g = new THREE.Group();
  addBox(g, len, 0.9, 0.65, 0xa07850, 0, 0.45, 0);
  addBox(g, len + 0.05, 0.05, 0.7, 0x333333, 0, 0.925, 0);
  addBox(g, 0.7, 0.01, 0.4, 0xaaaaaa, -len / 4, 0.955, 0.0);
  return g;
}

function makeDresser() {
  const g = new THREE.Group();
  addBox(g, 0.5, 0.5, 0.4, 0x8a6d4b, 0, 0.25, 0);
  addBox(g, 0.4, 0.02, 0.02, 0xd4af37, 0, 0.3, 0.21);
  return g;
}

function buildWorld() {
  const w = new THREE.Group();
  w.name = "world";

  const place = (g, x, z, rotY = 0) => {
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    w.add(g);
    return g;
  };

  // Ground slab under the whole house
  addBox(w, 20, 0.1, 12, 0x4a5a45, 0, -0.1, 0);

  const ROOMS = [
    { x0: -9, x1: -3, floor: 0xb88a5a, wall: 0xe8d9a8 }, // living room
    { x0: -3, x1: 3, floor: 0x7f93aa, wall: 0xb9d3e6 }, // bedroom
    { x0: 3, x1: 9, floor: 0xd8d6c8, wall: 0xc9e0c0 }, // kitchen / dining
  ];
  const DIV = 0xf2f2f2;

  const wallH = (xa, xb, z, color) =>
    addBox(w, xb - xa, WALL_H, WALL_T, color, (xa + xb) / 2, WALL_H / 2, z);
  const wallV = (x, za, zb, color) =>
    addBox(w, WALL_T, WALL_H, zb - za, color, x, WALL_H / 2, (za + zb) / 2);

  ROOMS.forEach((r, i) => {
    const pad = WALL_T / 2;
    addBox(w, r.x1 - r.x0, 0.05, HOUSE.z1 - HOUSE.z0, r.floor, (r.x0 + r.x1) / 2, -0.025, 0);
    const xa = r.x0 - (i === 0 ? pad : 0);
    const xb = r.x1 + (i === ROOMS.length - 1 ? pad : 0);
    wallH(xa, xb, HOUSE.z0, r.wall); // north
    wallH(xa, xb, HOUSE.z1, r.wall); // south
  });
  wallV(HOUSE.x0, HOUSE.z0 - WALL_T / 2, HOUSE.z1 + WALL_T / 2, ROOMS[0].wall); // west
  wallV(HOUSE.x1, HOUSE.z0 - WALL_T / 2, HOUSE.z1 + WALL_T / 2, ROOMS[2].wall); // east

  // Divider x = -3, door at z in [1.3, 2.7]
  wallV(-3, HOUSE.z0, 1.3, DIV);
  wallV(-3, 2.7, HOUSE.z1, DIV);
  addBox(w, WALL_T, 0.4, 1.4, DIV, -3, 2.4, 2.0);
  // Divider x = 3, door at z in [-2.7, -1.3]
  wallV(3, HOUSE.z0, -2.7, DIV);
  wallV(3, -1.3, HOUSE.z1, DIV);
  addBox(w, WALL_T, 0.4, 1.4, DIV, 3, 2.4, -2.0);

  // ---------------- Living room (x -9..-3) ----------------
  addBox(w, 3.2, 0.02, 2.4, 0x8b3a3a, -6, 0.011, -2.0); // rug
  place(makeTV(), -6, -4.7, 0);
  place(makeSofa(2.2, 0x2f5d8a), -6, -0.6, Math.PI);
  place(makeTable(1.0, 0.5, 0.4, 0xc9a66b), -6, -2.2);
  place(makeSofa(0.9, 0x5a7a3a), -8.1, -2.4, Math.PI / 2); // armchair
  place(makeSofa(2.0, 0x9a4a2a), -8.3, 2.8, Math.PI / 2);
  place(makeBookshelf(), -8.8, -4.0, Math.PI / 2);
  place(makePlant(), -3.6, -4.4);
  place(makeLamp(), -3.7, 4.3);
  addBox(w, 1.6, 0.9, 0.04, 0xd08030, -6, 1.6, HOUSE.z1 - WALL_T / 2 - 0.02); // painting

  // ---------------- Bedroom (x -3..3) ----------------
  addBox(w, 3.0, 0.02, 2.0, 0xc9b458, 0, 0.011, 0.5); // rug
  place(makeBed(0xc0392b), -1.5, -3.9);
  place(makeBed(0x2e6fb5), 1.5, -3.9);
  place(makeDresser(), 0, -4.7);
  addCyl(w, 0.08, 0.1, 0.25, 0xffe08a, 0, 0.63, -4.7, { emissive: 0xffd060, emissiveIntensity: 0.7 });
  place(makeWardrobe(), -1.5, 4.65, Math.PI);
  place(makeTV(), 1.5, 4.6, Math.PI);
  place(makePlant(), 2.5, -0.4);

  // ---------------- Kitchen / dining (x 3..9) ----------------
  place(makeFridge(), 8.5, -4.4, -Math.PI / 2);
  place(makeCounter(3.0), 8.6, -2.4, -Math.PI / 2);
  place(makeTable(1.8, 1.0, 0.75, 0xb08850), 6.2, 0.6);
  for (const cx of [5.6, 6.8]) {
    place(makeChair(0x3a6ea5), cx, -0.35, 0);
    place(makeChair(0x3a6ea5), cx, 1.55, Math.PI);
  }
  place(makeSofa(1.8, 0x7b3fa0), 5.5, -2.0, Math.PI);
  place(makeTV(), 5.5, -4.7, 0);
  place(makePlant(), 3.6, 4.4);
  addBox(w, 1.4, 0.8, 0.04, 0x3a8dde, 6, 1.6, HOUSE.z1 - WALL_T / 2 - 0.02); // painting

  return w;
}

function buildBeacon() {
  const g = new THREE.Group();
  g.name = "beacon";
  const R = CONFIRM_RADIUS;

  const discGeo = new THREE.CircleGeometry(R, 48);
  discGeo.rotateX(-Math.PI / 2);
  const disc = new THREE.Mesh(
    discGeo,
    new THREE.MeshBasicMaterial({ color: 0x22ff55, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })
  );
  disc.position.y = 0.03;
  g.add(disc);

  const ringGeo = new THREE.RingGeometry(R - 0.08, R, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x00ff44, side: THREE.DoubleSide }));
  ring.position.y = 0.035;
  g.add(ring);

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 3, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x33ff77, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })
  );
  beam.position.y = 1.5;
  g.add(beam);

  return g;
}

function buildPerson() {
  const g = new THREE.Group();
  g.name = "personMarker";
  personMat = new THREE.MeshStandardMaterial({ color: 0xe02020, emissive: 0x400000, roughness: 0.5 });
  const m = personMat;

  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 10), m);
    leg.position.set(sx * 0.09, 0.2, 0);
    g.add(leg);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.45, 8), m);
    arm.position.set(sx * 0.24, 0.65, 0);
    g.add(arm);
  }
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.32, 4, 10), m);
  torso.position.y = 0.62;
  g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), m);
  head.position.y = 1.05;
  g.add(head);

  // "Nose" cone: shows which way the person looks (+Z).
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.14, 10),
    new THREE.MeshStandardMaterial({ color: 0xffe066, emissive: 0x554400 })
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.05, 0.17);
  g.add(nose);

  return g;
}

// ---------------------------------------------------------------------------
// Scene / main
// ---------------------------------------------------------------------------

function main() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc3e0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.3));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(4, 8, 3);
  scene.add(dir);

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.rotation.order = "YXZ";
  camera.position.set(0, 1.6, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // World group = everything navigable (stays at identity transform).
  world = buildWorld();
  beacon = buildBeacon();
  world.add(beacon);
  scene.add(world);

  setupRigAndControllers();
  setupWim();
  setupDesktopControls();

  placeHeadAt(START_POS.x, START_POS.z);
  startTrial();
  renderer.setAnimationLoop(animate);
}

// ---------------------------------------------------------------------------
// Rig, controllers, WebXR
// ---------------------------------------------------------------------------

const XR_EXIT_BUTTON_INDEX = 4; // left-controller X
let xrExitButtonWasDown = false;
let spawnFramesLeft = 0;
let vrStatusHud = null;

function setupRigAndControllers() {
  renderer.xr.enabled = true;
  document.body.appendChild(VRButton.createButton(renderer));

  xrRig = new THREE.Group();
  xrRig.name = "xrRig";
  scene.add(xrRig);
  xrRig.add(camera);

  controllers.push(setupController(0, 0xff6666));
  controllers.push(setupController(1, 0x66aaff));

  buildVrStatusHud();

  renderer.xr.addEventListener("sessionstart", () => {
    // Wait a couple of frames so the headset pose is valid, then place the head.
    spawnFramesLeft = 3;
    trialActive = false;
  });

  renderer.xr.addEventListener("sessionend", () => {
    cancelDrag();
    spawnFramesLeft = 0;
    camera.position.set(0, 1.6, 0);
    camera.quaternion.identity();
    placeHeadAt(START_POS.x, START_POS.z);
    xrExitButtonWasDown = false;
    startTrial();
  });
}

function setupController(index, color) {
  const controller = renderer.xr.getController(index);
  controller.userData.handedness = "none";
  controller.userData.connected = false;
  controller.addEventListener("connected", (e) => {
    controller.userData.handedness = e.data.handedness;
    controller.userData.connected = true;
  });
  controller.addEventListener("disconnected", () => {
    controller.userData.handedness = "none";
    controller.userData.connected = false;
  });
  controller.addEventListener("selectstart", onSelectStart);
  controller.addEventListener("selectend", onSelectEnd);
  controller.addEventListener("squeezestart", onSqueezeConfirm);
  xrRig.add(controller);

  const grip = renderer.xr.getControllerGrip(index);
  grip.userData.handedness = "none";
  grip.addEventListener("connected", (e) => { grip.userData.handedness = e.data.handedness; });
  grip.addEventListener("disconnected", () => { grip.userData.handedness = "none"; });
  grip.add(new THREE.Mesh(new THREE.SphereGeometry(0.025, 12, 8), new THREE.MeshBasicMaterial({ color })));
  xrRig.add(grip);

  controller.userData.grip = grip;
  return controller;
}

function isLeftControllerXDown(session) {
  for (const source of session.inputSources) {
    if (source.handedness !== "left") continue;
    const gp = source.gamepad;
    if (!gp || gp.buttons.length <= XR_EXIT_BUTTON_INDEX) continue;
    if (gp.buttons[XR_EXIT_BUTTON_INDEX].pressed) return true;
  }
  return false;
}

function updateVrExitButton() {
  if (!renderer.xr.isPresenting) { xrExitButtonWasDown = false; return; }
  const session = renderer.xr.getSession();
  if (!session) return;
  const xDown = isLeftControllerXDown(session);
  if (xDown && !xrExitButtonWasDown) session.end();
  xrExitButtonWasDown = xDown;
}

function onSqueezeConfirm() {
  if (!renderer.xr.isPresenting) return;
  tryConfirm();
}

// ---------------------------------------------------------------------------
// Head / rig helpers
// ---------------------------------------------------------------------------

/** Move the rig so the head (camera) is at world (x, z). Height untouched. */
function placeHeadAt(x, z) {
  camera.getWorldPosition(_head);
  xrRig.position.x += x - _head.x;
  xrRig.position.z += z - _head.z;
  xrRig.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// WIM (World-in-Miniature)
// ---------------------------------------------------------------------------

function setupWim() {
  // Clone AFTER the world (incl. beacon) is fully built. Lights are not part of
  // `world`, so none are cloned. The rig is not part of `world` either.
  mini = world.clone(true);
  mini.scale.setScalar(WIM_SCALE);

  // Person marker, in mini-local (== world) coordinates.
  marker = buildPerson();
  marker.scale.setScalar(MARKER_HEIGHT / PERSON_MODEL_HEIGHT / WIM_SCALE); // undo the shrink
  mini.add(marker);

  miniHolder = new THREE.Group();
  miniHolder.add(mini);
  miniHolder.visible = false;

  syncMiniBeacon();
}

function syncMiniBeacon() {
  if (!mini) return;
  const b = mini.getObjectByName("beacon");
  if (!b) return;
  b.position.copy(beacon.position);
  b.scale.set(MINI_BEACON_BOOST, 1, MINI_BEACON_BOOST); // easier to see in the hand
}

function getLeftGrip() {
  for (const c of controllers) {
    if (c.userData.connected && c.userData.handedness === "left") return c.userData.grip;
  }
  return null;
}

function getGrabController() {
  return controllers.find((c) => c.userData.connected && c.userData.handedness !== "left") || null;
}

function updateMiniParent() {
  let desired = null;
  if (renderer.xr.isPresenting) {
    desired = getLeftGrip();
    miniHolder.position.set(0, 0.12, -0.05);
    miniHolder.rotation.set(0, 0, 0);
  } else {
    // Desktop debug: fixed HUD-like placement at lower-left of the view.
    desired = camera;
    miniHolder.position.set(-0.22, -0.2, -0.6);
    miniHolder.rotation.set(0.5, 0, 0);
  }
  if (desired) {
    if (miniHolder.parent !== desired) desired.add(miniHolder);
  } else if (miniHolder.parent) {
    miniHolder.removeFromParent();
  }
}

function syncMarkerToHead() {
  camera.getWorldPosition(_head);
  world.worldToLocal(_tmp.copy(_head)); // world is identity, kept for clarity
  marker.position.set(_tmp.x, 0, _tmp.z);

  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() > 1e-4) marker.rotation.y = Math.atan2(_fwd.x, _fwd.z);
}

function markerCenterWorld(out) {
  out.set(0, PERSON_MODEL_HEIGHT / 2, 0);
  marker.localToWorld(out);
  return out;
}

const _grabPos = new THREE.Vector3();
const _markerPos = new THREE.Vector3();

function onSelectStart(event) {
  const c = event.target;
  if (currentMapping() !== "wim") return;
  if (c.userData.handedness === "left") return; // left hand holds the miniature
  c.userData.grip.getWorldPosition(_grabPos);
  markerCenterWorld(_markerPos);
  if (_grabPos.distanceTo(_markerPos) <= GRAB_RADIUS) {
    dragController = c;
  }
}

function onSelectEnd(event) {
  if (event.target === dragController) releaseMarker();
}

function cancelDrag() {
  dragController = null;
}

/** Marker released: the head lands on the marker (not the rig origin). */
function releaseMarker() {
  dragController = null;
  marker.position.y = 0; // keep it on the floor

  const target = world.localToWorld(marker.position.clone());
  camera.getWorldPosition(_head);
  xrRig.position.x += target.x - _head.x;
  xrRig.position.z += target.z - _head.z;
  xrRig.updateMatrixWorld(true);

  console.log("[WIM] jump to", target.x.toFixed(2), target.z.toFixed(2));
}

function updateWim() {
  const active = currentMapping() === "wim";
  miniHolder.visible = active;
  updateMiniParent();
  if (!active) { dragController = null; return; }

  if (dragController) {
    // Follow the controller (projected onto the floor, upright), clamped to the house.
    dragController.userData.grip.getWorldPosition(_grabPos);
    mini.worldToLocal(_tmp.copy(_grabPos));
    marker.position.set(
      THREE.MathUtils.clamp(_tmp.x, HOUSE.x0 + 0.2, HOUSE.x1 - 0.2),
      THREE.MathUtils.clamp(_tmp.y, 0, 3),
      THREE.MathUtils.clamp(_tmp.z, HOUSE.z0 + 0.2, HOUSE.z1 - 0.2)
    );
    // keep heading in sync while dragging
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() > 1e-4) marker.rotation.y = Math.atan2(_fwd.x, _fwd.z);
    personMat.emissive.setHex(0xaa5500);
  } else {
    syncMarkerToHead();
    // hover highlight
    let hover = false;
    const c = getGrabController();
    if (c && renderer.xr.isPresenting) {
      c.userData.grip.getWorldPosition(_grabPos);
      markerCenterWorld(_markerPos);
      hover = _grabPos.distanceTo(_markerPos) <= GRAB_RADIUS;
    }
    personMat.emissive.setHex(hover ? 0x884400 : 0x400000);
  }
}

// ---------------------------------------------------------------------------
// Joystick locomotion (+ WASD for desktop debugging)
// ---------------------------------------------------------------------------

const keysDown = new Set();

function getMoveInput() {
  if (renderer.xr.isPresenting) {
    if (currentMapping() !== "joystick") return null;
    const session = renderer.xr.getSession();
    if (!session) return null;
    for (const src of session.inputSources) {
      if (src.handedness !== "left" || !src.gamepad) continue;
      const a = src.gamepad.axes;
      // xr-standard: axes[2], axes[3] = thumbstick (axes[0..1] = touchpad)
      return a.length >= 4 ? { x: a[2], y: a[3] } : { x: a[0] || 0, y: a[1] || 0 };
    }
    return null;
  }
  // Desktop debugging only.
  let x = 0, y = 0;
  if (keysDown.has("KeyW")) y -= 1;
  if (keysDown.has("KeyS")) y += 1;
  if (keysDown.has("KeyA")) x -= 1;
  if (keysDown.has("KeyD")) x += 1;
  return { x, y };
}

function updateLocomotion(delta) {
  const input = getMoveInput();
  if (!input) return;
  const mag = Math.hypot(input.x, input.y);
  if (mag < JOYSTICK_DEADZONE) return;
  const k = Math.min(1, (mag - JOYSTICK_DEADZONE) / (1 - JOYSTICK_DEADZONE)) / mag;
  const ix = input.x * k;
  const iy = input.y * k;

  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-4) return;
  _fwd.normalize();
  _right.set(-_fwd.z, 0, _fwd.x);

  xrRig.position.addScaledVector(_fwd, -iy * JOYSTICK_SPEED * delta);
  xrRig.position.addScaledVector(_right, ix * JOYSTICK_SPEED * delta);
}

// ---------------------------------------------------------------------------
// Desktop debug controls (mouse look + WASD)
// ---------------------------------------------------------------------------

let yaw = 0, pitch = 0, lookDragging = false;

function setupDesktopControls() {
  const el = renderer.domElement;
  el.addEventListener("pointerdown", () => { lookDragging = true; });
  window.addEventListener("pointerup", () => { lookDragging = false; });
  window.addEventListener("pointermove", (e) => {
    if (!lookDragging || renderer.xr.isPresenting) return;
    yaw -= e.movementX * 0.004;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.004, -1.4, 1.4);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    keysDown.add(e.code);
  }, true);
  document.addEventListener("keyup", (e) => keysDown.delete(e.code), true);
}

function updateDesktopCamera() {
  if (renderer.xr.isPresenting) return;
  camera.rotation.set(pitch, yaw, 0, "YXZ");
}

// ---------------------------------------------------------------------------
// HUD references
// ---------------------------------------------------------------------------

const participantIdInput = document.getElementById("participantId");
const mappingSelect = document.getElementById("mappingSelect");
const trialCountEl = document.getElementById("trialCount");
const confirmBtn = document.getElementById("confirmBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const liveErrorsEl = document.getElementById("liveErrors");

const TECHNIQUE_ID = { wim: 1, joystick: 2 };
const TECHNIQUE_NAME = { wim: "WIM", joystick: "Joystick" };

function currentMapping() {
  return mappingSelect.value;
}

// ---------------------------------------------------------------------------
// Trial state machine + instrumentation
//
// path_length rule (same for BOTH techniques): sum of the frame-to-frame
// horizontal (XZ) displacement of the HEAD in world space. That naturally
// includes physical walking, joystick travel and WIM jumps (a jump adds the
// jump distance in a single frame). straight_line_distance = head-to-beacon
// distance (XZ) at the moment the beacon spawns.
// ---------------------------------------------------------------------------

let trialActive = false;
let trialStartTime = performance.now();
let pathLength = 0;
let straightLineDistance = 0;
let lastSpotIndex = -1;
let noticeText = "";
let noticeUntil = 0;

let trialsDone = { wim: 0, joystick: 0 };
let techniqueOrder = []; // order in which techniques were first completed by this participant

const rows = [];
const CSV_HEADER = [
  "participant_id",
  "technique",
  "trial_number",
  "presentation_order",
  "completion_time_s",
  "path_length",
  "straight_line_distance",
  "path_ratio",
];

function distanceToBeacon() {
  camera.getWorldPosition(_head);
  return Math.hypot(_head.x - beacon.position.x, _head.z - beacon.position.z);
}

function spawnBeacon() {
  camera.getWorldPosition(_head);
  let candidates = [];
  SPAWN_SPOTS.forEach(([x, z], i) => {
    if (i !== lastSpotIndex && Math.hypot(x - _head.x, z - _head.z) >= MIN_BEACON_DIST) candidates.push(i);
  });
  if (candidates.length === 0) {
    // Fallback: the 3 farthest spots.
    candidates = SPAWN_SPOTS
      .map(([x, z], i) => ({ i, d: Math.hypot(x - _head.x, z - _head.z) }))
      .filter((o) => o.i !== lastSpotIndex)
      .sort((a, b) => b.d - a.d)
      .slice(0, 3)
      .map((o) => o.i);
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  lastSpotIndex = pick;
  beacon.position.set(SPAWN_SPOTS[pick][0], 0, SPAWN_SPOTS[pick][1]);
  syncMiniBeacon();
}

function trialLabel() {
  const m = currentMapping();
  const n = trialsDone[m] + 1;
  const tag = n > TRIALS_PER_TECHNIQUE ? `extra #${n}` : `Trial ${n}/${TRIALS_PER_TECHNIQUE}`;
  return `${TECHNIQUE_NAME[m]} — ${tag}`;
}

function startTrial() {
  spawnBeacon();
  camera.getWorldPosition(_head);
  straightLineDistance = Math.hypot(_head.x - beacon.position.x, _head.z - beacon.position.z);
  pathLength = 0;
  _lastHeadXZ.set(_head.x, _head.z);
  trialStartTime = performance.now();
  trialActive = true;
  trialCountEl.textContent = trialLabel();
}

function showNotice(text) {
  noticeText = text;
  noticeUntil = performance.now() + 1500;
}

function tryConfirm() {
  if (!trialActive) return;
  if (distanceToBeacon() > CONFIRM_RADIUS) {
    showNotice("Outside the circle");
    return;
  }
  confirmTrial();
}

function confirmTrial() {
  const mapping = currentMapping();
  const completionTimeS = (performance.now() - trialStartTime) / 1000;

  if (!techniqueOrder.includes(mapping)) techniqueOrder.push(mapping);
  trialsDone[mapping] += 1;

  const ratio = straightLineDistance > 0 ? pathLength / straightLineDistance : NaN;

  rows.push({
    participant_id: participantIdInput.value.trim() || "UNKNOWN",
    technique: TECHNIQUE_ID[mapping],
    trial_number: trialsDone[mapping],
    presentation_order: techniqueOrder.indexOf(mapping) + 1,
    completion_time_s: completionTimeS.toFixed(3),
    path_length: pathLength.toFixed(3),
    straight_line_distance: straightLineDistance.toFixed(3),
    path_ratio: ratio.toFixed(3),
  });
  console.log("[trial]", rows[rows.length - 1]);

  startTrial();
}

confirmBtn.addEventListener("click", tryConfirm);
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryConfirm();
});

participantIdInput.addEventListener("change", () => {
  trialsDone = { wim: 0, joystick: 0 };
  techniqueOrder = [];
  startTrial();
});

mappingSelect.addEventListener("change", () => {
  mappingSelect.blur();
  keysDown.clear();
  cancelDrag();
  startTrial(); // fresh beacon / timer for the new technique
});

// ---------------------------------------------------------------------------
// CSV download
// ---------------------------------------------------------------------------

function buildCsv() {
  const lines = [CSV_HEADER.join(",")];
  for (const row of rows) lines.push(CSV_HEADER.map((k) => row[k]).join(","));
  return lines.join("\n");
}

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([buildCsv()], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const pid = participantIdInput.value.trim() || "UNKNOWN";
  a.href = url;
  a.download = `a3_${pid}_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// Status (DOM + in-VR HUD): distance to target, green when inside the circle
// ---------------------------------------------------------------------------

function buildVrStatusHud() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 72;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.38, 0.054, 1);
  sprite.position.set(0, 0.38, -0.72);
  sprite.renderOrder = 999;
  sprite.visible = false;
  camera.add(sprite);
  vrStatusHud = { canvas, ctx, texture, sprite, lastKey: "" };
}

function updateVrStatusHud(text, inside) {
  if (!vrStatusHud) return;
  const { canvas, ctx, texture, sprite } = vrStatusHud;
  const inSession = renderer.xr.isPresenting;
  sprite.visible = inSession;
  if (!inSession) return;

  const key = text + inside;
  if (key === vrStatusHud.lastKey) return;
  vrStatusHud.lastKey = key;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = inside ? "rgba(30,90,45,0.92)" : "rgba(20,20,26,0.88)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "600 30px system-ui, sans-serif";
  ctx.fillStyle = inside ? "#9f9" : "#eee";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 14, canvas.height / 2);
  texture.needsUpdate = true;
}

function updateStatus() {
  const d = distanceToBeacon();
  const inside = d <= CONFIRM_RADIUS;

  let text = `dist ${d.toFixed(2)} m` + (inside ? "  IN TARGET" : "");
  if (performance.now() < noticeUntil) text = noticeText;

  statusEl.textContent = text;
  statusEl.classList.toggle("in-tolerance", inside);

  if (liveErrorsEl) {
    liveErrorsEl.textContent = `${trialLabel()} | ${text}`;
    liveErrorsEl.classList.toggle("in-tolerance", inside);
    liveErrorsEl.style.display = renderer.xr.isPresenting ? "none" : "";
  }

  const vrText = `${TECHNIQUE_NAME[currentMapping()]} ${trialsDone[currentMapping()] + 1}/${TRIALS_PER_TECHNIQUE} | ${text}`;
  updateVrStatusHud(vrText, inside);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function animate() {
  const delta = Math.min(clock.getDelta(), 0.1);

  // Place the head at the start position a few frames after the XR session begins.
  if (spawnFramesLeft > 0 && renderer.xr.isPresenting) {
    spawnFramesLeft--;
    if (spawnFramesLeft === 0) {
      placeHeadAt(START_POS.x, START_POS.z);
      startTrial();
    }
  }

  updateDesktopCamera();
  updateLocomotion(delta);
  updateWim();
  updateVrExitButton();

  // Path length: head displacement in the XZ plane, same rule for both techniques.
  camera.getWorldPosition(_head);
  if (trialActive) {
    pathLength += Math.hypot(_head.x - _lastHeadXZ.x, _head.z - _lastHeadXZ.y);
  }
  _lastHeadXZ.set(_head.x, _head.z);

  updateStatus();
  renderer.render(scene, camera);
}

main();
