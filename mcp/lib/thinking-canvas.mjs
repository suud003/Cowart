import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { Store } from "@tldraw/store";
import { createTLSchema, toRichText } from "@tldraw/tlschema";
import { generateKeyBetween } from "fractional-indexing";

import { COWART_CARD_GEO } from "../../src/cowartGeoTypes.js";
import {
  readCowartCanvasState,
  readCowartSelectionState,
  resolveCanvasDir,
  resolveCowartPaths,
  saveCowartCanvasSnapshot,
} from "./canvas-storage.mjs";
import {
  estimateThinkingCardSize,
  estimateThinkingRelationGap,
  layoutThinkingGraph,
} from "./thinking-layout.mjs";

const PAGE_PREFIX = "page:";
const SHAPE_PREFIX = "shape:";
const BINDING_PREFIX = "binding:";
const HISTORY_VERSION = 1;
const HISTORY_LIMIT = 20;
const MATERIAL_SIZE_LIMIT = 200 * 1024 * 1024;
const DEFAULT_CARD_WIDTH = 320;
const DEFAULT_CARD_HEIGHT = 200;
const DEFAULT_ZONE_WIDTH = 960;
const DEFAULT_ZONE_HEIGHT = 640;
const DEFAULT_ZONE_PADDING = 40;
const DEFAULT_ZONE_CARD_GAP = 28;
const DEFAULT_GAP = 48;
const MAX_CONTEXT_SHAPES = 250;
const MAX_CONTEXT_TEXT = 4_000;
const EMPTY_PAGE_ID = "page:cowart-thinking";

const THINKING_ROLES = new Set([
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

const CARD_COLORS = new Set([
  "black",
  "blue",
  "green",
  "grey",
  "light-blue",
  "light-green",
  "light-red",
  "light-violet",
  "orange",
  "red",
  "violet",
  "white",
  "yellow",
]);

const ROLE_COLORS = {
  material: "light-blue",
  idea: "light-violet",
  evidence: "light-green",
  question: "yellow",
  insight: "violet",
  assumption: "orange",
  decision: "green",
  summary: "blue",
  counterpoint: "light-red",
};

const SOURCE_ACCESS_STATUSES = new Set([
  "available",
  "unread",
  "not-configured",
  "denied",
  "error",
]);
const SEMANTIC_READING_ORDERS = new Set([
  "left-to-right",
  "right-to-left",
  "top-to-bottom",
  "bottom-to-top",
  "center-out",
  "board-to-peers",
]);
const SEMANTIC_DIAGRAM_TYPES = new Set([
  "flow",
  "architecture",
  "comparison",
  "state",
  "interface",
  "swimlane",
  "concept",
  "hierarchy",
  "containment",
  "board-to-peers",
  "custom",
]);
const SEMANTIC_OBJECT_TYPES = new Set([
  "agent",
  "actor",
  "task",
  "process",
  "decision",
  "data",
  "interface",
  "state",
  "outcome",
  "note",
  "group",
  "container",
  "document",
  "claim",
  "evidence",
  "question",
  "zone",
  "system",
  "custom",
]);
const SEMANTIC_OBJECT_STATES = new Set(["normal", "warning", "blocked", "success", "question"]);
const SEMANTIC_ORIGINS = new Set([
  "source",
  "user",
  "synthesis",
  "inference",
  "unknown",
  "assumption",
  "question",
]);

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ensureThinkingSnapshot(snapshot) {
  if (snapshot?.store && snapshot?.schema) return snapshot;
  return {
    schema: createTLSchema().serialize(),
    store: {
      [EMPTY_PAGE_ID]: {
        id: EMPTY_PAGE_ID,
        typeName: "page",
        name: "Thinking Canvas",
        index: "a0",
        meta: {},
      },
    },
  };
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedString(value, maxLength, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength);
}

function boundedStringList(value, maxItems, maxLength = 160) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => boundedString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function compactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const compacted = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ""),
  );
  return Object.keys(compacted).length > 0 ? compacted : null;
}

function normalizeSourceMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fileSize = finiteNumber(value.fileSize, null);
  const yogurtShapeIds = boundedStringList(value.yogurtShapeIds, 100);
  const provenance = value.provenance && typeof value.provenance === "object" && !Array.isArray(value.provenance)
    ? compactObject({
        origin: boundedString(value.provenance.origin, 80) || null,
        uri: boundedString(value.provenance.uri, 2_000) || null,
      })
    : null;
  return compactObject({
    id: boundedString(value.id, 160) || null,
    kind: boundedString(value.kind, 32) || null,
    title: boundedString(value.title, 300) || null,
    summary: boundedString(value.summary, 12_000) || null,
    excerpt: boundedString(value.excerpt, 3_000) || null,
    yogurtShapeIds: yogurtShapeIds.length > 0 ? yogurtShapeIds : null,
    provenance,
    accessStatus: SOURCE_ACCESS_STATUSES.has(value.accessStatus) ? value.accessStatus : null,
    fileName: boundedString(value.fileName, 240) || null,
    localPath: boundedString(value.localPath, 2_000) || null,
    originalPath: boundedString(value.originalPath, 2_000) || null,
    fileSize: fileSize === null ? null : Math.max(0, Math.min(MATERIAL_SIZE_LIMIT, Math.floor(fileSize))),
  });
}

function normalizeBridgeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceIds = boundedStringList(value.sourceIds, 50);
  const yogurtShapeIds = boundedStringList(value.yogurtShapeIds, 100);
  const requirementIds = boundedStringList(value.requirementIds, 100);
  const pageIds = boundedStringList(value.pageIds, 100);
  const annotationRefs = boundedStringList(value.annotationRefs, 100, 320);
  const returnedShapeIds = boundedStringList(value.returnedShapeIds, 100);
  return compactObject({
    mappingId: boundedString(value.mappingId, 160) || null,
    workspaceId: boundedString(value.workspaceId, 160) || null,
    sourceIds: sourceIds.length > 0 ? sourceIds : null,
    yogurtShapeIds: yogurtShapeIds.length > 0 ? yogurtShapeIds : null,
    zoneId: boundedString(value.zoneId, 160) || null,
    requirementIds: requirementIds.length > 0 ? requirementIds : null,
    pageIds: pageIds.length > 0 ? pageIds : null,
    annotationRefs: annotationRefs.length > 0 ? annotationRefs : null,
    returnedShapeIds: returnedShapeIds.length > 0 ? returnedShapeIds : null,
    lastSyncedRevision: boundedString(value.lastSyncedRevision, 200) || null,
  });
}

function normalizeSemanticDiagramMetadata(value, operations = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const teachingClaim = boundedString(value.teachingClaim, 500);
  const diagramId = boundedString(value.diagramId, 160);
  if (
    value.version !== "1" ||
    !diagramId ||
    !teachingClaim ||
    !SEMANTIC_READING_ORDERS.has(value.readingOrder) ||
    !SEMANTIC_DIAGRAM_TYPES.has(value.diagramType)
  ) {
    throw new Error("semanticDiagram must include a valid version, diagramId, teachingClaim, readingOrder, and diagramType.");
  }
  return {
    version: "1",
    diagramId,
    teachingClaim,
    readingOrder: value.readingOrder,
    diagramType: value.diagramType,
    sourceShapeIds: boundedStringList(value.sourceShapeIds, 250),
    sourceIds: boundedStringList(value.sourceIds, 100),
    objectCount: Number.isInteger(value.objectCount)
      ? Math.max(0, Math.min(250, value.objectCount))
      : operations.filter((operation) => ["create_card", "create_zone"].includes(operation?.type)).length,
    relationCount: Number.isInteger(value.relationCount)
      ? Math.max(0, Math.min(500, value.relationCount))
      : operations.filter((operation) => operation?.type === "create_relation").length,
    specDigest: boundedString(value.specDigest, 128) || null,
  };
}

function normalizeSemanticObject(value, diagram, fallbackId) {
  if (!diagram) return null;
  const semanticId = boundedString(value?.id, 160) || boundedString(fallbackId, 160);
  if (!semanticId) throw new Error("Every native semantic object requires semantic.id or a stable creation key.");
  return {
    version: "1",
    diagramId: diagram.diagramId,
    semanticId,
    type: SEMANTIC_OBJECT_TYPES.has(value?.type) ? value.type : "custom",
    state: SEMANTIC_OBJECT_STATES.has(value?.state) ? value.state : "normal",
    origin: SEMANTIC_ORIGINS.has(value?.origin) ? value.origin : "synthesis",
    order: Math.max(0, Math.min(999, Math.trunc(finiteNumber(value?.order, 0)))),
    sourceShapeIds: boundedStringList(value?.sourceShapeIds, 100),
    sourceIds: boundedStringList(value?.sourceIds, 100),
  };
}

const SEMANTIC_OBJECT_PATCH_FIELDS = new Set([
  "type",
  "state",
  "origin",
  "order",
  "sourceShapeIds",
  "sourceIds",
]);

function patchSemanticObject(current, patch, diagram, label) {
  if (patch === undefined) return current;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(`${label}.semantic must be an object.`);
  }
  const unsupported = Object.keys(patch).filter((key) => !SEMANTIC_OBJECT_PATCH_FIELDS.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      `${label}.semantic cannot change semanticId or diagramId; unsupported field(s): ${unsupported.join(", ")}.`,
    );
  }
  if (!current || typeof current !== "object" || !current.semanticId || !current.diagramId) {
    throw new Error(`${label}.semantic requires an existing native semantic object.`);
  }
  if (!diagram || current.diagramId !== diagram.diagramId) {
    throw new Error(`${label}.semantic must stay in diagram ${current.diagramId}.`);
  }
  const next = { ...current };
  if (patch.type !== undefined) {
    if (!SEMANTIC_OBJECT_TYPES.has(patch.type)) throw new Error(`${label}.semantic.type is invalid.`);
    next.type = patch.type;
  }
  if (patch.state !== undefined) {
    if (!SEMANTIC_OBJECT_STATES.has(patch.state)) throw new Error(`${label}.semantic.state is invalid.`);
    next.state = patch.state;
  }
  if (patch.origin !== undefined) {
    if (!SEMANTIC_ORIGINS.has(patch.origin)) throw new Error(`${label}.semantic.origin is invalid.`);
    next.origin = patch.origin;
  }
  if (patch.order !== undefined) {
    if (!Number.isInteger(patch.order) || patch.order < 0 || patch.order > 999) {
      throw new Error(`${label}.semantic.order must be an integer from 0 to 999.`);
    }
    next.order = patch.order;
  }
  if (patch.sourceShapeIds !== undefined) {
    next.sourceShapeIds = boundedStringList(patch.sourceShapeIds, 100);
  }
  if (patch.sourceIds !== undefined) {
    next.sourceIds = boundedStringList(patch.sourceIds, 100);
  }
  return next;
}

function safeRole(value, fallback = "idea") {
  return THINKING_ROLES.has(value) ? value : fallback;
}

function safeColor(value, role = "idea") {
  return CARD_COLORS.has(value) ? value : ROLE_COLORS[role] ?? "light-violet";
}

function diagramColor(value) {
  return CARD_COLORS.has(value) ? value : "black";
}

function zoneColor(value) {
  return CARD_COLORS.has(value) ? value : "grey";
}

function safeIdPart(value, fallback = "item") {
  const normalized = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function uniqueId(store, prefix, seed) {
  const safeSeed = safeIdPart(seed);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const suffix = attempt === 0 ? randomUUID().slice(0, 8) : `${attempt}-${randomUUID().slice(0, 6)}`;
    const id = `${prefix}${safeSeed}-${suffix}`;
    if (!store[id]) return id;
  }
  throw new Error(`Unable to allocate a unique ${prefix} id.`);
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return Boolean(pathToChild) && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function plainTextFromRichText(richText) {
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

function textForShape(shape) {
  if (!shape) return "";
  if (typeof shape.meta?.cowartThinkingBody === "string") {
    return shape.meta.cowartThinkingBody.trim();
  }
  if (shape.props?.richText) return plainTextFromRichText(shape.props.richText);
  if (typeof shape.props?.text === "string") return shape.props.text.trim();
  if (typeof shape.props?.name === "string") return shape.props.name.trim();
  if (typeof shape.props?.altText === "string") return shape.props.altText.trim();
  return "";
}

function localBounds(shape) {
  if (shape?.type === "arrow") {
    const start = shape.props?.start ?? { x: 0, y: 0 };
    const end = shape.props?.end ?? { x: 0, y: 0 };
    const minX = Math.min(finiteNumber(start.x, 0), finiteNumber(end.x, 0));
    const minY = Math.min(finiteNumber(start.y, 0), finiteNumber(end.y, 0));
    return {
      x: finiteNumber(shape.x, 0) + minX,
      y: finiteNumber(shape.y, 0) + minY,
      w: Math.max(1, Math.abs(finiteNumber(end.x, 0) - finiteNumber(start.x, 0))),
      h: Math.max(1, Math.abs(finiteNumber(end.y, 0) - finiteNumber(start.y, 0))),
    };
  }

  const scale = Math.max(0.01, finiteNumber(shape?.props?.scale, 1));
  return {
    x: finiteNumber(shape?.x, 0),
    y: finiteNumber(shape?.y, 0),
    w: Math.max(1, finiteNumber(shape?.props?.w, shape?.type === "text" ? 160 : DEFAULT_CARD_WIDTH) * scale),
    h: Math.max(1, (finiteNumber(shape?.props?.h, shape?.type === "text" ? 40 : DEFAULT_CARD_HEIGHT) + finiteNumber(shape?.props?.growY, 0)) * scale),
  };
}

function pageBounds(store, shape) {
  const bounds = localBounds(shape);
  let parentId = shape?.parentId;
  const visited = new Set([shape?.id]);
  while (typeof parentId === "string" && parentId.startsWith(SHAPE_PREFIX) && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = store[parentId];
    if (!parent) break;
    bounds.x += finiteNumber(parent.x, 0);
    bounds.y += finiteNumber(parent.y, 0);
    parentId = parent.parentId;
  }
  return bounds;
}

function unionBounds(boundsList) {
  if (boundsList.length === 0) return null;
  const minX = Math.min(...boundsList.map((bounds) => bounds.x));
  const minY = Math.min(...boundsList.map((bounds) => bounds.y));
  const maxX = Math.max(...boundsList.map((bounds) => bounds.x + bounds.w));
  const maxY = Math.max(...boundsList.map((bounds) => bounds.y + bounds.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function expandedBounds(bounds, padding) {
  if (!bounds) return null;
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    w: bounds.w + padding * 2,
    h: bounds.h + padding * 2,
  };
}

function boundsIntersect(first, second) {
  if (!first || !second) return false;
  return !(
    first.x + first.w < second.x ||
    second.x + second.w < first.x ||
    first.y + first.h < second.y ||
    second.y + second.h < first.y
  );
}

function pageIdForShape(store, shape) {
  let parentId = shape?.parentId;
  const visited = new Set([shape?.id]);
  while (typeof parentId === "string" && !visited.has(parentId)) {
    if (parentId.startsWith(PAGE_PREFIX)) return parentId;
    visited.add(parentId);
    parentId = store[parentId]?.parentId;
  }
  return null;
}

function pageShapes(store, pageId) {
  return Object.values(store).filter(
    (record) => record?.typeName === "shape" && pageIdForShape(store, record) === pageId,
  );
}

function translateLayoutPositions(positions, dx, dy) {
  return new Map(
    Array.from(positions, ([id, position]) => [id, { x: position.x + dx, y: position.y + dy }]),
  );
}

function positionedNodeBounds(nodes, positions) {
  return nodes.map((node) => ({
    x: positions.get(node.id).x,
    y: positions.get(node.id).y,
    w: node.w,
    h: node.h,
  }));
}

function placementOverlaps(positions, nodes, obstacles, padding = 0) {
  const paddedObstacles = obstacles.map((bounds) => expandedBounds(bounds, padding));
  return positionedNodeBounds(nodes, positions).some((bounds) =>
    paddedObstacles.some((obstacle) => boundsIntersect(bounds, obstacle)),
  );
}

function safePerpendicularSemanticPlacement({
  positions,
  nodes,
  obstacles,
  horizontal,
  spacing,
  parentZone,
}) {
  if (!placementOverlaps(positions, nodes, obstacles, DEFAULT_GAP / 2)) return positions;
  const nodeSpan = horizontal
    ? Math.max(...nodes.map((node) => node.h), DEFAULT_CARD_HEIGHT)
    : Math.max(...nodes.map((node) => node.w), DEFAULT_CARD_WIDTH);
  const step = nodeSpan + spacing;
  const minX = parentZone ? DEFAULT_ZONE_PADDING : Number.NEGATIVE_INFINITY;
  const minY = parentZone ? DEFAULT_ZONE_PADDING + 32 : Number.NEGATIVE_INFINITY;
  const maxX = parentZone ? 8_192 - DEFAULT_ZONE_PADDING : Number.POSITIVE_INFINITY;
  const maxY = parentZone ? 8_192 - DEFAULT_ZONE_PADDING : Number.POSITIVE_INFINITY;
  for (let ring = 1; ring <= 64; ring += 1) {
    for (const sign of [1, -1]) {
      const candidate = translateLayoutPositions(
        positions,
        horizontal ? 0 : sign * ring * step,
        horizontal ? sign * ring * step : 0,
      );
      const bounds = positionedNodeBounds(nodes, candidate);
      if (bounds.some((item) =>
        item.x < minX || item.y < minY || item.x + item.w > maxX || item.y + item.h > maxY,
      )) {
        continue;
      }
      if (!placementOverlaps(candidate, nodes, obstacles, DEFAULT_GAP / 2)) return candidate;
    }
  }
  throw new Error(
    "Incremental semantic layout cannot find a safe position without overlapping fixed sibling shapes; " +
    "provide explicit coordinates.",
  );
}

function thinkingRelationBindings(store, relationId) {
  return Object.values(store).filter((record) =>
    record?.typeName === "binding" &&
    record.type === "arrow" &&
    record.fromId === relationId,
  );
}

function uniqueBoundTerminalShape(store, bindings, terminal) {
  const terminalBindings = bindings.filter((record) =>
    record.props?.terminal === terminal && store[record.toId]?.typeName === "shape",
  );
  return terminalBindings.length === 1 ? store[terminalBindings[0].toId] : null;
}

function boundThinkingRelationEndpoints(store, relation, { syncMeta = false } = {}) {
  if (relation?.typeName !== "shape" || relation.type !== "arrow") {
    return {
      from: null,
      to: null,
      fromId: null,
      toId: null,
      bindingMode: "none",
      bindingCount: 0,
      complete: false,
    };
  }
  const bindings = thinkingRelationBindings(store, relation.id);
  const usesBindings = bindings.length > 0;
  const boundFrom = uniqueBoundTerminalShape(store, bindings, "start");
  const boundTo = uniqueBoundTerminalShape(store, bindings, "end");
  const metaFrom = store[relation.meta?.cowartThinkingFromShapeId];
  const metaTo = store[relation.meta?.cowartThinkingToShapeId];
  // Bindings are authoritative as soon as at least one exists. Falling back one
  // terminal at a time resurrects endpoints that a user deliberately unbound in
  // the UI. Metadata fallback is reserved for truly legacy arrows with no bindings.
  const from = usesBindings ? boundFrom : (metaFrom?.typeName === "shape" ? metaFrom : null);
  const to = usesBindings ? boundTo : (metaTo?.typeName === "shape" ? metaTo : null);
  if (syncMeta && relation.meta && from && to) {
    relation.meta.cowartThinkingFromShapeId = from.id;
    relation.meta.cowartThinkingToShapeId = to.id;
  }
  return {
    from,
    to,
    fromId: from?.id ?? null,
    toId: to?.id ?? null,
    bindingMode: usesBindings ? "bindings" : "legacy-meta",
    bindingCount: bindings.length,
    complete: Boolean(from && to),
  };
}

function semanticRelationValidity(store, relation, endpoints = null) {
  if (!relation?.meta?.cowartSemanticRelation) return { valid: true, unsafe: false, reason: null };
  const resolved = endpoints ?? boundThinkingRelationEndpoints(store, relation);
  if (!resolved.complete) {
    const detail = resolved.bindingMode === "bindings"
      ? "semantic relation has incomplete or ambiguous UI bindings"
      : "legacy semantic relation metadata has incomplete endpoints";
    return { valid: false, unsafe: false, reason: detail };
  }
  const diagramId = boundedString(relation.meta?.cowartSemanticDiagram?.diagramId, 160) ||
    boundedString(relation.meta?.cowartSemanticRelation?.diagramId, 160);
  if (!diagramId) return { valid: false, unsafe: true, reason: "semantic relation has no diagramId" };
  for (const [terminal, shape] of [["start", resolved.from], ["end", resolved.to]]) {
    const objectDiagramId = shape?.meta?.cowartSemanticObject?.diagramId;
    const shapeDiagramId = shape?.meta?.cowartSemanticDiagram?.diagramId;
    if (!objectDiagramId || !shapeDiagramId) {
      return { valid: false, unsafe: true, reason: `${terminal} binding targets a non-semantic shape` };
    }
    if (objectDiagramId !== diagramId || shapeDiagramId !== diagramId) {
      return { valid: false, unsafe: true, reason: `${terminal} binding crosses semantic diagrams` };
    }
  }
  return { valid: true, unsafe: false, reason: null };
}

function invalidSemanticRelations(store) {
  return Object.values(store)
    .filter((record) =>
      record?.typeName === "shape" &&
      record.type === "arrow" &&
      record.meta?.cowartSemanticRelation,
    )
    .map((record) => ({ record, ...semanticRelationValidity(store, record) }))
    .filter(({ valid }) => !valid);
}

function syncThinkingRelationEndpointMetadata(store) {
  for (const record of Object.values(store)) {
    if (
      record?.typeName === "shape" &&
      record.type === "arrow" &&
      record.meta?.cowartThinkingRelation === true
    ) {
      boundThinkingRelationEndpoints(store, record, { syncMeta: true });
    }
  }
}

function firstPageId(snapshot) {
  return Object.values(snapshot?.store ?? {})
    .filter((record) => record?.typeName === "page")
    .sort((a, b) => String(a.index ?? "").localeCompare(String(b.index ?? "")))[0]?.id ?? null;
}

function resolvePageId(snapshot, requestedPageId, viewState) {
  const store = snapshot?.store ?? {};
  const candidates = [requestedPageId, viewState?.currentPageId, firstPageId(snapshot)];
  const pageId = candidates.find((candidate) => typeof candidate === "string" && store[candidate]?.typeName === "page");
  if (!pageId) throw new Error("Yogurt AI canvas has no usable page.");
  return pageId;
}

function selectedShapeIds(selection) {
  return new Set(
    (selection?.selectedShapes ?? [])
      .map((shape) => shape?.id)
      .filter((id) => typeof id === "string"),
  );
}

function isAnnotationShape(shape) {
  if (!shape) return false;
  if (shape.meta?.cowartAnnotationArrow === true || shape.meta?.cowartAnnotationText === true) return true;
  if (!["arrow", "draw", "highlight", "text"].includes(shape.type)) return false;
  return ["red", "orange", "yellow"].includes(shape.props?.color) ||
    ["red", "orange", "yellow"].includes(shape.props?.labelColor);
}

function inferShapeRole(shape) {
  if (shape?.meta?.cowartThinkingZone === true || shape?.meta?.cowartProductZone === true) return "zone";
  if (THINKING_ROLES.has(shape?.meta?.cowartThinkingRole)) return shape.meta.cowartThinkingRole;
  if (isAnnotationShape(shape)) return "annotation";
  if (shape?.meta?.cowartThinkingMaterial === true) return "material";
  if (shape?.meta?.cowartHtmlDraft === true || shape?.meta?.cowartAiDraftHolder === true) return "visual";
  if (shape?.type === "image") return "image";
  if (shape?.type === "arrow") return "relation";
  return "canvas-object";
}

function compactSource(meta) {
  const source = meta?.cowartThinkingSource;
  if (!source || typeof source !== "object") return null;
  return {
    id: boundedString(source.id, 160) || null,
    kind: boundedString(source.kind, 32) || null,
    title: boundedString(source.title, 300) || null,
    summary: boundedString(source.summary, 12_000) || null,
    yogurtShapeIds: boundedStringList(source.yogurtShapeIds, 100),
    provenance: source.provenance && typeof source.provenance === "object"
      ? {
          origin: boundedString(source.provenance.origin, 80) || null,
          uri: boundedString(source.provenance.uri, 2_000) || null,
        }
      : null,
    accessStatus: SOURCE_ACCESS_STATUSES.has(source.accessStatus) ? source.accessStatus : null,
    fileName: boundedString(source.fileName, 240) || null,
    localPath: boundedString(source.localPath, 2_000) || null,
    originalPath: boundedString(source.originalPath, 2_000) || null,
    excerpt: boundedString(source.excerpt, 1_500) || null,
    fileSize: finiteNumber(source.fileSize, null),
  };
}

function compactBridge(meta) {
  const bridge = normalizeBridgeMetadata(meta?.cowartProductBridge);
  return bridge ? cloneJson(bridge) : null;
}

function compactVisual(shape) {
  if (shape?.meta?.cowartHtmlDraft !== true) return null;
  const semantic = shape.meta?.cowartSemanticDiagram;
  if (!semantic || typeof semantic !== "object") return null;
  const readingOrders = new Set([
    "left-to-right",
    "right-to-left",
    "top-to-bottom",
    "bottom-to-top",
    "center-out",
    "board-to-peers",
  ]);
  const diagramTypes = new Set([
    "flow",
    "architecture",
    "comparison",
    "state",
    "interface",
    "swimlane",
    "concept",
    "hierarchy",
    "containment",
    "board-to-peers",
    "custom",
  ]);
  return {
    kind: "semantic-line-svg",
    assetUrl: boundedString(shape.meta?.cowartHtmlDraftAssetUrl, 2_000) || null,
    semanticDiagram: {
      version: semantic.version === "1" ? "1" : null,
      teachingClaim: boundedString(semantic.teachingClaim, 500) || null,
      readingOrder: readingOrders.has(semantic.readingOrder) ? semantic.readingOrder : null,
      diagramType: diagramTypes.has(semantic.diagramType) ? semantic.diagramType : null,
      sourceShapeIds: boundedStringList(semantic.sourceShapeIds, MAX_CONTEXT_SHAPES, 160),
      sourceIds: boundedStringList(semantic.sourceIds, 100, 160),
      workspaceId: boundedString(semantic.workspaceId, 160) || null,
      zoneId: boundedString(semantic.zoneId, 160) || null,
      objectCount: Math.max(0, Math.min(250, Math.trunc(finiteNumber(semantic.objectCount, 0)))),
      relationCount: Math.max(0, Math.min(500, Math.trunc(finiteNumber(semantic.relationCount, 0)))),
      specDigest: boundedString(semantic.specDigest, 128) || null,
      promptDigest: boundedString(semantic.promptDigest, 128) || null,
    },
  };
}

function compactNativeSemantic(shape) {
  const diagram = shape?.meta?.cowartSemanticDiagram;
  if (!diagram || typeof diagram !== "object") return null;
  const object = shape.meta?.cowartSemanticObject;
  const relation = shape.meta?.cowartSemanticRelation;
  return {
    diagramId: boundedString(diagram.diagramId, 160) || null,
    teachingClaim: boundedString(diagram.teachingClaim, 500) || null,
    readingOrder: SEMANTIC_READING_ORDERS.has(diagram.readingOrder) ? diagram.readingOrder : null,
    diagramType: SEMANTIC_DIAGRAM_TYPES.has(diagram.diagramType) ? diagram.diagramType : null,
    sourceShapeIds: boundedStringList(diagram.sourceShapeIds, MAX_CONTEXT_SHAPES),
    sourceIds: boundedStringList(diagram.sourceIds, 100),
    objectCount: Math.max(0, Math.min(250, Math.trunc(finiteNumber(diagram.objectCount, 0)))),
    relationCount: Math.max(0, Math.min(500, Math.trunc(finiteNumber(diagram.relationCount, 0)))),
    specDigest: boundedString(diagram.specDigest, 128) || null,
    object: object && typeof object === "object"
      ? {
          semanticId: boundedString(object.semanticId, 160) || null,
          type: boundedString(object.type, 80) || null,
          state: boundedString(object.state, 80) || null,
          origin: boundedString(object.origin, 80) || null,
          order: Math.max(0, Math.trunc(finiteNumber(object.order, 0))),
          sourceShapeIds: boundedStringList(object.sourceShapeIds, 100),
          sourceIds: boundedStringList(object.sourceIds, 100),
        }
      : null,
    relation: relation && typeof relation === "object"
      ? {
          semanticId: boundedString(relation.semanticId, 160) || null,
          type: boundedString(relation.type, 80) || null,
          direction: boundedString(relation.direction, 40) || null,
          path: boundedString(relation.path, 40) || null,
          payload: boundedString(relation.payload, 300) || null,
          lane: Math.trunc(finiteNumber(relation.lane, 0)),
          origin: SEMANTIC_ORIGINS.has(relation.origin) ? relation.origin : null,
          sourceShapeIds: boundedStringList(relation.sourceShapeIds, 100),
          sourceIds: boundedStringList(relation.sourceIds, 100),
        }
      : null,
  };
}

function shapeContext(store, shape, selected, maxTextLength) {
  const asset = shape?.props?.assetId ? store[shape.props.assetId] : null;
  const parent = typeof shape?.parentId === "string" ? store[shape.parentId] : null;
  const relationEndpoints = shape.meta?.cowartThinkingRelation === true
    ? boundThinkingRelationEndpoints(store, shape)
    : null;
  const relationValidity = shape.meta?.cowartSemanticRelation
    ? semanticRelationValidity(store, shape, relationEndpoints)
    : null;
  const nativeSemantic = compactNativeSemantic(shape);
  if (nativeSemantic?.relation && relationValidity) {
    nativeSemantic.relation.valid = relationValidity.valid;
    nativeSemantic.relation.unsafe = relationValidity.unsafe;
    nativeSemantic.relation.invalidReason = relationValidity.reason;
  }
  return {
    id: shape.id,
    type: shape.type,
    role: inferShapeRole(shape),
    selected,
    bounds: pageBounds(store, shape),
    title: boundedString(shape.meta?.cowartThinkingTitle, 300) || null,
    text: boundedString(textForShape(shape), maxTextLength) || null,
    source: compactSource(shape.meta),
    key: boundedString(
      shape.meta?.cowartThinkingKey ?? shape.meta?.cowartThinkingZoneKey ?? shape.meta?.cowartProductZoneKey,
      80,
    ) || null,
    sourceRefs: boundedStringList(shape.meta?.cowartThinkingSourceRefs, 50, 500),
    zone: shape.meta?.cowartThinkingZone === true || shape.meta?.cowartProductZone === true
      ? {
          key: boundedString(shape.meta?.cowartThinkingZoneKey ?? shape.meta?.cowartProductZoneKey, 80) || null,
          ...(shape.meta?.cowartThinkingZonePurpose && shape.meta.cowartThinkingZonePurpose !== "product"
            ? { purpose: boundedString(shape.meta.cowartThinkingZonePurpose, 32) }
            : {}),
        }
      : null,
    parentZone: parent?.meta?.cowartThinkingZone === true || parent?.meta?.cowartProductZone === true
      ? {
          id: parent.id,
          key: boundedString(parent.meta?.cowartThinkingZoneKey ?? parent.meta?.cowartProductZoneKey, 80) || null,
          ...(parent.meta?.cowartThinkingZonePurpose && parent.meta.cowartThinkingZonePurpose !== "product"
            ? { purpose: boundedString(parent.meta.cowartThinkingZonePurpose, 32) }
            : {}),
        }
      : null,
    bridge: compactBridge(shape.meta),
    visual: compactVisual(shape),
    semantic: nativeSemantic,
    relation: shape.meta?.cowartThinkingRelation === true
      ? {
          fromId: relationEndpoints.fromId,
          toId: relationEndpoints.toId,
          kind: shape.meta.cowartThinkingRelationKind ?? "relates-to",
          direction: shape.meta.cowartSemanticRelation?.direction ?? shape.meta.cowartThinkingRelationDirection ?? "forward",
          path: shape.meta.cowartSemanticRelation?.path ?? shape.meta.cowartThinkingRelationPath ?? "primary",
          payload: shape.meta.cowartSemanticRelation?.payload ?? shape.meta.cowartThinkingRelationPayload ?? null,
          lane: storedRelationLane(shape),
          ...(relationValidity
            ? {
                valid: relationValidity.valid,
                unsafe: relationValidity.unsafe,
                invalidReason: relationValidity.reason,
              }
            : {}),
        }
      : null,
    asset: asset
      ? {
          id: asset.id,
          type: asset.type,
          name: asset.props?.name ?? null,
          src: asset.props?.src ?? null,
          mimeType: asset.props?.mimeType ?? null,
        }
      : null,
    generatedByAgent: shape.meta?.cowartThinkingGenerated === true,
  };
}

export function snapshotRevision(snapshot) {
  const content = JSON.stringify(snapshot?.store ?? {});
  return createHash("sha256").update(content).digest("hex").slice(0, 20);
}

export function summarizeThinkingContext({
  snapshot,
  selection = { selectedShapes: [] },
  viewState = null,
  pageId: requestedPageId,
  scope = "page",
  shapeIds: requestedShapeIds,
  includeAnnotations = true,
  maxShapes = MAX_CONTEXT_SHAPES,
  maxTextLength = MAX_CONTEXT_TEXT,
} = {}) {
  if (!snapshot?.store || !snapshot?.schema) throw new Error("Expected a valid Yogurt AI snapshot.");
  const store = snapshot.store;
  const hasFrozenSelection = scope === "selection" && Array.isArray(requestedShapeIds);
  const frozenSelectedIds = hasFrozenSelection
    ? new Set(boundedStringList(requestedShapeIds, MAX_CONTEXT_SHAPES, 160))
    : null;
  const inferredSelectionPageId = hasFrozenSelection
    ? Array.from(frozenSelectedIds)
      .map((id) => store[id])
      .filter((shape) => shape?.typeName === "shape")
      .map((shape) => pageIdForShape(store, shape))
      .find(Boolean) ?? null
    : null;
  const pageId = resolvePageId(snapshot, requestedPageId ?? inferredSelectionPageId, viewState);
  const selectedIds = frozenSelectedIds ?? selectedShapeIds(selection);
  const scopeShapeIds = new Set(selectedIds);
  for (const selectedId of selectedIds) {
    const selectedShape = store[selectedId];
    if (selectedShape?.typeName !== "shape" || pageIdForShape(store, selectedShape) !== pageId) continue;
    for (const descendantId of descendantShapeIds(store, selectedId)) scopeShapeIds.add(descendantId);
  }
  const allShapes = pageShapes(store, pageId);
  const selectedRelationIds = new Set();
  const selectedBounds = unionBounds(
    allShapes
      .filter((shape) => scopeShapeIds.has(shape.id))
      .map((shape) => pageBounds(store, shape)),
  );
  const annotationRegion = expandedBounds(selectedBounds, 160);

  if (scope === "selection" && selectedIds.size > 0) {
    for (const shape of allShapes) {
      const endpoints = boundThinkingRelationEndpoints(store, shape);
      if (
        shape.meta?.cowartThinkingRelation === true &&
        (scopeShapeIds.has(endpoints.fromId) || scopeShapeIds.has(endpoints.toId))
      ) {
        selectedRelationIds.add(shape.id);
      }
    }
  }

  const filtered = allShapes.filter((shape) => {
    if (!includeAnnotations && isAnnotationShape(shape)) return false;
    if (scope !== "selection" || selectedIds.size === 0) return true;
    return (
      scopeShapeIds.has(shape.id) ||
      selectedRelationIds.has(shape.id) ||
      (includeAnnotations && isAnnotationShape(shape) && boundsIntersect(pageBounds(store, shape), annotationRegion))
    );
  });

  const limited = filtered.slice(0, Math.max(1, Math.min(maxShapes, MAX_CONTEXT_SHAPES)));
  return {
    version: 1,
    revision: snapshotRevision(snapshot),
    pageId,
    scope: scope === "selection" && selectedIds.size > 0 ? "selection" : "page",
    selection: Array.from(selectedIds),
    shapes: limited.map((shape) =>
      shapeContext(store, shape, selectedIds.has(shape.id), Math.max(200, Math.min(maxTextLength, MAX_CONTEXT_TEXT))),
    ),
    truncated: filtered.length > limited.length,
    omittedShapeCount: Math.max(0, filtered.length - limited.length),
  };
}

function lastShapeIndex(store, parentId) {
  const indexes = Object.values(store)
    .filter((record) => record?.typeName === "shape" && record.parentId === parentId && typeof record.index === "string")
    .map((record) => record.index)
    .sort();
  return indexes.at(-1) ?? null;
}

function nextIndex(store, parentId) {
  return generateKeyBetween(lastShapeIndex(store, parentId), null);
}

function firstShapeIndex(store, parentId) {
  return Object.values(store)
    .filter((record) => record?.typeName === "shape" && record.parentId === parentId && typeof record.index === "string")
    .map((record) => record.index)
    .sort()
    .at(0) ?? null;
}

function previousIndex(store, parentId) {
  return generateKeyBetween(null, firstShapeIndex(store, parentId));
}

function formatCardText(title, body) {
  return [title, body].filter(Boolean).join("\n\n");
}

function explicitOrAnchoredCardPagePosition(store, pageId, operation, width, height, references) {
  if (Number.isFinite(operation.x) && Number.isFinite(operation.y)) {
    return { x: operation.x, y: operation.y };
  }

  const anchorId = typeof operation.anchorId === "string"
    ? references.get(operation.anchorId) ?? operation.anchorId
    : null;
  const anchor = typeof anchorId === "string" ? store[anchorId] : null;
  if (anchor?.typeName === "shape") {
    if (pageIdForShape(store, anchor) !== pageId) {
      throw new Error(`create_card.anchorId is not on page ${pageId}: ${operation.anchorId}`);
    }
    const bounds = pageBounds(store, anchor);
    const gap = Math.max(0, finiteNumber(operation.gap, DEFAULT_GAP));
    const placement = ["right", "left", "below", "above"].includes(operation.placement)
      ? operation.placement
      : "right";
    if (placement === "left") return { x: bounds.x - width - gap, y: bounds.y };
    if (placement === "below") return { x: bounds.x, y: bounds.y + bounds.h + gap };
    if (placement === "above") return { x: bounds.x, y: bounds.y - height - gap };
    return { x: bounds.x + bounds.w + gap, y: bounds.y };
  }

  return null;
}

function zoneCardPosition(store, zone, operation, width, height, references, pageId) {
  if (Math.abs(finiteNumber(zone.rotation, 0)) > Number.EPSILON) {
    throw new Error(`Cannot safely place a card in rotated product zone ${zone.id}.`);
  }
  const positioned = explicitOrAnchoredCardPagePosition(
    store,
    pageId,
    operation,
    width,
    height,
    references,
  );
  const zoneBounds = pageBounds(store, zone);
  if (positioned) {
    return {
      x: positioned.x - zoneBounds.x,
      y: positioned.y - zoneBounds.y,
    };
  }

  const siblings = Object.values(store).filter(
    (record) => record?.typeName === "shape" && record.parentId === zone.id && record.type !== "arrow",
  );
  const availableWidth = Math.max(width, finiteNumber(zone.props?.w, DEFAULT_ZONE_WIDTH) - DEFAULT_ZONE_PADDING * 2);
  const columns = Math.max(
    1,
    Math.floor((availableWidth + DEFAULT_ZONE_CARD_GAP) / (width + DEFAULT_ZONE_CARD_GAP)),
  );
  const slot = siblings.length;
  return {
    x: DEFAULT_ZONE_PADDING + (slot % columns) * (width + DEFAULT_ZONE_CARD_GAP),
    y: DEFAULT_ZONE_PADDING + Math.floor(slot / columns) * (height + DEFAULT_ZONE_CARD_GAP),
  };
}

function cardPosition(store, pageId, operation, width, height, createdCount, references, parentZone) {
  if (parentZone) {
    return zoneCardPosition(store, parentZone, operation, width, height, references, pageId);
  }

  const positioned = explicitOrAnchoredCardPagePosition(
    store,
    pageId,
    operation,
    width,
    height,
    references,
  );
  if (positioned) return positioned;

  const shapes = pageShapes(store, pageId).filter((shape) => shape.type !== "arrow");
  const rightEdge = shapes.reduce((max, shape) => {
    const bounds = pageBounds(store, shape);
    return Math.max(max, bounds.x + bounds.w);
  }, 0);
  return {
    x: rightEdge + DEFAULT_GAP + (createdCount % 2) * (width + DEFAULT_GAP),
    y: Math.floor(createdCount / 2) * (height + DEFAULT_GAP),
  };
}

function createCardRecord(store, pageId, operation, createdCount, references, semanticDiagram = null) {
  const role = safeRole(operation.role);
  const title = boundedString(operation.title, 300, role);
  const body = boundedString(operation.body, 12_000);
  if (!title && !body) throw new Error("create_card requires a title or body.");
  const dimensions = estimateThinkingCardSize({ title, body, w: operation.w, h: operation.h });
  const width = dimensions.w;
  const height = dimensions.h;
  const parentZone = operation.parentZoneId
    ? resolveZoneReference(store, references, operation.parentZoneId, "create_card.parentZoneId", pageId)
    : null;
  const parentId = parentZone?.id ?? pageId;
  const position = cardPosition(
    store,
    pageId,
    operation,
    width,
    height,
    createdCount,
    references,
    parentZone,
  );
  const id = uniqueId(store, SHAPE_PREFIX, operation.key || title || role);
  const timestamp = new Date().toISOString();
  const source = normalizeSourceMetadata(operation.source);
  const requestedBridge = normalizeBridgeMetadata(operation.bridge);
  const parentBridge = normalizeBridgeMetadata(parentZone?.meta?.cowartProductBridge);
  const productParent = parentZone && (
    parentZone.meta?.cowartThinkingZonePurpose === "product" || parentZone.meta?.cowartProductZone === true
  );
  const bridge = productParent
    ? {
        ...(requestedBridge ?? {}),
        zoneId: requestedBridge?.zoneId || parentBridge?.zoneId || parentZone.meta.cowartProductZoneKey,
      }
    : requestedBridge;
  const semantic = normalizeSemanticObject(operation.semantic, semanticDiagram, operation.key);
  const semanticColor = semantic?.state === "warning"
    ? "orange"
    : semantic?.state === "blocked"
      ? "red"
      : null;

  return {
    id,
    typeName: "shape",
    type: "geo",
    x: position.x,
    y: position.y,
    rotation: 0,
    index: nextIndex(store, parentId),
    parentId,
    isLocked: false,
    opacity: 1,
    props: {
      geo: COWART_CARD_GEO,
      dash: semanticDiagram ? "solid" : "draw",
      url: boundedString(operation.url, 2_000),
      w: width,
      h: height,
      growY: 0,
      scale: 1,
      labelColor: "black",
      color: semanticColor ?? diagramColor(operation.color),
      fill: "none",
      size: "s",
      font: "draw",
      align: body ? "start" : "middle",
      verticalAlign: body ? "start" : "middle",
      richText: toRichText(formatCardText(title, body)),
    },
    meta: {
      cowartThinkingCard: true,
      cowartThinkingGenerated: operation.generated !== false,
      cowartThinkingMaterial: role === "material",
      cowartThinkingRole: role,
      cowartThinkingKey: boundedString(operation.key, 80),
      cowartThinkingTitle: title,
      cowartThinkingBody: body,
      cowartThinkingSource: source,
      cowartThinkingSourceRefs: boundedStringList(operation.sourceRefs, 50, 500),
      cowartProductBridge: bridge,
      cowartSemanticDiagram: semanticDiagram,
      cowartSemanticObject: semantic,
      cowartThinkingParentZoneKey: parentZone ? managedZoneKey(parentZone) : null,
      cowartProductParentZoneKey: parentZone
        ? boundedString(parentZone.meta?.cowartProductZoneKey, 80)
        : null,
      cowartThinkingCreatedAt: timestamp,
      cowartThinkingUpdatedAt: timestamp,
    },
  };
}

function zonePosition(store, pageId, operation) {
  const existingBounds = unionBounds(
    pageShapes(store, pageId)
      .filter((shape) => shape.type !== "arrow")
      .map((shape) => pageBounds(store, shape)),
  );
  return {
    x: finiteNumber(operation.x, existingBounds ? existingBounds.x + existingBounds.w + DEFAULT_GAP * 2 : 0),
    y: finiteNumber(operation.y, existingBounds?.y ?? 0),
  };
}

function normalizeZoneBridge(value, key) {
  return {
    ...(normalizeBridgeMetadata(value) ?? {}),
    zoneId: boundedString(value?.zoneId, 160) || key,
  };
}

function semanticZoneDisplayName(title, semanticDiagram) {
  const teachingClaim = boundedString(semanticDiagram?.teachingClaim, 500);
  if (!teachingClaim) return title;
  const suffix = `｜核心判断：${teachingClaim}`;
  return boundedString(title.endsWith(suffix) ? title : `${title}${suffix}`, 800);
}

function isManagedZone(shape) {
  return shape?.typeName === "shape" && shape.type === "frame" && (
    shape.meta?.cowartThinkingZone === true || shape.meta?.cowartProductZone === true
  );
}

function managedZoneKey(shape) {
  return boundedString(shape?.meta?.cowartThinkingZoneKey ?? shape?.meta?.cowartProductZoneKey, 80);
}

function productScopedShape(store, value) {
  const direct = typeof value === "string" ? store[value] : value;
  let shape = direct ?? Object.values(store).find(
    (record) => isManagedZone(record) && managedZoneKey(record) === value,
  );
  const visited = new Set();
  while (shape?.typeName === "shape" && !visited.has(shape.id)) {
    visited.add(shape.id);
    if (
      shape.meta?.cowartProductZone === true ||
      shape.meta?.cowartThinkingZonePurpose === "product" ||
      shape.meta?.cowartProductBridge
    ) {
      return shape;
    }
    shape = typeof shape.parentId === "string" ? store[shape.parentId] : null;
  }
  return null;
}

function semanticScopedShape(store, value) {
  const direct = typeof value === "string" ? store[value] : value;
  let shape = direct ?? Object.values(store).find(
    (record) => isManagedZone(record) && managedZoneKey(record) === value,
  );
  const visited = new Set();
  while (shape?.typeName === "shape" && !visited.has(shape.id)) {
    visited.add(shape.id);
    if (
      shape.meta?.cowartSemanticZone === true ||
      shape.meta?.cowartThinkingZonePurpose === "semantic" ||
      shape.meta?.cowartSemanticDiagram
    ) {
      return shape;
    }
    shape = typeof shape.parentId === "string" ? store[shape.parentId] : null;
  }
  return null;
}

function createZoneRecord(store, pageId, operation, semanticDiagram = null) {
  const key = boundedString(operation.key, 80);
  if (!key) throw new Error("create_zone requires a stable key.");
  const duplicate = Object.values(store).find(
    (record) => isManagedZone(record) && managedZoneKey(record) === key,
  );
  if (duplicate) throw new Error(`Canvas zone key already exists: ${key}. Use update_zone instead.`);

  const title = boundedString(operation.title, 300, key);
  const body = boundedString(operation.body, 12_000);
  const width = Math.max(240, Math.min(8_192, finiteNumber(operation.w, DEFAULT_ZONE_WIDTH)));
  const height = Math.max(160, Math.min(8_192, finiteNumber(operation.h, DEFAULT_ZONE_HEIGHT)));
  const position = zonePosition(store, pageId, operation);
  const purpose = operation.purpose ?? (semanticDiagram ? "semantic" : operation.bridge ? "product" : "thinking");
  const semantic = normalizeSemanticObject(operation.semantic, semanticDiagram, operation.key);
  const preferredId = `${SHAPE_PREFIX}cowart-zone-${safeIdPart(key, "zone")}`;
  const id = store[preferredId] ? uniqueId(store, SHAPE_PREFIX, `cowart-zone-${key}`) : preferredId;
  const timestamp = new Date().toISOString();

  return {
    id,
    typeName: "shape",
    type: "frame",
    x: position.x,
    y: position.y,
    rotation: 0,
    index: previousIndex(store, pageId),
    parentId: pageId,
    isLocked: false,
    opacity: 1,
    props: {
      w: width,
      h: height,
      name: semanticZoneDisplayName(title, semanticDiagram),
      color: zoneColor(operation.color),
    },
    meta: {
      cowartThinkingGenerated: true,
      cowartThinkingZone: true,
      cowartThinkingZoneKey: key,
      cowartThinkingZonePurpose: purpose,
      cowartProductZone: purpose === "product",
      cowartProductZoneKey: purpose === "product" ? key : null,
      cowartSemanticZone: purpose === "semantic",
      cowartThinkingTitle: title,
      cowartThinkingBody: body,
      cowartThinkingSourceRefs: boundedStringList(operation.sourceRefs, 50, 500),
      cowartProductBridge: purpose === "product" ? normalizeZoneBridge(operation.bridge, key) : null,
      cowartSemanticDiagram: semanticDiagram,
      cowartSemanticObject: semantic,
      cowartThinkingCreatedAt: timestamp,
      cowartThinkingUpdatedAt: timestamp,
    },
  };
}

function resolveShapeReference(store, references, value, label) {
  const id = references.get(value) ?? value;
  const shape = typeof id === "string" ? store[id] : null;
  if (!shape || shape.typeName !== "shape") throw new Error(`${label} does not reference a canvas shape: ${value}`);
  return shape;
}

function resolveZoneReference(store, references, value, label, expectedPageId = null) {
  const referencedId = references.get(value) ?? value;
  const direct = typeof referencedId === "string" ? store[referencedId] : null;
  const shape = direct ?? Object.values(store).find(
    (record) => isManagedZone(record) && managedZoneKey(record) === value,
  );
  if (!isManagedZone(shape)) {
    throw new Error(`${label} does not reference a managed canvas zone: ${value}`);
  }
  const zonePageId = pageIdForShape(store, shape);
  if (expectedPageId && zonePageId !== expectedPageId) {
    throw new Error(`${label} references canvas zone ${shape.id} on ${zonePageId}, not batch page ${expectedPageId}.`);
  }
  return shape;
}

function assertManagedOrExplicitEdit(shape, allowUserAuthoredEdits, operationType) {
  const managed = shape.meta?.cowartThinkingCard === true || shape.meta?.cowartThinkingGenerated === true;
  if (!managed && !allowUserAuthoredEdits) {
    throw new Error(`Refusing to ${operationType} user-authored shape ${shape.id} without allowUserAuthoredEdits.`);
  }
}

function updateThinkingCard(store, operation, allowUserAuthoredEdits, semanticDiagram = null) {
  const shape = resolveShapeReference(store, new Map(), operation.id, "update_card.id");
  const isThinkingCard = shape.meta?.cowartThinkingCard === true;
  if (!isThinkingCard && !allowUserAuthoredEdits) {
    throw new Error(`Refusing to edit user-authored shape ${shape.id} without allowUserAuthoredEdits.`);
  }
  if (!shape.props?.richText) throw new Error(`Shape ${shape.id} does not contain editable rich text.`);

  const role = safeRole(operation.role, shape.meta?.cowartThinkingRole ?? "idea");
  const title = operation.title === undefined
    ? boundedString(shape.meta?.cowartThinkingTitle, 300)
    : boundedString(operation.title, 300);
  const body = operation.body === undefined
    ? boundedString(shape.meta?.cowartThinkingBody ?? textForShape(shape), 12_000)
    : boundedString(operation.body, 12_000);
  const sourceRefs = operation.sourceRefs === undefined
    ? boundedStringList(shape.meta?.cowartThinkingSourceRefs, 50, 500)
    : boundedStringList(operation.sourceRefs, 50, 500);
  const source = operation.source === undefined
    ? normalizeSourceMetadata(shape.meta?.cowartThinkingSource)
    : normalizeSourceMetadata(operation.source);
  const bridge = operation.bridge === undefined
    ? normalizeBridgeMetadata(shape.meta?.cowartProductBridge)
    : normalizeBridgeMetadata(operation.bridge);
  const semanticObject = patchSemanticObject(
    shape.meta?.cowartSemanticObject,
    operation.semantic,
    semanticDiagram,
    "update_card",
  );
  const updated = {
    ...shape,
    props: {
      ...shape.props,
      color: operation.color === undefined ? shape.props.color : safeColor(operation.color, role),
      url: operation.url === undefined ? shape.props.url : boundedString(operation.url, 2_000),
      richText: toRichText(formatCardText(title, body)),
    },
    meta: {
      ...shape.meta,
      cowartThinkingRole: role,
      cowartThinkingTitle: title,
      cowartThinkingBody: body,
      cowartThinkingSource: source,
      cowartThinkingSourceRefs: sourceRefs,
      cowartProductBridge: bridge,
      cowartSemanticObject: semanticObject,
      cowartThinkingUpdatedAt: new Date().toISOString(),
    },
  };
  store[shape.id] = updated;
  return updated;
}

function updateCanvasZone(store, operation, references, pageId, requestedSemanticDiagram = null) {
  const shape = resolveZoneReference(store, references, operation.id, "update_zone.id", pageId);
  if (shape.type !== "frame") throw new Error(`Canvas zone ${shape.id} is not a supported tldraw frame.`);
  const key = managedZoneKey(shape);
  const title = operation.title === undefined
    ? boundedString(shape.meta?.cowartThinkingTitle ?? shape.props?.name, 300, key)
    : boundedString(operation.title, 300, key);
  const body = operation.body === undefined
    ? boundedString(shape.meta?.cowartThinkingBody, 12_000)
    : boundedString(operation.body, 12_000);
  const sourceRefs = operation.sourceRefs === undefined
    ? boundedStringList(shape.meta?.cowartThinkingSourceRefs, 50, 500)
    : boundedStringList(operation.sourceRefs, 50, 500);
  const isProductZone = shape.meta?.cowartThinkingZonePurpose === "product" || shape.meta?.cowartProductZone === true;
  const storedSemanticDiagram = shape.meta?.cowartSemanticDiagram;
  const semanticObject = patchSemanticObject(
    shape.meta?.cowartSemanticObject,
    operation.semantic,
    requestedSemanticDiagram,
    "update_zone",
  );
  const bridge = isProductZone
    ? operation.bridge === undefined
      ? normalizeZoneBridge(shape.meta?.cowartProductBridge, key)
      : normalizeZoneBridge(operation.bridge, key)
    : null;
  const updated = {
    ...shape,
    x: operation.x === undefined ? shape.x : finiteNumber(operation.x, shape.x),
    y: operation.y === undefined ? shape.y : finiteNumber(operation.y, shape.y),
    props: {
      ...shape.props,
      w: operation.w === undefined
        ? shape.props.w
        : Math.max(240, Math.min(8_192, finiteNumber(operation.w, shape.props.w))),
      h: operation.h === undefined
        ? shape.props.h
        : Math.max(160, Math.min(8_192, finiteNumber(operation.h, shape.props.h))),
      name: semanticZoneDisplayName(title, storedSemanticDiagram),
      color: operation.color === undefined ? shape.props.color : zoneColor(operation.color),
    },
    meta: {
      ...shape.meta,
      cowartThinkingTitle: title,
      cowartThinkingBody: body,
      cowartThinkingSourceRefs: sourceRefs,
      cowartProductBridge: bridge,
      cowartSemanticObject: semanticObject,
      cowartThinkingUpdatedAt: new Date().toISOString(),
    },
  };
  store[shape.id] = updated;
  return updated;
}

function semanticRelationStyle(operation, semanticDiagram) {
  const relationType = boundedString(operation.kind, 80, semanticDiagram ? "flow" : "relates-to");
  const direction = ["forward", "bidirectional", "none"].includes(operation.direction)
    ? operation.direction
    : relationType === "sync"
      ? "bidirectional"
      : ["association", "compare"].includes(relationType)
        ? "none"
        : "forward";
  const path = operation.path === "alternative" ? "alternative" : "primary";
  if (!semanticDiagram) {
    return {
      relationType,
      direction,
      path,
      color: diagramColor(operation.color),
      dash: path === "alternative" || operation.dash === "dashed" ? "dashed" : "draw",
      arrowheadStart: direction === "bidirectional" ? "arrow" : "none",
      arrowheadEnd: direction === "none" ? "none" : "arrow",
    };
  }
  return {
    relationType,
    direction,
    path,
    color: direction === "none" ? "black" : "blue",
    dash: path === "alternative" ? "dashed" : "solid",
    arrowheadStart: direction === "bidirectional" ? "arrow" : "none",
    arrowheadEnd: direction === "none" ? "none" : "arrow",
  };
}

function storedRelationLane(record) {
  const semanticLane = record?.meta?.cowartSemanticRelation?.lane;
  if (Number.isFinite(semanticLane)) return Math.max(-8, Math.min(8, Math.trunc(semanticLane)));
  const thinkingLane = record?.meta?.cowartThinkingRelationLane;
  if (Number.isFinite(thinkingLane)) return Math.max(-8, Math.min(8, Math.trunc(thinkingLane)));
  return Math.max(-8, Math.min(8, Math.trunc(finiteNumber(record?.props?.bend, 0) / 36)));
}

function parallelRelationLanes(store, fromId, toId, excludeRelationId = null, { useBase = false } = {}) {
  const lanes = new Set();
  for (const record of Object.values(store)) {
    if (
      record?.typeName !== "shape" ||
      record.type !== "arrow" ||
      record.id === excludeRelationId ||
      record.meta?.cowartThinkingRelation !== true
    ) {
      continue;
    }
    const endpoints = boundThinkingRelationEndpoints(store, record);
    const samePair = (
      (endpoints.fromId === fromId && endpoints.toId === toId) ||
      (endpoints.fromId === toId && endpoints.toId === fromId)
    );
    if (samePair) {
      const baseLane = record.meta?.cowartThinkingRelationBaseLane;
      lanes.add(useBase && Number.isFinite(baseLane) ? Math.trunc(baseLane) : storedRelationLane(record));
    }
  }
  return lanes;
}

function parallelRelationLane(store, fromId, toId, requestedLane, excludeRelationId = null) {
  const used = parallelRelationLanes(store, fromId, toId, excludeRelationId, { useBase: true });
  const requested = Number.isFinite(requestedLane)
    ? Math.max(-8, Math.min(8, Math.trunc(requestedLane)))
    : null;
  const candidates = requested === null
    ? [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8]
    : Array.from({ length: 17 }, (_, index) => index - 8)
      .sort((first, second) =>
        Math.abs(first - requested) - Math.abs(second - requested) ||
        Math.abs(first) - Math.abs(second) ||
        first - second,
      );
  return candidates.find((lane) => !used.has(lane)) ?? requested ?? 0;
}

function relationBindingAnchors(fromBounds, toBounds, lane, selfLoop) {
  if (selfLoop) {
    return {
      start: { x: 1, y: Math.max(0.2, Math.min(0.8, 0.36 + lane * 0.08)) },
      end: { x: 1, y: Math.max(0.2, Math.min(0.8, 0.64 + lane * 0.08)) },
    };
  }
  const fromCenter = { x: fromBounds.x + fromBounds.w / 2, y: fromBounds.y + fromBounds.h / 2 };
  const toCenter = { x: toBounds.x + toBounds.w / 2, y: toBounds.y + toBounds.h / 2 };
  const laneOffset = Math.max(-0.3, Math.min(0.3, lane * 0.12));
  if (Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y)) {
    const forward = toCenter.x >= fromCenter.x;
    return {
      start: { x: forward ? 1 : 0, y: 0.5 + laneOffset },
      end: { x: forward ? 0 : 1, y: 0.5 + laneOffset },
    };
  }
  const forward = toCenter.y >= fromCenter.y;
  return {
    start: { x: 0.5 + laneOffset, y: forward ? 1 : 0 },
    end: { x: 0.5 + laneOffset, y: forward ? 0 : 1 },
  };
}

function normalizedAnchorPoint(bounds, anchor) {
  return {
    x: bounds.x + bounds.w * anchor.x,
    y: bounds.y + bounds.h * anchor.y,
  };
}

function expandedRouteBounds(bounds, padding = 18) {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    w: bounds.w + padding * 2,
    h: bounds.h + padding * 2,
  };
}

function pointInBounds(point, bounds) {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.w &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.h
  );
}

function segmentIntersectsBounds(start, end, bounds) {
  if (pointInBounds(start, bounds) || pointInBounds(end, bounds)) return true;
  const delta = { x: end.x - start.x, y: end.y - start.y };
  let minimum = 0;
  let maximum = 1;
  for (const [origin, distance, low, high] of [
    [start.x, delta.x, bounds.x, bounds.x + bounds.w],
    [start.y, delta.y, bounds.y, bounds.y + bounds.h],
  ]) {
    if (Math.abs(distance) < 1e-9) {
      if (origin < low || origin > high) return false;
      continue;
    }
    const first = (low - origin) / distance;
    const second = (high - origin) / distance;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return false;
  }
  return maximum >= 0 && minimum <= 1;
}

function sampledArcPoints(start, end, bend, sampleCount = 48) {
  if (Math.abs(bend) < 1e-6) return [start, end];
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length < 1e-6) return [start, end];
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const middle = {
    x: midpoint.x + (delta.y / length) * bend,
    y: midpoint.y - (delta.x / length) * bend,
  };
  const determinant = 2 * (
    start.x * (end.y - middle.y) +
    end.x * (middle.y - start.y) +
    middle.x * (start.y - end.y)
  );
  if (Math.abs(determinant) < 1e-6) return [start, end];
  const startSquared = start.x ** 2 + start.y ** 2;
  const endSquared = end.x ** 2 + end.y ** 2;
  const middleSquared = middle.x ** 2 + middle.y ** 2;
  const center = {
    x: (
      startSquared * (end.y - middle.y) +
      endSquared * (middle.y - start.y) +
      middleSquared * (start.y - end.y)
    ) / determinant,
    y: (
      startSquared * (middle.x - end.x) +
      endSquared * (start.x - middle.x) +
      middleSquared * (end.x - start.x)
    ) / determinant,
  };
  const tau = Math.PI * 2;
  const normalizeAngle = (value) => ((value % tau) + tau) % tau;
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const middleAngle = Math.atan2(middle.y - center.y, middle.x - center.x);
  const ccwSweep = normalizeAngle(endAngle - startAngle);
  const ccwMiddle = normalizeAngle(middleAngle - startAngle);
  const sweep = ccwMiddle <= ccwSweep + 1e-6 ? ccwSweep : ccwSweep - tau;
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    const angle = startAngle + sweep * (index / sampleCount);
    return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
  });
}

function pathIntersectsBounds(points, bounds) {
  for (let index = 1; index < points.length; index += 1) {
    if (segmentIntersectsBounds(points[index - 1], points[index], bounds)) return true;
  }
  return false;
}

function semanticRelationCardObstacles(store, arrow, from, to) {
  const diagramId = arrow.meta?.cowartSemanticDiagram?.diagramId;
  const pageId = pageIdForShape(store, arrow);
  if (!diagramId || !pageId) return [];
  return Object.values(store).filter((record) =>
    record?.typeName === "shape" &&
    record.meta?.cowartThinkingCard === true &&
    record.id !== from.id &&
    record.id !== to.id &&
    record.meta?.cowartSemanticObject &&
    record.meta?.cowartSemanticDiagram?.diagramId === diagramId &&
    pageIdForShape(store, record) === pageId,
  );
}

function requiredOutsideBend(start, end, blockers, sign) {
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const length = Math.max(1, Math.hypot(delta.x, delta.y));
  const normal = { x: delta.y / length, y: -delta.x / length };
  let required = 48;
  for (const blocker of blockers) {
    const bounds = pageBounds(blocker.store, blocker.shape);
    const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    const offset = (center.x - start.x) * normal.x + (center.y - start.y) * normal.y;
    const extent = Math.abs(normal.x) * bounds.w / 2 + Math.abs(normal.y) * bounds.h / 2;
    const along = Math.max(0.08, Math.min(0.92, (
      (center.x - start.x) * delta.x + (center.y - start.y) * delta.y
    ) / (length * length)));
    const midpointFactor = Math.max(0.24, 4 * along * (1 - along));
    required = Math.max(required, (sign * offset + extent + 32) / midpointFactor);
  }
  return required;
}

function semanticRelationRoute(store, arrow, from, to, baseLane) {
  const selfLoop = from.id === to.id;
  const baseBend = selfLoop ? 96 + Math.abs(baseLane) * 24 : baseLane * 36;
  if (selfLoop || !arrow.meta?.cowartSemanticRelation) {
    return { lane: baseLane, bend: baseBend, obstacleIds: [] };
  }
  const fromBounds = pageBounds(store, from);
  const toBounds = pageBounds(store, to);
  const baseAnchors = relationBindingAnchors(fromBounds, toBounds, baseLane, false);
  const baseStart = normalizedAnchorPoint(fromBounds, baseAnchors.start);
  const baseEnd = normalizedAnchorPoint(toBounds, baseAnchors.end);
  const obstacles = semanticRelationCardObstacles(store, arrow, from, to);
  const blockers = obstacles.filter((shape) =>
    segmentIntersectsBounds(baseStart, baseEnd, expandedRouteBounds(pageBounds(store, shape))),
  );
  if (blockers.length === 0) return { lane: baseLane, bend: baseBend, obstacleIds: [] };

  const usedLanes = parallelRelationLanes(store, from.id, to.id, arrow.id);
  const candidates = [];
  for (const sign of [1, -1]) {
    const required = requiredOutsideBend(
      baseStart,
      baseEnd,
      blockers.map((shape) => ({ store, shape })),
      sign,
    );
    const minimumLane = Math.max(1, Math.min(8, Math.ceil(required / 36)));
    const laneMagnitude = [
      ...Array.from({ length: 9 - minimumLane }, (_, index) => minimumLane + index),
      ...Array.from({ length: minimumLane - 1 }, (_, index) => minimumLane - 1 - index),
    ].find((magnitude) => !usedLanes.has(sign * magnitude));
    if (!laneMagnitude) continue;
    const lane = sign * laneMagnitude;
    const anchors = relationBindingAnchors(fromBounds, toBounds, lane, false);
    const start = normalizedAnchorPoint(fromBounds, anchors.start);
    const end = normalizedAnchorPoint(toBounds, anchors.end);
    let bendMagnitude = Math.max(required, laneMagnitude * 36);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const bend = sign * bendMagnitude;
      const points = sampledArcPoints(start, end, bend);
      const collides = obstacles.some((shape) =>
        pathIntersectsBounds(points, expandedRouteBounds(pageBounds(store, shape))),
      );
      if (!collides) {
        candidates.push({ lane, bend, obstacleIds: blockers.map((shape) => shape.id) });
        break;
      }
      bendMagnitude += Math.max(24, bendMagnitude * 0.18);
    }
  }
  return candidates.sort((first, second) => Math.abs(first.bend) - Math.abs(second.bend))[0] ?? {
    lane: baseLane,
    bend: baseBend,
    obstacleIds: blockers.map((shape) => shape.id),
  };
}

function assertSemanticRelationEndpoint(shape, semanticDiagram, label) {
  const objectDiagramId = shape.meta?.cowartSemanticObject?.diagramId;
  const shapeDiagramId = shape.meta?.cowartSemanticDiagram?.diagramId;
  if (!objectDiagramId || !shapeDiagramId) {
    throw new Error(`${label} must reference a native semantic object.`);
  }
  if (objectDiagramId !== semanticDiagram.diagramId || shapeDiagramId !== semanticDiagram.diagramId) {
    throw new Error(`${label} must reference a semantic object in diagram ${semanticDiagram.diagramId}.`);
  }
}

function createRelationRecords(store, operation, references, semanticDiagram = null) {
  const from = resolveShapeReference(store, references, operation.from, "create_relation.from");
  const to = resolveShapeReference(store, references, operation.to, "create_relation.to");
  if (semanticDiagram) {
    assertSemanticRelationEndpoint(from, semanticDiagram, "create_relation.from");
    assertSemanticRelationEndpoint(to, semanticDiagram, "create_relation.to");
  }
  const selfLoop = from.id === to.id;
  const fromBounds = pageBounds(store, from);
  const toBounds = pageBounds(store, to);
  const fromCenter = { x: fromBounds.x + fromBounds.w / 2, y: fromBounds.y + fromBounds.h / 2 };
  const toCenter = { x: toBounds.x + toBounds.w / 2, y: toBounds.y + toBounds.h / 2 };
  const arrowId = uniqueId(store, SHAPE_PREFIX, operation.key || "relation");
  const style = semanticRelationStyle(operation, semanticDiagram);
  const relationKind = style.relationType;
  const labelParts = [boundedString(operation.label, 300), boundedString(operation.payload, 300)].filter(Boolean);
  const label = Array.from(new Set(labelParts)).join(" · ");
  const pageId = pageIdForShape(store, from);
  if (!pageId || pageId !== pageIdForShape(store, to)) {
    throw new Error("create_relation shapes must be on the same page.");
  }

  const lane = parallelRelationLane(store, from.id, to.id, operation.lane);
  const bindingAnchors = relationBindingAnchors(fromBounds, toBounds, lane, selfLoop);
  const semanticRelation = semanticDiagram
    ? {
        version: "1",
        diagramId: semanticDiagram.diagramId,
        semanticId: boundedString(operation.semanticId, 160) || boundedString(operation.key, 80) || arrowId,
        type: relationKind,
        direction: style.direction,
        path: style.path,
        payload: boundedString(operation.payload, 300) || null,
        lane,
        origin: SEMANTIC_ORIGINS.has(operation.origin) ? operation.origin : "synthesis",
        sourceShapeIds: boundedStringList(operation.sourceShapeIds, 100),
        sourceIds: boundedStringList(operation.sourceIds, 100),
      }
    : null;
  const arrow = {
    id: arrowId,
    typeName: "shape",
    type: "arrow",
    x: fromCenter.x,
    y: fromCenter.y,
    rotation: 0,
    index: nextIndex(store, pageId),
    parentId: pageId,
    isLocked: false,
    opacity: 1,
    props: {
      kind: "arc",
      elbowMidPoint: 0.5,
      dash: style.dash,
      size: "s",
      fill: "none",
      color: style.color,
      labelColor: "black",
      bend: selfLoop ? 96 + Math.abs(lane) * 24 : lane * 36,
      start: { x: 0, y: 0 },
      end: selfLoop
        ? { x: Math.max(96, fromBounds.w * 0.42), y: Math.max(72, fromBounds.h * 0.42) }
        : { x: toCenter.x - fromCenter.x, y: toCenter.y - fromCenter.y },
      arrowheadStart: style.arrowheadStart,
      arrowheadEnd: style.arrowheadEnd,
      richText: toRichText(label),
      labelPosition: 0.5,
      font: "draw",
      scale: 1,
    },
    meta: {
      cowartThinkingGenerated: true,
      cowartThinkingRelation: true,
      cowartThinkingRelationKind: relationKind,
      cowartThinkingRelationDirection: style.direction,
      cowartThinkingRelationPath: style.path,
      cowartThinkingRelationPayload: boundedString(operation.payload, 300) || null,
      cowartThinkingFromShapeId: from.id,
      cowartThinkingToShapeId: to.id,
      cowartThinkingRelationLane: lane,
      cowartThinkingRelationBaseLane: lane,
      cowartSemanticDiagram: semanticDiagram,
      cowartSemanticRelation: semanticRelation,
      cowartThinkingCreatedAt: new Date().toISOString(),
    },
  };
  store[arrowId] = arrow;

  for (const [terminal, target] of [["start", from], ["end", to]]) {
    const bindingId = uniqueId(store, BINDING_PREFIX, `${arrowId}-${terminal}`);
    store[bindingId] = {
      id: bindingId,
      typeName: "binding",
      type: "arrow",
      fromId: arrowId,
      toId: target.id,
      props: {
        terminal,
        normalizedAnchor: bindingAnchors[terminal],
        isExact: false,
        isPrecise: Boolean(semanticDiagram),
        snap: "none",
      },
      meta: { cowartThinkingGenerated: true },
    };
  }
  return arrow;
}

function refreshRelationGeometryAndBindings(store, relationId) {
  const arrow = store[relationId];
  const { from, to } = boundThinkingRelationEndpoints(store, arrow, { syncMeta: true });
  if (!arrow || arrow.typeName !== "shape" || arrow.type !== "arrow" || !from || !to) return false;
  const fromBounds = pageBounds(store, from);
  const toBounds = pageBounds(store, to);
  const fromCenter = { x: fromBounds.x + fromBounds.w / 2, y: fromBounds.y + fromBounds.h / 2 };
  const toCenter = { x: toBounds.x + toBounds.w / 2, y: toBounds.y + toBounds.h / 2 };
  const selfLoop = from.id === to.id;
  const baseLane = Math.max(-8, Math.min(8, Math.trunc(finiteNumber(
    arrow.meta?.cowartThinkingRelationBaseLane,
    storedRelationLane(arrow),
  ))));
  const route = semanticRelationRoute(store, arrow, from, to, baseLane);
  const lane = route.lane;
  const bindingAnchors = relationBindingAnchors(fromBounds, toBounds, lane, selfLoop);
  arrow.x = fromCenter.x;
  arrow.y = fromCenter.y;
  arrow.props.start = { x: 0, y: 0 };
  arrow.props.bend = route.bend;
  arrow.props.end = selfLoop
    ? { x: Math.max(96, fromBounds.w * 0.42), y: Math.max(72, fromBounds.h * 0.42) }
    : { x: toCenter.x - fromCenter.x, y: toCenter.y - fromCenter.y };
  arrow.meta.cowartThinkingRelationLane = lane;
  arrow.meta.cowartThinkingObstacleRoute = route.obstacleIds.length > 0
    ? { strategy: "outside-arc", obstacleShapeIds: route.obstacleIds, bend: route.bend }
    : null;
  if (arrow.meta?.cowartSemanticRelation) arrow.meta.cowartSemanticRelation.lane = lane;
  for (const binding of Object.values(store)) {
    if (binding?.typeName !== "binding" || binding.type !== "arrow" || binding.fromId !== relationId) continue;
    const terminal = binding.props?.terminal;
    if (terminal !== "start" && terminal !== "end") continue;
    binding.props.normalizedAnchor = bindingAnchors[terminal];
  }
  return true;
}

function layoutCreatedThinkingGraph(store, pageId, createdCards, createdRelations, semanticDiagram = null) {
  if (createdCards.length === 0) {
    for (const relationId of createdRelations) refreshRelationGeometryAndBindings(store, relationId);
    return;
  }
  const candidates = createdCards.filter(({ operation }) =>
    !operation.anchorId && !Number.isFinite(operation.x) && !Number.isFinite(operation.y),
  );
  if (candidates.length === 0) {
    for (const relationId of createdRelations) refreshRelationGeometryAndBindings(store, relationId);
    return;
  }
  const groups = new Map();
  for (const card of candidates) {
    const parentId = store[card.id]?.parentId ?? pageId;
    const group = groups.get(parentId) ?? [];
    group.push(card);
    groups.set(parentId, group);
  }

  for (const [parentId, cards] of groups) {
    if (cards.length === 0) continue;
    const createdIds = new Set(cards.map(({ id }) => id));
    const allCreatedIds = new Set(createdCards.map(({ id }) => id));
    const nodes = cards.map(({ id, operation }) => {
      const shape = store[id];
      return { id, w: shape.props.w, h: shape.props.h, order: operation.semantic?.order ?? 0 };
    }).sort((first, second) => first.order - second.order);
    const edges = createdRelations
      .map((id) => store[id])
      .filter(Boolean)
      .flatMap((arrow) => {
        const { fromId: from, toId: to } = boundThinkingRelationEndpoints(store, arrow);
        const direction = arrow.meta?.cowartSemanticRelation?.direction ?? arrow.meta?.cowartThinkingRelationDirection ?? "forward";
        if (direction === "none") return [];
        if (direction === "bidirectional") return [{ from, to }, { from: to, to: from }];
        return [{ from, to }];
      })
      .filter((edge) => createdIds.has(edge.from) && createdIds.has(edge.to));
    if (edges.length === 0 && !semanticDiagram) continue;

    const parentZone = parentId === pageId ? null : store[parentId];
    const existingShapes = (parentZone ? Object.values(store) : pageShapes(store, pageId))
      .filter((shape) =>
        shape?.typeName === "shape" &&
        (parentZone ? shape.parentId === parentId : pageIdForShape(store, shape) === pageId) &&
        shape.type !== "arrow" &&
        !createdIds.has(shape.id),
      );
    const existingBounds = unionBounds(
      existingShapes.map((shape) => parentZone ? localBounds(shape) : pageBounds(store, shape)),
    );
    const readingOrder = semanticDiagram?.readingOrder ?? "top-to-bottom";
    const horizontal = ["left-to-right", "right-to-left", "board-to-peers"].includes(readingOrder);
    const baseOrigin = {
      x: parentZone ? DEFAULT_ZONE_PADDING : 0,
      y: parentZone ? DEFAULT_ZONE_PADDING + 32 : 0,
    };
    const relationGap = semanticDiagram
      ? Math.max(
          128,
          ...createdRelations
            .map((id) => store[id])
            .filter((arrow) =>
              arrow &&
              (
                createdIds.has(boundThinkingRelationEndpoints(store, arrow).fromId) ||
                createdIds.has(boundThinkingRelationEndpoints(store, arrow).toId)
              ),
            )
            .map((arrow) => estimateThinkingRelationGap(textForShape(arrow))),
        )
      : undefined;
    const crossPlacements = new Set();
    const externalEndpointIds = new Set();
    if (semanticDiagram) {
      for (const relationId of createdRelations) {
        const arrow = store[relationId];
        if (!arrow || arrow.meta?.cowartSemanticRelation?.direction !== "forward") continue;
        const endpoints = boundThinkingRelationEndpoints(store, arrow);
        const fromIsNew = createdIds.has(endpoints.fromId);
        const toIsNew = createdIds.has(endpoints.toId);
        if (fromIsNew === toIsNew) continue;
        const externalId = fromIsNew ? endpoints.toId : endpoints.fromId;
        const external = store[externalId];
        if (
          external?.parentId !== parentId ||
          external.meta?.cowartSemanticDiagram?.diagramId !== semanticDiagram.diagramId
        ) {
          continue;
        }
        crossPlacements.add(fromIsNew ? "upstream" : "downstream");
        externalEndpointIds.add(externalId);
      }
    }
    if (crossPlacements.size > 1) {
      throw new Error("Incremental semantic layout has conflicting upstream and downstream constraints; provide explicit coordinates.");
    }
    const crossPlacement = crossPlacements.values().next().value ?? null;
    const positiveReadingDirection = ["left-to-right", "top-to-bottom", "board-to-peers", "center-out"].includes(readingOrder);
    const placeBeforeCoordinate = crossPlacement && (
      (crossPlacement === "upstream" && positiveReadingDirection) ||
      (crossPlacement === "downstream" && !positiveReadingDirection)
    );
    const spacing = Math.max(DEFAULT_GAP * 2, relationGap ?? 0);
    const origin = existingBounds && !placeBeforeCoordinate
      ? horizontal
        ? {
            x: existingBounds.x + existingBounds.w + spacing,
            y: Math.max(baseOrigin.y, existingBounds.y),
          }
        : {
            x: Math.max(baseOrigin.x, existingBounds.x),
            y: existingBounds.y + existingBounds.h + spacing,
          }
      : baseOrigin;
    let positions = layoutThinkingGraph({
      nodes,
      edges,
      originX: origin.x,
      originY: origin.y,
      readingOrder,
      ...(relationGap ? { horizontalGap: relationGap, verticalGap: relationGap } : {}),
    });

    if (existingBounds && placeBeforeCoordinate) {
      const newBounds = unionBounds(nodes.map((node) => ({
        x: positions.get(node.id).x,
        y: positions.get(node.id).y,
        w: node.w,
        h: node.h,
      })));
      const shift = horizontal
        ? newBounds.x + newBounds.w + spacing - existingBounds.x
        : newBounds.y + newBounds.h + spacing - existingBounds.y;
      if (shift > 0) {
        const shiftable = existingShapes.filter((shape) =>
          shape.meta?.cowartThinkingGenerated === true &&
          shape.meta?.cowartSemanticDiagram?.diagramId === semanticDiagram.diagramId &&
          !allCreatedIds.has(shape.id),
        );
        const shiftableIds = new Set(shiftable.map((shape) => shape.id));
        const fixedShapes = existingShapes.filter((shape) => !shiftableIds.has(shape.id));
        const fixedBounds = fixedShapes.map((shape) =>
          parentZone ? localBounds(shape) : pageBounds(store, shape),
        );
        const shiftWouldOverlapFixed = shiftable.some((shape) => {
          const bounds = parentZone ? localBounds(shape) : pageBounds(store, shape);
          const shifted = {
            ...bounds,
            x: bounds.x + (horizontal ? shift : 0),
            y: bounds.y + (horizontal ? 0 : shift),
          };
          return fixedBounds.some((fixed) =>
            boundsIntersect(shifted, expandedBounds(fixed, DEFAULT_GAP / 2)),
          );
        });
        const fixedExternalEndpoint = Array.from(externalEndpointIds)
          .some((id) => !shiftableIds.has(id));
        if (!shiftWouldOverlapFixed && !fixedExternalEndpoint) {
          for (const shape of shiftable) {
            if (horizontal) shape.x += shift;
            else shape.y += shift;
          }
        }
      }
    }

    if (semanticDiagram && existingShapes.length > 0) {
      const obstacleBounds = existingShapes.map((shape) =>
        parentZone ? localBounds(shape) : pageBounds(store, shape),
      );
      positions = safePerpendicularSemanticPlacement({
        positions,
        nodes,
        obstacles: obstacleBounds,
        horizontal,
        spacing,
        parentZone,
      });
    }

    for (const [id, position] of positions) {
      store[id].x = position.x;
      store[id].y = position.y;
    }
    if (parentZone) {
      const children = Object.values(store).filter((shape) =>
        shape?.typeName === "shape" && shape.parentId === parentId && shape.type !== "arrow",
      );
      const right = Math.max(...children.map((shape) => shape.x + localBounds(shape).w));
      const bottom = Math.max(...children.map((shape) => shape.y + localBounds(shape).h));
      parentZone.props.w = Math.max(parentZone.props.w, right + DEFAULT_ZONE_PADDING);
      parentZone.props.h = Math.max(parentZone.props.h, bottom + DEFAULT_ZONE_PADDING);
    }
  }

  for (const relation of pageShapes(store, pageId)) {
    if (
      relation.type === "arrow" &&
      relation.meta?.cowartThinkingGenerated === true &&
      relation.meta?.cowartThinkingRelation === true
    ) {
      refreshRelationGeometryAndBindings(store, relation.id);
    }
  }
}

function descendantShapeIds(store, rootId) {
  const result = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of Object.values(store)) {
      if (record?.typeName === "shape" && result.has(record.parentId) && !result.has(record.id)) {
        result.add(record.id);
        changed = true;
      }
    }
  }
  return result;
}

function generatedDeletionIds(store, shape) {
  const shapeIds = descendantShapeIds(store, shape.id);
  const relationIds = new Set(
    Object.values(store)
      .filter((record) => {
        if (
          record?.typeName !== "shape" ||
          record.type !== "arrow" ||
          record.meta?.cowartThinkingGenerated !== true
        ) {
          return false;
        }
        const endpoints = boundThinkingRelationEndpoints(store, record);
        return shapeIds.has(endpoints.fromId) || shapeIds.has(endpoints.toId);
      })
      .map((record) => record.id),
  );
  return new Set([...shapeIds, ...relationIds]);
}

function deleteGeneratedShape(store, operation, references) {
  const shape = resolveShapeReference(store, references, operation.id, "delete_shape.id");
  if (shape.meta?.cowartThinkingGenerated !== true) {
    throw new Error(`Refusing to delete non-agent shape ${shape.id}.`);
  }
  const shapeIds = descendantShapeIds(store, shape.id);
  const protectedDescendants = Array.from(shapeIds)
    .filter((id) => id !== shape.id)
    .map((id) => store[id])
    .filter((record) => record?.typeName === "shape" && record.meta?.cowartThinkingGenerated !== true);
  if (protectedDescendants.length > 0) {
    throw new Error(
      `Refusing to delete ${shape.id}; it contains ${protectedDescendants.length} user-authored shape(s).`,
    );
  }
  const deletedIds = generatedDeletionIds(store, shape);
  for (const record of Object.values(store)) {
    if (
      deletedIds.has(record.id) ||
      (record?.typeName === "binding" && (deletedIds.has(record.fromId) || deletedIds.has(record.toId)))
    ) {
      delete store[record.id];
    }
  }
  return Array.from(deletedIds);
}

function validateOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("At least one thinking operation is required.");
  }
  if (operations.length > 100) throw new Error("A thinking operation batch is limited to 100 operations.");
  const supported = new Set([
    "create_card",
    "update_card",
    "create_zone",
    "update_zone",
    "move_shape",
    "resize_shape",
    "create_relation",
    "delete_shape",
  ]);
  const keyedCreationTypes = new Set(["create_card", "create_zone", "create_relation"]);
  const creationKeys = new Map();
  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || !supported.has(operation.type)) {
      throw new Error(`Unsupported thinking operation: ${operation?.type ?? "missing type"}`);
    }
    const key = keyedCreationTypes.has(operation.type) ? boundedString(operation.key, 80) : "";
    if (!key) continue;
    const previousType = creationKeys.get(key);
    if (previousType) {
      throw new Error(
        `Duplicate creation key '${key}' in one batch (${previousType} and ${operation.type}).`,
      );
    }
    creationKeys.set(key, operation.type);
  }
}

function assertSemanticRelationsSafeForApply(store, operations) {
  const invalid = invalidSemanticRelations(store).filter(({ unsafe }) => unsafe);
  if (invalid.length === 0) return;

  // A delete-only repair is deliberately permitted. Every invalid relation must
  // be covered by one of those guarded deletions; all other mutations fail closed.
  const deletionCoverage = new Set();
  if (operations.every((operation) => operation.type === "delete_shape")) {
    for (const operation of operations) {
      const target = typeof operation.id === "string" ? store[operation.id] : null;
      if (target?.typeName === "shape" && target.meta?.cowartThinkingGenerated === true) {
        for (const id of generatedDeletionIds(store, target)) deletionCoverage.add(id);
      }
    }
  }
  if (invalid.every(({ record }) => deletionCoverage.has(record.id))) return;

  const details = invalid
    .slice(0, 5)
    .map(({ record, reason }) => `${record.id}: ${reason}`)
    .join("; ");
  throw new Error(
    `Refusing canvas apply because native semantic relation bindings are invalid (${details}). ` +
    "Reconnect both endpoints inside the same semantic diagram or delete the invalid relation first.",
  );
}

export function applyThinkingOperationsToSnapshot({
  snapshot,
  viewState = null,
  pageId: requestedPageId,
  operations,
  semanticDiagram: requestedSemanticDiagram = null,
  allowUserAuthoredEdits = false,
} = {}) {
  if (!snapshot?.store || !snapshot?.schema) throw new Error("Expected a valid Yogurt AI snapshot.");
  validateOperations(operations);
  const nextSnapshot = cloneJson(snapshot);
  const store = nextSnapshot.store;
  assertSemanticRelationsSafeForApply(store, operations);
  syncThinkingRelationEndpointMetadata(store);
  const pageId = resolvePageId(nextSnapshot, requestedPageId, viewState);
  const semanticDiagram = normalizeSemanticDiagramMetadata(requestedSemanticDiagram, operations);
  if (!semanticDiagram && operations.some((operation) => operation?.semantic || operation?.semanticId)) {
    throw new Error("Semantic object and relation fields require the batch-level semanticDiagram contract.");
  }
  if (!semanticDiagram && operations.some((operation) => operation?.type === "create_zone" && operation.purpose === "semantic")) {
    throw new Error("A semantic canvas zone requires the batch-level semanticDiagram contract.");
  }
  if (!semanticDiagram) {
    for (const operation of operations) {
      if (operation.type === "create_card" && semanticScopedShape(store, operation.parentZoneId)) {
        throw new Error("Creating a card inside a semantic canvas zone requires the batch-level semanticDiagram contract.");
      }
      if (
        operation.type === "create_relation" &&
        (semanticScopedShape(store, operation.from) || semanticScopedShape(store, operation.to))
      ) {
        throw new Error("Creating a relation for semantic canvas objects requires the batch-level semanticDiagram contract.");
      }
      if (
        operation.type === "update_card" &&
        operation.bridge !== undefined &&
        semanticScopedShape(store, operation.id)
      ) {
        throw new Error("Updating a semantic canvas card cannot include Product Bridge metadata.");
      }
    }
  }
  if (semanticDiagram) {
    const semanticIds = new Set();
    const deletedBefore = new Set();
    for (const operation of operations) {
      if (operation.bridge !== undefined) {
        throw new Error("Semantic canvas operations cannot include Product Bridge metadata.");
      }
      if (operation.type === "create_zone" && operation.purpose === "product") {
        throw new Error("A semanticDiagram batch cannot create a Product Bridge zone.");
      }
      const scopedReferences = [
        operation.parentZoneId,
        operation.from,
        operation.to,
        operation.id,
      ].filter((value) => typeof value === "string" && value);
      const productScope = scopedReferences.map((value) => productScopedShape(store, value)).find(Boolean);
      if (productScope) {
        throw new Error(`Semantic canvas operations cannot target Product Bridge shape ${productScope.id}.`);
      }
      if (operation.type === "delete_shape") {
        const shape = typeof operation.id === "string" ? store[operation.id] : null;
        if (shape?.typeName === "shape" && shape.meta?.cowartThinkingGenerated === true) {
          for (const id of generatedDeletionIds(store, shape)) deletedBefore.add(id);
        }
        continue;
      }
      if (!["create_card", "create_zone", "create_relation"].includes(operation.type)) continue;
      const semanticId = operation.type === "create_relation"
        ? boundedString(operation.semanticId, 160) || boundedString(operation.key, 80)
        : boundedString(operation.semantic?.id, 160) || boundedString(operation.key, 80);
      if (!semanticId) throw new Error(`${operation.type} requires a stable semantic ID or creation key.`);
      if (semanticIds.has(semanticId)) throw new Error(`Duplicate semantic ID '${semanticId}' in one diagram batch.`);
      semanticIds.add(semanticId);
      const duplicate = Object.values(store).find((record) =>
        record?.typeName === "shape" &&
        !deletedBefore.has(record.id) &&
        record.meta?.cowartSemanticDiagram?.diagramId === semanticDiagram.diagramId &&
        (
          record.meta?.cowartSemanticObject?.semanticId === semanticId ||
          record.meta?.cowartSemanticRelation?.semanticId === semanticId
        ),
      );
      if (duplicate) throw new Error(`Semantic ID '${semanticId}' already exists in diagram ${semanticDiagram.diagramId}.`);
    }
  }
  const references = new Map();
  const changes = [];
  const createdCards = [];
  const createdRelations = [];
  const geometryChangedShapeIds = new Set();
  let createdCount = 0;

  for (const operation of operations) {
    if (operation.type === "create_zone") {
      const zone = createZoneRecord(store, pageId, operation, semanticDiagram);
      store[zone.id] = zone;
      const key = boundedString(operation.key, 80);
      references.set(key, zone.id);
      changes.push({ type: operation.type, id: zone.id, key });
      continue;
    }

    if (operation.type === "update_zone") {
      const updated = updateCanvasZone(store, operation, references, pageId, semanticDiagram);
      descendantShapeIds(store, updated.id).forEach((id) => geometryChangedShapeIds.add(id));
      changes.push({
        type: operation.type,
        id: updated.id,
        key: managedZoneKey(updated),
      });
      continue;
    }

    if (operation.type === "create_card") {
      const card = createCardRecord(store, pageId, operation, createdCount, references, semanticDiagram);
      store[card.id] = card;
      const key = boundedString(operation.key, 80);
      if (key) references.set(key, card.id);
      createdCards.push({ id: card.id, operation });
      changes.push({ type: operation.type, id: card.id, key: key || null });
      createdCount += 1;
      continue;
    }

    if (operation.type === "update_card") {
      const updated = updateThinkingCard(store, operation, allowUserAuthoredEdits, semanticDiagram);
      geometryChangedShapeIds.add(updated.id);
      changes.push({ type: operation.type, id: updated.id });
      continue;
    }

    if (operation.type === "move_shape") {
      const shape = resolveShapeReference(store, references, operation.id, "move_shape.id");
      assertManagedOrExplicitEdit(shape, allowUserAuthoredEdits, "move");
      shape.x = finiteNumber(operation.x, shape.x);
      shape.y = finiteNumber(operation.y, shape.y);
      descendantShapeIds(store, shape.id).forEach((id) => geometryChangedShapeIds.add(id));
      changes.push({ type: operation.type, id: shape.id, x: shape.x, y: shape.y });
      continue;
    }

    if (operation.type === "resize_shape") {
      const shape = resolveShapeReference(store, references, operation.id, "resize_shape.id");
      assertManagedOrExplicitEdit(shape, allowUserAuthoredEdits, "resize");
      if (!("w" in (shape.props ?? {})) || !("h" in (shape.props ?? {}))) {
        throw new Error(`Shape ${shape.id} cannot be resized with width and height.`);
      }
      shape.props.w = Math.max(16, Math.min(8_192, finiteNumber(operation.w, shape.props.w)));
      shape.props.h = Math.max(16, Math.min(8_192, finiteNumber(operation.h, shape.props.h)));
      descendantShapeIds(store, shape.id).forEach((id) => geometryChangedShapeIds.add(id));
      changes.push({ type: operation.type, id: shape.id, w: shape.props.w, h: shape.props.h });
      continue;
    }

    if (operation.type === "create_relation") {
      const arrow = createRelationRecords(store, operation, references, semanticDiagram);
      const key = boundedString(operation.key, 80);
      if (key) references.set(key, arrow.id);
      createdRelations.push(arrow.id);
      changes.push({ type: operation.type, id: arrow.id, key: key || null });
      continue;
    }

    if (operation.type === "delete_shape") {
      const deletedIds = deleteGeneratedShape(store, operation, references);
      changes.push({ type: operation.type, id: operation.id, deletedIds });
    }
  }

  layoutCreatedThinkingGraph(store, pageId, createdCards, createdRelations, semanticDiagram);
  if (semanticDiagram) {
    for (const record of pageShapes(store, pageId)) {
      if (
        record.type === "arrow" &&
        record.meta?.cowartThinkingGenerated === true &&
        record.meta?.cowartThinkingRelation === true &&
        record.meta?.cowartSemanticDiagram?.diagramId === semanticDiagram.diagramId
      ) {
        refreshRelationGeometryAndBindings(store, record.id);
      }
    }
  }
  if (geometryChangedShapeIds.size > 0) {
    const changedSemanticDiagramIds = new Set(
      Array.from(geometryChangedShapeIds)
        .map((id) => store[id]?.meta?.cowartSemanticDiagram?.diagramId)
        .filter(Boolean),
    );
    for (const record of Object.values(store)) {
      const endpoints = boundThinkingRelationEndpoints(store, record, { syncMeta: true });
      if (
        record?.typeName !== "shape" ||
        record.type !== "arrow" ||
        record.meta?.cowartThinkingGenerated !== true ||
        !(
          geometryChangedShapeIds.has(endpoints.fromId) ||
          geometryChangedShapeIds.has(endpoints.toId) ||
          changedSemanticDiagramIds.has(record.meta?.cowartSemanticDiagram?.diagramId)
        )
      ) {
        continue;
      }
      refreshRelationGeometryAndBindings(store, record.id);
    }
  }

  return {
    snapshot: nextSnapshot,
    pageId,
    changes,
    references: Object.fromEntries(references),
    semanticDiagram,
    revision: snapshotRevision(nextSnapshot),
  };
}

function validateSnapshot(snapshot) {
  try {
    const validationStore = new Store({
      schema: createTLSchema(),
      props: { defaultName: "Yogurt AI" },
    });
    validationStore.loadStoreSnapshot(snapshot);
    return snapshot;
  } catch (error) {
    throw new Error(`Thinking operations produced an invalid canvas snapshot: ${error.message}`, { cause: error });
  }
}

function historyDirectory(args) {
  return join(resolveCanvasDir(args), "thinking-history");
}

function historyFile(args, operationId) {
  return join(historyDirectory(args), `${safeIdPart(operationId, "operation")}.json`);
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function pruneHistory(args) {
  const directory = historyDirectory(args);
  let files;
  try {
    files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const fileName of files.slice(HISTORY_LIMIT)) {
    await rm(join(directory, fileName), { force: true });
  }
}

export async function getThinkingContext(args = {}, options = {}) {
  const hasFrozenSelection = options.scope === "selection" && Array.isArray(options.shapeIds);
  const state = await readCowartCanvasState(args, { hydrateAssets: false });
  const selectionState = hasFrozenSelection
    ? { selection: { selectedShapes: [] } }
    : await readCowartSelectionState(args);
  return {
    ...summarizeThinkingContext({
      snapshot: ensureThinkingSnapshot(state.snapshot),
      selection: selectionState.selection,
      viewState: state.viewState,
      pageId: options.pageId,
      scope: options.scope,
      shapeIds: options.shapeIds,
      includeAnnotations: options.includeAnnotations,
      maxShapes: options.maxShapes,
      maxTextLength: options.maxTextLength,
    }),
    projectDir: state.projectDir,
    canvasDir: state.canvasDir,
  };
}

export async function applyThinkingOperations(args = {}, options = {}) {
  const state = await readCowartCanvasState(args, { hydrateAssets: false });
  const currentSnapshot = ensureThinkingSnapshot(state.snapshot);
  const currentRevision = snapshotRevision(currentSnapshot);
  if (options.baseRevision && options.baseRevision !== currentRevision) {
    throw new Error(`Canvas revision changed from ${options.baseRevision} to ${currentRevision}; inspect again before applying.`);
  }

  const result = applyThinkingOperationsToSnapshot({
    snapshot: currentSnapshot,
    viewState: state.viewState,
    pageId: options.pageId,
    operations: options.operations,
    semanticDiagram: options.semanticDiagram,
    allowUserAuthoredEdits: options.allowUserAuthoredEdits === true,
  });
  result.snapshot = await validateSnapshot(result.snapshot);
  result.revision = snapshotRevision(result.snapshot);

  if (options.dryRun === true) {
    return {
      ok: true,
      applied: false,
      baseRevision: currentRevision,
      resultRevision: result.revision,
      pageId: result.pageId,
      changes: result.changes,
      references: result.references,
      semanticDiagram: result.semanticDiagram,
    };
  }

  const operationId = `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  const history = {
    version: HISTORY_VERSION,
    operationId,
    createdAt: new Date().toISOString(),
    reason: boundedString(options.reason, 2_000, "Canvas thinking edit"),
    explanation: boundedString(options.explanation, 8_000),
    baseRevision: currentRevision,
    resultRevision: result.revision,
    pageId: result.pageId,
    changes: result.changes,
    beforeSnapshot: currentSnapshot,
  };
  const persistedHistoryPath = historyFile(args, operationId);
  await writeJsonAtomic(persistedHistoryPath, history);

  let saveResult;
  try {
    saveResult = await saveCowartCanvasSnapshot(args, result.snapshot);
    if (!saveResult.ok) {
      throw new Error(saveResult.message || "Yogurt AI refused to persist the thinking operation batch.");
    }
  } catch (error) {
    await rm(persistedHistoryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await pruneHistory(args);

  return {
    ok: true,
    applied: true,
    operationId,
    baseRevision: currentRevision,
    resultRevision: result.revision,
    pageId: result.pageId,
    changes: result.changes,
    references: result.references,
    semanticDiagram: result.semanticDiagram,
    explanation: history.explanation,
    storage: saveResult.storage,
  };
}

async function readHistoryEntries(args) {
  const directory = historyDirectory(args);
  let entries;
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const histories = [];
  for (const fileName of entries) {
    try {
      histories.push({ filePath: join(directory, fileName), value: JSON.parse(await readFile(join(directory, fileName), "utf8")) });
    } catch (_error) {
      // Ignore malformed history entries; they cannot be safely used for undo.
    }
  }
  return histories;
}

export async function undoThinkingOperation(args = {}, options = {}) {
  const histories = await readHistoryEntries(args);
  const candidate = histories.find(({ value }) =>
    !value.undoneAt && (!options.operationId || value.operationId === options.operationId),
  );
  if (!candidate) throw new Error(options.operationId ? `Unknown or already undone operation ${options.operationId}.` : "No thinking operation is available to undo.");

  const state = await readCowartCanvasState(args, { hydrateAssets: false });
  const currentRevision = snapshotRevision(state.snapshot);
  if (currentRevision !== candidate.value.resultRevision) {
    throw new Error(
      `Refusing stale undo: canvas revision is ${currentRevision}, but operation ${candidate.value.operationId} produced ${candidate.value.resultRevision}.`,
    );
  }

  const beforeSnapshot = await validateSnapshot(candidate.value.beforeSnapshot);
  const saveResult = await saveCowartCanvasSnapshot(args, beforeSnapshot);
  if (!saveResult.ok) throw new Error(saveResult.message || "Yogurt AI refused to persist the undo snapshot.");

  const updatedHistory = {
    ...candidate.value,
    undoneAt: new Date().toISOString(),
    undoRevision: snapshotRevision(beforeSnapshot),
  };
  await writeJsonAtomic(candidate.filePath, updatedHistory);
  return {
    ok: true,
    operationId: candidate.value.operationId,
    revision: updatedHistory.undoRevision,
    restoredChangeCount: candidate.value.changes?.length ?? 0,
    storage: saveResult.storage,
  };
}

function sanitizedMaterialName(fileName) {
  const ext = extname(fileName).slice(0, 16);
  const stem = basename(fileName, ext)
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "material";
  return `${stem}${ext}`;
}

async function uniqueMaterialPath(directory, requestedName) {
  const safeName = sanitizedMaterialName(requestedName);
  const extension = extname(safeName);
  const stem = basename(safeName, extension);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const name = attempt === 0 ? safeName : `${stem}-${attempt}${extension}`;
    const filePath = join(directory, name);
    try {
      await stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return { fileName: name, filePath };
      throw error;
    }
  }
  throw new Error(`Unable to allocate material path for ${safeName}.`);
}

export async function importThinkingMaterial(args = {}, options = {}) {
  const sourcePath = resolve(String(options.sourcePath || ""));
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`Thinking material is not a file: ${sourcePath}`);
  if (sourceStat.size > MATERIAL_SIZE_LIMIT) throw new Error("Thinking material exceeds the 200 MB MVP limit.");

  const { projectDir, canvasDir } = resolveCowartPaths(args);
  if (!options.allowExternalSource && sourcePath !== projectDir && !isSafeChildPath(projectDir, sourcePath)) {
    throw new Error("Material must be inside the active project unless allowExternalSource is explicitly enabled.");
  }

  let localPath = sourcePath;
  let copied = false;
  if (options.copySource !== false) {
    const directory = join(canvasDir, "materials");
    if (!isSafeChildPath(canvasDir, directory)) throw new Error(`Unsafe material directory: ${directory}`);
    const destination = await uniqueMaterialPath(directory, options.fileName || basename(sourcePath));
    if (options.dryRun !== true) {
      await mkdir(directory, { recursive: true });
      await copyFile(sourcePath, destination.filePath);
      copied = true;
    }
    localPath = destination.filePath;
  }

  const source = {
    kind: boundedString(options.kind, 32, extname(sourcePath).slice(1).toLowerCase() || "file"),
    fileName: boundedString(options.fileName, 240, basename(sourcePath)),
    originalPath: sourcePath,
    localPath,
    excerpt: boundedString(options.excerpt, 3_000),
    fileSize: sourceStat.size,
  };

  try {
    const result = await applyThinkingOperations(args, {
      baseRevision: options.baseRevision,
      pageId: options.pageId,
      dryRun: options.dryRun,
      reason: options.reason || `Import material ${source.fileName}`,
      explanation: options.explanation || "Attached source material as a provenance-preserving canvas card.",
      operations: [
        {
          type: "create_card",
          key: "material",
          role: "material",
          generated: false,
          title: options.title || source.fileName,
          body: options.summary || source.excerpt || "Source material",
          color: options.color || "light-blue",
          x: options.x,
          y: options.y,
          w: options.w ?? 360,
          h: options.h ?? 220,
          source,
        },
      ],
    });
    return { ...result, source, copied: options.dryRun === true ? false : copied };
  } catch (error) {
    if (copied && isSafeChildPath(canvasDir, localPath)) await rm(localPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
