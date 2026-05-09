---
name: proximity-audio-mapping
description: Use when building spatial/proximity audio interactions in the Web Audio API — cursor-driven gain envelopes, depth-driven filter modulation, multi-zone soundscapes where each zone's loudness depends on distance to a target, ambient beds layered with one-shot pings, or React hooks that wrap a singleton AudioContext. Skip for generic playback, MIDI synths, or offline rendering.
---

# Proximity-Based Audio Modulation

A pattern for spatializing audio by cursor/object distance: each "zone" has its own source whose gain is driven by a proximity scalar (0..1), all zones share a global filter whose cutoff is driven by another scalar (e.g. depth), and one-shot triggers ride on top of the ambient bed.

For the layered-generative-scoring upgrade — multiple ambient beds, *per-entity* zone voices with deterministic harmonic signatures derived from each entity's id, plus an arpeggio rotator that picks notes from currently-in-range entities — use `layered-ambient-soundscape`. This skill is the simpler "fixed zones, one source per zone" case.

## Architecture

```
                                  proximityMap[zoneId] (0..1, per frame)
                                         │
                                         ▼
  Source_A ─► GainNode_A ─┐
  Source_B ─► GainNode_B ─┼─► BiquadFilter ─► (FX bus) ─► destination
  Source_C ─► GainNode_C ─┘        ▲
                                   │
                              depth (0..1)  →  freq = base + (1-depth)*range

  PingOsc ─► PingGain ─────────────┘    (one-shot, scheduled envelope)
```

One shared `AudioContext`. Each zone owns a long-lived source plus its own `GainNode`; the engine reads a `proximityMap` every frame and writes the gain values. A single `BiquadFilter` sits downstream so all zones get the same global tonal shaping. Pings are short-lived nodes created on demand and connected after the filter (or to the bus) so they ride above the bed.

## API patterns

### Proximity map (data contract)

The audio engine does not compute geometry. Upstream code (the canvas / cursor logic) produces:

```js
// proximityMap: { [zoneId]: number in 0..1 }
// 1 = cursor is at zone center, 0 = at or beyond zone radius
const prox = Math.max(0, 1 - dist / radius);
```

The engine just calls `engine.updateZones(proximityMap)` per frame and maps each entry to a `GainNode`.

### Smoothing zone gains: prefer `setTargetAtTime`

```js
gainNode.gain.setTargetAtTime(target, ctx.currentTime, 0.05);
```

Why not `linearRampToValueAtTime`?

- `linearRampToValueAtTime` schedules a fixed-duration ramp from the *previous scheduled value*. Calling it every frame with a moving target piles up overlapping ramps and causes audible stair-stepping or stalls when the schedule queue isn't cleared.
- `setValueAtTime` jumps — that's the zipper noise you're trying to avoid.
- `setTargetAtTime` is a one-pole exponential glide toward the target with time-constant `tau`. New calls just retarget; nothing piles up. Ideal for per-frame updates from a cursor.

Pick `tau` between `0.02` (snappy) and `0.15` (slushy) seconds. A non-linear shape (`Math.pow(prox, 1.5)`) before passing in softens the falloff so zones don't blast on entry.

### Global filter modulation

One `BiquadFilter` for the whole bed. Drive its frequency from a separate scalar:

```js
// depth: 0 = surface (bright), 1 = deep (muffled)
const freq = 80 + (1 - depth) * 2400;
filter.frequency.setTargetAtTime(freq, ctx.currentTime, 0.1);
```

Linear-in-Hz is fine for narrow ranges; for wide sweeps map exponentially: `freq = base * Math.pow(ratio, 1 - depth)`.

### One-shot ping

Short oscillator + gain envelope, created on demand, scheduled with `setValueAtTime` + `exponentialRampToValueAtTime`, then disconnected after release:

```js
function ping(ctx, dest, freq = 880, dur = 0.4) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(g).connect(dest);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.6, t + 0.01);   // attack
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur); // decay — NOT 0
  osc.start(t);
  osc.stop(t + dur + 0.05);
  osc.onended = () => { osc.disconnect(); g.disconnect(); };
}
```

`exponentialRampToValueAtTime` requires a strictly positive target (the ramp is `target * (target/start)^(t/dur)`). Using `0` throws or silently breaks. Use `0.001` or `0.0001`.

Add a per-zone cooldown (e.g. `Date.now() - lastPing[id] < 3000`) so rapid cursor jitter doesn't machine-gun the ping.

### AudioContext lifecycle

Browsers require a user gesture to unlock audio. Construct the engine lazily on first click/keypress:

```js
button.onclick = async () => { await engine.start(); };
```

Inside `start()`: `new AudioContext()`, then `await ctx.resume()` if state is `'suspended'`. The engine should be a singleton — wrap it in a React hook with `useRef` so the instance survives re-renders and StrictMode double-mounts:

```js
export function useAudioEngine() {
  const ref = useRef(null);
  const start = useCallback(async () => {
    if (!ref.current) ref.current = new AudioEngine();
    await ref.current.start();
  }, []);
  const updateZones = useCallback((m) => ref.current?.updateZones(m), []);
  const modulateFilter = useCallback((d) => ref.current?.modulateFilter(d), []);
  const triggerPing = useCallback((id) => ref.current?.triggerPing(id), []);
  return { start, updateZones, modulateFilter, triggerPing };
}
```

Never recreate the engine in `useEffect`. Never store it in `useState`. Use `useRef`.

## Minimal worked example

```js
// proximity-audio.js — distill of the pattern
export default class ProximityAudio {
  constructor() { this.ctx = null; this.zones = {}; this.filter = null; this.lastPing = {}; }

  async start() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 800;
    this.filter.Q.value = 0.7;
    this.filter.connect(this.ctx.destination);
  }

  addZone(id, freq) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    gain.gain.value = 0;                 // start silent
    osc.connect(gain).connect(this.filter);
    osc.start();
    this.zones[id] = { osc, gain };
  }

  // proximityMap: { [id]: 0..1 }
  updateZones(proximityMap) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [id, z] of Object.entries(this.zones)) {
      const p = proximityMap[id] ?? 0;
      const target = Math.pow(p, 1.5) * 0.4;          // soft curve, headroom
      z.gain.gain.setTargetAtTime(target, t, 0.05);   // smooth, no zipper
    }
  }

  modulateFilter(depth) {
    if (!this.filter) return;
    const freq = 120 + (1 - depth) * 3200;
    this.filter.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.1);
  }

  ping(id, freq = 880) {
    if (!this.ctx) return;
    const now = Date.now();
    if (this.lastPing[id] && now - this.lastPing[id] < 1000) return;
    this.lastPing[id] = now;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    osc.connect(g).connect(this.filter);
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.start(t); osc.stop(t + 0.45);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }
}
```

Usage:

```js
const audio = new ProximityAudio();
button.onclick = async () => {
  await audio.start();
  audio.addZone('a', 220);
  audio.addZone('b', 330);
};
// per frame:
audio.updateZones({ a: proxA, b: proxB });
audio.modulateFilter(depth);
// on hit:
audio.ping('a', 660);
```

## Checklist when implementing

- One `AudioContext`, started from a user gesture, owned by a singleton wrapped in `useRef`.
- Zone gains updated with `setTargetAtTime`, never `linearRampToValueAtTime` in a per-frame loop.
- Proximity is computed upstream; the engine consumes `{ [id]: 0..1 }`.
- Global filter is a single shared node; modulate `.frequency` with `setTargetAtTime`.
- Pings use `exponentialRampToValueAtTime` with a non-zero floor (`0.001`) and disconnect on `onended`.
- Apply a non-linear curve (`pow(p, 1.5)`) and a stacking attenuator if many zones can overlap, to keep the master from clipping.
- Lazy-create per-zone nodes when a zone first becomes audible; defer disposal until after the release tail.
