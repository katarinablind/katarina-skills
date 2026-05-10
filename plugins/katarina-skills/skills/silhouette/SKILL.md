---
name: silhouette
description: Use when you need a 1D horizon profile from an image (skyline, mountain ridge, treetops, urban silhouette) — for audio sonification, music generation, generative art, or any pipeline that turns the top edge of a photo into a signal. Also covers procedural FBM-noise horizon synthesis as the synthetic counterpart to the same shape. Covers Sobel + adaptive threshold edge detection, the continuity-vs-no-continuity tradeoff (skylines vs forests), an auto-selector that picks between them by measuring V1's noise floor, gap interpolation, and the canonical `Float32Array[width]` 0..1 profile shape that lets extraction and synthesis interoperate. Skip for 2D silhouette extraction (use background subtraction or segmentation), full-image masks, or when you need pixel-accurate alpha mattes — this only gives you the topmost edge per column.
---

## The canonical shape

Every extractor and the procedural generator return the **same shape**:

```
Float32Array of length = imageWidth
values normalized 0..1 where 1 = top of frame, 0 = bottom
```

Once everything emits this shape, downstream code (audio mapping, drawing, baseline diffing, downsampling to 64 points) doesn't care whether the profile came from a photo or from FBM noise. This is the most important decision in the design — make it before you write the extractors.

## Extraction: three algorithms, two real ones

### V1 — top-scan, no continuity (best for skylines, mountains)

For each column independently, find the topmost row whose Sobel gradient exceeds an adaptive threshold. No left-right constraint between columns. Heavy post-smoothing (5-tap box) absorbs noise.

```js
const grad = sobelMag(luminance(imageData), w, h);
const m = mean(grad), stdev = std(grad, m);
const thresh = m + 0.4 * stdev;     // permissive

for (let x = 0; x < w; x++) {
  let pick = -1;
  for (let y = 0; y < h; y++) {
    if (grad[y * w + x] > thresh) { pick = y; break; }
  }
  rows[x] = pick >= 0 ? pick : Math.floor(h * 0.4);
}
```

Wins on: skylines, ridge-lines, building tops — anywhere the true horizon jumps fast across adjacent columns. Loses on: forests, tree canopies — picks up unrelated foliage edges.

### V2 — Sobel + continuity constraint (best for forests, smooth horizons)

Same Sobel + adaptive threshold (`m + 0.6·stdev` — stricter than V1), but each column is constrained to stay within `±MAX_JUMP` of the previous column. `MAX_JUMP = max(2, floor(h * 0.04))`.

```js
const MAX_JUMP = Math.max(2, Math.floor(h * 0.04));
for (let x = 1; x < w; x++) {
  const prev = rows[x - 1];
  const lo = Math.max(0, prev - MAX_JUMP);
  const hi = Math.min(h - 1, prev + MAX_JUMP);
  let best = -1, bestStrength = 0;
  for (let y = lo; y <= hi; y++) {
    const s = grad[y * w + x];
    if (s < thresh) continue;
    if (best < 0 || y < best || (y === best && s > bestStrength)) {
      best = y; bestStrength = s;
    }
  }
  if (best < 0) { rows[x] = prev; found[x] = 0; }
  else          { rows[x] = best; found[x] = 1; }
}
```

Then **interpolate** over runs of `!found` columns rather than copying `prev` (which produced "straight line detached from the rest" artifacts). Final cleanup pass clips remaining single-column spikes.

Wins on: tree canopies, smooth horizons, anywhere the true edge is locally continuous. Loses on: sharp building tops, jagged ridges where `MAX_JUMP` blocks the real edge.

### V3 — auto-selector

Run V1. Build a heavily-smoothed copy (`smooth1D(v1, 11)`). Mean absolute residual between V1 and the smooth = V1's "noise floor."

- Mountain / skyline: V1's output IS the structure → smoothing tracks it → residual is small.
- Forest: V1 picks up canopy texture (single-column edges from unrelated leaves) → smoothing flattens those out → residual is large.

```js
const v1 = extractV1(imageData);
const smooth = smooth1D(v1, 11);
let residual = 0;
for (let i = 0; i < v1.length; i++) residual += Math.abs(v1[i] - smooth[i]);
residual /= v1.length;

const NOISE_THRESHOLD = 0.007;
return residual > NOISE_THRESHOLD ? extractV2(imageData) : v1;
```

This is the right pattern for any "I have two algorithms with opposite failure modes" problem: don't average them, run the cheaper one first and use a measurable property of *its own output* to decide whether you actually need the other.

## Gap interpolation (shared by V1 and V2)

When some columns have no qualifying edge, **don't copy `prev`**. Mark them as unfound and linearly interpolate over runs of unfound columns from the last known-good row to the next:

```js
let i = 0;
while (i < w) {
  if (found[i]) { i++; continue; }
  let j = i;
  while (j < w && !found[j]) j++;
  const leftRow  = i > 0     && found[i - 1] ? rows[i - 1] : (j < w ? rows[j] : Math.floor(h * 0.4));
  const rightRow = j < w     && found[j]     ? rows[j]     : leftRow;
  const span = j - i;
  for (let k = 0; k < span; k++) {
    const t = (k + 1) / (span + 1);
    rows[i + k] = Math.round(leftRow * (1 - t) + rightRow * t);
  }
  i = j;
}
```

Copy-prev produces visible plateaus and detached straight lines. Interpolation produces what looks like a continuous edge.

## Sobel magnitude (the workhorse)

Standard 3×3 Sobel on the luminance plane. Compute once per image, reuse for all extractors.

```js
function luminance(imageData) {
  const { width: w, height: h, data } = imageData;
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = 0.2126 * data[i] + 0.7152 * data[i+1] + 0.0722 * data[i+2];
  }
  return out;
}

function sobelMag(lum, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = lum[i-w-1], b = lum[i-w], c = lum[i-w+1];
      const d = lum[i-1],                  e = lum[i+1];
      const f = lum[i+w-1], g = lum[i+w], hh = lum[i+w+1];
      const gx = -a + c - 2*d + 2*e - f + hh;
      const gy = -a - 2*b - c + f + 2*g + hh;
      out[i] = Math.sqrt(gx*gx + gy*gy);
    }
  }
  return out;
}
```

Adaptive threshold (`mean + k·stdev`) is what makes this robust across exposure. Don't hardcode an absolute gradient threshold.

## Procedural counterpart: FBM-noise horizons

Same `Float32Array[width]` shape, generated from layered 1D noise. Useful when you want a horizon but don't have an image — or for stress-testing downstream code.

```js
export function generateProfile({
  seed = randomSeed(), width = 1024,
  scale = 2.5, octaves = 4, roughness = 0.55,
  peak = 0.7, baseline = 0.15, sharpness = 0.4,
} = {}) {
  const noise = makeNoise1D(seed);
  const out = new Float32Array(width);

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < width; i++) {
    const x = (i / width) * scale;
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum  += amp * noise(x * freq);
      norm += amp;
      amp  *= roughness;
      freq *= 2;
    }
    out[i] = sum / Math.max(1e-6, norm);
    if (out[i] < lo) lo = out[i];
    if (out[i] > hi) hi = out[i];
  }

  const span = Math.max(1e-6, hi - lo);
  const range = peak - baseline;
  for (let i = 0; i < width; i++) {
    let v = (out[i] - lo) / span;
    v = sharpen(v, sharpness);
    out[i] = baseline + Math.min(1, Math.max(0, v)) * range;
  }
  return out;
}

function sharpen(v, s) {
  if (s <= 0) return v;
  const k = 1 + s * 7;
  if (v < 0.5) return 0.5 * Math.pow(2 * v, k);
  return 1 - 0.5 * Math.pow(2 * (1 - v), k);
}
```

`sharpen` with `k = 1 + 7·s` pushes mid-values toward 0 or 1 — the difference between rolling hills and a sharp city skyline at the same noise input.

### Useful presets

```js
export const PRESETS = {
  hills:    { scale: 1.6, octaves: 3, roughness: 0.42, peak: 0.45, baseline: 0.18, sharpness: 0.15 },
  mountain: { scale: 2.2, octaves: 5, roughness: 0.62, peak: 0.82, baseline: 0.12, sharpness: 0.55 },
  urban:    { scale: 5.5, octaves: 4, roughness: 0.78, peak: 0.7,  baseline: 0.22, sharpness: 0.85 },
  coast:    { scale: 1.1, octaves: 2, roughness: 0.3,  peak: 0.28, baseline: 0.08, sharpness: 0.05 },
  forest:   { scale: 4.0, octaves: 4, roughness: 0.55, peak: 0.55, baseline: 0.32, sharpness: 0.35 },
};
```

`scale` is essentially horizontal frequency. `sharpness` decides whether peaks feel rolled or chiseled.

## Tunables (all under one roof)

| Constant | Algorithm | Role | Notes |
|---|---|---|---|
| `m + 0.4·stdev` | V1 threshold | Permissive — catches faint top edges | Lower for very low-contrast images |
| `m + 0.6·stdev` | V2 threshold | Stricter — relies on continuity to fill | Raise if V2 picks up clouds |
| `MAX_JUMP = h·0.04` | V2 continuity window | ±N rows allowed per column step | Larger for jagged ridges |
| `smooth1D(v1, 5)` | V1 post-smooth | Heavy because no continuity | Drop to 3 if losing real spikes |
| `smooth1D(v2, 3)` | V2 post-smooth | Light because continuity already smoothed | |
| `NOISE_THRESHOLD = 0.007` | V3 selector | V1 residual above this → use V2 | Calibrate per dataset; mountains run ~0.003, forests ~0.012 |

## Common mistakes

- **Returning rows in pixel coordinates instead of 0..1.** Downstream code that expects normalized values will break on every image of a different height.
- **Top = 0 vs top = 1.** Pick one (this skill uses top = 1) and document it. Switching mid-pipeline produces upside-down audio.
- **Copying `prev` for unfound columns.** Plateaus everywhere. Always interpolate over found-anchor pairs.
- **Hardcoded gradient threshold.** Works on one test image and fails on every other. Use `mean + k·stdev`.
- **Different output shape for procedural vs extracted.** The whole point is that they're interchangeable — keep the contract.
- **Smoothing before threshold.** You smooth the gradient, you lose the edge. Smooth the *output profile*, not the gradient field.
