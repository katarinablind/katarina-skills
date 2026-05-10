/**
 * Palette V1 — Naive top-k by count
 * ==================================
 * The "dominant = most frequent" baseline. Uses the same 4-bit RGB
 * bucketing and sampling grid as V2, but with no vibrance weighting
 * and no diversity constraint — pure top-5-by-count.
 *
 * Expected failure modes this studio should surface:
 *   - Forest photo: 4 near-identical dark greens crowd out lighter tones.
 *   - Sunset with a small accent: the hot pink is too few pixels to rank.
 *   - Monochrome: produces 5 near-identical swatches.
 *
 * This file is a museum piece — do not "improve" it. It exists as the
 * contrast against which V2's design choices are visible.
 */

export const META = {
  id: 'v1',
  name: 'V1 · Naive top-k',
  description: 'Raw bucket counts. The thing every palette library ships by default.',
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
  return [...bucket.values()]
    .sort((a, b) => b[3] - a[3])
    .slice(0, k)
    .map(([r, g, b, n]) => ({
      r: Math.round(r / n),
      g: Math.round(g / n),
      b: Math.round(b / n),
      count: n,
    }));
}
