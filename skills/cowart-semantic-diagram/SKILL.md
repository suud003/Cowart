---
name: cowart-semantic-diagram
description: Create or revise traceable semantic diagrams in Yogurt AI, routing simple editable graphs to native cards and relations while using safe inline SVG HTML drafts for precise layouts, ports, swimlanes, containment, or interface wireframes. Use when the user asks Yogurt to draw, organize, visualize, or round-trip product and system relationships; do not use for bitmap illustration or decorative artwork.
---

# Yogurt Semantic Diagram

Turn source-grounded ideas into diagrams that remain understandable, editable, and traceable in Yogurt AI. Preserve the user's material and change only the intended page or selection.

## Choose the representation

Use **native Yogurt cards and relations** when the diagram is primarily a thinking graph: a hierarchy, a small flow, a claim-evidence map, or another composition whose objects should remain individually selectable and editable on the canvas. Prefer this route when Yogurt's automatic card layout can express the reading order without manual coordinates.

Use an **HTML draft with one inline semantic SVG** when meaning depends on precise geometry: explicit connection ports, parallel lanes, swimlanes, nested containment, same-scale comparison, GUI/LUI wireframes, or a dense relation layout that native cards cannot render unambiguously.

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

Build one connected operation batch with typed card, zone, and relation operations. Omit coordinates when Yogurt's connected-card layout is sufficient; use coordinates only to preserve or extend an existing composition.

Call apply_cowart_thinking_operations with dryRun true and the captured revision. Verify that every non-root card has the intended relation and that only the selected region changes. Apply the identical operation list against the preview's baseRevision. If the revision changed, discard the preview, re-read context, and recompute.

Use native relation labels only when the verb carries meaning not already clear from the hierarchy. Keep source-shape IDs and semantic IDs in supported operation metadata or the surrounding zone bridge fields; never write raw tldraw records.

## HTML inline-SVG route

Create a self-contained HTML document containing exactly one semantic SVG. The document must include two inert, machine-readable siblings:

~~~html
<template data-cowart-diagram-spec type="application/json">{"schemaVersion":"1","diagramId":"checkout-flow"}</template>
<template data-cowart-diagram-prompt type="application/json">{"schemaVersion":"1","diagramId":"checkout-flow","prompt":"Rebuild the source-grounded checkout flow using the embedded specification."}</template>
~~~

The real templates must contain the complete contract described in the reference. JSON-escape the less-than character as \u003c before embedding so source text cannot close a template. Keep the prompt synchronized with the final diagram rather than preserving abandoned layout attempts.

Apply the relation grammar and route every directional line between explicit object-boundary ports. Allocate group boundaries, label zones, and relation lanes before drawing objects. Do not use a visually detached arrow as though it were a connected edge.

Validate the finished HTML with:

~~~powershell
node "<skill-dir>/scripts/validate-semantic-svg.mjs" --root "<artifact-root>" "<diagram.html>"
~~~

The validator also supports --stdin when the caller can safely stream markup without creating a file. It is a structural and security check, not a substitute for real-canvas geometry or screenshot review.

Call insert_cowart_html_draft with dryRun true, an anchor shape when the source is local, and dimensions appropriate to the existing canvas region. Review the planned placement, then repeat the exact content, placement, and semanticDiagram payload with dryRun false and the returned baseRevision. If the revision changed, re-read context and recompute instead of forcing the insertion. To revise an existing artifact, target its draftShapeId and set updateExistingDraft true; do not create a duplicate beside it.

## Verify the rendered result

Check the actual Yogurt viewport, not only the source markup:

- every object, relation, state, label, and color has a semantic reason;
- peer alignment and safe gaps satisfy the embedded layout contract;
- each edge leaves the source boundary, follows one continuous route, and lands its arrow tip on the target boundary;
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
