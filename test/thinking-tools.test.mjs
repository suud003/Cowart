import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { z } from "zod";

import { getThinkingContext } from "../mcp/lib/thinking-canvas.mjs";
import { registerCowartThinkingTools, THINKING_TOOL_NAMES } from "../mcp/lib/thinking-tools.mjs";

function registeredThinkingTools() {
  const tools = new Map();
  registerCowartThinkingTools({
    registerTool(name, definition, handler) {
      tools.set(name, { definition, handler });
    },
  });
  return tools;
}

function strictInputSchema(tool) {
  return z.object(tool.definition.inputSchema).strict();
}

test("safe thinking operations are non-destructive while the explicit destructive entry point remains available", () => {
  const tools = registeredThinkingTools();
  const safeTool = tools.get(THINKING_TOOL_NAMES.applySafeOperations);
  const destructiveTool = tools.get(THINKING_TOOL_NAMES.applyOperations);

  assert.ok(safeTool);
  assert.ok(destructiveTool);
  assert.equal(safeTool.definition.annotations.readOnlyHint, false);
  assert.equal(safeTool.definition.annotations.destructiveHint, false);
  assert.equal(destructiveTool.definition.annotations.destructiveHint, true);

  const safeSchema = strictInputSchema(safeTool);
  const destructiveSchema = strictInputSchema(destructiveTool);
  assert.equal(safeSchema.safeParse({
    operations: [{ type: "create_card", key: "idea", title: "Idea" }],
  }).success, true);
  assert.equal(safeSchema.safeParse({
    operations: [{ type: "delete_shape", id: "shape:managed" }],
  }).success, false);
  assert.equal(safeSchema.safeParse({
    operations: [{ type: "move_shape", id: "shape:managed", x: 10, y: 20 }],
    allowUserAuthoredEdits: true,
  }).success, false);
  assert.equal(destructiveSchema.safeParse({
    operations: [{ type: "delete_shape", id: "shape:managed" }],
    allowUserAuthoredEdits: true,
  }).success, true);
});

test("safe thinking operation handler rejects protected flags even when schema validation is bypassed", async () => {
  const safeTool = registeredThinkingTools().get(THINKING_TOOL_NAMES.applySafeOperations);

  await assert.rejects(
    safeTool.handler({
      allowUserAuthoredEdits: true,
      operations: [{ type: "move_shape", id: "shape:user", x: 10, y: 20 }],
    }),
    /cannot enable allowUserAuthoredEdits/,
  );
  await assert.rejects(
    safeTool.handler({ operations: [{ type: "delete_shape", id: "shape:managed" }] }),
    /cannot delete shapes/,
  );
});

test("safe thinking operation handler can create and move a Cowart-managed shape", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-safe-thinking-tool-"));
  try {
    const safeTool = registeredThinkingTools().get(THINKING_TOOL_NAMES.applySafeOperations);
    const initial = await getThinkingContext({ projectDir }, { scope: "page" });
    const created = await safeTool.handler({
      projectDir,
      baseRevision: initial.revision,
      operations: [{ type: "create_card", key: "managed", title: "Managed card" }],
    });
    const shapeId = created.structuredContent.references.managed;

    const moved = await safeTool.handler({
      projectDir,
      baseRevision: created.structuredContent.resultRevision,
      operations: [{ type: "move_shape", id: shapeId, x: 240, y: 180 }],
    });

    assert.equal(created.structuredContent.applied, true);
    assert.equal(moved.structuredContent.applied, true);
    assert.deepEqual(moved.structuredContent.changes, [
      { type: "move_shape", id: shapeId, x: 240, y: 180 },
    ]);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("safe semantic dry-run and apply return the same validated html-line-svg layout digest", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-safe-semantic-tool-"));
  try {
    const safeTool = registeredThinkingTools().get(THINKING_TOOL_NAMES.applySafeOperations);
    const initial = await getThinkingContext({ projectDir }, { scope: "page" });
    const semanticDiagram = {
      version: "1",
      diagramId: "ac-diagram:111111111111:222222222222",
      teachingClaim: "A decision updates the next state.",
      readingOrder: "left-to-right",
      diagramType: "flow",
      layoutEngine: "html-line-svg",
      layoutMode: "balanced",
      layoutFit: "fixed",
    };
    const operations = [
      { type: "create_zone", key: "flow", title: "Decision flow", purpose: "semantic", w: 1_200, h: 420, semantic: { id: "object:flow" } },
      { type: "create_card", key: "decision", title: "Decision", parentZoneId: "flow", semantic: { id: "object:decision", order: 1 } },
      { type: "create_card", key: "state", title: "Next state", parentZoneId: "flow", semantic: { id: "object:state", order: 2 } },
      { type: "create_relation", key: "decision-state", semanticId: "relation:decision-state", from: "decision", to: "state" },
    ];
    const preview = await safeTool.handler({
      projectDir,
      baseRevision: initial.revision,
      semanticDiagram,
      operations,
      dryRun: true,
    });
    const applied = await safeTool.handler({
      projectDir,
      baseRevision: preview.structuredContent.baseRevision,
      semanticDiagram,
      operations,
    });

    assert.equal(preview.structuredContent.layoutReport.valid, true);
    assert.deepEqual(preview.structuredContent.layoutReport.collisions, []);
    assert.deepEqual(preview.structuredContent.layoutReport.outOfBounds, []);
    assert.equal(
      preview.structuredContent.layoutReport.layoutDigest,
      applied.structuredContent.layoutReport.layoutDigest,
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});
