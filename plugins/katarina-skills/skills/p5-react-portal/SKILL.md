---
name: p5-react-portal
description: Use when embedding a p5.js sketch inside a React component, especially when the sketch needs to be canvas-parented to a specific div, cleaned up on unmount, or co-exist with React state without re-mounting on every render. Covers the dynamic-import pattern, useRef-based reactive prop bridging, and the sketch-driven exit/handoff. Do not fire on generic React work, generic canvas/WebGL work, or non-p5 animation libraries.
---

# Embedding p5.js in React

## Why this is non-obvious

p5 and React both want to own the DOM and the frame loop. Four collision points:

1. **Where the canvas mounts** — by default p5 attaches `<canvas>` to `document.body`, escaping React's tree. Fix: `cnv.parent(containerRef.current)`.
2. **When p5 starts** — p5 must instantiate after the container div exists. Fix: `useEffect`, not render-time.
3. **Cleanup on unmount** — p5 keeps a `requestAnimationFrame` loop running forever unless told otherwise. Fix: `return () => p5instance?.remove()` in the effect.
4. **Reactive props** — naively listing props in the effect's dep array tears down and rebuilds the sketch on every change, resetting `frameCount`, accumulators, and any internal state. Fix: bridge via a ref the sketch reads each frame.

Also: p5 touches `window` at import time. Static imports can break SSR and bloat the initial bundle. Use `import('p5').then(...)` to code-split.

## Skeleton

```jsx
import { useEffect, useRef } from 'react';

export default function P5Portal({ value, onDone }) {
  const containerRef = useRef(null);
  const valueRef = useRef(value);
  valueRef.current = value; // keep ref in sync each render

  useEffect(() => {
    let p5instance;
    import('p5').then(({ default: P5 }) => {
      const sketch = (p) => {
        p.setup = () => {
          const cnv = p.createCanvas(
            containerRef.current.offsetWidth,
            containerRef.current.offsetHeight
          );
          cnv.parent(containerRef.current); // attach inside React tree
        };
        p.draw = () => {
          // read reactive value via ref — never closes over stale prop
          const v = valueRef.current;
          // ...
          if (/* done */ false) {
            p5instance?.remove();
            onDone?.();
          }
        };
      };
      p5instance = new P5(sketch);
    });
    return () => p5instance?.remove(); // stops draw loop, removes canvas
  }, []); // empty deps: instantiate once

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    />
  );
}
```

Annotations:

- `useRef(null)` for the container; the div is the sketch's parent.
- `useEffect` with empty deps so p5 instantiates exactly once for the component's lifetime.
- Dynamic `import('p5')` so p5 is code-split. p5's global-ish scope can break SSR and adds ~800KB to the initial bundle if static-imported.
- `cnv.parent(containerRef.current)` is what keeps the canvas inside React's tree. Without it, p5 appends to `<body>` and you get a floating canvas.
- Cleanup `p5instance?.remove()` cancels the rAF loop and detaches the canvas. The optional chain handles the race where the component unmounts before the dynamic import resolves.

## Passing reactive values without remount

p5 sketches usually have internal state you do not want to reset (frameCount, particle positions, easing accumulators). So **don't** put props in the effect's dep array.

Instead, mirror props into refs and have the sketch read the ref each frame:

```jsx
const expandingRef = useRef(false);

// In the parent or an event handler:
const handleClick = () => { expandingRef.current = true; };

// Inside the sketch's p.draw:
if (expandingRef.current && expandT < 1) {
  expandT = Math.min(1, expandT + 0.03);
}
```

If the prop should drive the ref, sync it at the top of the component body:

```jsx
const valueRef = useRef(value);
valueRef.current = value;
```

This keeps p5's frame loop intact while still reacting to React state changes.

## Sizing

Read dimensions in `setup`:

```js
const cnv = p.createCanvas(
  containerRef.current.offsetWidth,
  containerRef.current.offsetHeight
);
```

Gotcha: the container must have a real size **before** p5 mounts. The parent needs `position: relative` (or absolute), an explicit or flex-derived width, and an explicit or flex-derived height. A bare `<div>` with no styling will measure 0×0 and you'll get an invisible canvas.

Common pattern: outer relative wrapper, absolute-positioned canvas container filling it.

```jsx
<div style={{ position: 'relative', width: '100%', height: '100%' }}>
  <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
  {/* React-rendered overlays go here, above the canvas */}
</div>
```

For resize support, listen to `window` resize and call `p.resizeCanvas(...)` from inside the sketch (close over `p`), or store the instance on a ref and call from a React effect.

## Sketch-driven handoff

When the sketch decides it is finished (animation complete, threshold reached, user-triggered exit), call a callback prop and remove itself in the same tick. The parent then unmounts or transitions:

```js
if (expandT >= 1) {
  p5instance?.remove();
  onEnter();
}
```

Two notes:

- Calling `remove()` before the callback prevents one extra frame from drawing after the React tree has moved on.
- Put `onEnter` (or whatever callback) in the effect's dep array only if you genuinely want a stable callback — otherwise wrap the parent's callback in `useCallback` so the effect does not re-run and rebuild the sketch.

## Minimal worked example

```jsx
import { useEffect, useRef } from 'react';

export default function PulseCanvas({ pulsing, onPeak }) {
  const containerRef = useRef(null);
  const pulsingRef = useRef(pulsing);
  pulsingRef.current = pulsing;

  useEffect(() => {
    let p5instance;
    import('p5').then(({ default: P5 }) => {
      const sketch = (p) => {
        let t = 0;
        p.setup = () => {
          const cnv = p.createCanvas(
            containerRef.current.offsetWidth,
            containerRef.current.offsetHeight
          );
          cnv.parent(containerRef.current);
        };
        p.draw = () => {
          t += pulsingRef.current ? 0.05 : 0.01;
          p.background(0, 20);
          p.noStroke();
          p.fill(0, 200, 255, 180);
          const r = 40 + Math.sin(t) * 30;
          p.circle(p.width / 2, p.height / 2, r * 2);
          if (r > 65) {
            p5instance?.remove();
            onPeak?.();
          }
        };
      };
      p5instance = new P5(sketch);
    });
    return () => p5instance?.remove();
  }, [onPeak]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    />
  );
}
```

That is the complete pattern: dynamic import, parented canvas, ref-bridged prop, sketch-driven exit, cleanup on unmount.
