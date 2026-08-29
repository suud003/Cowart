import assert from "node:assert/strict";
import test from "node:test";

import { fitSemanticLayout, layoutSemanticGraph } from "../mcp/lib/semantic-layout.mjs";
import { layoutThinkingGraph } from "../mcp/lib/thinking-layout.mjs";

function whitespace(bounds, targetRect) {
  return {
    left: bounds.x - targetRect.x,
    right: targetRect.x + targetRect.w - (bounds.x + bounds.w),
    top: bounds.y - targetRect.y,
    bottom: targetRect.y + targetRect.h - (bounds.y + bounds.h),
  };
}

test("centers a semantic graph inside the fixed target rectangle", () => {
  const targetRect = { x: 120, y: 80, w: 1_400, h: 680 };
  const result = layoutSemanticGraph({
    nodes: [
      { id: "observe", w: 220, h: 96 },
      { id: "decide", w: 260, h: 112 },
      { id: "act", w: 200, h: 96 },
    ],
    edges: [
      { from: "observe", to: "decide" },
      { from: "decide", to: "act" },
    ],
    readingOrder: "left-to-right",
    targetRect,
  });
  const inset = whitespace(result.diagramBounds, targetRect);

  assert.equal(result.engine, "html-line-svg");
  assert.equal(result.valid, true);
  assert.ok(Math.abs(inset.left - inset.right) < 1e-7);
  assert.ok(Math.abs(inset.top - inset.bottom) < 1e-7);
  assert.ok(result.utilization.width <= 1);
  assert.ok(result.utilization.height <= 1);
});

test("preserves node sizes and never reduces the layout gap", () => {
  const nodes = [
    { id: "source", w: 180, h: 96 },
    { id: "middle", w: 240, h: 120 },
    { id: "outcome", w: 200, h: 104 },
  ];
  const edges = [
    { from: "source", to: "middle" },
    { from: "middle", to: "outcome" },
  ];
  const initial = layoutThinkingGraph({ nodes, edges, readingOrder: "left-to-right" });
  const result = fitSemanticLayout({
    nodes,
    positions: initial,
    targetRect: { x: 0, y: 0, w: 1_600, h: 600 },
    maxCenterScale: 1.5,
  });
  const initialGap = initial.get("middle").x - (initial.get("source").x + nodes[0].w);
  const fittedGap =
    result.positions.get("middle").x - (result.positions.get("source").x + nodes[0].w);

  assert.equal(result.valid, true);
  assert.deepEqual(result.collisions, []);
  assert.deepEqual(result.outOfBounds, []);
  assert.ok(fittedGap >= initialGap);
  assert.deepEqual(
    nodes.map(({ w, h }) => ({ w, h })),
    [
      { w: 180, h: 96 },
      { w: 240, h: 120 },
      { w: 200, h: 104 },
    ],
  );
});

test("rejects overflow without shrinking nodes or expanding the target", () => {
  const targetRect = { x: 40, y: 60, w: 200, h: 120 };
  const result = fitSemanticLayout({
    nodes: [{ id: "oversized", w: 320, h: 180 }],
    positions: new Map([["oversized", { x: 0, y: 0 }]]),
    targetRect,
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.outOfBounds, ["oversized"]);
  assert.deepEqual(result.collisions, []);
  assert.equal(result.diagramBounds.w, 320);
  assert.equal(result.diagramBounds.h, 180);
  assert.deepEqual(result.centerScale, { x: 1, y: 1 });
  assert.deepEqual(targetRect, { x: 40, y: 60, w: 200, h: 120 });
});

test("returns the same positions and diagnostics for identical input", () => {
  const input = {
    nodes: [
      { id: "hub", w: 220, h: 104 },
      { id: "north", w: 180, h: 96 },
      { id: "east", w: 200, h: 96 },
      { id: "south", w: 180, h: 112 },
      { id: "west", w: 240, h: 96 },
    ],
    edges: ["north", "east", "south", "west"].map((to) => ({ from: "hub", to })),
    readingOrder: "center-out",
    targetRect: { x: 24, y: 36, w: 1_280, h: 820 },
  };

  const first = layoutSemanticGraph(input);
  const second = layoutSemanticGraph(input);

  assert.deepEqual([...first.positions], [...second.positions]);
  assert.deepEqual(first.diagramBounds, second.diagramBounds);
  assert.deepEqual(first.utilization, second.utilization);
  assert.deepEqual(first.collisions, second.collisions);
  assert.deepEqual(first.outOfBounds, second.outOfBounds);
  assert.equal(first.valid, second.valid);
});

test("wraps a strongly connected cycle across a wide fixed rectangle", () => {
  const nodes = ["a", "b", "c"].map((id) => ({ id, w: 180, h: 96 }));
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
  ];
  const input = {
    nodes,
    edges,
    readingOrder: "left-to-right",
    targetRect: { x: 40, y: 72, w: 1_520, h: 788 },
    maxCenterScale: 2.15,
  };
  const result = layoutSemanticGraph(input);

  assert.equal(result.valid, true);
  assert.deepEqual(result.collisions, []);
  assert.deepEqual(result.outOfBounds, []);
  assert.ok(new Set([...result.positions.values()].map(({ x }) => x)).size > 1);
  assert.ok(new Set([...result.positions.values()].map(({ y }) => y)).size > 1);
  assert.deepEqual([...result.positions], [...layoutSemanticGraph(input).positions]);
});

test("wraps a wide top-to-bottom fan-out into bounded peer rows", () => {
  const nodes = ["hub", "a", "b", "c", "d", "e"].map((id) => ({ id, w: 180, h: 96 }));
  const result = layoutSemanticGraph({
    nodes,
    edges: ["a", "b", "c", "d", "e"].map((to) => ({ from: "hub", to })),
    readingOrder: "top-to-bottom",
    targetRect: { x: 40, y: 72, w: 570, h: 488 },
    maxCenterScale: 2.15,
  });
  const peerRows = new Set(["a", "b", "c", "d", "e"].map((id) => result.positions.get(id).y));

  assert.equal(result.valid, true);
  assert.deepEqual(result.collisions, []);
  assert.deepEqual(result.outOfBounds, []);
  assert.ok(peerRows.size > 1);
  assert.ok(result.diagramBounds.w <= 570);
  assert.ok(result.diagramBounds.h <= 488);
});
