---
name: operable-vehicle-mesh
description: Use when building an operable 3D vehicle in Three.js — mesh assembly from named primitives (body, wheels, paddle, etc.), input-driven animation patterns (steering wheel rotation, throttle, paddle stroke phase from key state), damage/wear visual state, and car↔kayak shared structure where the only material difference is surface contact (sample-and-stick vs float-and-rock). Includes the third-person follow camera. Skip for non-operable scenery models, physics-engine vehicles, or pure terrain rendering.
---

# Operable Vehicle Mesh

The skill is about the **vehicle**: how it's assembled from named primitives, how player input maps to per-frame animation of named sub-groups, how damage/wear shows up as visual mutations, and how a car and a kayak are the same skill — the only material difference is **what `surfaceY(x, z)` returns**. Terrain is incidental; the vehicle is the artifact.

Read in order: §1 mesh-as-Group is the foundation everything else depends on. §2 input-mapping and §3 paddle modes are the animation grammar. §4 damage is the same grammar applied to materials. §5 car↔kayak is where the symmetry pays off. §6 follow camera is a one-pager. §7 worked example is a single ~120-line sketch that demonstrates the whole pattern.

## 1. The mesh-as-Group pattern

Build the vehicle as a `THREE.Group` with **named, animatable children stashed on `userData`**. The animation loop reaches for parts by role, not by traversal:

```js
function buildVehicle() {
  const g = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a6a3a, flatShading: true });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 3.6), bodyMat);
  body.position.y = 0.9; g.add(body);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 1.8), bodyMat.clone());
  cab.position.set(0, 1.7, 0.3); g.add(cab);

  // Sub-groups that get animated independently
  const frontWheelPivot = new THREE.Group();
  frontWheelPivot.position.z = -1.2;
  g.add(frontWheelPivot);

  const wheels = [];
  for (const [x, z, parent] of [
    [-1.25, 1.2, g], [1.25, 1.2, g],                          // rear (fixed)
    [-1.25, 0,  frontWheelPivot], [1.25, 0, frontWheelPivot], // front (steers)
  ]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14), wheelMat);
    w.position.set(x, 0.55, z); w.rotation.z = Math.PI/2;
    parent.add(w); wheels.push(w);
  }

  // Stash refs the animation loop will reach for
  g.userData = {
    body, cab, bodyMat,
    baseColor: bodyMat.color.clone(),
    allMats: [bodyMat, cab.material],
    wheels,                    // [4] — all four spin from speed
    frontWheelPivot,           // car: yaw on steering input
    paddlePivot: null,         // kayak: filled in by buildKayak()
  };
  return g;
}
```

Why this beats anonymous traversal:

- The animation loop reads `vehicle.userData.wheels[0].rotation.x += rate * dt` directly — O(1).
- `traverse(node => if (node.name === 'wheel-fl') ...)` is O(meshes) per frame and brittle to renames.
- Stashing material refs (`bodyMat`, `allMats`) lets damage code mutate without re-finding them.
- A child can live in two places conceptually (e.g. `cab` is both a body panel for damage AND part of the car's silhouette). `userData` lets you label without restructuring the parent/child tree.

The same shape works for the kayak — different children (`paddlePivot`, `paddleBlades`, `cockpit`, `hull`), same `userData` discipline.

## 2. Input → animation mapping

Three layers, in order: **keys → state → mutation**. Don't read keys directly inside `mesh.rotation.x = ...`; that couples controls to rendering and breaks the second you want to drive the vehicle from a slider, an AI, or a recorded replay.

```js
// Layer 1: raw keys
const keys = {};
addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
addEventListener('keyup',   e => keys[e.key.toLowerCase()] = false);

// Layer 2: per-frame state derived from keys
const state = {
  speed: 0,           // 0..1 throttle integrator
  steer: 0,           // -1..1 with springback
  wheelRot: 0,        // accumulator
  paddlePhase: 0,     // accumulator, kayak only
};

function updateState(dt) {
  // Throttle: W accelerates, drag decays
  if (keys['w']) state.speed = Math.min(1, state.speed + 2 * dt);
  state.speed *= 1 - 0.6 * dt;

  // Steering: A/D push toward ±1, no input springs back to 0
  const target = (keys['d'] ? 1 : 0) - (keys['a'] ? 1 : 0);
  state.steer += (target - state.steer) * Math.min(1, 8 * dt);

  // Accumulators
  state.wheelRot    += state.speed * 8 * dt;
  state.paddlePhase += state.speed * 5.5 * dt;
}

// Layer 3: mutate the mesh
function applyState(g) {
  for (const w of g.userData.wheels) w.rotation.x = state.wheelRot;
  if (g.userData.frontWheelPivot)
    g.userData.frontWheelPivot.rotation.y = state.steer * 0.5;     // clamp to ~30°
  if (g.userData.paddlePivot)
    g.userData.paddlePivot.rotation.z = paddleModes[mode](state.paddlePhase, keys);
}
```

The springback on `steer` (`(target - state.steer) * k * dt`) is the single most common idiom in input-driven animation — it gives "wheel returns to center when you let go" without any extra logic. Use it for steering wheel angle, throttle pedals, brake pedals, leaning, anything that has a rest position.

For a slider-driven studio (no keys), skip layer 1 and write directly into `state` from the slider's `input` event. Layers 2 and 3 don't change.

## 3. Paddle stroke modes

Paddle animation is the kayak's signature — a `THREE.Group` (`paddlePivot`) whose `rotation.z` is the stroke. Each mode is a tiny function `(phase, keys) → targetRotation`. The frame loop lerps the current rotation toward the target with a "dip response" stiffness so dips feel weighted, not snappy:

```js
state.paddleRot += (target - state.paddleRot) * Math.min(1, dt * LERP);  // LERP=16 responsive, 8 loose
paddlePivot.rotation.z = state.paddleRot;
```

Four interchangeable modes — pick by feel, not correctness:

```js
const SWAY = 0.65, STROKE = 5.5;
const isDown = (...ks) => ks.some(k => keys[k]);

const paddleModes = {
  // Continuous oscillation regardless of input. Always alive, doesn't show key state.
  sine: (phase, keys) => Math.sin(phase * STROKE) * SWAY,

  // Held key plants paddle on that side. Arcade-readable.
  'hold-side': (phase, keys) => {
    if (isDown('a')) return +SWAY;       // A → paddle dips LEFT
    if (isDown('d')) return -SWAY;       // D → paddle dips RIGHT
    if (isDown('w')) return Math.sin(phase * STROKE) * SWAY;
    return Math.sin(phase * 1.2) * SWAY * 0.18;            // idle breathing
  },

  // Like hold-side but no idle sway — cleaner rest pose.
  alternating: (phase, keys) => {
    if (isDown('a')) return +SWAY;
    if (isDown('d')) return -SWAY;
    if (isDown('w')) return Math.sin(phase * STROKE) * SWAY;
    return 0;
  },

  // Realistic: turn LEFT by paddling on the RIGHT (right blade pulls nose left).
  opposite: (phase, keys) => {
    if (isDown('a')) return -SWAY;       // left turn → right-side dip
    if (isDown('d')) return +SWAY;       // right turn → left-side dip
    if (isDown('w')) return Math.sin(phase * STROKE) * SWAY;
    return 0;
  },
};
```

Choosing:
- **`opposite`** for sims — matches real cause-and-effect.
- **`hold-side`** for arcade — players expect paddle on the same side as the held key.
- **`alternating`** when you want a clean idle (no breathing motion).
- **`sine`** for cinematic / always-paddling NPCs.

The four modes are *mappings*, not behaviors. They read identical state and produce a single number. Swap them at runtime by changing `mode` — no mesh rebuild, no state reset. Choice is feel, not correctness; ship a select element, let the designer audition them.

## 4. Damage / wear visual state

A scalar `stability ∈ [0, 1]` (1 = pristine, 0 = wrecked) drives a single function that walks `userData` and mutates materials and transforms. **Idempotent** — calling it twice with the same input yields the same result, no compounding:

```js
function applyDamageVisuals(g, stability) {
  const d = 1 - stability;     // 0 pristine → 1 wrecked
  const ud = g.userData;

  // 1. Tint body toward burnt brown
  ud.bodyMat.color.copy(
    ud.baseColor.clone().lerp(new THREE.Color(0x3a2a15), d * 0.5)
  );
  ud.bodyMat.roughness = 0.6 + d * 0.3;

  // 2. Dent the hood — scale Y toward 0.85
  if (ud.hood) ud.hood.scale.y = 1 - d * 0.15;

  // 3. Drop opacity on the cab to read as broken
  if (ud.cab) {
    ud.cab.material.transparent = d > 0;
    ud.cab.material.opacity = 1 - d * 0.4;
  }

  // 4. Sympathetic roughness on every other material
  for (const m of ud.allMats) if (m !== ud.bodyMat) m.roughness = 0.6 + d * 0.3;
}
```

Three rules:
1. **Read base values from `userData`**, not from the live material. `baseColor` is captured once at build time; the live `color` is what you mutate. Otherwise you can't recover from `stability=0` back to `stability=1`.
2. **Idempotent**. Each line is *a function of* `d`, not an increment. `applyDamageVisuals(g, 0.5)` then `applyDamageVisuals(g, 0.5)` produces the same scene as one call.
3. **Visual mutations only**. No geometry rebuild, no `add`/`remove` of children. The collision shape, raycast targets, and child indices stay stable.

`stability` is also a great hook for non-visual feedback: distortion on the engine audio, screen-shake amplitude, particle spawn rate. Drive everything from one scalar.

## 5. Car ↔ Kayak as one skill

The two vehicles share **mesh assembly, input mapping, follow camera, damage**. The only material difference is what `surfaceY(x, z)` returns:

```js
function surfaceY(x, z, mode, t) {
  if (mode === 'car')   return sampleHeight(x, z);                 // terrain heightmap
  if (mode === 'kayak') return Math.sin(t * 1.7) * 0.04            // bob
                             + Math.sin(t * 0.6 + x*0.3) * 0.02;   // surface wave
}
```

And how tilt is computed:
- **Car (sample-and-stick)**: pitch/roll from finite-difference samples of the heightmap. The terrain dictates tilt.
- **Kayak (float-and-rock)**: pitch/roll from stroke phase + lateral speed. The vehicle dictates tilt.

```js
function applyTilt(g, x, z, fwd, t, mode) {
  const y = surfaceY(x, z, mode, t);
  g.position.set(x, y + RIDE_HEIGHT, z);
  if (mode === 'car') {
    const ds = 1.0;
    const yF = surfaceY(x + fwd.x*ds, z + fwd.z*ds, mode, t);
    const yS = surfaceY(x - fwd.z*ds, z + fwd.x*ds, mode, t);
    g.rotation.set(
      -Math.atan2(yF - y, ds) * 0.15,    // pitch (TILT_SCALE = 0.15)
      heading,
       Math.atan2(yS - y, ds) * 0.15,    // roll
      'YXZ'
    );
  } else {
    g.rotation.set(
      Math.sin(state.paddlePhase * 5.5) * 0.04,           // bob pitch
      heading,
      -state.lateralSpeed * 2.2,                          // lean into turn
      'YXZ'
    );
  }
}
```

Mesh assembly stays in two `buildCar()` / `buildKayak()` factories that produce the same `userData` shape (with different sub-groups). Input mapping reads `state.speed` and `state.steer`; the apply step branches on `mode` to pick which sub-group to wiggle. The follow camera doesn't care.

This is what makes it one skill: **`mode` is a one-line toggle**, and 90% of the code (mesh discipline, input mapping, follow cam, damage) is shared.

## 6. Follow camera (brief)

Lerp toward `vehicle.position + offset` along the vehicle's forward vector. Keep the lerped vectors persistent (outside the loop) — re-creating them every frame snaps instantly because there's no prior state to interpolate from.

```js
const camPos  = new THREE.Vector3(0, 8, 12);    // persistent across frames
const camLook = new THREE.Vector3();

const fwd = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
const targetCam  = vehicle.position.clone()
  .add(fwd.clone().multiplyScalar(-9))
  .add(new THREE.Vector3(0, 4.5, 0));
const targetLook = vehicle.position.clone().add(fwd.clone().multiplyScalar(2));
camPos.lerp(targetCam,  0.10);
camLook.lerp(targetLook, 0.10);
camera.position.copy(camPos);
camera.lookAt(camLook);
```

Stiffness `0.10` is the natural sweet spot. `0.06` is cinematic / floaty. `0.20` is rigid / turret-like. The TILT_SCALE damping (`0.15` from §5) and the camera stiffness (`0.10`) are the two damping constants you'll tune most.

## 7. Worked example

A single sketch with one vehicle that morphs between car and kayak by toggling a `mode` flag. Flat ground / water disc — no FBM terrain, the vehicle is the point. Demonstrates: mesh-as-Group with named children, input-driven wheel + paddle animation, damage scalar driving visuals, mode toggle.

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Operable vehicle</title>
<style>html,body{margin:0;height:100%;background:#9bb0c0;overflow:hidden}canvas{display:block}</style>
<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js"}}
</script></head><body>
<script type="module">
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9bb0c0, 30, 90);
const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.5, 200);
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xfff4d8, 1.0); sun.position.set(8, 14, 6); scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(40, 48),
  new THREE.MeshStandardMaterial({ color: 0x6d8a5a, flatShading: true })
);
ground.rotation.x = -Math.PI/2; scene.add(ground);

// ─── Mesh-as-Group with named children on userData ───────────
function buildVehicle() {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a6a3a, flatShading: true });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 3.6), bodyMat);
  body.position.y = 0.9; g.add(body);
  const cab  = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.7, 1.8), bodyMat.clone());
  cab.position.set(0, 1.7, 0.3); g.add(cab);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.1, 1.0), bodyMat.clone());
  hood.position.set(0, 1.45, -1.0); g.add(hood);

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222 });
  const frontWheelPivot = new THREE.Group();
  frontWheelPivot.position.z = -1.2; g.add(frontWheelPivot);
  const wheels = [];
  for (const [x, z, parent] of [
    [-1.25,1.2,g],[1.25,1.2,g],
    [-1.25,0,frontWheelPivot],[1.25,0,frontWheelPivot]
  ]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55,0.55,0.4,14), wheelMat);
    w.position.set(x, 0.55, z); w.rotation.z = Math.PI/2;
    parent.add(w); wheels.push(w);
  }

  // Paddle pivot — only used in kayak mode (hidden when mode==='car')
  const paddlePivot = new THREE.Group();
  paddlePivot.position.set(0, 1.5, 0.3); g.add(paddlePivot);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,3.0,8),
    new THREE.MeshStandardMaterial({ color: 0x4a2008 }));
  shaft.rotation.z = Math.PI/2; paddlePivot.add(shaft);
  for (const sx of [-1.4, 1.4]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x5b2f08 }));
    blade.position.x = sx; paddlePivot.add(blade);
  }

  g.userData = {
    body, cab, hood, bodyMat,
    baseColor: bodyMat.color.clone(),
    allMats: [bodyMat, cab.material, hood.material],
    wheels, frontWheelPivot, paddlePivot,
  };
  return g;
}
const vehicle = buildVehicle(); scene.add(vehicle);

// ─── Input → state → mutation ────────────────────────────────
const keys = {};
addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
addEventListener('keyup',   e => keys[e.key.toLowerCase()] = false);
const isDown = (...ks) => ks.some(k => keys[k]);

let mode = 'car';                     // toggle 'car' / 'kayak' with M
let stability = 1;                    // 1 = pristine; [ ] adjust
const state = { x:0, z:0, heading:0, speed:0, steer:0, wheelRot:0, paddlePhase:0, paddleRot:0 };

const SWAY = 0.65, STROKE = 5.5;
const paddleOpposite = (phase) => {
  if (isDown('a')) return -SWAY;
  if (isDown('d')) return +SWAY;
  if (isDown('w')) return Math.sin(phase * STROKE) * SWAY;
  return 0;
};

function applyDamageVisuals(g, stability) {
  const d = 1 - stability, ud = g.userData;
  ud.bodyMat.color.copy(ud.baseColor.clone().lerp(new THREE.Color(0x3a2a15), d * 0.5));
  ud.bodyMat.roughness = 0.6 + d * 0.3;
  ud.hood.scale.y = 1 - d * 0.15;
  ud.cab.material.transparent = d > 0;
  ud.cab.material.opacity = 1 - d * 0.4;
}

const camPos = new THREE.Vector3(0, 6, 12), camLook = new THREE.Vector3();
let last = performance.now();
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now(), dt = Math.min(0.05, (now-last)/1000); last = now;
  const t = now / 1000;

  if (isDown('w')) state.speed = Math.min(1, state.speed + 2 * dt);
  state.speed *= 1 - 0.6 * dt;
  const tgt = (isDown('d') ? 1 : 0) - (isDown('a') ? 1 : 0);
  state.steer += (tgt - state.steer) * Math.min(1, 8 * dt);
  state.heading -= state.steer * state.speed * 1.5 * dt;
  const fx = Math.sin(state.heading), fz = Math.cos(state.heading);
  state.x += fx * state.speed * 4 * dt;
  state.z += fz * state.speed * 4 * dt;

  state.wheelRot    += state.speed * 8 * dt;
  state.paddlePhase += dt;

  // Mode-dependent surface
  const y = mode === 'kayak' ? Math.sin(t * 1.7) * 0.04 : 0;
  vehicle.position.set(state.x, y, state.z);
  vehicle.rotation.set(0, state.heading, mode === 'kayak' ? Math.sin(t*1.5)*0.04 : 0, 'YXZ');

  // Mode-dependent animation
  vehicle.userData.paddlePivot.visible = mode === 'kayak';
  if (mode === 'car') {
    for (const w of vehicle.userData.wheels) w.rotation.x = state.wheelRot;
    vehicle.userData.frontWheelPivot.rotation.y = state.steer * 0.5;
  } else {
    const target = paddleOpposite(state.paddlePhase);
    state.paddleRot += (target - state.paddleRot) * Math.min(1, dt * 16);
    vehicle.userData.paddlePivot.rotation.z = state.paddleRot;
  }
  applyDamageVisuals(vehicle, stability);

  const fwd = new THREE.Vector3(fx, 0, fz);
  camPos.lerp(vehicle.position.clone().add(fwd.multiplyScalar(-9)).add(new THREE.Vector3(0, 4.5, 0)), 0.10);
  camLook.lerp(vehicle.position, 0.10);
  camera.position.copy(camPos); camera.lookAt(camLook);
  renderer.render(scene, camera);
}
frame();

addEventListener('keydown', e => {
  if (e.key === 'm') mode = mode === 'car' ? 'kayak' : 'car';
  if (e.key === '[') stability = Math.max(0, stability - 0.1);
  if (e.key === ']') stability = Math.min(1, stability + 0.1);
});
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
});
</script></body></html>
```

## Pitfalls

- **Don't reach for parts via `traverse()` every frame.** Stash refs in `userData` at build time; the loop reads them by name. `traverse` is for scene-wide passes (shadow casters, debug overlays), not the hot path.
- **`applyDamageVisuals` must be idempotent.** Each line is *a function of* `d`, not an increment. If you write `bodyMat.color.lerp(red, 0.1)` you can never recover.
- **Springback on `steer` is non-negotiable.** Without `(target - state.steer) * k * dt`, the steering wheel never returns to center and the vehicle feels stuck-on at corners.
- **`paddlePivot.rotation.z` lerping toward target** is what gives the dip its weight. A direct assignment looks like Whac-A-Mole.
- **`mode` toggle should not rebuild the mesh.** Hide/show `paddlePivot` and `frontWheelPivot`; branch the per-frame mutation. The vehicle is one Group; modes are two ways to animate it.
- **`camPos` / `camLook` must persist across frames.** Allocating fresh vectors and lerping from them snaps instantly because `lerp(a, b, k)` needs a prior `a`.
- **Material refs in `userData` — stash at build time.** Re-finding via `traverse` is wasteful and silently breaks when meshes are renamed.
