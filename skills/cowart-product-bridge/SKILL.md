---
name: cowart-product-bridge
description: Turn rough Yogurt AI canvas notes, selected shapes, product ideas, requirement excerpts, and source references into a traceable PRD plus interactive prototype workspace, then preview and explicitly confirm a revision-safe return to Yogurt AI. Use when product thinking must move from Yogurt into reviewable product artifacts or be synchronized back without overwriting newer canvas work.
---

# Yogurt Product Bridge

Keep Yogurt AI as the thinking surface and the Interaction PRD workspace as the review surface. Preserve provenance across both directions; never treat a link, inference, or generated artifact as confirmed product truth.

## Route the request

- **Yogurt to product workspace:** read the relevant Yogurt page or selection, normalize its sources, then create or update the PRD and prototypes.
- **Revise an existing workspace:** preserve reviewer changes, stable IDs, and unknown manifest fields. Update only the affected modules and mappings.
- **Product workspace to Yogurt:** compute a small return plan, preview it against the current canvas revision, and apply it only after explicit confirmation.

Before capturing or returning Yogurt data, read [references/yogurt-bridge-contract.md](references/yogurt-bridge-contract.md). Before substantial PRD or prototype authoring, read [references/authoring.md](references/authoring.md). When editing `interaction-prd.json`, read [references/schema.md](references/schema.md).

## Start a workspace

For a new workspace, run:

```powershell
python "<skill-dir>/scripts/init_workspace.py" "<project-dir>" --name "<product-name>" --canvas-id "<canvas-id>" --page-id "<page-id>" --source-revision "<revision>" --scope selection
```

Omit unavailable Yogurt identifiers rather than inventing them. If `interaction-prd.json` already exists, do not initialize over it. The initializer creates the review workspace and three bridge files under `bridge/`.

## Capture from Yogurt

1. Use `get_cowart_thinking_context` with `scope: selection` when the user selected or marked a local region; use `scope: page` for broader synthesis. When the Yogurt launcher supplies frozen shape IDs, pass that exact list through `shapeIds`; it is authoritative for this request and must not be replaced by a later shared-selection state. The launcher expands selected frames and groups before sending the list.
2. Record the returned canvas/page identity, revision, scope, and selected shape IDs in `bridge/source-packet.json`.
3. Separate direct source material, user-authored judgment, source-grounded synthesis, model inference, assumptions, and open questions. Keep the original Yogurt shape IDs for every captured item.
4. Record external URLs as references. A pasted link stays unread unless its body is already present in the active context. Never infer requirements from a URL or claim the linked page was read; ask the user for pasted text or an export when the content is needed.
5. Preserve concise excerpts and provenance. Do not copy entire copyrighted sources into the workspace.

## Build the PRD and prototype

1. Turn the captured material into shaping documents, explicitly labeling facts, assumptions, conflicts, open decisions, and out-of-scope items.
2. Define canvas zones and a module/page plan. Each zone should have one purpose and stable `zoneId` so the same conceptual region can be returned to Yogurt.
3. Author module PRDs with stable requirement IDs and self-contained interactive HTML prototypes. Model the main path plus applicable empty, loading, validation, service-error, unauthorized, and completion states.
4. Bind each important visual annotation to one unique `data-annotation-anchor`. Keep percentage coordinates only as a compatibility fallback.
5. Maintain `bridge/trace-map.json` while authoring. Each mapping connects source IDs and Yogurt shape IDs to zones, requirements, pages, annotations, and any shapes later returned to Yogurt.
6. Do not generate a semantic line diagram or register semantic SVG as a Product Bridge document/page. If the user asks for both capabilities, finish this workspace independently; the separate canvas-diagram workflow must read the same frozen source scope and write only to the Yogurt canvas.
7. Run:

```powershell
python "<skill-dir>/scripts/validate_workspace.py" "<project-dir>" --strict
python "<skill-dir>/scripts/serve.py" "<project-dir>"
```

Verify both “文档与原型” and “页面关系”. The latter is only the prototype-page navigation view, not a Yogurt semantic line diagram. Repair missing anchors, broken paths, clipped layouts, stale mappings, and unsupported source claims before handoff.

## Return to Yogurt safely

1. Re-read the current Yogurt context immediately before planning the return. Compare its revision with `bridge/sync-state.json` and the captured source revision.
2. Build the smallest operation list that adds or updates the intended product zones. Use typed `create_zone` operations with `purpose: "product"` for new zones and `update_zone` for an existing shape ID or stable zone key. Give each card that belongs inside a zone the zone's stable key or shape ID as `parentZoneId`; this makes it a real frame child rather than a visually overlapping page card. Keep creation keys unique within the batch. Preserve user-authored shapes and unrelated canvas regions. Prefer cards and relations inside zones for product structure; use `insert_cowart_html_draft` when an editable prototype or structured HTML view is materially useful.
3. Put only the supported trace subset in each zone operation's `bridge` field: `mappingId`, `workspaceId`, `sourceIds`, `yogurtShapeIds`, `zoneId`, `requirementIds`, `pageIds`, `annotationRefs`, `returnedShapeIds`, and `lastSyncedRevision`. Do not send arbitrary workspace JSON as canvas metadata.
4. Call `apply_cowart_thinking_operations` with `dryRun: true` and the current revision. Store the preview's `baseRevision`, a stable digest of the exact operation list, and the proposed mapping updates in `bridge/sync-state.json`.
5. Show the user what will be created, changed, or linked. Do not apply until the user explicitly confirms that preview.
6. After confirmation, apply the identical operation list against the preview's `baseRevision`. If the revision changed, discard the stale preview, re-read context, recompute, and ask for confirmation again.
7. Store the returned operation ID and applied revision, then update `trace-map.json` with returned Yogurt shape IDs. Use `undo_cowart_thinking_operation` for a requested rollback; do not bypass stale-undo protection.

Never write raw tldraw records, replace a full snapshot, silently approve inferred scope, or use a prior confirmation for a materially different operation list.

## Handoff

Report the workspace path and launch command, captured source/access status, completed modules and states, assumptions and open decisions, validation performed, and synchronization status. If no return was applied, say whether it is unplanned, awaiting preview confirmation, stale, or blocked by access/revision conflict.
