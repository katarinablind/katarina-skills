# katarina-skills

A Claude Code [plugin marketplace](https://docs.claude.com/en/docs/claude-code/plugins) bundling 12 skills for generative graphics, creative coding, and interactive visualizations.

## Install

In Claude Code:

```
/plugin marketplace add katarinablind/claude-skills
/plugin install katarina-skills@katarina-skills-marketplace
```

(Replace `katarinablind/claude-skills` with the actual GitHub `owner/repo` once published.)

## What's inside

| Skill | What it covers |
|---|---|
| `marching-squares-topology` | 2D iso-line contour fields in p5.js / canvas |
| `filled-band-topology` | Height-bucketed filled color bands (topo map look) |
| `3d-terrain-contours` | Three.js heightmap terrain + overlaid 3D contour lines |
| `minimap-radar-overlay` | 2D canvas minimap / radar HUD for 3D scenes |
| `generative-tree-mesh` | Procedurally-generated 3D tree meshes (Three.js) |
| `highlightable-grass-field` | InstancedMesh grass that brightens & sways near cursor |
| `swimming-fish-tank` | Autonomous-swimming fish/animal sprites with bob & flip |
| `realtime-presence-ping` | Cross-client ephemeral visual pings (bubbles, hearts) |
| `proximity-audio-mapping` | Cursor-driven Web Audio gain / filter envelopes |
| `operable-vehicle-mesh` | Driveable 3D vehicle meshes (car / kayak) with follow camera |
| `svg-path-grow-animation` | `stroke-dasharray` path-draw growth animations |
| `p5-react-portal` | Embedding a p5.js sketch inside React without remounts |

Each skill ships with a standalone `studio.html` demo you can open in a browser.

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
            ├── 3d-terrain-contours/
            ├── filled-band-topology/
            ├── generative-tree-mesh/
            ├── highlightable-grass-field/
            ├── marching-squares-topology/
            ├── minimap-radar-overlay/
            ├── operable-vehicle-mesh/
            ├── p5-react-portal/
            ├── proximity-audio-mapping/
            ├── realtime-presence-ping/
            ├── svg-path-grow-animation/
            └── swimming-fish-tank/
```

## Author

Katarina Blind — Seattle
