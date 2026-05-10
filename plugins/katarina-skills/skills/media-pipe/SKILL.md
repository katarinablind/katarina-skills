---
name: media-pipe
description: Use when building browser-based hand-gesture interactions with MediaPipe Hand Landmarker — gesture classification (palm/fist/pinch/point/peace/thumbs-up), and continuous controls driven by hand geometry (pinch-slide sliders, palm-openness zoom, fingertip cursors with amplified delta, hand-rotation as yaw, hand-tilt as pitch). Covers the exact CDN-import setup, the per-frame inference loop with frame-skip dedupe, geometric (no-ML) gesture classification using smoothstep on landmark distances normalized by hand size, anatomical-projection patterns that work without per-user calibration, the z-depth-is-unreliable gotcha, and camera-permission error handling. Skip for face/pose/holistic landmarkers (use the right MediaPipe task module), native (non-web) MediaPipe, custom gesture-recognition ML training, or AR-style 3D hand reconstruction — this is 2D landmark-rule classification.
---

## CDN setup (the only reliable import path)

```js
import { HandLandmarker, FilesetResolver }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs";

const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
);

const handLandmarker = await HandLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    delegate: "GPU",
  },
  runningMode: "VIDEO",
  numHands: 2,
});
```

- **WASM path must match the package version** of the import. Mismatch produces silent failures (the model loads but inference returns no landmarks).
- **`delegate: "GPU"`** — drops total latency from ~30ms to ~8ms on most laptops. Falls back to CPU automatically if GPU init fails.
- **`runningMode: "VIDEO"`** is required for `detectForVideo()`. `"IMAGE"` mode uses `detect()` and runs through CPU regardless.

## Camera + permission handling

```js
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      // User denied — don't keep retrying, show "allow camera and reload"
    } else if (err.name === 'NotFoundError') {
      // No webcam connected
    } else if (!navigator.mediaDevices?.getUserMedia) {
      // Page is not on localhost or HTTPS — getUserMedia is gated
    }
  }
}
```

The "API unavailable" case is the one people miss: `getUserMedia` requires a secure context. `file://` URLs don't work — serve the page over `python3 -m http.server` or HTTPS.

## The detection loop with frame-skip dedupe

```js
let lastVT = -1;

function detect() {
  // Skip frames where the video hasn't advanced — running inference on the
  // same frame twice burns the entire frame budget for nothing.
  if (video.currentTime === lastVT) {
    requestAnimationFrame(detect);
    return;
  }
  lastVT = video.currentTime;

  const t0 = performance.now();
  const res = handLandmarker.detectForVideo(video, performance.now());
  const t1 = performance.now();

  if (res.landmarks && res.landmarks.length > 0) {
    const lm = res.landmarks[0];   // 21 normalized landmarks (x,y,z in 0..1)
    const scores = classifyGestures(lm);
    drawHand(lm, scores);
    // ...interaction-mode updates...
  }

  const renderMs = performance.now() - t1;
  // record(t1 - t0 = processing ms, renderMs)
  requestAnimationFrame(detect);
}
```

The frame-skip is the single biggest perf win for video inference. Without it, on a 60Hz monitor with a 30Hz camera you do twice the work.

## 21 landmarks — the layout you'll memorize

```
Wrist:               0
Thumb:    1, 2, 3, 4 (tip = 4)
Index:    5, 6, 7, 8 (MCP=5, tip=8)
Middle:   9, 10, 11, 12
Ring:     13, 14, 15, 16
Pinky:    17, 18, 19, 20
```

Coordinates are normalized 0..1 across the camera frame. **z exists but is unreliable** (relative depth, noisy). Use x and y only unless you really know what you're doing.

## Hand-size normalization

Every distance gets divided by `handSize` so gestures work regardless of how close to the camera the hand is.

```js
const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
const handSize = (lm) => dist(lm[0], lm[9]) + 1e-6;  // wrist → middle-MCP
```

**Don't use bounding-box dimensions for scale.** They jitter as fingers extend. The wrist→middle-MCP segment is rigid (no joints between them) so it's stable.

## Geometric gesture classification (no ML)

The trick: each gesture is a *product* of fuzzy 0..1 conditions. Use `smoothstep` instead of hard thresholds so confidence is continuous — the bar UI feels alive instead of binary.

```js
const smoothstep = (lo, hi, x) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

// Finger extension: 0 = curled, 1 = straight out
function fingerExt(lm, tip, pip) {
  return smoothstep(0.85, 1.35, dist(lm[tip], lm[0]) / (dist(lm[pip], lm[0]) + 1e-6));
}

// Thumb is special — different anatomy
function thumbExt(lm) {
  return smoothstep(0.8, 1.6, dist(lm[4], lm[5]) / (dist(lm[3], lm[5]) + 1e-6));
}

// Spread of fingertips, normalized by hand size
function fingerSpread(lm) {
  const hs = handSize(lm);
  let t = 0;
  for (const [a, b] of [[8, 12], [12, 16], [16, 20]]) t += dist(lm[a], lm[b]) / hs;
  return smoothstep(0.15, 0.55, t / 3);
}

function classifyGestures(lm) {
  const e = {
    thumb:  thumbExt(lm),
    index:  fingerExt(lm, 8, 6),
    middle: fingerExt(lm, 12, 10),
    ring:   fingerExt(lm, 16, 14),
    pinky:  fingerExt(lm, 20, 18),
  };
  const c = Object.fromEntries(Object.entries(e).map(([k, v]) => [k, 1 - v]));

  const hs = handSize(lm);
  const pinchClose = smoothstep(0.45, 0.12, dist(lm[4], lm[8]) / hs);
  const notFist    = smoothstep(0.1, 0.4, Math.max(e.middle, e.ring, e.pinky));
  const idxProj    = smoothstep(0.3, 0.7, dist(lm[8], lm[5]) / hs);
  const thumbUp    = smoothstep(0, -0.12, lm[4].y - lm[2].y);

  return {
    palm:  Math.min(e.thumb, e.index, e.middle, e.ring, e.pinky) * fingerSpread(lm),
    fist:  Math.min(c.thumb, c.index, c.middle, c.ring, c.pinky),
    pinch: pinchClose * notFist,
    point: e.index * idxProj * Math.min(c.middle, c.ring, c.pinky),
    peace: Math.min(e.index, e.middle) * Math.min(c.ring, c.pinky),
    thumb: e.thumb * thumbUp * Math.min(c.index, c.middle, c.ring, c.pinky),
  };
}
```

`Math.min(...)` is fuzzy AND. Multiplication is fuzzy AND with stronger penalty (a 0.5 component drags the whole score down). Use `min` when components should be roughly equal-weighted, multiplication when you want one component to gate the others.

A "dominant gesture" is just `argmax` over the scores, with a confidence threshold (~0.3) below which you say "no gesture":

```js
function dominant(scores) {
  let best = null, bestScore = -1;
  for (const g of GESTURES) if (scores[g.id] > bestScore) { best = g; bestScore = scores[g.id]; }
  return { gesture: best, score: bestScore };
}
```

## Continuous-control patterns

These are the meaty ones. The pattern in all of them: **derive a single 0..1 value (or angle) from anatomy that doesn't require calibration**, then smooth it.

### Pinch-slide (anatomical projection)

Project the pinch midpoint onto the wrist→middle-MCP axis. The projection parameter `t` ranges from 0 (at wrist) to ~1 (at MCP) — anatomy itself defines the range.

```js
class PinchSlide {
  constructor() { this.smooth = 0.5; }
  update(lm) {
    const mid = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
    const ax = lm[9].x - lm[0].x, ay = lm[9].y - lm[0].y;     // hand axis
    const px = mid.x - lm[0].x,   py = mid.y - lm[0].y;       // pinch from wrist
    const dot = px * ax + py * ay;
    const lenSq = ax * ax + ay * ay;
    const t = lenSq > 0 ? dot / lenSq : 0;                    // projection param
    const v = Math.max(0, Math.min(1, (t - 0.3) / 0.8));      // anatomical [0.3, 1.1] → [0, 1]
    this.smooth += (v - this.smooth) * 0.3;                   // EMA, α=0.3
  }
}
```

The `[0.3, 1.1]` window is empirical — it's where pinch midpoints actually fall when you do this gesture. Tune by logging raw `t` and watching what range your hand produces.

### Palm zoom (openness → scale)

```js
class PalmZoom {
  constructor() { this.smooth = 1; }
  update(lm) {
    const exts = [
      fingerExt(lm, 8, 6), fingerExt(lm, 12, 10),
      fingerExt(lm, 16, 14), fingerExt(lm, 20, 18),
    ];
    const openness = exts.reduce((a, b) => a + b, 0) / 4;
    // closed (0) → 3×, open (1) → 0.5×
    const scale = Math.max(0.3, Math.min(4, 3 - openness * 2.5));
    this.smooth += (scale - this.smooth) * 0.25;
  }
}
```

### Cursor (amplified delta with drifting reference)

The trick: don't bind the cursor to the fingertip. Bind it to a *delta from a reference point*, amplified. Then drift the reference toward the current position so the cursor never pins to an edge.

```js
class Cursor {
  constructor() { this.sx = 0.5; this.sy = 0.5; this.refX = null; this.refY = null; this.gain = 3.5; }
  update(lm) {
    const fx = lm[8].x, fy = lm[8].y;
    if (this.refX === null) { this.refX = fx; this.refY = fy; }
    const cx = Math.max(0, Math.min(1, 0.5 + (fx - this.refX) * this.gain));
    const cy = Math.max(0, Math.min(1, 0.5 + (fy - this.refY) * this.gain));
    this.sx += (cx - this.sx) * 0.35;
    this.sy += (cy - this.sy) * 0.35;
    // Slowly drift reference toward current — prevents edge-pinning
    this.refX += (fx - this.refX) * 0.008;
    this.refY += (fy - this.refY) * 0.008;
  }
}
```

`gain = 3.5` is a good starting point. Higher gain = faster cursor but more jitter. Drift rate `0.008` is the slow leak that recenters.

### Rotate (yaw)

Angle from palm center to midpoint of thumb+index tips. Calibrate the reference angle on first detection so rotation is *relative*, not absolute.

```js
const angleDeg = (a, b) => Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;

class Rotate {
  constructor() { this.smoothAngle = 0; this.refAngle = null; }
  update(lm) {
    const center = { x: (lm[0].x + lm[9].x) / 2, y: (lm[0].y + lm[9].y) / 2 };
    const mid    = { x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
    const angle = angleDeg(center, mid);
    if (this.refAngle === null) this.refAngle = angle;
    let delta = angle - this.refAngle;
    while (delta > 180)  delta -= 360;
    while (delta < -180) delta += 360;
    this.smoothAngle += (delta - this.smoothAngle) * 0.3;
  }
}
```

Wrap-around handling (`while (delta > 180) delta -= 360`) is mandatory or the value snaps when you cross 180°.

### Tilt (pitch)

```js
class Tilt {
  constructor() { this.smooth = 0; this.refPitch = null; }
  update(lm) {
    const raw = angleDeg(lm[0], lm[9]);
    const pitch = raw + 90;                  // upright = 0
    if (this.refPitch === null) this.refPitch = pitch;
    let delta = pitch - this.refPitch;
    while (delta > 180)  delta -= 360;
    while (delta < -180) delta += 360;
    this.smooth += (delta - this.smooth) * 0.25;
  }
}
```

## The z-depth gotcha (worth memorizing)

> When a finger points straight at the camera, tip and MCP overlap in the x,y plane — the finger "disappears." Pointing must be lateral or vertical to be detected reliably.

This kills naive "point at the screen" interactions. Two ways out:

1. **Use sideways pointing** for cursor-like modes (the index fingertip's screen x,y).
2. **Use anatomical projections** instead of absolute landmark positions (PinchSlide above is the model — it stays meaningful even under partial occlusion).

`z` exists in the landmarks but is *relative within the hand* and noisy at the inter-frame level. Don't build interactions where `z` deltas matter unless you're prepared to do heavy filtering.

## Drawing the hand (debug overlay)

Use the canonical 23-edge connection set:

```js
const CONNS = [
  [0,1],[1,2],[2,3],[3,4],          // thumb
  [0,5],[5,6],[6,7],[7,8],          // index
  [0,9],[9,10],[10,11],[11,12],     // middle
  [0,13],[13,14],[14,15],[15,16],   // ring
  [0,17],[17,18],[18,19],[19,20],   // pinky
  [5,9],[9,13],[13,17],             // palm
];
```

Draw with `transform: scaleX(-1)` on the canvas (and the video) so the user sees a mirror of themselves — what feels right when you raise your right hand.

## Performance budget (rough)

| Stage | GPU delegate | CPU delegate |
|---|---|---|
| `detectForVideo` | 5–10ms | 20–35ms |
| Classify + smoothing | <0.5ms | <0.5ms |
| Canvas overlay draw | 1–3ms | 1–3ms |

At 60 FPS you have 16.7ms per frame. GPU keeps you comfortable; CPU has you skipping frames on busy scenes. Always frame-skip dedupe.

## Common mistakes

- **Forgetting `numHands`.** Defaults to 1. Two-hand interactions silently get the second hand dropped.
- **Reading `lm.x` as pixels.** They're 0..1. Multiply by `canvas.width` / `canvas.height`.
- **Hard thresholds for gestures.** `dist > 0.5 ? open : closed` produces flickering output. Use `smoothstep`.
- **No EMA on continuous controls.** Raw landmark coords have ~1–2px jitter per frame. Without smoothing, every slider trembles.
- **Calibrating per-user.** This codebase doesn't, and shouldn't — anatomical projection (`pinchSlide`) and reference-relative angles (`rotate`, `tilt`) make calibration unnecessary. If you're tempted to add a calibration step, you probably need a better feature.
- **Skipping the `lastVT` dedupe.** Burns 50% of your inference budget on duplicate frames.
- **Loading WASM and model from different versions.** They handshake silently — no landmarks come back, no error fires.
