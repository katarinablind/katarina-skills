---
name: fluid-mosaic
description: Use when building a cursor-reactive image-circle blob that breathes and warps in noise — a soft tiled photo collage shaped by a noise-deformed circular boundary, where each tile inside the boundary scales up by edge-distance, the cursor pushes nearby tiles radially with a falloff, and the whole blob slowly drifts with low-frequency Perlin noise on the center and radius. Covers the dot-grid setup with margin overflow, the `circDist < 1 + boundaryNoise(angle)` shape test, edge-distance-driven size/opacity/movement, the cursor radial push (falloff² with proportional pushAmt), per-dot 0.1 EMA smoothing, and the image-OR-sphere-OR-color rendering trio. Skip for static photo grids, packed image walls (use a packing algorithm), particle systems without spatial coherence, or rectilinear gallery layouts — this is specifically the breathing-blob aesthetic.
---

## The shape

A grid of "dots" extends well past the canvas edges. Each frame, a noise-warped circle decides which dots are *alive*. Alive dots scale up, fade in, and wiggle in place. The cursor pushes dots radially within a hover radius. Everything is EMA-smoothed at α=0.1 so motion always feels viscous.

```
viewport edge ┌───────────────────────────┐
              │  · · · · · · · · · · · ·  │  ← dots outside boundary: tiny, transparent
              │  · · · ╱─────╲ · · · · ·  │
              │  · ·  ╱  ◯◯◯  ╲  · · · ·  │  ← inside: image-filled circles, full size
              │  · ·│  ◯◯◯◯◯  │· · · · ·  │     boundary noise gives the wobbly outline
              │  · · ╲  ◯◯◯  ╱ · · · · ·  │     cursor in this region pushes dots out
              │  · · · ╲───╱  · · · · ·   │
              │  · · · · · · · · · · ·    │
              └───────────────────────────┘
```

## Build the dot grid (with margin overflow)

```js
const sp = 40;                  // spacing
const baseRadius = Math.min(W, H) * 0.42;
const MAX_SHAPE_SIZE = 2.0;     // shape can grow up to 2× baseRadius
const margin = 2.6;             // dots extend 2.6× past the shape

const gridRadius = baseRadius * MAX_SHAPE_SIZE;
const c0 = Math.floor((W * 0.5 - gridRadius * margin) / sp);
const c1 = Math.ceil( (W * 0.5 + gridRadius * margin) / sp);
const r0 = Math.floor((H * 0.5 - gridRadius * margin) / sp);
const r1 = Math.ceil( (H * 0.5 + gridRadius * margin) / sp);

const dots = [];
for (let r = r0; r < r1; r++) {
  for (let c = c0; c < c1; c++) {
    dots.push({
      x: c * sp, y: r * sp, baseX: c * sp, baseY: r * sp,
      col: c, row: r,
      size: 0, baseSize: 2,
      tx: c * sp, ty: r * sp, ts: 0,           // *t* prefix = target values
      opacity: 0, to: 0,
      imgIdx: pickImageIdx(),                  // weighted random
      rotation: Math.random() * Math.PI * 2,
      useImage: Math.random() < imageRatio,
      color: PRISM_PALETTE[Math.floor(Math.random() * PRISM_PALETTE.length)],
      isSphere: Math.random() < 0.5,           // colored dots get a soft-light sphere overlay
    });
  }
}
```

The `margin = 2.6` overflow is what lets the noise-warped boundary expand past the visible canvas without revealing a hard edge.

## Per-frame: the breathing blob

```js
const tt = t * motionSpeed;          // motionSpeed ≈ 2.0
const fluid = 0.6;                   // 0..1 — how much per-dot warp

// 1. Drift the center and breathe the radius (low frequency, high amplitude)
const cxA = centerX + noise(tt * 0.08, 0)   * 55;
const cyA = centerY + noise(0, tt * 0.08)   * 42;
const breathe = 0.94 + noise(tt * 0.13, 7) * 0.1;
const rA = baseRadius * shapeSize * breathe;

for (const d of dots) {
  // 2. Warp each dot's "shape coordinates" by FBM noise
  let nx = (d.baseX - cxA) / rA;
  let ny = (d.baseY - cyA) / rA;

  if (fluid > 0.001) {
    const wfx = d.baseX * 0.0032;
    const wfy = d.baseY * 0.0032;
    const warpAmp = fluid * 0.9;
    nx += noise(wfx + tt * 0.15, wfy + tt * 0.08) * warpAmp;
    ny += noise(wfx - tt * 0.10 + 50, wfy + tt * 0.13 + 50) * warpAmp;
  }

  // 3. Test against a noise-deformed unit circle
  const circDist = nx * nx + ny * ny;
  const angle = Math.atan2(ny, nx);
  const boundAmp = 0.38 + fluid * 0.28;
  const boundaryNoise = noise(angle * 2 + tt * 0.22, tt * 0.14) * boundAmp;
  const threshold = 1.0 + boundaryNoise;

  if (circDist < threshold) {
    const edgeDist = 1 - circDist / threshold;     // 1 at center, 0 at edge
    d.ts = sizeMin + edgeDist * sizeRange;          // target size grows toward center
    d.to = 0.25 + edgeDist * 0.72;                  // target opacity 0.25..0.97
    // Per-dot wiggle, larger near the edge
    const n1 = noise(d.col * 0.1 + tt * 0.18, d.row * 0.1 + tt * 0.12);
    const n2 = noise(d.col * 0.06 - tt * 0.1,  d.row * 0.06 + tt * 0.08);
    const movement = (1 - edgeDist * 0.6) * 4;      // 4px max, less near center
    d.tx = d.baseX + n1 * movement;
    d.ty = d.baseY + n2 * movement;
  } else {
    d.ts = 0; d.to = 0;
    d.tx = d.baseX; d.ty = d.baseY;
  }
}
```

`circDist < threshold` is the whole shape test. `circDist` is squared distance from the warped center divided by squared radius; if it's less than `1 + boundaryNoise`, the dot is inside.

## Cursor radial push

After the shape test (so the cursor can amplify dots that are already alive *and* poke at the void around the shape):

```js
const cursorR = 285;
const hoverScale = 0.25;

for (const d of dots) {
  const dx = d.x - mx, dy = d.y - my;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < cursorR) {
    const hover = 1 - dist / cursorR;
    const falloff = hover * hover;                       // smoother near radius edge
    d.ts *= 1 + hover * hoverScale;                      // grow
    d.to = Math.min(1, d.opacity + hover * 0.6);         // boost visibility
    if (dist > 0.5) {
      const pushAmt = falloff * (cursorR * 0.23);        // proportional push
      d.tx += (dx / dist) * pushAmt;                     // radial direction
      d.ty += (dy / dist) * pushAmt;
    }
  }
}
```

`hover²` for the push (smoother fall-off near the edge) but linear `hover` for the size boost (more responsive). The `pushAmt = falloff * cursorR * 0.23` is what makes the push *proportional to the hover radius* — change `cursorR` and the push scales naturally.

## EMA smoothing

```js
const spd = 0.1;   // EMA factor — 0.1 is the magic number for this aesthetic
for (const d of dots) {
  d.x       += (d.tx       - d.x)       * spd;
  d.y       += (d.ty       - d.y)       * spd;
  d.size    += (d.ts       - d.size)    * spd;
  d.opacity += (d.to       - d.opacity) * spd;
}
```

Higher `spd` (≥0.2) and the motion gets jittery. Lower (≤0.05) and dots feel like they're stuck in molasses. `0.1` is the sweet spot for "viscous but alive."

## Render: image OR sphere OR flat color

```js
ctx.clearRect(0, 0, W, H);
for (const d of dots) {
  if (d.size < 1 || d.opacity < 0.01) continue;

  ctx.save();
  ctx.globalAlpha = Math.min(1, d.opacity);
  ctx.translate(d.x, d.y);
  ctx.rotate(d.rotation);
  ctx.beginPath();
  ctx.arc(0, 0, d.size, 0, Math.PI * 2);
  ctx.closePath();

  if (d.useImage && images[d.imgIdx]?.complete) {
    ctx.clip();
    const s = d.size * 2;
    ctx.drawImage(images[d.imgIdx], -d.size, -d.size, s, s);
  } else if (d.isSphere) {
    ctx.fillStyle = d.color;
    ctx.fill();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.drawImage(SPHERE_SPRITE, -d.size, -d.size, d.size * 2, d.size * 2);
  } else {
    ctx.fillStyle = d.color;
    ctx.fill();
  }
  ctx.restore();
}
```

The sphere sprite is a 256×256 radial-gradient canvas built once at startup:

```js
function buildSphereSprite(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const cx = c.getContext('2d');
  const r = 128;
  const grad = cx.createRadialGradient(r - r * 0.35, r - r * 0.4, 0, r, r, r * 1.05);
  for (const [pos, rgba] of stops) grad.addColorStop(pos, rgba);
  cx.fillStyle = grad;
  cx.beginPath(); cx.arc(r, r, r, 0, Math.PI * 2); cx.fill();
  return c;
}
const TRADITIONAL_SPRITE = buildSphereSprite([
  [0,    'rgba(255,240,195,1)'],
  [0.10, 'rgba(240,220,170,1)'],
  [0.55, 'rgba(128,128,128,1)'],
  [0.85, 'rgba(55,45,105,1)'],
  [1,    'rgba(30,25,70,1)'],
]);
```

Composite with `soft-light` over the colored fill — gives the marble look without per-frame gradient computation.

## Weighted image pool

Don't `Math.floor(Math.random() * IMAGE_COUNT)`. Build a flat lookup so some images appear more often:

```js
const IMAGE_WEIGHTS = [3, 4, 3, 3, 3, 1, 2, 2, 3, 4];
const IMAGE_POOL = IMAGE_WEIGHTS.flatMap((w, i) => Array(w).fill(i));
const pickImageIdx = () => IMAGE_POOL[Math.floor(Math.random() * IMAGE_POOL.length)];
```

Lets you bias toward photos that work well at small sizes without pruning the source list.

## Tunable knobs

| Knob | Default | Effect |
|---|---|---|
| `spacing` | 40 | Dot-grid pitch in px |
| `sizeMin` / `sizeMax` | 2 / 16 | Per-dot radius range |
| `imageRatio` | 1.0 | Probability a dot uses an image (vs colored) |
| `motionSpeed` | 2.0 | Time multiplier for everything |
| `fluidity` | 0.6 | Per-dot warp strength + boundary wobble strength |
| `cursorRadius` | 285 | Hover effect range in px |
| `hoverScale` | 0.25 | Size boost at cursor |
| `shapeSize` | 0.85 | Boundary radius scale (× baseRadius) |
| EMA `spd` | 0.1 | Don't change this. |

## Common mistakes

- **Building the grid only over the canvas extent.** When the shape warps outward, you'll see the dot grid abruptly end. Margin × 2.6.
- **Skipping the squared `circDist < threshold` test in favor of `Math.sqrt`.** Squared comparison is faster and equivalent for this purpose.
- **Computing `boundaryNoise` per dot using cartesian coords.** It needs to be `noise(angle * 2 + …)` so the wobbles wrap around the boundary. Per-dot cartesian noise gives blobs that don't deform smoothly.
- **Putting the cursor push *before* the shape test.** Then dots that just got pushed get their target reset to base. Push after the shape test.
- **Forgetting `pushAmt = falloff * cursorR * 0.23`.** A constant pushAmt makes the cursor effect feel weaker as you increase cursorR.
- **Animating without `requestAnimationFrame` deferral on resize.** Rebuild the grid on resize; rebuild on every resize event will thrash. Use a ResizeObserver with a 70-120ms debounce.
