import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Store } from "@tldraw/store";
import { createTLSchema, toRichText } from "@tldraw/tlschema";
import { z } from "zod";

import {
  applyThinkingOperations,
  applyThinkingOperationsToSnapshot,
  getThinkingContext,
  importThinkingMaterial,
  normalizeAutoComposeImageMetadata,
  snapshotRevision,
  summarizeThinkingContext,
  undoThinkingOperation,
} from "../mcp/lib/thinking-canvas.mjs";
import { registerCowartThinkingTools, THINKING_TOOL_NAMES } from "../mcp/lib/thinking-tools.mjs";
import { writeCowartSelectionState } from "../mcp/lib/canvas-storage.mjs";

function emptySnapshot() {
  return {
    schema: createTLSchema().serialize(),
    store: {
      "page:test": {
        id: "page:test",
        typeName: "page",
        name: "Test",
        index: "a0",
        meta: {},
      },
    },
  };
}

function validateSnapshot(snapshot) {
  const store = new Store({ schema: createTLSchema(), props: { defaultName: "Test" } });
  store.loadStoreSnapshot(snapshot);
  return store;
}

function thinkingToolInputSchema(toolName) {
  let definition = null;
  registerCowartThinkingTools({
    registerTool(name, toolDefinition) {
      if (name === toolName) definition = toolDefinition;
    },
  });
  assert.ok(definition, `${toolName} should be registered`);
  return z.object(definition.inputSchema).strict();
}

function semanticDiagram(diagramId = "native:test-guard") {
  return {
    version: "1",
    diagramId,
    teachingClaim: "A bound native relation stays editable without losing semantic integrity.",
    readingOrder: "left-to-right",
    diagramType: "flow",
    sourceShapeIds: ["shape:source-note"],
    sourceIds: ["source:test-note"],
  };
}

function relationBindings(snapshot, relationId) {
  return Object.values(snapshot.store).filter(
    (record) => record?.typeName === "binding" && record.fromId === relationId,
  );
}

function richTextPlainText(richText) {
  const paragraphs = [];
  for (const block of richText?.content ?? []) {
    let text = "";
    const visit = (node) => {
      if (typeof node?.text === "string") text += node.text;
      for (const child of node?.content ?? []) visit(child);
    };
    visit(block);
    paragraphs.push(text);
  }
  return paragraphs.join("\n").trim();
}

function simpleBoundsOverlap(first, second) {
  return !(
    first.x + first.props.w < second.x ||
    second.x + second.props.w < first.x ||
    first.y + first.props.h < second.y ||
    second.y + second.props.h < first.y
  );
}

test("thinking operation schema rejects arbitrary raw source and bridge metadata", () => {
  const schema = thinkingToolInputSchema(THINKING_TOOL_NAMES.applyOperations);
  const validZone = {
    type: "create_zone",
    key: "review",
    title: "Prototype review",
    sourceRefs: ["src-tapd-101"],
    bridge: {
      mappingId: "map-review",
      workspaceId: "workspace:ugc-assistant",
      sourceIds: ["src-tapd-101"],
      zoneId: "zone-review",
      requirementIds: ["F-review-01"],
      pageIds: ["review-main"],
      annotationRefs: ["review-main#1"],
      lastSyncedRevision: "revision:1",
    },
  };
  assert.equal(schema.safeParse({ operations: [validZone] }).success, true);

  const rawBridge = structuredClone(validZone);
  rawBridge.bridge.rawTldraw = { type: "image", props: { src: "file:///secret" } };
  assert.equal(schema.safeParse({ operations: [rawBridge] }).success, false);

  const rawSource = {
    type: "create_card",
    key: "tapd-reference",
    title: "TAPD 101",
    url: "https://tapd.example/101",
    source: {
      id: "src-tapd-101",
      kind: "tapd-link",
      title: "TAPD requirement 101",
      provenance: { origin: "linked-reference", uri: "https://tapd.example/101" },
      accessStatus: "unread",
      rawTldraw: { type: "geo" },
    },
  };
  assert.equal(schema.safeParse({ operations: [rawSource] }).success, false);
});

test("thinking operation schema accepts only bounded native semantic diagram fields", () => {
  const schema = thinkingToolInputSchema(THINKING_TOOL_NAMES.applyOperations);
  const input = {
    semanticDiagram: {
      version: "1",
      diagramId: "native:ugc-flow",
      teachingClaim: "Ideas become a reviewable canvas flow.",
      readingOrder: "left-to-right",
      diagramType: "flow",
      layoutEngine: "html-line-svg",
      layoutMode: "balanced",
      layoutFit: "fixed",
      sourceShapeIds: ["shape:idea"],
      objectCount: 2,
      relationCount: 1,
    },
    operations: [
      {
        type: "create_card",
        key: "idea",
        title: "Idea",
        semantic: {
          id: "object:idea",
          type: "note",
          state: "normal",
          origin: "source",
          sourceShapeIds: ["shape:idea"],
        },
      },
      {
        type: "create_card",
        key: "prototype",
        title: "Prototype",
        semantic: { id: "object:prototype", type: "interface", origin: "synthesis" },
      },
      {
        type: "create_relation",
        key: "idea-to-prototype",
        semanticId: "relation:idea-to-prototype",
        from: "idea",
        to: "prototype",
        kind: "flow",
        direction: "forward",
        path: "alternative",
        label: "optional",
        lane: 1,
        origin: "source",
        sourceShapeIds: ["shape:idea"],
        sourceIds: ["source:idea"],
      },
    ],
  };
  assert.equal(schema.safeParse(input).success, true);
  const invalid = structuredClone(input);
  invalid.operations[0].semantic.rawTldraw = { type: "geo" };
  assert.equal(schema.safeParse(invalid).success, false);
});

test("keeps native semantic canvas batches structurally separate from Product Bridge", () => {
  const product = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    operations: [
      {
        type: "create_zone",
        key: "product-zone",
        title: "Product review",
        purpose: "product",
        bridge: { workspaceId: "workspace:product", zoneId: "zone:product" },
      },
      {
        type: "create_card",
        key: "product-card",
        title: "Product requirement",
        parentZoneId: "product-zone",
        bridge: { workspaceId: "workspace:product", zoneId: "zone:product" },
      },
    ],
  });
  const semanticDiagram = {
    version: "1",
    diagramId: "native:separate",
    teachingClaim: "Canvas diagrams and Product Bridge are independent outputs.",
    readingOrder: "left-to-right",
    diagramType: "flow",
  };

  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: product.snapshot,
      operations: [{ type: "create_zone", key: "shell", title: "Shell", purpose: "semantic" }],
    }),
    /requires the batch-level semanticDiagram/,
  );
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: product.snapshot,
      semanticDiagram,
      operations: [{ type: "create_zone", key: "mixed", title: "Mixed", purpose: "product" }],
    }),
    /cannot create a Product Bridge zone/,
  );
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: product.snapshot,
      semanticDiagram,
      operations: [{
        type: "create_card",
        key: "mixed-card",
        title: "Mixed card",
        semantic: { id: "object:mixed" },
        bridge: { workspaceId: "workspace:product" },
      }],
    }),
    /cannot include Product Bridge metadata/,
  );
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: product.snapshot,
      semanticDiagram,
      operations: [{
        type: "create_card",
        key: "product-child",
        title: "Product child",
        parentZoneId: product.references["product-zone"],
        semantic: { id: "object:product-child" },
      }],
    }),
    /cannot target Product Bridge shape/,
  );

  const beside = applyThinkingOperationsToSnapshot({
    snapshot: product.snapshot,
    semanticDiagram,
    operations: [{
      type: "create_card",
      key: "independent-card",
      title: "Independent canvas card",
      anchorId: product.references["product-card"],
      placement: "right",
      semantic: { id: "object:independent" },
    }],
  });
  const independent = beside.snapshot.store[beside.references["independent-card"]];
  assert.equal(independent.parentId, "page:test");
  assert.equal(independent.meta.cowartProductBridge, null);
  assert.equal(independent.meta.cowartSemanticDiagram.diagramId, "native:separate");
});

test("round-trips semantic zone roles and relation provenance through compact context", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    semanticDiagram: {
      version: "1",
      diagramId: "native:trace",
      teachingClaim: "Every source-backed relation keeps its provenance.",
      readingOrder: "left-to-right",
      diagramType: "flow",
      sourceShapeIds: ["shape:source-note"],
      sourceIds: ["source:note"],
      objectCount: 8,
      relationCount: 6,
    },
    operations: [
      {
        type: "create_zone",
        key: "trace-zone",
        title: "Trace zone",
        purpose: "semantic",
        semantic: { id: "object:zone", type: "zone" },
      },
      {
        type: "create_card",
        key: "a",
        title: "A",
        parentZoneId: "trace-zone",
        semantic: {
          id: "object:a",
          type: "document",
          origin: "source",
          sourceShapeIds: ["shape:source-note"],
        },
      },
      {
        type: "create_card",
        key: "b",
        title: "B",
        parentZoneId: "trace-zone",
        semantic: { id: "object:b", type: "system" },
      },
      {
        type: "create_relation",
        key: "a-b",
        semanticId: "relation:a-b",
        from: "a",
        to: "b",
        origin: "source",
        sourceShapeIds: ["shape:source-note"],
        sourceIds: ["source:note"],
      },
    ],
  });
  const context = summarizeThinkingContext({ snapshot: result.snapshot, scope: "page" });
  const zone = context.shapes.find(({ id }) => id === result.references["trace-zone"]);
  const relation = context.shapes.find(({ id }) => id === result.references["a-b"]);
  assert.equal(zone.role, "zone");
  assert.deepEqual(relation.semantic.sourceIds, ["source:note"]);
  assert.equal(relation.semantic.objectCount, 8);
  assert.equal(relation.semantic.relationCount, 6);
  assert.equal(relation.semantic.relation.origin, "source");
  assert.deepEqual(relation.semantic.relation.sourceShapeIds, ["shape:source-note"]);
  assert.deepEqual(relation.semantic.relation.sourceIds, ["source:note"]);
});

test("treats partial UI bindings as authoritative and keeps an unbound relation when deleting its old target", () => {
  const diagram = semanticDiagram("native:partial-binding");
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    semanticDiagram: diagram,
    operations: [
      { type: "create_card", key: "a", title: "A", x: 40, y: 40, semantic: { id: "object:a" } },
      { type: "create_card", key: "b", title: "B", x: 520, y: 40, semantic: { id: "object:b" } },
      { type: "create_relation", key: "a-b", from: "a", to: "b", semanticId: "relation:a-b" },
    ],
  });
  const relationId = created.references["a-b"];
  const targetId = created.references.b;

  const legacy = structuredClone(created.snapshot);
  for (const binding of relationBindings(legacy, relationId)) delete legacy.store[binding.id];
  const legacyRelation = summarizeThinkingContext({ snapshot: legacy, scope: "page" })
    .shapes.find(({ id }) => id === relationId);
  assert.equal(legacyRelation.relation.fromId, created.references.a);
  assert.equal(legacyRelation.relation.toId, targetId);
  assert.equal(legacyRelation.relation.valid, true);

  const partial = structuredClone(created.snapshot);
  const endBinding = relationBindings(partial, relationId)
    .find((binding) => binding.props.terminal === "end");
  delete partial.store[endBinding.id];
  const partialRelation = summarizeThinkingContext({ snapshot: partial, scope: "page" })
    .shapes.find(({ id }) => id === relationId);
  assert.equal(partialRelation.relation.fromId, created.references.a);
  assert.equal(partialRelation.relation.toId, null);
  assert.equal(partialRelation.relation.valid, false);
  assert.equal(partialRelation.relation.unsafe, false);
  assert.match(partialRelation.relation.invalidReason, /incomplete/);

  const deleted = applyThinkingOperationsToSnapshot({
    snapshot: partial,
    operations: [{ type: "delete_shape", id: targetId }],
  });
  assert.equal(deleted.snapshot.store[targetId], undefined);
  assert.ok(deleted.snapshot.store[relationId], "an already-unbound arrow must not follow stale endpoint metadata");
  assert.equal(relationBindings(deleted.snapshot, relationId).length, 1);
  validateSnapshot(deleted.snapshot);
});

test("marks cross-diagram and non-semantic UI rebindings invalid and refuses later mutations", () => {
  const firstDiagram = semanticDiagram("native:first");
  const first = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    semanticDiagram: firstDiagram,
    operations: [
      { type: "create_card", key: "a", title: "A", x: 40, y: 40, semantic: { id: "object:a" } },
      { type: "create_card", key: "b", title: "B", x: 520, y: 40, semantic: { id: "object:b" } },
      { type: "create_relation", key: "a-b", from: "a", to: "b", semanticId: "relation:a-b" },
    ],
  });
  const second = applyThinkingOperationsToSnapshot({
    snapshot: first.snapshot,
    semanticDiagram: semanticDiagram("native:second"),
    operations: [
      { type: "create_card", key: "c", title: "C", x: 1_000, y: 40, semantic: { id: "object:c" } },
    ],
  });
  const ordinary = applyThinkingOperationsToSnapshot({
    snapshot: second.snapshot,
    operations: [{ type: "create_card", key: "plain", title: "Plain", x: 1_400, y: 40 }],
  });
  const relationId = first.references["a-b"];
  const endBindingId = relationBindings(ordinary.snapshot, relationId)
    .find((binding) => binding.props.terminal === "end").id;

  for (const [targetId, reasonPattern] of [
    [second.references.c, /crosses semantic diagrams/],
    [ordinary.references.plain, /non-semantic shape/],
  ]) {
    const rebound = structuredClone(ordinary.snapshot);
    rebound.store[endBindingId].toId = targetId;
    const contextRelation = summarizeThinkingContext({ snapshot: rebound, scope: "page" })
      .shapes.find(({ id }) => id === relationId);
    assert.equal(contextRelation.semantic.relation.valid, false);
    assert.equal(contextRelation.semantic.relation.unsafe, true);
    assert.match(contextRelation.semantic.relation.invalidReason, reasonPattern);
    assert.throws(
      () => applyThinkingOperationsToSnapshot({
        snapshot: rebound,
        operations: [{ type: "move_shape", id: first.references.a, x: 80, y: 80 }],
      }),
      /native semantic relation bindings are invalid/,
    );
  }
});

test("round-trips restricted semantic patches without changing diagram or semantic identity", () => {
  const schema = thinkingToolInputSchema(THINKING_TOOL_NAMES.applyOperations);
  const diagram = semanticDiagram("native:semantic-patch");
  assert.equal(schema.safeParse({
    semanticDiagram: diagram,
    operations: [{
      type: "update_card",
      id: "shape:card",
      semantic: {
        type: "decision",
        state: "warning",
        origin: "inference",
        order: 4,
        sourceShapeIds: ["shape:source-2"],
        sourceIds: ["source:2"],
      },
    }],
  }).success, true);
  assert.equal(schema.safeParse({
    semanticDiagram: diagram,
    operations: [{ type: "update_card", id: "shape:card", semantic: { id: "object:hijack" } }],
  }).success, false);
  assert.equal(schema.safeParse({
    semanticDiagram: diagram,
    operations: [{ type: "update_zone", id: "shape:zone", semantic: { diagramId: "native:hijack" } }],
  }).success, false);

  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    semanticDiagram: diagram,
    operations: [
      {
        type: "create_zone",
        key: "zone",
        title: "System",
        purpose: "semantic",
        semantic: { id: "object:zone", type: "zone", sourceIds: ["source:1"] },
      },
      {
        type: "create_card",
        key: "card",
        title: "Draft",
        parentZoneId: "zone",
        semantic: { id: "object:card", type: "note", sourceIds: ["source:1"] },
      },
    ],
  });
  const updated = applyThinkingOperationsToSnapshot({
    snapshot: created.snapshot,
    semanticDiagram: diagram,
    operations: [
      {
        type: "update_zone",
        id: created.references.zone,
        semantic: { type: "container", state: "success", origin: "user", order: 1, sourceIds: ["source:2"] },
      },
      {
        type: "update_card",
        id: created.references.card,
        title: "Reviewed",
        semantic: {
          type: "decision",
          state: "warning",
          origin: "inference",
          order: 4,
          sourceShapeIds: ["shape:source-2"],
          sourceIds: ["source:2"],
        },
      },
    ],
  });
  const card = updated.snapshot.store[created.references.card];
  const zone = updated.snapshot.store[created.references.zone];
  assert.equal(card.meta.cowartSemanticObject.semanticId, "object:card");
  assert.equal(card.meta.cowartSemanticObject.diagramId, diagram.diagramId);
  assert.deepEqual(
    {
      type: card.meta.cowartSemanticObject.type,
      state: card.meta.cowartSemanticObject.state,
      origin: card.meta.cowartSemanticObject.origin,
      order: card.meta.cowartSemanticObject.order,
      sourceShapeIds: card.meta.cowartSemanticObject.sourceShapeIds,
      sourceIds: card.meta.cowartSemanticObject.sourceIds,
    },
    {
      type: "decision",
      state: "warning",
      origin: "inference",
      order: 4,
      sourceShapeIds: ["shape:source-2"],
      sourceIds: ["source:2"],
    },
  );
  assert.equal(zone.meta.cowartSemanticObject.semanticId, "object:zone");
  assert.equal(zone.meta.cowartSemanticObject.type, "container");
  const contextCard = summarizeThinkingContext({ snapshot: updated.snapshot, scope: "page" })
    .shapes.find(({ id }) => id === created.references.card);
  assert.deepEqual(contextCard.semantic.object.sourceIds, ["source:2"]);

  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: updated.snapshot,
      semanticDiagram: diagram,
      operations: [{
        type: "update_card",
        id: created.references.card,
        semantic: { semanticId: "object:hijack", type: "state" },
      }],
    }),
    /cannot change semanticId or diagramId/,
  );
});

test("incremental upstream layout preserves fixed user siblings and selects a safe alternate lane", () => {
  const diagram = semanticDiagram("native:fixed-sibling");
  const initial = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    semanticDiagram: diagram,
    operations: [
      { type: "create_zone", key: "zone", title: "System", purpose: "semantic", x: 0, y: 0, w: 1_200, h: 900, semantic: { id: "object:zone", type: "zone" } },
      { type: "create_card", key: "endpoint", title: "Endpoint", parentZoneId: "zone", x: 80, y: 120, semantic: { id: "object:endpoint", order: 2 } },
      { type: "create_card", key: "fixed", title: "User sibling", parentZoneId: "zone", x: 500, y: 120, generated: false, semantic: { id: "object:fixed", order: 3 } },
    ],
  });
  const endpointBefore = structuredClone(initial.snapshot.store[initial.references.endpoint]);
  const fixedBefore = structuredClone(initial.snapshot.store[initial.references.fixed]);
  const extended = applyThinkingOperationsToSnapshot({
    snapshot: initial.snapshot,
    semanticDiagram: diagram,
    operations: [
      { type: "create_card", key: "upstream", title: "Upstream", parentZoneId: initial.references.zone, semantic: { id: "object:upstream", order: 1 } },
      { type: "create_relation", key: "upstream-endpoint", from: "upstream", to: initial.references.endpoint, semanticId: "relation:upstream-endpoint" },
    ],
  });
  const endpointAfter = extended.snapshot.store[initial.references.endpoint];
  const fixedAfter = extended.snapshot.store[initial.references.fixed];
  const upstream = extended.snapshot.store[extended.references.upstream];
  assert.deepEqual({ x: endpointAfter.x, y: endpointAfter.y }, { x: endpointBefore.x, y: endpointBefore.y });
  assert.deepEqual({ x: fixedAfter.x, y: fixedAfter.y }, { x: fixedBefore.x, y: fixedBefore.y });
  assert.equal(simpleBoundsOverlap(upstream, endpointAfter), false);
  assert.equal(simpleBoundsOverlap(upstream, fixedAfter), false);

  const blocked = structuredClone(initial.snapshot);
  blocked.store[initial.references.fixed].x = 40;
  blocked.store[initial.references.fixed].y = 40;
  blocked.store[initial.references.fixed].props.w = 8_000;
  blocked.store[initial.references.fixed].props.h = 8_000;
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: blocked,
      semanticDiagram: diagram,
      operations: [
        { type: "create_card", key: "blocked-upstream", title: "Blocked upstream", parentZoneId: initial.references.zone, semantic: { id: "object:blocked-upstream", order: 1 } },
        { type: "create_relation", key: "blocked-edge", from: "blocked-upstream", to: initial.references.endpoint, semanticId: "relation:blocked-edge" },
      ],
    }),
    /cannot find a safe position without overlapping fixed sibling shapes/,
  );
});

test("thinking context schema requires a non-empty bounded frozen selection", () => {
  const schema = thinkingToolInputSchema(THINKING_TOOL_NAMES.getContext);
  assert.equal(schema.safeParse({ scope: "selection", shapeIds: ["shape:frozen"] }).success, true);
  assert.equal(schema.safeParse({ scope: "selection", shapeIds: [] }).success, false);
  assert.equal(
    schema.safeParse({
      scope: "selection",
      shapeIds: Array.from({ length: 251 }, (_, index) => `shape:${index}`),
    }).success,
    false,
  );
});

test("thinking context exposes a constrained semantic diagram summary for round trips", () => {
  const snapshot = emptySnapshot();
  const sourceShapeIds = Array.from({ length: 250 }, (_, index) => `shape:source-${index}`);
  snapshot.store["shape:diagram"] = {
    id: "shape:diagram",
    typeName: "shape",
    type: "embed",
    parentId: "page:test",
    index: "a1",
    x: 80,
    y: 80,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { w: 960, h: 540, url: "data:text/html;base64,PGh0bWw+PC9odG1sPg==" },
    meta: {
      cowartHtmlDraft: true,
      cowartHtmlDraftAssetUrl: "/page-assets/test/product-flow.html",
      cowartSemanticDiagram: {
        version: "1",
        teachingClaim: "用户想法先被整理成需求，再生成可评审原型。",
        readingOrder: "left-to-right",
        diagramType: "flow",
        sourceShapeIds,
        sourceIds: ["src:idea", "src:tapd"],
        workspaceId: "workspace:ugc",
        zoneId: "zone:overview",
        objectCount: 3,
        relationCount: 2,
        specDigest: "sha256:spec",
        promptDigest: "sha256:prompt",
        ignoredRawMarkup: "<script>alert(1)</script>",
      },
    },
  };

  const context = summarizeThinkingContext({ snapshot, pageId: "page:test" });
  const diagram = context.shapes.find((shape) => shape.id === "shape:diagram");
  assert.equal(diagram.role, "visual");
  assert.equal(diagram.visual.kind, "semantic-line-svg");
  assert.equal(diagram.visual.assetUrl, "/page-assets/test/product-flow.html");
  assert.equal(diagram.visual.semanticDiagram.teachingClaim, "用户想法先被整理成需求，再生成可评审原型。");
  assert.deepEqual(diagram.visual.semanticDiagram.sourceShapeIds, sourceShapeIds);
  assert.equal("ignoredRawMarkup" in diagram.visual.semanticDiagram, false);
});

test("thinking context exposes only v3 composition-reference lineage for resume", () => {
  const snapshot = emptySnapshot();
  const pagePlanDigest = "a".repeat(64);
  const addImage = (name, { index, parentId = "page:test", assetPage = "test", meta = {} } = {}) => {
    const assetId = `asset:${name}`;
    const shapeId = `shape:${name}`;
    snapshot.store[assetId] = {
      id: assetId,
      typeName: "asset",
      type: "image",
      props: { name: `${name}.png`, src: `/page-assets/${assetPage}/${name}.png`, w: 800, h: 450, mimeType: "image/png", fileSize: 42, isAnimated: false },
      meta: {},
    };
    snapshot.store[shapeId] = {
      id: shapeId,
      typeName: "shape",
      type: "image",
      parentId,
      index,
      x: 80,
      y: 560,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      props: { w: 400, h: 225, assetId, playing: true, url: "", crop: null, flipX: false, flipY: false, altText: name },
      meta,
    };
    return shapeId;
  };
  snapshot.store["shape:brief"] = {
    id: "shape:brief",
    typeName: "shape",
    type: "geo",
    parentId: "page:test",
    index: "a0",
    x: 0,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { w: 320, h: 180, geo: "rectangle", color: "black", fill: "none", dash: "draw", size: "m", font: "draw", align: "middle", verticalAlign: "middle", growY: 0, url: "", scale: 1, richText: toRichText("Mixed brief") },
    meta: {},
  };
  snapshot.store["asset:reference"] = {
    id: "asset:reference",
    typeName: "asset",
    type: "image",
    props: {
      name: "composition-preview.png",
      src: "/page-assets/test/composition-preview.png",
      w: 1600,
      h: 900,
      mimeType: "image/png",
      fileSize: 42,
      isAnimated: false,
    },
    meta: {},
  };
  snapshot.store["shape:reference"] = {
    id: "shape:reference",
    typeName: "shape",
    type: "image",
    parentId: "page:test",
    index: "a1",
    x: 80,
    y: 80,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: {
      w: 800,
      h: 450,
      assetId: "asset:reference",
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: "Full-page composition preview",
    },
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
      cowartAutoComposeSourceShapeIds: ["shape:brief"],
      ignoredPrompt: "must not leak into compact context",
    },
  };
  snapshot.store["shape:spoofed-reference"] = {
    id: "shape:spoofed-reference",
    typeName: "shape",
    type: "image",
    parentId: "page:test",
    index: "a2",
    x: 920,
    y: 80,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { w: 320, h: 180, assetId: "asset:missing", playing: true, url: "", crop: null, flipX: false, flipY: false, altText: "Spoofed reference" },
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    },
  };
  addImage("visual-part", {
    index: "a3",
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeBlockId: "block:rainy-alley",
      cowartAutoComposeSlotId: "slot:rainy-alley",
      cowartAutoComposeRole: "visual-part",
      cowartAutoComposeReferenceShapeId: "shape:reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
      cowartAutoComposeSourceShapeIds: ["shape:brief"],
    },
  });
  addImage("wrong-composition-part", {
    index: "a4",
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:other",
      cowartAutoComposeBlockId: "block:rainy-alley",
      cowartAutoComposeSlotId: "slot:rainy-alley",
      cowartAutoComposeRole: "visual-part",
      cowartAutoComposeReferenceShapeId: "shape:reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    },
  });
  addImage("wrong-layout-digest-part", {
    index: "a4V",
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeBlockId: "block:rainy-alley",
      cowartAutoComposeSlotId: "slot:rainy-alley",
      cowartAutoComposeRole: "visual-part",
      cowartAutoComposeReferenceShapeId: "shape:reference",
      cowartAutoComposePagePlanDigest: "d".repeat(64),
    },
  });
  addImage("cross-url-reference", {
    index: "a5",
    assetPage: "other",
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    },
  });
  addImage("invalid-role", {
    index: "a6",
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeRole: "diagram",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    },
  });
  addImage("oversized-id", {
    index: "a7",
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: `compose:${"x".repeat(200)}`,
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    },
  });
  snapshot.store["page:other"] = { id: "page:other", typeName: "page", name: "Other", index: "a1", meta: {} };
  const otherReferenceId = addImage("other-reference", {
    index: "a1",
    parentId: "page:other",
    assetPage: "other",
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    },
  });
  addImage("cross-page-part", {
    index: "a8",
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeBlockId: "block:cross-page",
      cowartAutoComposeSlotId: "slot:cross-page",
      cowartAutoComposeRole: "visual-part",
      cowartAutoComposeReferenceShapeId: otherReferenceId,
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    },
  });
  snapshot.store["shape:non-image-lineage"] = {
    ...snapshot.store["shape:brief"],
    id: "shape:non-image-lineage",
    index: "a9",
    x: 400,
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    },
  };
  addImage("legacy-concept-reference", {
    index: "a10",
    meta: {
      cowartAutoComposeVersion: "1",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeRole: "reference",
    },
  });
  addImage("legacy-layout-reference", {
    index: "a11",
    meta: {
      cowartAutoComposeVersion: "2",
      cowartAutoComposeId: "compose:interactive-film",
      cowartAutoComposeRole: "layout-reference",
      cowartAutoComposeLayoutPlanDigest: pagePlanDigest,
    },
  });

  const context = summarizeThinkingContext({ snapshot, pageId: "page:test" });
  const reference = context.shapes.find((shape) => shape.id === "shape:reference");
  const spoofed = context.shapes.find((shape) => shape.id === "shape:spoofed-reference");
  const visualPart = context.shapes.find((shape) => shape.id === "shape:visual-part");

  assert.deepEqual(reference.autoCompose, {
    version: "3",
    compositionId: "compose:interactive-film",
    blockId: null,
    slotId: null,
    role: "composition-reference",
    pagePlanDigest,
    referenceShapeId: null,
    sourceShapeIds: ["shape:brief"],
  });
  assert.equal(reference.asset.src, "/page-assets/test/composition-preview.png");
  assert.equal("ignoredPrompt" in reference.autoCompose, false);
  assert.equal(spoofed.autoCompose, null);
  assert.deepEqual(visualPart.autoCompose, {
    version: "3",
    compositionId: "compose:interactive-film",
    blockId: "block:rainy-alley",
    slotId: "slot:rainy-alley",
    role: "visual-part",
    pagePlanDigest,
    referenceShapeId: "shape:reference",
    sourceShapeIds: ["shape:brief"],
  });
  for (const invalidId of [
    "shape:wrong-composition-part",
    "shape:wrong-layout-digest-part",
    "shape:cross-url-reference",
    "shape:invalid-role",
    "shape:oversized-id",
    "shape:cross-page-part",
    "shape:non-image-lineage",
    "shape:legacy-concept-reference",
    "shape:legacy-layout-reference",
  ]) {
    assert.equal(context.shapes.find(({ id }) => id === invalidId).autoCompose, null, `${invalidId} must not expose trusted lineage`);
  }

  const sourceOnly = summarizeThinkingContext({
    snapshot,
    pageId: "page:test",
    scope: "selection",
    shapeIds: ["shape:brief"],
  });
  assert.deepEqual(sourceOnly.shapes.map(({ id }) => id), ["shape:brief"]);

  const resumed = summarizeThinkingContext({
    snapshot,
    pageId: "page:test",
    scope: "selection",
    shapeIds: ["shape:brief", "shape:reference"],
  });
  assert.deepEqual(resumed.shapes.map(({ id }) => id), ["shape:brief", "shape:reference"]);
  assert.equal(resumed.shapes.find(({ id }) => id === "shape:reference").autoCompose.role, "composition-reference");
});

test("a 250-shape frozen source scope resumes its later reference with a second exact read", () => {
  const snapshot = emptySnapshot();
  const pagePlanDigest = "b".repeat(64);
  const sourceIds = [];
  for (let index = 0; index < 250; index += 1) {
    const id = `shape:source-${index}`;
    sourceIds.push(id);
    snapshot.store[id] = {
      id,
      typeName: "shape",
      type: "geo",
      parentId: "page:test",
      index: `a${String(index).padStart(3, "0")}`,
      x: index * 12,
      y: 0,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      props: { w: 10, h: 10, geo: "rectangle", color: "black", fill: "none", dash: "draw", size: "s", font: "draw", align: "middle", verticalAlign: "middle", growY: 0, url: "", scale: 1, richText: toRichText(String(index)) },
      meta: {},
    };
  }
  snapshot.store["asset:late-reference"] = {
    id: "asset:late-reference",
    typeName: "asset",
    type: "image",
    props: { name: "late-reference.png", src: "/page-assets/test/late-reference.png", w: 800, h: 450, mimeType: "image/png", fileSize: 42, isAnimated: false },
    meta: {},
  };
  snapshot.store["shape:late-reference"] = {
    id: "shape:late-reference",
    typeName: "shape",
    type: "image",
    parentId: "page:test",
    index: "z1",
    x: 3200,
    y: 0,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { w: 800, h: 450, assetId: "asset:late-reference", playing: true, url: "", crop: null, flipX: false, flipY: false, altText: "Late managed reference" },
    meta: {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "compose:limit-test",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
      cowartAutoComposeSourceShapeIds: sourceIds,
    },
  };

  const pageContext = summarizeThinkingContext({ snapshot, pageId: "page:test" });
  assert.equal(pageContext.truncated, true);
  assert.equal(pageContext.shapes.some(({ id }) => id === "shape:late-reference"), false);

  const sourceContext = summarizeThinkingContext({ snapshot, pageId: "page:test", scope: "selection", shapeIds: sourceIds });
  const referenceContext = summarizeThinkingContext({ snapshot, pageId: "page:test", scope: "selection", shapeIds: ["shape:late-reference"] });
  assert.equal(sourceContext.shapes.length, 250);
  assert.equal(referenceContext.shapes[0].autoCompose.role, "composition-reference");
  assert.equal(sourceContext.revision, referenceContext.revision);
  assert.equal(sourceContext.pageId, referenceContext.pageId);
});

test("auto-compose evidence identity round-trips through supported card source fields", () => {
  const compositionHash = "a1b2c3d4e5f6";
  const blockHash = "0f1e2d3c4b5a";
  const key = `ac-evidence:${compositionHash}:${blockHash}`;
  const sourceId = `ac-source:${compositionHash}:${blockHash}`;
  assert.ok(key.length <= 80);
  assert.ok(sourceId.length <= 160);

  const input = thinkingToolInputSchema(THINKING_TOOL_NAMES.applyOperations).parse({
    pageId: "page:test",
    dryRun: true,
    operations: [{
      type: "create_card",
      key,
      role: "evidence",
      title: "Branch budget",
      body: "Each decision point exposes no more than three branches.",
      source: {
        id: sourceId,
        kind: "user-note",
        yogurtShapeIds: ["shape:brief"],
        provenance: { origin: "user" },
      },
      sourceRefs: ["source:brief", "constraint:branch-budget"],
    }],
  });
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: input.pageId,
    operations: input.operations,
  });
  const context = summarizeThinkingContext({ snapshot: result.snapshot, pageId: "page:test" });
  const card = context.shapes.find((shape) => shape.id === result.references[key]);

  assert.equal(card.key, key);
  assert.equal(card.source.id, sourceId);
  assert.deepEqual(card.source.yogurtShapeIds, ["shape:brief"]);
  assert.deepEqual(card.sourceRefs, ["source:brief", "constraint:branch-budget"]);
  assert.equal(card.semantic, null);
});

test("auto-compose image metadata validates at the image insertion boundary", () => {
  const pagePlanDigest = "c".repeat(64);
  const normalized = normalizeAutoComposeImageMetadata({
    unrelatedShapeField: true,
    cowartAutoComposeVersion: "3",
    cowartAutoComposeId: "  ac:composition  ",
    cowartAutoComposeRole: "visual-part",
    cowartAutoComposeBlockId: " ac:block ",
    cowartAutoComposeSlotId: " ac:slot ",
    cowartAutoComposeReferenceShapeId: " shape:reference ",
    cowartAutoComposePagePlanDigest: pagePlanDigest,
    cowartAutoComposeSourceShapeIds: [" shape:brief ", "shape:brief"],
  });
  assert.deepEqual(normalized, {
    unrelatedShapeField: true,
    cowartAutoComposeVersion: "3",
    cowartAutoComposeId: "ac:composition",
    cowartAutoComposeRole: "visual-part",
    cowartAutoComposeBlockId: "ac:block",
    cowartAutoComposeSlotId: "ac:slot",
    cowartAutoComposeReferenceShapeId: "shape:reference",
    cowartAutoComposePagePlanDigest: pagePlanDigest,
    cowartAutoComposeSourceShapeIds: ["shape:brief"],
  });

  assert.deepEqual(normalizeAutoComposeImageMetadata({
    cowartAutoComposeVersion: "3",
    cowartAutoComposeId: "ac:composition",
    cowartAutoComposeRole: "composition-reference",
    cowartAutoComposePagePlanDigest: pagePlanDigest,
  }), {
    cowartAutoComposeVersion: "3",
    cowartAutoComposeId: "ac:composition",
    cowartAutoComposeRole: "composition-reference",
    cowartAutoComposePagePlanDigest: pagePlanDigest,
  });

  assert.throws(
    () => normalizeAutoComposeImageMetadata({
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "ac:composition",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
      cowartAutoComposeUnexpected: true,
    }),
    /Unsupported auto-compose image metadata field/,
  );
  assert.throws(
    () => normalizeAutoComposeImageMetadata({
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "ac:composition",
      cowartAutoComposeRole: "visual-part",
      cowartAutoComposeBlockId: "ac:block",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    }),
    /require a block ID, slot ID, and reference shape ID/,
  );
  assert.throws(
    () => normalizeAutoComposeImageMetadata({
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "ac:composition",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
    }, { allowLineage: false }),
    /belongs on shapeMeta/,
  );
  assert.throws(
    () => normalizeAutoComposeImageMetadata({
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "ac:composition",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
      cowartAutoComposeSourceShapeIds: Array.from({ length: 251 }, (_, index) => `shape:${index}`),
    }),
    /cannot exceed 250 items/,
  );
  assert.throws(
    () => normalizeAutoComposeImageMetadata({
      cowartAutoComposeVersion: "1",
      cowartAutoComposeId: "ac:composition",
      cowartAutoComposeRole: "reference",
    }),
    /must be exactly "3"/,
  );
  assert.throws(
    () => normalizeAutoComposeImageMetadata({
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "ac:composition",
      cowartAutoComposeRole: "composition-reference",
    }),
    /must be exactly 64 lowercase hexadecimal characters/,
  );
  assert.throws(
    () => normalizeAutoComposeImageMetadata({
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "ac:composition",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: pagePlanDigest,
      cowartAutoComposeReferenceShapeId: "shape:other",
    }),
    /cannot declare a block ID, slot ID, or reference shape ID/,
  );
});

test("creates source-aware cards and bound relations from local references", () => {
  const initial = emptySnapshot();
  const result = applyThinkingOperationsToSnapshot({
    snapshot: initial,
    pageId: "page:test",
    operations: [
      {
        type: "create_card",
        key: "source",
        role: "material",
        generated: false,
        title: "Interview notes",
        body: "Users cannot see why a recommendation was made.",
        source: {
          fileName: "interview.md",
          localPath: "C:/project/canvas/materials/interview.md",
          excerpt: "Why did it choose this?",
        },
      },
      {
        type: "create_card",
        key: "insight",
        role: "insight",
        title: "Expose reasoning provenance",
        body: "Keep conclusions visibly connected to evidence.",
        anchorId: "source",
      },
      {
        type: "create_relation",
        key: "supports",
        from: "source",
        to: "insight",
        kind: "supports",
        label: "supports",
      },
    ],
  });

  validateSnapshot(result.snapshot);
  assert.equal(result.changes.length, 3);
  assert.match(result.references.source, /^shape:/);
  assert.match(result.references.insight, /^shape:/);
  assert.match(result.references.supports, /^shape:/);

  const relation = result.snapshot.store[result.references.supports];
  const bindings = Object.values(result.snapshot.store).filter(
    (record) => record.typeName === "binding" && record.fromId === relation.id,
  );
  assert.equal(bindings.length, 2);
  assert.deepEqual(new Set(bindings.map((binding) => binding.props.terminal)), new Set(["start", "end"]));
});

test("compact context keeps source provenance separate from synthesis", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    operations: [
      {
        type: "create_card",
        key: "material",
        role: "material",
        generated: false,
        title: "Strategy.pdf",
        body: "Source summary",
        source: {
          kind: "pdf",
          fileName: "Strategy.pdf",
          localPath: "C:/project/canvas/materials/Strategy.pdf",
          excerpt: "Retention is the leading risk.",
          fileSize: 1234,
        },
      },
      {
        type: "create_card",
        key: "idea",
        role: "idea",
        title: "Retention intervention",
        body: "Test a guided activation path.",
        sourceRefs: ["Strategy.pdf#p12"],
      },
    ],
  });
  const materialId = result.references.material;
  const context = summarizeThinkingContext({
    snapshot: result.snapshot,
    selection: { selectedShapes: [{ id: materialId }] },
    scope: "selection",
  });

  assert.equal(context.scope, "selection");
  assert.equal(context.shapes.length, 1);
  assert.equal(context.shapes[0].role, "material");
  assert.equal(context.shapes[0].source.fileName, "Strategy.pdf");
  assert.equal(context.shapes[0].source.excerpt, "Retention is the leading risk.");
  assert.equal(context.shapes[0].text, "Source summary");

  const pageContext = summarizeThinkingContext({ snapshot: result.snapshot, scope: "page" });
  const synthesis = pageContext.shapes.find(({ id }) => id === result.references.idea);
  assert.deepEqual(synthesis.sourceRefs, ["Strategy.pdf#p12"]);
});

test("creates real product zones and exposes constrained bridge trace metadata", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    operations: [
      {
        type: "create_card",
        key: "raw-note",
        role: "material",
        generated: false,
        title: "Unsorted product note",
        body: "Creators need help turning fragments into a reviewable flow.",
        x: 40,
        y: 40,
        source: {
          id: "source:note-1",
          kind: "user-note",
          title: "UGC assistant idea",
          summary: "A source-faithful summary.",
          yogurtShapeIds: ["shape:source-note"],
          provenance: { origin: "user-authored", uri: "https://example.test/note/1" },
          accessStatus: "available",
          rawTldraw: { type: "image" },
        },
        bridge: {
          mappingId: "map:ugc-intake",
          workspaceId: "workspace:ugc-assistant",
          sourceIds: ["source:note-1"],
          yogurtShapeIds: ["shape:source-note"],
          requirementIds: ["REQ-1"],
          rawShape: { type: "image" },
        },
      },
      {
        type: "create_zone",
        key: "ugc-intake",
        title: "UGC intake",
        body: "Collect notes and TAPD references.",
        x: 0,
        y: 0,
        w: 880,
        h: 560,
        color: "light-blue",
        sourceRefs: ["source:note-1"],
        bridge: {
          mappingId: "map:ugc-intake",
          workspaceId: "workspace:ugc-assistant",
          sourceIds: ["source:note-1"],
          yogurtShapeIds: ["shape:source-note"],
          zoneId: "zone:ugc-intake",
          requirementIds: ["REQ-1"],
          pageIds: ["page:intake"],
          annotationRefs: ["page:intake#annotation-1"],
          returnedShapeIds: ["shape:returned-zone"],
          lastSyncedRevision: "sync:1",
          rawShape: { type: "geo" },
        },
      },
      {
        type: "update_zone",
        id: "ugc-intake",
        body: "Collect, classify, and trace notes and TAPD references.",
        w: 920,
      },
    ],
  });

  const zoneId = result.references["ugc-intake"];
  const cardId = result.references["raw-note"];
  const updatedResult = applyThinkingOperationsToSnapshot({
    snapshot: result.snapshot,
    operations: [
      {
        type: "update_zone",
        id: "ugc-intake",
        title: "UGC source intake",
        w: 940,
      },
      {
        type: "update_card",
        id: cardId,
        sourceRefs: ["source:note-1", "src-tapd-101"],
        source: {
          id: "source:note-1",
          kind: "user-note",
          title: "UGC assistant idea",
          summary: "A reviewed, source-faithful summary.",
          yogurtShapeIds: ["shape:source-note"],
          provenance: { origin: "user-authored", uri: "https://example.test/note/1" },
          accessStatus: "available",
        },
        bridge: {
          mappingId: "map:ugc-intake",
          workspaceId: "workspace:ugc-assistant",
          sourceIds: ["source:note-1", "src-tapd-101"],
          yogurtShapeIds: ["shape:source-note"],
          zoneId: "zone:ugc-intake",
          requirementIds: ["REQ-1", "REQ-2"],
          pageIds: ["page:intake"],
          annotationRefs: ["page:intake#annotation-1"],
          lastSyncedRevision: "sync:2",
        },
      },
    ],
  });

  validateSnapshot(updatedResult.snapshot);
  const zone = updatedResult.snapshot.store[zoneId];
  assert.equal(zone.type, "frame");
  assert.equal(zone.props.w, 940);
  assert.equal(zone.props.name, "UGC source intake");
  assert.equal(zone.meta.cowartProductZoneKey, "ugc-intake");
  assert.equal(zone.meta.cowartThinkingBody, "Collect, classify, and trace notes and TAPD references.");
  assert.equal(zone.index < updatedResult.snapshot.store[cardId].index, true);
  assert.equal(zone.meta.cowartProductBridge.rawShape, undefined);

  const context = summarizeThinkingContext({ snapshot: updatedResult.snapshot, scope: "page" });
  const zoneContext = context.shapes.find(({ id }) => id === zoneId);
  const cardContext = context.shapes.find(({ id }) => id === cardId);
  assert.equal(zoneContext.role, "zone");
  assert.equal(zoneContext.key, "ugc-intake");
  assert.deepEqual(zoneContext.zone, { key: "ugc-intake" });
  assert.deepEqual(zoneContext.sourceRefs, ["source:note-1"]);
  assert.deepEqual(zoneContext.bridge, {
    mappingId: "map:ugc-intake",
    workspaceId: "workspace:ugc-assistant",
    sourceIds: ["source:note-1"],
    yogurtShapeIds: ["shape:source-note"],
    zoneId: "zone:ugc-intake",
    requirementIds: ["REQ-1"],
    pageIds: ["page:intake"],
    annotationRefs: ["page:intake#annotation-1"],
    returnedShapeIds: ["shape:returned-zone"],
    lastSyncedRevision: "sync:1",
  });
  assert.equal(cardContext.source.id, "source:note-1");
  assert.equal(cardContext.source.accessStatus, "available");
  assert.equal(cardContext.source.summary, "A reviewed, source-faithful summary.");
  assert.equal(cardContext.source.provenance.uri, "https://example.test/note/1");
  assert.deepEqual(cardContext.sourceRefs, ["source:note-1", "src-tapd-101"]);
  assert.deepEqual(cardContext.bridge.requirementIds, ["REQ-1", "REQ-2"]);
  assert.equal(cardContext.bridge.lastSyncedRevision, "sync:2");
  assert.equal(cardContext.source.rawTldraw, undefined);
  assert.equal(cardContext.bridge.rawShape, undefined);

  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: updatedResult.snapshot,
      operations: [{ type: "create_zone", key: "ugc-intake", title: "Duplicate" }],
    }),
    /Canvas zone key already exists/,
  );
});

test("selection context includes nearby annotations but excludes unrelated page marks", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    operations: [{ type: "create_card", key: "selected", title: "Selected idea", x: 0, y: 0 }],
  });
  const snapshot = structuredClone(created.snapshot);
  const annotation = (id, x) => ({
    id,
    typeName: "shape",
    type: "text",
    parentId: "page:test",
    index: x < 1_000 ? "a2" : "a3",
    x,
    y: 20,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: { color: "red", w: 80, scale: 1, richText: toRichText("review") },
    meta: {},
  });
  snapshot.store["shape:near-annotation"] = annotation("shape:near-annotation", 340);
  snapshot.store["shape:far-annotation"] = annotation("shape:far-annotation", 5_000);

  const context = summarizeThinkingContext({
    snapshot,
    selection: { selectedShapes: [{ id: created.references.selected }] },
    scope: "selection",
  });
  const contextIds = new Set(context.shapes.map(({ id }) => id));
  assert.equal(contextIds.has("shape:near-annotation"), true);
  assert.equal(contextIds.has("shape:far-annotation"), false);
});

test("create_card becomes a real frame child with page-coordinate placement and safe zone semantics", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    operations: [
      { type: "create_zone", key: "requirements", title: "Requirements", x: 100, y: 200, w: 900, h: 620 },
      {
        type: "create_card",
        key: "requirement",
        title: "F-intake-01",
        parentZoneId: "requirements",
        x: 160,
        y: 280,
        generated: false,
      },
      {
        type: "create_card",
        key: "auto-requirement",
        title: "F-intake-02",
        parentZoneId: "requirements",
      },
    ],
  });
  const zoneId = created.references.requirements;
  const cardId = created.references.requirement;
  const autoCardId = created.references["auto-requirement"];
  const card = created.snapshot.store[cardId];
  const autoCard = created.snapshot.store[autoCardId];
  assert.equal(created.snapshot.store[zoneId].meta.cowartThinkingZonePurpose, "thinking");
  assert.equal(created.snapshot.store[zoneId].meta.cowartProductZone, false);
  assert.equal(card.parentId, zoneId);
  assert.deepEqual({ x: card.x, y: card.y }, { x: 60, y: 80 });
  assert.equal(autoCard.parentId, zoneId);
  assert.equal(autoCard.x >= 40, true);
  assert.equal(autoCard.y >= 40, true);
  assert.notDeepEqual({ x: autoCard.x, y: autoCard.y }, { x: card.x, y: card.y });
  assert.notEqual(autoCard.index, card.index);
  validateSnapshot(created.snapshot);

  const createdByShapeId = applyThinkingOperationsToSnapshot({
    snapshot: created.snapshot,
    operations: [
      {
        type: "create_card",
        key: "shape-id-child",
        title: "F-intake-03",
        parentZoneId: zoneId,
      },
    ],
  });
  const shapeIdChild = createdByShapeId.references["shape-id-child"];
  assert.equal(createdByShapeId.snapshot.store[shapeIdChild].parentId, zoneId);

  const context = summarizeThinkingContext({
    snapshot: createdByShapeId.snapshot,
    scope: "selection",
    shapeIds: [zoneId],
    selection: { selectedShapes: [{ id: "shape:unrelated-shared-selection" }] },
  });
  assert.equal(context.scope, "selection");
  assert.deepEqual(context.selection, [zoneId]);
  assert.deepEqual(
    new Set(context.shapes.map(({ id }) => id)),
    new Set([zoneId, cardId, autoCardId, shapeIdChild]),
  );
  assert.equal(context.shapes.find(({ id }) => id === zoneId).selected, true);
  assert.equal(context.shapes.find(({ id }) => id === cardId).selected, false);
  assert.deepEqual(
    context.shapes.find(({ id }) => id === cardId).parentZone,
    { id: zoneId, key: "requirements", purpose: "thinking" },
  );

  const moved = applyThinkingOperationsToSnapshot({
    snapshot: createdByShapeId.snapshot,
    operations: [{ type: "move_shape", id: zoneId, x: 500, y: 600 }],
  });
  assert.deepEqual(
    { x: moved.snapshot.store[cardId].x, y: moved.snapshot.store[cardId].y },
    { x: 60, y: 80 },
  );
  const movedContext = summarizeThinkingContext({ snapshot: moved.snapshot, scope: "page" });
  assert.deepEqual(
    movedContext.shapes.find(({ id }) => id === cardId).bounds,
    { x: 560, y: 680, w: card.props.w, h: card.props.h },
  );
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: moved.snapshot,
      operations: [{ type: "delete_shape", id: zoneId }],
    }),
    /contains 1 user-authored shape/,
  );
});

test("update_zone cannot resolve a product zone from another page", () => {
  const snapshot = emptySnapshot();
  snapshot.store["page:other"] = {
    id: "page:other",
    typeName: "page",
    name: "Other",
    index: "a1",
    meta: {},
  };
  const created = applyThinkingOperationsToSnapshot({
    snapshot,
    pageId: "page:test",
    operations: [{ type: "create_zone", key: "page-one-zone", title: "Page one zone" }],
  });
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: created.snapshot,
      pageId: "page:other",
      operations: [{ type: "update_zone", id: "page-one-zone", title: "Cross-page edit" }],
    }),
    /not batch page page:other/,
  );
  assert.equal(
    created.snapshot.store[created.references["page-one-zone"]].props.name,
    "Page one zone",
  );
});

test("creation keys are unique across zones, cards, and relations before mutation", () => {
  const snapshot = emptySnapshot();
  const revision = snapshotRevision(snapshot);
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot,
      operations: [
        { type: "create_zone", key: "shared-key", title: "Zone" },
        { type: "create_card", key: "shared-key", title: "Card", parentZoneId: "shared-key" },
      ],
    }),
    /Duplicate creation key 'shared-key'/,
  );
  assert.equal(snapshotRevision(snapshot), revision);
  assert.deepEqual(Object.keys(snapshot.store), ["page:test"]);
});

test("frozen shapeIds remain authoritative after the shared selection changes", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-frozen-selection-test-"));
  try {
    const initial = await getThinkingContext({ projectDir }, { scope: "page" });
    const created = await applyThinkingOperations(
      { projectDir },
      {
        baseRevision: initial.revision,
        operations: [
          { type: "create_card", key: "frozen", title: "Frozen selection" },
          { type: "create_card", key: "live", title: "Later shared selection" },
        ],
      },
    );
    const frozenId = created.references.frozen;
    const liveId = created.references.live;
    await writeCowartSelectionState(
      { projectDir },
      { selectedShapes: [{ id: frozenId }], updatedAt: new Date().toISOString() },
    );
    const frozenShapeIds = [frozenId];

    await writeCowartSelectionState(
      { projectDir },
      { selectedShapes: [{ id: liveId }], updatedAt: new Date().toISOString() },
    );
    const explicitContext = await getThinkingContext(
      { projectDir },
      { scope: "selection", shapeIds: frozenShapeIds },
    );
    assert.deepEqual(explicitContext.selection, [frozenId]);
    assert.deepEqual(explicitContext.shapes.map(({ id }) => id), [frozenId]);

    const sharedContext = await getThinkingContext({ projectDir }, { scope: "selection" });
    assert.deepEqual(sharedContext.selection, [liveId]);
    assert.deepEqual(sharedContext.shapes.map(({ id }) => id), [liveId]);

    await writeFile(path.join(projectDir, "canvas", "cowart-selection.json"), "{not-valid-json", "utf8");
    const contextWithoutSelectionRead = await getThinkingContext(
      { projectDir },
      { scope: "selection", shapeIds: frozenShapeIds },
    );
    assert.deepEqual(contextWithoutSelectionRead.shapes.map(({ id }) => id), [frozenId]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("refuses silent edits and deletes of user-authored content", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    operations: [
      {
        type: "create_card",
        key: "material",
        role: "material",
        generated: false,
        title: "Original material",
      },
    ],
  });
  const materialId = created.references.material;

  assert.throws(
    () =>
      applyThinkingOperationsToSnapshot({
        snapshot: created.snapshot,
        operations: [{ type: "delete_shape", id: materialId }],
      }),
    /Refusing to delete non-agent shape/,
  );

  const manualSnapshot = structuredClone(created.snapshot);
  delete manualSnapshot.store[materialId].meta.cowartThinkingCard;
  delete manualSnapshot.store[materialId].meta.cowartThinkingGenerated;
  assert.throws(
    () =>
      applyThinkingOperationsToSnapshot({
        snapshot: manualSnapshot,
        operations: [{ type: "update_card", id: materialId, body: "Changed" }],
      }),
    /allowUserAuthoredEdits/,
  );
  assert.throws(
    () =>
      applyThinkingOperationsToSnapshot({
        snapshot: manualSnapshot,
        operations: [{ type: "move_shape", id: materialId, x: 200, y: 100 }],
      }),
    /allowUserAuthoredEdits/,
  );
  assert.throws(
    () =>
      applyThinkingOperationsToSnapshot({
        snapshot: manualSnapshot,
        operations: [{ type: "resize_shape", id: materialId, w: 500, h: 240 }],
      }),
    /allowUserAuthoredEdits/,
  );
});

test("allows explicit user-authored text edits and guarded agent deletes", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    operations: [{ type: "create_card", key: "idea", role: "idea", title: "Draft idea" }],
  });
  const ideaId = created.references.idea;
  const manualSnapshot = structuredClone(created.snapshot);
  delete manualSnapshot.store[ideaId].meta.cowartThinkingCard;

  const updated = applyThinkingOperationsToSnapshot({
    snapshot: manualSnapshot,
    allowUserAuthoredEdits: true,
    operations: [{ type: "update_card", id: ideaId, title: "Reframed idea", body: "New body" }],
  });
  assert.equal(updated.snapshot.store[ideaId].meta.cowartThinkingTitle, "Reframed idea");

  const deleted = applyThinkingOperationsToSnapshot({
    snapshot: updated.snapshot,
    operations: [{ type: "delete_shape", id: ideaId }],
  });
  assert.equal(deleted.snapshot.store[ideaId], undefined);
  validateSnapshot(deleted.snapshot);
});

test("snapshot revisions change only when canvas records change", () => {
  const initial = emptySnapshot();
  const cloned = structuredClone(initial);
  assert.equal(snapshotRevision(initial), snapshotRevision(cloned));

  const created = applyThinkingOperationsToSnapshot({
    snapshot: initial,
    operations: [{ type: "create_card", role: "question", title: "What is missing?" }],
  });
  assert.notEqual(snapshotRevision(initial), snapshotRevision(created.snapshot));
});

test("preserves live canvas text when a later Agent update changes only style or semantics", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    semanticDiagram: semanticDiagram("native:live-text"),
    operations: [
      {
        type: "create_card",
        key: "editable",
        title: "旧标题",
        body: "旧正文",
        semantic: { id: "object:editable", type: "concept" },
      },
    ],
  });
  const cardId = created.references.editable;
  const manuallyEdited = structuredClone(created.snapshot);
  manuallyEdited.store[cardId].props.richText = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "用户标题", marks: [{ type: "bold" }] }],
      },
      { type: "paragraph" },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "用户正文第一行" },
          { type: "hardBreak" },
          { type: "text", text: "用户正文第二行", marks: [{ type: "italic" }] },
        ],
      },
    ],
  };
  const exactLiveRichText = structuredClone(manuallyEdited.store[cardId].props.richText);

  const beforeUpdate = summarizeThinkingContext({ snapshot: manuallyEdited, scope: "page" })
    .shapes.find(({ id }) => id === cardId);
  assert.equal(beforeUpdate.title, "用户标题");
  assert.equal(beforeUpdate.text, "用户正文第一行\n用户正文第二行");

  const updated = applyThinkingOperationsToSnapshot({
    snapshot: manuallyEdited,
    semanticDiagram: semanticDiagram("native:live-text"),
    operations: [
      {
        type: "update_card",
        id: cardId,
        color: "orange",
        semantic: { state: "warning" },
      },
    ],
  });
  const card = updated.snapshot.store[cardId];
  assert.equal(card.meta.cowartThinkingTitle, "用户标题");
  assert.equal(card.meta.cowartThinkingBody, "用户正文第一行\n用户正文第二行");
  assert.deepEqual(card.props.richText, exactLiveRichText);
  assert.equal(card.props.color, "orange");
  assert.doesNotThrow(() => validateSnapshot(updated.snapshot));
});

test("treats a user-cleared card as authoritative during a later style-only update", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    operations: [{ type: "create_card", key: "clear-me", title: "旧标题", body: "旧正文" }],
  });
  const cardId = created.references["clear-me"];
  const manuallyCleared = structuredClone(created.snapshot);
  manuallyCleared.store[cardId].props.richText = toRichText("");
  const exactEmptyRichText = structuredClone(manuallyCleared.store[cardId].props.richText);

  const updated = applyThinkingOperationsToSnapshot({
    snapshot: manuallyCleared,
    operations: [{ type: "update_card", id: cardId, fill: "hachure" }],
  });
  const card = updated.snapshot.store[cardId];
  assert.equal(card.meta.cowartThinkingTitle, "");
  assert.equal(card.meta.cowartThinkingBody, "");
  assert.deepEqual(card.props.richText, exactEmptyRichText);
  assert.equal(card.props.fill, "pattern");
  assert.doesNotThrow(() => validateSnapshot(updated.snapshot));
});

test("an MCP-shaped request can atomically create the first card on empty storage", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-thinking-empty-cas-"));
  try {
    const initial = await getThinkingContext({ projectDir }, { scope: "page" });
    const input = {
      projectDir,
      baseRevision: initial.revision,
      operations: [{ type: "create_card", role: "question", title: "First persisted card" }],
    };

    const applied = await applyThinkingOperations(input, input);
    assert.equal(applied.applied, true);
    assert.notEqual(applied.resultRevision, initial.revision);
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).shapes.length, 1);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("persistent operation previews, applies, and undoes without overwriting later work", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-thinking-test-"));
  try {
    const initial = await getThinkingContext({ projectDir }, { scope: "page" });
    const options = {
      baseRevision: initial.revision,
      operations: [{ type: "create_card", role: "question", title: "What should change?" }],
      reason: "Test reversible thinking operation",
      explanation: "Adds one question card.",
    };

    const preview = await applyThinkingOperations({ projectDir }, { ...options, dryRun: true });
    assert.equal(preview.applied, false);
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).revision, initial.revision);

    const applied = await applyThinkingOperations({ projectDir }, options);
    assert.equal(applied.applied, true);
    assert.notEqual(applied.resultRevision, initial.revision);
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).shapes.length, 1);

    await assert.rejects(
      applyThinkingOperations({ projectDir }, options),
      /Canvas revision changed/,
    );

    const later = await applyThinkingOperations(
      { projectDir },
      {
        baseRevision: applied.resultRevision,
        operations: [{ type: "create_card", role: "insight", title: "Later canvas work" }],
      },
    );
    await assert.rejects(
      undoThinkingOperation({ projectDir }, { operationId: applied.operationId }),
      /Refusing stale undo/,
    );
    await undoThinkingOperation({ projectDir }, { operationId: later.operationId });

    const undone = await undoThinkingOperation({ projectDir }, { operationId: applied.operationId });
    assert.equal(undone.revision, initial.revision);
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).shapes.length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("product zone dry runs do not write and applied zones undo to the prior revision", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-zone-test-"));
  try {
    const initial = await getThinkingContext({ projectDir }, { scope: "page" });
    const options = {
      baseRevision: initial.revision,
      operations: [
        {
          type: "create_zone",
          key: "prototype-review",
          title: "Prototype review",
          body: "Review annotated screens before syncing them back.",
          x: 120,
          y: 80,
          w: 1_000,
          h: 700,
          sourceRefs: ["tapd:12345"],
          bridge: {
            workspaceId: "workspace:review",
            requirementIds: ["REQ-12345"],
            lastSyncedRevision: "sync:preview",
          },
        },
      ],
      reason: "Create a reviewable product zone",
    };

    const preview = await applyThinkingOperations({ projectDir }, { ...options, dryRun: true });
    assert.equal(preview.applied, false);
    assert.match(preview.references["prototype-review"], /^shape:cowart-zone-/);
    const afterPreview = await getThinkingContext({ projectDir }, { scope: "page" });
    assert.equal(afterPreview.revision, initial.revision);
    assert.equal(afterPreview.shapes.length, 0);

    const applied = await applyThinkingOperations({ projectDir }, options);
    assert.equal(applied.applied, true);
    const afterApply = await getThinkingContext({ projectDir }, { scope: "page" });
    assert.equal(afterApply.shapes.length, 1);
    assert.equal(afterApply.shapes[0].role, "zone");
    assert.equal(afterApply.shapes[0].bridge.zoneId, "prototype-review");
    assert.notEqual(afterApply.revision, initial.revision);

    const undone = await undoThinkingOperation({ projectDir }, { operationId: applied.operationId });
    assert.equal(undone.revision, initial.revision);
    const afterUndo = await getThinkingContext({ projectDir }, { scope: "page" });
    assert.equal(afterUndo.shapes.length, 0);
    assert.equal(afterUndo.revision, initial.revision);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("material import copies the source and exposes provenance in compact context", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-material-test-"));
  try {
    const sourcePath = path.join(projectDir, "interview-notes.md");
    await writeFile(sourcePath, "Users want to see evidence beside each conclusion.\n", "utf8");
    const initial = await getThinkingContext({ projectDir }, { scope: "page" });
    const imported = await importThinkingMaterial(
      { projectDir },
      {
        sourcePath,
        baseRevision: initial.revision,
        excerpt: "Users want to see evidence beside each conclusion.",
        summary: "Research note about visible provenance.",
      },
    );

    assert.equal(imported.applied, true);
    assert.equal(imported.copied, true);
    assert.equal(await readFile(imported.source.localPath, "utf8"), await readFile(sourcePath, "utf8"));

    const context = await getThinkingContext({ projectDir }, { scope: "page" });
    assert.equal(context.shapes.length, 1);
    assert.equal(context.shapes[0].role, "material");
    assert.equal(context.shapes[0].source.originalPath, sourcePath);
    assert.equal(context.shapes[0].source.localPath, imported.source.localPath);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
