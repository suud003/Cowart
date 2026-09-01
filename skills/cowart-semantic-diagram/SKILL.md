---
name: cowart-semantic-diagram
description: Create or revise source-traceable, Excalidraw-style diagrams directly on the Yogurt AI canvas as native editable cards, semantic zones, text, and bound relations using html-line-svg's semantic and layout grammar. Never rasterize the diagram or turn it into HTML, SVG, Product Bridge, or PRD output.
---

# Yogurt Semantic Diagram

Turn source-grounded ideas into diagrams that remain understandable, editable, and traceable in Yogurt AI. Preserve the user's material and change only the intended page or selection. This is a first-class canvas capability; do not create or modify an Interaction PRD workspace.

## Representation contract

Always use **native Yogurt cards, short semantic frames, editable text, and bound relations** for flows, hierarchies, state maps, architecture summaries, comparisons, claim-evidence maps, and board-to-peers compositions. Every visible object must remain individually selectable, movable, resizable, editable, deletable, and reconnectable. Express containment through real frame parentage and comparison through peer alignment, not fake arrows.

Never turn a semantic diagram into a bitmap, full-page preview, HTML draft, inline SVG, Slides deck, Product Bridge, or PRD workspace. If one graph would become too dense, split it into adjacent native diagrams with one teaching claim each. Do not shrink text, stack nodes, or create a large empty frame to force everything into one artifact.

## Capture context and write the semantic plan

1. Call get_cowart_thinking_context. Use scope selection for a marked region and scope page for a page-level synthesis. Preserve any frozen shape IDs supplied by the Yogurt launcher.
2. Record canvas ID, page ID, revision, scope, and source shape IDs. Separate source material, user judgment, source-grounded synthesis, inference, assumptions, and open questions.
3. State one diagram claim: the single judgment the composition must make legible.
4. Define stable object and relation IDs, visible labels, origin, source-shape mappings, relation type and direction, layout profile, reading order, and special states. Do not add an arrow for a relationship the material does not support.
5. Inventory nearby titles and labels. Remove repeated text before laying out the diagram.

## Native-card route

Build one connected operation batch with typed card, zone, and relation operations. For a new diagram, omit coordinates so Yogurt can apply SCC-aware layers, peer alignment, label-aware safe gaps, and the requested reading order. Use explicit coordinates only when a repair requires a specific composition. User-authored or unmanaged siblings remain fixed; managed nodes in the same diagram may shift together to preserve reading order, and automatic placement must never overlap a fixed sibling. Use `purpose: "semantic"` for short grouping frames.

Pass a batch-level `semanticDiagram` contract with `version: "1"`, a stable `diagramId`, the teaching claim, diagram type, reading order, `layoutEngine: "html-line-svg"`, `layoutMode: "balanced" | "compact"`, `layoutFit: "fixed" | "grow"`, source shape/source IDs, full-diagram object/relation counts, and an optional spec digest. Use `fixed` for an auto-compose slot and `grow` for an unconstrained standalone diagram. Counts are derived for an initial creation batch; provide the complete counts when repairing or extending an existing diagram. Keep the frame name short; when the teaching claim must be visible, create one concise wrap-capable claim card instead of concatenating the full claim into the single-line frame title. Give every new card or zone a stable `semantic.id`, object type, visible state, origin, reading order, and source-shape mappings. Give every relation a stable `semanticId`, semantic `kind`, `direction`, `path`, optional payload, lane, `origin`, `sourceShapeIds`, and `sourceIds`.

Keep a standalone diagram to at most 12 nodes whenever possible. A legacy fixed auto-compose slot remains bounded to at most 8 nodes and 10 relations; split denser material into adjacent native diagrams instead of compressing it.

Use the relation grammar directly in native operations:

- primary directional flow: `direction: "forward"`, `path: "primary"`;
- alternative flow: `direction: "forward"`, `path: "alternative"`, plus a visible label or payload;
- synchronization: `direction: "bidirectional"`;
- association: `direction: "none"`;
- containment: `parentZoneId`, not a relation;
- comparison: aligned peers, not a relation.

The canvas engine derives color, dash, arrowheads, boundary anchors, and parallel lanes from those semantics. Do not override semantic relation styling with arbitrary color or dash values.

Use the Excalidraw-style visual contract throughout:

- cards use `geo: "cowart-card"`, `dash: "draw"`, `font: "draw"`, `size: "s"`, and are unlocked;
- default card fill is transparent; use `fill: "hachure"` only for a small number of meaningful emphasized nodes, never as decoration;
- primary and unlabelled relations are neutral black `draw` strokes; alternatives are `dashed`;
- warning and blocked states may use restrained orange or red; do not assign a different color to every category;
- use short visible labels and place detail in the card body so text never spills outside the node.

Call `apply_cowart_safe_thinking_operations` with `dryRun: true` and the captured revision. Require a matching `layoutReport` whose `engine` is `html-line-svg`, `layoutReport.valid` is true, `collisions` and `outOfBounds` are empty, and `layoutDigest` is present. Validate the real node/edge bounds returned by that dry run, not guessed placeholder geometry. Verify that every non-root card has the intended relation and that only the selected region changes. Apply the identical operation list through the same safe tool against the preview's `baseRevision`, then require the same layout digest. If the revision changed or the digest differs, discard the preview, re-read context, and recompute. The safe tool may update, move, or resize only Cowart-managed shapes and cannot accept `delete_shape` or `allowUserAuthoredEdits`.

Use native relation labels only when the verb carries meaning not already clear from the hierarchy. Keep source-shape IDs and semantic IDs in the native semantic metadata; do not borrow Product Bridge zone/trace fields. Never write raw tldraw records.

To revise card or zone semantics, use the restricted `semantic` patch on `update_card` or `update_zone`; keep `diagramId` and `semanticId` stable and change only type, state, origin, order, or source mappings. To revise a relation's direction, path, lane, label, payload, provenance, or endpoints, explicit deletion is required because there is no `update_relation` operation. Obtain explicit user authorization, then use the destructive `apply_cowart_thinking_operations` entry point with `delete_shape` before `create_relation` and reuse the stable relation `semanticId`. Never route that replacement through autonomous safe execution.

## Verify the rendered result

Check the actual Yogurt viewport, not only the source markup:

- every object, relation, state, label, and color has a semantic reason;
- peer alignment and safe gaps satisfy the embedded layout contract;
- each edge leaves the source boundary, follows one continuous route, and lands its arrow tip on the target boundary; after UI reconnection, the real start/end bindings remain authoritative;
- lines do not cross unrelated objects or text, and parallel routes do not visually merge;
- containment labels have their own safe zone and inner objects remain within the outer boundary;
- title, description, reading order, font size, clipping, and narrow-view behavior remain usable;
- each card keeps its current live rich text when a later Agent update changes only color, state, or provenance;
- saving and reopening preserves rich text, frame parentage, semantic IDs, arrow bindings, and style props.

If the geometry is ambiguous, reassign ports, separate lanes, use a monotonic Bezier route, or split the diagram. Do not preserve a dense network merely because the markup validates.

## Revise and report

When revising an existing generated diagram, match objects by stable semantic IDs instead of recreating the whole graph. Keep manually edited rich text and user-positioned nodes unless the user explicitly asks to rewrite or relayout them. Use the smallest safe native operation batch; do not replace an editable graph with a new image or monolithic object.

Report the diagram claim, source scope and access limitations, affected native shape/relation IDs, validation performed, inference introduced, and the operation ID available for undo.
