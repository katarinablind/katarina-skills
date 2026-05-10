/**
 * Palette V2 — Vibrance-weighted diversity (skylinemusic canonical)
 * ==================================================================
 * Two-pass greedy selection with a diversity constraint.
 *
 *   Pass 1: rank buckets by blended score (count + vibrance), walk
 *           the list accepting only buckets at least MIN_DIST=45 RGB
 *           away from every previous pick.
 *   Pass 2: if fewer than k picked, walk by pure vibrance at
 *           0.55·MIN_DIST to fill any remaining slots.
 *
 * Key tunings:
 *   Score blend:  0.55·count_norm + 0.45·vibrance_norm
 *   Vibrance:     count · max(0, s − 0.12) · (0.3 + midLight · 0.7)
 *   MIN_DIST:     45  (≈ perceptibly different in RGB Euclidean space)
 *
 * 45 is the whole design:
 *   - Raise it → monochrome images can't fill 5 swatches.
 *   - Lower it → forest photos yield four near-identical dark greens.
 *
 * Lifted verbatim from skylinemusic/js/colorAnalysis.js. Do not edit
 * this file to "fix" V2 — create mappingV3.js and let them race.
 */

export const META = {
  id: 'v2',
  name: 'V2 · Vibrance + diversity',
  description: 'Score-ranked greedy with RGB-distance gate. Escape hatch for monochromes.',
  constants: { MIN_DIST: 45, SCORE_COUNT_W: 0.55, SCORE_VIB_W: 0.45, S_FLOOR: 0.12 },
};

export function extractPalette(canvas, k = 5) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;

  const stepX = Math.max(1, Math.floor(w / 60));
  const stepY = Math.max(1, Math.floor(h / 60));
  let totalSamples = 0;
  const bucket = new Map();
  for (let y = 0; y < h; y += stepY) {
    for (let x = 0; x < w; x += stepX) {
      const i = (y * w + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const e = bucket.get(key);
      if (e) { e[0] += r; e[1] += g; e[2] += b; e[3]++; }
      else   bucket.set(key, [r, g, b, 1]);
      totalSamples++;
    }
  }

  const all = [...bucket.values()].map(([rs, gs, bs, n]) => {
    const r = rs / n, g = gs / n, b = bs / n;
    const hsl = rgbToHsl(r, g, b);
    const midLight = Math.min(hsl.l, 1 - hsl.l) * 2;
    const vibrance = n * Math.max(0, hsl.s - 0.12) * (0.3 + midLight * 0.7);
    return {
      r: Math.round(r), g: Math.round(g), b: Math.round(b),
      count: n, weight: n / totalSamples,
      h: hsl.h, s: hsl.s, l: hsl.l,
      vibrance,
    };
  });

  if (all.length === 0) return [];

  const dist = (a, b) => {
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const farEnough = (c, picks, min) => picks.every(p => dist(c, p) >= min);

  const maxCount = all.reduce((m, c) => Math.max(m, c.count), 1);
  const maxVib   = all.reduce((m, c) => Math.max(m, c.vibrance), 1e-6);
  const scored = all.map(c => ({
    ...c,
    score: (c.count / maxCount) * 0.55 + (c.vibrance / maxVib) * 0.45,
  }));

  const MIN_DIST = 45;
  const picks = [];

  const byScore = [...scored].sort((a, b) => b.score - a.score);
  for (const c of byScore) {
    if (picks.length >= k) break;
    if (farEnough(c, picks, MIN_DIST)) picks.push(c);
  }

  if (picks.length < k) {
    const byVibrance = [...scored].sort((a, b) => b.vibrance - a.vibrance);
    for (const c of byVibrance) {
      if (picks.length >= k) break;
      if (picks.includes(c)) continue;
      if (farEnough(c, picks, MIN_DIST * 0.55)) picks.push(c);
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
