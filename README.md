# katarina-skills

A Claude Code [plugin marketplace](https://docs.claude.com/en/docs/claude-code/plugins) bundling 17 skills for generative graphics, creative coding, image-driven music, and interactive visualizations.

## Install

In Claude Code:

```
/plugin marketplace add katarinablind/katarina-skills
/plugin install katarina-skills@katarina-skills-marketplace
```

## What's inside

### Visualization & terrain

| Skill | What it covers |
|---|---|
| `marching-squares-topology` | 2D iso-line contour fields in p5.js / canvas |
| `filled-band-topology` | Height-bucketed filled color bands (topo-map look) |
| `3d-terrain-contours` | Three.js heightmap terrain + overlaid 3D contour lines |
| `3d-halftone-surface` | Wave-deformed surface rendered as a perspective-projected grid of image sprites |
| `minimap-radar-overlay` | 2D canvas minimap / radar HUD for 3D scenes |

### Generative scenes

| Skill | What it covers |
|---|---|
| `generative-tree-mesh` | Procedurally-generated 3D tree meshes (Three.js) |
| `highlightable-grass-field` | InstancedMesh grass that brightens & sways near cursor |
| `swimming-fish-tank` | Autonomous-swimming fish sprites with bob, flip, and stable per-fish variation |
| `fluid-mosaic` | Cursor-reactive image-circle blob that breathes inside a noise-warped boundary |

### Interaction & audio

| Skill | What it covers |
|---|---|
| `lo-fi-cursor-birds` | Small flock of cursor-following birds with character (image stacks, flap, drift-back) |
| `cursor-ripple-field` | Click/move-triggered expanding-ring offset field for any 2D point grid |
| `realtime-presence-ping` | Cross-client ephemeral visual pings (bubbles, hearts, ripples) |
| `proximity-audio-mapping` | Cursor-driven Web Audio gain / filter envelopes |
| `media-pipe` | MediaPipe hand-landmark gesture classification + continuous-control patterns (pinch-slide, palm-zoom, cursor, rotate, tilt) |

### Image → data pipelines

| Skill | What it covers |
|---|---|
| `palette` | Image → 5-swatch palette extraction with proportional vivacity scoring + hue-aware diversity gating |
| `silhouette` | Image → 1D horizon profile (skyline / mountain / forest) with auto-selection between top-scan and continuity algorithms |
| `rubato-probs` | Image metrics → small per-event probabilities for procedural variation (skip / harmony / echo / ornament) |

Each skill ships with a standalone `studio.html` demo. Some skills depend on shared assets (e.g. test images, design tokens) that aren't bundled — the canonical algorithm files always are.

## Repo layout

```
.
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    └── katarina-skills/
        ├── .claude-plugin/
        │   └── plugin.json
        └── skills/
            ├── 3d-halftone-surface/
            ├── 3d-terrain-contours/
            ├── cursor-ripple-field/
            ├── filled-band-topology/
            ├── fluid-mosaic/
            ├── generative-tree-mesh/
            ├── highlightable-grass-field/
            ├── lo-fi-cursor-birds/
            ├── marching-squares-topology/
            ├── media-pipe/
            ├── minimap-radar-overlay/
            ├── palette/
            ├── proximity-audio-mapping/
            ├── realtime-presence-ping/
            ├── rubato-probs/
            ├── silhouette/
            └── swimming-fish-tank/
```

## Author

Katarina Blind — Seattle
