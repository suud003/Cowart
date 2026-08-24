# Authoring guide

## Shaping artifacts

Keep the following files small enough to review independently:

- `shaping/01-brief.md`: problem, audience, outcome, evidence, constraints, non-goals, assumptions, open questions.
- `shaping/02-requirements.md`: actors, jobs, business rules, data inputs/outputs, permissions, exceptions, success measures.
- `shaping/03-flows.md`: primary flow, alternative paths, state transitions, cross-module dependencies.
- `shaping/04-module-plan.md`: delivery order, pages per module, dependencies, status, review decisions.
- `DESIGN.md`: tokens, layout baseline, responsive rules, shared components, and their relevant states.

If starting from code, add `shaping/00-demo-audit.md` with observed routes, components, states, data contracts, missing behavior, and questions. Label observations separately from intended behavior.

When starting from Yogurt, cite `sourceId` values from `bridge/source-packet.json` beside important facts and decisions. Do not flatten conflicts or promote model inference to user evidence.

## Requirement format

Use stable IDs: `F-<module>-NN` for functional behavior and `NFR-<module>-NN` for quality requirements. Do not renumber accepted IDs; deprecate them with a reason.

Write requirements with the EARS pattern that best fits the behavior:

- Ubiquitous: `The product shall ...`
- Event-driven: `When <trigger>, the product shall ...`
- State-driven: `While <state>, the product shall ...`
- Optional feature: `Where <feature/permission applies>, the product shall ...`
- Unwanted behavior: `If <failure or invalid condition>, the product shall ...`
- Complex: combine state, trigger, and response only when the simpler patterns lose essential meaning.

For each visible feature include, as applicable:

```markdown
### F-plan-01 Parse natural-language tasks

- Actor / precondition:
- Trigger:
- Requirement: When ..., the product shall ...
- Rules:
- Input / output:
- Visible states: default, loading, success, empty, validation error, service error, unauthorized
- Dependencies:
- Source evidence: `src-...`
- Acceptance:
  - Given ... When ... Then ...
- Prototype coverage: `plan-main`, annotations 1–3
```

Avoid vague words such as “quick”, “friendly”, or “supports” without measurable behavior. Put technical choices in a technical design unless they constrain user-visible behavior.

## Prototype authoring

Each page is a self-contained HTML fragment or document under `prototypes/`. It may use inline CSS and JavaScript so the iframe remains portable. Do not rely on external CDNs.

Model meaningful interactions: navigation, toggles, form validation, empty/loading/error feedback, permission differences, and irreversible-action confirmation. Seed deterministic example data. Clearly label simulated server behavior.

Give every annotated visual target a unique semantic anchor such as `data-annotation-anchor="brief.generate"`. Keep this key stable when labels, layout, or child markup change. Use element IDs as a secondary option. Do not use `data-requirement` as the sole anchor when one requirement appears in multiple places.

Store both the semantic anchor and legacy percentage coordinates in `interaction-prd.json`. The viewer follows the anchored element through iframe scrolling, resizing, and DOM reflow; coordinates remain the fallback when an anchor is unavailable. Verify every marker against its intended element after loading the review container. A dashed amber marker means the anchor is missing or the annotation only has legacy coordinates; repair it with “重新定位”. Markers stay hidden until the iframe and its fonts have reached a stable first layout, so an obsolete percentage point is never shown as the initial authoritative location.

## Semantic diagrams

Use `$cowart-semantic-diagram` when a product overview or prototype needs precise relationship drawing rather than a loose card graph. Keep the final semantic JSON specification and reusable prompt inside the same HTML asset using `data-cowart-diagram-spec` and `data-cowart-diagram-prompt` templates. Give SVG objects and relations stable `data-annotation-anchor`, `data-object-id`, `data-relation`, `data-from`, and `data-to` attributes so annotations and trace mappings bind to meaning instead of pixels.

Every arrow must be supported by a readable source or an explicitly labeled product assumption. Route lines from source boundaries to target boundaries, keep parallel paths visually separate, and split a diagram that cannot remain traceable without crossing unrelated objects or labels. Run the semantic SVG validator, then inspect the real review viewport for alignment, clipping, text collision, and line traceability.

## Alignment review

| Source | Must agree with |
|---|---|
| Yogurt source packet | shaping facts, assumptions, and open questions |
| TAPD access status | evidence claims and quoted content |
| Shaping scope | module plan and PRD scope |
| Requirement IDs | annotations, prototype coverage, and trace map |
| Rules and state machine | prototype behavior and messages |
| `DESIGN.md` | shared component page and prototypes |
| Page transitions | global canvas arrows and working navigation |
| Semantic diagram spec | SVG objects, relations, prompts, source IDs, and annotations |
| Yogurt zones | trace-map `zoneId` and proposed return operations |
| Permissions | visible controls, blocked states, and acceptance criteria |

Treat edits saved by the review container as source changes. If both the agent and reviewer changed a file, inspect and merge intentionally.
