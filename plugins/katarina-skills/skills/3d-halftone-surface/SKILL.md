---
name: 3d-halftone-surface
description: Use when rendering a 3D wave-deformed surface (water, fabric, terrain) as a perspective-projected grid of halftone *image dots* — every world cell becomes a sprite sized by perspective scale and brightened by its world Y, sorted back-to-front, with stable per-cell variation (which sprite, what rotation) hashed from grid coords so the field looks textured but never reshuffles. Covers the 4-summed-sines wave height function, the simple yHorizon + (CAM_H - y)·f / D camera projection, the per-row far-taper that widens distant rows, brightness from crest height with a sparkle-pop on tall crests, the deterministic per-cell hash for variation that survives resize, and the front-row coverage rule that ensures every sprite type appears at least once. Skip for full 3D meshes (use Three.js), Voronoi/dithered halftones (different problem), shader-based water (uses fragment shaders, not canvas), or any halftone where the dots don't sit on a 3D surface — this is specifically "image grid as a wave."
---

## The look

Each grid cell on a 3D wave surface becomes an *image sprite* on canvas — its size is set by perspective, its alpha by depth-fade, its rotation and which-of-N-sprites by a hash of `(col, row)` so it stays put while the wave animates underneath. The result reads as halftone-dotted water, but every "dot" is a tiny pictogram.

```
yHorizon ─────────────────────────────────────  ← cells far away: small, faint, packed
              ·  ·  ·  ·  ·  ·  ·  ·
            ·   ·  ◯  ·  ·  ◯  ·   ·             ← perspective taper widens nearer rows
          ◯    ✦   ◯    ◯    ✦   ◯
        ◯   ◯   ✦  ◯  ◯   ✦   ◯  ◯              ← cells near camera: large, bright,
      ◯   ◯   ◯   ✦  ◯  ◯  ✦   ◯   ◯               sparkly on crests
canvas bottom ─────────────────────────────────
```

## Wave height: 4 summed sines

```js
const CFG = {
  amp: 0.50,        // overall wave amplitude (world units)
  wScale: 0.45,     // spatial frequency
  wSpd: 0.98,       // time frequency
};

function waveY(x, z, tt) {
  const k = CFG.wScale, s = CFG.wSpd;
  const a = Math.sin(x * k + tt * s);
  const b = Math.sin(z * k * 1.4 - tt * s * 0.7 + 1.3);
  const c = Math.sin((x + z) * k * 0.55 + tt * s * 1.6 + 2.1);
  const d = Math.sin((x * 0.9 - z * 1.3) * k * 2.1 - tt * s * 1.9);
  return (a * 0.38 + b * 0.28 + c * 0.20 + d * 0.14) * CFG.amp;
}
```

Four sines is the sweet spot. Three reads as a static pattern; five+ is wasted compute. The weights `0.38, 0.28, 0.20, 0.14` sum to 1.0 — they're *amplitude* shares, so the output stays ≈ `[-amp, +amp]`. The diagonal terms (`(x+z)`, `(x*0.9 - z*1.3)`) are what break the gridded look.

## World grid with far-taper

```js
const CFG_GRID = {
  cols: 30, rows: 11,
  worldW: 15.2,         // base world width
  farTaper: 1.80,       // how much wider far rows get (1.0 = no taper)
};

const WORLD_D = 12;

// Iterate back-to-front so closer cells overdraw distant ones
for (let j = rows - 1; j >= 0; j--) {
  const zt = j / (rows - 1);
  const z = zt * WORLD_D;
  const fadeA = 1 - Math.pow(zt, 1.8) * fadeStrength;     // distance fade
  const rowWidth = worldW * (1 + farTaper * zt);          // far rows are wider
  for (let i = 0; i < cols; i++) {
    const xt = i / (cols - 1);
    const x = (xt - 0.5) * rowWidth;
    const y = waveY(x, z, tt);
    // ...project + draw...
  }
}
```

`farTaper = 1.80` means the back row is 2.8× wider than the front row in world space — once projected, this reads as natural perspective even though we're using a simple pinhole projection. Without it, distant rows look unnaturally narrow.

The `Math.pow(zt, 1.8)` exponent on the fade is what makes the distance dropoff feel atmospheric instead of linear.

## Camera projection (the simplest possible)

```js
const CAM_H = 1.0;           // camera height above water plane

function project(x, y, z, W, H, camDepth, tilt) {
  const D = camDepth + z;
  if (D <= 0.1) return null;
  const f = Math.min(W, H) * 1.5;            // focal length
  const yHorizon = H * (0.30 - tilt * 0.20); // higher tilt = horizon higher
  const sx = W * 0.5 + (x * f) / D;
  const sy = yHorizon + ((CAM_H - y) * f) / D;
  return { sx, sy, scale: f / D };
}
```

This is *not* a real camera — it's the bare minimum needed to make perspective work for this kind of look. There's no actual rotation matrix, no FOV, no aspect ratio handling beyond `Math.min(W, H)`. That's fine because:

- `(x * f) / D` projects horizontal world position with depth divisor → things farther away get squeezed toward center.
- `((CAM_H - y) * f) / D` does the same for vertical, mapping world Y onto screen Y around the horizon line.
- `tilt` shifts the horizon up or down — higher tilt = more bird's-eye, lower = more ground-level.

`p.scale = f / D` is the per-cell sprite-scale factor, used directly:

```js
const rRaw = CFG.dot * p.scale * 0.010;
const rad = Math.max(CFG.dotMin, Math.min(CFG.dotMax, rRaw));
```

`dot = 10.6, dotMin = 1.6, dotMax = 17.5` — the min/max clamp prevents foreground sprites from blowing up to ridiculous sizes when the camera is close.

## Per-cell stable variation (the hash trick)

If you call `Math.random()` for which sprite to draw at each cell every frame, the field flickers. Instead, hash `(col, row)` deterministically:

```js
function buildVariation(cols, rows, weightsVersion) {
  const variation = new Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      // 32-bit integer hash of (i, j)
      let h = ((i * 73856093) ^ (j * 19349663) ^ 0x9e3779b9) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
      h = (h ^ (h >>> 16)) >>> 0;

      const r2 = (h & 0xffff) / 0x10000;     // 0..1 — picks sprite via weighted CDF
      let h2 = Math.imul(h ^ 0x27d4eb2d, 0x165667b1) >>> 0;
      h2 = (h2 ^ (h2 >>> 15)) >>> 0;
      const r3 = (h2 & 0xffff) / 0x10000;    // 0..1 — picks rotation

      const imgIdx = sampleWeighted(r2);
      const lockUpright = SHOULD_BE_UPRIGHT(imgIdx);
      const rotation = lockUpright ? 0 : r3 * Math.PI * 2;
      variation[j * cols + i] = { imgIdx, rotation };
    }
  }
  return variation;
}
```

The constants are FNV-flavored multipliers — any decent integer hash works. The point is determinism: same `(col, row)` always produces the same sprite + rotation, so resize doesn't reshuffle.

**Lock some sprite types upright.** If your sprites include things with a clear top (like a leaf, a fish, a face), don't rotate them — the random rotation looks wrong. Pick which indices `lockUpright` based on art content.

### Front-row coverage

A small canvas may have so few cells in the closest row that some sprite types never appear there — and the closest row is what the eye reads first. Force coverage:

```js
const FRONT = 0;
const presentRow = new Set();
for (let i = 0; i < cols; i++) presentRow.add(variation[FRONT * cols + i].imgIdx);
const missing = [];
for (let k = 0; k < SPRITE_COUNT; k++) if (!presentRow.has(k)) missing.push(k);

// For each missing sprite, swap out an over-represented cell in the front row
const counts = new Array(SPRITE_COUNT).fill(0);
for (let i = 0; i < cols; i++) counts[variation[i].imgIdx]++;
let cursor = Math.floor(cols / (missing.length + 1));
const stride = Math.max(1, Math.floor(cols / missing.length));
for (const idx of missing) {
  for (let step = 0; step < cols; step++) {
    const i = (cursor + step) % cols;
    const cell = variation[i];
    if (counts[cell.imgIdx] > 1) {
      counts[cell.imgIdx]--;
      cell.imgIdx = idx;
      cell.rotation = SHOULD_BE_UPRIGHT(idx) ? 0 : cell.rotation;
      counts[idx] = (counts[idx] || 0) + 1;
      break;
    }
  }
  cursor = (cursor + stride) % cols;
}
```

Run once after `buildVariation`. The cursor stride spaces the fixups out so they don't cluster.

## Brightness + sparkle from world Y

```js
const ampSafe = CFG.amp || 0.0001;
const crest = y / ampSafe;                                 // -1..1 normalized
let bright = crest * 0.5 + 0.5;                            // 0..1
const sparkle = Math.sin(x * 1.7 + z * 2.3 + tt * 1.9) * 0.5 + 0.5;
if (crest > 0.55 && sparkle > 0.78) bright = Math.min(1, bright + 0.35);

ctx.globalAlpha = Math.max(0, Math.min(1, fadeA * (0.55 + bright * 0.45)));
```

Two passes: ambient brightness from where the cell sits in the wave, and a sparkle pop on tall crests where a separate sin field is also high. The sparkle is what makes the surface read as *water* and not just "wave with shading."

## Tunable knobs

| Knob | Default | Effect |
|---|---|---|
| `cols × rows` | 30 × 11 | More cells = denser look, more compute |
| `dot` | 10.6 | Base sprite size |
| `dotMin` / `dotMax` | 1.6 / 17.5 | Foreground/background size clamp |
| `amp` | 0.50 | Wave height |
| `wScale` | 0.45 | Wave spatial frequency |
| `wSpd` | 0.98 | Wave time frequency |
| `tilt` | 1.15 | Camera pitch — higher = more bird's-eye |
| `camDepth` | 4.05 | Camera distance from front of grid |
| `worldW` | 15.2 | World-space width of grid base |
| `farTaper` | 1.80 | How much wider far rows get |
| `fade` | 1.00 | Distance-fade strength |

## Common mistakes

- **`Math.random()` for sprite selection per frame.** Field flickers like a static-broadcast TV. Always hash from `(col, row)`.
- **Iterating front-to-back when drawing.** Distant cells overdraw close ones. Render `for (j = rows-1; j >= 0; j--)`.
- **Forgetting to clamp sprite radius.** Front-row cells can compute `rad > 100` if the camera is close — looks like cartoon dots in front of a sea of pinpricks.
- **Skipping the front-row coverage step.** With small `cols`, several sprite types may never appear in the closest row and the field looks one-note.
- **Linear distance fade.** Reads as a hard cutoff. Use `Math.pow(zt, 1.8)` so the dropoff is atmospheric.
- **Rotating upright-shaped sprites.** Faces, leaves, anything with a clear top — random rotation looks wrong. Lock those upright.
- **Coupling ripple offsets with the surface code.** Keep them separate (see `cursor-ripple-field`) so you can use either independently.
