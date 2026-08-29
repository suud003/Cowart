# Auto-compose routing and page-plan contract

Use this v3 contract to turn one mixed requirement into a deterministic Yogurt AI page. The first bitmap is a near-final visual projection of the complete page plan. It is not an abstract blueprint, and it is never the semantic source of the final native objects.

## Plan shape

Maintain this logical structure in the Agent response. `pagePlan` is the machine-readable single source of geometry and preview content; `compositionReference` is its human-visible raster projection. Never reconstruct product semantics from pixels or OCR.

```json
{
  "schemaVersion": "3",
  "executionMode": "guided",
  "compositionId": "compose:<12-hex-composition-hash>",
  "source": {
    "pageId": "page:...",
    "revision": "...",
    "shapeIds": ["shape:..."],
    "sourceIds": ["source:..."]
  },
  "pagePlan": {
    "version": "3",
    "frame": { "width": 1600, "height": 1000 },
    "padding": 32,
    "gutter": 24,
    "slots": [
      {
        "id": "slot:<12-hex-block-hash>",
        "blockId": "block:<12-hex-block-hash>",
        "route": "visual",
        "region": "视觉素材",
        "rect": { "x": 32, "y": 32, "w": 520, "h": 936 },
        "padding": 24,
        "order": 1,
        "fit": "cover",
        "contentSpec": {
          "type": "visual",
          "brief": "Rainy near-future city mood",
          "focalPoint": "A lone player facing the city",
          "styleSourceIds": []
        }
      }
    ]
  },
  "pagePlanDigest": "<64-lowercase-hex-sha256>",
  "compositionReference": {
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

Keep stable IDs across revisions. Never renumber an unchanged block because another block was added or removed.

The object above is the Agent's logical orchestration record. The strict MCP validator intentionally accepts only the geometry/content subset: call `validate_cowart_auto_compose_plan` with exactly `{"plan":{"schemaVersion":"3","pagePlan":<pagePlan>}}`. The validator returns the normalized subset and `pagePlanDigest`; it does not accept or validate `executionMode`, `compositionId`, `source`, `compositionReference`, or `blocks`.

## Route-specific content specs

Every executable slot has exactly one bounded `contentSpec`. The same spec drives both the full-page preview and the final native or visual result.

- `visual`: `type: "visual"`, a concise `brief` of at most 800 characters, optional `focalPoint` of at most 200 characters, and up to 8 bounded `styleSourceIds`.
- `diagram`: `type: "diagram"`, one `diagramType`, one `teachingClaim`, one reading order, up to 8 semantic objects, and up to 10 relations. Objects carry stable ID, short label, type, state, and source mappings. Relations carry stable ID, endpoints, direction, path, optional short label, and source mappings.
- `evidence`: `type: "evidence"` and 1–4 cards. Each card has a stable ID, role, concise title, preview body of at most 280 characters, and bounded source-shape/source references.

`question` blocks do not receive a slot until resolved. Do not pad a preview with invented content merely to make it look complete.

## Page-plan invariants

- Use the integer local coordinate plane `1600 x 1000`, outer padding of at least 24 (prefer 32 for ordinary pages), and slot gutter of at least 24.
- Use 2–12 executable slots, with no more than 6 visual slots. At the orchestration layer, every executable block maps to exactly one slot. The strict validator checks slot, block-ID, slot-ID, and order uniqueness but cannot prove that the separate logical `blocks` report is complete.
- Require `x >= pagePlan.padding`, `y >= pagePlan.padding`, `w > 0`, `h > 0`, `x + w <= 1600 - pagePlan.padding`, and `y + h <= 1000 - pagePlan.padding`.
- Slot rectangles may not overlap for any reason. Remove the old decorative-overlap exception. Distinct slots must keep the declared gutter on at least one separating axis.
- Every slot has `padding >= 24`; its usable content rectangle is the slot rectangle inset by that padding.
- Use `fit: "cover"` or `"contain"` for visual slots and `fit: "native"` for diagram and evidence slots.
- A diagram slot should be at least 480 x 320; an evidence slot at least 300 x 180; a visual slot at least 300 x 220. Split or summarize content before preview when it cannot fit.
- Unique numeric `order` values define the whole-page reading order.
- Canonicalize the normalized validation payload `{ "schemaVersion": "3", "pagePlan": ... }`, including all `contentSpec` values, and compute SHA-256 over its UTF-8 bytes. Store all 64 lowercase hexadecimal characters as `pagePlanDigest`. Any geometry or content-spec change invalidates the prior preview and guided approval.

Before generating the bitmap, validate these invariants deterministically. Do not rely on the image model to repair an invalid plan.

## Bounded ID and digest derivation

Canonicalize ID payloads and the complete `pagePlan` as follows:

1. Normalize every string to Unicode NFC, then replace CRLF and lone CR with LF. Do not otherwise trim, case-fold, translate, or rewrite strings.
2. Deduplicate ID arrays by exact normalized value while preserving the first occurrence. Preserve frozen source order; do not sort arrays.
3. Normalize page-plan slots into ascending numeric `order`, then serialize objects as JSON with keys sorted lexicographically at every depth, all other arrays in declared order, standard JSON escaping, and no insignificant whitespace.
4. Encode as UTF-8 without a byte-order mark. Hash those exact bytes with SHA-256. Use the first 12 lowercase hexadecimal characters for bounded IDs and the full 64 characters for `pagePlanDigest`.

The composition payload remains exactly `{"initialRequirement": <string>, "pageId": <string>, "sourceShapeIds": <ordered string array>, "version": "1"}`. The block payload remains exactly `{"compositionHash": <12-hex string>, "normalizedSummary": <string>, "route": <route string>, "sourceIds": <ordered string array>, "sourceShapeIds": <ordered string array>, "version": "1"}`. Keeping those v1 ID payloads preserves stable composition and block IDs while the page-plan contract advances to v3.

- `compositionId`: `compose:<compositionHash>`; exactly 20 characters.
- `blockId`: `block:<blockHash>`; exactly 18 characters.
- slot ID: `slot:<blockHash>`; exactly 17 characters.
- diagram ID: `ac-diagram:<compositionHash>:<blockHash>`; 36 characters.
- evidence card key: `ac-evidence:<compositionHash>:<blockHash>`; 37 characters.
- evidence `source.id`: `ac-source:<compositionHash>:<blockHash>`; 35 characters.

The strict validator enforces the exact lowercase-hex `slot:` and `block:` formats above. It does not derive those hashes or validate composition, diagram, evidence, or source IDs outside the page-plan subset. Never concatenate full user text or full composition/block IDs into typed operation IDs.

## Routing tests

Choose `visual` when appearance carries the value: scene, character, environment, art direction, mood, texture, illustrative metaphor, poster, key art, or another visual asset.

Choose `diagram` when the user must inspect or edit structure: sequence, branching, state, dependency, hierarchy, ownership, architecture, choice-consequence logic, comparison, system boundary, or data flow.

Choose `evidence` when exact wording or provenance matters: requirement, quote, metric, source excerpt, constraint, risk, assumption, acceptance condition, or reference link.

Choose `question` only when missing information would change the core representation, authorization, or outcome. Record ordinary uncertainty as an assumption instead.

One source fragment may support several blocks only when the outputs have distinct jobs. Do not duplicate the same idea into every region.

## Full-page composition-reference contract

Generate one composition reference from the validated `pagePlan` for every mixed auto-compose task, including diagram-plus-evidence tasks without a visual block.

It must show:

- the complete page boundary, final visual hierarchy, whitespace, and reading order;
- representative rendered imagery in every visual slot rather than mountain icons or grey placeholders;
- recognizable topology in every diagram slot: the planned node count, major lanes or branches, arrows, and short labels from the diagram `contentSpec`;
- realistic card hierarchy, headings, and copy density in every evidence slot from the evidence `contentSpec`;
- styling coherent enough that each final part can use its own slot window as a visual reference.

It must not become:

- an empty wireframe, low-information layout blueprint, skeleton UI, or collection of blank boxes;
- one cinematic scene, character sheet, moodboard, key art, or poster without all page regions;
- fake citations, issue IDs, metrics, requirements, states, or relationships;
- the source of any product fact, relation, label, or constraint.

Visually compare every slot with its `contentSpec`. If a required region is missing, placeholder-like, or has materially wrong density/topology, regenerate once. If the retry still fails, stop without inserting it.

A user-supplied concept image may inform visual style, but it is not the page preview. Reuse an existing image only when it visibly is a near-final whole-page composition matching every current slot and spec.

## Execution modes and states

1. `route-planned`: route and validated page plan exist; no preview has been generated.
2. `composition-reference-review`: guided mode has one verified preview visible and fan-out is paused.
3. `autonomous-executing`: autonomous mode has one verified preview visible and immediately prepares the final parts.
4. `executing`: guided approval binds the current preview and final parts are being prepared.
5. `complete`: every block has a visible result or explicit unresolved status.
6. `stale`: source revision, page-plan digest, preview shape, or asset changed; re-read before continuing.

Guided approval must arrive after the managed preview is visible, in the same Agent thread, and bind `compositionId + pagePlanDigest + shapeId + assetFile`. Do not interpret silence or an earlier generic instruction as approval.

Autonomous execution is valid only when the Yogurt AI task envelope says the user enabled it. It skips this product-workflow checkpoint and ordinary non-material clarification, not security controls. It never auto-accepts an external website or network request, project-external write, credential disclosure, payment, deletion of user content, or another protected operation.

## Placement and collision checks

Create only regions required by the plan:

- `视觉预演`: the reduced composition reference and compact status card;
- `视觉素材`: final images tied to visual blocks;
- `结构与流程`: native editable semantic diagrams;
- `证据与约束`: exact requirements, sources, risks, and assumptions.

Map the 1600 x 1000 page plan beside the source selection only after finding a page origin with at least 64 canvas units of clearance from existing unmanaged shapes. The same mapped origin applies to every slot.

Prepare native diagram and evidence operations against the frozen context. Use one dry-run batch when possible. Before apply, inspect the real returned shape, label, and relation bounds:

- every root and descendant stays inside its slot's inset content rectangle;
- unrelated objects and text do not overlap;
- every relation reaches its intended boundary and avoids unrelated nodes and labels;
- no output collides with existing unmanaged content;
- the operation batch remains within the 100-operation tool limit.

Repack once when a dry-run fails. A second failure invalidates the current plan: in autonomous mode revise the affected plan and regenerate the composition reference once; in guided mode request a plan revision. Never commit a clipped, overflowing, partially connected, or tangled result.

## Trace and identity fields

Generated auto-compose image shapes use only these bounded lineage fields:

- `cowartAutoComposeVersion`: `"3"`;
- `cowartAutoComposeId`: stable composition ID;
- `cowartAutoComposeRole`: `composition-reference` or `visual-part`;
- `cowartAutoComposePagePlanDigest`: exact 64-character page-plan digest;
- `cowartAutoComposeBlockId`: stable block ID for a visual part;
- `cowartAutoComposeSlotId`: stable slot ID for a visual part;
- `cowartAutoComposeReferenceShapeId`: composition-reference shape ID for a visual part;
- `cowartAutoComposeSourceShapeIds`: bounded source canvas shape IDs.

Version 1 concept references and version 2 layout references are legacy. Leave them visible but never expose them as trusted v3 lineage or resume from them. A v3 `visual-part` is trusted only when its referenced image is a same-page local v3 `composition-reference` with the same composition ID and page-plan digest.

For native outputs, use their existing typed semantic and source fields:

- diagrams set `semanticDiagram.diagramId` to `ac-diagram:<compositionHash>:<blockHash>`, with stable object/relation IDs and source mappings;
- evidence cards use `ac-evidence:<compositionHash>:<blockHash>` and `source.id: "ac-source:<compositionHash>:<blockHash>"`.

For each evidence card, order provenance deterministically: directly cited IDs first, then remaining mapped IDs in frozen source order, deduplicated by first occurrence. Put at most 100 canvas IDs in `source.yogurtShapeIds` and 50 identifiers in `sourceRefs`. For overflow, append `Provenance overflow: <field> kept <limit>/<total>; omitted <count>; sha256:<12-hex-digest>.`

Do not store unbounded prompts, source bodies, complete plans, or base64 image data in shape metadata.

## Safe resume

For selection-scoped resume, append the exact `referenceShapeId` to frozen source IDs when the combined list is at most 250. With 250 frozen sources, make two exact selection reads—frozen sources and `[referenceShapeId]`—and require the same page and revision. If they differ, repeat both reads once. If the retry still differs, mark `stale` and stop. Never depend on a truncated page scan.

Compact lineage is only a candidate index. Before fan-out, reconstruct and validate the complete page plan, verify its digest, resolve the exact image with `read_cowart_page_asset`, and require a readable same-page local asset with matching composition and digest. Imported or hand-authored metadata never counts as guided approval.
