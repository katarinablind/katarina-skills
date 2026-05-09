---
name: highlightable-grass-field
description: Use when building a 3D grass / vegetation field in Three.js where the field brightens and sways near a 3D highlight point (cursor, hand, anchor) — InstancedMesh of PlaneGeometry quads driven by a custom ShaderMaterial that does GLSL simplex-noise wind plus a uCursor-uniform proximity tint, with the per-frame raycast→update wiring. Skip for static scenery grass, 2D grass sprites, or grass that needs CPU-side per-blade hover events.
---

# Highlightable grass field — shader-driven proximity in Three.js

The "tens of thousands of blades that brighten and ripple under your cursor" pattern. One `InstancedMesh` of `PlaneGeometry` quads scattered over an area, and a custom `ShaderMaterial` that does **all** the wind sway and cursor-proximity coloring in GLSL. The only per-frame JS work is updating two uniforms: `uTime` and `uCursor`.

Reference implementation: `tree-music-map/src/scene/GhostGrass.js`. That file scales to 80 000 blades on a laptop because the JS loop never visits a blade after construction — the GPU does the per-vertex work.

## Why shader, not per-instance colors

A naive "InstancedMesh + per-instance colors driven by JS distance loop" approach works up to ~5 000 blades. Past that you're doing tens of thousands of `setColorAt` calls per frame and uploading the whole instance-color buffer every tick. The shader-based approach instead packs distance, sway, and color logic into the vertex+fragment shader. The buffer that changes every frame is a single `vec3 uniform` — three floats, not 240 000.

The skill teaches the shader approach because that's what the project actually does. If your blade count is below ~5 000 and you genuinely need JS-side per-blade hover events (e.g., to fire an audio ping per blade), that's a different pattern — see notes at the end.

## Architecture

```
PlaneGeometry(width, bladeHeight)        ← one shared quad
        │   .translate(0, bladeHeight/2, 0)  ← base at y=0
        ▼
ShaderMaterial { uTime, uCursor, uHeight }  ← uniforms only
        │   transparent: true
        │   depthWrite:  false
        │   blending:    AdditiveBlending
        │   side:        DoubleSide
        ▼
InstancedMesh(quad, mat, COUNT)            ← random xz + random Y rot per instance
        │   .frustumCulled = false         ← bounding sphere is too small otherwise
        ▼
scene.add(...)
```

Per frame:

```
mouse → Raycaster → terrain or ground plane → world-space hit point
                                                       │
                                                       ▼
                                            grass.update(time, hitPoint)
                                                       │
                                                       ▼
                              uTime.value = time;  uCursor.value.copy(hitPoint)
```

That's the whole loop. The vertex shader reads `uCursor`, computes `cursorDist` per vertex, and uses it to push the blade away and bend it; the fragment shader uses the same distance for color/alpha.

## Blade geometry: a quad with the base at y=0

Each blade is a `PlaneGeometry(0.06, 0.7)` translated up so y=0 is the base. The shader will scale `localPos.y *= uHeight` so the blade's tip moves but the root stays planted.

```js
const bladeWidth  = 0.06;
const bladeHeight = 0.7;
const bladeGeo = new THREE.PlaneGeometry(bladeWidth, bladeHeight);
bladeGeo.translate(0, bladeHeight / 2, 0); // base at y=0
```

Single quad, `side: THREE.DoubleSide` so it reads from any orbit angle without a billboard rotation. The fragment shader carves a circular soft-edged ghost dot inside the quad's UV — that's where the soft-blob look comes from, not the quad outline.

## Instance placement

Random xz scatter, random Y rotation per instance for visual variety. Stash the matrix once at construction:

```js
const dummy = new THREE.Object3D();
for (let i = 0; i < count; i++) {
  const x = (Math.random() - 0.5) * area;
  const z = (Math.random() - 0.5) * area;
  dummy.position.set(x, 0, z);
  dummy.rotation.set(0, Math.random() * Math.PI, 0);
  dummy.updateMatrix();
  mesh.setMatrixAt(i, dummy.matrix);
}
mesh.instanceMatrix.needsUpdate = true;
mesh.frustumCulled = false; // crucial: default sphere covers only instance 0
```

The instance matrix carries position **and** rotation — the vertex shader pulls both back out (`instanceMatrix[3].xyz` for position, the upper 3×3 block for rotation) so it can sway the blade in instance-local space and then world-place it.

## The vertex shader: wind + cursor sway

Three octaves of GLSL `snoise` over `(worldX, worldZ, time)` give a rolling breeze + soft turbulence + light flutter. Multiply by `vRelativeHeight^2` so the tip moves but the base stays anchored:

```glsl
float windTotal = wind1 + wind2 + wind3;
float swayStrength = vRelativeHeight * vRelativeHeight * 0.06;
localPos.x += windTotal * swayStrength;
localPos.z += windTotal * swayStrength * 0.6;
```

Cursor sway is layered on top — push the blade radially away from `uCursor` and add some turbulence, with falloff over a `uSwayRadius`-sized region:

```glsl
float cursorDist = length(vec2(worldX - uCursor.x, worldZ - uCursor.z));
float cursorWind = 1.0 - smoothstep(0.0, uSwayRadius, cursorDist);
cursorWind *= cursorWind;
// push direction
float pushX = (cursorDist > 0.1) ? (worldX - uCursor.x) / cursorDist : 0.0;
float pushZ = (cursorDist > 0.1) ? (worldZ - uCursor.z) / cursorDist : 0.0;
float cursorSway = cursorWind * vRelativeHeight * 0.25;
localPos.x += pushX * 0.6 * cursorSway;
localPos.z += pushZ * 0.6 * cursorSway;
```

Apply the instance rotation (3×3 block of `instanceMatrix`) to the swayed local position, then translate by the instance's world xz and the (optional) terrain height. Pass `vCursorDist` as a varying so the fragment shader can color by it.

Edge fade — multiply alpha by `1 - smoothstep(50, 60, max(|x|,|z|))` — kills hard boundaries when the field is finite.

## The fragment shader: ghost dot + green glow

Each quad fragments into a soft circular dot via a UV distance check:

```glsl
float dist = length(vUv - 0.5);
if (dist > 0.5) discard;
float softEdge = smoothstep(0.5, 0.1, dist);
```

Then the cursor proximity drives a mix from a near-black green (`vec3(0.03, 0.08, 0.04)`) to a vivid alive green (`vec3(0.06, 0.28, 0.1)`):

```glsl
float cursorInfluence = 1.0 - smoothstep(0.0, uGlowRadius, vCursorDist);
cursorInfluence *= cursorInfluence;
vec3 color = mix(baseColor, brightGreen, cursorInfluence * 0.9);
color *= 1.0 + cursorInfluence * 0.8;          // brighten near cursor
color = mix(color * 0.6, color, vRelativeHeight * 0.8 + 0.4); // tip brighter
float alpha = vAlpha * softEdge;
alpha = min(alpha + cursorInfluence * 0.35, 1.0);
gl_FragColor = vec4(color, alpha);
```

Material is `transparent: true`, `depthWrite: false`, `blending: THREE.AdditiveBlending`. Additive is what makes the field glow — overlapping blades add their tiny alpha contributions into a soft mass.

## The class shape

```js
export class GhostGrass {
  constructor(scene, { count = 80000, area = 120, height = 0.7 } = {}) {
    this.uniforms = {
      uTime:   { value: 0 },
      uCursor: { value: new THREE.Vector3(0, -100, 0) }, // far-away default
      uHeight: { value: height },
    };
    // ...build geometry, material, InstancedMesh, place instances...
    scene.add(this.mesh);
  }
  update(time, cursorPos) {
    this.uniforms.uTime.value = time;
    if (cursorPos) this.uniforms.uCursor.value.copy(cursorPos);
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
```

Default `uCursor` is `(0, -100, 0)` so before any cursor input the grass reads as fully dormant (the smoothstep returns 0 at that distance).

## The per-frame wiring

In your render loop, raycast the mouse onto whatever the grass sits on — terrain mesh, flat ground plane, water surface — and feed the world-space hit into `grass.update`:

```js
const raycaster = new THREE.Raycaster();
const mouseNDC  = new THREE.Vector2();
let cursorWorld = new THREE.Vector3(), cursorActive = false;

renderer.domElement.addEventListener('pointermove', (e) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObject(groundOrTerrainMesh);
  if (hits.length) { cursorWorld.copy(hits[0].point); cursorActive = true; }
});

function frame() {
  const t = performance.now() / 1000;
  grass.update(t, cursorActive ? cursorWorld : null);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
```

This is exactly the wiring `tree-music-map/src/main.js` uses — raycast against `terrain.mesh`, copy the hit point into the grass uniform.

## Multiple highlight points

`uCursor` is a single `vec3`. To support multiple highlight points (cursor + N hands), declare `uniform vec3 uCursors[N]` and `uniform int uCursorCount`, loop in the shader, and take the **max** of the per-cursor influences (so they don't sum past 1):

```glsl
float maxInfluence = 0.0;
for (int i = 0; i < N; i++) {
  if (i >= uCursorCount) break;
  float d = length(vec2(worldX - uCursors[i].x, worldZ - uCursors[i].z));
  float k = 1.0 - smoothstep(0.0, uGlowRadius, d);
  maxInfluence = max(maxInfluence, k * k);
}
```

Cap N around 8 — past that the shader loop starts to cost. Push a degenerate value like `(0,-1000,0)` for unused slots if you don't want to deal with the count uniform.

## Draping over terrain

`GhostGrass.js` keeps a `terrainY(vec2)` function inside the vertex shader that samples the same simplex noise the terrain mesh uses. This lets each blade sit at the correct height **without** any CPU-side raycast — the GPU computes ground height per blade per frame. Pattern:

```glsl
float terrainY(vec2 p) {
  float e  = snoise(vec3(p.x*0.028, p.y*0.028, 0.0)) * 1.4;
        e += snoise(vec3(p.x*0.059, p.y*0.059, 4.0)) * 0.42;
  return e * 0.3;
}
// ...
vec3 worldPos = rotatedPos + vec3(worldX, terrainY(vec2(worldX, worldZ)), worldZ);
```

The terrain mesh and the grass shader must use the same noise constants, or the grass will float / submerge.

## Tuning knobs that ship

The constructor exposes `count`, `area`, `height`. Other useful knobs you can promote to uniforms:

| Uniform        | What it controls                              | Project default    |
|----------------|------------------------------------------------|--------------------|
| `uHeight`      | Per-blade vertical scale                       | 0.7                |
| `uSwayRadius`  | Vertex-shader push radius near cursor          | 10.0 (in source)   |
| `uGlowRadius`  | Fragment-shader green glow radius              | 14.0 (in source)   |

In the shipped `GhostGrass.js` the radii are hard-coded; promoting them to uniforms is a one-line change and lets the studio expose sliders.

## When this skill doesn't fit

- **JS-side per-blade hover events** — the GPU doesn't tell you which instance is under the cursor. If you need "cursor over blade #3742, fire a callback", you're back to a CPU loop with `setColorAt` and a smaller blade count (~2–5 k).
- **Heavily lit material** — the GhostGrass material is unlit (raw `vec3` math). If you want PBR shading, fork the shader to compose your color into a `MeshStandardMaterial` via `onBeforeCompile`, which is more work.
- **Sprite billboards / cards** — if the blades should always face the camera, you want a billboard quad with a view-aligned vertex transform, not the random Y-rotation pattern here.

## Cross-reference

- For terrain to drape grass onto, pair with `3d-terrain-contours` for the heightmap.
- For audio reactions tied to the cursor's proximity, pair with `proximity-audio-mapping`.
