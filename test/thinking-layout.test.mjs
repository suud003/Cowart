import assert from "node:assert/strict";
import test from "node:test";

import { Store } from "@tldraw/store";
import { createTLSchema } from "@tldraw/tlschema";

import {
  applyThinkingOperationsToSnapshot,
  summarizeThinkingContext,
} from "../mcp/lib/thinking-canvas.mjs";
import {
  estimateThinkingCardSize,
  estimateThinkingRelationGap,
  layoutThinkingGraph,
} from "../mcp/lib/thinking-layout.mjs";

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

function relationBindings(snapshot, relationId) {
  return Object.values(snapshot.store).filter(
    (record) => record?.typeName === "binding" && record.type === "arrow" && record.fromId === relationId,
  );
}

function boundsOverlap(first, second) {
  return !(
    first.x + first.props.w <= second.x ||
    second.x + second.props.w <= first.x ||
    first.y + first.props.h <= second.y ||
    second.y + second.props.h <= first.y
  );
}

function semanticDiagram(overrides = {}) {
  return {
    version: "1",
    diagramId: "native:layout-regression",
    teachingClaim: "Relations stay readable and attached while the diagram changes.",
    readingOrder: "left-to-right",
    diagramType: "flow",
    ...overrides,
  };
}

test("sizes concise concepts and detailed cards to their content", () => {
  const concept = estimateThinkingCardSize({ title: "470 AI 助手" });
  const detail = estimateThinkingCardSize({
    title: "可视化",
    body: "识别选中的积木与逻辑块，并将变量、函数和场景物件组织成可读结构。",
  });

  assert.equal(concept.h, 96);
  assert.ok(concept.w >= 180 && concept.w < detail.w);
  assert.ok(detail.h > concept.h);
  assert.ok(detail.w <= 560);
});

test("lays a connected graph out from top to bottom", () => {
  const positions = layoutThinkingGraph({
    nodes: [
      { id: "root", w: 220, h: 96 },
      { id: "left", w: 220, h: 96 },
      { id: "right", w: 220, h: 96 },
      { id: "detail", w: 440, h: 160 },
    ],
    edges: [
      { from: "root", to: "left" },
      { from: "root", to: "right" },
      { from: "left", to: "detail" },
    ],
  });

  assert.ok(positions.get("root").y < positions.get("left").y);
  assert.equal(positions.get("left").y, positions.get("right").y);
  assert.notEqual(positions.get("left").x, positions.get("right").x);
  assert.ok(positions.get("left").y < positions.get("detail").y);
});

test("lays cycles deterministically and mirrors horizontal reading order", () => {
  const nodes = [
    { id: "a", w: 200, h: 96 },
    { id: "b", w: 220, h: 96 },
    { id: "c", w: 240, h: 96 },
  ];
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
    { from: "b", to: "c" },
  ];
  const leftToRight = layoutThinkingGraph({ nodes, edges, readingOrder: "left-to-right" });
  const rightToLeft = layoutThinkingGraph({ nodes, edges, readingOrder: "right-to-left" });

  assert.equal(
    leftToRight.get("a").x + nodes[0].w / 2,
    leftToRight.get("b").x + nodes[1].w / 2,
  );
  assert.ok(leftToRight.get("b").x < leftToRight.get("c").x);
  assert.ok(rightToLeft.get("b").x > rightToLeft.get("c").x);
  assert.notEqual(leftToRight.get("a").y, leftToRight.get("b").y);
});

test("lays a hub-and-spoke graph out deterministically from the center", () => {
  const nodes = [
    { id: "hub", w: 220, h: 96 },
    { id: "a", w: 180, h: 96 },
    { id: "b", w: 180, h: 96 },
    { id: "c", w: 180, h: 96 },
    { id: "d", w: 180, h: 96 },
  ];
  const edges = ["a", "b", "c", "d"].map((to) => ({ from: "hub", to }));
  const centerOut = layoutThinkingGraph({ nodes, edges, readingOrder: "center-out" });
  const repeated = layoutThinkingGraph({ nodes, edges, readingOrder: "center-out" });
  const topToBottom = layoutThinkingGraph({ nodes, edges, readingOrder: "top-to-bottom" });
  const center = (id) => ({
    x: centerOut.get(id).x + nodes.find((node) => node.id === id).w / 2,
    y: centerOut.get(id).y + nodes.find((node) => node.id === id).h / 2,
  });
  const hub = center("hub");

  assert.deepEqual(centerOut, repeated);
  assert.ok(center("a").x > hub.x);
  assert.ok(center("b").y > hub.y);
  assert.ok(center("c").x < hub.x);
  assert.ok(center("d").y < hub.y);
  assert.ok(topToBottom.get("hub").y < topToBottom.get("d").y);
  assert.ok(centerOut.get("hub").y > centerOut.get("d").y);
  for (let first = 0; first < nodes.length; first += 1) {
    for (let second = first + 1; second < nodes.length; second += 1) {
      const firstNode = { ...nodes[first], ...centerOut.get(nodes[first].id), props: nodes[first] };
      const secondNode = { ...nodes[second], ...centerOut.get(nodes[second].id), props: nodes[second] };
      assert.equal(boundsOverlap(firstNode, secondNode), false);
    }
  }
});

test("keeps a strongly connected component aligned at the center-out focus", () => {
  const nodes = [
    { id: "upstream", w: 180, h: 96 },
    { id: "cycle-a", w: 200, h: 96 },
    { id: "cycle-b", w: 240, h: 112 },
    { id: "downstream", w: 180, h: 96 },
  ];
  const edges = [
    { from: "upstream", to: "cycle-a" },
    { from: "cycle-a", to: "cycle-b" },
    { from: "cycle-b", to: "cycle-a" },
    { from: "cycle-b", to: "downstream" },
  ];
  const positions = layoutThinkingGraph({ nodes, edges, readingOrder: "center-out" });
  const centerX = (id) => positions.get(id).x + nodes.find((node) => node.id === id).w / 2;

  assert.equal(centerX("cycle-a"), centerX("cycle-b"));
  assert.notEqual(positions.get("cycle-a").y, positions.get("cycle-b").y);
  assert.ok(centerX("upstream") > centerX("cycle-a"));
  assert.ok(centerX("downstream") < centerX("cycle-a"));
});

test("creates a native semantic diagram with editable zones, relation grammar, and trace metadata", () => {
  const semanticDiagram = {
    version: "1",
    diagramId: "native:film-loop",
    teachingClaim: "Player choices update world state before the next scene is generated.",
    readingOrder: "left-to-right",
    diagramType: "flow",
    sourceShapeIds: ["shape:brief"],
  };
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram,
    operations: [
      {
        type: "create_zone",
        key: "film-loop",
        title: "AI 互动影游循环",
        purpose: "semantic",
        semantic: { id: "object:loop", type: "group", origin: "synthesis" },
      },
      {
        type: "create_card",
        key: "choice",
        title: "玩家选择",
        parentZoneId: "film-loop",
        semantic: { id: "object:choice", type: "actor", origin: "source", order: 1 },
      },
      {
        type: "create_card",
        key: "state",
        title: "世界状态",
        parentZoneId: "film-loop",
        semantic: { id: "object:state", type: "state", origin: "synthesis", order: 2 },
      },
      {
        type: "create_card",
        key: "scene",
        title: "生成下一幕",
        parentZoneId: "film-loop",
        semantic: { id: "object:scene", type: "process", origin: "inference", order: 3 },
      },
      {
        type: "create_relation",
        key: "choice-state",
        semanticId: "relation:choice-state",
        from: "choice",
        to: "state",
        kind: "flow",
        direction: "forward",
        path: "primary",
      },
      {
        type: "create_relation",
        key: "state-scene-alternative",
        semanticId: "relation:state-scene-alternative",
        from: "state",
        to: "scene",
        kind: "transition",
        direction: "forward",
        path: "alternative",
        label: "候选分支",
      },
      {
        type: "create_relation",
        key: "scene-state-sync",
        semanticId: "relation:scene-state-sync",
        from: "scene",
        to: "state",
        kind: "sync",
        direction: "bidirectional",
      },
      {
        type: "create_relation",
        key: "choice-scene-association",
        semanticId: "relation:choice-scene-association",
        from: "choice",
        to: "scene",
        kind: "association",
        direction: "none",
      },
    ],
  });

  const zone = result.snapshot.store[result.references["film-loop"]];
  const choice = result.snapshot.store[result.references.choice];
  const state = result.snapshot.store[result.references.state];
  const scene = result.snapshot.store[result.references.scene];
  const primary = result.snapshot.store[result.references["choice-state"]];
  const alternative = result.snapshot.store[result.references["state-scene-alternative"]];
  const sync = result.snapshot.store[result.references["scene-state-sync"]];
  const association = result.snapshot.store[result.references["choice-scene-association"]];

  assert.equal(zone.meta.cowartSemanticZone, true);
  assert.equal(zone.meta.cowartProductZone, false);
  assert.equal(choice.parentId, zone.id);
  assert.ok(choice.x < state.x && choice.x < scene.x);
  assert.equal(state.x + state.props.w / 2, scene.x + scene.props.w / 2);
  assert.notEqual(state.y, scene.y);
  assert.equal(choice.meta.cowartSemanticObject.semanticId, "object:choice");
  assert.equal(choice.meta.cowartSemanticDiagram.diagramId, "native:film-loop");
  assert.equal(primary.props.color, "black");
  assert.equal(primary.props.dash, "draw");
  assert.equal(primary.props.arrowheadStart, "none");
  assert.equal(primary.props.arrowheadEnd, "arrow");
  assert.equal(alternative.props.dash, "dashed");
  assert.equal(sync.props.arrowheadStart, "arrow");
  assert.equal(sync.props.arrowheadEnd, "arrow");
  assert.equal(association.props.color, "black");
  assert.equal(association.props.arrowheadEnd, "none");
  assert.equal(
    Object.values(result.snapshot.store).some((record) => record?.meta?.cowartHtmlDraft === true),
    false,
  );
  assert.doesNotThrow(() => {
    const validationStore = new Store({ schema: createTLSchema(), props: { defaultName: "Test" } });
    validationStore.loadStoreSnapshot(result.snapshot);
  });
});

test("recomputes binding anchors after vertical layout and reserves label space", () => {
  const label = "写入状态变化并生成下一幕";
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ readingOrder: "top-to-bottom" }),
    operations: [
      { type: "create_card", key: "source", title: "AI 导演", semantic: { id: "object:source" } },
      { type: "create_card", key: "target", title: "状态账本", semantic: { id: "object:target" } },
      {
        type: "create_relation",
        key: "source-target",
        semanticId: "relation:source-target",
        from: "source",
        to: "target",
        label,
      },
    ],
  });
  const source = result.snapshot.store[result.references.source];
  const target = result.snapshot.store[result.references.target];
  const relationId = result.references["source-target"];
  const bindings = relationBindings(result.snapshot, relationId);
  const start = bindings.find((binding) => binding.props.terminal === "start");
  const end = bindings.find((binding) => binding.props.terminal === "end");

  assert.ok(source.y < target.y);
  assert.ok(target.y - (source.y + source.props.h) >= estimateThinkingRelationGap(label));
  assert.deepEqual(start.props.normalizedAnchor, { x: 0.5, y: 1 });
  assert.deepEqual(end.props.normalizedAnchor, { x: 0.5, y: 0 });
});

test("keeps association and bidirectional peers in one readable semantic layer", () => {
  for (const direction of ["none", "bidirectional"]) {
    const label = direction === "none" ? "共享长期上下文关联" : "双向同步创作状态";
    const result = applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: semanticDiagram({ diagramId: `native:${direction}` }),
      operations: [
        { type: "create_card", key: "first", title: "First", semantic: { id: "object:first" } },
        { type: "create_card", key: "second", title: "Second", semantic: { id: "object:second" } },
        {
          type: "create_relation",
          key: "peer-relation",
          semanticId: "relation:peer",
          from: "first",
          to: "second",
          direction,
          label,
        },
      ],
    });
    const first = result.snapshot.store[result.references.first];
    const second = result.snapshot.store[result.references.second];
    assert.equal(first.x + first.props.w / 2, second.x + second.props.w / 2);
    assert.ok(Math.abs(second.y - first.y) >= Math.min(first.props.h, second.props.h) + estimateThinkingRelationGap(label));
  }
});

test("keeps fixed and incremental semantic cards out of existing sibling bounds", () => {
  const first = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram(),
    operations: [
      { type: "create_zone", key: "zone", title: "Semantic zone", purpose: "semantic", semantic: { id: "object:zone" } },
      {
        type: "create_card",
        key: "fixed",
        title: "Fixed",
        parentZoneId: "zone",
        x: 40,
        y: 72,
        semantic: { id: "object:fixed" },
      },
      { type: "create_card", key: "a", title: "A", parentZoneId: "zone", semantic: { id: "object:a" } },
      { type: "create_card", key: "b", title: "B", parentZoneId: "zone", semantic: { id: "object:b" } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
    ],
  });
  const zoneId = first.references.zone;
  const firstCards = ["fixed", "a", "b"].map((key) => first.snapshot.store[first.references[key]]);
  for (let left = 0; left < firstCards.length; left += 1) {
    for (let right = left + 1; right < firstCards.length; right += 1) {
      assert.equal(boundsOverlap(firstCards[left], firstCards[right]), false);
    }
  }

  const second = applyThinkingOperationsToSnapshot({
    snapshot: first.snapshot,
    pageId: "page:test",
    semanticDiagram: semanticDiagram(),
    operations: [
      { type: "create_card", key: "c", title: "C", parentZoneId: zoneId, semantic: { id: "object:c" } },
      { type: "create_card", key: "d", title: "D", parentZoneId: zoneId, semantic: { id: "object:d" } },
      { type: "create_relation", key: "c-d", semanticId: "relation:c-d", from: "c", to: "d" },
    ],
  });
  const oldCards = ["fixed", "a", "b"].map((key) => second.snapshot.store[first.references[key]]);
  const newCards = ["c", "d"].map((key) => second.snapshot.store[second.references[key]]);
  for (const oldCard of oldCards) {
    for (const newCard of newCards) assert.equal(boundsOverlap(oldCard, newCard), false);
  }

  const relationBeforeMove = second.snapshot.store[second.references["c-d"]];
  const moved = applyThinkingOperationsToSnapshot({
    snapshot: second.snapshot,
    pageId: "page:test",
    operations: [{ type: "move_shape", id: zoneId, x: 500, y: 300 }],
  });
  assert.equal(moved.snapshot.store[second.references["c-d"]].x - relationBeforeMove.x, 500);

  const deleted = applyThinkingOperationsToSnapshot({
    snapshot: moved.snapshot,
    pageId: "page:test",
    operations: [{ type: "delete_shape", id: zoneId }],
  });
  assert.equal(Object.values(deleted.snapshot.store).some((record) => record?.type === "arrow"), false);
  assert.equal(Object.values(deleted.snapshot.store).some((record) => record?.typeName === "binding"), false);
});

test("refreshes relation geometry when an endpoint crosses its target", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:move" }),
    operations: [
      { type: "create_card", key: "a", title: "A", x: 0, y: 0, semantic: { id: "object:a" } },
      { type: "create_card", key: "b", title: "B", x: 500, y: 0, semantic: { id: "object:b" } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
    ],
  });
  const moved = applyThinkingOperationsToSnapshot({
    snapshot: created.snapshot,
    pageId: "page:test",
    operations: [{ type: "move_shape", id: created.references.a, x: 900, y: 0 }],
  });
  const relationId = created.references["a-b"];
  const relation = moved.snapshot.store[relationId];
  const source = moved.snapshot.store[created.references.a];
  const bindings = relationBindings(moved.snapshot, relationId);
  assert.equal(relation.x, source.x + source.props.w / 2);
  assert.ok(relation.props.end.x < 0);
  assert.deepEqual(bindings.find((binding) => binding.props.terminal === "start").props.normalizedAnchor, { x: 0, y: 0.5 });
  assert.deepEqual(bindings.find((binding) => binding.props.terminal === "end").props.normalizedAnchor, { x: 1, y: 0.5 });
});

test("requires semantic relation endpoints to be objects in the same diagram", () => {
  const ordinary = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    operations: [{ type: "create_card", key: "ordinary", title: "Ordinary" }],
  });
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: ordinary.snapshot,
      pageId: "page:test",
      semanticDiagram: semanticDiagram({ diagramId: "native:endpoints" }),
      operations: [
        { type: "create_card", key: "semantic", title: "Semantic", semantic: { id: "object:semantic" } },
        {
          type: "create_relation",
          key: "invalid",
          semanticId: "relation:invalid",
          from: "semantic",
          to: ordinary.references.ordinary,
        },
      ],
    }),
    /must reference a native semantic object/,
  );

  const firstDiagram = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:first" }),
    operations: [{ type: "create_card", key: "first", title: "First", semantic: { id: "object:first" } }],
  });
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: firstDiagram.snapshot,
      pageId: "page:test",
      semanticDiagram: semanticDiagram({ diagramId: "native:second" }),
      operations: [
        { type: "create_card", key: "second", title: "Second", semantic: { id: "object:second" } },
        {
          type: "create_relation",
          key: "cross-diagram",
          semanticId: "relation:cross-diagram",
          from: "second",
          to: firstDiagram.references.first,
        },
      ],
    }),
    /must reference a semantic object in diagram native:second/,
  );
});

test("allocates unique lanes for parallel and reversed endpoint pairs", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:parallel" }),
    operations: [
      { type: "create_card", key: "a", title: "A", semantic: { id: "object:a" } },
      { type: "create_card", key: "b", title: "B", semantic: { id: "object:b" } },
      { type: "create_relation", key: "forward", semanticId: "relation:forward", from: "a", to: "b", lane: 0 },
      { type: "create_relation", key: "reverse", semanticId: "relation:reverse", from: "b", to: "a", lane: 0 },
      { type: "create_relation", key: "third", semanticId: "relation:third", from: "a", to: "b" },
    ],
  });
  const relations = ["forward", "reverse", "third"].map((key) => result.snapshot.store[result.references[key]]);
  const lanes = relations.map((relation) => relation.meta.cowartSemanticRelation.lane);
  assert.equal(new Set(lanes).size, 3);
  assert.equal(lanes[0], 0);
  assert.ok(relations.slice(1).every((relation) => relation.props.bend !== 0));
});

test("routes a semantic skip edge outside unrelated cards", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:skip-edge" }),
    operations: [
      { type: "create_card", key: "a", title: "A", semantic: { id: "object:a", order: 1 } },
      { type: "create_card", key: "b", title: "B", semantic: { id: "object:b", order: 2 } },
      { type: "create_card", key: "c", title: "C", semantic: { id: "object:c", order: 3 } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
      { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: "b", to: "c" },
      { type: "create_relation", key: "a-c", semanticId: "relation:a-c", from: "a", to: "c" },
    ],
  });
  const middle = result.snapshot.store[result.references.b];
  const skip = result.snapshot.store[result.references["a-c"]];
  assert.notEqual(skip.meta.cowartSemanticRelation.lane, 0);
  assert.ok(Math.abs(skip.props.bend) > middle.props.h / 2 + 18);
  assert.deepEqual(skip.meta.cowartThinkingObstacleRoute.obstacleShapeIds, [middle.id]);
});

test("fits an html-line-svg semantic chain to its target frame instead of clustering at the top left", () => {
  const requestedZone = { x: 120, y: 80, w: 1_600, h: 500 };
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({
      diagramId: "ac-diagram:111111111111:222222222222",
      layoutEngine: "html-line-svg",
      layoutMode: "balanced",
      layoutFit: "fixed",
    }),
    operations: [
      { type: "create_zone", key: "zone", title: "Core loop", purpose: "semantic", ...requestedZone, semantic: { id: "object:zone" } },
      { type: "create_card", key: "a", title: "Observe", parentZoneId: "zone", semantic: { id: "object:a", order: 1 } },
      { type: "create_card", key: "b", title: "Decide", parentZoneId: "zone", semantic: { id: "object:b", order: 2 } },
      { type: "create_card", key: "c", title: "Act", parentZoneId: "zone", semantic: { id: "object:c", order: 3 } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
      { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: "b", to: "c" },
    ],
  });
  const zone = result.snapshot.store[result.references.zone];
  const cards = ["a", "b", "c"].map((key) => result.snapshot.store[result.references[key]]);
  const pageBounds = cards.map((card) => ({
    x: zone.x + card.x,
    y: zone.y + card.y,
    w: card.props.w,
    h: card.props.h,
  }));
  const left = Math.min(...pageBounds.map(({ x }) => x));
  const right = Math.max(...pageBounds.map(({ x, w }) => x + w));
  const top = Math.min(...pageBounds.map(({ y }) => y));
  const bottom = Math.max(...pageBounds.map(({ y, h }) => y + h));

  assert.equal(zone.meta.cowartSemanticLayout.engine, "html-line-svg");
  assert.equal(zone.meta.cowartSemanticLayout.valid, true);
  assert.equal(result.layoutReport.engine, "html-line-svg");
  assert.equal(result.layoutReport.layoutApplied, true);
  assert.equal(result.layoutReport.valid, true);
  assert.deepEqual(result.layoutReport.collisions, []);
  assert.deepEqual(result.layoutReport.outOfBounds, []);
  assert.match(result.layoutReport.layoutDigest, /^[0-9a-f]{64}$/u);
  assert.ok(right - left > 1_150, "balanced layout should use the available horizontal slot");
  assert.ok(Math.abs((left + right) / 2 - (requestedZone.x + requestedZone.w / 2)) < 1);
  const requestedContentCenterY = requestedZone.y + 72 + (requestedZone.h - 112) / 2;
  assert.ok(Math.abs((top + bottom) / 2 - requestedContentCenterY) < 1);
  assert.deepEqual(
    { x: zone.x, y: zone.y, w: zone.props.w, h: zone.props.h },
    requestedZone,
    "a fixed semantic slot must retain its validated frame",
  );
});

test("allocates distinct boundary ports for semantic fan-out", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:fan-out" }),
    operations: [
      { type: "create_card", key: "hub", title: "Hub", semantic: { id: "object:hub", order: 1 } },
      ...["top", "middle", "bottom"].map((key, index) => ({
        type: "create_card",
        key,
        title: key,
        semantic: { id: `object:${key}`, order: index + 2 },
      })),
      ...["top", "middle", "bottom"].map((key) => ({
        type: "create_relation",
        key: `hub-${key}`,
        semanticId: `relation:hub-${key}`,
        from: "hub",
        to: key,
      })),
    ],
  });
  const startFractions = ["top", "middle", "bottom"].map((key) => {
    const relationId = result.references[`hub-${key}`];
    return relationBindings(result.snapshot, relationId)
      .find((binding) => binding.props.terminal === "start").props.normalizedAnchor.y;
  });
  assert.equal(new Set(startFractions).size, 3);
  assert.deepEqual([...startFractions].sort((a, b) => a - b), [0.22, 0.5, 0.78]);
});

test("rejects overlapping explicit semantic nodes instead of committing tangled geometry", () => {
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: semanticDiagram({ diagramId: "native:explicit-collision" }),
      operations: [
        { type: "create_zone", key: "zone", title: "Collision", purpose: "semantic", w: 900, h: 600, semantic: { id: "object:zone" } },
        { type: "create_card", key: "a", title: "A", parentZoneId: "zone", x: 180, y: 180, semantic: { id: "object:a" } },
        { type: "create_card", key: "b", title: "B", parentZoneId: "zone", x: 180, y: 180, semantic: { id: "object:b" } },
      ],
    }),
    /SEMANTIC_GEOMETRY.*collisions: object:a\/object:b/,
  );
});

test("rejects fixed semantic slot overflow instead of silently growing its frame", () => {
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: semanticDiagram({
        diagramId: "ac-diagram:aaaaaaaaaaaa:bbbbbbbbbbbb",
        layoutFit: "fixed",
      }),
      operations: [
        { type: "create_zone", key: "zone", title: "Too dense", purpose: "semantic", x: 0, y: 0, w: 480, h: 320, semantic: { id: "object:zone" } },
        ...["a", "b", "c", "d"].map((key, index) => ({
          type: "create_card",
          key,
          title: key.toUpperCase(),
          parentZoneId: "zone",
          semantic: { id: `object:${key}`, order: index + 1 },
        })),
        { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
        { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: "b", to: "c" },
        { type: "create_relation", key: "c-d", semanticId: "relation:c-d", from: "c", to: "d" },
      ],
    }),
    /LAYOUT_CAPACITY.*cannot fit its fixed/,
  );
});

test("requires canonical IDs and explicit validated slot geometry for auto-compose diagrams", () => {
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: semanticDiagram({ diagramId: "ac-diagram:aaaaaaaaaaaa:not-a-digest" }),
      operations: [
        { type: "create_zone", key: "zone", title: "Invalid", purpose: "semantic", x: 0, y: 0, w: 900, h: 500, semantic: { id: "object:zone" } },
      ],
    }),
    /AUTO_COMPOSE_LAYOUT_CONTRACT.*12 lowercase hex/,
  );
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: semanticDiagram({ diagramId: "ac-diagram:abababababab:cdcdcdcdcdcd" }),
      operations: [
        { type: "create_zone", key: "zone", title: "Missing slot", purpose: "semantic", w: 900, h: 500, semantic: { id: "object:zone" } },
        { type: "create_card", key: "a", title: "A", parentZoneId: "zone", semantic: { id: "object:a" } },
      ],
    }),
    /AUTO_COMPOSE_LAYOUT_CONTRACT.*explicit x, y, w, and h/,
  );
});

test("rejects manual placement and split batches for fixed auto-compose diagrams", () => {
  const diagram = semanticDiagram({
    diagramId: "ac-diagram:dddddddddddd:eeeeeeeeeeee",
    layoutEngine: "html-line-svg",
    layoutMode: "balanced",
    layoutFit: "fixed",
  });
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: diagram,
      operations: [
        { type: "create_zone", key: "zone", title: "Fixed", purpose: "semantic", x: 100, y: 100, w: 480, h: 320, semantic: { id: "object:zone" } },
        { type: "create_card", key: "outside", title: "Outside", parentZoneId: "zone", x: 1_000, y: 700, semantic: { id: "object:outside" } },
      ],
    }),
    /AUTO_COMPOSE_LAYOUT_CONTRACT.*must omit x, y, anchorId, placement, and gap/,
  );
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: diagram,
      operations: [
        { type: "create_zone", key: "anchor-zone", title: "Fixed", purpose: "semantic", x: 100, y: 100, w: 480, h: 320, semantic: { id: "object:anchor-zone" } },
        { type: "create_card", key: "anchor", title: "Anchor", parentZoneId: "anchor-zone", x: 160, y: 200, semantic: { id: "object:anchor" } },
        { type: "create_card", key: "anchored", title: "Anchored", parentZoneId: "anchor-zone", anchorId: "anchor", gap: 600, semantic: { id: "object:anchored" } },
      ],
    }),
    /AUTO_COMPOSE_LAYOUT_CONTRACT.*must omit x, y, anchorId, placement, and gap/,
  );

  const initial = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: diagram,
    operations: [
      { type: "create_zone", key: "incremental-zone", title: "Fixed", purpose: "semantic", x: 0, y: 0, w: 900, h: 360, semantic: { id: "object:incremental-zone" } },
      { type: "create_card", key: "a", title: "A", parentZoneId: "incremental-zone", semantic: { id: "object:a", order: 1 } },
      { type: "create_card", key: "b", title: "B", parentZoneId: "incremental-zone", semantic: { id: "object:b", order: 2 } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
    ],
  });
  const updated = applyThinkingOperationsToSnapshot({
    snapshot: initial.snapshot,
    pageId: "page:test",
    semanticDiagram: diagram,
    operations: [
      { type: "update_card", id: initial.references.a, title: "A revised", semantic: { state: "success" } },
    ],
  });
  assert.equal(updated.layoutReport.layoutApplied, true);
  assert.equal(updated.layoutReport.valid, true);
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: initial.snapshot,
      pageId: "page:test",
      operations: [{ type: "move_shape", id: initial.references.a, x: 400, y: 200 }],
    }),
    /AUTO_COMPOSE_LAYOUT_CONTRACT.*cannot modify fixed diagram/,
  );
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: initial.snapshot,
      pageId: "page:test",
      semanticDiagram: diagram,
      operations: [
        { type: "create_card", key: "c", title: "C", parentZoneId: initial.references["incremental-zone"], semantic: { id: "object:c", order: 3 } },
        { type: "create_card", key: "d", title: "D", parentZoneId: initial.references["incremental-zone"], semantic: { id: "object:d", order: 4 } },
        { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: initial.references.b, to: "c" },
        { type: "create_relation", key: "c-d", semanticId: "relation:c-d", from: "c", to: "d" },
      ],
    }),
    /AUTO_COMPOSE_FIXED_RELAYOUT_REQUIRED.*cannot be extended incrementally/,
  );
  const unchangedZone = initial.snapshot.store[initial.references["incremental-zone"]];
  assert.deepEqual({ w: unchangedZone.props.w, h: unchangedZone.props.h }, { w: 900, h: 360 });
});

test("rejects relation crossings and relation labels over unrelated nodes", () => {
  const crossingDiagram = semanticDiagram({ diagramId: "native:crossing-report" });
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: crossingDiagram,
      operations: [
        { type: "create_zone", key: "zone", title: "Crossing", purpose: "semantic", w: 1_200, h: 800, semantic: { id: "object:zone" } },
        { type: "create_card", key: "a", title: "A", parentZoneId: "zone", x: 160, y: 180, semantic: { id: "object:a" } },
        { type: "create_card", key: "b", title: "B", parentZoneId: "zone", x: 160, y: 500, semantic: { id: "object:b" } },
        { type: "create_card", key: "c", title: "C", parentZoneId: "zone", x: 800, y: 180, semantic: { id: "object:c" } },
        { type: "create_card", key: "d", title: "D", parentZoneId: "zone", x: 800, y: 500, semantic: { id: "object:d" } },
        { type: "create_relation", key: "a-d", semanticId: "relation:a-d", from: "a", to: "d" },
        { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: "b", to: "c" },
      ],
    }),
    /SEMANTIC_GEOMETRY.*relation:a-d\/relation:b-c/,
  );

  const multilineLabel = Array.from({ length: 10 }, (_, index) => `retry condition ${index + 1}`).join("\n");
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: emptySnapshot(),
      pageId: "page:test",
      semanticDiagram: semanticDiagram({ diagramId: "native:label-node-report" }),
      operations: [
        { type: "create_zone", key: "zone", title: "Label", purpose: "semantic", w: 1_200, h: 800, semantic: { id: "object:zone" } },
        { type: "create_card", key: "loop", title: "Loop", parentZoneId: "zone", x: 300, y: 300, semantic: { id: "object:loop" } },
        { type: "create_card", key: "peer", title: "Peer", parentZoneId: "zone", x: 520, y: 300, semantic: { id: "object:peer" } },
        { type: "create_relation", key: "loop-relation", semanticId: "relation:loop", from: "loop", to: "loop", label: multilineLabel },
      ],
    }),
    /SEMANTIC_GEOMETRY.*relation:loop\/object:peer/,
  );
});

test("keeps keyless parallel relation ports and layout digests deterministic", () => {
  const diagram = semanticDiagram({ diagramId: "native:keyless-parallel" });
  const operations = [
    { type: "create_zone", key: "zone", title: "Parallel", purpose: "semantic", w: 1_000, h: 500, semantic: { id: "object:zone" } },
    { type: "create_card", key: "a", title: "A", parentZoneId: "zone", semantic: { id: "object:a", order: 1 } },
    { type: "create_card", key: "b", title: "B", parentZoneId: "zone", semantic: { id: "object:b", order: 2 } },
    { type: "create_relation", semanticId: "relation:first", from: "a", to: "b" },
    { type: "create_relation", semanticId: "relation:second", from: "a", to: "b" },
  ];
  const first = applyThinkingOperationsToSnapshot({ snapshot: emptySnapshot(), pageId: "page:test", semanticDiagram: diagram, operations });
  const second = applyThinkingOperationsToSnapshot({ snapshot: emptySnapshot(), pageId: "page:test", semanticDiagram: diagram, operations });
  const ports = (result) => result.layoutReport.relations.map(({ semanticId, ports: relationPorts }) => ({
    semanticId,
    ports: relationPorts,
  }));

  assert.equal(first.layoutReport.layoutDigest, second.layoutReport.layoutDigest);
  assert.deepEqual(ports(first), ports(second));
});

test("lays SCC cycles and wide fan-outs inside their unchanged fixed frames", () => {
  const cycleDiagram = semanticDiagram({
    diagramId: "ac-diagram:aaaaaaaaaaaa:cccccccccccc",
    layoutFit: "fixed",
  });
  const cycle = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: cycleDiagram,
    operations: [
      { type: "create_zone", key: "zone", title: "Cycle", purpose: "semantic", x: 0, y: 0, w: 900, h: 360, semantic: { id: "object:zone" } },
      ...["a", "b", "c"].map((key, index) => ({ type: "create_card", key, title: key.toUpperCase(), parentZoneId: "zone", semantic: { id: `object:${key}`, order: index + 1 } })),
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
      { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: "b", to: "c" },
      { type: "create_relation", key: "c-a", semanticId: "relation:c-a", from: "c", to: "a" },
    ],
  });
  const cycleZone = cycle.snapshot.store[cycle.references.zone];
  const cyclePositions = ["a", "b", "c"].map((key) => cycle.snapshot.store[cycle.references[key]]);
  assert.deepEqual({ w: cycleZone.props.w, h: cycleZone.props.h }, { w: 900, h: 360 });
  assert.ok(new Set(cyclePositions.map(({ x }) => x)).size > 1);
  assert.ok(new Set(cyclePositions.map(({ y }) => y)).size > 1);
  assert.equal(cycle.layoutReport.valid, true);

  const fanoutDiagram = semanticDiagram({
    diagramId: "ac-diagram:aaaaaaaaaaaa:ffffffffffff",
    readingOrder: "top-to-bottom",
    layoutFit: "fixed",
  });
  const fanout = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: fanoutDiagram,
    operations: [
      { type: "create_zone", key: "zone", title: "Fan-out", purpose: "semantic", x: 0, y: 0, w: 650, h: 600, semantic: { id: "object:zone" } },
      ...["hub", "a", "b", "c", "d", "e"].map((key, index) => ({ type: "create_card", key, title: key.toUpperCase(), parentZoneId: "zone", semantic: { id: `object:${key}`, order: index + 1 } })),
      ...["a", "b", "c", "d", "e"].map((to) => ({ type: "create_relation", key: `hub-${to}`, semanticId: `relation:hub-${to}`, from: "hub", to })),
    ],
  });
  const fanoutZone = fanout.snapshot.store[fanout.references.zone];
  const peerRows = new Set(["a", "b", "c", "d", "e"].map((key) => fanout.snapshot.store[fanout.references[key]].y));
  assert.deepEqual({ w: fanoutZone.props.w, h: fanoutZone.props.h }, { w: 650, h: 600 });
  assert.ok(peerRows.size > 1);
  assert.equal(fanout.layoutReport.valid, true);
  assert.deepEqual(fanout.layoutReport.collisions, []);
  assert.deepEqual(fanout.layoutReport.outOfBounds, []);
});

test("expands a semantic zone around obstacle-routed arcs and relation labels", () => {
  const initialZone = { x: 100, y: 100, w: 340, h: 1_500 };
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({
      diagramId: "native:contained-skip-edge",
      readingOrder: "top-to-bottom",
    }),
    operations: [
      {
        type: "create_zone",
        key: "zone",
        title: "Contained flow",
        purpose: "semantic",
        ...initialZone,
        semantic: { id: "object:zone" },
      },
      ...["a", "b", "c", "d"].map((key, index) => ({
        type: "create_card",
        key,
        title: key.toUpperCase(),
        parentZoneId: "zone",
        x: 160,
        y: 200 + index * 300,
        semantic: { id: `object:${key}`, order: index + 1 },
      })),
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
      { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: "b", to: "c" },
      { type: "create_relation", key: "c-d", semanticId: "relation:c-d", from: "c", to: "d" },
      {
        type: "create_relation",
        key: "a-d",
        semanticId: "relation:a-d",
        from: "a",
        to: "d",
        label: "跨层风险回流",
      },
    ],
  });
  const zone = result.snapshot.store[result.references.zone];
  const context = summarizeThinkingContext({ snapshot: result.snapshot, pageId: "page:test" });
  const skip = context.shapes.find(({ id }) => id === result.references["a-d"]);
  const initialRight = initialZone.x + initialZone.w;
  const relationRight = skip.bounds.x + skip.bounds.w;
  const fittedRight = zone.x + zone.props.w;

  assert.ok(relationRight > initialRight, "the regression fixture must exceed the requested frame");
  assert.ok(fittedRight - relationRight >= 40, "the fitted frame must retain a relation-safe right gap");
  assert.ok(zone.props.w > initialZone.w);
});

test("grows a semantic zone leftward without moving its cards on the page", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({
      diagramId: "native:left-contained-edge",
      readingOrder: "top-to-bottom",
    }),
    operations: [
      {
        type: "create_zone",
        key: "zone",
        title: "Left route",
        purpose: "semantic",
        x: 100,
        y: 100,
        w: 400,
        h: 800,
        semantic: { id: "object:zone" },
      },
      {
        type: "create_card",
        key: "a",
        title: "A",
        parentZoneId: "zone",
        x: 180,
        y: 200,
        semantic: { id: "object:a" },
      },
      {
        type: "create_card",
        key: "b",
        title: "B",
        parentZoneId: "zone",
        x: 180,
        y: 600,
        semantic: { id: "object:b" },
      },
      {
        type: "create_relation",
        key: "a-b",
        semanticId: "relation:a-b",
        from: "a",
        to: "b",
        lane: -8,
        label: "左侧回流",
      },
    ],
  });
  const zone = result.snapshot.store[result.references.zone];
  const first = result.snapshot.store[result.references.a];
  const context = summarizeThinkingContext({ snapshot: result.snapshot, pageId: "page:test" });
  const relation = context.shapes.find(({ id }) => id === result.references["a-b"]);

  assert.ok(zone.x < 100);
  assert.equal(zone.x + first.x, 180, "leftward frame growth must not move child content");
  assert.ok(relation.bounds.x - zone.x >= 40, "the fitted frame must retain a relation-safe left gap");
});

test("keeps parallel base lanes unique after a skip-edge obstacle is removed", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:skip-lifecycle" }),
    operations: [
      { type: "create_card", key: "a", title: "A", semantic: { id: "object:a", order: 1 } },
      { type: "create_card", key: "b", title: "B", semantic: { id: "object:b", order: 2 } },
      { type: "create_card", key: "c", title: "C", semantic: { id: "object:c", order: 3 } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
      { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: "b", to: "c" },
      { type: "create_relation", key: "skip-one", semanticId: "relation:skip-one", from: "a", to: "c" },
      { type: "create_relation", key: "skip-two", semanticId: "relation:skip-two", from: "a", to: "c" },
    ],
  });
  const moved = applyThinkingOperationsToSnapshot({
    snapshot: created.snapshot,
    pageId: "page:test",
    operations: [{
      type: "move_shape",
      id: created.references.b,
      x: created.snapshot.store[created.references.b].x,
      y: 1_000,
    }],
  });
  const skips = ["skip-one", "skip-two"].map((key) => moved.snapshot.store[created.references[key]]);
  assert.equal(new Set(skips.map((relation) => relation.meta.cowartThinkingRelationBaseLane)).size, 2);
  assert.equal(new Set(skips.map((relation) => relation.meta.cowartThinkingRelationLane)).size, 2);
  assert.equal(new Set(skips.map((relation) => relation.props.bend)).size, 2);
  assert.ok(skips.every((relation) => relation.meta.cowartThinkingObstacleRoute === null));
});

test("reroutes existing semantic relations when an explicit card is added later", () => {
  const diagram = semanticDiagram({ diagramId: "native:late-obstacle" });
  const initial = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: diagram,
    operations: [
      { type: "create_zone", key: "zone", title: "Zone", w: 1_600, h: 500, purpose: "semantic", semantic: { id: "object:zone" } },
      { type: "create_card", key: "a", title: "A", parentZoneId: "zone", x: 40, y: 100, semantic: { id: "object:a" } },
      { type: "create_card", key: "c", title: "C", parentZoneId: "zone", x: 1_100, y: 100, semantic: { id: "object:c" } },
      { type: "create_relation", key: "a-c", semanticId: "relation:a-c", from: "a", to: "c" },
    ],
  });
  assert.equal(initial.snapshot.store[initial.references["a-c"]].meta.cowartThinkingObstacleRoute, null);

  const withObstacle = applyThinkingOperationsToSnapshot({
    snapshot: initial.snapshot,
    pageId: "page:test",
    semanticDiagram: diagram,
    operations: [{
      type: "create_card",
      key: "b",
      title: "B",
      parentZoneId: initial.references.zone,
      x: 570,
      y: 100,
      semantic: { id: "object:b" },
    }],
  });
  const relation = withObstacle.snapshot.store[initial.references["a-c"]];
  assert.notEqual(relation.meta.cowartThinkingRelationLane, 0);
  assert.deepEqual(relation.meta.cowartThinkingObstacleRoute.obstacleShapeIds, [withObstacle.references.b]);
});

test("keeps generic relation grammar and lanes after endpoint movement", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    operations: [
      { type: "create_card", key: "a", title: "A", x: 0, y: 0 },
      { type: "create_card", key: "b", title: "B", x: 500, y: 0 },
      {
        type: "create_relation",
        key: "association",
        from: "a",
        to: "b",
        kind: "association",
        direction: "none",
        path: "alternative",
        payload: "shared context",
        lane: 0,
      },
      { type: "create_relation", key: "sync", from: "a", to: "b", kind: "sync", lane: 0 },
    ],
  });
  const association = created.snapshot.store[created.references.association];
  const sync = created.snapshot.store[created.references.sync];
  assert.equal(association.props.arrowheadEnd, "none");
  assert.equal(association.props.dash, "dashed");
  assert.equal(sync.props.arrowheadStart, "arrow");
  assert.notEqual(association.meta.cowartThinkingRelationLane, sync.meta.cowartThinkingRelationLane);

  const moved = applyThinkingOperationsToSnapshot({
    snapshot: created.snapshot,
    pageId: "page:test",
    operations: [{ type: "move_shape", id: created.references.b, x: 700, y: 150 }],
  });
  const movedBindings = ["association", "sync"].map((key) => {
    const relationId = created.references[key];
    return relationBindings(moved.snapshot, relationId)
      .find((binding) => binding.props.terminal === "start").props.normalizedAnchor;
  });
  assert.notDeepEqual(movedBindings[0], movedBindings[1]);
  const context = summarizeThinkingContext({ snapshot: moved.snapshot, pageId: "page:test" });
  const relationContext = context.shapes.find(({ id }) => id === created.references.association).relation;
  assert.equal(relationContext.direction, "none");
  assert.equal(relationContext.path, "alternative");
  assert.equal(relationContext.payload, "shared context");
  assert.equal(relationContext.lane, association.meta.cowartThinkingRelationLane);
});

test("uses rebound arrow bindings for context, refresh, and deletion cleanup", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:rebound" }),
    operations: [
      { type: "create_card", key: "a", title: "A", x: 0, y: 0, semantic: { id: "object:a" } },
      { type: "create_card", key: "b", title: "B", x: 500, y: 0, semantic: { id: "object:b" } },
      { type: "create_card", key: "c", title: "C", x: 500, y: 300, semantic: { id: "object:c" } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b" },
    ],
  });
  const rebound = structuredClone(created.snapshot);
  const relationId = created.references["a-b"];
  const endBinding = relationBindings(rebound, relationId)
    .find((binding) => binding.props.terminal === "end");
  endBinding.toId = created.references.c;

  const reboundContext = summarizeThinkingContext({ snapshot: rebound, pageId: "page:test" });
  assert.equal(reboundContext.shapes.find(({ id }) => id === relationId).relation.toId, created.references.c);

  const moved = applyThinkingOperationsToSnapshot({
    snapshot: rebound,
    pageId: "page:test",
    operations: [{ type: "move_shape", id: created.references.c, x: 800, y: 400 }],
  });
  assert.equal(moved.snapshot.store[relationId].meta.cowartThinkingToShapeId, created.references.c);
  assert.ok(moved.snapshot.store[relationId].props.end.x > 700);

  const withoutOldTarget = applyThinkingOperationsToSnapshot({
    snapshot: moved.snapshot,
    pageId: "page:test",
    operations: [{ type: "delete_shape", id: created.references.b }],
  });
  assert.ok(withoutOldTarget.snapshot.store[relationId]);
  assert.equal(relationBindings(withoutOldTarget.snapshot, relationId).length, 2);

  const withoutBoundTarget = applyThinkingOperationsToSnapshot({
    snapshot: withoutOldTarget.snapshot,
    pageId: "page:test",
    operations: [{ type: "delete_shape", id: created.references.c }],
  });
  assert.equal(withoutBoundTarget.snapshot.store[relationId], undefined);
  assert.equal(relationBindings(withoutBoundTarget.snapshot, relationId).length, 0);
});

test("keeps semantic claims in metadata without stretching frame titles and allows stable relation replacement", () => {
  const created = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:replace", teachingClaim: "The claim stays visible." }),
    operations: [
      { type: "create_zone", key: "zone", title: "Original", purpose: "semantic", semantic: { id: "object:zone" } },
      { type: "create_card", key: "a", title: "A", parentZoneId: "zone", semantic: { id: "object:a" } },
      { type: "create_card", key: "b", title: "B", parentZoneId: "zone", semantic: { id: "object:b" } },
      { type: "create_relation", key: "old-relation", semanticId: "relation:stable", from: "a", to: "b" },
    ],
  });
  const updatedZone = applyThinkingOperationsToSnapshot({
    snapshot: created.snapshot,
    pageId: "page:test",
    operations: [{ type: "update_zone", id: created.references.zone, title: "Renamed" }],
  });
  const renamedZone = updatedZone.snapshot.store[created.references.zone];
  assert.equal(renamedZone.props.name, "Renamed");
  assert.equal(renamedZone.meta.cowartSemanticDiagram.teachingClaim, "The claim stays visible.");
  assert.throws(
    () => applyThinkingOperationsToSnapshot({
      snapshot: updatedZone.snapshot,
      pageId: "page:test",
      operations: [{
        type: "update_card",
        id: created.references.a,
        bridge: { workspaceId: "workspace:pollution" },
      }],
    }),
    /cannot include Product Bridge metadata/,
  );
  const replacement = applyThinkingOperationsToSnapshot({
    snapshot: updatedZone.snapshot,
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:replace", teachingClaim: "The claim stays visible." }),
    operations: [
      { type: "delete_shape", id: created.references["old-relation"] },
      {
        type: "create_relation",
        key: "new-relation",
        semanticId: "relation:stable",
        from: created.references.a,
        to: created.references.b,
      },
    ],
  });
  const newRelation = replacement.snapshot.store[replacement.references["new-relation"]];
  assert.notEqual(newRelation.id, created.references["old-relation"]);
  assert.equal(newRelation.meta.cowartSemanticRelation.semanticId, "relation:stable");
});

test("places incremental semantic sources before existing targets and targets after sources", () => {
  const initial = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:incremental-direction" }),
    operations: [{ type: "create_card", key: "b", title: "B", semantic: { id: "object:b" } }],
  });
  const upstream = applyThinkingOperationsToSnapshot({
    snapshot: initial.snapshot,
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:incremental-direction" }),
    operations: [
      { type: "create_card", key: "a", title: "A", semantic: { id: "object:a" } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: initial.references.b },
    ],
  });
  assert.ok(upstream.snapshot.store[upstream.references.a].x < upstream.snapshot.store[initial.references.b].x);

  const downstream = applyThinkingOperationsToSnapshot({
    snapshot: upstream.snapshot,
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:incremental-direction" }),
    operations: [
      { type: "create_card", key: "c", title: "C", semantic: { id: "object:c" } },
      { type: "create_relation", key: "b-c", semanticId: "relation:b-c", from: initial.references.b, to: "c" },
    ],
  });
  assert.ok(downstream.snapshot.store[initial.references.b].x < downstream.snapshot.store[downstream.references.c].x);
});

test("creates a thin, transparent, connected Excalidraw-style diagram", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    operations: [
      { type: "create_card", key: "root", title: "470 AI 助手" },
      { type: "create_card", key: "scene", title: "场景编辑" },
      { type: "create_card", key: "visual", title: "可视化" },
      {
        type: "create_card",
        key: "detail",
        title: "可视化细节",
        body: "识别关联装置、场景物件与变量字段，并保持结构清晰。",
      },
      { type: "create_relation", from: "root", to: "scene" },
      { type: "create_relation", from: "root", to: "visual" },
      { type: "create_relation", from: "visual", to: "detail" },
    ],
  });

  const root = result.snapshot.store[result.references.root];
  const scene = result.snapshot.store[result.references.scene];
  const visual = result.snapshot.store[result.references.visual];
  const detail = result.snapshot.store[result.references.detail];
  const arrows = Object.values(result.snapshot.store).filter(
    (record) => record.typeName === "shape" && record.type === "arrow",
  );

  for (const card of [root, scene, visual, detail]) {
    assert.equal(card.props.geo, "cowart-card");
    assert.equal(card.props.size, "s");
    assert.equal(card.props.fill, "none");
    assert.equal(card.props.font, "draw");
    assert.equal(card.props.color, "black");
    assert.equal(card.props.dash, "draw");
    assert.equal(card.isLocked, false);
  }
  assert.equal(root.props.align, "middle");
  assert.equal(detail.props.align, "start");
  assert.ok(root.y < scene.y);
  assert.equal(scene.y, visual.y);
  assert.ok(visual.y < detail.y);
  assert.notEqual(scene.x, visual.x);
  assert.equal(arrows.length, 3);
  for (const arrow of arrows) {
    assert.equal(arrow.props.size, "s");
    assert.equal(arrow.props.color, "black");
    assert.equal(arrow.props.font, "draw");
    assert.equal(arrow.props.dash, "draw");
    assert.equal(arrow.props.richText.content[0].content, undefined);
  }
});

test("semantic diagrams keep the Excalidraw draw contract and support optional hachure emphasis", () => {
  const result = applyThinkingOperationsToSnapshot({
    snapshot: emptySnapshot(),
    pageId: "page:test",
    semanticDiagram: semanticDiagram({ diagramId: "native:excalidraw-style" }),
    operations: [
      {
        type: "create_zone",
        key: "diagram",
        title: "Editable flow",
        purpose: "semantic",
        semantic: { id: "object:diagram", type: "container" },
      },
      {
        type: "create_card",
        key: "start",
        title: "开始",
        fill: "hachure",
        parentZoneId: "diagram",
        semantic: { id: "object:start", type: "state", order: 1 },
      },
      {
        type: "create_card",
        key: "done",
        title: "完成",
        parentZoneId: "diagram",
        semantic: { id: "object:done", type: "state", order: 2 },
      },
      {
        type: "create_relation",
        key: "start-done",
        semanticId: "relation:start-done",
        from: "start",
        to: "done",
      },
    ],
  });

  const start = result.snapshot.store[result.references.start];
  const done = result.snapshot.store[result.references.done];
  const relation = result.snapshot.store[result.references["start-done"]];
  assert.equal(start.props.fill, "pattern");
  assert.equal(start.props.dash, "draw");
  assert.equal(done.props.fill, "none");
  assert.equal(done.props.dash, "draw");
  assert.equal(relation.props.color, "black");
  assert.equal(relation.props.dash, "draw");
  assert.equal(relationBindings(result.snapshot, relation.id).length, 2);
});
