import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyExcalidrawThinkingOperationsToSnapshot,
  summarizeExcalidrawThinkingContext,
} from "../mcp/lib/excalidraw-thinking-canvas.mjs";
import {
  applyThinkingOperations,
  getThinkingContext,
  importThinkingMaterial,
  undoThinkingOperation,
} from "../mcp/lib/thinking-runtime.mjs";
import { saveCowartCanvasSnapshot } from "../mcp/lib/canvas-storage.mjs";

function emptyExcalidraw() {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

function semanticDiagram(id = "native:excalidraw-flow") {
  return {
    version: "1",
    diagramId: id,
    teachingClaim: "Editable native objects make the reasoning structure inspectable.",
    readingOrder: "left-to-right",
    diagramType: "flow",
    layoutEngine: "html-line-svg",
    layoutMode: "balanced",
    layoutFit: "fixed",
  };
}

function active(snapshot, predicate = () => true) {
  return snapshot.elements.filter((element) => element.isDeleted !== true && predicate(element));
}

function overlaps(first, second) {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

function globalArrowPoints(arrow) {
  return arrow.points.map(([x, y]) => ({ x: arrow.x + x, y: arrow.y + y }));
}

function segmentCrossesCardInterior(start, end, card) {
  const left = card.x;
  const right = card.x + card.width;
  const top = card.y;
  const bottom = card.y + card.height;
  if (Math.abs(start.x - end.x) < 1e-6) {
    if (start.x <= left || start.x >= right) return false;
    return Math.max(start.y, end.y) > top && Math.min(start.y, end.y) < bottom;
  }
  if (Math.abs(start.y - end.y) < 1e-6) {
    if (start.y <= top || start.y >= bottom) return false;
    return Math.max(start.x, end.x) > left && Math.min(start.x, end.x) < right;
  }
  return true;
}

function assertOrthogonalAndClear(snapshot, arrow) {
  const endpointIds = new Set([arrow.startBinding?.elementId, arrow.endBinding?.elementId]);
  const unrelatedCards = active(snapshot, (element) =>
    element.type === "rectangle" && !endpointIds.has(element.id)
  );
  const points = globalArrowPoints(arrow);
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    assert.ok(
      Math.abs(start.x - end.x) < 1e-6 || Math.abs(start.y - end.y) < 1e-6,
      `arrow ${arrow.id} contains a diagonal segment`,
    );
    for (const card of unrelatedCards) {
      assert.equal(
        segmentCrossesCardInterior(start, end, card),
        false,
        `arrow ${arrow.id} crosses unrelated card ${card.id}`,
      );
    }
  }
}

test("creates standard editable Excalidraw cards, frame, bound arrow, and label with html-line-svg layout", () => {
  const result = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: emptyExcalidraw(),
    semanticDiagram: semanticDiagram(),
    operations: [
      {
        type: "create_zone",
        key: "flow",
        title: "Decision flow",
        purpose: "semantic",
        x: 100,
        y: 80,
        w: 1_200,
        h: 520,
        semantic: { id: "object:flow", type: "zone" },
      },
      {
        type: "create_card",
        key: "question",
        title: "Question",
        body: "What does the player decide?",
        parentZoneId: "flow",
        semantic: { id: "object:question", type: "question", order: 1 },
      },
      {
        type: "create_card",
        key: "outcome",
        title: "Outcome",
        body: "The state changes visibly.",
        parentZoneId: "flow",
        semantic: { id: "object:outcome", type: "outcome", order: 2 },
      },
      {
        type: "create_relation",
        key: "question-outcome",
        semanticId: "relation:question-outcome",
        from: "question",
        to: "outcome",
        label: "changes",
        direction: "forward",
      },
    ],
  });

  const frame = result.snapshot.elements.find((element) => element.id === result.references.flow);
  const question = result.snapshot.elements.find((element) => element.id === result.references.question);
  const outcome = result.snapshot.elements.find((element) => element.id === result.references.outcome);
  const arrow = result.snapshot.elements.find((element) => element.id === result.references["question-outcome"]);
  const questionText = active(result.snapshot, (element) => element.containerId === question.id)[0];
  const arrowLabel = active(result.snapshot, (element) => element.containerId === arrow.id)[0];

  assert.equal(frame.type, "frame");
  assert.equal(frame.name, "Decision flow");
  assert.equal(question.type, "rectangle");
  assert.equal(question.frameId, frame.id);
  assert.equal(questionText.type, "text");
  assert.equal(questionText.fontFamily, 5);
  assert.equal(questionText.containerId, question.id);
  assert.ok(question.boundElements.some(({ id, type }) => id === questionText.id && type === "text"));
  assert.equal(arrow.type, "arrow");
  assert.equal(arrow.startBinding.elementId, question.id);
  assert.equal(arrow.endBinding.elementId, outcome.id);
  assert.equal(arrowLabel.text, "changes");
  assert.equal(arrowLabel.containerId, arrow.id);
  assert.equal(question.customData.cowart.semanticObject.semanticId, "object:question");
  assert.equal(arrow.customData.cowart.semanticRelation.semanticId, "relation:question-outcome");
  assert.equal(result.layoutReport.engine, "html-line-svg");
  assert.equal(result.layoutReport.valid, true);
  assert.deepEqual(result.layoutReport.collisions, []);
  assert.equal(overlaps(question, outcome), false);

  const context = summarizeExcalidrawThinkingContext({ snapshot: result.snapshot });
  assert.equal(context.runtime, "excalidraw");
  assert.equal(context.shapes.length, 4, "bound text stays attached without becoming duplicate context cards");
  assert.equal(context.shapes.find(({ id }) => id === arrow.id).relation.label, "changes");
});

test("wraps imported bound text before the official Excalidraw editor renders it", () => {
  const originalBody = "使用边界端口、正交连线与障碍规避生成清晰可编辑的结构图。";
  const result = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: emptyExcalidraw(),
    operations: [{ type: "create_card", key: "wrapped", title: "自动排版", body: originalBody }],
  });
  const card = result.snapshot.elements.find((element) => element.id === result.references.wrapped);
  const text = active(result.snapshot, (element) => element.containerId === card.id)[0];

  assert.equal(text.originalText, `自动排版\n\n${originalBody}`);
  assert.equal(text.autoResize, false);
  assert.ok(text.text.split("\n").length >= 4, "long CJK copy should be wrapped into visible rows");
  assert.ok(text.height < card.height, "wrapped text should remain inside its card");
});

test("semantic updates keep manual Excalidraw styles, font choices, bindings, and geometry intact", () => {
  const diagram = semanticDiagram("native:style-preservation");
  const created = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: emptyExcalidraw(),
    semanticDiagram: diagram,
    operations: [
      { type: "create_card", key: "a", title: "Draft A", x: 80, y: 120, semantic: { id: "object:a" } },
      { type: "create_card", key: "b", title: "Draft B", x: 600, y: 120, semantic: { id: "object:b" } },
      { type: "create_relation", key: "a-b", semanticId: "relation:a-b", from: "a", to: "b", label: "draft" },
    ],
  });
  const manuallyStyled = structuredClone(created.snapshot);
  const card = manuallyStyled.elements.find((element) => element.id === created.references.a);
  const cardText = manuallyStyled.elements.find((element) => element.containerId === card.id);
  const relation = manuallyStyled.elements.find((element) => element.id === created.references["a-b"]);
  const relationLabel = manuallyStyled.elements.find((element) => element.containerId === relation.id);
  Object.assign(card, {
    strokeColor: "#c2255c",
    backgroundColor: "#ffdeeb",
    fillStyle: "cross-hatch",
    strokeStyle: "dotted",
    strokeWidth: 4,
    roughness: 2,
    opacity: 63,
  });
  Object.assign(cardText, { fontFamily: 2, fontSize: 31, strokeColor: "#862e9c" });
  Object.assign(relation, {
    strokeColor: "#5f3dc4",
    strokeStyle: "dashed",
    strokeWidth: 3,
    roughness: 0,
    opacity: 47,
  });
  Object.assign(relationLabel, { fontFamily: 3, fontSize: 27 });
  const cardStyleBefore = {
    strokeColor: card.strokeColor,
    backgroundColor: card.backgroundColor,
    fillStyle: card.fillStyle,
    strokeStyle: card.strokeStyle,
    strokeWidth: card.strokeWidth,
    roughness: card.roughness,
    opacity: card.opacity,
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
  };
  const relationStyleBefore = {
    strokeColor: relation.strokeColor,
    backgroundColor: relation.backgroundColor,
    fillStyle: relation.fillStyle,
    strokeStyle: relation.strokeStyle,
    strokeWidth: relation.strokeWidth,
    roughness: relation.roughness,
    opacity: relation.opacity,
    x: relation.x,
    y: relation.y,
    width: relation.width,
    height: relation.height,
    points: structuredClone(relation.points),
    startBinding: structuredClone(relation.startBinding),
    endBinding: structuredClone(relation.endBinding),
  };

  const updated = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: manuallyStyled,
    semanticDiagram: diagram,
    operations: [
      {
        type: "update_card",
        id: card.id,
        title: "Reviewed A",
        color: "green",
        fill: "solid",
        semantic: { state: "success" },
      },
      {
        type: "update_relation",
        id: relation.id,
        kind: "supports",
        origin: "source",
        label: "verified",
      },
    ],
  });
  const nextCard = updated.snapshot.elements.find((element) => element.id === card.id);
  const nextCardText = updated.snapshot.elements.find((element) => element.id === cardText.id);
  const nextRelation = updated.snapshot.elements.find((element) => element.id === relation.id);
  const nextRelationLabel = updated.snapshot.elements.find((element) => element.id === relationLabel.id);

  assert.deepEqual(
    {
      strokeColor: nextCard.strokeColor,
      backgroundColor: nextCard.backgroundColor,
      fillStyle: nextCard.fillStyle,
      strokeStyle: nextCard.strokeStyle,
      strokeWidth: nextCard.strokeWidth,
      roughness: nextCard.roughness,
      opacity: nextCard.opacity,
      x: nextCard.x,
      y: nextCard.y,
      width: nextCard.width,
      height: nextCard.height,
    },
    cardStyleBefore,
  );
  assert.equal(nextCardText.fontFamily, 2);
  assert.equal(nextCardText.fontSize, 31);
  assert.match(nextCardText.text, /^Reviewed A/u);
  assert.equal(nextCard.customData.cowart.semanticObject.state, "success");
  assert.deepEqual(
    {
      strokeColor: nextRelation.strokeColor,
      backgroundColor: nextRelation.backgroundColor,
      fillStyle: nextRelation.fillStyle,
      strokeStyle: nextRelation.strokeStyle,
      strokeWidth: nextRelation.strokeWidth,
      roughness: nextRelation.roughness,
      opacity: nextRelation.opacity,
      x: nextRelation.x,
      y: nextRelation.y,
      width: nextRelation.width,
      height: nextRelation.height,
      points: nextRelation.points,
      startBinding: nextRelation.startBinding,
      endBinding: nextRelation.endBinding,
    },
    relationStyleBefore,
  );
  assert.equal(nextRelationLabel.fontFamily, 3);
  assert.equal(nextRelationLabel.fontSize, 27);
  assert.equal(nextRelationLabel.text, "verified");
  assert.equal(nextRelation.customData.cowart.semanticRelation.type, "supports");
});

test("explicit move and resize update bound geometry while deletion stays limited to managed elements", () => {
  const created = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: emptyExcalidraw(),
    operations: [
      { type: "create_card", key: "a", title: "A", x: 40, y: 50 },
      { type: "create_card", key: "b", title: "B", x: 500, y: 50 },
      { type: "create_relation", key: "a-b", from: "a", to: "b", label: "next" },
    ],
  });
  const cardId = created.references.a;
  const relationId = created.references["a-b"];
  const moved = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: created.snapshot,
    operations: [
      { type: "move_shape", id: cardId, x: 160, y: 220 },
      { type: "resize_shape", id: cardId, w: 420, h: 240 },
    ],
  });
  const card = moved.snapshot.elements.find((element) => element.id === cardId);
  const text = moved.snapshot.elements.find((element) => element.containerId === cardId && element.isDeleted !== true);
  const relation = moved.snapshot.elements.find((element) => element.id === relationId);
  assert.deepEqual({ x: card.x, y: card.y, width: card.width, height: card.height }, { x: 160, y: 220, width: 420, height: 240 });
  assert.equal(text.x >= card.x, true);
  assert.equal(text.y >= card.y, true);
  assert.notDeepEqual(relation.points, created.snapshot.elements.find((element) => element.id === relationId).points);

  const userElement = {
    ...card,
    id: "user-rectangle",
    customData: {},
    boundElements: null,
  };
  const withUserElement = structuredClone(moved.snapshot);
  withUserElement.elements.push(userElement);
  assert.throws(
    () => applyExcalidrawThinkingOperationsToSnapshot({
      snapshot: withUserElement,
      operations: [{ type: "delete_shape", id: userElement.id }],
      allowUserAuthoredEdits: true,
    }),
    /only delete Cowart-managed/u,
  );

  const deleted = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: withUserElement,
    operations: [{ type: "delete_shape", id: cardId }],
  });
  assert.equal(deleted.snapshot.elements.find((element) => element.id === cardId).isDeleted, true);
  assert.equal(deleted.snapshot.elements.find((element) => element.id === text.id).isDeleted, true);
  assert.equal(deleted.snapshot.elements.find((element) => element.id === relationId).isDeleted, true);
  assert.equal(deleted.snapshot.elements.find((element) => element.id === userElement.id).isDeleted, false);
});

test("routes different-row relations orthogonally around unrelated cards and keeps routes clear after endpoint moves", () => {
  const created = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: emptyExcalidraw(),
    operations: [
      { type: "create_card", key: "source", title: "Source", x: 80, y: 80, w: 260, h: 140 },
      { type: "create_card", key: "blocker", title: "Unrelated", x: 470, y: 170, w: 280, h: 180 },
      { type: "create_card", key: "target", title: "Target", x: 900, y: 440, w: 260, h: 140 },
      { type: "create_relation", key: "source-target", from: "source", to: "target", label: "continue" },
    ],
  });
  const arrow = created.snapshot.elements.find((element) => element.id === created.references["source-target"]);
  assert.ok(arrow.points.length >= 4, "different-row connection should contain orthogonal bends");
  assert.equal(arrow.elbowed, false, "polyline remains a native editable Excalidraw arrow");
  assert.equal(arrow.customData.cowart.route.orthogonal, true);
  assertOrthogonalAndClear(created.snapshot, arrow);

  const moved = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: created.snapshot,
    operations: [
      { type: "move_shape", id: created.references.source, x: 160, y: 500 },
      { type: "resize_shape", id: created.references.target, w: 360, h: 200 },
    ],
  });
  const rerouted = moved.snapshot.elements.find((element) => element.id === arrow.id);
  assert.notDeepEqual(rerouted.points, arrow.points);
  assertOrthogonalAndClear(moved.snapshot, rerouted);

  const manuallyStyled = structuredClone(moved.snapshot);
  const styledArrow = manuallyStyled.elements.find((element) => element.id === arrow.id);
  Object.assign(styledArrow, {
    strokeColor: "#5f3dc4",
    strokeStyle: "dotted",
    strokeWidth: 4,
    roughness: 0,
    opacity: 61,
  });
  const laneUpdated = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: manuallyStyled,
    operations: [{ type: "update_relation", id: arrow.id, lane: -2 }],
  });
  const laneArrow = laneUpdated.snapshot.elements.find((element) => element.id === arrow.id);
  assert.equal(laneArrow.customData.cowart.route.lane, -2);
  assert.deepEqual(
    {
      strokeColor: laneArrow.strokeColor,
      strokeStyle: laneArrow.strokeStyle,
      strokeWidth: laneArrow.strokeWidth,
      roughness: laneArrow.roughness,
      opacity: laneArrow.opacity,
    },
    {
      strokeColor: "#5f3dc4",
      strokeStyle: "dotted",
      strokeWidth: 4,
      roughness: 0,
      opacity: 61,
    },
  );
  assert.notDeepEqual(laneArrow.points, styledArrow.points);
  assertOrthogonalAndClear(laneUpdated.snapshot, laneArrow);
});

test("keeps a five-node cycle readable with a separated outer return lane", () => {
  const diagram = {
    ...semanticDiagram("native:five-node-cycle"),
    teachingClaim: "A five-step loop stays readable when the return edge travels outside the cards.",
  };
  const operations = [
    {
      type: "create_zone",
      key: "cycle",
      title: "Five-step cycle",
      purpose: "semantic",
      x: 80,
      y: 80,
      w: 2_000,
      h: 1_100,
      semantic: { id: "object:cycle", type: "zone" },
    },
    ...["a", "b", "c", "d", "e"].map((key, index) => ({
      type: "create_card",
      key,
      title: `Step ${index + 1}`,
      parentZoneId: "cycle",
      semantic: { id: `object:${key}`, type: "step", order: index + 1 },
    })),
    ...[
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
      ["e", "a"],
    ].map(([from, to]) => ({
      type: "create_relation",
      key: `${from}-${to}`,
      semanticId: `relation:${from}-${to}`,
      from,
      to,
      direction: "forward",
      path: "primary",
    })),
  ];
  const result = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: emptyExcalidraw(),
    semanticDiagram: diagram,
    operations,
  });
  const cards = ["a", "b", "c", "d", "e"].map((key) =>
    result.snapshot.elements.find((element) => element.id === result.references[key])
  );
  const arrows = ["a-b", "b-c", "c-d", "d-e", "e-a"].map((key) =>
    result.snapshot.elements.find((element) => element.id === result.references[key])
  );
  for (const arrow of arrows) assertOrthogonalAndClear(result.snapshot, arrow);

  const returnArrow = arrows.at(-1);
  assert.equal(returnArrow.customData.cowart.route.mode, "outer");
  assert.notEqual(returnArrow.customData.cowart.route.lane, 0);
  const cardBounds = {
    left: Math.min(...cards.map((card) => card.x)),
    top: Math.min(...cards.map((card) => card.y)),
    right: Math.max(...cards.map((card) => card.x + card.width)),
    bottom: Math.max(...cards.map((card) => card.y + card.height)),
  };
  const returnPoints = globalArrowPoints(returnArrow);
  assert.ok(
    returnPoints.some((point) =>
      point.x < cardBounds.left ||
      point.x > cardBounds.right ||
      point.y < cardBounds.top ||
      point.y > cardBounds.bottom
    ),
    "cycle return route should travel outside the card envelope",
  );
  assert.ok(returnArrow.points.length >= 5, "outer return route should expose a traceable polyline");
});

test("runtime dispatch persists, previews, imports, and safely undoes native Excalidraw operations", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-excalidraw-thinking-"));
  try {
    const seeded = await saveCowartCanvasSnapshot({ projectDir }, emptyExcalidraw());
    assert.equal(seeded.ok, true);
    const initial = await getThinkingContext({ projectDir }, { scope: "page" });
    assert.equal(initial.runtime, "excalidraw");

    const preview = await applyThinkingOperations(
      { projectDir },
      {
        baseRevision: initial.revision,
        dryRun: true,
        operations: [{ type: "create_card", key: "preview", title: "Preview" }],
      },
    );
    assert.equal(preview.applied, false);
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).shapes.length, 0);

    const applied = await applyThinkingOperations(
      { projectDir },
      {
        baseRevision: initial.revision,
        operations: [{ type: "create_card", key: "saved", title: "Saved" }],
      },
    );
    assert.equal(applied.applied, true);
    assert.equal(applied.storage, "excalidraw");
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).shapes.length, 1);

    const sourcePath = path.join(projectDir, "research.md");
    await writeFile(sourcePath, "A source-backed conclusion.\n", "utf8");
    const imported = await importThinkingMaterial(
      { projectDir },
      {
        sourcePath,
        baseRevision: applied.resultRevision,
        excerpt: "A source-backed conclusion.",
      },
    );
    assert.equal(imported.copied, true);
    assert.equal(await readFile(imported.source.localPath, "utf8"), "A source-backed conclusion.\n");
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).shapes.length, 2);

    await undoThinkingOperation({ projectDir }, { operationId: imported.operationId });
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).shapes.length, 1);
    await undoThinkingOperation({ projectDir }, { operationId: applied.operationId });
    assert.equal((await getThinkingContext({ projectDir }, { scope: "page" })).shapes.length, 0);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
