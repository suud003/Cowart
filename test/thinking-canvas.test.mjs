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
    /Product zone key already exists/,
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
    { id: zoneId, key: "requirements" },
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
