---
name: palette
description: Use when extracting a small (3–7 swatch) representative color palette from an image in the browser — for cover-art tinting, generative input, dominant-color UI, or audio/visual mappings driven by image color. Covers coarse-grid sampling into 4-bit-per-channel RGB buckets, vivacity scoring, the multiplicative `count × (1 + vivacity × BOOST)` formula, hue-aware diversity gating, and the three-pass selection (blended score → vivid accent sweep → count-only fill). Skip for k-means / median-cut quantization, fixed-palette mapping (use nearest-neighbor instead), perceptual-Lab pipelines (this stays in RGB+HSL), or single-dominant-color extraction (use top-1 by count).
---

## Why naive top-k by count fails

It's the default every palette library ships and it produces bad palettes the moment images aren't perfectly diverse:

- **Forest photos**: 4 near-identical dark greens crowd out lighter tones.
- **Sunset with a small accent**: a 2% hot-pink cluster never outranks the 30% sky and gets dropped entirely.
- **Monochromes**: 5 nearly-identical swatches.

The fix is not "weight by saturation." That over-corrects: a 3% vivid orange shouldn't beat a 25% structural blue. The fix is **proportional scoring** — vivacity *multiplies* count, never replaces it.

## Pipeline

### 1. Sample on a coarse grid (~60×60), bucket into 4-bit RGB

```js
const stepX = Math.max(1, Math.floor(w / 60));
const stepY = Math.max(1, Math.floor(h / 60));
const bucket = new Map();
for (let y = 0; y < h; y += stepY) {
  for (let x = 0; x < w; x += stepX) {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4); // 12-bit, 4096 cells
    const e = bucket.get(key);
    if (e) { e[0] += r; e[1] += g; e[2] += b; e[3]++; }
    else   bucket.set(key, [r, g, b, 1]);
  }
}
```

`>> 4` is the trick: it collapses 256³ exact RGB values into 4096 buckets while preserving averageable color (you still sum and divide by count). 60×60 samples is enough for stable counts on web-resolution images and runs in <5ms.

### 2. Per-bucket: HSL + vivacity

```js
const hsl = rgbToHsl(r, g, b);
const midLight = Math.min(hsl.l, 1 - hsl.l) * 2; // peaks at l=0.5
const vivacity = Math.max(0, hsl.s - 0.08) * (0.2 + midLight * 0.8);
```

- `s - 0.08` floor: ignores effectively-grey buckets. Tune up to `0.12` if neutrals leak into vivid passes.
- `0.2 + midLight * 0.8`: blacks and whites have low midLight even at high saturation, so they don't get "vivid" credit. A sunlit yellow gets the full lift.

### 3. Score: vivacity multiplies count, never replaces it

```js
const maxCount = all.reduce((m, c) => Math.max(m, c.count), 1);
const BOOST = 5;
const scored = all.map(c => ({
  ...c,
  score: (c.count / maxCount) * (1 + c.vivacity * BOOST),
}));
```

A 3% cluster (`count_norm ≈ 0.03`) tops out at `0.03 × (1 + BOOST) ≈ 0.18`.
A 25% sky (`count_norm ≈ 0.5`) scores `0.5 × (1 + vivacity × BOOST)`.

Count always sets the ceiling. Vivacity lifts a color up to `1+BOOST×` its count-only score — meaningful, but proportional. This is the whole design.

`BOOST=5` is the right knob. Higher → vivid accents push out structural neutrals. Lower → palettes feel washed-out for accent-heavy images.

### 4. Diversity gate: RGB OR hue-aware

A candidate is blocked by an existing pick if **either** rule triggers:

```js
const tooSimilar = (c, p, minRgb) => {
  const dr = c.r - p.r, dg = c.g - p.g, db = c.b - p.b;
  if (Math.sqrt(dr * dr + dg * dg + db * db) < minRgb) return true;          // A
  if (c.s > 0.15 && p.s > 0.15) {                                             // B
    if (hueDist(c.h, p.h) < 20 && Math.abs(c.l - p.l) < 0.22) return true;
  }
  return false;
};

const hueDist = (h1, h2) => { const d = Math.abs(h1 - h2); return Math.min(d, 360 - d); };
```

- **Rule A** (RGB Euclidean) governs neutrals where hue is meaningless.
- **Rule B** (same hue family + similar lightness, both saturated) catches "dark green and medium green" — they're ~80 apart in RGB but read as the same color, different shade. The `s > 0.15` clause means greys and near-whites bypass B and rely on A alone.
- `L_TOL = 0.22` lets genuinely different brightness levels of the same hue (dark forest floor + sunlit canopy) coexist when the image has nothing else to offer.

### 5. Three passes

```js
const MIN_DIST = 40;
const picks = [];

// Pass 1 — blended score: structural and vivid compete on equal terms.
const byScore = [...scored].sort((a, b) => b.score - a.score);
for (const c of byScore) {
  if (picks.length >= k) break;
  if (farEnough(c, picks, MIN_DIST)) picks.push(c);
}

// Pass 2 — accent sweep: catches sparse vivid highlights pass 1 missed.
// vivacity > 0.15 threshold prevents dull structural shades from sneaking in.
if (picks.length < k) {
  const byVivacity = [...scored].sort((a, b) => b.vivacity - a.vivacity);
  for (const c of byVivacity) {
    if (picks.length >= k) break;
    if (c.vivacity <= 0.15) break;
    if (picks.includes(c)) continue;
    if (farEnough(c, picks, MIN_DIST * 0.55)) picks.push(c);   // gate relaxed
  }
}

// Pass 3 — count fill: monochrome safety valve. Most images stop at pass 1.
if (picks.length < k) {
  for (const c of byScore) {
    if (picks.length >= k) break;
    if (picks.includes(c)) continue;
    if (farEnough(c, picks, MIN_DIST * 0.4)) picks.push(c);
  }
}

picks.sort((a, b) => b.l - a.l); // light → dark
return picks.slice(0, k);
```

Pass 1 handles ~95% of images. Pass 2 exists for the sunset-with-accent case. Pass 3 exists so a near-monochrome doesn't return fewer than `k` swatches — the gate progressively relaxes (`MIN_DIST × 0.55`, then `× 0.4`).

## Constants worth tuning

| Constant | Role | If you change it |
|---|---|---|
| `MIN_DIST = 40` | RGB Euclidean diversity floor | Raise for more contrast; lower if monochromes can't fill |
| `BOOST = 5` | Vivacity multiplier ceiling | Higher = accents dominate; lower = structural-leaning |
| `HUE_TOL = 20°` | Hue-family similarity | Tighter rejects subtle hue cousins |
| `L_TOL = 0.22` | Lightness diff for hue-gated | Tighter blocks shade-variation pairs |
| `S_MIN = 0.15` | Saturation floor for hue rule | Below this, fall back to RGB-only |
| `VIV_FLOOR = 0.08` | Saturation floor for vivacity | Below this, color contributes 0 vivacity |

## Museum-piece pattern (regression-safe iteration)

Keep old algorithm versions side-by-side in named files (`mappingV1.js`, `mappingV2.js`, …) and commit a `baselines.json` of reviewer-approved outputs per test image. Each new mapping (`V3`, `V4`, …) is added without touching predecessors. The studio renders all versions on the same image and diffs against baselines. To "ship" a new version: human-review every diff, accept the improvements as the new baseline, commit. Never edit V1 or V2 to fix a regression — write V3.

This works for any algorithm where "correct" is a judgment call, not a spec.

## Common mistakes

- **Using `score = w·count + (1−w)·vivacity`** (additive). A 3% vivid cluster with `vivacity_norm = 1.0` scores 0.5 — strong enough to claim multiple slots and crowd out structural colors. Use the multiplicative form.
- **RGB-distance-only diversity**. Lets dark green + medium green coexist. Add the hue-aware rule for any image with hue-rich subjects (foliage, skin, fabric).
- **Sampling every pixel**. Pointless for palette extraction — burns 100ms+ on a typical image with no quality gain. Coarse stride is correct.
- **Forgetting the count fill pass**. Monochromes return < k swatches and break downstream code that expects exactly `k`.
- **Sorting picks by score for output**. Sort by lightness — palettes read better as gradients than as score-rank.
