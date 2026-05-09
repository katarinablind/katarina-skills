---
name: generative-tree-mesh
description: Use when building procedurally-generated 3D tree meshes in Three.js — bundled-strand recursive branching emitted as additive-shader LineSegments, glowing Points-foliage with per-vertex phase, plug-in stylizations (light-particle hero tree, bare-skeleton background tree), and a forest-assembly pattern that places hero trees in named clusters with a backdrop of fixed-position skeleton trees. Includes the species-data contract and the `Math.random()` reroll pattern. Skip for static/imported tree models, voxel trees, or 2D vegetation.
---

# Generative Tree Mesh

Build trees in Three.js as **two cooperating builders, not one**. The same scene fronts a few hero trees built with the rich, animated, light-particle stylization, and *backdrops* them with cheap, deterministic, bare-line trees. Don't use textured cylinder branches and instanced-sphere foliage — that's a different aesthetic. Used in `tree-music-map` to render the forest the camera flies through.

## What "tree" means in this codebase

A tree is **never a solid mesh**. It is:

1. A **bundled-strand wireframe** — recursive branches emitted as multiple parallel `LineSegments` strands per branch, drawn with an additive `ShaderMaterial`. The trunk reads as a *woven cable*, not a cylinder.
2. **Foliage as additive `THREE.Points`** — leaf positions are seeded at the *tips* of the deepest branches, each carrying a per-vertex `aSize` and `aPh` (phase) attribute. The leaf material is an additive sprite shader with breathing/beat uniforms.
3. **Roots** — same recursion as branches but pointing down, with a separate root color and lower fork count.

Optionally, a separate barebones builder produces dim wireframe trees for backdrop. These have no foliage and no glow — they only sway gently — and they're the cheap visual context that surrounds the hero light-trees.

## The two builders

**`LightParticleTree`** — the hero. A `THREE.Group` subclass. Constructor takes a config (height, theme, trunkColor, detail, leafSpread). Three internal recursions populate three `BufferGeometry`s: `trunkPos` (LineSegments), `rootPos` (LineSegments), `leafPos` + `leafSizes` + phase (Points). Each gets its own `ShaderMaterial` with a shared uniform set `{ uTime, uGlow, uBeat }` so a single `tree.update(t, glow, beat)` per frame drives all three layers.

**`SkeletonTree`** — the backdrop. Plain class (not a Group subclass). Takes `(scene, x, z, height, seed)`. Uses a `mulberry32` seeded RNG so the same `seed` always produces the same tree. Builds *one* `BufferGeometry` of LineSegments — every recursive branch is just two more vertices in the same buffer. Vertex shader does subtle wind sway driven by a per-vertex `aHeight` attribute.

Two builders, two aesthetics, one forest scene.

## Recursive branching — strands, not cylinders

Each `growBranch` call emits N parallel line strands offset around the branch axis. That's what makes the trunk look like a *bundle of wires* instead of a tube:

```js
const growBranch = (start, dir, length, iter) => {
  const end = start.clone().add(dir.clone().multiplyScalar(length));
  const strands = this.params.trunkStrands;            // ~8-20
  const radius  = this.params.trunkThickness * (iter / this.params.detail);

  // Emit `strands` parallel line segments around the branch axis
  for (let i = 0; i < strands; i++) {
    const theta = (i / strands) * Math.PI * 2;
    const osX = Math.cos(theta) * radius, osZ = Math.sin(theta) * radius;
    const oeX = Math.cos(theta) * radius * 0.7, oeZ = Math.sin(theta) * radius * 0.7;
    trunkPos.push(start.x + osX, start.y, start.z + osZ,
                  end.x   + oeX, end.y,   end.z   + oeZ);
  }

  if (iter <= 0) {
    // Reached a tip — drop a cluster of leaf positions
    for (let i = 0; i < 20; i++) {
      leafPos.push(
        end.x + (Math.random() - 0.5) * this.params.leafSpread,
        end.y + (Math.random() - 0.5) * this.params.leafSpread,
        end.z + (Math.random() - 0.5) * this.params.leafSpread,
      );
      leafSizes.push(rng() * (sizeMax - sizeMin) + sizeMin);
    }
    return;
  }

  // Two child branches with random axis-rotation deflection
  for (let i = 0; i < 2; i++) {
    const newDir = dir.clone();
    newDir.applyAxisAngle(new THREE.Vector3(1,0,0), (Math.random()-0.5) * angle*3);
    newDir.applyAxisAngle(new THREE.Vector3(0,0,1), (Math.random()-0.5) * angle*3);
    growBranch(end, newDir, length * 0.75, iter - 1);
  }
};
```

Two key choices:

- **Two children per fork**, not three. The strand-bundle look already implies thickness — three forks would make every junction read as a starburst.
- **Length × 0.75** per recursion (faster shrink than the cylinder pattern's 0.6) keeps the silhouette tight.

The radius shrinks with `iter / detail`, so deepest branches are thinnest. At `iter == 0`, the recursion drops 20 leaf positions per tip. Detail of 7 means roughly 128 tips × 20 = 2560 leaves per tree.

## Foliage as additive Points (NOT instanced spheres)

After the recursion finishes, the collected `leafPos` array becomes a single `BufferGeometry` with three attributes:

```js
const leafGeom = new THREE.BufferGeometry();
leafGeom.setAttribute('position', new THREE.Float32BufferAttribute(leafPos,    3));
leafGeom.setAttribute('aSize',    new THREE.Float32BufferAttribute(leafSizes,  1));
const phases = new Float32Array(leafSizes.length);
for (let i = 0; i < phases.length; i++) phases[i] = Math.random() * 6.2832;
leafGeom.setAttribute('aPh',      new THREE.Float32BufferAttribute(phases,     1));
```

The leaf material is a `ShaderMaterial` with `blending: THREE.AdditiveBlending`, `depthWrite: false`, `depthTest: false`. The vertex shader breathes each leaf with `uTime + aPh`, scales by `uGlow + uBeat`, and sets `gl_PointSize` from `aSize`. The fragment shader makes the point a soft round disc. **Don't use IcosahedronGeometry InstancedMesh** — the project's look is bioluminescent, not foliated, and additive points are what produce it.

## The species-data contract

Trees are still a small plain object — but the species table is **only** consulted by the assembly code (which species lives where, what color theme it wears). The geometry builder takes a `theme` config blob, not the full species struct:

```js
// src/data/trees.js — used by assembly
const SPECIES = {
  'douglas-fir':       { label:'Douglas Fir',       category:'conifer',   color:[80,200,140] },
  'western-red-cedar': { label:'Western Red Cedar', category:'conifer',   color:[120,160,220] },
  // ... 8 PNW species, each with category + 0-255 RGB color
};

// LightParticleTree config — consumed by the builder
new LightParticleTree({
  height: 3.0,
  detail: 7,
  theme:      { leaf: '#66ccff', name: 'cyan' },     // one of 6 preset hex leaf colors
  trunkColor: '#446688',                             // optional — picks from 3 trunk styles
  trunkStrands: 12,
  rootColor: '#00a3d7',
});
```

The `SPECIES` table tells the *assembly* loop what positions and which theme to spawn; the *builder* doesn't know about species at all.

## The Math.random() reroll pattern

The actual project's `LightParticleTree` uses `Math.random()` inside `growBranch` — this is intentional, because the demo wants every page reload to draw a slightly different forest. To make a *seeded* version (for reproducible studio sliders, or a deterministic forest), monkey-patch `Math.random` for the duration of construction:

```js
function buildSeeded(seed, config) {
  const orig = Math.random;
  let s = (seed | 0) ^ 0x9e3779b9;
  Math.random = function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try { return new LightParticleTree(config); }
  finally { Math.random = orig; }
}
```

For `SkeletonTree`, seeding is built in — the constructor takes a `seed` argument and uses an internal `mulberry32`. The project assembles its skeleton forest with `i * 7 + 42` as the seed for tree `i`.

## Forest assembly — clusters + backdrop, not random scatter

The actual scene-assembly code (`src/demo2.js`) places trees in **named clusters**, not via `Math.random` scatter. Hero `LightParticleTree`s go in three to four named groves; the much larger backdrop of `SkeletonTree`s sits at fixed positions further out. Don't roll a fresh random forest layout — the design is hand-tuned. Only per-tree rotation/scale jitter is random.

```js
// Hand-authored hero positions (15 LightParticleTrees)
const TREE_CONFIGS = [
  // Center cluster
  { x:  0, z: -12, species:'western-red-cedar', height:3.5, theme:{leaf:'#66ccff'}, trunkColor:'#446688' },
  { x: -3, z: -10, species:'douglas-fir',       height:2.8, theme:{leaf:'#77bb41'}, trunkColor:'#583400' },
  { x:  3, z: -14, species:'bigleaf-maple',     height:2.5, theme:{leaf:'#ff7700'}, trunkColor:'#dddddd' },
  // Left grove ...   Right grove ...   Far scattered ...
];

// Hand-authored backdrop positions (25 SkeletonTrees)
const SKELETON_POSITIONS = [
  { x:  5, z:  -8, h: 5   }, { x: -6, z: -14, h: 6   }, { x:   2, z: -18, h: 4.5 },
  // ... 25 of these, fanning out further than the hero ring
];

for (let i = 0; i < SKELETON_POSITIONS.length; i++) {
  const sp = SKELETON_POSITIONS[i];
  new SkeletonTree(scene, sp.x, sp.z, sp.h, i * 7 + 42);   // seeded → deterministic
}

for (let i = 0; i < TREE_CONFIGS.length; i++) {
  const cfg = TREE_CONFIGS[i];
  const tree = new LightParticleTree({
    height: cfg.height, theme: cfg.theme,
    trunkColor: cfg.trunkColor,
    detail: 6 + Math.floor(Math.random() * 2),
  });
  const y = terrainHeight(cfg.x, cfg.z);                   // sample noise terrain
  tree.position.set(cfg.x, y, cfg.z);
  tree.rotation.y = Math.random() * Math.PI * 2;           // only rotation/scale are random
  const s = 0.85 + Math.random() * 0.3;
  tree.scale.set(s, s, s);
  scene.add(tree);
}
```

Two kinds of trees, two `for` loops, two arrays of fixed positions. That's the forest.

## The proximity glow contract

Every `LightParticleTree` exposes `tree.update(time, glow, beat)`. In the live scene, `glow` comes from a per-tree proximity computation — distance from camera/cursor to the tree, smooth-mapped to `[0, 1]`. The shader uniforms `uGlow` and `uBeat` are what make the leaves pulse and the trunk shimmer when you approach a tree. **Don't bake glow into the geometry**; always feed it through the per-frame `update()` so the same builder can be reused across static and reactive views.

A simple "scene breathes" loop without proximity, useful for studios:

```js
for (let i = 0; i < lightTrees.length; i++) {
  const phase = i * 0.7;
  const breathing = (Math.sin(t * 0.5 + phase) * 0.5 + 0.5) * 0.4;
  lightTrees[i].update(t, baseGlow + breathing, t);
}
```

## Particle-cloud canopies (TouchDesigner aesthetic)

There's a third stylization in the project — `Trees.js` and `DemoTrees.js` — that drops the recursive branching entirely and renders the canopy as a multi-tier `Points` particle system: large breathing orbs, medium curling-noise flow, tiny twinkling dust. The trunk in this style is a `CatmullRomCurve3` `TubeGeometry` with a rim-lit shader, not bundled strands. Use this when you want exhibition-grade "what if a tree were made of light" — it's the heaviest of the three styles (3 shader programs per tree, ~1500 particles per tree). It is *not* recursive; the canopy is a noise field, not a fork tree.

Pick one of the three:

| Style                    | Trunk                          | Foliage                          | Cost          |
|--------------------------|--------------------------------|----------------------------------|---------------|
| `LightParticleTree`      | bundled-strand LineSegments    | additive Points at branch tips    | medium        |
| `SkeletonTree`           | single LineSegments BufferGeo  | none                              | very cheap    |
| `Trees.js` particle tier | CatmullRom TubeGeometry        | 3 tiers of additive Points clouds | heavy         |

## Worked example

See `studio.html` next to this skill — it lifts both `LightParticleTree` and `SkeletonTree` verbatim from the project, exposes the same control surface (height, detail, trunk-strands, glow, theme, seed), and offers a `Single` mode (one big hero tree, dead-centered, slow auto-orbit) and a `Forest` mode (the actual `demo2.js` layout, scaled to a manageable disc).

The two interesting things to read in that file:

1. The `LightParticleTree` class definition — copy it whole into any Three.js project, hand it a `theme`, and you're done.
2. The `Math.random` monkey-patch in `rebuildSingle()` — the trick that turns the project's `Math.random()`-based recursion into a seedable studio knob without touching the builder.
