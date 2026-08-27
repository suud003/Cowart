# Yogurt bridge contract

Use these files as the durable boundary between Yogurt AI and the review workspace. Keep IDs stable after review begins and preserve unknown fields.

## `bridge/source-packet.json`

This file records what was actually captured, its provenance, and whether linked systems were readable.

```json
{
  "version": 1,
  "workspaceId": "example-product",
  "productName": "Example Product",
  "capture": {
    "canvasId": "canvas-123",
    "pageId": "page-1",
    "scope": "selection",
    "sourceRevision": "42",
    "selectionShapeIds": ["shape:a", "shape:b"]
  },
  "sources": [
    {
      "id": "src-yogurt-a",
      "kind": "yogurt-shape",
      "title": "用户问题",
      "summary": "A source-faithful summary",
      "excerpt": "A short representative excerpt",
      "yogurtShapeIds": ["shape:a"],
      "provenance": { "origin": "user-authored", "uri": null },
      "accessStatus": "available"
    },
    {
      "id": "src-external-101",
      "kind": "external-link",
      "title": "External requirement reference",
      "summary": null,
      "excerpt": null,
      "yogurtShapeIds": ["shape:b"],
      "provenance": { "origin": "linked-reference", "uri": "https://requirements.example/101" },
      "accessStatus": "unread"
    }
  ],
  "ideas": [],
  "assumptions": [],
  "openQuestions": []
}
```

Allowed `kind` values are `yogurt-shape`, `user-note`, `external-link`, `document`, `image`, `code`, and `other`. The legacy `tapd-link` value remains accepted only so existing workspaces continue to validate. Allowed `accessStatus` values are:

- `available`: content was actually returned by an authorized source or directly supplied by the user;
- `unread`: a reference exists but has not been opened;
- `not-configured`: no source reader is configured;
- `denied`: access was refused;
- `error`: an attempted read failed.

An external URL alone is never `available`. Do not fill `summary` or `excerpt` as if linked content had been read. A user-pasted requirement body may be a separate `user-note` with `available` status and a relation to the external reference.

## `bridge/trace-map.json`

This file connects evidence and Yogurt canvas structure to generated product artifacts and returned shapes.

```json
{
  "version": 1,
  "workspaceId": "example-product",
  "mappings": [
    {
      "id": "map-intake-generate",
      "sourceIds": ["src-yogurt-a", "src-external-101"],
      "yogurtShapeIds": ["shape:a", "shape:b"],
      "zoneId": "zone-intake",
      "requirementIds": ["F-intake-01"],
      "pageIds": ["intake-main"],
      "annotationRefs": ["intake-main#1"],
      "returnedShapeIds": [],
      "lastSyncedRevision": null
    }
  ]
}
```

`annotationRefs` use `<pageId>#<annotationId>`. Every referenced annotation should name the mapped requirement ID. Never delete accepted mappings merely because an artifact was deprecated; mark the artifact deprecated and retain its lineage.

When copying trace data into a typed `create_zone` or `update_zone` operation, the operation's `bridge` object accepts exactly this constrained subset: `mappingId`, `workspaceId`, `sourceIds`, `yogurtShapeIds`, `zoneId`, `requirementIds`, `pageIds`, `annotationRefs`, `returnedShapeIds`, and `lastSyncedRevision`. Keep richer workspace state in these bridge files rather than attaching arbitrary fields to the canvas.

## `bridge/sync-state.json`

This file describes one proposed or completed return without storing raw tldraw records.

```json
{
  "version": 1,
  "workspaceId": "example-product",
  "returnFlow": {
    "mode": "dry-run-required",
    "status": "idle",
    "sourceRevision": "42",
    "previewBaseRevision": null,
    "operationDigest": null,
    "confirmation": {
      "required": true,
      "confirmed": false,
      "confirmedAt": null
    },
    "appliedRevision": null,
    "operationId": null,
    "pendingMappingUpdates": [],
    "conflicts": []
  }
}
```

Allowed `status` values are `idle`, `previewed`, `awaiting-confirmation`, `confirmed`, `applied`, `stale`, `conflict`, and `undone`.

## Return protocol invariants

1. Read the live Yogurt context and revision immediately before planning.
2. Preview through `apply_cowart_thinking_operations` with `dryRun: true` and that revision.
3. Persist `previewBaseRevision` and a deterministic digest of the exact operation list. Do not persist or mutate raw tldraw records.
4. Obtain explicit user confirmation for that preview. Confirmation does not carry over when operations or the base revision change.
5. Apply the identical operations against the preview base revision. Use `create_zone` for a new stable zone and `update_zone` for an existing shape ID or stable zone key. A stale revision requires a new preview and confirmation.
6. After success, persist the operation ID, applied revision, returned shape IDs, and mapping updates.
7. Preserve user-authored shapes and unrelated canvas areas. Use the undo tool for rollback and respect stale-undo refusal.

## Zone design

A `zoneId` identifies a stable product-thinking region, not screen coordinates. Typical zones include source material, problem framing, users, opportunities, requirements, flows, risks, open decisions, and prototype review. The return operation may position these zones near their originating material, but layout changes must not change the IDs.
