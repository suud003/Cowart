# Yogurt semantic diagram contract

Read this contract when creating, validating, revising, or writing back an HTML inline-SVG diagram. Native-card diagrams use the same stable semantic IDs, source/synthesis/inference origins, relation direction/path meanings, and source trace model, but do not need the HTML envelope. Native objects may additionally use canvas-oriented roles (`actor`, `process`, `data`, `outcome`, `group`, `custom`) and uncertainty origins (`assumption`, `question`); preserve those values during round trips instead of coercing them into Product Bridge fields.

## 1. Semantic specification

Store one JSON object in the template carrying data-cowart-diagram-spec and preserve unknown fields when revising an existing artifact.

~~~json
{
  "schemaVersion": "1",
  "diagramId": "product-intake-flow",
  "claim": "Rough Yogurt notes become a reviewable artifact and can return without overwriting newer canvas work.",
  "mode": "html-svg",
  "objects": [
    {
      "id": "yogurt-notes",
      "label": "Yogurt notes",
      "role": "document",
      "origin": "source",
      "sourceShapeIds": ["shape:notes"]
    },
    {
      "id": "review-workspace",
      "label": "Review workspace",
      "role": "container",
      "origin": "synthesis",
      "sourceShapeIds": []
    }
  ],
  "relations": [
    {
      "id": "notes-to-review",
      "from": "yogurt-notes",
      "to": "review-workspace",
      "type": "flow",
      "direction": "forward",
      "path": "primary",
      "label": "structure",
      "origin": "synthesis",
      "sourceShapeIds": ["shape:notes"]
    }
  ],
  "states": [],
  "visibleLabels": [
    {"text": "Yogurt notes", "role": "object-label"},
    {"text": "Review workspace", "role": "object-label"},
    {"text": "structure", "role": "relation-label"}
  ],
  "layout": {
    "kind": "flow",
    "readingOrder": "left-to-right",
    "peerAlignment": "visual-center-y",
    "alignmentTolerance": "0.5% of viewBox height",
    "minimumSafeGap": "2% of viewBox width",
    "containmentLabelZone": "top",
    "viewport": "responsive"
  },
  "trace": {
    "canvasId": "canvas:product",
    "pageId": "page:overview",
    "sourceRevision": "revision-12",
    "scope": "selection",
    "sourceShapeIds": ["shape:notes"],
    "mappings": [
      {
        "semanticId": "yogurt-notes",
        "sourceShapeIds": ["shape:notes"],
        "returnedShapeIds": []
      }
    ],
    "draftShapeId": null,
    "operationIds": [],
    "lastAppliedRevision": null
  }
}
~~~

Required object roles are selected from interface, agent, task, container, document, state, claim, evidence, question, decision, zone, and system. Required origins are source, user, synthesis, inference, or unknown. Use unknown only while keeping the uncertainty visible.

For the native route, put the batch trace in `semanticDiagram`, object trace in each `semantic` object, and relation trace directly on each `create_relation` operation. A native relation carries `semanticId`, `kind`, `direction`, `path`, optional `payload`, `lane`, `origin`, `sourceShapeIds`, and `sourceIds`. Real Excalidraw `startBinding` and `endBinding` values are the authoritative endpoints after a user reconnects an arrow; stale compatibility metadata must not revive a missing terminal or cross a diagram boundary. Do not reuse Product Bridge `bridge`, `zoneId`, requirement, page, or annotation fields. Keep the single-line semantic-zone title short; show a necessary teaching claim in a wrap-capable claim card and retain the full value in metadata.

Native semantic card and zone revisions may patch type, state, origin, reading order, and source mappings, but must preserve their `diagramId` and `semanticId`. Revise relation semantics and labels with `update_relation`; it preserves the stable relation ID, live bindings, user-edited styles, and geometry. Endpoint replacement remains an explicitly authorized structural change.

The prompt template is also JSON and must remain independently usable:

~~~json
{
  "schemaVersion": "1",
  "diagramId": "product-intake-flow",
  "prompt": "Generate one accessible responsive semantic SVG that preserves the embedded objects, relation direction, layout constraints, source trace, and visible labels. Use Yogurt design tokens, explicit boundary ports, unique IDs, and no external resources."
}
~~~

Serialize both JSON objects without raw less-than characters. At minimum replace them with \u003c; replacing ampersands with \u0026 is also recommended.

## 2. HTML and SVG envelope

An HTML draft contains one diagram and no remote dependency:

~~~html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    .cowart-diagram { width: 100%; min-width: 0; overflow: hidden; }
    .cowart-diagram svg { display: block; width: 100%; height: auto; }
    [data-cowart-stroke] { vector-effect: non-scaling-stroke; }
  </style>
</head>
<body>
  <main class="cowart-diagram">
    <svg viewBox="0 0 600 250" role="img"
      aria-labelledby="product-intake-title product-intake-desc"
      data-cowart-diagram-id="product-intake-flow"
      data-cowart-layout="flow"
      data-reading-order="left-to-right">
      <title id="product-intake-title">Product intake and return flow</title>
      <desc id="product-intake-desc">Yogurt notes flow to a review workspace through a source-grounded structuring step.</desc>
      <defs>
        <marker id="product-intake-arrow" viewBox="0 0 10 10" refX="10" refY="5"
          markerWidth="7" markerHeight="7" orient="auto">
          <path data-cowart-stroke d="M 0 0 L 10 5 L 0 10 Z"></path>
        </marker>
      </defs>
      <g data-cowart-object-id="yogurt-notes" data-cowart-role="document"
        data-cowart-origin="source" data-cowart-source-ids="shape:notes">
        <rect data-cowart-stroke x="40" y="82" width="170" height="72" rx="6"></rect>
        <text x="125" y="124" text-anchor="middle">Yogurt notes</text>
      </g>
      <g data-cowart-object-id="review-workspace" data-cowart-role="container"
        data-cowart-origin="synthesis">
        <rect data-cowart-stroke x="390" y="82" width="170" height="72" rx="6"></rect>
        <text x="475" y="124" text-anchor="middle">Review workspace</text>
      </g>
      <g data-cowart-relation-id="notes-to-review"
        data-from="yogurt-notes" data-to="review-workspace"
        data-relation="flow" data-direction="forward" data-path="primary"
        data-cowart-origin="synthesis">
        <path data-cowart-stroke d="M 210 118 H 390"
          marker-end="url(#product-intake-arrow)"></path>
      </g>
    </svg>
  </main>
  <template data-cowart-diagram-spec type="application/json">{"schemaVersion":"1","diagramId":"product-intake-flow","claim":"Yogurt notes become reviewable and returnable.","mode":"html-svg","objects":[{"id":"yogurt-notes","label":"Yogurt notes","role":"document","origin":"source","sourceShapeIds":["shape:notes"]},{"id":"review-workspace","label":"Review workspace","role":"container","origin":"synthesis","sourceShapeIds":[]}],"relations":[{"id":"notes-to-review","from":"yogurt-notes","to":"review-workspace","type":"flow","direction":"forward","path":"primary","label":"structure","origin":"synthesis","sourceShapeIds":["shape:notes"]}],"states":[],"visibleLabels":[],"layout":{"kind":"flow","readingOrder":"left-to-right","peerAlignment":"visual-center-y","alignmentTolerance":"0.5% of viewBox height","minimumSafeGap":"2% of viewBox width","containmentLabelZone":"top","viewport":"responsive"},"trace":{"canvasId":"canvas:product","pageId":"page:overview","sourceRevision":"revision-12","scope":"selection","sourceShapeIds":["shape:notes"],"mappings":[],"draftShapeId":null,"operationIds":[],"lastAppliedRevision":null}}</template>
  <template data-cowart-diagram-prompt type="application/json">{"schemaVersion":"1","diagramId":"product-intake-flow","prompt":"Generate one accessible responsive semantic SVG from the embedded source-grounded specification."}</template>
</body>
</html>
~~~

The abbreviated SVG illustrates the envelope, not a complete visual style. A directional relation must add a unique marker whose visible tip lands on the target boundary.

### Required SVG attributes

- Root: viewBox, role img, aria-labelledby, data-cowart-diagram-id, data-cowart-layout, and data-reading-order.
- Every semantic object group: data-cowart-object-id, data-cowart-role, and data-cowart-origin.
- Every semantic relation group: data-cowart-relation-id, data-from, data-to, data-relation, data-direction, data-path, and data-cowart-origin.
- Source-grounded elements: data-cowart-source-ids containing stable Yogurt shape IDs separated by spaces.
- Every visible stroked primitive: data-cowart-stroke, with CSS or an attribute applying vector-effect non-scaling-stroke.
- Title and description: unique IDs referenced together by aria-labelledby.
- Visible geometry uses coordinates baked directly into the SVG coordinate system. Do not put `transform` on visible groups, paths, nodes, or labels; the validator must be able to compare their real bounds with the root viewBox.

Prefix all document IDs with the diagram ID or a collision-resistant derivative. Repeating a diagram on one page must not duplicate title, description, marker, clip-path, or other IDs.

## 3. Relation grammar

| Meaning | data-relation | Direction | Visual form |
| --- | --- | --- | --- |
| main flow or handoff | flow | forward | solid directional line |
| dispatch from a coordinator | dispatch | forward | solid directional line |
| claim from a shared board | claim | forward | solid directional line |
| call or dependency | call or dependency | forward | solid directional line |
| state transition | transition | forward | directional line; label the state event when needed |
| optional or alternative path | same relation type | forward | dashed directional line with data-path alternative |
| synchronized design or exchange | sync | bidirectional | one route with markers at both ends |
| undirected association | association | none | dark solid line without a marker |
| comparison | compare | none | aligned peer groups; normally no connecting line |
| containment | contains | none | nested boundaries; never an arrow |

Color is a semantic role, not a copied palette. Map directional relations, warnings, blockers, borders, and muted labels to existing Yogurt tokens. Do not use color as the only state cue.

## 4. Layout, ports, and safe gaps

Supported layout profiles are hierarchy, flow, comparison, board-to-peers, containment, swimlane, interface, and custom.

1. Lay out group boundaries, containment label zones, separators, and relation lanes before placing objects.
2. Align three or more peers to a declared common anchor. Default center deviation must stay within 0.5% of viewBox height unless the specification states a stricter rule.
3. Keep every visible object, text label, stroke, marker, and the true extrema of each line or Bezier route inside the root viewBox. Reserve an outer safe inset of at least 2% of the shorter viewBox dimension, then keep the same elements at least 2% of viewBox width from unrelated group boundaries and separators. Increase either gap when labels or arrowheads need more room.
4. Use rectangle ports on the actual left, right, top, or bottom boundary. Choose the side consistent with the reading direction and relative object position.
5. Set a marker's reference point so its visible tip, rather than the path's hidden endpoint, reaches the target boundary. The relation tail begins on the source boundary.
6. Give parallel relations separate lanes. Unless the specification defines a scale-aware alternative, separate route centerlines by at least the greater of 12 viewBox units or 1.5 marker widths.
7. Do not route through an unrelated object, label, or containment title zone. Place relation labels in their own clear lane.
8. Long returns and cross-layer jumps use a monotonic quadratic or cubic Bezier only when orthogonal routing remains ambiguous. A curve must not introduce a new crossing.
9. Multiple edges may share a segment only when a visible, semantically explicit branch or merge node owns that segment.
10. If these constraints cannot be satisfied at the real Yogurt display size, split the diagram or switch to a native or hybrid representation.

Responsive HTML uses width 100%, min-width 0, height auto, and an explicit viewBox. Do not replace responsive CSS with fixed root SVG width and height. Yogurt derives a semantic HTML holder's minimum height from the viewBox aspect ratio, but the author must still keep all geometry inside that viewBox and verify the actual Yogurt card size and any narrow layout used by the host.

## 5. Accessibility and security

The title states what the diagram is. The description names the important objects, directions, and special states. Nearby prose must retain the core claim so it is not available only visually.

HTML diagrams are static, self-contained documents. They must not contain scripts, event-handler attributes, foreignObject, image, filters, remote fonts, external styles, network URLs, external href or xlink:href, iframes, embedded objects, or active form controls. Internal fragment references such as url(#product-intake-arrow) are permitted only when the target ID exists in the same document.

Run scripts/validate-semantic-svg.mjs before insertion and after material changes. The validator checks the static envelope and visible geometry, including path extrema, labels, stroke/marker allowance, and outer safe padding. It is not a sanitizer and does not prove collision-free or semantically correct routing; only generated or otherwise trusted markup should reach insert_cowart_html_draft.

## 6. Trace and return lifecycle

- Capture canvasId, pageId, source revision, scope, and shape IDs before authoring.
- Keep semantic IDs stable across revisions. Map each source-backed object or relation to its original shape IDs.
- Record the returned HTML draft shape ID after insertion. On later edits, update that same draft rather than creating a sibling.
- Before writing native cards back, re-read Yogurt context and compare revisions. A stale source revision invalidates a prior return preview.
- Preview HTML insertion with `dryRun: true`, then apply the exact payload with the returned `baseRevision`. A stale revision invalidates the preview and requires a new context read.
- Preview ordinary additive work with `apply_cowart_safe_thinking_operations` and require a valid `layoutReport`. Preserve user-authored shapes; use `apply_cowart_thinking_operations` only after explicit authorization for deletion or user-authored modification.
- After a successful return, add operation IDs, returned shape IDs, and lastAppliedRevision to trace, then update the existing HTML draft through insert_cowart_html_draft with updateExistingDraft true.
- Never infer external source content from a URL. Record it as unread unless the actual body is already present in the active context.
- Never hand-write raw Excalidraw element records or legacy tldraw records, and never replace a full canvas snapshot.

## 7. Validation commands

~~~powershell
node "<skill-dir>/scripts/validate-semantic-svg.mjs" --root "<artifact-root>" "<artifact-root>/diagram.html"
node "<skill-dir>/scripts/validate-semantic-svg.mjs" --self-test
~~~

The first command validates one or more files and optionally confines reads to --root. The validator also accepts --stdin. The second command runs in-memory positive and attack cases.
