---
name: rubato-probs
description: Use when adding sparse, expressive variation to procedural sequences (music, animation, text generation, gameplay events) by mapping continuous environmental/input metrics to small per-event probabilities. Pattern is "image metrics → low-probability Bernoulli rolls per note" but generalizes to any source-of-truth → variation pipeline. Covers cheap image-metric extraction (brightness, contrast, saturation spread, warmth), linear-blend probability formulas with bounded ranges, the independent-rolls-per-event model where multiple effects coexist (skip + harmony + echo + ornament on the same note), and a 16-step studio for visualizing the resulting density. Skip for deterministic mappings (use direct functions, not probabilities), reinforcement-learned policies, or large-probability decisions where Bernoulli noise is the wrong model — this is for things that should happen *occasionally* in proportion to a metric, not things that should always happen.
---

## The pattern

Don't pick *one* event per step. Roll *many* independent events, each at a small probability driven by the same source metrics. The event types are orthogonal (skip a note, add a harmony, repeat as echo, prefix with an ornament) and stack freely on the same step. This is what gives the output the feel of natural rubato — sparse, varied, never the same shape twice — without per-step scripting.

```
input metrics  ──────►  formula stack  ──────►  per-step Bernoulli rolls  ──────►  output
(brightness,            P_skip, P_harmony,      Math.random() < P each            16-step
 contrast, sat-         P_echo, P_ornament      step, independently               sequence
 spread, …)             ∈ [1.5%, 13%]
```

The probabilities are deliberately small (max ~13% in this design). Any one event is rare. Across 16 steps with 4 event types and avg 5% probability, you get roughly 3–4 decorations total — sparse enough that the underlying melody still reads as the melody.

## Image metrics (cheap, ~4000-sample budget)

```js
function extractImageMetrics(canvas) {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, width, height);
  const total = width * height;

  let sumR = 0, sumG = 0, sumB = 0;
  let minLum = 1, maxLum = 0;
  const sats = [];

  const step = Math.max(1, Math.floor(total / 4000));   // ~4000 samples max
  let n = 0;
  for (let i = 0; i < total; i += step) {
    const off = i * 4;
    const r = data[off] / 255, g = data[off+1] / 255, b = data[off+2] / 255;
    sumR += r; sumG += g; sumB += b;

    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;

    const cmax = Math.max(r, g, b), cmin = Math.min(r, g, b);
    const delta = cmax - cmin;
    const l = (cmax + cmin) / 2;
    const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
    sats.push(sat);
    n++;
  }

  const brightness = (sumR + sumG + sumB) / (3 * n);
  const contrast   = Math.max(0, Math.min(1, maxLum - minLum));

  // Saturation SPREAD (stddev × 3), not mean. "Is this image colorful?"
  // is about variance across the image, not average — a uniformly red
  // photo has high mean saturation but is not visually "colorful."
  const satMean = sats.reduce((a, x) => a + x, 0) / sats.length;
  const satVar  = sats.reduce((a, x) => a + (x - satMean) ** 2, 0) / sats.length;
  const saturationSpread = Math.min(1, Math.sqrt(satVar) * 3);

  // Warmth from k-means dominant colors — captures the dominant tone, not
  // the average pixel. A blue sky over an orange landscape averages to grey.
  const doms = kmeansDominants(data, width, height, 5);
  const domAvgR = doms.reduce((a, c) => a + c.r, 0) / doms.length;
  const domAvgB = doms.reduce((a, c) => a + c.b, 0) / doms.length;
  const warmth = Math.max(-1, Math.min(1, (domAvgR - domAvgB) / 255));

  return { brightness, contrast, saturationSpread, warmth };
}
```

`saturationSpread = stddev × 3` is the move. Mean saturation tells you "is the average pixel saturated"; spread tells you "is there *variety* of saturation," which is a much better proxy for visual interest. The `× 3` brings typical values into [0, 1] range without clipping the photogenic outliers.

## K-means dominant colors (8 iterations, cheap)

```js
function kmeansDominants(data, width, height, k) {
  const pixels = [];
  const step = Math.max(1, Math.floor(width * height / 2000));
  for (let i = 0; i < width * height; i += step) {
    const off = i * 4;
    pixels.push({ r: data[off], g: data[off+1], b: data[off+2] });
  }
  let centroids = [];
  for (let j = 0; j < k; j++) {
    centroids.push(pixels[Math.floor((j / k) * pixels.length)]);  // even-spaced init
  }
  for (let iter = 0; iter < 8; iter++) {
    const buckets = Array.from({ length: k }, () => ({ r: 0, g: 0, b: 0, cnt: 0 }));
    for (const p of pixels) {
      let best = 0, bestDist = Infinity;
      for (let j = 0; j < k; j++) {
        const c = centroids[j];
        const d = (p.r-c.r)**2 + (p.g-c.g)**2 + (p.b-c.b)**2;
        if (d < bestDist) { bestDist = d; best = j; }
      }
      buckets[best].r += p.r; buckets[best].g += p.g; buckets[best].b += p.b; buckets[best].cnt++;
    }
    for (let j = 0; j < k; j++) {
      const bk = buckets[j];
      if (bk.cnt > 0) centroids[j] = { r: bk.r/bk.cnt, g: bk.g/bk.cnt, b: bk.b/bk.cnt };
    }
  }
  return centroids;
}
```

8 iterations is empirically enough. Even-spaced initialization beats random for stability — same image always gives the same dominants.

## Probability formulas

Linear blends of the metrics, each with a stated min and max range. The ranges are part of the design — not derived, *chosen*.

```js
function computeProbs({ brightness: b, contrast: c, saturationSpread: s, warmth: w }) {
  return {
    skip:     0.015 + (1 - b) * 0.025 + c * 0.02,    // 1.5% – 6%
    harmony:  0.04  + c * 0.07         + b * 0.02,    // 4%   – 13%
    echo:     0.03  + c * 0.05,                       // 3%   – 8%
    ornament: 0.02  + s * 0.08         + b * 0.02,    // 2%   – 12%
  };
}
```

Each formula is `base + Σ (weight × metric)`. Three rules:

1. **Document the range.** If you can't say "this probability is between X% and Y%," the formula isn't ready. Min = base; max = base + Σ weights (when all metrics = 1).
2. **Keep ceilings low.** No formula should reach 50% — at that point it's not "occasional variation," it's "structural." Use a different mechanism for structural decisions.
3. **Map metrics to *meanings*, not direct couplings.**
   - `(1 - b)` (darkness, not brightness) drives `skip` — dark images should feel *more* sparse.
   - `c` (contrast) drives `harmony` and `echo` — contrasty images get more rhythmic emphasis.
   - `s` (saturation spread) drives `ornament` — colorful images get more grace notes.
   - These are editorial decisions. Pick them on purpose.

## Independent rolls per step

```js
function generateStep(probs) {
  const skipped    = Math.random() < probs.skip;
  const harmony    = Math.random() < probs.harmony;
  const echo       = Math.random() < probs.echo;
  const ornament   = Math.random() < probs.ornament;

  // Skip is the gate. A skipped step suppresses everything else on that step
  // — silence beats decoration, conceptually.
  if (skipped) return { skipped: true };
  return { skipped: false, harmony, echo, ornament };
}

const sequence = Array.from({ length: 16 }, () => generateStep(probs));
```

Two structural choices:

- **Independent rolls** (not exclusive): harmony + echo + ornament can all hit the same step. This is what makes the output feel arranged rather than randomly chosen. If you want exclusivity, use weighted random instead of Bernoulli — but most natural-feeling variation systems want stacking.
- **Skip is the gate**: a skipped step blocks everything else, because adding harmony to a rest doesn't make sense. If your domain has a similar "null" event, treat it the same way.

## The 16-step studio (visual debugging tool)

You can compute probabilities all day, but the only way to know if they *feel* right is to render a 16-step rollout. Key affordances:

- **Sliders for each input metric** so you can sweep without changing images.
- **Image drop** that auto-fills the sliders from extracted metrics. The image is the corpus; the sliders are for ablation.
- **Re-roll button** so you can see variance (one rollout doesn't tell you much).
- **Per-event glyphs on each slot** — a green dot for harmony, a small "x2" for echo, a purple dot for ornament. Skipped slots gray out. Lets you scan density at a glance.

The studio's job is to surface "is 5% the right probability?" — a question you can't answer by reading the formula.

## Tunable knobs (across the whole system)

| Knob | Lever | Effect |
|---|---|---|
| Bases (`0.015`, `0.04`, `0.03`, `0.02`) | Floors | Probability when all metrics are 0 — the "default" decoration density |
| Coefficients | Sensitivity | How much a metric of 1 lifts the probability above its floor |
| Sample budget (`4000`, `2000`) | Speed vs stability | Lower for snappier UI; raise if metrics jitter on similar images |
| `× 3` on satSpread | Output range | Brings stddev from typical 0.05–0.3 into 0.15–0.9 visible range |
| 8 k-means iterations | Stability | More iterations = same dominants every time, slower |
| Skip-gates-everything | Composition rule | Set to false if rests can carry decoration (rare) |

## Common mistakes

- **Letting probabilities exceed ~25%.** They stop feeling like variation and start feeling like rules. Cap formulas explicitly with `Math.min(MAX, …)`.
- **One roll per step** instead of independent rolls per event type. Forces mutual exclusivity that doesn't match how decoration actually layers.
- **Ignoring the metric→meaning translation.** Using `b` (brightness) for `skip` instead of `(1 - b)` (darkness) is a one-character change that inverts the entire feel.
- **Mean saturation instead of spread.** Mean tells you "saturated"; spread tells you "varied." For "is this image colorful," you want spread.
- **Forgetting to seed an RNG when reproducibility matters.** `Math.random()` is fine for live preview, lethal for "why doesn't this match the screenshot."
- **Computing metrics every frame.** They don't change unless the image changes. Cache them on input, not on render.
