/**
 * Silhouette Studio — Horizon Profile Extraction + Procedural Generation
 * ======================================================================
 * Primary purpose: extract a 1D horizon profile from an image using three
 * algorithms compared side by side. Secondary purpose: synthesize a horizon
 * profile from layered FBM noise.
 *
 * Extraction exports:
 *   extractV1(imageData)  → Float32Array  top scan (no continuity)    (amber)
 *   extractV2(imageData)  → Float32Array  continuity + gap interp      (blue)
 *   extractV3(imageData)  → { profile, picked: 'v1'|'v2', residual }   (emerald)
 *
 *   V1 wins on skylines and mountains (handles big column-to-column jumps).
 *   V2 wins on forests (continuity smooths fine texture noise).
 *   V3 is the auto-selector: it runs V1 first, measures how much V1
 *     deviates from a heavily-smoothed copy of itself, and picks V2 when
 *     that residual exceeds a threshold (which means V1 is picking up
 *     unstructured noise — i.e. forest texture). Otherwise V1 wins. The
 *     studio reads `picked` to label which sibling it ended up using.
 *
 *   EXTRACTORS            → ordered metadata array
 *
 * Procedural exports (kept from the previous procedural-only version)
 *   generateProfile(opts) → Float32Array
 *   PRESETS               → preset-key → opts overrides
 *   makeRng / randomSeed / formatSeed / parseSeed
 *
 * All extraction algorithms operate on `ImageData` (read once from a canvas)
 * and return a Float32Array of length `imageData.width` whose values are
 * normalized 0..1 horizon heights (1 = top of frame, 0 = bottom). The single
 * canonical output shape lets the studio overlay all three at once and lets
 * downstream baselines store a single 64-point downsample per image.
 */

/* ============================================================================
 * EXTRACTION (primary)
 * ========================================================================== */

export const EXTRACTORS = [
  { id: 'v1', name: 'V1 · top scan',                  color: '#f59e0b', fn: extractV1 },
  { id: 'v2', name: 'V2 · continuity',                color: '#3b82f6', fn: extractV2 },
  { id: 'v3', name: 'V3 · auto (picks V1 or V2)',     color: '#10b981', fn: extractV3, auto: true },
];

/* ── V1: loose Sobel · top scan, no continuity ──────────────────────────────
 * For each column independently, find the topmost row whose Sobel gradient
 * exceeds an adaptive (permissive) threshold. No continuity constraint
 * between columns; relies on heavy post-smoothing to absorb noise. Best for
 * skylines and other scenes where the topmost edge IS the horizon — V2's
 * continuity window can stall when the true horizon jumps fast across
 * adjacent columns (building tops, sharp ridge-lines). The per-column
 * independence is exactly what handles those big jumps.
 * ──────────────────────────────────────────────────────────────────────── */
export function extractV1(imageData) {
  const { width: w, height: h } = imageData;
  const lum  = luminance(imageData);
  const grad = sobelMag(lum, w, h);

  // Permissive adaptive threshold: mean + 0.4·stdev (lower than V2's 0.6).
  let m = 0; for (let i = 0; i < grad.length; i++) m += grad[i]; m /= grad.length;
  let v = 0; for (let i = 0; i < grad.length; i++) { const d = grad[i] - m; v += d * d; }
  const stdev = Math.sqrt(v / grad.length);
  const thresh = m + 0.4 * stdev;

  const rows = new Int32Array(w);
  const found = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    let pick = -1;
    for (let y = 0; y < h; y++) {
      if (grad[y * w + x] > thresh) { pick = y; break; }
    }
    if (pick >= 0) { rows[x] = pick; found[x] = 1; }
    else           { rows[x] = Math.floor(h * 0.4); found[x] = 0; }
  }

  // Same gap interpolation pattern V2 uses, but only for columns where
  // no edge cleared the threshold. Without continuity we don't need to
  // bridge "stuck" runs, just genuinely empty columns.
  let i = 0;
  while (i < w) {
    if (found[i]) { i++; continue; }
    let j = i;
    while (j < w && !found[j]) j++;
    const leftIdx  = i - 1;
    const rightIdx = j;
    const leftRow  = leftIdx  >= 0 && found[leftIdx]  ? rows[leftIdx]  : (rightIdx < w ? rows[rightIdx] : Math.floor(h * 0.4));
    const rightRow = rightIdx <  w && found[rightIdx] ? rows[rightIdx] : leftRow;
    const span = j - i;
    for (let k = 0; k < span; k++) {
      const t = (k + 1) / (span + 1);
      rows[i + k] = Math.round(leftRow * (1 - t) + rightRow * t);
    }
    i = j;
  }

  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) out[x] = 1 - (rows[x] / Math.max(1, h - 1));
  // Heavier post-smoothing than V2 to compensate for no continuity.
  return smooth1D(out, 5);
}

/* ── V2: Sobel + continuity constraint ──────────────────────────────────────
 * Compute Sobel gradient magnitude (luma channel). For each column find the
 * topmost row with strong gradient; require the row to stay within ±N pixels
 * of the previous column to suppress noise from clouds, foliage. Walks
 * left-to-right then right-to-left and keeps the more conservative answer.
 * ──────────────────────────────────────────────────────────────────────── */
export function extractV2(imageData) {
  const { width: w, height: h } = imageData;
  const lum = luminance(imageData);
  const grad = sobelMag(lum, w, h);

  // Threshold = mean + 0.6·stdev of gradient magnitudes (adaptive)
  let m = 0; for (let i = 0; i < grad.length; i++) m += grad[i]; m /= grad.length;
  let v = 0; for (let i = 0; i < grad.length; i++) { const d = grad[i] - m; v += d * d; }
  const stdev = Math.sqrt(v / grad.length);
  const thresh = m + 0.6 * stdev;

  const MAX_JUMP = Math.max(2, Math.floor(h * 0.04));

  // Forward pass: track per-column whether a qualifying edge was actually
  // found inside the [prev ± MAX_JUMP] window. Columns that don't find
  // one are marked unfound so they can be interpolated later instead of
  // copying prev (which is what produced the "straight line detached
  // from the rest" artifact).
  const rows = new Int32Array(w);
  const found = new Uint8Array(w);
  const initial = firstStrongRow(grad, w, h, 0, thresh);
  rows[0] = initial.row;
  found[0] = initial.ok ? 1 : 0;
  for (let x = 1; x < w; x++) {
    const prev = rows[x - 1];
    const lo = Math.max(0, prev - MAX_JUMP);
    const hi = Math.min(h - 1, prev + MAX_JUMP);
    let best = -1, bestStrength = 0;
    for (let y = lo; y <= hi; y++) {
      const s = grad[y * w + x];
      if (s < thresh) continue;
      // prefer the topmost qualifying edge, breaking ties by strength
      if (best < 0 || y < best || (y === best && s > bestStrength)) {
        best = y; bestStrength = s;
      }
    }
    if (best < 0) { rows[x] = prev; found[x] = 0; }
    else          { rows[x] = best; found[x] = 1; }
  }

  // Linear interpolation over runs of unfound columns. Each gap is
  // bridged from the last known-good row to the next known-good row;
  // gaps at the ends extend the nearest known value.
  let i = 0;
  while (i < w) {
    if (found[i]) { i++; continue; }
    let j = i;
    while (j < w && !found[j]) j++;
    const leftIdx  = i - 1;
    const rightIdx = j;
    const leftRow  = leftIdx  >= 0 && found[leftIdx]  ? rows[leftIdx]  : (rightIdx < w ? rows[rightIdx] : Math.floor(h * 0.4));
    const rightRow = rightIdx <  w && found[rightIdx] ? rows[rightIdx] : leftRow;
    const span = j - i;
    for (let k = 0; k < span; k++) {
      const t = (k + 1) / (span + 1);
      rows[i + k] = Math.round(leftRow * (1 - t) + rightRow * t);
    }
    i = j;
  }

  // Final cleanup pass: any remaining single-column spikes get clipped
  // to MAX_JUMP from their neighbor (handles edge cases where a found
  // column was technically in-window but not aligned with its run).
  for (let x = w - 2; x >= 0; x--) {
    const next = rows[x + 1];
    if (Math.abs(rows[x] - next) > MAX_JUMP) rows[x] = next;
  }

  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) out[x] = 1 - (rows[x] / Math.max(1, h - 1));
  return smooth1D(out, 3);
}

function firstStrongRow(grad, w, h, x, thresh) {
  for (let y = 0; y < h; y++) {
    if (grad[y * w + x] > thresh) return { row: y, ok: true };
  }
  return { row: Math.floor(h * 0.4), ok: false };
}

/* ── V3: auto-select V1 or V2 by measuring V1's noise level ─────────────────
 * Run V1 first. Build a heavily-smoothed copy and measure the mean
 * absolute residual between V1 and that smooth. The residual is the
 * "noise floor" of V1's output:
 *   • Mountain / skyline: V1's output IS the structure, residual is small
 *     after smoothing tracks the structure.
 *   • Forest: V1 picks up canopy texture (single-column edges from
 *     unrelated leaves), residual is large because the smooth flattens
 *     out something V1 thought was real.
 * If residual > NOISE_THRESHOLD, the image is forest-like → return V2.
 * Otherwise return V1. The picked id is exposed on the returned object
 * so the studio can label what was chosen.
 * ──────────────────────────────────────────────────────────────────────── */
export function extractV3(imageData) {
  const v1 = extractV1(imageData);

  // Heavy smoothing — wide enough to flatten texture but not so wide
  // that real structure (mountain ridge, building tops) is washed out.
  const smooth = smooth1D(v1, 11);
  let residual = 0;
  for (let i = 0; i < v1.length; i++) residual += Math.abs(v1[i] - smooth[i]);
  residual /= v1.length;

  const NOISE_THRESHOLD = 0.007;
  const picked = residual > NOISE_THRESHOLD ? 'v2' : 'v1';
  const profile = picked === 'v2' ? extractV2(imageData) : v1;

  // Return Float32Array tagged with metadata so callers expecting a plain
  // profile still work, while the studio can read `.picked` for the label.
  // (Float32Array supports adding properties.)
  /** @type {Float32Array & { picked: string, residual: number }} */
  const tagged = profile;
  tagged.picked = picked;
  tagged.residual = residual;
  return tagged;
}

/* ── Shared image-processing helpers ────────────────────────────────────── */

function luminance(imageData) {
  const { width: w, height: h, data } = imageData;
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return out;
}

function boxBlur2D(field, w, h, radius) {
  const tmp = new Float32Array(field.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xi = x + dx;
        if (xi < 0 || xi >= w) continue;
        sum += field[y * w + xi]; cnt++;
      }
      tmp[y * w + x] = sum / cnt;
    }
  }
  const out = new Float32Array(field.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yi = y + dy;
        if (yi < 0 || yi >= h) continue;
        sum += tmp[yi * w + x]; cnt++;
      }
      out[y * w + x] = sum / cnt;
    }
  }
  return out;
}

function sobelMag(lum, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = lum[i - w - 1], b = lum[i - w], c = lum[i - w + 1];
      const d = lum[i - 1],                       e = lum[i + 1];
      const f = lum[i + w - 1], g = lum[i + w], hh = lum[i + w + 1];
      const gx = -a + c - 2 * d + 2 * e - f + hh;
      const gy = -a - 2 * b - c + f + 2 * g + hh;
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/* Box-blur an array in place (k samples each side) */
function smooth1D(arr, k) {
  const n = arr.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = -k; j <= k; j++) {
      const m = i + j;
      if (m < 0 || m >= n) continue;
      s += arr[m]; c++;
    }
    out[i] = s / c;
  }
  return out;
}

/* ============================================================================
 * PROCEDURAL (secondary) — preserved unchanged from the previous version
 * ========================================================================== */

export const PRESETS = {
  hills:    { scale: 1.6, octaves: 3, roughness: 0.42, peak: 0.45,
              baseline: 0.18, sharpness: 0.15 },
  mountain: { scale: 2.2, octaves: 5, roughness: 0.62, peak: 0.82,
              baseline: 0.12, sharpness: 0.55 },
  urban:    { scale: 5.5, octaves: 4, roughness: 0.78, peak: 0.7,
              baseline: 0.22, sharpness: 0.85 },
  coast:    { scale: 1.1, octaves: 2, roughness: 0.3,  peak: 0.28,
              baseline: 0.08, sharpness: 0.05 },
  forest:   { scale: 4.0, octaves: 4, roughness: 0.55, peak: 0.55,
              baseline: 0.32, sharpness: 0.35 },
};

export function generateProfile(opts = {}) {
  const {
    seed       = randomSeed(),
    width      = 1024,
    scale      = 2.5,
    octaves    = 4,
    roughness  = 0.55,
    peak       = 0.7,
    baseline   = 0.15,
    sharpness  = 0.4,
  } = opts;

  const noise = makeNoise1D(seed);
  const out   = new Float32Array(width);

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
    const v = sum / Math.max(1e-6, norm);
    out[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }

  const span  = Math.max(1e-6, hi - lo);
  const top   = Math.max(baseline + 0.01, peak);
  const range = top - baseline;
  for (let i = 0; i < width; i++) {
    let v = (out[i] - lo) / span;
    if (v < 0) v = 0; else if (v > 1) v = 1;
    v = sharpen(v, sharpness);
    out[i] = baseline + v * range;
  }
  return out;
}

function sharpen(v, s) {
  if (s <= 0) return v;
  const k = 1 + s * 7;
  if (v < 0.5) return 0.5 * Math.pow(2 * v, k);
  return 1 - 0.5 * Math.pow(2 * (1 - v), k);
}

export function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}

export function formatSeed(seed) {
  return '0x' + (seed >>> 0).toString(16).padStart(8, '0');
}

export function parseSeed(text) {
  if (text == null) return null;
  const t = String(text).trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith('0x')) {
    const n = parseInt(t.slice(2), 16);
    return Number.isFinite(n) ? (n >>> 0) : null;
  }
  const asHex = parseInt(t, 16);
  if (/^[0-9a-f]+$/.test(t) && /[a-f]/.test(t)) {
    return Number.isFinite(asHex) ? (asHex >>> 0) : null;
  }
  const asDec = Number(t);
  if (Number.isFinite(asDec)) return (asDec >>> 0);
  return Number.isFinite(asHex) ? (asHex >>> 0) : null;
}

function makeNoise1D(seed) {
  const rng = makeRng(seed);
  const N = 512;
  const table = new Float32Array(N);
  for (let i = 0; i < N; i++) table[i] = rng();

  return function (x) {
    const i = Math.floor(x);
    const f = x - i;
    const a = table[((i % N) + N) % N];
    const b = table[(((i + 1) % N) + N) % N];
    const t = (1 - Math.cos(f * Math.PI)) * 0.5;
    return a * (1 - t) + b * t;
  };
}
