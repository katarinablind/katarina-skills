---
name: lo-fi-cursor-birds
description: Use when building a small flock of cursor-following 2D creatures (birds, fish, insects, ghosts) with a "lo-fi character" feel — rendered as image stacks (body + 2 wings) or curve glyphs (V, M, dash), each with a stable per-individual identity (random flap rate, base velocity, size variant), gentle attraction toward the cursor with a falloff-gated force and speed cap, and a graceful return to base velocity when the cursor leaves. Covers the per-bird state shape, the `vx += (cursor - bird) * pull * dt` force model, the speed-cap clamp, the `(1 - 0.35^dt)` exponential blend back to base velocity, vertical bobbing, wing-flap phase, sprite-flip on direction reverse, pair-wise vertical separation to prevent overlap, the always-at-least-one-visible failsafe, and the multi-image-stack rendering (body + lifted wing tips). Skip for steered-AI flocks (use boids), single hero characters (this is for a *flock*), or full physics (this is gentle attraction, not collision).
---

## What gives them character

Five ingredients, all small:

1. **Per-bird stable identity**: each bird gets a random `flapRate`, `baseVx` (signed), `size`, `depth`, plus a stable shuffle of 3 image indices. They never change after spawn.
2. **Image-stack rendering**: body + 2 wings as separate sprites, with the wings *lifted* by `-flap * s * 0.22` so they look like they're flapping.
3. **Vertical bob**: `bob = sin(phase * 0.7) * 2.0` — small, slow, separate from the flap.
4. **Sprite-flip on direction reverse**: `if (vx < 0) ctx.scale(-1, 1)` so birds always face their direction of travel.
5. **Falloff-gated cursor pull, not a hard target**: birds *drift toward* the cursor with a force, hit a speed cap, then drift back to their base velocity when the cursor leaves. They never snap.

Without (1) and (2), they look like generic particles. Without (3) and (5), they look like cursor followers, not creatures.

## Per-bird state

```js
{
  x, y,                           // position
  vx, vy,                         // velocity (vy may be undefined initially)
  baseVx,                         // signed base horizontal speed (this is "where it wants to go")
  phase,                          // wing-flap phase, 0..2π+
  flapRate,                       // 2.6..5 rad/s — per-bird signature
  size,                           // 0.75..1.25 × base size
  depth,                          // 0.55..1 — affects alpha and apparent size
  imgIdxs,                        // [3 stable image indices for body + 2 wings]
  color, grad,                    // for non-image rendering
}
```

```js
function buildBirds(W, H, count) {
  const birds = [];
  for (let i = 0; i < count; i++) {
    const size = BASE_SIZE * (0.75 + Math.random() * 0.5);
    const baseVx = (16 + Math.random() * 36) * (Math.random() < 0.5 ? -1 : 1);

    // Stable per-bird image stack — shuffle pool, take first 3
    const pool = IMG_POOL.map((_, k) => k);
    for (let s = pool.length - 1; s > 0; s--) {
      const r = Math.floor(Math.random() * (s + 1));
      [pool[s], pool[r]] = [pool[r], pool[s]];
    }

    birds.push({
      x: Math.random() * W * 1.4 - W * 0.2,
      y: pickY(size, H),
      vx: baseVx, baseVx,
      phase: Math.random() * Math.PI * 2,
      flapRate: 2.6 + Math.random() * 2.4,
      size,
      depth: 0.55 + Math.random() * 0.45,
      imgIdxs: pool.slice(0, 3),
    });
  }
  return birds;
}
```

The `Math.random() * W * 1.4 - W * 0.2` initial X spread starts birds inside *and outside* the canvas — the off-canvas ones drift in naturally over the first few seconds, no "all spawned at once" pop.

## Cursor pull (the force model, not target lerp)

```js
function update(birds, dt, cursor, W, H) {
  for (const b of birds) {
    if (cursor.inside) {
      const dx = cursor.x - b.x;
      const dy = cursor.y - b.y;
      const d = Math.hypot(dx, dy) + 1;
      // falloff: 0 at d≤25, ramping to 1 at d≥105 — birds within 25px of cursor drift, not chase
      const falloff = Math.max(0, Math.min(1, (d - 25) / 80));
      const pull = 420 * falloff;          // px/s² of acceleration
      const ux = dx / d, uy = dy / d;
      b.vx += ux * pull * dt;
      b.vy = (b.vy || 0) + uy * pull * dt;

      // Speed cap — without this they overshoot the cursor and oscillate
      const speed = Math.hypot(b.vx, b.vy);
      const maxSpeed = 160;
      if (speed > maxSpeed) {
        b.vx *= maxSpeed / speed;
        b.vy *= maxSpeed / speed;
      }
    } else {
      // Exponential blend back toward base velocity, framerate-independent
      const blend = 1 - Math.pow(0.35, dt);
      b.vx += (b.baseVx - b.vx) * blend;
      b.vy = (b.vy || 0) * Math.pow(0.4, dt * 4);
      if (Math.abs(b.vy) < 0.4) b.vy = 0;
    }

    b.x += b.vx * SPEED_MULT * dt;
    b.y += (b.vy || 0) * SPEED_MULT * dt;
    b.phase += dt * b.flapRate;

    // Wrap: when off the right edge with positive vx, respawn on left at fresh y
    const pad = b.size * 6;
    if (b.vx > 0 && b.x > W + pad) { b.x = -pad; b.y = pickY(b.size, H); }
    if (b.vx < 0 && b.x < -pad)    { b.x = W + pad; b.y = pickY(b.size, H); }
    b.y = clampY(b, H);
  }
}
```

Three pieces work together: **inverted falloff** (`(d - 25) / 80`) so close birds don't get jittery near the cursor, **pull as acceleration** (not a snap to position), **speed cap** to prevent fly-through-and-back. The blend back to base is `Math.pow(0.35, dt)` so the birds re-organize over ~1 second when the cursor leaves.

## Always-at-least-one-visible failsafe

If you cursor-corral birds offscreen, they all wrap and respawn — but during the wrap window the canvas is empty for a second. Fix: after every update, if no bird is visible, teleport the one closest to an edge into a random visible position.

```js
let anyVisible = false;
for (const b of birds) if (b.x >= 0 && b.x <= W) { anyVisible = true; break; }
if (!anyVisible) {
  let bestB = birds[0], bestD = Infinity;
  for (const b of birds) {
    const distEdge = b.vx > 0 ? Math.abs(-b.x) : Math.abs(b.x - W);
    if (distEdge < bestD) { bestD = distEdge; bestB = b; }
  }
  bestB.x = Math.random() * W;
  bestB.y = pickY(bestB.size, H);
}
```

Worth the 5 lines. Without it the canvas occasionally goes blank and the page feels broken.

## Pair-wise vertical separation

Birds clump on the cursor. Push them apart vertically (only — preserve x for direction integrity):

```js
for (let i = 0; i < birds.length; i++) {
  for (let j = i + 1; j < birds.length; j++) {
    const a = birds[i], c = birds[j];
    const minDist = (a.size + c.size) * 1.6 + 8;
    const dx = c.x - a.x, dy = c.y - a.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < minDist * minDist && d2 > 0.0001) {
      const d = Math.sqrt(d2);
      const overlap = minDist - d;
      const sign = dy >= 0 ? 1 : -1;
      a.y -= sign * overlap * 0.5;
      c.y += sign * overlap * 0.5;
      a.y = clampY(a, H);
      c.y = clampY(c, H);
    }
  }
}
```

O(n²) is fine for ~10 birds. Don't add forces for x-overlap — the natural `vx` direction handles horizontal spacing through wrap-around.

## Image-stack rendering

The "lo-fi character" trick — body in the middle, two wings flanking it, wings lifted by current flap fraction:

```js
function drawOne(b, ctx) {
  const flap = Math.sin(b.phase) * 0.5 + 0.5;     // 0..1
  const s = b.size * (0.7 + b.depth * 0.4);
  const bob = Math.sin(b.phase * 0.7) * 2.0;       // independent slow bob
  const cx = b.x, cy = b.y + bob;
  ctx.globalAlpha = 0.55 + b.depth * 0.35;

  const lift = -flap * s * 0.22;
  const positions = [
    { x: cx,             y: cy,        w: s * 0.55, idx: b.imgIdxs[0] },  // body
    { x: cx - s * 0.55,  y: cy + lift, w: s * 0.45, idx: b.imgIdxs[1] },  // left wing
    { x: cx + s * 0.55,  y: cy + lift, w: s * 0.45, idx: b.imgIdxs[2] },  // right wing
  ];
  const flipX = b.vx < 0 ? -1 : 1;
  for (const p of positions) {
    const img = IMGS[p.idx];
    if (img && img.complete && img.naturalWidth > 0) {
      const ratio = img.naturalHeight / img.naturalWidth;
      const h = p.w * ratio;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (flipX < 0) ctx.scale(-1, 1);
      ctx.drawImage(img, -p.w / 2, -h / 2, p.w, h);
      ctx.restore();
    }
  }
}
```

The wing `lift = -flap * s * 0.22` is what sells it. When the wings are at peak flap, both wing sprites lift above the body — the bird looks like it just pushed down through the air.

## Curve-glyph fallback (no images)

When you don't have art, bird-shaped curves work:

```js
// 'm' style — a wide arc with a notch (the classic seagull silhouette)
const wing = 0.18 + flap * 0.5;
ctx.lineWidth = Math.max(1.2, s * 0.12);
ctx.beginPath();
ctx.moveTo(cx - s, cy + Math.sin(wing) * s * 0.45);
ctx.quadraticCurveTo(cx - s * 0.5, cy - s * wing * 0.9, cx, cy);
ctx.quadraticCurveTo(cx + s * 0.5, cy - s * wing * 0.9, cx + s, cy + Math.sin(wing) * s * 0.45);
ctx.stroke();
```

`m` reads as a bird at any zoom level, scales gracefully, and animates well via `wing`. Useful for backgrounds where the silhouette is enough.

## Lifecycle wiring (canvas + observers)

Don't run these continuously when offscreen.

```js
function startWhenVisible(canvas, tick) {
  let active = false, raf = 0, lastT = performance.now();
  const loop = () => {
    if (!active) { raf = 0; return; }
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    tick(dt);
    raf = requestAnimationFrame(loop);
  };
  new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        if (!active) { active = true; lastT = performance.now(); if (!raf) raf = requestAnimationFrame(loop); }
      } else active = false;
    }
  }, { threshold: 0 }).observe(canvas);
}
```

`Math.min(0.05, dt)` is the dt clamp — protects against tab-switch resume where a 30-second dt would warp every bird off the screen.

## Tunable knobs

| Knob | Default | Effect |
|---|---|---|
| `count` | 4 | Birds in the flock — keep ≤8 for "ambient" feel |
| `BASE_SIZE` | 38 | Pixel size at depth=1; multiply by 0.75–1.25 per bird |
| `flapRate` | 2.6–5 rad/s | Range, not constant — this is what gives identity |
| `pull` | 420 | Cursor force; lower = lazier, higher = more obedient |
| `maxSpeed` | 160 | Px/s cap — without this they overshoot |
| `falloff (d-25)/80` | — | 25 = no-jitter zone around cursor; 80 = falloff range |
| Return blend | `0.35^dt` | Lower = faster return; 0.35 ≈ 1s settling |
| Bob amp | 2.0 | Px — keep small |
| Wing lift | `0.22` | Larger = more dramatic flap |

## Common mistakes

- **Lerping x/y toward cursor instead of accelerating velocity.** Birds snap; they don't drift.
- **No speed cap.** They reach the cursor, blast through, and bounce back. Visually awful.
- **Identical flap rate per bird.** They look like a synchronized chorus line. Random per bird.
- **Drawing one sprite instead of three.** No flap = no character. Three sprites with the lift trick is the whole gag.
- **Forgetting `dt` clamp on tab resume.** First frame after re-foregrounding warps everyone offscreen.
- **Hard target on cursor.** Birds bounce on top of each other in a stack. Use the falloff-gated force model.
- **Skipping the always-visible failsafe.** Canvas occasionally goes blank for ~1 sec when wrapping a tight flock. Looks like a bug.
