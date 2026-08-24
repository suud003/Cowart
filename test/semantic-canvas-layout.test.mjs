import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPageTransitions,
  layoutPages,
  normalizePagePosition,
  normalizeTransition,
  PAGE_CARD_HEIGHT,
  PAGE_CARD_WIDTH,
  routeTransition,
} from "../skills/cowart-product-bridge/assets/container/semantic-canvas-layout.js";

test("normalizes missing or malformed page positions for defensive rendering", () => {
  assert.deepEqual(normalizePagePosition(), { x: 0, y: 0 });
  assert.deepEqual(normalizePagePosition({ x: 120, y: Number.NaN }), { x: 120, y: 0 });
});

test("normalizes legacy and semantic transition fields", () => {
  assert.deepEqual(normalizeTransition({ label: "Continue" }), {
    type: "flow",
    direction: "forward",
    path: "primary",
    label: "Continue",
    payload: "",
    displayLabel: "Continue",
  });
  assert.equal(normalizeTransition({ type: "sync" }).direction, "bidirectional");
  assert.equal(normalizeTransition({ type: "association" }).direction, "none");
  assert.equal(
    normalizeTransition({ label: "提交", payload: "评审草稿", path: "alternative" }).displayLabel,
    "提交 · 评审草稿",
  );
});

test("lays page flows out in stable topological layers", () => {
  const result = layoutPages([
    { id: "root", transitions: [{ to: "intake" }, { to: "review" }] },
    { id: "intake", transitions: [{ to: "done" }] },
    { id: "review", transitions: [] },
    { id: "done", transitions: [] },
  ]);

  assert.deepEqual(result.layers, [["root"], ["intake", "review"], ["done"]]);
  assert.ok(result.positions.root.x < result.positions.intake.x);
  assert.equal(result.positions.intake.x, result.positions.review.x);
  assert.notEqual(result.positions.intake.y, result.positions.review.y);
  assert.ok(result.positions.intake.x + PAGE_CARD_WIDTH < result.positions.done.x);
  assert.ok(
    Math.abs(
      result.positions.root.y + PAGE_CARD_HEIGHT / 2 -
      (result.positions.intake.y + result.positions.review.y + PAGE_CARD_HEIGHT) / 2,
    ) < 0.001,
  );
});

test("keeps cycles deterministic by placing their members in one layer", () => {
  const pages = [
    { id: "a", transitions: [{ to: "b" }] },
    { id: "b", transitions: [{ to: "a" }, { to: "c" }] },
    { id: "c", transitions: [] },
  ];
  const first = layoutPages(pages);
  const second = layoutPages(pages);

  assert.deepEqual(first, second);
  assert.deepEqual(first.layers, [["a", "b"], ["c"]]);
  assert.equal(first.positions.a.x, first.positions.b.x);
  assert.ok(first.positions.b.x < first.positions.c.x);
});

test("collects old transitions and separates parallel or reverse lanes", () => {
  const transitions = collectPageTransitions([
    { id: "a", transitions: [{ to: "b" }, { to: "b", path: "alternative" }] },
    { id: "b", transitions: [{ to: "a", type: "sync" }] },
  ]);

  assert.equal(transitions.length, 3);
  assert.deepEqual(transitions.map(({ lane }) => lane), [-1, 0, 1]);
  assert.equal(transitions[0].direction, "forward");
  assert.equal(transitions[1].path, "alternative");
  assert.equal(transitions[2].direction, "bidirectional");
});

test("routes relations from facing card boundaries with semantic markers", () => {
  const route = routeTransition(
    { x: 0, y: 20, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT },
    { x: 560, y: 20, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT },
    { type: "flow", direction: "bidirectional", label: "同步", payload: "状态" },
  );

  assert.deepEqual(route.start, { x: PAGE_CARD_WIDTH, y: 150 });
  assert.deepEqual(route.end, { x: 560, y: 150 });
  assert.equal(route.markerStart, true);
  assert.equal(route.markerEnd, true);
  assert.equal(route.displayLabel, "同步 · 状态");
  assert.match(route.d, /^M 360 150 C /);

  const association = routeTransition(
    { x: 0, y: 0, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT },
    { x: 0, y: 500, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT },
    { type: "association", path: "alternative" },
  );
  assert.deepEqual(association.start, { x: 180, y: PAGE_CARD_HEIGHT });
  assert.deepEqual(association.end, { x: 180, y: 500 });
  assert.equal(association.markerStart, false);
  assert.equal(association.markerEnd, false);
  assert.equal(association.path, "alternative");
});

test("separates parallel relation ports as well as their middle lanes", () => {
  const from = { x: 0, y: 20, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT };
  const to = { x: 560, y: 20, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT };
  const upper = routeTransition(from, to, { lane: -0.5 });
  const lower = routeTransition(from, to, { lane: 0.5 });

  assert.notEqual(upper.start.y, lower.start.y);
  assert.notEqual(upper.end.y, lower.end.y);
  assert.equal(upper.start.x, PAGE_CARD_WIDTH);
  assert.equal(lower.end.x, 560);
});

test("routes skip-layer relations outside intervening page cards", () => {
  const from = { x: 80, y: 80, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT };
  const blocker = { x: 560, y: 80, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT };
  const to = { x: 1040, y: 80, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT };
  const route = routeTransition(from, to, { label: "跨层" }, { obstacles: [blocker] });

  assert.equal(route.routeKind, "detour");
  assert.match(route.d, /^M .+ L /);
  assert.ok(route.points.some((point) => point.y < blocker.y || point.y > blocker.y + blocker.h));
  assert.ok(route.labelPoint.y < blocker.y || route.labelPoint.y > blocker.y + blocker.h);
});

test("renders self transitions as an external loop with a visible label", () => {
  const rect = { x: 80, y: 80, w: PAGE_CARD_WIDTH, h: PAGE_CARD_HEIGHT };
  const route = routeTransition(rect, rect, { label: "重试" }, { selfLoop: true });

  assert.equal(route.routeKind, "self-loop");
  assert.equal(route.start.x, rect.x + rect.w);
  assert.equal(route.end.x, rect.x + rect.w);
  assert.ok(route.firstControl.x > rect.x + rect.w);
  assert.ok(route.secondControl.x > rect.x + rect.w);
  assert.ok(route.labelPoint.x > rect.x + rect.w);
  assert.equal(route.markerEnd, true);
});
