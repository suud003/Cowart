# Auto-compose routing contract

Use this contract to turn a mixed requirement into a deterministic plan before generating or editing the Yogurt AI canvas.

## Plan shape

Maintain this logical structure in the Agent response. Image lineage is persisted in bounded shape metadata; native diagram and evidence identity uses their existing typed semantic and source fields. The full plan is not a standalone persisted canvas record, so a later turn must reconstruct it from the original task, prior preview, and frozen source context rather than assuming hidden in-memory state.

```json
{
  "schemaVersion": "1",
  "compositionId": "compose:<12-hex-composition-hash>",
  "source": {
    "pageId": "page:...",
    "revision": "...",
    "shapeIds": ["shape:..."],
    "sourceIds": ["source:..."]
  },
  "reference": {
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
      "reason": "Lighting and atmosphere carry the value",
      "targetZone": "视觉素材",
      "sourceShapeIds": ["shape:brief"],
      "sourceIds": [],
      "origin": "user",
      "status": "planned"
    }
  ]
}
```

Use stable IDs across revisions. Never renumber unchanged blocks merely because one block was added or removed.

## Bounded ID derivation

Derive IDs from canonical JSON and use hashes only; never include a generated slug in persistent identity.

Canonicalize an ID payload as follows:

1. Normalize every string to Unicode NFC, then replace CRLF and lone CR with LF. Do not otherwise trim, case-fold, translate, or rewrite strings.
2. Deduplicate ID arrays by exact normalized value while preserving the first occurrence. Preserve the frozen source order; do not sort arrays.
3. Serialize objects as JSON with keys sorted lexicographically at every depth, arrays in their declared order, standard JSON escaping, and no insignificant whitespace.
4. Encode the serialized text as UTF-8 without a byte-order mark. Hash those exact bytes with SHA-256 and use the first 12 lowercase hexadecimal characters.

The composition payload is exactly `{"initialRequirement": <string>, "pageId": <string>, "sourceShapeIds": <ordered string array>, "version": "1"}`. The block payload is exactly `{"compositionHash": <12-hex string>, "normalizedSummary": <string>, "route": <route string>, "sourceIds": <ordered string array>, "sourceShapeIds": <ordered string array>, "version": "1"}`. The serializer, not the order shown in prose, applies the key-order rule above.

- `compositionHash`: digest of the canonical composition payload.
- `blockHash`: digest of the canonical block payload.
- `compositionId`: `compose:<compositionHash>`; exactly 20 characters.
- `blockId`: `block:<blockHash>`; exactly 18 characters.
- diagram ID: `ac-diagram:<compositionHash>:<blockHash>`; 36 characters, within the 160-character schema limit.
- evidence card key: `ac-evidence:<compositionHash>:<blockHash>`; 37 characters, within the 80-character schema limit.
- evidence `source.id`: `ac-source:<compositionHash>:<blockHash>`; 35 characters, within the 160-character schema limit.

Keep an unchanged block's canonical input unchanged so its IDs survive rerouting previews and later turns. Never concatenate full user text or full composition/block IDs into a typed operation ID.

## Routing tests

Choose `visual` when the user needs to see appearance: scene, character, environment, art direction, mood, texture, illustrative metaphor, poster, key art, or a visual asset whose meaning would be lost as boxes and arrows.

Choose `diagram` when the user needs to inspect or edit structure: sequence, branching, state, dependency, hierarchy, ownership, architecture, choice-consequence logic, comparison, system boundary, or data flow. Diagram text and relations must come from the request or sources, never from generated pixels.

Choose `evidence` when wording or trace matters: requirement, quote, metric, source excerpt, constraint, risk, unresolved assumption, acceptance condition, or reference link. Preserve concise exact wording when permitted and include provenance.

Choose `question` only when missing information would change the primary representation or create a materially different outcome. Do not route ordinary uncertainty to a question when it can be labeled as an assumption.

One source fragment may support multiple blocks only when the outputs have distinct jobs. Example: a city description may support one atmosphere image and one evidence card. Do not duplicate the same idea into every zone.

## Reference-image contract

The master reference is a visual anchor, not the final canvas and not a semantic source.

It should communicate:

- shared palette, lighting, texture, lens or illustration language;
- overall composition rhythm and relative visual weight;
- approximate grouping of visual regions;
- enough subject continuity for later image generation.

It should not contain:

- long or exact product copy;
- requirements that must remain readable;
- final flow arrows, system relationships, or state logic;
- fake citations, issue identifiers, metrics, or UI controls;
- decorative sections that have no routed block.

Use the verified local reference path for every derived visual. Prefer the page-local `assetFile` returned by `insert_cowart_image`. When reusing an existing page asset, resolve it with `read_cowart_page_asset`. Do not silently fall back to an old generated image or a prompt-only description if the reference file cannot be read.

## Confirmation states

Use these phase states:

1. `route-planned`: route preview exists; no reference has been generated.
2. `reference-review`: one reference image is visible and the fan-out is paused.
3. `executing`: the user approved the exact reference and derived outputs are being created.
4. `complete`: every block has a visible result or an explicit unresolved status.
5. `stale`: the source revision or reference changed; re-read before continuing.

Normal mixed requests with a visual block should reach `reference-review` in the first execution turn. The user can approve, revise the reference, reroute a block, or cancel. Approval must arrive after the managed reference is visible, in the same Agent thread, and bind the current composition ID plus exact reference shape/path. Do not interpret silence, a pre-review instruction, or a generic earlier approval as approval.

## Canvas regions

Create only the regions required by the plan:

- `视觉参考`: the approved master reference and a compact status card;
- `视觉素材`: derived images, each tied to one visual block;
- `结构与流程`: editable semantic diagrams;
- `证据与约束`: exact requirements, sources, risks, and assumptions.

Use the source selection or nearest relevant material as the composition anchor. Preserve existing user layout. New regions may move together only when they belong to the same managed composition.

## Trace and identity fields

For generated image shapes only, use bounded string or string-array metadata supported by `insert_cowart_image`:

- `cowartAutoComposeVersion`: `"1"`;
- `cowartAutoComposeId`: stable composition ID;
- `cowartAutoComposeBlockId`: stable block ID for a derived result;
- `cowartAutoComposeRole`: `reference` or `visual-part`;
- `cowartAutoComposeReferenceShapeId`: approved reference image shape ID;
- `cowartAutoComposeSourceShapeIds`: bounded source canvas shape IDs for image results;

For native outputs, do not invent unsupported arbitrary metadata:

- diagrams set `semanticDiagram.diagramId` to the bounded `ac-diagram:<compositionHash>:<blockHash>` value, plus stable semantic object/relation IDs and the semantic contract's `sourceShapeIds` and `sourceIds`;
- evidence cards use the bounded `ac-evidence:<compositionHash>:<blockHash>` typed-operation key and `source.id: "ac-source:<compositionHash>:<blockHash>"`. Ordinary cards do not accept top-level `sourceShapeIds` or `sourceIds`.

For each evidence card, build provenance lists deterministically before calling `create_card`: place IDs cited directly by that evidence block first in their declared block order, then append the remaining mapped IDs in frozen source order, and deduplicate by first occurrence. Put at most the first 100 canvas IDs in `source.yogurtShapeIds` and at most the first 50 external/source identifiers in `sourceRefs`. If either full ordered list exceeds its limit, do not pass the overflow to unsupported fields and do not silently omit it: append a compact line to the card body for each overflowing list in the form `Provenance overflow: <field> kept <limit>/<total>; omitted <count>; sha256:<digest>.` Compute `<digest>` from the full ordered list using the canonical JSON and 12-hex SHA-256 rule above. If the user requires every source ID to remain individually addressable, stop and ask them to narrow the source scope or approve separately routed evidence blocks instead of creating a lossy card.

Do not store unbounded prompts, source bodies, or base64 image data in shape metadata.

For selection-scoped resume, append the approved `referenceShapeId` to the frozen source IDs when the combined list contains at most 250 IDs. With 250 frozen sources, make two exact selection reads—one for the frozen sources and one for `[referenceShapeId]`—and require matching page/revision values. If either value differs, repeat both exact reads once. If the second pair still differs, mark the composition `stale`, stop without writing, and ask the user to retry from the fresh canvas state; never loop. Never depend on page-scope truncation to discover an image inserted later. Source-only selection context does not include it.

Auto-compose metadata is a candidate index, not proof of approval. Before fan-out, resolve the exact image with `read_cowart_page_asset`, require a readable local canvas asset on the same page and composition, and require approval of that exact shape/path in the current Agent conversation. Imported or hand-authored metadata never counts as user approval.
