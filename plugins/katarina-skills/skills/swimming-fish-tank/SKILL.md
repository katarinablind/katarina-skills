---
name: swimming-fish-tank
description: Use when building autonomous-swimming animated entities for an aquarium / pond / tank scene — fish (or other animals) following long horizontal trajectories with vertical bob, staggered start delays so they don't cross in sync, sprite/SVG flipping on direction reversal, and per-fish stable variation derived from a stable id (so the same fish always feels like itself). Includes the per-fish state, the per-frame update loop, and a vanilla-JS port of the Motion-driven loop pattern. Skip for fish that swim freely with steering AI / boids (this pattern is one-axis ferry traffic with bob), for koi-pond top-down patterns, or for static aquarium illustrations.
---

# Swimming Fish · Autonomous Tank

The pattern lifted from `telefishin/components/tank/Fish.tsx` and `DemoTank.tsx`. Every fish is an independent ferry: it crosses the tank on the X axis with a long looping period, gently bobs on the Y axis with a shorter period, and re-enters from the off-screen side when it loops. Per-fish properties (Y row, X-period, bob phase, start delay) are *deterministic* from the fish's stable id, so a given fish always behaves the same way — even after a refresh.

There is no boids logic, no path-finding, no collision. Fish look like they are swimming in a tank because there are several of them, with desynced periods, all bobbing at slightly different phases. The illusion is in the staggering, not in any per-fish AI.

## The per-fish state

For each fish you store, once at spawn:

```js
{
  id: 'm-2a3f',         // stable string — used as RNG seed
  spriteSrc: '...png',  // image url (or SVG element)
  y: 180,               // top position (px) — chosen to evenly stagger rows
  duration: 22,         // seconds for one left-to-right traversal
  delay: 5,             // seconds before this fish starts (first loop only)
  bobPhase: 1.7,        // seconds offset into the bob cycle
  bobAmplitude: 20,     // px — peak vertical displacement
  speedJitter: 0.0,     // optional: per-fish multiplier on duration
}
```

The "id-derived" properties (`duration`, `bobPhase`, `delay`) come from a tiny seeded RNG. Fish.tsx uses charCodeAt + length:

```js
// telefishin/components/tank/Fish.tsx lines ~40-53
duration = 18 + ((id.charCodeAt(0) + id.length) % 9);   // 18–26 s
bobPhase = (id.charCodeAt(0) + index * 1.3) % bobDuration;
delay    = index * 5;
```

Two reasons this matters: stability across reloads, and visual desync (no two fish in identical phase).

## The path / trajectory

There is no bezier curve. The path is:

- **X**: linear `[startX, endX]` over `duration` seconds, looping.
  - `startX = -fishSize - 50` (off-screen left)
  - `endX   = tankWidth + 50` (off-screen right)
- **Y**: a row position `y` (constant) plus a sinusoidal bob `[0, -20, 0]` over `bobDuration ≈ 4` seconds.

Rows are evenly distributed across the tank's usable height with padding:

```js
// telefishin/components/tank/Fish.tsx lines ~31-37
const padding = 80;
const usable  = tankHeight - fishSize - padding * 2;
const step    = members.length <= 1 ? 0 : usable / members.length;
const y       = padding + step * index;
```

That's it. No control points, no arclength reparam. The "path" is two independent oscillators. The wandery feel is purely from row stagger × period stagger × phase stagger.

## Direction changes / turning

The fish in this pattern do *not* turn. They swim left-to-right only, then re-enter from the left. From `Fish.tsx`:

> // Swim left to right only

When the X-tween repeats (Motion's `repeatType: "loop"`), the fish snaps back to `startX` and crosses again. There's no flip animation because the sprite always faces the same direction.

If you want a turn-around variant: switch the X tween to `repeatType: "mirror"` (or in vanilla, ping-pong the t value), and apply `transform: scaleX(-1)` when the direction reverses. The rest of the state stays the same.

## Sprite flipping

Not used in the canonical Fish.tsx (one-way swim). For a mirror/reverse variant, write the velocity sign and apply CSS:

```js
fish.facingLeft = velocityX < 0;
fishEl.style.transform = `translate(${x}px, ${y}px) scaleX(${fish.facingLeft ? -1 : 1})`;
```

Use `transform-origin: center` so the flip pivots about the sprite's middle.

## Depth layering

Fish.tsx does **not** scale by depth — every fish is the same size (`FISH_SIZE = 120`). Depth is "expressed" via the row position alone (lower rows feel like foreground, top rows like distant). Each fish has a glow layer (radial gradient, day = warm yellow, night = cool purple) sized at 2× the sprite, blurred 8px.

If you want true parallax, scale by Y-row and z-index by the same key:

```js
const depthT = (fish.y - paddingTop) / usableHeight; // 0=top, 1=bottom
const scale  = 0.6 + depthT * 0.6;                    // 0.6 → 1.2
fishEl.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
fishEl.style.zIndex    = String(Math.floor(depthT * 100));
```

The studio file uses this depth-scale variant because tanks usually look better with parallax.

## Idle vs. active

There is no idle/active split. Fish are always in motion at the same speed (their personal speed). The "calm" of the tank comes from long durations (~20 s per crossing) and from the slow, easeInOut bob.

## Performance

The React/Motion version is cheap — Motion uses GPU transforms (`translate3d`) under the hood, and a tank with 5–10 fish stays at 60 FPS easily. In a vanilla port (the pattern below) we drive transforms manually each frame; ~30 fish is the sane upper bound. Above that, the per-frame DOM writes start to dominate.

Cheap optimizations:
- Use `transform`, never `top`/`left`. (Composite-only, no layout.)
- Use `will-change: transform` on the fish element.
- Render the glow as a CSS radial-gradient on a sibling div, not as an image. (Source does this.)

## Worked example

Vanilla JS, no React, no Motion. Drives the same two-oscillator-per-fish pattern. ~120 lines.

```html
<!doctype html>
<style>
  body { margin: 0; background: #0a1320; font-family: system-ui; }
  .tank {
    position: relative; width: 100vw; height: 100vh; overflow: hidden;
    background: linear-gradient(180deg, #19476b 0%, #0d2a45 100%);
  }
  .fish {
    position: absolute; left: 0; top: 0;
    width: 80px; height: 80px;
    will-change: transform;
    pointer-events: none;
  }
  .fish .glow {
    position: absolute; inset: -40px; border-radius: 50%;
    background: radial-gradient(circle, rgba(255,200,80,0.5) 0%, rgba(255,140,0,0.2) 50%, transparent 80%);
    filter: blur(6px);
  }
  .fish svg { position: relative; width: 100%; height: 100%; }
</style>
<div class="tank" id="tank"></div>
<script>
const TANK_W = innerWidth, TANK_H = innerHeight;
const FISH_SIZE = 80;
const COUNT = 8;

// Stable RNG: fish-id → derived numbers (port of Fish.tsx charCodeAt trick)
function fishParams(id, index, count) {
  const c = id.charCodeAt(0);
  const padding = 60;
  const usable  = TANK_H - FISH_SIZE - padding * 2;
  const step    = count <= 1 ? 0 : usable / count;
  return {
    y:        padding + step * index,
    duration: 18 + ((c + id.length) % 9),    // 18–26 s
    delay:    index * 1.8,                    // start stagger
    bobPhase: (c + index * 1.3) % 4,
    bobAmp:   18,
    bobDur:   4,
  };
}

function makeFish(id, index) {
  const p = fishParams(id, index, COUNT);
  const el = document.createElement('div');
  el.className = 'fish';
  el.innerHTML = `
    <div class="glow"></div>
    <svg viewBox="0 0 80 80">
      <ellipse cx="40" cy="40" rx="26" ry="14" fill="#e7a14f"/>
      <polygon points="14,40 0,28 0,52" fill="#c8852a"/>
      <circle cx="54" cy="36" r="3" fill="#fff"/>
      <circle cx="55" cy="36" r="1.5" fill="#000"/>
    </svg>`;
  document.getElementById('tank').appendChild(el);
  return { id, el, ...p };
}

const fish = [];
for (let i = 0; i < COUNT; i++) fish.push(makeFish('f-' + i + '-abc', i));

const startX = -FISH_SIZE - 50;
const endX   = TANK_W + 50;
const t0 = performance.now() / 1000;

function frame() {
  const t = performance.now() / 1000 - t0;
  for (const f of fish) {
    // X: linear loop over `duration`, with start delay
    const tx = ((t - f.delay) % f.duration + f.duration) % f.duration;
    const px = tx / f.duration;
    const x  = startX + (endX - startX) * px;
    // Y: row + bob (easeInOut sine over bobDur)
    const tb  = ((t + f.bobPhase) / f.bobDur) * Math.PI * 2;
    const bob = -Math.sin(tb) * f.bobAmp;
    f.el.style.transform = `translate(${x}px, ${f.y + bob}px)`;
  }
  requestAnimationFrame(frame);
}
frame();
</script>
```

This is the canonical motion. Drop in any sprite via the `<img>` of your choice, or replace the SVG. To get a tank that feels lived-in, set per-fish `delay` so they're not all entering at once (DemoTank does this with hand-tuned `startX` offsets — same idea).
