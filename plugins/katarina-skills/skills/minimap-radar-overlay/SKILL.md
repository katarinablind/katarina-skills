---
name: minimap-radar-overlay
description: Use when building a 2D canvas minimap or radar HUD overlay for a 3D scene — fixed-position frosted-glass container, world-to-minimap coordinate transform (follow-camera vs absolute modes), player chevron with heading rotation, view-frustum cone, POI markers, and the activation/fade-in pattern. The terrain layer is pluggable; for the filled-bands terrain rendering see `filled-band-topology`, for outline contours see `marching-squares-topology`. Skip in-world UI, full-screen maps, or 3D-rendered HUD elements.
---

## What this is

This skill is the **HUD frame**, not the picture inside it. It covers everything that makes a corner-of-the-screen minimap feel like a minimap: a fixed-position frosted-glass container, the world-to-minimap coordinate transform, a player chevron that rotates with heading, a view-frustum cone, POI markers, and the fade-in activation pattern. The terrain layer is pluggable — you can leave it blank, fill it with a flat tint, or drop in a real renderer.

For terrain rendering itself see the sibling skills:

- **`filled-band-topology`** — top-down quantized colour bands sampled from a height function. The most common minimap terrain look.
- **`marching-squares-topology`** — outline contour lines from an iso-field. Use when you want a topographic / sonar feel instead of solid fill.

This skill stops at the edge of the canvas. What gets drawn into the terrain layer is somebody else's problem.

## 1. Container chrome

A `position: fixed` div with a canvas inside. `pointer-events: none` so clicks pass straight through to the 3D viewport — the minimap is "stamped on", not a UI panel that competes for input. If you need clickable POIs, scope pointer events to the hot children only.

```html
<div id="minimap"><canvas id="minimap-canvas" width="240" height="240"></canvas></div>
```

```css
#minimap{
  position:fixed; bottom:16px; left:16px; z-index:50;
  pointer-events:none;
  opacity:0; transition:opacity .6s;
  border:1px solid rgba(80,70,55,.45);
  border-radius:6px; overflow:hidden;
  box-shadow:0 4px 18px rgba(20,15,10,.28);
  background:rgba(245,238,222,.38);
  -webkit-backdrop-filter:blur(10px) saturate(1.15);
  backdrop-filter:blur(10px) saturate(1.15);
}
#minimap.visible{opacity:1}
#minimap canvas{display:block}
```

Why these choices:

- `pointer-events:none` keeps the 3D viewport in charge of input. Scope to `#minimap .hot{pointer-events:auto}` for interactive markers.
- `backdrop-filter:blur` is the frosted-glass look — terrain colours behind the corner show through softly. Cheap on modern GPUs; fall back to a flat tint on browsers without it.
- `overflow:hidden` + `border-radius` clips canvas corners cleanly so you don't have to round the canvas itself.
- `opacity:0` plus a `.visible` class drives the activation transition (section 6).

For DPR-crisp drawing, scale the backing store but keep logical coords:

```js
const dpr = Math.max(1, Math.min(3, devicePixelRatio || 1));
mm.width = MM_W * dpr;  mm.height = MM_H * dpr;
mm.style.width = MM_W + 'px';  mm.style.height = MM_H + 'px';
ctx.scale(dpr, dpr);
```

## 2. World-to-minimap transform

This is the meat of the skill. Both modes share the same per-frame loop; only the offset differs. Pick one upfront — they don't mix.

Inputs:

- player world position `(px, pz)`, heading
- entity world position `(x, z)`
- minimap radius `R` in pixels (canvas is `2R × 2R`, centre `(cx, cz) = (R, R)`)
- `W` = window half-extent in world units (zoom — bigger `W` = zoomed-out)

```js
// Follow mode — player always at minimap centre, world translates under them.
function worldToMM_follow(x, z, px, pz, W, R){
  const cx = R, cz = R;
  const mx = cx + (x - px) / W * R;
  const mz = cz + (z - pz) / W * R;
  return [mx, mz];
}

// Absolute mode — world origin pinned to minimap centre, player drifts.
function worldToMM_abs(x, z, W, R){
  const cx = R, cz = R;
  const mx = cx + x / W * R;
  const mz = cz + z / W * R;
  return [mx, mz];
}
```

Side-by-side:

| | follow | absolute |
|---|---|---|
| centre of map | player | world origin |
| player position on map | always `(R, R)` | `(R + px/W*R, R + pz/W*R)` |
| world translates each frame | yes | no |
| good for | free-roam, driving, flight | small fixed levels, tactical maps |

For a heading-up minimap (player triangle pinned upward, world rotates), apply a `ctx.rotate(-heading)` after translating to the player. Most exploration / tactical UIs use **north-up**; driving and flight HUDs use **heading-up**.

## 3. Player chevron

A triangle pointing forward, rotated by `heading`. The chevron (concave-back triangle) reads as direction better than an isoceles. The drop shadow lifts it above whatever the terrain layer drew.

```js
function drawPlayer(ctx, cx, cz, heading){
  ctx.save();
  ctx.translate(cx, cz);
  ctx.rotate(-heading);                        // negation: see note below
  ctx.shadowColor = 'rgba(0,0,0,.4)';
  ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
  ctx.fillStyle = 'rgba(225,105,30,.96)';
  ctx.beginPath();
  ctx.moveTo(0, -7); ctx.lineTo(5, 5);
  ctx.lineTo(0, 2.2); ctx.lineTo(-5, 5);
  ctx.closePath(); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.1;
  ctx.strokeStyle = 'rgba(255,248,235,.92)';
  ctx.stroke();
  ctx.restore();
}
```

The `rotate(-heading)` negation handles the convention mismatch: in 3D space, heading 0 typically means "looking down −Z" with Y up, but the 2D canvas has Y growing downward. Negating flips the rotation sense so heading 0 points up on the minimap and increasing heading rotates clockwise as the player turns right.

## 4. View-frustum cone

A translucent wedge extending forward from the player; angle equals the camera's horizontal FOV. Drawn as a triangle (or pie slice for a soft far edge), low alpha, sits between the terrain layer and the player chevron.

```js
function drawFrustum(ctx, cx, cz, heading, fovRad, rangePx){
  ctx.save();
  ctx.translate(cx, cz);
  ctx.rotate(-heading);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, rangePx, -Math.PI/2 - fovRad/2, -Math.PI/2 + fovRad/2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,240,200,.18)';
  ctx.fill();
  ctx.restore();
}
```

Low alpha (around 0.18) keeps the terrain readable through the cone. Range in pixels — pick something like 60–80% of `R` so the cone never covers the full radar.

## 5. POI markers

POIs are pluggable. Each has a world position and (optionally) an icon, colour, and label. Run the same world-to-minimap transform per frame; cull anything that falls outside the minimap circle.

```js
function drawPOIs(ctx, pois, px, pz, W, R, mode){
  for (const p of pois){
    const [mx, mz] = mode === 'follow'
      ? worldToMM_follow(p.x, p.z, px, pz, W, R)
      : worldToMM_abs(p.x, p.z, W, R);
    const dx = mx - R, dz = mz - R;
    if (dx*dx + dz*dz > R*R) continue;          // outside circle, cull
    ctx.fillStyle = p.color || 'rgba(40,30,20,.85)';
    ctx.beginPath(); ctx.arc(mx, mz, p.r || 2.5, 0, Math.PI*2); ctx.fill();
  }
}
```

For "off-screen" hint arrows, clamp to the rim and draw a tick instead of culling.

## 6. Activation pattern

The container starts at `opacity: 0`. Add `.visible` when a narrative or gameplay condition triggers the minimap to appear; remove it to fade out. CSS handles the transition.

```js
// Always-on case (most games):
document.getElementById('minimap').classList.add('visible');

// Narrative-beat case — the minimap appearing is itself a story moment:
function onPlayerCrestsHill(){
  document.getElementById('minimap').classList.add('visible');
}
```

Useful for storytelling-driven UIs where HUD chrome arrives gradually as the player gains capabilities. The same CSS structure costs nothing if you just toggle once on game start.

## 7. Drawing order

Strict z-order inside the canvas:

1. **Terrain layer** (pluggable — `filled-band-topology`, `marching-squares-topology`, or blank)
2. **Frustum cone**
3. **POI markers**
4. **Player chevron** — always last so nothing covers the user's avatar

Clear (or trail-fade) the canvas at step 0, then walk the list. The chevron-on-top rule is non-negotiable: if a POI sits underneath the player, the player wins.

## 8. Worked example

A self-contained HTML file: a fake world (just an empty stage), the minimap container with full chrome, both transform modes wired to a toggle, a chevron, a frustum, and POIs. Terrain is intentionally a flat tint — the point of this file is the HUD layer, not the terrain.

```html
<!doctype html>
<meta charset="utf-8">
<title>Minimap HUD demo</title>
<style>
  body{margin:0;background:radial-gradient(circle,#2a2e36,#0e1014);
       color:#ddd;font:13px monospace;height:100vh}
  #hint{position:fixed;top:16px;left:16px;opacity:.7;z-index:100}
  #minimap{
    position:fixed; bottom:16px; left:16px; z-index:50;
    pointer-events:none; opacity:0; transition:opacity .6s;
    border:1px solid rgba(80,70,55,.6); border-radius:8px; overflow:hidden;
    box-shadow:0 4px 18px rgba(0,0,0,.4);
    background:rgba(40,42,48,.55);
    backdrop-filter:blur(10px) saturate(1.15);
  }
  #minimap.visible{opacity:1}
  #minimap canvas{display:block}
</style>
<div id="hint">WASD/arrows to move &middot; Q/E to turn &middot; M to toggle minimap &middot; T to toggle FOLLOW/ABSOLUTE</div>
<div id="minimap"><canvas id="mm" width="240" height="240"></canvas></div>
<script>
const MM = 240, R = 120, W = 25;     // R = half-canvas px; W = world half-extent
const mm = document.getElementById('mm'), ctx = mm.getContext('2d');
const dpr = Math.max(1, Math.min(3, devicePixelRatio||1));
mm.width = MM*dpr; mm.height = MM*dpr;
mm.style.width = MM+'px'; mm.style.height = MM+'px';
ctx.scale(dpr, dpr);

const player = {x: 0, z: 0, heading: 0};
const POIS = [
  {x: 8, z: 4, color:'#f59e0b'}, {x:-12, z: 9, color:'#3b82f6'},
  {x: 2, z:-15, color:'#10b981'}, {x:18, z:-6, color:'#ef4444'},
  {x:-5, z:-9, color:'#8b5cf6'}, {x:11, z:14, color:'#06b6d4'}
];
let mode = 'follow';                     // 'follow' | 'absolute'
const keys = {};
addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'm') document.getElementById('minimap').classList.toggle('visible');
  if (e.key === 't') mode = mode === 'follow' ? 'absolute' : 'follow';
});
addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
document.getElementById('minimap').classList.add('visible');

function worldToMM(x, z){
  if (mode === 'follow') return [R + (x - player.x)/W * R,
                                  R + (z - player.z)/W * R];
  return [R + x/W * R, R + z/W * R];
}

function step(){
  const sp = 0.15, rs = 0.04;
  if (keys.q) player.heading -= rs;
  if (keys.e) player.heading += rs;
  const fwdX = Math.sin(player.heading), fwdZ = -Math.cos(player.heading);
  if (keys.w || keys.arrowup)    { player.x += fwdX*sp; player.z += fwdZ*sp; }
  if (keys.s || keys.arrowdown)  { player.x -= fwdX*sp; player.z -= fwdZ*sp; }
  if (keys.a || keys.arrowleft)  { player.x -= fwdZ*sp; player.z += fwdX*sp; }
  if (keys.d || keys.arrowright) { player.x += fwdZ*sp; player.z -= fwdX*sp; }
  draw();
  requestAnimationFrame(step);
}

function draw(){
  // 0. Terrain layer (intentionally flat — pluggable)
  ctx.fillStyle = '#1a1d24'; ctx.fillRect(0, 0, MM, MM);

  // 1. Frustum cone
  const [pmx, pmz] = mode === 'follow' ? [R, R] : worldToMM(player.x, player.z);
  ctx.save();
  ctx.translate(pmx, pmz);
  ctx.rotate(-player.heading);
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.arc(0, 0, 70, -Math.PI/2 - 0.6, -Math.PI/2 + 0.6);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,240,200,.18)'; ctx.fill();
  ctx.restore();

  // 2. POIs
  for (const p of POIS){
    const [mx, mz] = worldToMM(p.x, p.z);
    const dx = mx - R, dz = mz - R;
    if (dx*dx + dz*dz > R*R) continue;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(mx, mz, 3, 0, Math.PI*2); ctx.fill();
  }

  // 3. Player chevron — always on top
  ctx.save();
  ctx.translate(pmx, pmz);
  ctx.rotate(-player.heading);
  ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
  ctx.fillStyle = 'rgba(225,105,30,.96)';
  ctx.beginPath();
  ctx.moveTo(0, -7); ctx.lineTo(5, 5);
  ctx.lineTo(0, 2.2); ctx.lineTo(-5, 5);
  ctx.closePath(); ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 1.1; ctx.strokeStyle = 'rgba(255,248,235,.92)'; ctx.stroke();
  ctx.restore();
}
step();
</script>
```

Drop in a real terrain renderer at step 0 (filled bands or marching squares) and a real heading source from your 3D camera, and you have a working radar HUD.
