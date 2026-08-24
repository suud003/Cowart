import { z } from "zod";

import {
  applyThinkingOperations,
  getThinkingContext,
  importThinkingMaterial,
  undoThinkingOperation,
} from "./thinking-canvas.mjs";

export const THINKING_TOOL_NAMES = {
  getContext: "get_cowart_thinking_context",
  importMaterial: "import_cowart_material",
  applyOperations: "apply_cowart_thinking_operations",
  undoOperation: "undo_cowart_thinking_operation",
};

const projectArgsSchema = {
  projectDir: z.string().trim().optional(),
  canvasDir: z.string().trim().optional(),
};

const placementSchema = z.enum(["right", "left", "below", "above"]);
const roleSchema = z.enum([
  "material",
  "idea",
  "evidence",
  "question",
  "insight",
  "assumption",
  "decision",
  "summary",
  "counterpoint",
]);

const sourceProvenanceSchema = z.object({
  origin: z.string().trim().max(80).optional(),
  uri: z.string().trim().max(2_000).nullable().optional(),
}).strict();

const sourceMetadataSchema = z.object({
  id: z.string().trim().max(160).optional(),
  kind: z.enum(["yogurt-shape", "user-note", "tapd-link", "document", "image", "code", "other"]).optional(),
  title: z.string().trim().max(300).optional(),
  summary: z.string().max(12_000).nullable().optional(),
  excerpt: z.string().max(3_000).nullable().optional(),
  yogurtShapeIds: z.array(z.string().trim().max(160)).max(100).optional(),
  provenance: sourceProvenanceSchema.optional(),
  accessStatus: z.enum(["available", "unread", "not-configured", "denied", "error"]).optional(),
  fileName: z.string().trim().max(240).optional(),
  localPath: z.string().trim().max(2_000).optional(),
  originalPath: z.string().trim().max(2_000).optional(),
  fileSize: z.number().int().min(0).max(200 * 1024 * 1024).optional(),
}).strict();

const bridgeMetadataSchema = z.object({
  mappingId: z.string().trim().max(160).optional(),
  workspaceId: z.string().trim().max(160).optional(),
  sourceIds: z.array(z.string().trim().max(160)).max(50).optional(),
  yogurtShapeIds: z.array(z.string().trim().max(160)).max(100).optional(),
  zoneId: z.string().trim().max(160).optional(),
  requirementIds: z.array(z.string().trim().max(160)).max(100).optional(),
  pageIds: z.array(z.string().trim().max(160)).max(100).optional(),
  annotationRefs: z.array(z.string().trim().max(320)).max(100).optional(),
  returnedShapeIds: z.array(z.string().trim().max(160)).max(100).optional(),
  lastSyncedRevision: z.string().trim().max(200).nullable().optional(),
}).strict();

const createCardSchema = z.object({
  type: z.literal("create_card"),
  key: z.string().trim().max(80).optional(),
  role: roleSchema.optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(12_000).optional(),
  color: z.string().trim().optional(),
  sourceRefs: z.array(z.string().trim().max(500)).max(50).optional(),
  source: sourceMetadataSchema.optional(),
  bridge: bridgeMetadataSchema.optional(),
  url: z.string().max(2_000).optional(),
  parentZoneId: z.string().trim().min(1).max(160).optional(),
  anchorId: z.string().trim().optional(),
  placement: placementSchema.optional(),
  gap: z.number().min(0).max(2_000).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().min(120).max(2_000).optional(),
  h: z.number().min(80).max(2_000).optional(),
});

const updateCardSchema = z.object({
  type: z.literal("update_card"),
  id: z.string().trim(),
  role: roleSchema.optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(12_000).optional(),
  color: z.string().trim().optional(),
  sourceRefs: z.array(z.string().trim().max(500)).max(50).optional(),
  source: sourceMetadataSchema.nullable().optional(),
  bridge: bridgeMetadataSchema.nullable().optional(),
  url: z.string().max(2_000).optional(),
});

const createZoneSchema = z.object({
  type: z.literal("create_zone"),
  key: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(12_000).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().min(240).max(8_192).optional(),
  h: z.number().min(160).max(8_192).optional(),
  color: z.string().trim().optional(),
  sourceRefs: z.array(z.string().trim().max(500)).max(50).optional(),
  bridge: bridgeMetadataSchema.optional(),
});

const updateZoneSchema = z.object({
  type: z.literal("update_zone"),
  id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(12_000).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().min(240).max(8_192).optional(),
  h: z.number().min(160).max(8_192).optional(),
  color: z.string().trim().optional(),
  sourceRefs: z.array(z.string().trim().max(500)).max(50).optional(),
  bridge: bridgeMetadataSchema.nullable().optional(),
});

const moveShapeSchema = z.object({
  type: z.literal("move_shape"),
  id: z.string().trim(),
  x: z.number(),
  y: z.number(),
});

const resizeShapeSchema = z.object({
  type: z.literal("resize_shape"),
  id: z.string().trim(),
  w: z.number().min(16).max(8_192),
  h: z.number().min(16).max(8_192),
});

const createRelationSchema = z.object({
  type: z.literal("create_relation"),
  key: z.string().trim().max(80).optional(),
  from: z.string().trim(),
  to: z.string().trim(),
  kind: z.string().trim().max(80).optional(),
  label: z.string().max(300).optional(),
  color: z.string().trim().optional(),
  dash: z.enum(["draw", "dashed"]).optional(),
});

const deleteShapeSchema = z.object({
  type: z.literal("delete_shape"),
  id: z.string().trim(),
});

const operationSchema = z.discriminatedUnion("type", [
  createCardSchema,
  updateCardSchema,
  createZoneSchema,
  updateZoneSchema,
  moveShapeSchema,
  resizeShapeSchema,
  createRelationSchema,
  deleteShapeSchema,
]);

function toolText(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

export function registerCowartThinkingTools(server) {
  server.registerTool(
    THINKING_TOOL_NAMES.getContext,
    {
      title: "Inspect Yogurt AI Thinking Context",
      description:
        "Read a compact, source-aware representation of the current Yogurt AI page or selection. When the UI captured a selection, pass its frozen shapeIds with scope=selection so later shared-selection changes cannot alter the request; selected frames and groups include their descendants. Use before planning any thinking-canvas edit; do not ask for the raw tldraw snapshot.",
      inputSchema: {
        ...projectArgsSchema,
        pageId: z.string().trim().optional(),
        scope: z.enum(["page", "selection"]).optional(),
        shapeIds: z.array(z.string().trim().min(1).max(160)).min(1).max(250).optional(),
        includeAnnotations: z.boolean().optional(),
        maxShapes: z.number().int().min(1).max(250).optional(),
        maxTextLength: z.number().int().min(200).max(4_000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const context = await getThinkingContext(input, input);
      return toolText(
        `Loaded ${context.shapes.length} Yogurt AI thinking object(s) from ${context.scope} at revision ${context.revision}.`,
        context,
      );
    },
  );

  server.registerTool(
    THINKING_TOOL_NAMES.importMaterial,
    {
      title: "Import Yogurt AI Material",
      description:
        "Attach a local source file to the Yogurt AI project and create an editable material card that preserves its path, excerpt, summary, and provenance.",
      inputSchema: {
        ...projectArgsSchema,
        sourcePath: z.string().trim(),
        fileName: z.string().trim().optional(),
        title: z.string().max(300).optional(),
        summary: z.string().max(12_000).optional(),
        excerpt: z.string().max(3_000).optional(),
        kind: z.string().trim().max(32).optional(),
        pageId: z.string().trim().optional(),
        baseRevision: z.string().trim().optional(),
        copySource: z.boolean().optional(),
        allowExternalSource: z.boolean().optional(),
        color: z.string().trim().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        w: z.number().min(120).max(2_000).optional(),
        h: z.number().min(80).max(2_000).optional(),
        reason: z.string().max(2_000).optional(),
        explanation: z.string().max(8_000).optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await importThinkingMaterial(input, input);
      const action = result.applied ? "Imported" : "Previewed";
      return toolText(
        `${action} material ${result.source.fileName} as ${result.references.material} at revision ${result.resultRevision}.`,
        result,
      );
    },
  );

  server.registerTool(
    THINKING_TOOL_NAMES.applyOperations,
    {
      title: "Apply Yogurt AI Thinking Operations",
      description:
        "Preview or atomically apply local, typed edits to Yogurt AI cards, product zones, positions, sizes, and relations. Product zones are safe tldraw frames with stable keys and constrained source/bridge trace metadata. create_card may use parentZoneId (a stable zone key or shape ID, including a zone created earlier in the same batch) to become a real frame child; supplied x/y remain page coordinates and are safely converted to frame-local coordinates, while omitted positions are padded and arranged inside the frame. Creation keys must be unique within a batch, and zone updates cannot cross the requested page. A connected batch of unpositioned page-level cards and relations is automatically arranged as a top-down Excalidraw-style graph. Deletion is limited to agent-generated shapes and refuses zones containing user-authored descendants. Pass the latest canvas revision and use dryRun before applying a non-trivial batch.",
      inputSchema: {
        ...projectArgsSchema,
        baseRevision: z.string().trim().optional(),
        pageId: z.string().trim().optional(),
        operations: z.array(operationSchema).min(1).max(100),
        reason: z.string().max(2_000).optional(),
        explanation: z.string().max(8_000).optional(),
        allowUserAuthoredEdits: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await applyThinkingOperations(input, input);
      return toolText(
        `${result.applied ? "Applied" : "Previewed"} ${result.changes.length} Yogurt AI thinking edit(s); result revision ${result.resultRevision}.`,
        result,
      );
    },
  );

  server.registerTool(
    THINKING_TOOL_NAMES.undoOperation,
    {
      title: "Undo Yogurt AI Thinking Operation",
      description:
        "Undo the latest compatible thinking-agent batch, or a named operation. Refuses to overwrite canvas work made after that batch.",
      inputSchema: {
        ...projectArgsSchema,
        operationId: z.string().trim().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input = {}) => {
      const result = await undoThinkingOperation(input, input);
      return toolText(
        `Undid Yogurt AI thinking operation ${result.operationId}; canvas revision is now ${result.revision}.`,
        result,
      );
    },
  );
}
