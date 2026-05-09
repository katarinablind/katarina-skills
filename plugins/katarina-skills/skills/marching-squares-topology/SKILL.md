---
name: marching-squares-topology
description: Use when building topographic contour visualizations, iso-line fields, marching-squares algorithms, cursor-reactive terrain maps, sonar/oceanography-style UIs, or layered Perlin-noise contour plots in p5.js or HTML canvas. Covers the 16-case lookup table, edge interpolation for smooth lines, multi-iso layering, and cursor "depression" field deformation. Skip for heightmaps rendered as filled polygons, voxel/3D terrain, or generic 2D drawing.
---

## Algorithm

1. Build a `(ROWS+1) x (COLS+1)` 2D grid `field[r][c]` of scalar values, typically clamped to `[0, 1]`. Source values from Perlin noise, sampled images, or any scalar field.
2. For each cell (between four corner samples), compute a 4-bit index by comparing each corner to an iso threshold.
3. Look the index up in a 16-entry table to get which cell edges the contour crosses. There are 0, 1, or 2 line segments per cell.
4. Linearly interpolate along each crossed edge to find where the contour value exactly equals `iso`. Draw line segments between those points.
5. Repeat for multiple iso levels to get the layered topographic look.

## Corner-bit convention

```
v00 (TL) ---- v10 (TR)
 |              |
 |              |
v01 (BL) ---- v11 (BR)
```

```js
const idx =
  (v00 > iso ? 8 : 0) |  // top-left  = bit 3
  (v10 > iso ? 4 : 0) |  // top-right = bit 2
  (v11 > iso ? 2 : 0) |  // bottom-right = bit 1
  (v01 > iso ? 1 : 0);   // bottom-left  = bit 0
```

`idx === 0` (all below) and `idx === 15` (all above) produce no segments — skip them.

## Edge interpolation

Place each segment endpoint at the actual iso-crossing along the cell edge, not at the cell midpoint. This is what turns blocky stairs into smooth curves.

```js
const it = (a, b, len) => (iso - a) / (b - a) * len;

const top    = { x: x0 + it(v00, v10, cellW), y: y0 };
const bottom = { x: x0 + it(v01, v11, cellW), y: y0 + cellH };
const left   = { x: x0,         y: y0 + it(v00, v01, cellH) };
const right  = { x: x0 + cellW, y: y0 + it(v10, v11, cellH) };
```

## Lookup table (canonical reference)

Each entry maps `idx` to one or two `[start, end]` segment pairs over the four edge points `top`, `right`, `bottom`, `left`. Cases 5 and 10 are the saddle/ambiguous cases — the choice below is consistent with the convention above.

```js
const lm = {
  1:  [[left, bottom]],
  2:  [[right, bottom]],
  3:  [[left, right]],
  4:  [[top, right]],
  5:  [[top, left], [right, bottom]],
  6:  [[top, bottom]],
  7:  [[top, left]],
  8:  [[top, left]],
  9:  [[top, bottom]],
  10: [[top, right], [left, bottom]],
  11: [[top, right]],
  12: [[left, right]],
  13: [[right, bottom]],
  14: [[left, bottom]],
};
```

`idx` of 0 and 15 are intentionally absent — guard with `if (!segs) continue;`.

## Layering iso levels

Loop over `LEVELS` and vary `iso` across the field's value range. Vary stroke alpha/weight/hue per level so deeper contours read as deeper. Build the field once per frame; iterate iso levels inside.

```js
const LEVELS = 10;
for (let level = 0; level < LEVELS; level++) {
  const iso = 0.15 + (level / LEVELS) * 0.65;
  const lv = level / LEVELS;
  p.stroke(0, 100 + lv * 80, 180 + lv * 75, 80 + lv * 80);
  p.strokeWeight(0.6 + lv * 0.8);
  // ...marching-squares pass over all cells at this iso...
}
```

## Cursor depression (optional)

While building the field, subtract a soft radial falloff centered on the normalized cursor position. The contours will collapse into a basin around the pointer.

```js
const mxN = mx / W, myN = my / H;
const dx = nx - mxN, dy = ny - myN;
const dist = Math.sqrt(dx * dx + dy * dy);
const soft = Math.max(0, 1 - dist / 0.25) ** 2;  // radius 0.25, quadratic falloff
val -= soft * 0.5;                                 // depth of the basin
```

Squaring the falloff (`** 2`) gives a smoother bowl than linear. Tune radius and depth to taste.

## Performance notes

- Build the field once per frame, then run all iso passes against the same grid.
- `(ROWS+1) x (COLS+1)` samples — the grid is one larger than the cell count in each axis.
- For large grids, precompute `field[r][c] > iso` as a boolean grid before the inner loop.
- A persistent low-alpha "ghost" layer (drawn over the canvas each frame) gives motion trails without re-rendering history.

## Minimal worked example (p5.js)

```js
let COLS = 48, ROWS = 32;
let mx = 0, my = 0;

function setup() {
  createCanvas(640, 420);
  frameRate(60);
}

function mouseMoved() { mx = mouseX; my = mouseY; }

function draw() {
  background(0, 3, 13);
  const W = width, H = height;
  const cellW = W / COLS, cellH = H / ROWS;
  const t = frameCount * 0.012;

  // 1. Build field
  const field = [];
  for (let r = 0; r <= ROWS; r++) {
    field[r] = [];
    for (let c = 0; c <= COLS; c++) {
      const nx = c / COLS, ny = r / ROWS;
      let val = noise(nx * 2.5 + t * 0.04, ny * 2.0 + t * 0.03, t * 0.01);
      const dx = nx - mx / W, dy = ny - my / H;
      const soft = Math.max(0, 1 - Math.sqrt(dx*dx + dy*dy) / 0.25) ** 2;
      val -= soft * 0.5;
      field[r][c] = Math.max(0, Math.min(1, val));
    }
  }

  // 2. Draw contours at multiple iso levels
  const LEVELS = 10;
  noFill();
  for (let level = 0; level < LEVELS; level++) {
    const iso = 0.15 + (level / LEVELS) * 0.65;
    const lv = level / LEVELS;
    stroke(0, 100 + lv * 80, 180 + lv * 75, 80 + lv * 80);
    strokeWeight(0.6 + lv * 0.8);

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x0 = c * cellW, y0 = r * cellH;
        const v00 = field[r][c],     v10 = field[r][c+1];
        const v01 = field[r+1][c],   v11 = field[r+1][c+1];
        const idx = (v00>iso?8:0)|(v10>iso?4:0)|(v11>iso?2:0)|(v01>iso?1:0);
        if (idx === 0 || idx === 15) continue;

        const it = (a, b, l) => (iso - a) / (b - a) * l;
        const top    = { x: x0 + it(v00, v10, cellW), y: y0 };
        const bottom = { x: x0 + it(v01, v11, cellW), y: y0 + cellH };
        const left   = { x: x0,         y: y0 + it(v00, v01, cellH) };
        const right  = { x: x0 + cellW, y: y0 + it(v10, v11, cellH) };

        const lm = {
          1:[[left,bottom]], 2:[[right,bottom]], 3:[[left,right]],
          4:[[top,right]], 5:[[top,left],[right,bottom]], 6:[[top,bottom]],
          7:[[top,left]], 8:[[top,left]], 9:[[top,bottom]],
          10:[[top,right],[left,bottom]], 11:[[top,right]],
          12:[[left,right]], 13:[[right,bottom]], 14:[[left,bottom]],
        };
        const segs = lm[idx];
        if (!segs) continue;
        for (const [a, b] of segs) line(a.x, a.y, b.x, b.y);
      }
    }
  }
}
```

## Common mistakes

- Off-by-one on field dimensions: must be `ROWS+1` rows and `COLS+1` cols of samples for `ROWS x COLS` cells.
- Wrong bit assignment: if contours look mirrored or rotated, the corner-to-bit mapping is permuted relative to the lookup table.
- Forgetting to clamp `field[r][c]` after subtracting the cursor depression — interpolation still works on out-of-range values, but iso level choice becomes harder to reason about.
- Using `iso` outside the field's actual value range produces empty layers; pick iso levels inside `[min(field), max(field)]`.
