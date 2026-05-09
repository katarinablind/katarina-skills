---
name: filled-band-topology
description: Use when rendering terrain or any 2D scalar field as height-bucketed filled color bands (the 'topographic map with filled regions' look). The pattern: sample a height function over a 2D pixel grid, bucket each value into N bands by threshold, fill with a per-band color from a ramp. Distinct from `marching-squares-topology` (which draws iso-line outlines instead of filled regions) — pick this one when you want regions of color, that one when you want lines. Skip for 3D mesh terrain or rendering pure outline contours.
---

## Pick the right skill

If you want **outline contours** instead of filled bands, use `marching-squares-topology`.
If you want **both** (3D mesh + lines floating above), use `3d-terrain-contours`.
This skill is **filled bands only** — typically the fastest of the three to render, and the most "video-game minimap" feeling.

## Core algorithm

Per pixel (or per Nth pixel for stride), sample a height function, bucket the value into one of `N` bands by threshold, look up the band's color, fill the cell.

```js
const W = canvas.width, H = canvas.height;
const stride = 2;                 // sample every Nth pixel, fill an N×N block
const N_BANDS = 8;
const palette = makeRamp(N_BANDS); // array of [r,g,b]
const hMin = 0.0, hMax = 1.0;

for (let y = 0; y < H; y += stride) {
  for (let x = 0; x < W; x += stride) {
    const h = heightAt(x / W, y / H);                       // scalar in ~[hMin,hMax]
    const t = (h - hMin) / (hMax - hMin);                   // 0..1
    const bi = Math.max(0, Math.min(N_BANDS - 1,
                Math.floor(t * N_BANDS)));                  // bucket index
    const [r, g, b] = palette[bi];
    ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
    ctx.fillRect(x, y, stride, stride);
  }
}
```

For higher fidelity, write into an `ImageData` buffer instead of `fillRect` per cell — one `putImageData` at the end is cheaper than thousands of state changes.

## Color ramps

The band palette is the most important authoring decision. Three patterns:

**(a) Discrete ramp** — each band is a hand-picked color. Best for stylized maps and recognizable biomes.

```js
const TOPO = [
  [ 30, 60,110], [ 50,100,150], [ 90,150,180],   // deep / mid / shallow water
  [200,200,160], [180,170,120], [140,130, 90],   // sand / grass / hill
  [180,170,160], [240,240,240],                  // rock / snow
];
```

**(b) Gradient ramp** — lerp between two endpoints. Cheap, smooth, parametric.

```js
function ramp(n, lo, hi) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    out.push([
      lo[0] + (hi[0] - lo[0]) * t,
      lo[1] + (hi[1] - lo[1]) * t,
      lo[2] + (hi[2] - lo[2]) * t,
    ]);
  }
  return out;
}
const HEAT = ramp(8, [40, 0, 80], [255, 240, 200]);
```

**(c) Data-derived** — terrain biomes mapped to colors by what the height *means*, not just where it falls. Encode each band's color via a lookup keyed on its midpoint value.

```js
function biomeColor(t) {
  if (t < 0.25) return [ 30, 60,110];   // ocean
  if (t < 0.32) return [200,200,160];   // beach
  if (t < 0.55) return [110,150, 90];   // grass
  if (t < 0.78) return [140,130, 90];   // hills
  if (t < 0.92) return [180,170,160];   // rock
  return                  [245,245,245];// snow
}
const BIOME = Array.from({length: 8}, (_, i) => biomeColor(i / 7));
```

## Stride / sampling rate (the perf knob)

`stride` controls how often you sample and how big a block each sample fills.

- `stride = 1`: full resolution. Smoothest but most expensive (`W*H` samples per frame).
- `stride = 2`: ~4× cheaper. Still indistinguishable on most monitors.
- `stride = 4`: ~16× cheaper. Visibly chunky; the "video-game minimap" look. Often desirable for stylized output.
- `stride = 8+`: pixel-art / Mode-7-ish.

The pattern in `experiments/map-offroading/index.html` (around line 3375) writes into a small offscreen `ImageData` (one pixel per band cell) then `drawImage`s it scaled up with `imageSmoothingEnabled = true` for a soft bilinear-upscaled look — same idea, tighter inner loop.

## Adaptive `[hMin, hMax]`

If the height function's *visible range* varies frame-to-frame (scrolling terrain, zoom, dynamic field), bucketing against fixed `[0, 1]` will make low-contrast regions read as one flat color. Recompute the bounds per frame from the observed min/max:

```js
let hMin = Infinity, hMax = -Infinity;
for (let i = 0; i < samples.length; i++) {
  const h = samples[i];
  if (h < hMin) hMin = h;
  if (h > hMax) hMax = h;
}
const hRange = (hMax - hMin) || 1e-6;
// then in the bucket loop:
const t = (h - hMin) / hRange;
```

**Caveat:** adaptive bands "breathe" — same world point shifts color as the visible window changes. For static, stable maps prefer fixed `[hMinS, hMaxS]` reference values (this is what `map-offroading` does for the car-act minimap; see comment near line 1070).

## Combining with outlines

The filled-band layer can sit *under* a marching-squares iso-line layer for the classic "filled topo with crisp contour lines" look. Use the **same level thresholds** in both passes so each line lands exactly on a band boundary.

```js
drawFilledBands(ctx, levels);   // this skill
drawMarchingSquares(ctx, levels); // marching-squares-topology, stroked over the top
```

The studio in this skill has an `Outline overlay` checkbox that demonstrates the layering.

## Worked example (~80 lines, standalone)

```html
<!doctype html>
<canvas id="c" width="600" height="400"></canvas>
<label>Bands <input id="bands" type="range" min="3" max="16" value="8"></label>
<label>Stride <input id="stride" type="range" min="1" max="8" value="2"></label>
<script>
const c = document.getElementById('c'), ctx = c.getContext('2d');
const bandsEl = document.getElementById('bands');
const strideEl = document.getElementById('stride');

// Tiny FBM (value-noise based — replace with your own noise lib for production)
const PERM = new Uint8Array(512);
(() => {
  const p = new Uint8Array(256).map((_,i) => i);
  for (let i = 255; i > 0; i--) { const j = (Math.random()*(i+1))|0; [p[i],p[j]] = [p[j],p[i]]; }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();
function fade(t){return t*t*t*(t*(t*6-15)+10);}
function lerp(a,b,t){return a+(b-a)*t;}
function vnoise(x,y){
  const xi=Math.floor(x)&255, yi=Math.floor(y)&255;
  const xf=x-Math.floor(x), yf=y-Math.floor(y);
  const u=fade(xf), v=fade(yf);
  const a=PERM[PERM[xi]+yi], b=PERM[PERM[xi+1]+yi];
  const cN=PERM[PERM[xi]+yi+1], d=PERM[PERM[xi+1]+yi+1];
  return lerp(lerp(a/255,b/255,u), lerp(cN/255,d/255,u), v);
}
function fbm(x,y,oct=4){
  let amp=0.5, freq=1, sum=0, norm=0;
  for (let i=0;i<oct;i++){ sum += vnoise(x*freq, y*freq)*amp; norm+=amp; amp*=0.5; freq*=2; }
  return sum/norm;
}

// Discrete topo ramp
const PALETTE = [
  [30,60,110],[50,100,150],[90,150,180],[200,200,160],
  [180,170,120],[140,130,90],[180,170,160],[240,240,240]
];
function bandColor(i, n){
  const t = n === 1 ? 0 : i / (n - 1);
  const fi = t * (PALETTE.length - 1);
  const a = PALETTE[Math.floor(fi)], b = PALETTE[Math.min(PALETTE.length-1, Math.ceil(fi))];
  const u = fi - Math.floor(fi);
  return [a[0]+(b[0]-a[0])*u, a[1]+(b[1]-a[1])*u, a[2]+(b[2]-a[2])*u];
}

let t0 = 0;
function frame(){
  t0 += 0.003;
  const W = c.width, H = c.height;
  const N = +bandsEl.value, stride = +strideEl.value;
  const ramp = Array.from({length: N}, (_,i) => bandColor(i, N));

  // Adaptive range pass — sample once, find hMin/hMax, then bucket
  const samples = new Float32Array(Math.ceil(W/stride) * Math.ceil(H/stride));
  let hMin = Infinity, hMax = -Infinity, k = 0;
  for (let y = 0; y < H; y += stride)
    for (let x = 0; x < W; x += stride) {
      const h = fbm(x/W*3 + t0, y/H*3, 4);
      samples[k++] = h;
      if (h<hMin) hMin=h; if (h>hMax) hMax=h;
    }
  const hRange = (hMax - hMin) || 1e-6;

  // Fill pass
  k = 0;
  for (let y = 0; y < H; y += stride)
    for (let x = 0; x < W; x += stride) {
      const t = (samples[k++] - hMin) / hRange;
      const bi = Math.max(0, Math.min(N-1, Math.floor(t * N)));
      const [r,g,b] = ramp[bi];
      ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
      ctx.fillRect(x, y, stride, stride);
    }
  requestAnimationFrame(frame);
}
frame();
</script>
```

## Common mistakes

- **Forgetting `Math.min(N-1, ...)` clamp** on the bucket index — at `t === 1.0` the floor produces `N`, an out-of-range palette index.
- **`fillStyle` inside the inner loop** for stride 1 — the parser cost dominates. Pre-build palette strings or write into `ImageData`.
- **Mismatched levels between fill + outline layers** — if you draw outlines on top with different thresholds, the lines will wander away from band boundaries and the result reads as noise.
- **Adaptive range without a fallback for empty samples** — divide-by-zero when `hMax === hMin`. Always `|| 1e-6` the denominator.
