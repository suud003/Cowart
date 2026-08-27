---
name: cowart-auto-compose
description: Orchestrate one mixed Yogurt AI requirement into a reference-first canvas composition. Use when a request combines scenes or visual assets with flows, relationships, systems, constraints, evidence, or questions; when the user wants Yogurt AI to decide what becomes an image versus an editable line diagram; or when the user wants one master reference image followed by visually consistent parts and native editable canvas structure.
---

# Yogurt AI Auto Compose

Turn one mixed requirement into a coherent Yogurt AI canvas without forcing every idea into the same representation. Generate one overall visual reference first when pixels add value, then use that approved reference to guide the separate image assets while rebuilding structure as native editable canvas objects.

Before routing or executing, read [references/routing-contract.md](references/routing-contract.md). It defines the block schema, routing tests, reference-image contract, layout zones, trace fields, and completion checks.

## Preserve the source scope

1. Call `get_cowart_thinking_context` with the frozen page or selection supplied by the Agent task. Use `scope: selection` when objects are selected and `scope: page` otherwise.
2. Keep the user's request, source-shape IDs, source IDs, page ID, revision, and any selected image asset metadata. Do not rely on screenshot coordinates.
3. Separate direct material, user judgment, source-grounded synthesis, model inference, assumptions, and open questions before routing.
4. Assign one stable, bounded `compositionId` and one stable, bounded block ID to every routed requirement fragment using the deterministic canonical-JSON hash rules in the routing contract. Preserve those IDs through preview, reference generation, execution, revision, and reporting.

## Build the route plan

Route every meaningful block to exactly one primary output:

- `visual`: a scene, character, environment, mood, illustration, texture, or other asset where pixels carry the intended value;
- `diagram`: a flow, hierarchy, state, dependency, architecture, decision, comparison, or relationship that must remain editable;
- `evidence`: an exact requirement, constraint, quote, citation, metric, risk, or assumption that should stay readable and traceable;
- `question`: missing information whose answer would materially change the route or result.

Do not infer a diagram's facts from visual style. Do not put precise requirements into generated image text. Do not create a PRD workspace unless the user explicitly asks for one.

Present a concise route preview with block ID, source, route, planned output, target zone, and any inference. If ambiguity would materially change a block's primary route, ask one short question before generating.

## Phase 1: create the reference

Only create a master reference when at least one block routes to `visual`.

1. When the user selects or supplies an existing reference image, resolve its verified local path with `get_cowart_selection` and `read_cowart_page_asset`, then delegate `$cowart-image-gen` in auto-compose caller mode to insert one managed reference copy carrying this composition's bounded `reference` metadata. Preserve the user's original image unchanged. The managed copy, not the unmodified source image, becomes the approved `referenceShapeId` used by derived images.
2. Otherwise delegate the reference to `$cowart-image-gen` in auto-compose caller mode. Supply the composition ID, `role: "reference"`, source shape IDs, page, placement intent, and reference brief. That skill is the only owner of generation, visual inspection, dry-run insertion, and final insertion; do not call `insert_cowart_image` a second time here. The reference should establish art direction, palette, lighting, composition rhythm, and approximate placement of the routed regions. Keep it low-text: no long copy, exact requirements, labels that must be correct, or final diagram semantics.
3. Require `$cowart-image-gen` to return the verified `assetFile`, inserted image shape ID, page ID, `baseRevision`, and result revision. Confirm that the returned shape carries bounded `reference` trace metadata and is not a stale asset.
4. Require the returned managed reference to be placed near the source scope as a normal image, not as a substitute for the final editable content.
5. Mark the plan as `reference-review`, then always stop after reporting the route preview and managed reference. Ask the user to approve it or request a revision before generating the derived parts. Use the host's confirmation surface when available; otherwise end the turn with one clear confirmation request. Never fan out a newly inserted reference in the same turn, even when the user previously asked to skip review. Approval is valid only when a user message or elicitation response arrives after this `reference-review` in the same Agent thread and identifies the current composition ID plus the exact managed reference shape/path. A prior request to “use this image,” silence, or a generic earlier approval is not approval of the inserted reference.

If there is no `visual` block, skip the bitmap reference rather than inventing one. Show the route preview and proceed with the native structure only when that is already authorized.

## Phase 2: fan out from the approved reference

After the user approves the reference:

1. Re-read the Yogurt context and confirm the managed reference shape, page, composition ID, and revision are still current. When `frozenSourceShapeIds.length + 1 <= 250`, request one exact `scope: "selection"` read with `shapeIds: [...frozenSourceShapeIds, referenceShapeId]`. At the 250-source boundary, keep the exact frozen-source read and issue a second exact selection read with `shapeIds: [referenceShapeId]`; require both reads to report the same revision and page. If they differ, repeat both exact reads once. If the retry still differs, mark the plan `stale`, stop without writing, report that the canvas changed during resume, and ask the user to retry from the fresh canvas state. Never loop and never fall back to a truncated page scan to find the later reference. A source-only frozen selection will not automatically include it. Treat compact auto-compose metadata only as a candidate index: resolve the exact image again with `read_cowart_page_asset`, confirm the asset is a readable page-local image on the same page, and never accept a metadata-only or cross-page match. If explicit approval of the current composition and exact managed shape/path is not recorded after its `reference-review` in the same Agent thread, ask again. If the reference changed or disappeared, stop and ask whether to use the revised image.
2. Reconstruct the deterministic route plan from the original task, the prior route preview, and the frozen source context. Preserve unchanged block IDs. If the original preview is unavailable or cannot be matched without guessing, show the reconstructed preview and ask for confirmation before applying it.
3. Delegate each `visual` block once to `$cowart-image-gen` in auto-compose caller mode. Pass the verified master `assetFile`, composition ID, block ID, `role: "visual-part"`, reference shape ID, source shape IDs, page, and placement intent. `$cowart-image-gen` remains the only insertion owner and must return the created shape and revision trace; do not insert the same result again.
4. Build every `diagram` block through `$cowart-semantic-diagram` in native-only mode, using editable cards, semantic zones, and bound relations. Do not use that skill's HTML + inline-SVG fallback inside auto-compose. If one dense structure cannot be expressed safely with native objects, split it into multiple native diagrams or ask the user to choose a simplification; never silently downgrade editability. Use the contract's bounded `semanticDiagram.diagramId` and retain source shape IDs and source IDs through the semantic contract. The approved reference may guide placement, spacing, and visual rhythm only. The user's request and traceable sources remain the semantic source of truth. Never rasterize the diagram or trace generated pixels into unsupported facts.
5. Build `evidence` and resolved `question` blocks through `$cowart-thinking-agent` as source-linked cards. Use the contract's bounded evidence operation `key`. Map provenance only through fields accepted by `create_card`: put the stable primary identity in `source.id`, at most 100 canvas sources in `source.yogurtShapeIds`, and at most 50 external/source identifiers in `sourceRefs`. Apply the routing contract's deterministic ordering and overflow digest before calling the tool; never rely on schema rejection or silent truncation. Do not send unsupported top-level `sourceShapeIds` or `sourceIds`. Keep exact constraints beside the visual or diagram block they govern.
6. Arrange the result as one composition with distinct `视觉参考`, `视觉素材`, `结构与流程`, and `证据与约束` regions when those regions exist. Anchor the composition beside the original scope and preserve unrelated or user-authored shapes.

Do not use one broad raw tldraw snapshot write. Use the typed Yogurt operations, preview revisions, and atomic apply contracts of the delegated skills.

## Finish and report

Verify that:

- every planned block has one primary route and a visible result or explicit pending state;
- every derived visual used the approved reference path rather than prompt-only imitation;
- every semantic object is individually editable and every non-root diagram object has the intended bound relation;
- exact facts remain in cards or native text, not baked into the reference image;
- source material and unrelated canvas regions remain intact;
- image results preserve bounded auto-compose metadata; native diagrams preserve their bounded semantic diagram/object/relation IDs; evidence cards preserve bounded operation keys plus `source.id`, `source.yogurtShapeIds`, and `sourceRefs` trace.

Report the composition ID, approved reference shape and asset path, route summary, created image shape IDs, semantic operation IDs, source scope, inference introduced, and any block still awaiting confirmation.
