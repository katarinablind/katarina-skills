---
name: 3d-terrain-contours
description: Use when building 3D heightmap terrain with overlaid contour lines (topographic-map look) in Three.js — deformed PlaneGeometry driven by FBM noise, multi-level iso-line extraction emitted as 3D world-space LineSegments floating just above the surface, biome-driven vertex colors, scrolling/streaming terrain windows, and per-cell mask filters (e.g. roads). Skip for flat 2D contour-only work (use marching-squares-topology), terrain rendering without overlaid lines, voxel terrain, or generic Three.js scene setup.
---

# 3D heightmap with overlaid contour lines

The "3D topographic map" look: a deformed plane with crisp dark lines tracing iso-elevations above it. Two meshes, one shared height function.

## Cross-reference

- `marching-squares-topology` covers the 2D-canvas case (16-case lookup table, edge interpolation, cursor depression). Read it first if you need the algorithm itself — this skill assumes it.
- If the consumer only needs flat 2D contour lines (canvas / SVG / p5), point them at `marching-squares-topology` and stop.
- This skill is specifically the combo: 3D mesh **plus** lines floating above it, sharing one height field.

## Architecture: two meshes, one height function

```
heightFn(nx, sY) ──┬──> PlaneGeometry vertices  (terrainMesh, MeshStandardMaterial, vertexColors)
                   └──> hCache[] ──> marchingSquares ──> LineSegments BufferGeometry  (contourMesh)
```

- **Terrain**: `THREE.PlaneGeometry(W, D, SEGS, SEGS).rotateX(-Math.PI/2)`. You write into `position` and `color` typed arrays each frame and flip `needsUpdate`. Material is `MeshStandardMaterial({vertexColors:true, flatShading:true})`.
- **Contours**: a separate `THREE.BufferGeometry` with preallocated `position` (Float32Array, `MAX_CSEGS*6`) and `color` attributes, drawn with `LineSegments` + `LineBasicMaterial({vertexColors:true, fog:false})`. `frustumCulled=false` (the bounding sphere starts degenerate). `renderOrder=1` so it draws after the terrain and the depth test resolves cleanly.
- They share `hCache`: the terrain pass fills it (one float per grid vertex), the contour pass reads it. Don't sample the noise twice.

## Height function

Layered FBM, then biome shaping, then optional radial warp:

```js
function fbm(x,y){let v=0,a=.5,f=1;for(let i=0;i<5;i++){v+=a*noise2d(x*f,y*f);a*=.5;f*=2}return v*.5+.5}
function fbm3(x,y){let v=0,a=.5,f=1;for(let i=0;i<3;i++){v+=a*noise2d(x*f,y*f);a*=.5;f*=2}return v*.5+.5}
```

- **`fbm` (5 octaves)** for gameplay queries that need detail (car-vs-ground, hazard collisions, the contour pass which traces fine creases).
- **`fbm3` (3 octaves, fast)** for the terrain mesh vertex pass. The mesh runs `(SEGS+1)^2` samples per update — the bottom two octaves are below the per-vertex spacing anyway, so dropping them is free visually and ~40% cheaper. Use the slow variant only where the missing detail is visible (line crossings on the road).

Biome thresholding sits on top:

```js
function getBiome(sY){
  const prog = (.14 - sY/5) / FINISH_DIST;
  if (prog < .2)  return 'meadow';
  if (prog < .45) return 'cliff';
  if (prog < .7)  return 'forest';
  return 'alpine';
}
// inside sampleTerrainHeight:
if (biome==='cliff')  v += Math.exp(-((nx-.82)**2)/.008)*.15;
else if (biome==='alpine') v += fbm(nx*10+60, sY*6+60)*.08;
```

Optional `applyRadialWarp(x, y, cx, cy, r, amp)` displaces grid samples radially around an agent — positive `amp` bows lines outward, negative `amp` collapses them inward. Run it on the input `(nx, sY)` before sampling.

## Updating the terrain mesh per frame

**Don't rebuild the geometry.** Write into the existing typed arrays:

```js
const pos = terrainGeo.attributes.position;
const col = terrainGeo.attributes.color;
for (let j = 0; j <= SEGS; j++) {
  for (let i = 0; i <= SEGS; i++) {
    const vIdx = j*(SEGS+1) + i;
    const nx = i/SEGS, sY = sYMin + (j/SEGS)*(sYMax-sYMin);
    const v = sampleTerrainHeightFast(nx, sY);
    hCache[vIdx] = v;                                    // share with contour pass
    pos.setXYZ(vIdx, (nx-0.5)*WORLD_SCALE, v*HEIGHT_SCALE, (sY-carSY)*WORLD_SCALE);
    col.setXYZ(vIdx, r, g, b);
  }
}
pos.needsUpdate = true;
col.needsUpdate = true;
terrainGeo.computeVertexNormals();
```

Cost is `O(SEGS^2)` noise samples per update plus a normal recompute. At `SEGS=90` that's ~8.3k vertices per frame — fine on desktop, tight on mobile. Throttle by skipping updates when the scroll offset hasn't moved enough:

```js
if (Math.abs(scrollOff - _lastTerrainScroll) < 0.008) return;
```

Bound `SEGS` aggressively. Doubling it 4×s the cost.

## Marching squares in 3D

Same 16-case lookup table as 2D. The trick is what you do at the edge crossing — instead of emitting `(x, y)` you emit `(x, height, z)`, where height is **the iso-level itself** (no extra interpolation: by construction the field equals the iso at the crossing).

```js
// MS_TABLE: bits = TL<<3|TR<<2|BR<<1|BL<<0, edges 0=top 1=right 2=bottom 3=left
const MS_TABLE = [
  [],[[2,3]],[[1,2]],[[1,3]],
  [[0,1]],[[0,3],[1,2]],[[0,2]],[[0,3]],
  [[0,3]],[[0,2]],[[0,1],[2,3]],[[0,1]],
  [[1,3]],[[1,2]],[[2,3]],[]
];

function marchingSquares(field, cols, rows, iso, visit, filter) {
  const stride = cols + 1;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (filter && !filter(c, r)) continue;
    const i = r*stride + c;
    const v00=field[i], v10=field[i+1], v01=field[i+stride], v11=field[i+stride+1];
    const bits = (v00>=iso?8:0)|(v10>=iso?4:0)|(v11>=iso?2:0)|(v01>=iso?1:0);
    if (bits === 0 || bits === 15) continue;
    const dhT=v10-v00, dhR=v11-v10, dhB=v11-v01, dhL=v01-v00;
    const tT = Math.abs(dhT)<1e-6 ? .5 : (iso-v00)/dhT;
    const tR = Math.abs(dhR)<1e-6 ? .5 : (iso-v10)/dhR;
    const tB = Math.abs(dhB)<1e-6 ? .5 : (iso-v01)/dhB;
    const tL = Math.abs(dhL)<1e-6 ? .5 : (iso-v00)/dhL;
    const ex=[c+tT, c+1, c+tB, c], ey=[r, r+tR, r+1, r+tL];
    for (const [e0,e1] of MS_TABLE[bits]) visit(ex[e0],ey[e0],ex[e1],ey[e1],c,r);
  }
}
```

In `visit`, lift the segment slightly above the surface to dodge z-fighting:

```js
function edgeToWorld(xg, yg, ht, out) {
  const nx = xg/SEGS, sY = sYMin + (yg/SEGS)*(sYMax-sYMin);
  out[0] = (nx - 0.5) * WORLD_SCALE;
  out[1] = ht * HEIGHT_SCALE + 0.12;   // ← lift; tune per HEIGHT_SCALE
  out[2] = (sY - carSY) * WORLD_SCALE;
}
```

**Preallocate, don't grow.** Allocate one `Float32Array(MAX_CSEGS*6)` for positions and one for colors at startup. Track a `segIdx` cursor; bail when nearly full and call `geo.setDrawRange(0, segIdx*2)` at the end:

```js
const MAX_CSEGS = 24000;
const cPos = new Float32Array(MAX_CSEGS*6);
const cCol = new Float32Array(MAX_CSEGS*6);
let segIdx = 0;
for (const level of CONTOUR_LEVELS) {
  if (segIdx >= MAX_CSEGS - 4) break;
  marchingSquares(hCache, SEGS, SEGS, level, (x0,y0,x1,y1,c,r) => {
    if (segIdx >= MAX_CSEGS - 2) return;
    const base = segIdx*6;
    edgeToWorld(x0,y0,level, p0); edgeToWorld(x1,y1,level, p1);
    cPos[base]=p0[0]; cPos[base+1]=p0[1]; cPos[base+2]=p0[2];
    cPos[base+3]=p1[0]; cPos[base+4]=p1[1]; cPos[base+5]=p1[2];
    // ... colors ...
    segIdx++;
  });
}
contourGeo.setDrawRange(0, segIdx*2);
contourGeo.attributes.position.needsUpdate = true;
contourGeo.attributes.color.needsUpdate = true;
```

`CONTOUR_LEVELS` is a fixed array (`for (let v=.18; v<=.85; v+=.025) push(v)`) — **hardcode the iso values, don't derive them from `[hMin,hMax]`** of the visible window. Sliding bounds make lines pop in/out as the camera moves.

## The mask filter

`marchingSquares` accepts an optional `filter(c, r) => bool`. Returning false skips the entire cell — table lookup, edge math, the visit callback. Use it for any region you want contour-free:

```js
function roadMask(c, r) {
  if (segIdx >= MAX_CSEGS - 4) return false;            // doubles as budget brake
  const segNX = (c + 0.5) / SEGS;
  const segSY = sYMin + ((r + 0.5)/SEGS) * (sYMax-sYMin);
  return Math.abs(segNX - getRoadX(segSY)) <= ROAD_HALF_W * 3;  // only inside road corridor
}
```

Reusable for: water bodies, exclusion zones around POIs, fade-out at the visible window edge, LOD ("only contour the near band"), or as shown above as a budget short-circuit.

## Scrolling / streaming window

Recompute `[sYMin, sYMax]` from a moving anchor (`carSY`) each frame and remap grid index `j → sY` linearly. The mesh is positioned at the world origin and **its vertices** carry the scroll — that way a single PlaneGeometry serves an infinite world. Same logic applies to the contour pass since they share the height window.

## Minimal worked example

A standalone Three.js sketch — terrain + contours + drifting noise origin, no road, no biome:

```html
<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;background:#101418;overflow:hidden}canvas{display:block}</style>
<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.162.0/build/three.module.js"}}
</script>
<script type="module">
import * as THREE from 'three';

const W=innerWidth, H=innerHeight;
const SEGS=80, WORLD=60, HSCALE=6;
const ISO=[]; for(let v=.15;v<=.85;v+=.05)ISO.push(v);
const MAX_CSEGS=12000;

// noise + fbm
const perm=new Uint8Array(512);
{const p=Array.from({length:256},(_,i)=>i); for(let i=255;i>0;i--){const j=Math.floor(Math.random()*(i+1));[p[i],p[j]]=[p[j],p[i]]} for(let i=0;i<512;i++)perm[i]=p[i&255]}
const fade=t=>t*t*t*(t*(t*6-15)+10), lerp=(a,b,t)=>a+t*(b-a);
const grad=(h,x,y)=>((h&1)?-x:x)+((h&2)?-y:y);
function noise2d(x,y){const X=Math.floor(x)&255,Y=Math.floor(y)&255,xf=x-Math.floor(x),yf=y-Math.floor(y),u=fade(xf),v=fade(yf);
  return lerp(lerp(grad(perm[perm[X]+Y],xf,yf),grad(perm[perm[X+1]+Y],xf-1,yf),u),
              lerp(grad(perm[perm[X]+Y+1],xf,yf-1),grad(perm[perm[X+1]+Y+1],xf-1,yf-1),u),v)}
const fbm =(x,y)=>{let v=0,a=.5,f=1;for(let i=0;i<5;i++){v+=a*noise2d(x*f,y*f);a*=.5;f*=2}return v*.5+.5};
const fbm3=(x,y)=>{let v=0,a=.5,f=1;for(let i=0;i<3;i++){v+=a*noise2d(x*f,y*f);a*=.5;f*=2}return v*.5+.5};

// scene
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(W,H); renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setClearColor(0x101418); document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene(); scene.fog=new THREE.Fog(0x101418,40,110);
const cam=new THREE.PerspectiveCamera(55,W/H,.5,300); cam.position.set(0,30,40); cam.lookAt(0,0,0);
scene.add(new THREE.AmbientLight(0xffffff,.6));
const dl=new THREE.DirectionalLight(0xffffff,.9); dl.position.set(8,15,6); scene.add(dl);

// terrain
const tGeo=new THREE.PlaneGeometry(WORLD,WORLD,SEGS,SEGS); tGeo.rotateX(-Math.PI/2);
const tCol=new Float32Array((SEGS+1)**2*3);
tGeo.setAttribute('color',new THREE.BufferAttribute(tCol,3));
scene.add(new THREE.Mesh(tGeo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.85,flatShading:true})));
const hCache=new Float32Array((SEGS+1)**2);

// contours
const cPos=new Float32Array(MAX_CSEGS*6), cCol=new Float32Array(MAX_CSEGS*6);
const cGeo=new THREE.BufferGeometry();
cGeo.setAttribute('position',new THREE.BufferAttribute(cPos,3));
cGeo.setAttribute('color',new THREE.BufferAttribute(cCol,3));
cGeo.setDrawRange(0,0);
const cLines=new THREE.LineSegments(cGeo,new THREE.LineBasicMaterial({vertexColors:true,fog:false}));
cLines.frustumCulled=false; cLines.renderOrder=1; scene.add(cLines);

// marching squares
const MS=[[],[[2,3]],[[1,2]],[[1,3]],[[0,1]],[[0,3],[1,2]],[[0,2]],[[0,3]],
          [[0,3]],[[0,2]],[[0,1],[2,3]],[[0,1]],[[1,3]],[[1,2]],[[2,3]],[]];
function marchingSquares(F,cols,rows,iso,visit){
  const s=cols+1;
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const i=r*s+c, v00=F[i],v10=F[i+1],v01=F[i+s],v11=F[i+s+1];
    const b=(v00>=iso?8:0)|(v10>=iso?4:0)|(v11>=iso?2:0)|(v01>=iso?1:0);
    if(b===0||b===15)continue;
    const dT=v10-v00,dR=v11-v10,dB=v11-v01,dL=v01-v00;
    const tT=Math.abs(dT)<1e-6?.5:(iso-v00)/dT, tR=Math.abs(dR)<1e-6?.5:(iso-v10)/dR;
    const tB=Math.abs(dB)<1e-6?.5:(iso-v01)/dB, tL=Math.abs(dL)<1e-6?.5:(iso-v00)/dL;
    const ex=[c+tT,c+1,c+tB,c], ey=[r,r+tR,r+1,r+tL];
    for(const[e0,e1]of MS[b])visit(ex[e0],ey[e0],ex[e1],ey[e1]);
  }
}

// frame
let t=0;
function frame(){
  t+=.005;
  const pos=tGeo.attributes.position, col=tGeo.attributes.color;
  for(let j=0;j<=SEGS;j++)for(let i=0;i<=SEGS;i++){
    const vIdx=j*(SEGS+1)+i, nx=i/SEGS, ny=j/SEGS;
    const v=fbm3(nx*3+t, ny*3+t*.5);
    hCache[vIdx]=v;
    pos.setXYZ(vIdx,(nx-.5)*WORLD, v*HSCALE, (ny-.5)*WORLD);
    const g=.3+v*.7; col.setXYZ(vIdx, g*.55, g*.7, g*.45);
  }
  pos.needsUpdate=true; col.needsUpdate=true; tGeo.computeVertexNormals();

  let segIdx=0;
  for(const iso of ISO){
    if(segIdx>=MAX_CSEGS-4)break;
    marchingSquares(hCache,SEGS,SEGS,iso,(x0,y0,x1,y1)=>{
      if(segIdx>=MAX_CSEGS-2)return;
      const wy=iso*HSCALE+.08, base=segIdx*6;
      cPos[base]=(x0/SEGS-.5)*WORLD; cPos[base+1]=wy; cPos[base+2]=(y0/SEGS-.5)*WORLD;
      cPos[base+3]=(x1/SEGS-.5)*WORLD; cPos[base+4]=wy; cPos[base+5]=(y1/SEGS-.5)*WORLD;
      for(let k=0;k<6;k++)cCol[base+k]=k%3===0?.05:k%3===1?.05:.08;
      segIdx++;
    });
  }
  cGeo.setDrawRange(0,segIdx*2);
  cGeo.attributes.position.needsUpdate=true;
  cGeo.attributes.color.needsUpdate=true;

  renderer.render(scene,cam);
  requestAnimationFrame(frame);
}
frame();
</script>
```

Drop into a `.html` file, open it. The noise origin drifts in `t`, so the terrain morphs and the contour lines slide across it. Add the `filter` arg to `marchingSquares` when you need masking; swap `fbm3` for `fbm` and add biome/road shaping when you grow into the full reference.
