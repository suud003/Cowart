# `interaction-prd.json` schema

The review container reads this file from the project root. Paths are relative to the project root and must remain inside it.

```json
{
  "version": 1,
  "product": {
    "name": "Example",
    "stage": "SHAPING",
    "viewport": { "width": 1280, "height": 800 }
  },
  "settings": { "showShaping": true },
  "bridge": {
    "sourcePacketPath": "bridge/source-packet.json",
    "traceMapPath": "bridge/trace-map.json",
    "syncStatePath": "bridge/sync-state.json"
  },
  "documents": [
    { "id": "brief", "title": "Brief", "kind": "shaping", "path": "shaping/01-brief.md" }
  ],
  "modules": [
    {
      "id": "foundation",
      "title": "Foundation",
      "status": "draft",
      "summary": "Shared components and states",
      "prdPath": "prd/foundation.md",
      "pages": [
        {
          "id": "components",
          "title": "Component states",
          "prototypePath": "prototypes/components.html",
          "viewport": { "width": 1280, "height": 800 },
          "position": { "x": 80, "y": 80 },
          "annotations": [
            {
              "id": 1,
              "x": 32,
              "y": 44,
              "anchor": {
                "type": "element",
                "key": "components.primary-action",
                "point": { "x": 1, "y": 0.5 },
                "offset": { "x": 8, "y": 0 }
              },
              "title": "Primary action",
              "body": "Only one primary action per section.",
              "requirementId": "F-foundation-01"
            }
          ],
          "transitions": [
            {
              "to": "home",
              "label": "Continue",
              "type": "flow",
              "direction": "forward",
              "path": "primary",
              "payload": "review draft"
            }
          ]
        }
      ]
    }
  ]
}
```

## Invariants

- `version` is `1`.
- `bridge` points to the three JSON files defined in [yogurt-bridge-contract.md](yogurt-bridge-contract.md).
- IDs are unique within their collection and stable after review begins.
- `x` and `y` annotation coordinates are percentages from the prototype viewport's top-left corner, from `0` through `100`. Keep them as a backward-compatible fallback.
- Prefer an `anchor` for every annotation. `anchor.key` names one unique `data-annotation-anchor` value in the prototype. `anchor.point.x/y` are normalized positions inside the target element from `0` through `1`; `anchor.offset.x/y` are prototype CSS pixels.
- Anchor keys are semantic and stable, for example `brief.generate` or `review.high-risk`. They are independent of requirement IDs because one requirement may map to several visible elements.
- When an anchor is missing, the viewer falls back to `x/y`, marks the bubble as degraded, and allows the reviewer to repair it with “重新定位”.
- `requirementId` may be omitted or left empty while a note is still being triaged. When provided, it must name a requirement ID declared in a module PRD.
- Every page has a finite numeric `position.x/y` and a `viewport.width/height` made of positive finite numbers. The viewer defensively renders a missing position at `{ "x": 0, "y": 0 }`, but the validator rejects incomplete geometry so saved workspaces remain deterministic.
- A transition `to` value names a page ID in any module.
- Transition semantic fields are optional and backward compatible. `type` is one of `flow`, `dispatch`, `claim`, `sync`, `association`, or `compare`; `direction` is `forward`, `bidirectional`, or `none`; `path` is `primary` or `alternative`; and `payload` is an optional short handoff label. Missing fields default to `flow`, a type-appropriate direction (`sync` is bidirectional, `association` and `compare` are undirected, otherwise forward), and `primary`.
- The source page and transition `to` still define the layout order even for a bidirectional or undirected relation. Direction controls arrowheads, while `alternative` controls the dashed visual path. Use `label` for the relationship verb and add `payload` only when the transferred item is necessary to understand the flow.
- The viewer persists annotations and canvas positions back into this file.
- `status` is one of `planned`, `draft`, `review`, `approved`, or `deprecated`.
- `prototypePath` points to an HTML file. `prdPath` and document paths point to Markdown files.

The browser UI tolerates unknown fields. Preserve them when editing so future extensions and reviewer metadata are not lost.
