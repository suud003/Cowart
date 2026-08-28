---
name: cowart-auto-compose
description: Orchestrate one mixed Yogurt AI requirement into a layout-blueprint-first canvas composition. Use when a request combines visual assets with flows, relationships, systems, constraints, evidence, or questions; when the user wants Yogurt AI to decide what becomes an image versus an editable line diagram; or when the user wants one full-canvas page layout approved before each part is generated and placed.
---

# Yogurt AI Auto Compose

Turn one mixed requirement into a coherent Yogurt AI page without forcing every idea into the same representation. First create a structured page layout plan and a human-reviewable whole-page layout blueprint. After approval, generate each image, native editable diagram, and evidence card into its planned slot.

Before acting, read [references/routing-contract.md](references/routing-contract.md). It defines block routing, layout-plan invariants, the blueprint contract, confirmation binding, trace fields, and completion checks.

## Preserve the source scope

1. Call `get_cowart_thinking_context` with the frozen page or selection from the Agent task. Use `scope: selection` when objects are selected and `scope: page` otherwise.
2. Keep the user's request, source-shape IDs, source IDs, page ID, revision, and selected image asset metadata. Do not rely on screenshot coordinates.
3. Separate direct material, user judgment, source-grounded synthesis, model inference, assumptions, and open questions before routing.
4. Assign one stable bounded `compositionId` and one stable bounded block ID to every routed fragment with the canonical-JSON hash rules in the routing contract. Preserve them through preview, blueprint generation, execution, revision, and reporting.

## Build the route and layout plan

Route every meaningful block to exactly one primary output:

- `visual`: scene, character, environment, mood, illustration, texture, or another asset where pixels carry the value;
- `diagram`: flow, hierarchy, state, dependency, architecture, decision, comparison, or relationship that must remain editable;
- `evidence`: exact requirement, constraint, quote, citation, metric, risk, or assumption that must stay readable and traceable;
- `question`: missing information whose answer would materially change the route or result.

Do not infer diagram facts from visual style. Do not put precise requirements into generated image text. Do not create a PRD workspace unless the user explicitly asks for one.

Then create the structured `layoutPlan` before generating any bitmap:

1. Use the contract's 1600 x 1000 local page frame.
2. Assign every executable block exactly one non-overflowing slot with block ID, route, region, integer bounds, order, and fit mode.
3. Plan the whole page: relative size, hierarchy, whitespace, reading order, and how image, diagram, and evidence regions work together.
4. Canonicalize the complete plan and compute the 64-character `layoutPlanDigest`.
5. Present a concise route-and-layout preview with block ID, source, route, slot bounds, order, planned output, and any inference. Ask one short question only when ambiguity would materially change a route or page structure.

## Phase 1: create the full-canvas layout blueprint

Every mixed auto-compose task gets one blueprint, including diagram-plus-evidence tasks with no visual asset.

1. Delegate `$cowart-image-gen` in auto-compose caller mode with the full structured layout plan, digest, composition ID, `role: "layout-reference"`, source shape IDs, page, placement intent, and a blueprint brief.
2. Require a whole-page layout mock that visibly includes the page boundary and every planned slot. It should show region hierarchy, relative sizes, whitespace, and reading order with minimal placeholder text. It must not be a single concept image, cinematic scene, character sheet, moodboard, key art, or poster.
3. A user-supplied concept image may be passed as optional style material for a visual slot, but it cannot be copied and relabeled as the blueprint. Reuse an existing image as the managed blueprint only when visual inspection proves it is a whole-page mock matching every current slot.
4. `$cowart-image-gen` owns generation, visual validation, dry-run insertion, and final insertion. Do not call `insert_cowart_image` again. Require it to compare the bitmap with the structured plan, retry at most once when regions are missing, and return the verified `assetFile`, shape ID, page ID, dry-run `baseRevision`, result revision, dimensions, and placement.
5. Confirm that the returned shape carries version 2 `layout-reference` lineage with the exact layout digest and is not stale.
6. Mark the plan `layout-reference-review`, show the route-and-layout preview, and stop. Ask the user to approve the page partition, proportions, hierarchy, and reading order or request a revision.

Approval is valid only when a user message or elicitation response arrives after this review in the same Agent thread and identifies the current `compositionId + layoutPlanDigest + exact shapeId + assetFile`. A prior request, silence, or generic earlier approval is not approval. Never fan out a newly inserted blueprint in the same turn.

## Phase 2: generate and place the approved parts

After explicit approval:

1. Re-read the frozen sources and exact blueprint shape. When `frozenSourceShapeIds.length + 1 <= 250`, use one exact selection read with `shapeIds: [...frozenSourceShapeIds, referenceShapeId]`. At the 250-source boundary, read frozen sources and `[referenceShapeId]` separately and require the same page and revision. If they differ, repeat both exact reads once. If the retry still differs, mark `stale`, stop without writing, and ask the user to retry. Never loop or fall back to a truncated page scan.
2. Treat compact lineage only as a candidate index. Resolve the exact image with `read_cowart_page_asset`, require a readable same-page local `layout-reference`, and verify composition ID and layout digest.
3. Reconstruct the deterministic route and layout plan from the original task, prior preview, and frozen context. Recompute the digest. If the preview is unavailable, IDs cannot be matched, or the digest differs, show a fresh layout preview and return to Phase 1; never infer slots from blueprint pixels or OCR.
4. Delegate each `visual` block once to `$cowart-image-gen` in auto-compose caller mode. Pass the approved blueprint path, digest, block ID, exact slot bounds/aspect ratio, `role: "visual-part"`, reference shape ID, source IDs, page, and placement intent. The blueprint controls target slot and crop only: do not reproduce its placeholder borders, labels, or page chrome. Use the original brief or explicit user style material for visual art direction.
5. Build each `diagram` block through `$cowart-semantic-diagram` in native-only mode. Pass its approved slot bounds and reading order. Use editable cards, semantic zones, and bound relations. If a dense structure cannot fit safely, stop and ask for a plan revision; never overflow or silently rasterize it. The request and traceable sources are the semantic truth.
6. Build `evidence` and resolved `question` blocks through `$cowart-thinking-agent` as source-linked cards inside their approved slots. Use the bounded evidence key, `source.id`, up to 100 `source.yogurtShapeIds`, and up to 50 `sourceRefs`, with deterministic overflow reporting from the contract.
7. Map the approved 1600 x 1000 local frame beside the original scope. Use typed create/move/resize operations and delegated placement contracts so every result lands in its slot. Preserve unrelated and user-authored shapes.
8. Keep the blueprint in a distinct `布局参考` region beside the generated `视觉素材`, `结构与流程`, and `证据与约束` regions required by the plan.

Do not use one broad raw tldraw snapshot write. Use typed Yogurt operations, preview revisions, and atomic apply contracts.

## Finish and report

Verify that:

- every executable block has exactly one approved slot and one visible result or explicit pending state;
- the final geometry follows the structured plan rather than the blueprint pixels;
- every derived image uses the planned slot ratio and carries matching version 2 composition/digest lineage;
- every semantic object remains individually editable and every non-root diagram object has its intended bound relation;
- exact facts remain in native text or cards, never baked into or inferred from the blueprint;
- source material and unrelated canvas regions remain intact;
- the result stays within the approved page frame with readable text and no clipped overflow.

Report the composition ID, layout digest, approved blueprint shape and asset path, route-and-slot summary, created image shape IDs, semantic operation IDs, source scope, inference introduced, and any block still awaiting confirmation.
