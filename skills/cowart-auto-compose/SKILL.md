---
name: cowart-auto-compose
description: Orchestrate one mixed Yogurt AI requirement through a near-final full-page visual preview into stable canvas parts. Use when a request combines visual assets with flows, relationships, systems, constraints, evidence, or questions; when Yogurt AI should decide what becomes an image versus an editable diagram or source card; or when the user wants one coherent page composed before its parts are generated and placed.
---

# Yogurt AI Auto Compose

Turn one mixed requirement into a coherent Yogurt AI page without forcing every idea into the same representation. First create a structured page plan and one near-final whole-page visual preview in which the images, diagrams, cards, hierarchy, and whitespace already resemble the intended result. Then rebuild each part in its planned slot so visual assets stay consistent while diagrams and evidence remain native, editable, and traceable.

Before acting, read [references/routing-contract.md](references/routing-contract.md). It defines block routing, deterministic page-plan validation, the composition-reference contract, execution modes, trace fields, and completion checks.

## Preserve the source scope

1. Call `get_cowart_thinking_context` with the frozen page or selection from the Agent task. Use `scope: selection` when objects are selected and `scope: page` otherwise.
2. Keep the user's request, source-shape IDs, source IDs, page ID, revision, and selected image asset metadata. Do not rely on screenshot coordinates.
3. Separate direct material, user judgment, source-grounded synthesis, model inference, assumptions, and open questions before routing.
4. Assign one stable bounded `compositionId` and one stable bounded block ID to every routed fragment with the canonical-JSON hash rules in the routing contract. Preserve them through preview generation, execution, revision, and reporting.

## Build the route and composition plan

Route every meaningful block to exactly one primary output:

- `visual`: scene, character, environment, mood, illustration, texture, or another asset where pixels carry the value;
- `diagram`: flow, hierarchy, state, dependency, architecture, decision, comparison, or relationship that must remain editable;
- `evidence`: exact requirement, constraint, quote, citation, metric, risk, or assumption that must stay readable and traceable;
- `question`: missing information whose answer would materially change the route or result.

Do not infer diagram facts from visual style. Do not put precise requirements into generated image text. Do not create a PRD workspace unless the user explicitly asks for one.

Then create the structured v3 `pagePlan` before generating any bitmap:

1. Use the contract's 1600 x 1000 local page frame.
2. Assign every executable block exactly one non-overflowing slot with block ID, route, region, integer bounds, order, and fit mode.
3. Give every slot a route-specific `contentSpec`: a visual scene brief; or a diagram type, teaching claim, bounded semantic objects/relations, and short source-grounded labels; or bounded evidence cards. The preview must know what belongs inside each slot, not only where an empty box sits.
4. Reserve gutters and safe gaps, estimate native content capacity, and split an over-dense block before preview. A single native diagram slot may contain at most 8 nodes and 10 relations; an evidence slot at most 4 cards. Use a second slot or a more compact semantic summary when the source exceeds those limits.
5. Plan the whole page: relative size, hierarchy, whitespace, reading order, and how image, diagram, and evidence regions work together. Text-heavy slots may not overlap, and unrelated slots require at least 24 local units of separation.
6. Call `validate_cowart_auto_compose_plan` with exactly `{ "plan": { "schemaVersion": "3", "pagePlan": <the pagePlan above> } }`. Do not pass the surrounding execution, source, preview, or block-report fields into this strict validator. Use its normalized plan and exact 64-character `pagePlanDigest`; do not hand-wave or visually estimate overlap.
7. Present a concise route-and-layout preview with block ID, source, route, slot bounds, order, planned content, and any inference. Ask one short question only when ambiguity would change the task's core meaning or authorization boundary; otherwise record a reversible assumption.

## Phase 1: create the near-final full-page visual preview

Every mixed auto-compose task gets one composition preview, including diagram-plus-evidence tasks with no visual asset.

1. Delegate `$cowart-image-gen` in auto-compose caller mode with the normalized `pagePlan`, every `contentSpec`, digest, composition ID, `role: "composition-reference"`, source shape IDs, page, placement intent, and the chosen product visual language.
2. Require one whole-page mock that already looks broadly complete at fit-to-page zoom. Visual slots contain representative rendered scenes or assets; diagram slots contain recognizable nodes, lanes, arrows, and short grounded labels; evidence slots contain realistic card hierarchy and copy density. It must show the final page rhythm instead of empty placeholders, grey skeleton boxes, an abstract wireframe, or one cinematic concept image/poster.
3. Keep visible wording short and source-grounded. The bitmap may preview hierarchy and labels, but it remains a visual reference rather than a source of product facts. Never invent citations, issue IDs, metrics, states, or relations to make the page look finished.
4. A user-supplied concept image may guide the visual language of one or more slots, but it cannot be copied and relabeled as the whole-page preview. Reuse an existing image only when visual inspection proves it is a near-final page composition matching every current slot and `contentSpec`.
5. `$cowart-image-gen` owns generation, visual validation, dry-run insertion, and final insertion. Do not call `insert_cowart_image` again. Require it to compare every region with the plan, retry at most once when the composition is incomplete or placeholder-like, and return the verified `assetFile`, shape ID, page ID, dry-run `baseRevision`, result revision, dimensions, and placement.
6. Confirm that the returned shape carries version 3 `composition-reference` lineage with the exact page-plan digest and is not stale.
7. Follow the execution mode supplied by the Yogurt AI task envelope:
   - `guided`: mark `composition-reference-review`, show the preview, and pause once for approval of the page partition, hierarchy, density, and visual direction;
   - `autonomous`: the user's persisted panel choice declares a workflow preference to skip this product checkpoint. Mark `autonomous-executing` and continue in the same turn without an elicitation or confirmation click.

In guided mode, approval is valid only when a user message or elicitation response arrives after review in the same Agent thread and identifies the current `compositionId + pagePlanDigest + exact shapeId + assetFile`. A prior request, silence, or generic earlier approval is not approval. In autonomous mode, never reinterpret the mode as permission for external access, project-external writes, credentials, payment, deletion of user content, or another protected operation; those boundaries keep their normal approval behavior.

## Phase 2: rebuild and place the planned parts

After guided approval, or immediately in autonomous mode:

1. Re-read the frozen sources and exact composition-reference shape. When `frozenSourceShapeIds.length + 1 <= 250`, use one exact selection read with `shapeIds: [...frozenSourceShapeIds, referenceShapeId]`. At the 250-source boundary, read frozen sources and `[referenceShapeId]` separately and require the same page and revision. If they differ, repeat both exact reads once. If the retry still differs, mark `stale` and stop without writing. Never loop or fall back to a truncated page scan.
2. Treat compact lineage only as a candidate index. Resolve the exact image with `read_cowart_page_asset`, require a readable same-page local `composition-reference`, and verify composition ID and page-plan digest.
3. Reconstruct the deterministic route and page plan from the original task, prior preview, and frozen context. Revalidate it with `validate_cowart_auto_compose_plan`. If the preview is unavailable, IDs cannot be matched, or the digest differs, create a fresh composition reference and return to Phase 1; never infer slots or semantics from reference pixels or OCR.
4. Delegate each `visual` block once to `$cowart-image-gen` in auto-compose caller mode. Pass the composition-reference path, digest, block ID, exact slot bounds/aspect ratio and normalized reference window, `role: "visual-part"`, reference shape ID, source IDs, page, and placement intent. Generate only that slot's finished visual. Use the reference window for crop, palette, balance, and local composition; use the original brief and sources for meaning. Run independent visual blocks concurrently when the tool host permits instead of regenerating the whole page serially.
5. Build each `diagram` block through `$cowart-semantic-diagram` in native-only mode. Pass its slot bounds, `contentSpec`, visual-reference window, reading order, and the fixed native layout contract `layoutEngine: "html-line-svg"`, `layoutMode: "balanced"`, `layoutFit: "fixed"`. Do not hand-place its nodes. Recreate the preview's broad geometry and density with editable cards, semantic zones, and bound relations, but take every object, label, state, and relation from the shared content spec and traceable sources—not pixels or OCR.
6. Build `evidence` and resolved `question` blocks through `$cowart-thinking-agent` as source-linked cards inside their approved slots. Use the bounded evidence key, `source.id`, up to 100 `source.yogurtShapeIds`, and up to 50 `sourceRefs`, with deterministic overflow reporting from the contract.
7. Map the 1600 x 1000 local frame beside the original scope. Use typed create/move/resize operations and delegated placement contracts so every result lands in its slot. Preserve unrelated and user-authored shapes.
8. Dry-run and apply every native diagram/evidence batch through `apply_cowart_safe_thinking_operations`. This path may create objects and update, move, or resize Cowart-managed objects, but it cannot use `delete_shape` or `allowUserAuthoredEdits`. If the plan would require either protected operation, leave that block pending in autonomous mode instead of falling back to `apply_cowart_thinking_operations`; use the destructive entry point only after explicit user authorization. For every diagram require the returned `layoutReport.engine` to be `html-line-svg`, `valid` to be true, `collisions` and `outOfBounds` to be empty, and `layoutDigest` to remain identical from dry-run to apply. Require every result to stay inside its slot, every pair of unrelated objects to have a visible gap, every label to remain readable, and every relation to avoid unrelated nodes and text. Repack once if needed. If it still fails, revise and re-preview the affected plan once in autonomous mode, or request a plan revision in guided mode; never apply tangled or clipped geometry.
9. Keep the preview at a reduced size in a distinct `视觉预演` region beside the generated `视觉素材`, `结构与流程`, and `证据与约束` regions required by the plan.

Do not use one broad raw tldraw snapshot write. Use typed Yogurt operations, preview revisions, and atomic apply contracts.

## Finish and report

Verify that:

- every executable block has exactly one approved slot and one visible result or explicit pending state;
- the final geometry follows the structured plan rather than raster pixels;
- no native object overlaps an unrelated object, crosses a slot boundary, clips text, or leaves a relation visually detached;
- every derived image uses the planned slot ratio and carries matching version 3 composition/digest lineage;
- every semantic object remains individually editable and every non-root diagram object has its intended bound relation;
- exact facts remain in native text or cards, never inferred from the preview;
- source material and unrelated canvas regions remain intact;
- the result stays within the page frame with readable text and no clipped overflow;
- autonomous execution did not auto-accept a protected external or destructive operation.

Report the execution mode, composition ID, page-plan digest, composition-reference shape and asset path, route-and-slot summary, created image shape IDs, semantic operation IDs, source scope, assumptions introduced, geometry checks, and any block still pending.
