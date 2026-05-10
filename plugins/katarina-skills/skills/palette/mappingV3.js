/**
 * Palette V3 — Multiplicative score + hue-aware diversity
 * =========================================================
 *
 * Fixes two independent problems from V2 and V3-α:
 *
 * ── Problem 1: vivid accents overpowering structural colors ─────────────────
 * V3-α used: score = 0.5 × count_norm + 0.5 × vivacity_norm
 * A 3% orange-pink cluster with vivacity_norm = 1.0 scores 0.5 — strong
 * enough to claim multiple palette slots and crowd out grey rock or blue sky.
 *
 * Fix: make vivacity a multiplier on count, not an independent term.
 *   score = count_norm × (1 + vivacity × BOOST)
 *
 * A 3% cluster (count_norm≈0.03) can score at most 0.03 × (1 + BOOST).
 * A 25% blue sky (count_norm≈0.5) scores 0.5 × (1 + vivacity × BOOST).
 * Count always sets the ceiling. Vivacity lifts a color up to BOOST× its
 * count-only score — meaningful boost, but proportional to presence.
 *
 * ── Problem 2: same hue family filling multiple slots ───────────────────────
 * RGB Euclidean distance lets dark green + medium green coexist (they're
 * ~80 apart in RGB) even though they read as "the same color, different shade."
 *
 * Fix: a two-part diversity check (a candidate is blocked by an existing pick
 * if EITHER condition is true):
 *   A) RGB_dist(c, pick) < MIN_DIST (= 40)
 *      General separation; governs neutrals where hue is meaningless.
 *   B) hue_diff < 20°
 *      AND lightness_diff < 0.22
 *      AND c.s > 0.15 AND pick.s > 0.15
 *      "Same color, slightly different shade." Only applies when both colors
 *      are actually chromatic (s > 0.15). Greys and near-whites bypass B and
 *      rely on RGB distance alone.
 *      lightness_diff < 0.22 means two same-hue colors at genuinely different
 *      brightness (dark forest floor + sunlit canopy) can still coexist when
 *      there are no other distinct hues to fill the palette.
 *
 * ── Vivacity formula ────────────────────────────────────────────────────────
 *   vivacity = max(0, s − 0.08) × (0.2 + midLight × 0.8)   [per-pixel, absolute]
 *   Floor 0.08 catches lightly-saturated warm whites and pale yellows.
 *   midLight coefficient 0.8 lifts bright warm tones (orange, yellow) over
 *   dark saturated ones at equal pixel count.
 *   No count factor — score formula handles the count relationship.
 *
 * ── Passes ──────────────────────────────────────────────────────────────────
 *   Pass 1  blended score,   RGB 40 + hue gate  (main structural + vivid picks)
 *   Pass 2  vivacity sweep,  RGB 22 + hue gate  (sparse vivid accents; only
 *           colors with vivacity > 0.15 qualify — bars dull structural shades)
 *   Pass 3  count fill,      RGB 16 + hue gate  (monochrome safety valve)
 */

export const META = {
  id: 'v3',
  name: 'V3 · Perceptual extremes',
  description: 'Proportional multiplicative score + hue-aware diversity gate.',
  constants: { MIN_DIST: 40, BOOST: 5, HUE_TOL: 20, L_TOL: 0.22, S_MIN: 0.15, VIV_FLOOR: 0.08 },
};

export function extractPalette(canvas, k = 5) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;

  const stepX = Math.max(1, Math.floor(w / 60));
  const stepY = Math.max(1, Math.floor(h / 60));
  const bucket = new Map();
  for (let y = 0; y < h; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = bucket.get(key);
      if (e) { e[0] += r; e[1] += g; e[2] += b; e[3]++; }
      else   bucket.set(key, [r, g, b, 1]);
    }
  }

  const all = [...bucket.values()].map(([rs, gs, bs, n]) => {
    const r = rs / n, g = gs / n, b = bs / n;
    const hsl = rgbToHsl(r, g, b);
    const midLight = Math.min(hsl.l, 1 - hsl.l) * 2;
    const vivacity = Math.max(0, hsl.s - 0.08) * (0.2 + midLight * 0.8);
    return {
      r: Math.round(r), g: Math.round(g), b: Math.round(b),
      count: n, h: hsl.h, s: hsl.s, l: hsl.l, vivacity,
    };
  });

  if (all.length === 0) return [];

  // ── Diversity check ───────────────────────────────────────────────────────
  const hueDist = (h1, h2) => { const d = Math.abs(h1 - h2); return Math.min(d, 360 - d); };

  const tooSimilar = (c, p, minRgb) => {
    const dr = c.r - p.r, dg = c.g - p.g, db = c.b - p.b;
    if (Math.sqrt(dr * dr + dg * dg + db * db) < minRgb) return true;
    if (c.s > 0.15 && p.s > 0.15) {
      if (hueDist(c.h, p.h) < 20 && Math.abs(c.l - p.l) < 0.22) return true;
    }
    return false;
  };

  const farEnough = (c, picks, minRgb) => picks.every(p => !tooSimilar(c, p, minRgb));

  // ── Scoring: vivacity multiplies count, never replaces it ─────────────────
  const maxCount = all.reduce((m, c) => Math.max(m, c.count), 1);
  const BOOST = 5;

  const scored = all.map(c => ({
    ...c,
    score: (c.count / maxCount) * (1 + c.vivacity * BOOST),
  }));

  const MIN_DIST = 40;
  const picks = [];

  // Pass 1 — proportional: structural and vivid compete on equal terms
  const byScore = [...scored].sort((a, b) => b.score - a.score);
  for (const c of byScore) {
    if (picks.length >= k) break;
    if (farEnough(c, picks, MIN_DIST)) picks.push(c);
  }

  // Pass 2 — accent sweep: catches sparse vivid highlights pass 1 missed.
  // Threshold vivacity > 0.15 prevents dull structural shades from sneaking in.
  if (picks.length < k) {
    const byVivacity = [...scored].sort((a, b) => b.vivacity - a.vivacity);
    for (const c of byVivacity) {
      if (picks.length >= k) break;
      if (c.vivacity <= 0.15) break;
      if (picks.includes(c)) continue;
      if (farEnough(c, picks, MIN_DIST * 0.55)) picks.push(c);
    }
  }

  // Pass 3 — count fill: monochrome safety valve
  if (picks.length < k) {
    for (const c of byScore) {
      if (picks.length >= k) break;
      if (picks.includes(c)) continue;
      if (farEnough(c, picks, MIN_DIST * 0.4)) picks.push(c);
    }
  }

  picks.sort((a, b) => b.l - a.l);
  return picks.slice(0, k);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h, s;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return { h, s, l };
}
