---
name: cursor-ripple-field
description: Use when adding cursor- or click-triggered expanding-ring ripple distortions to any 2D point grid (water, fabric, halftone fields, particle clouds) — outputs a vertical (or arbitrary-axis) offset per query point that reads as a wave radiating from the impact site, with a Gaussian envelope around the leading edge so the ripple has a *visible ring* instead of being a flat sin field. Covers the ripple data model, the move-debouncing rules (min gap + min distance) that prevent spam, the click-vs-move amplitude split, the FIFO cap, and the core `dy = -cos(phase) × ringEnvelope × lifeFade × amp` formula with `phase = (d/λ - age·speed/2λ)·2π` and `ringEnvelope = exp(-(d - age·speed)² / decay²)`. Skip for full fluid simulations, shader-based water (use a fragment shader), CSS-pseudo-element ripples (Material Design), or springy on-touch UI (use a transform animation) — this is a per-pixel/per-vertex offset field for canvas/3D pipelines.
---

## What it produces

A pure function: given a 2D query point and the current time, return a scalar offset (typically applied to the point's Y or a height value). The ripple field is *additive* — sum the contributions of all active ripples to get the total offset.

```
                           ringEnvelope = exp(-(d - age·speed)² / decay²)
                           ▲
                           │     ╭─╮  ← peak when d ≈ age·speed (the leading edge)
                           │    ╱   ╲
                           │   ╱     ╲
                           │  ╱       ╲
                           │ ╱         ╲___
                           ┼──────────────────► distance from ripple center
                                d
```

The query point's offset is `−cos(phase)` modulated by this Gaussian envelope, so points right at the leading edge oscillate maximally and points well ahead or behind contribute almost nothing.

## Ripple data model

```js
const RIPPLE_LIFE   = 1.8;     // seconds before ripple expires
const RIPPLE_AMP    = 8;       // base offset amplitude (px or world units)
const RIPPLE_LAMBDA = 110;     // wavelength (controls cos() spatial frequency)
const RIPPLE_SPEED  = 200;     // ring expansion speed (units/s)
const RIPPLE_DECAY  = 240;     // Gaussian width around the ring edge
const RIPPLE_MIN_GAP_MS = 180; // min ms between move-triggered ripples
const RIPPLE_MIN_DIST   = 60;  // min cursor delta between move-triggered ripples
const MAX_RIPPLES = 12;        // FIFO cap

const ripples = [];

function addRipple(sx, sy, ampMul = 1, t) {
  ripples.push({
    sx, sy,           // origin (in same coord space as your query points)
    t,                // birth time in seconds
    life: RIPPLE_LIFE,
    amp: RIPPLE_AMP * ampMul,
  });
  if (ripples.length > MAX_RIPPLES) ripples.shift();   // FIFO
}
```

The FIFO cap matters: without it, dragging across the canvas spawns dozens of ripples and the offset field becomes noise.

## Triggering: debounce hard

Movement-triggered ripples spam easily. Two gates:

```js
let lastRippleAt = 0;
let lastRippleX = -9999, lastRippleY = -9999;

function onMove(e) {
  const r = canvas.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right ||
      e.clientY < r.top  || e.clientY > r.bottom) return;
  const now = performance.now();
  if (now - lastRippleAt < RIPPLE_MIN_GAP_MS) return;       // time gate
  const lx = e.clientX - r.left;
  const ly = e.clientY - r.top;
  const moved = Math.hypot(lx - lastRippleX, ly - lastRippleY);
  if (moved < RIPPLE_MIN_DIST) return;                       // distance gate
  lastRippleAt = now;
  lastRippleX = lx; lastRippleY = ly;
  addRipple(lx, ly, 1.0, (performance.now() - t0) * 0.001);
}

function onClick(e) {
  const r = canvas.getBoundingClientRect();
  if (outsideCanvas(e, r)) return;
  // Clicks always fire — no debounce, but with bigger amplitude
  addRipple(e.clientX - r.left, e.clientY - r.top, 2.4, (performance.now() - t0) * 0.001);
}
```

Move uses `1.0` amp; click uses `2.4`. The 2.4× lets the user *feel* the click-vs-move difference without the ripple math caring about input source.

## The offset function

```js
function rippleOffset(sx, sy, tt) {
  let dy = 0;
  for (const rp of ripples) {
    const age = tt - rp.t;
    if (age < 0 || age > rp.life) continue;
    const dx = sx - rp.sx;
    const dyR = sy - rp.sy;
    const d = Math.hypot(dx, dyR);

    const ringR = age * RIPPLE_SPEED;          // current ring radius
    const ringDelta = d - ringR;                // distance from leading edge
    const ring = Math.exp(-(ringDelta * ringDelta) / (RIPPLE_DECAY * RIPPLE_DECAY));

    const phase = (d / RIPPLE_LAMBDA - age * RIPPLE_SPEED / (RIPPLE_LAMBDA * 2)) * Math.PI * 2;
    const lifeFade = 1 - age / rp.life;

    dy += -Math.cos(phase) * ring * lifeFade * rp.amp;
  }
  return dy;
}
```

Three multiplicative factors:

1. **`ring` (Gaussian envelope around `age·speed`)** — kills contribution far from the leading edge. This is what makes the ripple read as a *ring* instead of a global wobble.
2. **`lifeFade` (linear age decay)** — 1.0 at birth, 0 at death. Without this the ring would just keep expanding at full strength forever.
3. **`-Math.cos(phase)`** — the actual oscillation. The negative sign means the leading edge dips down first (water-like). Drop the `-` for "rises first."

The phase `(d/λ - age·speed/2λ)·2π` gives spatial-frequency `1/λ` with a time term that retreats from the ring center as the ring expands — this is what makes the wavelength feel coupled to motion rather than a static pattern.

## Aging out

```js
function pruneRipples(tt) {
  for (let i = ripples.length - 1; i >= 0; i--) {
    if (tt - ripples[i].t > ripples[i].life) ripples.splice(i, 1);
  }
}
```

Run once per frame at the top of your tick. With the FIFO cap above, this almost never matters in practice — but it's cheap and avoids leaks if your loop runs without bound.

## Applying to a grid

Once `rippleOffset` exists, you apply it wherever you have a 2D grid:

```js
// In a halftone water surface (after projection):
const p = project(x, y, z);
if (ripples.length) p.sy += rippleOffset(p.sx, p.sy, tt);

// In a height-mapped grid:
heightField[i] += rippleOffset(x, z, tt);

// In a particle field (per particle):
particle.y += rippleOffset(particle.x, particle.y, tt);
```

The offset is in the same units as your input coordinates. If your grid lives in screen space, ripple origins should be in screen space; if it lives in world units, scale accordingly.

## Performance

`rippleOffset` is O(grid × ripples). With `MAX_RIPPLES = 12` and a 30×11 grid, that's 3,960 calls per frame — fast on any machine. If you go larger (say a 200×200 height field with 30 active ripples = 1.2M calls/frame), you start feeling it. Two mitigations:

- **Skip ripples whose `ringR` is far past your point.** If `ringDelta > 4 * RIPPLE_DECAY`, the contribution is < 0.0003 — `continue`.
- **Skip ripples whose envelope is dead.** Once `lifeFade < 0.05`, the ripple effectively contributes nothing.

```js
if (Math.abs(ringDelta) > 4 * RIPPLE_DECAY) continue;
if (lifeFade < 0.05) continue;
```

## Tunable knobs

| Knob | Default | Effect |
|---|---|---|
| `LIFE` | 1.8s | How long a ripple lives |
| `AMP` | 8 | Base offset magnitude |
| `LAMBDA` | 110 | Wavelength — smaller = more oscillations per ring |
| `SPEED` | 200 | Ring expansion speed (units/s) |
| `DECAY` | 240 | Gaussian width — larger = thicker ring |
| `MIN_GAP_MS` | 180 | Move-trigger time debounce |
| `MIN_DIST` | 60 | Move-trigger distance debounce |
| `MAX_RIPPLES` | 12 | FIFO cap |
| Click amp mul | 2.4 | Click vs move feel |

Two combinations worth knowing:

- **Sharp, fast pings**: `SPEED = 350, LAMBDA = 70, DECAY = 100, LIFE = 1.0` — feels like raindrops.
- **Slow, slosh-y water**: `SPEED = 130, LAMBDA = 150, DECAY = 320, LIFE = 2.5` — feels like dropping a stone in a pond.

## Common mistakes

- **No debounce on movement.** Mousemove fires at 60+Hz; in a fast drag you'd spawn 100 ripples. Min gap + min distance both matter — gap alone lets a held cursor at one spot accumulate; distance alone lets a tiny circling motion stack up.
- **No FIFO cap.** A user clicking rapidly fills the array indefinitely. 12 active ripples is the practical limit before the field reads as static noise.
- **Forgetting the lifeFade.** Without it the ring is full-strength when it expires, producing a visible "snap" as the ripple disappears.
- **Multiplying instead of adding for multiple ripples.** Ripples are *additive* offsets. Multiplying them produces nonsense.
- **Coupling to the surface.** Keep the ripple field as a pure function of `(x, y, t)`. Apply it from the outside.
- **Not skipping outside-canvas events.** Mousemove fires on `window`, not just the canvas. Bounding-rect check is required.
- **Using the same amp for click and move.** The whole point is making click feel different. 2–3× is the right ratio.
