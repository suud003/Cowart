import assert from "node:assert/strict";
import test from "node:test";

import { createAnnotationCoordinateMapper } from "../skills/cowart-product-bridge/assets/container/annotation-geometry.js";

test("maps iframe viewport points into an independently scaled annotation layer", () => {
  const mapper = createAnnotationCoordinateMapper({
    frameRect: { left: 120, top: 80, width: 642, height: 402 },
    frameOffsetWidth: 1284,
    frameOffsetHeight: 804,
    frameClientLeft: 2,
    frameClientTop: 2,
    layerRect: { left: 100, top: 60, width: 650, height: 410 },
    layerOffsetWidth: 1300,
    layerOffsetHeight: 820,
  });

  assert.deepEqual(mapper.frameToScreen({ x: 200, y: 100 }), { x: 221, y: 131 });
  assert.deepEqual(mapper.frameToLayer({ x: 200, y: 100 }), { x: 242, y: 142 });
  assert.deepEqual(mapper.screenToFrame({ x: 221, y: 131 }), { x: 200, y: 100 });
});

test("maps iframe element rectangles without assuming shared origins", () => {
  const mapper = createAnnotationCoordinateMapper({
    frameRect: { left: 300, top: 180, width: 800, height: 500 },
    frameOffsetWidth: 1600,
    frameOffsetHeight: 1000,
    layerRect: { left: 280, top: 160, width: 400, height: 250 },
    layerOffsetWidth: 800,
    layerOffsetHeight: 500,
  });

  assert.deepEqual(
    mapper.frameRectToLayer({ left: 100, top: 120, width: 240, height: 80 }),
    { left: 140, top: 160, width: 240, height: 80 },
  );
});
