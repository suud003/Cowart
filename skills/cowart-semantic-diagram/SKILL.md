---
name: cowart-semantic-diagram
description: Create or revise source-traceable semantic diagrams directly on the Yogurt AI canvas. Default to native editable cards, semantic zones, and bound relations using html-line-svg's semantic and layout grammar; use safe inline-SVG canvas blocks only when exact geometry cannot be expressed natively. Never make the diagram a Product Bridge or PRD page.
---

# Yogurt Semantic Diagram

Turn source-grounded ideas into diagrams that remain understandable, editable, and traceable in Yogurt AI. Preserve the user's material and change only the intended page or selection. This is a first-class canvas capability; do not create or modify an Interaction PRD workspace.

## Choose the representation

Use **native Yogurt cards, semantic zones, and relations by default**, including flows, hierarchies, state maps, architecture summaries, comparisons, claim-evidence maps, and board-to-peers compositions. Native objects remain individually selectable and editable and carry stable semantic/source metadata. Express containment through real frame parentage and comparison through peer alignment, not fake arrows.

Use an **HTML draft with one inline semantic SVG only as a canvas-level precision route** when the user explicitly requests SVG or when meaning depends on geometry the native canvas cannot render unambiguously: dense obstacle routing, exact multi-port topology, detailed swimlanes, or GUI/LUI wireframes. The HTML draft is one scalable object on the current Yogurt page; it is never a PRD document or prototype page.

Use a **hybrid** only when both representations add distinct value. Keep a small native summary or zone as the editable index and put the detailed SVG in one anchored HTML draft; do not duplicate the entire graph in both forms.

Do not turn a semantic diagram into a bitmap. Route illustrative or decorative image requests to the Yogurt image skills.

Before authoring or revising an HTML diagram, read [references/diagram-contract.md](references/diagram-contract.md). It defines the semantic model, relation grammar, HTML envelope, layout and port rules, trace fields, and validator contract.

## Capture context and write the semantic plan

1. Call get_cowart_thinking_context. Use scope selection for a marked region and scope page for a page-level synthesis. Preserve any frozen shape IDs supplied by the Yogurt launcher.
2. Record canvas ID, page ID, revision, scope, and source shape IDs. Separate source material, user judgment, source-grounded synthesis, inference, assumptions, and open questions.
3. State one diagram claim: the single judgment the composition must make legible.
4. Define stable object and relation IDs, visible labels, origin, source-shape mappings, relation type and direction, layout profile, reading order, and special states. Do not add an arrow for a relationship the material does not support.
5. Inventory nearby titles and labels. Remove repeated text before laying out the diagram.

## Native-card route

Build one connected operation batch with typed card, zone, and relation operations. For a new diagram, omit coordinates so Yogurt can apply SCC-aware layers, peer alignment, label-aware safe gaps, and the requested reading order. Use explicit coordinates only when a repair requires a specific composition. User-authored or unmanaged siblings remain fixed; managed nodes in the same diagram may shift together to preserve reading order, and automatic placement must never overlap a fixed sibling. Use `purpose: "semantic"` for grouping zones.

Pass a batch-level `semanticDiagram` contract with `version: "1"`, a stable `diagramId`, the teaching claim, diagram type, reading order, source shape/source IDs, full-diagram object/relation counts, and an optional spec digest. Counts are derived for an initial creation batch; provide the complete counts when repairing or extending an existing diagram. The semantic-zone title must keep the teaching claim visible on the canvas, not only in metadata. Give every new card or zone a stable `semantic.id`, object type, visible state, origin, reading order, and source-shape mappings. Give every relation a stable `semanticId`, semantic `kind`, `direction`, `path`, optional payload, lane, `origin`, `sourceShapeIds`, and `sourceIds`.

Use the relation grammar directly in native operations:

- primary directional flow: `direction: "forward"`, `path: "primary"`;
- alternative flow: `direction: "forward"`, `path: "alternative"`, plus a visible label or payload;
- synchronization: `direction: "bidirectional"`;
- association: `direction: "none"`;
- containment: `parentZoneId`, not a relation;
- comparison: aligned peers, not a relation.

The canvas engine derives color, dash, arrowheads, boundary anchors, and parallel lanes from those semantics. Do not override semantic relation styling with arbitrary color or dash values.

Call apply_cowart_thinking_operations with dryRun true and the captured revision. Verify that every non-root card has the intended relation and that only the selected region changes. Apply the identical operation list against the preview's baseRevision. If the revision changed, discard the preview, re-read context, and recompute.

Use native relation labels only when the verb carries meaning not already clear from the hierarchy. Keep source-shape IDs and semantic IDs in the native semantic metadata; do not borrow Product Bridge zone/trace fields. Never write raw tldraw records.

To revise card or zone semantics, use the restricted `semantic` patch on `update_card` or `update_zone`; keep `diagramId` and `semanticId` stable and change only type, state, origin, order, or source mappings. To revise a relation's direction, path, lane, label, payload, provenance, or endpoints, put `delete_shape` before `create_relation` in the same semantic batch and reuse the stable relation `semanticId`. There is no `update_relation` operation.

## HTML inline-SVG route

Create a self-contained HTML document containing exactly one semantic SVG. The document must include two inert, machine-readable siblings:

~~~html
<template data-cowart-diagram-spec type="application/json">{"schemaVersion":"1","diagramId":"checkout-flow"}</template>
<template data-cowart-diagram-prompt type="application/json">{"schemaVersion":"1","diagramId":"checkout-flow","prompt":"Rebuild the source-grounded checkout flow using the embedded specification."}</template>
~~~

The real templates must contain the complete contract described in the reference. JSON-escape the less-than character as \u003c before embedding so source text cannot close a template. Keep the prompt synchronized with the final diagram rather than preserving abandoned layout attempts.

Apply the relation grammar and route every directional line between explicit object-boundary ports. Allocate group boundaries, label zones, and relation lanes before drawing objects. Bake visible coordinates into the SVG instead of using `transform`. Size the root viewBox from all nodes, labels, strokes, markers, and true line/Bezier extrema, with an outer inset of at least 2% of the shorter viewBox dimension. Do not use a visually detached arrow as though it were a connected edge.

Validate the finished HTML with:

~~~powershell
node "<skill-dir>/scripts/validate-semantic-svg.mjs" --root "<artifact-root>" "<diagram.html>"
~~~

The validator also supports --stdin when the caller can safely stream markup without creating a file. It rejects static geometry that exceeds the padded viewBox, but it is not a substitute for collision checks, real-canvas geometry, or screenshot review.

Call insert_cowart_html_draft with dryRun true, an anchor shape when the source is local, and dimensions appropriate to the existing canvas region. Review the planned placement, then repeat the exact content, placement, and semanticDiagram payload with dryRun false and the returned baseRevision. If the revision changed, re-read context and recompute instead of forcing the insertion. To revise an existing artifact, target its draftShapeId and set updateExistingDraft true; do not create a duplicate beside it.

## Verify the rendered result

Check the actual Yogurt viewport, not only the source markup:

- every object, relation, state, label, and color has a semantic reason;
- peer alignment and safe gaps satisfy the embedded layout contract;
- each edge leaves the source boundary, follows one continuous route, and lands its arrow tip on the target boundary; after UI reconnection, the real start/end bindings remain authoritative;
- lines do not cross unrelated objects or text, and parallel routes do not visually merge;
- containment labels have their own safe zone and inner objects remain within the outer boundary;
- title, description, reading order, font size, clipping, and narrow-view behavior remain usable;
- the source context is still understandable without seeing the SVG.

If the geometry is ambiguous, reassign ports, separate lanes, use a monotonic Bezier route, or split the diagram. Do not preserve a dense network merely because the markup validates.

## Trace and write back

Treat the specification template as the round-trip source of truth and the SVG as its rendering. Preserve unknown fields when revising it.

When the user asks to turn an HTML diagram back into native Yogurt structure:

1. Read the current HTML draft and parse both templates; do not reconstruct semantics from pixels alone.
2. Call get_cowart_thinking_context again and compare the current revision with trace.sourceRevision and trace.lastAppliedRevision.
3. Build the smallest native-card operation list from the stable semantic IDs and mappings. Preserve user-authored shapes and unrelated regions.
4. Preview with apply_cowart_thinking_operations and show which objects and relations will be created or updated. Require explicit confirmation before overwriting user-authored content or applying a materially changed return plan.
5. Apply the identical operations against the preview revision. On success, update the existing HTML draft through insert_cowart_html_draft so its spec records returned shape IDs, operation IDs, and the applied revision. If the canvas revision is stale, recompute instead of forcing the write.

Report the chosen representation, diagram claim, source scope and access limitations, artifact or operation IDs, validation performed, inference introduced, and whether any return is applied, awaiting confirmation, or stale.
