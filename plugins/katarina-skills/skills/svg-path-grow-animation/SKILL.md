---
name: svg-path-grow-animation
description: Use when building SVG path-draw growth animations — the `stroke-dasharray` + `stroke-dashoffset` technique that 'draws' a path on screen by animating the dashoffset from total-length to zero. Covers single-stroke draws, vine/stem-along-curve growth, hover-triggered re-growth, staggered multi-path sequences, and the per-stroke timing variation that makes mechanical SVGs feel organic. Skip for canvas-based animation, GIF/Lottie playback, or non-path SVG morphs.
---

# SVG Path Grow Animation

The skill is the `stroke-dasharray` / `stroke-dashoffset` trick: an SVG `<path>` with a dash gap longer than itself is **invisible**. Animate the offset to zero and the path **draws itself** along its geometry. That single primitive scales from a one-line CSS transition to vine fields that re-grow on every hover. The rest of this skill is about (a) computing the right length, (b) per-path jitter so multiple paths don't look mechanical, (c) the two-frame reset trick that makes hover re-growth actually animate, (d) curve geometry that gives stems their organic shape, and (e) staggered sequencing so multi-part plants grow stem-then-leaf-then-flower.

Read in order: §1 is the foundation. §2 fixes the "robot rows of identical paths" problem. §3 is the hover-re-growth pattern (single most-asked-about). §4 is curve geometry for vines. §5 is staggered sequences. §6 is a worked example.

## 1. The core technique

A path's total length is what makes the trick work — set both `stroke-dasharray` and `stroke-dashoffset` to that length and the path is one fully-offset dash, invisible. Animating the offset to 0 reveals the dash from start to end, which reads as the path "drawing itself."

```css
.vine-stem {
  fill: none;
  stroke-linecap: round;
  stroke-dasharray:  1000;     /* longer than the path */
  stroke-dashoffset: 1000;     /* fully offset → invisible */
  transition: stroke-dashoffset 1.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.vine-stem.grow { stroke-dashoffset: 0; }
```

```js
// Compute the actual length per path — hardcoded 1000 works for short strokes
// but breaks for long curves. Use getTotalLength() at build time:
const len = pathEl.getTotalLength();
pathEl.style.strokeDasharray  = len;
pathEl.style.strokeDashoffset = len;
// then later:
pathEl.style.strokeDashoffset = 0;   // triggers the CSS transition
```

The bloom-timeline shortcut: hardcode `1000` in the CSS for both values. It works because (a) every path is shorter than 1000 in that viz, (b) the visible-once-drawn segment doesn't care about the dash gap as long as it exceeds the stroke length. For longer paths use `getTotalLength()`.

`fill: none` is mandatory — if the path is filled, the stroke draw is meaningless because the fill renders instantly. `stroke-linecap: round` gives the growing tip a soft point instead of a square.

## 2. Per-path timing variation

Animating ten paths with the same `transition: 1.2s` makes them grow in lockstep — visually robotic. The fix: jitter `transition-duration` and `transition-delay` per element. The jitter must be **deterministic per element** so the same vine grows the same way on every re-trigger (otherwise it feels glitchy, not random).

```js
function seededJitter(seed) {
  // tiny LCG — same input → same output
  let s = seed * 16807 + 7;
  return () => { s = (s * 16807 + 7) % 2147483647; return (s & 0xffff) / 0xffff; };
}

paths.forEach((p, i) => {
  const rand = seededJitter(i);                      // i is the deterministic seed
  const dur   = baseDur * (1 - jitter * 0.3 + rand() * jitter * 0.6);  // ±30%·jitter
  const delay = staggerMs * i + rand() * jitter * 200;
  p.style.transition = `stroke-dashoffset ${dur}ms ${easing} ${delay}ms`;
});
```

Two knobs — `jitter` (how much variation) and `stagger` (linear ramp between starts). `jitter=0` is fully synchronized, `jitter=1` is wide spread. Start at `0.3` for organic-feeling-but-coherent growth.

The bloom-timeline grass uses a richer per-blade pattern: each blade gets `delay = centerT * 0.6 + layerZ * 0.06 + Math.random() * 0.12` — so blades start at the *center* of the bar and spread outward (`centerT` is `|t - 0.5| * 2`), back layers start later than front (`layerZ * 0.06`), and a small random component breaks up the front. That's three jitter sources composed, each with a meaning. Pattern: pick jitter sources that **encode something** (position, layer, freshness) rather than scattering uniformly.

## 3. Hover-triggered re-growth

The trick: to re-trigger a CSS transition, the property must **change values across two separate frames**. Setting `dashoffset = len` and `dashoffset = 0` in the same frame is one composite mutation — the transition sees the final value and renders it immediately.

```js
// WRONG — looks instant, no animation
pathEl.style.strokeDashoffset = len;
pathEl.style.strokeDashoffset = 0;

// RIGHT — reset, then transition on the next frame
pathEl.style.transition = 'none';                      // disable transition
pathEl.style.strokeDashoffset = len;                   // snap to start
pathEl.getBoundingClientRect();                        // force layout flush
requestAnimationFrame(() => {
  pathEl.style.transition = '';                        // re-enable from CSS
  pathEl.style.strokeDashoffset = 0;                   // animate back
});
```

The `getBoundingClientRect()` read forces a synchronous layout, which commits the snap-back. Without it, browsers sometimes batch the offset change with the next-frame change. `requestAnimationFrame` then schedules the transition-triggering write for the next paint frame.

**The bloom-timeline alternative**: don't re-trigger — **rebuild**. `growGrassAlongLines(species)` is called fresh on every hover; it removes the previous `<g>` and creates a new one. The new elements are born with `transform: scaleY(0)` and `fill-opacity: 0`; one `requestAnimationFrame` later they get `scaleY(1)` and `fillOpacity: 0.5`, and the CSS transition handles the growth. This avoids the reset-flush dance entirely and lets each re-grow have fresh randomness.

```js
// Lifted pattern from bloom-timeline.html growGrassAlongLines
function growGrassAlongLines(species) {
  clearGrass();                            // remove previous <g>
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  // ... build paths with style.transform = "scaleY(0)" and transitions ...
  svg.appendChild(group);
  activeGrass.push(group);

  requestAnimationFrame(() => {
    group.querySelectorAll('.grass-blade').forEach(b => {
      b.style.fillOpacity = String(0.25 + Math.random() * 0.55);
      b.style.transform = 'scaleY(1)';
    });
  });
}
```

Pick rebuild for "every hover should feel fresh" (bloom-timeline) or pick reset-and-flush for "the same vine grows the same way each time" (deterministic UI, replay).

## 4. Vine / stem along a curve

A straight stroke draws a line. To get a **vine**, the underlying path must already be curvy — Catmull-Rom or Bezier. The growth animation just animates along whatever geometry the path describes.

```js
// d3 (used by bloom-timeline) — Catmull-Rom through control points
const lineGen = d3.line().curve(d3.curveCatmullRom.alpha(0.5));
const points = [
  [x0, y0],                                  // root
  [x0 + sway, y0 - h * 0.4],                 // mid (with horizontal jitter)
  [x0 + sway * 1.6, y0 - h * 0.75],
  [tipX, tipY],                              // tip
];
pathEl.setAttribute('d', lineGen(points));
```

Vanilla SVG cubic Bezier — no d3 needed:

```js
function vinePath(bx, by, h, sway) {
  const tipX = bx + sway;
  const tipY = by - h;
  // Two cubic Beziers: one up to mid, one mid-to-tip.
  return `M ${bx} ${by}
          C ${bx + sway*0.3} ${by - h*0.3},
            ${tipX - sway*0.5} ${by - h*0.6},
            ${tipX - sway*0.2} ${tipY + h*0.15}
          C ${tipX + 0.2} ${tipY + h*0.05},
            ${tipX} ${tipY + 0.5},
            ${tipX} ${tipY}`;
}
```

`alpha(0.5)` (centripetal Catmull-Rom) is the safe default — it never over-shoots between control points the way `alpha(0)` (uniform) does. Use `alpha(1)` (chordal) only when you want a deliberately tense, stretched look.

For the bloom-timeline blade-shape — a closed teardrop instead of an open line — the path goes up one side, around the tip, and back down. The stroke draw still works but you'll see two strokes converge; usually you want `fill` on shapes like this and stroke-draw on open-ended stems.

## 5. Multi-path staggered sequence

For "stem grows, then leaves, then flower," chain delays so each part starts when the previous reaches a threshold (typically 60–80% complete, not 100% — the eye accepts overlap).

```js
const stages = [
  { selector: '.stem',   dur: 1200, phase: 0     },
  { selector: '.leaf',   dur:  600, phase: 0.7   },   // start when stem is 70% done
  { selector: '.flower', dur:  500, phase: 1.4   },   // start after leaves finish
];

let cumulative = 0;
stages.forEach(stage => {
  const delay = cumulative;
  document.querySelectorAll(stage.selector).forEach((el, i) => {
    el.style.transition = `stroke-dashoffset ${stage.dur}ms ${easing} ${delay + i * 30}ms`;
    el.style.strokeDashoffset = '0';
  });
  cumulative = delay + stage.dur * stage.phase;       // next stage starts at phase·prev-dur
});
```

`phase` is the only interesting knob: `phase < 1` means stages overlap (looks alive), `phase >= 1` means strict sequence (feels mechanical, useful for tutorials/demos where each stage needs to be read separately).

The bloom-timeline grass does this implicitly with `delay = centerT * 0.6 + layerZ * 0.06`: the layer-Z component creates a back-to-front sequence (back blades start later), and the center-out radial timing creates a wave from the bar center.

## 6. Worked example

Five vines that grow on click. Each vine is a Catmull-Rom curve through a randomly-jittered control polyline; per-vine duration and delay come from a deterministic seed. Re-click triggers a rebuild for fresh randomness — bloom-timeline pattern.

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>SVG path grow</title>
<style>
  body { margin:0; background:#0d1410; height:100vh; display:grid; place-items:center; font-family: monospace; color:#7ea878; }
  svg { display:block; }
  .vine {
    fill: none;
    stroke: #5a8a50;
    stroke-width: 2;
    stroke-linecap: round;
  }
  button { position:fixed; top:16px; left:16px;
    background:#1e3320; color:#9ec59a; border:1px solid #2d5a27;
    padding:8px 14px; font:inherit; cursor:pointer; }
</style></head><body>
<button id="go">re-grow</button>
<svg id="stage" width="800" height="500" viewBox="0 0 800 500"></svg>
<script>
const svg = document.getElementById('stage');
const NUM_VINES = 5, BASE_DUR = 1400, JITTER = 0.4;

// Deterministic LCG so seed N always produces the same vine
function seededRand(seed) {
  let s = seed * 16807 + 7;
  return () => { s = (s * 16807 + 7) % 2147483647; return (s & 0xffff) / 0xffff; };
}

// Vanilla cubic-Bezier vine builder — no d3 needed
function vinePath(bx, by, h, swayDir, rand) {
  const segs = 4;
  let d = `M ${bx} ${by}`;
  let x = bx, y = by;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const sway = swayDir * (10 + rand() * 25) * Math.sin(t * 3.0);
    const nx = bx + sway;
    const ny = by - h * t;
    const cp1x = x + (nx - x) * 0.3 + (rand() - 0.5) * 14;
    const cp1y = y + (ny - y) * 0.4;
    const cp2x = x + (nx - x) * 0.7 + (rand() - 0.5) * 14;
    const cp2y = y + (ny - y) * 0.7;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${nx} ${ny}`;
    x = nx; y = ny;
  }
  return { d, tipX: x, tipY: y };
}

function grow() {
  // Rebuild — fresh DOM, transitions apply on the next animation frame
  svg.innerHTML = '';
  for (let i = 0; i < NUM_VINES; i++) {
    const rand = seededRand(i + 1);
    const bx = 100 + i * (600 / (NUM_VINES - 1));
    const by = 460;
    const h  = 280 + rand() * 120;
    const swayDir = i % 2 === 0 ? 1 : -1;

    const { d, tipX, tipY } = vinePath(bx, by, h, swayDir, rand);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'vine');
    svg.appendChild(path);

    const len = path.getTotalLength();
    path.style.strokeDasharray  = len;
    path.style.strokeDashoffset = len;

    const dur   = BASE_DUR * (1 - JITTER * 0.3 + rand() * JITTER * 0.6);
    const delay = i * 80 + rand() * JITTER * 240;
    path.style.transition =
      `stroke-dashoffset ${dur}ms cubic-bezier(0.16,1,0.3,1) ${delay}ms`;

    // Leaf glyph at the tip — appears after the stroke draws
    const leaf = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    leaf.setAttribute('cx', tipX); leaf.setAttribute('cy', tipY);
    leaf.setAttribute('r', 5);
    leaf.setAttribute('fill', '#7ea878');
    leaf.style.opacity = '0';
    leaf.style.transition = `opacity 400ms ease ${delay + dur * 0.85}ms`;
    svg.appendChild(leaf);

    // Two-frame: appended with offset=len, next frame transitions to 0
    requestAnimationFrame(() => {
      path.style.strokeDashoffset = '0';
      leaf.style.opacity = '1';
    });
  }
}

document.getElementById('go').addEventListener('click', grow);
grow();
</script></body></html>
```

## Pitfalls

- **`fill: none` is mandatory.** A filled path renders the fill instantly; the stroke draw becomes invisible against it.
- **Hardcoded dasharray (e.g. `1000`) only works if every path is shorter.** For variable-length paths, set `strokeDasharray` and `strokeDashoffset` from `pathEl.getTotalLength()` at build time.
- **Re-trigger needs two frames.** Setting `dashoffset = len` then `dashoffset = 0` in the same tick collapses to one mutation; the browser shows the final state. Either disable transition + `getBoundingClientRect()` flush + `requestAnimationFrame`, or rebuild the element.
- **Element must be in the DOM before reading `getTotalLength()`.** Detached paths return 0 in some browsers. `appendChild` first, measure second.
- **Uniform timing across many paths reads as robotic.** Add per-path `transition-delay` jitter from a deterministic seed — uniform random *per re-trigger* feels glitchy; deterministic-per-element-id feels intentional.
- **Catmull-Rom needs `alpha(0.5)` (centripetal).** `alpha(0)` (uniform) overshoots between close control points and produces self-intersecting vines. `alpha(1)` (chordal) over-tightens.
- **Stagger phase < 1 is correct for organic.** The eye reads slight overlap as natural growth. Strict sequential (phase ≥ 1) feels like a UI tutorial, not a plant.
- **Don't put dashoffset transitions on `transform: scale(0→1)` elements simultaneously without thinking.** They'll race; the path is invisible (offset = len) but the scale transform still expands its empty bounding box, which can look like a glitch on hover. Either pick one or sequence them with delay.
