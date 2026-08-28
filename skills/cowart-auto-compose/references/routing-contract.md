# Auto-compose routing and layout contract

Use this contract to turn one mixed requirement into a deterministic page plan before generating or editing the Yogurt AI canvas. The first bitmap is a review surface for the whole page layout, not concept art.

## Plan shape

Maintain this logical structure in the Agent response. The structured `layoutPlan` is the machine-readable placement contract; `layoutReference` is its human-reviewable bitmap projection. Never reconstruct the plan from bitmap pixels or OCR. Image lineage is persisted in bounded shape metadata; native diagram and evidence identity uses their existing typed semantic and source fields. A later turn must reconstruct the plan from the original task, prior preview, and frozen source context rather than assuming hidden memory.

```json
{
  "schemaVersion": "2",
  "compositionId": "compose:<12-hex-composition-hash>",
  "source": {
    "pageId": "page:...",
    "revision": "...",
    "shapeIds": ["shape:..."],
    "sourceIds": ["source:..."]
  },
  "layoutPlan": {
    "version": "1",
    "frame": { "width": 1600, "height": 1000 },
    "readingOrder": "left-to-right, then top-to-bottom",
    "slots": [
      {
        "id": "slot:<12-hex-block-hash>",
        "blockId": "block:<12-hex-block-hash>",
        "route": "visual",
        "region": "视觉素材",
        "rect": { "x": 0, "y": 0, "w": 520, "h": 1000 },
        "order": 1,
        "fit": "cover"
      }
    ]
  },
  "layoutPlanDigest": "<64-lowercase-hex-sha256>",
  "layoutReference": {
    "required": true,
    "status": "planned",
    "shapeId": null,
    "assetFile": null
  },
  "blocks": [
    {
      "id": "block:<12-hex-block-hash>",
      "summary": "Rainy near-future city mood",
      "route": "visual",
      "reason": "Appearance carries the value",
      "sourceShapeIds": ["shape:brief"],
      "sourceIds": [],
      "origin": "user",
      "status": "planned"
    }
  ]
}
```

Use stable IDs across revisions. Never renumber unchanged blocks merely because one block was added or removed.

## Layout-plan invariants

- Use a local integer coordinate plane of `1600 x 1000`. Map that frame beside the source scope only during execution.
- Give every executable `visual`, `diagram`, and `evidence` block exactly one slot. `question` blocks have no slot until resolved.
- A slot has one stable `id`, matching `blockId`, route, region, integer `rect`, unique positive `order`, and `fit` (`cover`, `contain`, or `native`).
- Require `x >= 0`, `y >= 0`, `w > 0`, `h > 0`, `x + w <= 1600`, and `y + h <= 1000`. Use at most 20 slots.
- Slots must not materially overlap. Small decorative overlap is allowed only when explicitly labeled and never for text-heavy diagram or evidence slots.
- Use enough size for readable native text. If content cannot fit, split the block before review instead of overflowing after approval.
- Serialize the complete `layoutPlan` with the canonical JSON rules below and compute SHA-256 over its UTF-8 bytes. Store all 64 lowercase hexadecimal characters as `layoutPlanDigest`.
- The route preview must show each block's slot, normalized bounds, reading order, and route. Approval binds the exact plan digest; moving or resizing a slot invalidates prior approval.

## Bounded ID derivation

Derive IDs from canonical JSON and use hashes only; never include a generated slug in persistent identity.

Canonicalize an ID payload as follows:

1. Normalize every string to Unicode NFC, then replace CRLF and lone CR with LF. Do not otherwise trim, case-fold, translate, or rewrite strings.
2. Deduplicate ID arrays by exact normalized value while preserving the first occurrence. Preserve the frozen source order; do not sort arrays.
3. Serialize objects as JSON with keys sorted lexicographically at every depth, arrays in their declared order, standard JSON escaping, and no insignificant whitespace.
4. Encode the serialized text as UTF-8 without a byte-order mark. Hash those exact bytes with SHA-256. Use the first 12 lowercase hexadecimal characters for bounded IDs and the full 64 characters for `layoutPlanDigest`.

The composition payload is exactly `{"initialRequirement": <string>, "pageId": <string>, "sourceShapeIds": <ordered string array>, "version": "1"}`. The block payload is exactly `{"compositionHash": <12-hex string>, "normalizedSummary": <string>, "route": <route string>, "sourceIds": <ordered string array>, "sourceShapeIds": <ordered string array>, "version": "1"}`. The serializer, not the order shown in prose, applies the key-order rule above.

- `compositionId`: `compose:<compositionHash>`; exactly 20 characters.
- `blockId`: `block:<blockHash>`; exactly 18 characters.
- slot ID: `slot:<blockHash>`; exactly 17 characters.
- diagram ID: `ac-diagram:<compositionHash>:<blockHash>`; 36 characters.
- evidence card key: `ac-evidence:<compositionHash>:<blockHash>`; 37 characters.
- evidence `source.id`: `ac-source:<compositionHash>:<blockHash>`; 35 characters.

Keep an unchanged block's canonical input unchanged so its IDs survive previews and later turns. Never concatenate full user text or full composition/block IDs into a typed operation ID.

## Routing tests

Choose `visual` when the user needs to see appearance: scene, character, environment, art direction, mood, texture, illustrative metaphor, poster, key art, or another visual asset.

Choose `diagram` when the user needs to inspect or edit structure: sequence, branching, state, dependency, hierarchy, ownership, architecture, choice-consequence logic, comparison, system boundary, or data flow. Diagram text and relations come from the request or sources, never generated pixels.

Choose `evidence` when wording or trace matters: requirement, quote, metric, source excerpt, constraint, risk, unresolved assumption, acceptance condition, or reference link. Preserve concise exact wording when permitted and include provenance.

Choose `question` only when missing information would change the primary representation or create a materially different outcome. Label ordinary uncertainty as an assumption instead.

One source fragment may support multiple blocks only when the outputs have distinct jobs. Do not duplicate the same idea into every region.

## Full-canvas layout blueprint contract

The layout reference is a page-layout blueprint derived from `layoutPlan`, not the final canvas and not a semantic source. Generate it for every mixed auto-compose task, including diagram-plus-evidence tasks without a visual block.

It must show:

- the whole page boundary and every planned slot;
- each slot's relative position, size, hierarchy, whitespace, and reading order;
- recognizable placeholder treatment for image, editable diagram, and evidence regions;
- short region labels and block IDs sufficient to compare it with the route preview.

It must not become:

- one cinematic scene, character sheet, key art, poster, or moodboard without the page regions;
- a loose collage that omits the canvas boundary or slot hierarchy;
- long or exact product copy, final flow semantics, fake citations, issue IDs, metrics, or UI controls;
- the source of any product fact, relationship, label, or constraint.

If there are two or more slots, visually verify that the page boundary and at least two distinct planned regions are visible. Compare every slot against the structured plan before insertion. If the bitmap is concept art or does not materially match the plan, regenerate it once; if it still fails, stop without inserting it.

A user-supplied concept image may inform styling for a visual slot, but it is not the page-layout blueprint. Generate a new managed blueprint from the structured plan. Only reuse a supplied image as the blueprint when it visibly is a whole-page layout mockup and matches all current slots.

## Confirmation states

1. `route-planned`: route and structured layout previews exist; no blueprint has been generated.
2. `layout-reference-review`: one verified layout blueprint is visible and fan-out is paused.
3. `executing`: the user approved the exact composition ID, plan digest, blueprint shape, and local asset path.
4. `complete`: every block has a visible result or explicit unresolved status.
5. `stale`: the source revision, plan digest, blueprint shape, or asset changed; re-read before continuing.

Normal mixed requests reach `layout-reference-review` in the first execution turn. Approval must arrive after the managed blueprint is visible, in the same Agent thread, and bind the current `compositionId + layoutPlanDigest + shapeId + assetFile`. Do not interpret silence, a pre-review instruction, or a generic earlier approval as approval.

## Canvas regions and placement

Create only regions required by the approved plan:

- `布局参考`: the approved whole-page blueprint and compact status card;
- `视觉素材`: derived images, each tied to one visual block;
- `结构与流程`: editable semantic diagrams;
- `证据与约束`: exact requirements, sources, risks, and assumptions.

Map the approved 1600 x 1000 plan beside the source selection. Place every result from its slot bounds with typed Yogurt create/move/resize operations. The structured plan, not the bitmap, controls final coordinates. Preserve existing user layout and unrelated shapes.

## Trace and identity fields

Generated auto-compose image shapes use only these bounded metadata fields:

- `cowartAutoComposeVersion`: `"2"`;
- `cowartAutoComposeId`: stable composition ID;
- `cowartAutoComposeRole`: `layout-reference` or `visual-part`;
- `cowartAutoComposeLayoutPlanDigest`: exact 64-character layout digest;
- `cowartAutoComposeBlockId`: stable block ID for a visual part;
- `cowartAutoComposeReferenceShapeId`: approved layout-reference shape ID for a visual part;
- `cowartAutoComposeSourceShapeIds`: bounded source canvas shape IDs.

Version 1 `reference` images are legacy concept references. Leave them visible but never expose them as trusted auto-compose lineage or resume from them. A `visual-part` is trusted only when its referenced image is a same-page local `layout-reference` with the same composition ID and layout digest.

For native outputs, do not invent unsupported arbitrary metadata:

- diagrams set `semanticDiagram.diagramId` to `ac-diagram:<compositionHash>:<blockHash>`, plus stable semantic object/relation IDs and the semantic contract's source fields;
- evidence cards use `ac-evidence:<compositionHash>:<blockHash>` and `source.id: "ac-source:<compositionHash>:<blockHash>"`.

For each evidence card, order provenance deterministically: IDs directly cited by the block first, then remaining mapped IDs in frozen source order, deduplicated by first occurrence. Put at most the first 100 canvas IDs in `source.yogurtShapeIds` and the first 50 external/source identifiers in `sourceRefs`. For overflow, append `Provenance overflow: <field> kept <limit>/<total>; omitted <count>; sha256:<12-hex-digest>.` If every source must remain individually addressable, ask the user to narrow the scope or approve split evidence blocks.

Do not store unbounded prompts, source bodies, the full plan, or base64 image data in shape metadata.

For selection-scoped resume, append the approved `referenceShapeId` to frozen source IDs when the combined list is at most 250. With 250 frozen sources, make two exact selection reads—frozen sources and `[referenceShapeId]`—and require the same page and revision. If they differ, repeat both exact reads once. If the retry still differs, mark `stale`, stop without writing, and ask the user to retry. Never depend on page-scope truncation. Source-only selection context does not include the later blueprint.

Auto-compose metadata is only a candidate index. Before fan-out, reconstruct the layout plan, verify its digest, resolve the exact image with `read_cowart_page_asset`, require a readable same-page local asset and same composition/digest, and require approval of that exact tuple in the current Agent conversation. Imported or hand-authored metadata never counts as approval.
