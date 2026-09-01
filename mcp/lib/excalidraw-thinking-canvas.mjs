import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { generateKeyBetween } from "fractional-indexing";

import {
  cowartSnapshotRevision,
  readCowartCanvasState,
  readCowartSelectionState,
  resolveCanvasDir,
  resolveCowartPaths,
  saveCowartCanvasSnapshot,
} from "./canvas-storage.mjs";
import { layoutSemanticGraph } from "./semantic-layout.mjs";

const SCENE_PAGE_ID = "excalidraw:scene";
const HISTORY_VERSION = 1;
const HISTORY_LIMIT = 20;
const MATERIAL_SIZE_LIMIT = 200 * 1024 * 1024;
const DEFAULT_CARD_WIDTH = 320;
const DEFAULT_CARD_HEIGHT = 180;
const DEFAULT_ZONE_WIDTH = 1_200;
const DEFAULT_ZONE_HEIGHT = 720;
const DEFAULT_GAP = 56;
const MAX_CONTEXT_SHAPES = 250;
const MAX_CONTEXT_TEXT = 4_000;
const ROUTE_PADDING = 48;
const ROUTE_LANE_GAP = 36;
const ROUTE_BEND_COST = 48;
const ROUTE_EPSILON = 1e-6;

const ROLE_COLORS = Object.freeze({
  material: "light-blue",
  idea: "light-violet",
  evidence: "light-green",
  question: "yellow",
  insight: "violet",
  assumption: "orange",
  decision: "green",
  summary: "blue",
  counterpoint: "light-red",
});

const STROKE_COLORS = Object.freeze({
  black: "#1e1e1e",
  blue: "#1971c2",
  green: "#2f9e44",
  grey: "#868e96",
  "light-blue": "#1971c2",
  "light-green": "#2f9e44",
  "light-red": "#e03131",
  "light-violet": "#7048e8",
  orange: "#e8590c",
  red: "#e03131",
  violet: "#7048e8",
  white: "#f8f9fa",
  yellow: "#f08c00",
});

const BACKGROUND_COLORS = Object.freeze({
  black: "#ced4da",
  blue: "#a5d8ff",
  green: "#b2f2bb",
  grey: "#e9ecef",
  "light-blue": "#d0ebff",
  "light-green": "#d3f9d8",
  "light-red": "#ffe3e3",
  "light-violet": "#e5dbff",
  orange: "#ffe8cc",
  red: "#ffc9c9",
  violet: "#d0bfff",
  white: "#ffffff",
  yellow: "#fff3bf",
});

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedString(value, maxLength, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
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
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  );
  return Object.keys(compacted).length > 0 ? compacted : null;
}

function ensureExcalidrawSnapshot(snapshot) {
  if (snapshot?.type === "excalidraw" && Array.isArray(snapshot.elements)) {
    return {
      ...cloneJson(snapshot),
      version: finiteNumber(snapshot.version, 2),
      source: typeof snapshot.source === "string" ? snapshot.source : "https://excalidraw.com",
      appState: cloneJson(snapshot.appState ?? {}),
      files: cloneJson(snapshot.files ?? {}),
    };
  }
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

function nextIndex(elements) {
  const lastIndex = [...elements]
    .reverse()
    .find((element) => element?.isDeleted !== true && typeof element.index === "string")
    ?.index ?? null;
  try {
    return generateKeyBetween(lastIndex, null);
  } catch (_error) {
    // Excalidraw will repair a null fractional index on scene restore. This is
    // safer than inventing an invalid index after importing a malformed file.
    return null;
  }
}

function randomSeed() {
  return Math.max(1, Math.floor(Math.random() * 2_147_483_646));
}

function elementId(kind) {
  return `cowart-${kind}-${randomUUID()}`;
}

function commonElement(elements, { id, type, x, y, width, height, frameId = null }) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "hachure",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId,
    index: nextIndex(elements),
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: randomSeed(),
    version: 1,
    versionNonce: randomSeed(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function touch(element) {
  element.version = Math.max(1, finiteNumber(element.version, 1)) + 1;
  element.versionNonce = randomSeed();
  element.updated = Date.now();
}

function strokeColor(value, role = "idea") {
  const name = typeof value === "string" && value in STROKE_COLORS
    ? value
    : ROLE_COLORS[role] ?? "black";
  return STROKE_COLORS[name] ?? STROKE_COLORS.black;
}

function backgroundColor(value, role = "idea", fill = "none") {
  if (fill === "none") return "transparent";
  const name = typeof value === "string" && value in BACKGROUND_COLORS
    ? value
    : ROLE_COLORS[role] ?? "white";
  return BACKGROUND_COLORS[name] ?? BACKGROUND_COLORS.white;
}

function fillStyle(fill) {
  return fill === "solid" ? "solid" : "hachure";
}

function normalizeSemanticDiagram(value, operations = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const diagramId = boundedString(value.diagramId, 160);
  const teachingClaim = boundedString(value.teachingClaim, 500);
  if (!diagramId || !teachingClaim) {
    throw new Error("semanticDiagram must include diagramId and teachingClaim.");
  }
  return {
    version: "1",
    diagramId,
    teachingClaim,
    readingOrder: boundedString(value.readingOrder, 40, "top-to-bottom"),
    diagramType: boundedString(value.diagramType, 40, "custom"),
    layoutEngine: "html-line-svg",
    layoutMode: value.layoutMode === "compact" ? "compact" : "balanced",
    layoutFit: value.layoutFit === "fixed" ? "fixed" : "grow",
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
  if (!semanticId) throw new Error("Every semantic object requires semantic.id or a stable creation key.");
  return {
    version: "1",
    diagramId: diagram.diagramId,
    semanticId,
    type: boundedString(value?.type, 40, "custom"),
    state: boundedString(value?.state, 40, "normal"),
    origin: boundedString(value?.origin, 40, "synthesis"),
    order: Math.max(0, Math.min(999, Math.trunc(finiteNumber(value?.order, 0)))),
    sourceShapeIds: boundedStringList(value?.sourceShapeIds, 100),
    sourceIds: boundedStringList(value?.sourceIds, 100),
  };
}

function patchSemanticObject(current, patch, diagram, label) {
  if (patch === undefined) return current ?? null;
  if (!current?.semanticId || !current?.diagramId) {
    throw new Error(`${label}.semantic requires an existing semantic object.`);
  }
  if (!diagram || diagram.diagramId !== current.diagramId) {
    throw new Error(`${label}.semantic must stay in diagram ${current.diagramId}.`);
  }
  const next = cloneJson(current);
  for (const field of ["type", "state", "origin"]) {
    if (patch[field] !== undefined) next[field] = boundedString(patch[field], 40, next[field]);
  }
  if (patch.order !== undefined) next.order = Math.max(0, Math.min(999, Math.trunc(patch.order)));
  if (patch.sourceShapeIds !== undefined) next.sourceShapeIds = boundedStringList(patch.sourceShapeIds, 100);
  if (patch.sourceIds !== undefined) next.sourceIds = boundedStringList(patch.sourceIds, 100);
  return next;
}

function cowartData(element) {
  return element?.customData?.cowart ?? null;
}

function isManaged(element, kind = null) {
  const cowart = cowartData(element);
  return Boolean(cowart?.managed === true && (!kind || cowart.kind === kind));
}

function activeElements(snapshot) {
  return snapshot.elements.filter((element) => element && element.isDeleted !== true);
}

function activeById(snapshot) {
  return new Map(activeElements(snapshot).map((element) => [element.id, element]));
}

function resolveElement(snapshot, references, value, label) {
  const id = references.get(value) ?? value;
  const element = snapshot.elements.find((candidate) => candidate.id === id && candidate.isDeleted !== true);
  if (!element) throw new Error(`${label} references unknown Excalidraw element '${value}'.`);
  return element;
}

function assertManagedOrExplicit(element, allowUserAuthoredEdits, action) {
  if (!isManaged(element) && !allowUserAuthoredEdits) {
    throw new Error(`Refusing to ${action} user-authored Excalidraw element ${element.id}.`);
  }
}

function addBoundElement(element, id, type) {
  const refs = Array.isArray(element.boundElements) ? element.boundElements : [];
  if (!refs.some((ref) => ref?.id === id)) refs.push({ id, type });
  element.boundElements = refs;
}

function removeBoundElement(element, id) {
  if (!Array.isArray(element?.boundElements)) return;
  const next = element.boundElements.filter((ref) => ref?.id !== id);
  element.boundElements = next.length > 0 ? next : null;
}

function cardText(title, body) {
  return [boundedString(title, 300), boundedString(body, 12_000)].filter(Boolean).join("\n\n");
}

function estimatedGlyphWidth(character, fontSize) {
  if (/\s/u.test(character)) return fontSize * 0.34;
  if (/^[\u0000-\u00ff]$/u.test(character)) return fontSize * 0.58;
  return fontSize * 0.98;
}

function balanceTrailingTextRow(rows) {
  if (rows.length < 2) return rows;
  const previous = Array.from(rows.at(-2));
  const trailing = Array.from(rows.at(-1));
  if (trailing.length >= 4 || trailing.length >= previous.length / 2) return rows;
  const combined = [...previous, ...trailing];
  const splitAt = Math.ceil(combined.length / 2);
  return [...rows.slice(0, -2), combined.slice(0, splitAt).join(""), combined.slice(splitAt).join("")];
}

function wrapTextForWidth(value, fontSize, maximumWidth) {
  const source = String(value || " ");
  const widthLimit = Math.max(fontSize * 4, maximumWidth);
  return source
    .split("\n")
    .flatMap((line) => {
      if (!line) return [""];
      const rows = [];
      let row = "";
      let rowWidth = 0;
      let lastWhitespaceIndex = -1;
      for (const character of Array.from(line)) {
        const characterWidth = estimatedGlyphWidth(character, fontSize);
        if (row && rowWidth + characterWidth > widthLimit) {
          if (lastWhitespaceIndex > 0) {
            rows.push(row.slice(0, lastWhitespaceIndex).trimEnd());
            row = `${row.slice(lastWhitespaceIndex).trimStart()}${character}`;
            rowWidth = Array.from(row).reduce(
              (total, glyph) => total + estimatedGlyphWidth(glyph, fontSize),
              0,
            );
          } else {
            rows.push(row);
            row = character;
            rowWidth = characterWidth;
          }
          lastWhitespaceIndex = Array.from(row).findLastIndex((glyph) => /\s/u.test(glyph));
          continue;
        }
        row += character;
        rowWidth += characterWidth;
        if (/\s/u.test(character)) lastWhitespaceIndex = Array.from(row).length - 1;
      }
      rows.push(row);
      return balanceTrailingTextRow(rows);
    })
    .join("\n");
}

function splitCardText(value) {
  const text = typeof value === "string" ? value : "";
  const [title = "", ...body] = text.split(/\n\s*\n/u);
  return { title: title.trim(), body: body.join("\n\n").trim() };
}

function estimateTextMetrics(text, fontSize = 20, maximumWidth = 288) {
  const safeFontSize = Math.max(8, finiteNumber(fontSize, 20));
  const wrappedText = wrapTextForWidth(text, safeFontSize, maximumWidth);
  const lineCount = wrappedText.split("\n").length;
  return {
    width: maximumWidth,
    height: Math.max(safeFontSize * 1.25, lineCount * safeFontSize * 1.25),
    lineHeight: 1.25,
    wrappedText,
  };
}

function createBoundText(elements, {
  container,
  text,
  kind,
  fontSize = 20,
  textAlign = "center",
  verticalAlign = "middle",
}) {
  const originalText = text || " ";
  const metrics = estimateTextMetrics(originalText, fontSize, Math.max(40, container.width - 32));
  const id = elementId("text");
  const element = {
    ...commonElement(elements, {
      id,
      type: "text",
      x: container.x + 16,
      y: container.y + Math.max(12, (container.height - metrics.height) / 2),
      width: metrics.width,
      height: metrics.height,
      frameId: container.frameId ?? null,
    }),
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "hachure",
    strokeWidth: 1,
    roughness: 0,
    roundness: null,
    fontSize,
    fontFamily: 5,
    text: metrics.wrappedText,
    textAlign,
    verticalAlign,
    containerId: container.id,
    originalText,
    autoResize: false,
    lineHeight: metrics.lineHeight,
    customData: {
      cowart: {
        managed: true,
        kind,
        parentId: container.id,
      },
    },
  };
  addBoundElement(container, id, "text");
  return element;
}

function syncBoundTextPosition(container, textElement) {
  if (!container || !textElement) return;
  textElement.x = container.x + Math.max(12, (container.width - textElement.width) / 2);
  textElement.y = container.y + Math.max(12, (container.height - textElement.height) / 2);
  textElement.frameId = container.frameId ?? null;
  touch(textElement);
}

function boundTextFor(snapshot, container) {
  if (!container) return null;
  return snapshot.elements.find((element) =>
    element?.type === "text" &&
    element.isDeleted !== true &&
    element.containerId === container.id,
  ) ?? null;
}

function createCard(snapshot, operation, references, diagram) {
  const role = boundedString(operation.role, 40, "idea");
  const parent = operation.parentZoneId
    ? resolveElement(snapshot, references, operation.parentZoneId, "create_card.parentZoneId")
    : null;
  if (parent && !isManaged(parent, "zone")) {
    throw new Error(`create_card.parentZoneId must reference a Cowart-managed frame.`);
  }
  const anchor = operation.anchorId
    ? resolveElement(snapshot, references, operation.anchorId, "create_card.anchorId")
    : null;
  const width = Math.max(120, Math.min(2_000, finiteNumber(operation.w, DEFAULT_CARD_WIDTH)));
  const height = Math.max(80, Math.min(2_000, finiteNumber(operation.h, DEFAULT_CARD_HEIGHT)));
  let x = finiteNumber(operation.x, null);
  let y = finiteNumber(operation.y, null);
  if (anchor && (x === null || y === null)) {
    const gap = Math.max(0, Math.min(2_000, finiteNumber(operation.gap, DEFAULT_GAP)));
    const placement = operation.placement ?? "right";
    x = placement === "left"
      ? anchor.x - width - gap
      : placement === "right"
        ? anchor.x + anchor.width + gap
        : anchor.x;
    y = placement === "above"
      ? anchor.y - height - gap
      : placement === "below"
        ? anchor.y + anchor.height + gap
        : anchor.y;
  }
  const rectangle = {
    ...commonElement(snapshot.elements, {
      id: elementId("card"),
      type: "rectangle",
      x: x ?? 0,
      y: y ?? 0,
      width,
      height,
      frameId: parent?.id ?? null,
    }),
    strokeColor: strokeColor(operation.color, role),
    backgroundColor: backgroundColor(operation.color, role, operation.fill),
    fillStyle: fillStyle(operation.fill),
    link: boundedString(operation.url, 2_000) || null,
    customData: {
      cowart: {
        version: 1,
        managed: true,
        kind: "card",
        role,
        key: boundedString(operation.key, 80) || null,
        title: boundedString(operation.title, 300),
        body: boundedString(operation.body, 12_000),
        sourceRefs: boundedStringList(operation.sourceRefs, 50, 500),
        source: cloneJson(operation.source ?? null),
        bridge: cloneJson(operation.bridge ?? null),
        semanticDiagram: cloneJson(diagram),
        semanticObject: normalizeSemanticObject(operation.semantic, diagram, operation.key),
        url: boundedString(operation.url, 2_000) || null,
        generatedByAgent: operation.generated !== false,
      },
    },
  };
  const text = createBoundText(snapshot.elements, {
    container: rectangle,
    text: cardText(operation.title, operation.body),
    kind: "card-label",
  });
  snapshot.elements.push(rectangle, text);
  return { rectangle, text, autoLayout: x === null || y === null };
}

function createZone(snapshot, operation, diagram) {
  const width = Math.max(240, Math.min(8_192, finiteNumber(operation.w, DEFAULT_ZONE_WIDTH)));
  const height = Math.max(160, Math.min(8_192, finiteNumber(operation.h, DEFAULT_ZONE_HEIGHT)));
  const frame = {
    ...commonElement(snapshot.elements, {
      id: elementId("zone"),
      type: "frame",
      x: finiteNumber(operation.x, 80),
      y: finiteNumber(operation.y, 80),
      width,
      height,
    }),
    strokeColor: strokeColor(operation.color, "summary"),
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    roughness: 0,
    name: boundedString(operation.title, 300, "Untitled"),
    customData: {
      cowart: {
        version: 1,
        managed: true,
        kind: "zone",
        key: boundedString(operation.key, 80),
        title: boundedString(operation.title, 300),
        body: boundedString(operation.body, 12_000),
        sourceRefs: boundedStringList(operation.sourceRefs, 50, 500),
        bridge: cloneJson(operation.bridge ?? null),
        purpose: boundedString(operation.purpose, 40, "thinking"),
        semanticDiagram: cloneJson(diagram),
        semanticObject: normalizeSemanticObject(operation.semantic, diagram, operation.key),
        generatedByAgent: true,
      },
    },
  };
  snapshot.elements.push(frame);
  return frame;
}

function rectangleCenter(element) {
  return {
    x: finiteNumber(element.x, 0) + finiteNumber(element.width, 0) / 2,
    y: finiteNumber(element.y, 0) + finiteNumber(element.height, 0) / 2,
  };
}

function routeRect(element, padding = 0) {
  const x = finiteNumber(element?.x, 0);
  const y = finiteNumber(element?.y, 0);
  const width = Math.max(0, finiteNumber(element?.width, 0));
  const height = Math.max(0, finiteNumber(element?.height, 0));
  return {
    left: x - padding,
    top: y - padding,
    right: x + width + padding,
    bottom: y + height + padding,
  };
}

function routeRectContainsPoint(rect, point) {
  return (
    point.x > rect.left + ROUTE_EPSILON &&
    point.x < rect.right - ROUTE_EPSILON &&
    point.y > rect.top + ROUTE_EPSILON &&
    point.y < rect.bottom - ROUTE_EPSILON
  );
}

function routeSegmentIntersectsRect(start, end, rect) {
  if (Math.abs(start.x - end.x) <= ROUTE_EPSILON) {
    if (start.x <= rect.left + ROUTE_EPSILON || start.x >= rect.right - ROUTE_EPSILON) return false;
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    return bottom > rect.top + ROUTE_EPSILON && top < rect.bottom - ROUTE_EPSILON;
  }
  if (Math.abs(start.y - end.y) <= ROUTE_EPSILON) {
    if (start.y <= rect.top + ROUTE_EPSILON || start.y >= rect.bottom - ROUTE_EPSILON) return false;
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    return right > rect.left + ROUTE_EPSILON && left < rect.right - ROUTE_EPSILON;
  }
  return true;
}

function sameRoutePoint(first, second) {
  return (
    Math.abs(first.x - second.x) <= ROUTE_EPSILON &&
    Math.abs(first.y - second.y) <= ROUTE_EPSILON
  );
}

function simplifyOrthogonalPoints(points) {
  const deduplicated = [];
  for (const point of points) {
    if (!deduplicated.some((candidate, index) =>
      index === deduplicated.length - 1 && sameRoutePoint(candidate, point)
    )) {
      deduplicated.push(point);
    }
  }
  if (deduplicated.length < 3) return deduplicated;
  const simplified = [deduplicated[0]];
  for (let index = 1; index < deduplicated.length - 1; index += 1) {
    const previous = simplified.at(-1);
    const current = deduplicated[index];
    const next = deduplicated[index + 1];
    const sameX = Math.abs(previous.x - current.x) <= ROUTE_EPSILON &&
      Math.abs(current.x - next.x) <= ROUTE_EPSILON;
    const sameY = Math.abs(previous.y - current.y) <= ROUTE_EPSILON &&
      Math.abs(current.y - next.y) <= ROUTE_EPSILON;
    if (!sameX && !sameY) simplified.push(current);
  }
  simplified.push(deduplicated.at(-1));
  return simplified;
}

function routePort(element, side, offset = 0) {
  const rect = routeRect(element);
  const center = rectangleCenter(element);
  const horizontalInset = Math.min(28, Math.max(8, (rect.right - rect.left) / 4));
  const verticalInset = Math.min(28, Math.max(8, (rect.bottom - rect.top) / 4));
  if (side === "left" || side === "right") {
    return {
      side,
      point: {
        x: side === "left" ? rect.left : rect.right,
        y: Math.max(rect.top + verticalInset, Math.min(rect.bottom - verticalInset, center.y + offset)),
      },
    };
  }
  return {
    side,
    point: {
      x: Math.max(rect.left + horizontalInset, Math.min(rect.right - horizontalInset, center.x + offset)),
      y: side === "top" ? rect.top : rect.bottom,
    },
  };
}

function routeStub(port) {
  if (port.side === "left") return { x: port.point.x - ROUTE_PADDING, y: port.point.y };
  if (port.side === "right") return { x: port.point.x + ROUTE_PADDING, y: port.point.y };
  if (port.side === "top") return { x: port.point.x, y: port.point.y - ROUTE_PADDING };
  return { x: port.point.x, y: port.point.y + ROUTE_PADDING };
}

function routeBindingFocus(element, port) {
  const rect = routeRect(element);
  const center = rectangleCenter(element);
  if (port.side === "left" || port.side === "right") {
    return Math.max(-0.95, Math.min(0.95, (port.point.y - center.y) / Math.max(1, (rect.bottom - rect.top) / 2)));
  }
  return Math.max(-0.95, Math.min(0.95, (port.point.x - center.x) / Math.max(1, (rect.right - rect.left) / 2)));
}

function routeDiagramId(element) {
  return cowartData(element)?.semanticDiagram?.diagramId ?? null;
}

function routeScopeKey(element) {
  const diagramId = routeDiagramId(element);
  return diagramId ? `diagram:${diagramId}` : `frame:${element?.frameId ?? "__scene__"}`;
}

function routeObstacles(snapshot, relation, from, to) {
  const diagramId = routeDiagramId(relation);
  const sameScope = (element) => {
    if (diagramId) return routeDiagramId(element) === diagramId;
    if (relation.frameId) return element.frameId === relation.frameId;
    return !element.frameId;
  };
  const bindable = new Set(["rectangle", "diamond", "ellipse", "text"]);
  const elements = activeElements(snapshot).filter((element) =>
    bindable.has(element.type) &&
    !element.containerId &&
    sameScope(element),
  );
  if (!elements.some(({ id }) => id === from.id)) elements.push(from);
  if (!elements.some(({ id }) => id === to.id)) elements.push(to);
  return elements;
}

function routeBounds(elements) {
  const rects = elements.map((element) => routeRect(element));
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

function sortedUniqueCoordinates(values) {
  return [...new Set(values.map((value) => Number(value.toFixed(4))))].sort((first, second) => first - second);
}

function routeGridCoordinates(obstacles, routePoints, graphBounds, laneMagnitude = 1) {
  const xValues = routePoints.map(({ x }) => x);
  const yValues = routePoints.map(({ y }) => y);
  for (const rect of obstacles) {
    xValues.push(rect.left, rect.right);
    yValues.push(rect.top, rect.bottom);
  }
  const outerOffset = ROUTE_LANE_GAP * Math.max(1, laneMagnitude);
  xValues.push(graphBounds.left - outerOffset, graphBounds.right + outerOffset);
  yValues.push(graphBounds.top - outerOffset, graphBounds.bottom + outerOffset);
  const withMidpoints = (values) => {
    const sorted = sortedUniqueCoordinates(values);
    const expanded = [...sorted];
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] - sorted[index - 1] > ROUTE_PADDING * 2) {
        expanded.push((sorted[index] + sorted[index - 1]) / 2);
      }
    }
    return sortedUniqueCoordinates(expanded);
  };
  return { xValues: withMidpoints(xValues), yValues: withMidpoints(yValues) };
}

function routeOnGrid(start, end, obstacles, coordinates) {
  if (sameRoutePoint(start, end)) return [start];
  const { xValues, yValues } = coordinates;
  const pointKey = (xIndex, yIndex) => `${xIndex}:${yIndex}`;
  const pointFor = (xIndex, yIndex) => ({ x: xValues[xIndex], y: yValues[yIndex] });
  const validPoints = new Set();
  for (let xIndex = 0; xIndex < xValues.length; xIndex += 1) {
    for (let yIndex = 0; yIndex < yValues.length; yIndex += 1) {
      const point = pointFor(xIndex, yIndex);
      if (!obstacles.some((rect) => routeRectContainsPoint(rect, point))) {
        validPoints.add(pointKey(xIndex, yIndex));
      }
    }
  }
  const startX = xValues.findIndex((value) => Math.abs(value - start.x) <= ROUTE_EPSILON);
  const startY = yValues.findIndex((value) => Math.abs(value - start.y) <= ROUTE_EPSILON);
  const endX = xValues.findIndex((value) => Math.abs(value - end.x) <= ROUTE_EPSILON);
  const endY = yValues.findIndex((value) => Math.abs(value - end.y) <= ROUTE_EPSILON);
  if ([startX, startY, endX, endY].some((value) => value < 0)) return null;

  const startState = `${pointKey(startX, startY)}:none`;
  const pending = new Map([[startState, 0]]);
  const distance = new Map([[startState, 0]]);
  const previous = new Map();
  let finalState = null;
  while (pending.size > 0) {
    let currentState = null;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (const [state, candidateDistance] of pending) {
      if (candidateDistance < currentDistance) {
        currentState = state;
        currentDistance = candidateDistance;
      }
    }
    pending.delete(currentState);
    const [xText, yText, incomingDirection] = currentState.split(":");
    const xIndex = Number(xText);
    const yIndex = Number(yText);
    if (xIndex === endX && yIndex === endY) {
      finalState = currentState;
      break;
    }
    const candidates = [
      [xIndex - 1, yIndex, "horizontal"],
      [xIndex + 1, yIndex, "horizontal"],
      [xIndex, yIndex - 1, "vertical"],
      [xIndex, yIndex + 1, "vertical"],
    ];
    for (const [nextX, nextY, nextDirection] of candidates) {
      if (nextX < 0 || nextX >= xValues.length || nextY < 0 || nextY >= yValues.length) continue;
      if (!validPoints.has(pointKey(nextX, nextY))) continue;
      const currentPoint = pointFor(xIndex, yIndex);
      const nextPoint = pointFor(nextX, nextY);
      if (obstacles.some((rect) => routeSegmentIntersectsRect(currentPoint, nextPoint, rect))) continue;
      const segmentLength = Math.abs(nextPoint.x - currentPoint.x) + Math.abs(nextPoint.y - currentPoint.y);
      const bendCost = incomingDirection !== "none" && incomingDirection !== nextDirection ? ROUTE_BEND_COST : 0;
      const nextDistance = currentDistance + segmentLength + bendCost;
      const nextState = `${pointKey(nextX, nextY)}:${nextDirection}`;
      if (nextDistance + ROUTE_EPSILON >= (distance.get(nextState) ?? Number.POSITIVE_INFINITY)) continue;
      distance.set(nextState, nextDistance);
      previous.set(nextState, currentState);
      pending.set(nextState, nextDistance);
    }
  }
  if (!finalState) return null;
  const reversed = [];
  let cursor = finalState;
  while (cursor) {
    const [xText, yText] = cursor.split(":");
    reversed.push(pointFor(Number(xText), Number(yText)));
    cursor = previous.get(cursor) ?? null;
  }
  return simplifyOrthogonalPoints(reversed.reverse());
}

function routeThroughWaypoints(start, end, waypoints, obstacles, graphBounds, laneMagnitude) {
  const checkpoints = [start, ...waypoints, end];
  const coordinates = routeGridCoordinates(obstacles, checkpoints, graphBounds, laneMagnitude);
  const routed = [];
  for (let index = 1; index < checkpoints.length; index += 1) {
    const section = routeOnGrid(checkpoints[index - 1], checkpoints[index], obstacles, coordinates);
    if (!section) return null;
    routed.push(...(index === 1 ? section : section.slice(1)));
  }
  return simplifyOrthogonalPoints(routed);
}

function relationReadingAxis(relation) {
  const readingOrder = cowartData(relation)?.semanticDiagram?.readingOrder ?? "left-to-right";
  if (["left-to-right", "right-to-left", "board-to-peers"].includes(readingOrder)) {
    return { axis: "x", sign: readingOrder === "right-to-left" ? -1 : 1 };
  }
  return { axis: "y", sign: readingOrder === "bottom-to-top" ? -1 : 1 };
}

function relationFlow(relation, from, to) {
  const reading = relationReadingAxis(relation);
  const crossAxis = reading.axis === "x" ? "y" : "x";
  const fromCenter = rectangleCenter(from);
  const toCenter = rectangleCenter(to);
  const delta = {
    x: toCenter.x - fromCenter.x,
    y: toCenter.y - fromCenter.y,
  };
  const fromRect = routeRect(from);
  const toRect = routeRect(to);
  const separated = {
    x: toRect.left >= fromRect.right - ROUTE_EPSILON || fromRect.left >= toRect.right - ROUTE_EPSILON,
    y: toRect.top >= fromRect.bottom - ROUTE_EPSILON || fromRect.top >= toRect.bottom - ROUTE_EPSILON,
  };
  let axis = reading.axis;
  let sign = Math.sign(delta[axis]) || reading.sign;
  let backward = delta[reading.axis] * reading.sign < -ROUTE_EPSILON;
  if (!separated[reading.axis] && separated[crossAxis]) {
    axis = crossAxis;
    sign = Math.sign(delta[crossAxis]) || 1;
    // Wrapped html-line-svg bands progress downwards (horizontal reading)
    // or rightwards (vertical reading). Reversing inside a band is a return.
    backward = delta[crossAxis] < -ROUTE_EPSILON;
  }
  return { ...reading, routeAxis: axis, routeSign: sign, backward };
}

function automaticBackLane(snapshot, relation) {
  const { axis } = relationReadingAxis(relation);
  const diagramId = routeDiagramId(relation);
  const candidates = activeElements(snapshot)
    .filter((candidate) => candidate.type === "arrow" && isManaged(candidate, "relation"))
    .filter((candidate) => {
      if (routeDiagramId(candidate) !== diagramId || relationReadingAxis(candidate).axis !== axis) return false;
      const { from, to } = relationEndpoints(snapshot, candidate);
      return from && to && relationFlow(candidate, from, to).backward;
    })
    .sort((first, second) => {
      const firstId = cowartData(first)?.semanticRelation?.semanticId ?? first.id;
      const secondId = cowartData(second)?.semanticRelation?.semanticId ?? second.id;
      return firstId.localeCompare(secondId);
    });
  const index = Math.max(0, candidates.findIndex(({ id }) => id === relation.id));
  const magnitude = Math.floor(index / 2) + 1;
  return index % 2 === 0 ? magnitude : -magnitude;
}

function routeForRelation(snapshot, relation, from, to) {
  const semantic = cowartData(relation)?.semanticRelation ?? {};
  const flow = relationFlow(relation, from, to);
  const { axis } = flow;
  const explicitLane = Math.max(-8, Math.min(8, Math.trunc(finiteNumber(semantic.lane, 0))));
  const backward = from.id === to.id || flow.backward;
  const lane = explicitLane || (backward ? automaticBackLane(snapshot, relation) : semantic.path === "alternative" ? 1 : 0);
  const laneMagnitude = Math.max(1, Math.abs(lane));
  const portOffset = lane === 0 ? 0 : lane * 14;
  const elements = routeObstacles(snapshot, relation, from, to);
  const graphBounds = routeBounds(elements);
  const obstacles = elements.map((element) => routeRect(element, ROUTE_PADDING));
  let startPort;
  let endPort;
  let waypoints = [];

  if (from.id === to.id) {
    const side = axis === "x" ? (lane >= 0 ? "bottom" : "top") : (lane >= 0 ? "right" : "left");
    startPort = routePort(from, side, -28);
    endPort = routePort(to, side, 28);
    if (axis === "x") {
      const y = side === "bottom"
        ? graphBounds.bottom + ROUTE_LANE_GAP * laneMagnitude
        : graphBounds.top - ROUTE_LANE_GAP * laneMagnitude;
      waypoints = [{ x: startPort.point.x, y }, { x: endPort.point.x, y }];
    } else {
      const x = side === "right"
        ? graphBounds.right + ROUTE_LANE_GAP * laneMagnitude
        : graphBounds.left - ROUTE_LANE_GAP * laneMagnitude;
      waypoints = [{ x, y: startPort.point.y }, { x, y: endPort.point.y }];
    }
  } else if (backward) {
    if (axis === "x") {
      const side = lane >= 0 ? "bottom" : "top";
      startPort = routePort(from, side, portOffset);
      endPort = routePort(to, side, -portOffset);
      const y = side === "bottom"
        ? graphBounds.bottom + ROUTE_LANE_GAP * laneMagnitude
        : graphBounds.top - ROUTE_LANE_GAP * laneMagnitude;
      waypoints = [{ x: (startPort.point.x + endPort.point.x) / 2, y }];
    } else {
      const side = lane >= 0 ? "right" : "left";
      startPort = routePort(from, side, portOffset);
      endPort = routePort(to, side, -portOffset);
      const x = side === "right"
        ? graphBounds.right + ROUTE_LANE_GAP * laneMagnitude
        : graphBounds.left - ROUTE_LANE_GAP * laneMagnitude;
      waypoints = [{ x, y: (startPort.point.y + endPort.point.y) / 2 }];
    }
  } else if (flow.routeAxis === "x") {
    const startSide = flow.routeSign > 0 ? "right" : "left";
    const endSide = flow.routeSign > 0 ? "left" : "right";
    startPort = routePort(from, startSide, portOffset);
    endPort = routePort(to, endSide, -portOffset);
  } else {
    const startSide = flow.routeSign > 0 ? "bottom" : "top";
    const endSide = flow.routeSign > 0 ? "top" : "bottom";
    startPort = routePort(from, startSide, portOffset);
    endPort = routePort(to, endSide, -portOffset);
  }

  const startStub = routeStub(startPort);
  const endStub = routeStub(endPort);
  const gridPath = routeThroughWaypoints(
    startStub,
    endStub,
    waypoints,
    obstacles,
    graphBounds,
    laneMagnitude,
  );
  const fallback = axis === "x"
    ? [startStub, { x: (startStub.x + endStub.x) / 2, y: startStub.y }, { x: (startStub.x + endStub.x) / 2, y: endStub.y }, endStub]
    : [startStub, { x: startStub.x, y: (startStub.y + endStub.y) / 2 }, { x: endStub.x, y: (startStub.y + endStub.y) / 2 }, endStub];
  const points = simplifyOrthogonalPoints([
    startPort.point,
    ...(gridPath ?? fallback),
    endPort.point,
  ]);
  return {
    points,
    startPort,
    endPort,
    backward,
    lane,
    mode: from.id === to.id ? "self-loop" : backward ? "outer" : "orthogonal",
  };
}

function routePointAtHalfLength(points) {
  const segments = [];
  let totalLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    segments.push({ start, end, length });
    totalLength += length;
  }
  let remaining = totalLength / 2;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const ratio = segment.length <= ROUTE_EPSILON ? 0 : remaining / segment.length;
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
      };
    }
    remaining -= segment.length;
  }
  return points.at(-1);
}

function relationMetadata(operation, diagram) {
  return {
    version: "1",
    diagramId: diagram?.diagramId ?? null,
    semanticId: boundedString(operation.semanticId, 160) || boundedString(operation.key, 80) || null,
    type: boundedString(operation.kind, 80, "relation"),
    direction: boundedString(operation.direction, 40, "forward"),
    path: boundedString(operation.path, 40, "primary"),
    payload: boundedString(operation.payload, 300) || null,
    lane: Math.max(-8, Math.min(8, Math.trunc(finiteNumber(operation.lane, 0)))),
    origin: boundedString(operation.origin, 40, "synthesis"),
    sourceShapeIds: boundedStringList(operation.sourceShapeIds, 100),
    sourceIds: boundedStringList(operation.sourceIds, 100),
  };
}

function createRelation(snapshot, operation, references, diagram) {
  const from = resolveElement(snapshot, references, operation.from, "create_relation.from");
  const to = resolveElement(snapshot, references, operation.to, "create_relation.to");
  if (!["rectangle", "diamond", "ellipse", "text"].includes(from.type)) {
    throw new Error(`create_relation.from must reference a bindable Excalidraw element.`);
  }
  if (!["rectangle", "diamond", "ellipse", "text"].includes(to.type)) {
    throw new Error(`create_relation.to must reference a bindable Excalidraw element.`);
  }
  const start = rectangleCenter(from);
  const end = rectangleCenter(to);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const direction = operation.direction ?? "forward";
  const arrow = {
    ...commonElement(snapshot.elements, {
      id: elementId("relation"),
      type: "arrow",
      x: start.x,
      y: start.y,
      width: Math.abs(dx),
      height: Math.abs(dy),
      frameId: from.frameId && from.frameId === to.frameId ? from.frameId : null,
    }),
    strokeColor: strokeColor(operation.color, "idea"),
    backgroundColor: "transparent",
    fillStyle: "hachure",
    strokeStyle: operation.dash === "dashed" || operation.path === "alternative" ? "dashed" : "solid",
    roundness: { type: 2 },
    points: [[0, 0], [dx, dy]],
    lastCommittedPoint: null,
    startBinding: { elementId: from.id, focus: 0, gap: 8 },
    endBinding: { elementId: to.id, focus: 0, gap: 8 },
    startArrowhead: direction === "bidirectional" ? "arrow" : null,
    endArrowhead: direction === "none" ? null : "arrow",
    elbowed: false,
    customData: {
      cowart: {
        version: 1,
        managed: true,
        kind: "relation",
        fromId: from.id,
        toId: to.id,
        semanticDiagram: cloneJson(diagram),
        semanticRelation: relationMetadata(operation, diagram),
        generatedByAgent: true,
      },
    },
  };
  addBoundElement(from, arrow.id, "arrow");
  addBoundElement(to, arrow.id, "arrow");
  snapshot.elements.push(arrow);
  refreshRelationGeometry(snapshot, arrow);
  const labelValue = boundedString(operation.label, 300);
  let label = null;
  if (labelValue) {
    label = createBoundText(snapshot.elements, {
      container: arrow,
      text: labelValue,
      kind: "relation-label",
      fontSize: 16,
    });
    label.frameId = arrow.frameId;
    snapshot.elements.push(label);
    refreshRelationGeometry(snapshot, arrow);
  }
  return { arrow, label };
}

function relationEndpoints(snapshot, relation) {
  const byId = activeById(snapshot);
  const fromId = relation.startBinding?.elementId ?? cowartData(relation)?.fromId ?? null;
  const toId = relation.endBinding?.elementId ?? cowartData(relation)?.toId ?? null;
  return { fromId, toId, from: byId.get(fromId), to: byId.get(toId) };
}

function refreshRelationGeometry(snapshot, relation) {
  if (!relation || relation.type !== "arrow" || relation.isDeleted === true) return;
  const { from, to } = relationEndpoints(snapshot, relation);
  if (!from || !to) return;
  const route = routeForRelation(snapshot, relation, from, to);
  const start = route.points[0];
  const relativePoints = route.points.map((point) => [point.x - start.x, point.y - start.y]);
  const xs = relativePoints.map(([x]) => x);
  const ys = relativePoints.map(([, y]) => y);
  relation.x = start.x;
  relation.y = start.y;
  relation.width = Math.max(...xs) - Math.min(...xs);
  relation.height = Math.max(...ys) - Math.min(...ys);
  relation.points = relativePoints;
  relation.startBinding = {
    elementId: from.id,
    focus: routeBindingFocus(from, route.startPort),
    gap: finiteNumber(relation.startBinding?.gap, 8),
  };
  relation.endBinding = {
    elementId: to.id,
    focus: routeBindingFocus(to, route.endPort),
    gap: finiteNumber(relation.endBinding?.gap, 8),
  };
  relation.frameId = from.frameId && from.frameId === to.frameId ? from.frameId : null;
  const data = cowartData(relation);
  if (data) {
    data.route = {
      version: 1,
      mode: route.mode,
      lane: route.lane,
      orthogonal: true,
    };
  }
  touch(relation);
  const label = boundTextFor(snapshot, relation);
  if (label) {
    const midpoint = routePointAtHalfLength(route.points);
    label.x = midpoint.x - label.width / 2;
    label.y = midpoint.y - label.height / 2;
    label.frameId = relation.frameId;
    touch(label);
  }
}

function syncRelationsForElement(snapshot, elementId) {
  for (const relation of activeElements(snapshot)) {
    if (relation.type !== "arrow") continue;
    const endpoints = relationEndpoints(snapshot, relation);
    if (endpoints.fromId === elementId || endpoints.toId === elementId) {
      refreshRelationGeometry(snapshot, relation);
    }
  }
}

function moveElement(snapshot, element, x, y) {
  const dx = x - element.x;
  const dy = y - element.y;
  element.x = x;
  element.y = y;
  touch(element);
  if (element.type === "frame") {
    for (const child of activeElements(snapshot)) {
      if (child.frameId !== element.id) continue;
      child.x += dx;
      child.y += dy;
      touch(child);
    }
    for (const relation of activeElements(snapshot)) {
      if (relation.type === "arrow" && relation.frameId === element.id) refreshRelationGeometry(snapshot, relation);
    }
    return;
  }
  const text = boundTextFor(snapshot, element);
  if (text) syncBoundTextPosition(element, text);
  syncRelationsForElement(snapshot, element.id);
}

function resizeElement(snapshot, element, width, height) {
  element.width = Math.max(16, Math.min(8_192, width));
  element.height = Math.max(16, Math.min(8_192, height));
  touch(element);
  const text = boundTextFor(snapshot, element);
  if (text) syncBoundTextPosition(element, text);
  syncRelationsForElement(snapshot, element.id);
}

function elementBounds(element) {
  return {
    x: finiteNumber(element?.x, 0),
    y: finiteNumber(element?.y, 0),
    w: Math.max(1, finiteNumber(element?.width, 1)),
    h: Math.max(1, finiteNumber(element?.height, 1)),
  };
}

function overlap(first, second, padding = 0) {
  return !(
    first.x + first.w + padding <= second.x ||
    second.x + second.w + padding <= first.x ||
    first.y + first.h + padding <= second.y ||
    second.y + second.h + padding <= first.y
  );
}

function layoutCreatedCards(snapshot, createdCards, createdRelations, diagram) {
  if (createdCards.length === 0) return null;
  const groups = new Map();
  for (const card of createdCards) {
    const key = card.rectangle.frameId ?? "__scene__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  const reports = [];
  for (const [frameId, cards] of groups) {
    const requiresLayout = Boolean(diagram) || cards.some((card) => card.autoLayout);
    if (!requiresLayout) continue;
    const frame = frameId === "__scene__"
      ? null
      : snapshot.elements.find((element) => element.id === frameId && element.isDeleted !== true);
    const outside = activeElements(snapshot).filter((element) =>
      !["text", "arrow", "frame"].includes(element.type) &&
      !cards.some((card) => card.rectangle.id === element.id) &&
      (frame ? element.frameId === frame.id : !element.frameId),
    );
    const maxOutsideY = outside.reduce(
      (maximum, element) => Math.max(maximum, element.y + element.height),
      24,
    );
    const frameContentTop = frame
      ? Math.max(frame.y + 64, maxOutsideY + (outside.length > 0 ? 48 : 0))
      : null;
    const targetRect = frame
      ? {
          x: frame.x + 40,
          y: frameContentTop,
          w: Math.max(160, frame.width - 80),
          h: Math.max(1, frame.y + frame.height - 40 - frameContentTop),
        }
      : {
          x: 80,
          y: maxOutsideY + 64,
          w: Math.max(1_200, Math.min(3_200, cards.length * 380)),
          h: Math.max(640, Math.ceil(cards.length / 3) * 260),
        };
    const nodeIds = new Set(cards.map((card) => card.rectangle.id));
    const nodes = cards.map((card) => ({
      id: card.rectangle.id,
      w: card.rectangle.width,
      h: card.rectangle.height,
    }));
    const edges = createdRelations
      .map(({ arrow }) => {
        const { fromId, toId } = relationEndpoints(snapshot, arrow);
        return { from: fromId, to: toId };
      })
      .filter(({ from, to }) => nodeIds.has(from) && nodeIds.has(to));
    const report = layoutSemanticGraph({
      nodes,
      edges,
      targetRect,
      readingOrder: diagram?.readingOrder ?? "left-to-right",
      horizontalGap: diagram?.layoutMode === "compact" ? 48 : 72,
      verticalGap: diagram?.layoutMode === "compact" ? 72 : 104,
    });
    if (!report.valid) {
      throw new Error(
        `SEMANTIC_GEOMETRY: html-line-svg could not place ${cards.length} card(s) without overlap.`,
      );
    }
    for (const card of cards) {
      const position = report.positions.get(card.rectangle.id);
      moveElement(snapshot, card.rectangle, position.x, position.y);
    }
    reports.push({ ...report, frameId: frame?.id ?? null });
  }
  for (const { arrow } of createdRelations) refreshRelationGeometry(snapshot, arrow);
  if (!diagram) return null;

  const cards = createdCards.map(({ rectangle }) => rectangle);
  const collisions = [];
  for (let index = 0; index < cards.length; index += 1) {
    for (let other = index + 1; other < cards.length; other += 1) {
      if (overlap(elementBounds(cards[index]), elementBounds(cards[other]))) {
        collisions.push({ a: cards[index].id, b: cards[other].id });
      }
    }
  }
  const digestInput = cards
    .map((card) => {
      const data = cowartData(card);
      const stableId = data?.semanticObject?.semanticId ?? data?.key ?? card.id;
      return `${stableId}:${card.x}:${card.y}:${card.width}:${card.height}`;
    })
    .sort()
    .join("|");
  return {
    engine: "html-line-svg",
    valid: reports.every((report) => report.valid) && collisions.length === 0,
    collisions,
    outOfBounds: reports.flatMap((report) => report.outOfBounds ?? []),
    layoutErrors: [],
    layoutDigest: createHash("sha256").update(digestInput).digest("hex").slice(0, 20),
    diagramId: diagram.diagramId,
  };
}

function updateCard(snapshot, operation, references, diagram) {
  const card = resolveElement(snapshot, references, operation.id, "update_card.id");
  if (!isManaged(card, "card")) throw new Error(`update_card can only modify Cowart-managed cards.`);
  const data = cowartData(card);
  const textElement = boundTextFor(snapshot, card);
  const visible = splitCardText(textElement?.originalText ?? textElement?.text ?? cardText(data.title, data.body));
  const title = operation.title === undefined ? visible.title : boundedString(operation.title, 300);
  const body = operation.body === undefined ? visible.body : boundedString(operation.body, 12_000);
  Object.assign(data, {
    role: operation.role === undefined ? data.role : boundedString(operation.role, 40, data.role),
    title,
    body,
    sourceRefs: operation.sourceRefs === undefined ? data.sourceRefs : boundedStringList(operation.sourceRefs, 50, 500),
    source: operation.source === undefined ? data.source : cloneJson(operation.source),
    bridge: operation.bridge === undefined ? data.bridge : cloneJson(operation.bridge),
    semanticObject: patchSemanticObject(data.semanticObject, operation.semantic, diagram, "update_card"),
    url: operation.url === undefined ? data.url : boundedString(operation.url, 2_000) || null,
  });
  if (operation.url !== undefined) card.link = data.url;
  if (textElement && (operation.title !== undefined || operation.body !== undefined)) {
    const nextText = cardText(title, body) || " ";
    const metrics = estimateTextMetrics(nextText, textElement.fontSize, Math.max(40, card.width - 32));
    textElement.text = metrics.wrappedText;
    textElement.originalText = nextText;
    textElement.width = metrics.width;
    textElement.height = metrics.height;
    syncBoundTextPosition(card, textElement);
    touch(textElement);
  }
  touch(card);
  return card;
}

function updateZone(snapshot, operation, references, diagram) {
  const zone = resolveElement(snapshot, references, operation.id, "update_zone.id");
  if (!isManaged(zone, "zone")) throw new Error(`update_zone can only modify Cowart-managed frames.`);
  const data = cowartData(zone);
  if (operation.title !== undefined) {
    zone.name = boundedString(operation.title, 300, zone.name);
    data.title = zone.name;
  } else {
    data.title = boundedString(zone.name, 300, data.title);
  }
  if (operation.body !== undefined) data.body = boundedString(operation.body, 12_000);
  if (operation.sourceRefs !== undefined) data.sourceRefs = boundedStringList(operation.sourceRefs, 50, 500);
  if (operation.bridge !== undefined) data.bridge = cloneJson(operation.bridge);
  data.semanticObject = patchSemanticObject(data.semanticObject, operation.semantic, diagram, "update_zone");
  if ([operation.x, operation.y, operation.w, operation.h].some(Number.isFinite)) {
    throw new Error("update_zone preserves frame geometry; use move_shape and resize_shape explicitly.");
  }
  touch(zone);
  return zone;
}

function updateRelation(snapshot, operation, references, diagram) {
  const relation = resolveElement(snapshot, references, operation.id, "update_relation.id");
  if (!isManaged(relation, "relation") || relation.type !== "arrow") {
    throw new Error(`update_relation can only modify Cowart-managed arrows.`);
  }
  const data = cowartData(relation);
  const semantic = data.semanticRelation ?? relationMetadata({}, data.semanticDiagram ?? diagram);
  if (diagram && semantic.diagramId && semantic.diagramId !== diagram.diagramId) {
    throw new Error(`update_relation must stay in diagram ${semantic.diagramId}.`);
  }
  const patchMap = {
    kind: "type",
    direction: "direction",
    path: "path",
    payload: "payload",
    origin: "origin",
    sourceShapeIds: "sourceShapeIds",
    sourceIds: "sourceIds",
  };
  let routeChanged = false;
  for (const [sourceField, targetField] of Object.entries(patchMap)) {
    if (operation[sourceField] === undefined) continue;
    if (["sourceShapeIds", "sourceIds"].includes(sourceField)) {
      semantic[targetField] = boundedStringList(operation[sourceField], 100);
    } else if (operation[sourceField] === null) {
      semantic[targetField] = null;
    } else {
      semantic[targetField] = boundedString(operation[sourceField], sourceField === "payload" ? 300 : 80);
    }
    if (["direction", "path"].includes(sourceField)) routeChanged = true;
  }
  if (operation.lane !== undefined) {
    semantic.lane = Math.max(-8, Math.min(8, Math.trunc(finiteNumber(operation.lane, semantic.lane ?? 0))));
    routeChanged = true;
  }
  data.semanticRelation = semantic;

  if (operation.direction !== undefined) {
    relation.startArrowhead = semantic.direction === "bidirectional" ? "arrow" : null;
    relation.endArrowhead = semantic.direction === "none" ? null : "arrow";
  }

  if (operation.label !== undefined) {
    let label = boundTextFor(snapshot, relation);
    if (operation.label === null || boundedString(operation.label, 300) === "") {
      if (label) {
        label.isDeleted = true;
        touch(label);
        removeBoundElement(relation, label.id);
      }
    } else if (label) {
      const value = boundedString(operation.label, 300);
      label.text = value;
      label.originalText = value;
      touch(label);
    } else {
      label = createBoundText(snapshot.elements, {
        container: relation,
        text: boundedString(operation.label, 300),
        kind: "relation-label",
        fontSize: 16,
      });
      snapshot.elements.push(label);
      refreshRelationGeometry(snapshot, relation);
    }
  }
  if (routeChanged) refreshRelationGeometry(snapshot, relation);
  touch(relation);
  return relation;
}

function deleteManaged(snapshot, operation, references) {
  const target = resolveElement(snapshot, references, operation.id, "delete_shape.id");
  if (!isManaged(target)) throw new Error(`delete_shape can only delete Cowart-managed Excalidraw elements.`);
  const deletionIds = new Set([target.id]);
  if (target.type === "frame") {
    for (const element of activeElements(snapshot)) {
      if (element.frameId === target.id && isManaged(element)) deletionIds.add(element.id);
    }
  }
  if (target.type !== "arrow") {
    for (const relation of activeElements(snapshot)) {
      if (!isManaged(relation, "relation")) continue;
      const { fromId, toId } = relationEndpoints(snapshot, relation);
      if (deletionIds.has(fromId) || deletionIds.has(toId)) deletionIds.add(relation.id);
    }
  }
  for (const element of activeElements(snapshot)) {
    if (element.type === "text" && element.containerId && deletionIds.has(element.containerId)) {
      deletionIds.add(element.id);
    }
  }
  for (const id of deletionIds) {
    const element = snapshot.elements.find((candidate) => candidate.id === id);
    if (!element) continue;
    if (element.type === "arrow") {
      const { from, to } = relationEndpoints(snapshot, element);
      removeBoundElement(from, element.id);
      removeBoundElement(to, element.id);
    }
    element.isDeleted = true;
    touch(element);
  }
  return Array.from(deletionIds);
}

function validateOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("operations must contain at least one thinking operation.");
  }
  const supported = new Set([
    "create_card",
    "update_card",
    "create_zone",
    "update_zone",
    "move_shape",
    "resize_shape",
    "create_relation",
    "update_relation",
    "delete_shape",
  ]);
  for (const operation of operations) {
    if (!supported.has(operation?.type)) throw new Error(`Unsupported thinking operation '${operation?.type}'.`);
  }
  const creationKeys = new Set();
  for (const operation of operations) {
    if (!["create_card", "create_zone", "create_relation"].includes(operation.type)) continue;
    const key = boundedString(operation.key, 80);
    if (!key) continue;
    if (creationKeys.has(key)) throw new Error(`Duplicate creation key '${key}' in one operation batch.`);
    creationKeys.add(key);
  }
}

export function applyExcalidrawThinkingOperationsToSnapshot({
  snapshot,
  operations,
  semanticDiagram: requestedSemanticDiagram = null,
  allowUserAuthoredEdits = false,
} = {}) {
  validateOperations(operations);
  const nextSnapshot = ensureExcalidrawSnapshot(snapshot);
  const diagram = normalizeSemanticDiagram(requestedSemanticDiagram, operations);
  const references = new Map();
  const changes = [];
  const createdCards = [];
  const createdRelations = [];

  for (const operation of operations) {
    if (operation.type === "create_zone") {
      const zone = createZone(nextSnapshot, operation, diagram);
      references.set(operation.key, zone.id);
      changes.push({ type: operation.type, id: zone.id, key: operation.key });
      continue;
    }
    if (operation.type === "create_card") {
      const card = createCard(nextSnapshot, operation, references, diagram);
      if (operation.key) references.set(operation.key, card.rectangle.id);
      createdCards.push({ ...card, operation });
      changes.push({ type: operation.type, id: card.rectangle.id, key: operation.key ?? null });
      continue;
    }
    if (operation.type === "create_relation") {
      const relation = createRelation(nextSnapshot, operation, references, diagram);
      if (operation.key) references.set(operation.key, relation.arrow.id);
      createdRelations.push(relation);
      changes.push({ type: operation.type, id: relation.arrow.id, key: operation.key ?? null });
      continue;
    }
    if (operation.type === "update_card") {
      const card = updateCard(nextSnapshot, operation, references, diagram);
      changes.push({ type: operation.type, id: card.id });
      continue;
    }
    if (operation.type === "update_zone") {
      const zone = updateZone(nextSnapshot, operation, references, diagram);
      changes.push({ type: operation.type, id: zone.id });
      continue;
    }
    if (operation.type === "move_shape") {
      const element = resolveElement(nextSnapshot, references, operation.id, "move_shape.id");
      assertManagedOrExplicit(element, allowUserAuthoredEdits, "move");
      moveElement(nextSnapshot, element, finiteNumber(operation.x, element.x), finiteNumber(operation.y, element.y));
      changes.push({ type: operation.type, id: element.id, x: element.x, y: element.y });
      continue;
    }
    if (operation.type === "resize_shape") {
      const element = resolveElement(nextSnapshot, references, operation.id, "resize_shape.id");
      assertManagedOrExplicit(element, allowUserAuthoredEdits, "resize");
      resizeElement(nextSnapshot, element, finiteNumber(operation.w, element.width), finiteNumber(operation.h, element.height));
      changes.push({ type: operation.type, id: element.id, w: element.width, h: element.height });
      continue;
    }
    if (operation.type === "update_relation") {
      const relation = updateRelation(nextSnapshot, operation, references, diagram);
      changes.push({ type: operation.type, id: relation.id });
      continue;
    }
    if (operation.type === "delete_shape") {
      const deletedIds = deleteManaged(nextSnapshot, operation, references);
      changes.push({ type: operation.type, id: references.get(operation.id) ?? operation.id, deletedIds });
    }
  }

  const layoutReport = layoutCreatedCards(nextSnapshot, createdCards, createdRelations, diagram);
  const routeAffectingTypes = new Set(["create_card", "create_relation", "move_shape", "resize_shape", "delete_shape"]);
  const routeAffectingChanges = changes.filter((change, index) =>
    routeAffectingTypes.has(change.type) ||
    (change.type === "update_relation" &&
      [operations[index]?.direction, operations[index]?.path, operations[index]?.lane]
        .some((value) => value !== undefined)),
  );
  const rerouteScopes = new Set(routeAffectingChanges.flatMap((change) => {
    const element = nextSnapshot.elements.find((candidate) => candidate.id === change.id);
    return element ? [routeScopeKey(element)] : [];
  }));
  if (rerouteScopes.size > 0) {
    for (const relation of activeElements(nextSnapshot)) {
      if (
        relation.type === "arrow" &&
        isManaged(relation, "relation") &&
        rerouteScopes.has(routeScopeKey(relation))
      ) {
        refreshRelationGeometry(nextSnapshot, relation);
      }
    }
  }
  return {
    snapshot: nextSnapshot,
    pageId: SCENE_PAGE_ID,
    changes,
    references: Object.fromEntries(references),
    semanticDiagram: diagram,
    layoutReport,
    revision: cowartSnapshotRevision(nextSnapshot),
  };
}

function contextForElement(snapshot, element, selected, maxTextLength) {
  const data = cowartData(element);
  const textElement = element.type === "rectangle" || element.type === "arrow"
    ? boundTextFor(snapshot, element)
    : null;
  const visibleText = element.type === "text"
    ? element.text
    : element.type === "frame"
      ? element.name
      : textElement?.text ?? "";
  const textParts = splitCardText(visibleText);
  const relation = element.type === "arrow" ? relationEndpoints(snapshot, element) : null;
  const parentZone = element.frameId
    ? snapshot.elements.find((candidate) => candidate.id === element.frameId && candidate.isDeleted !== true)
    : null;
  const semantic = data?.semanticDiagram
    ? {
        diagramId: boundedString(data.semanticDiagram.diagramId, 160) || null,
        teachingClaim: boundedString(data.semanticDiagram.teachingClaim, 500) || null,
        readingOrder: boundedString(data.semanticDiagram.readingOrder, 40) || null,
        diagramType: boundedString(data.semanticDiagram.diagramType, 40) || null,
        layoutEngine: data.semanticDiagram.layoutEngine === "html-line-svg" ? "html-line-svg" : null,
        layoutMode: boundedString(data.semanticDiagram.layoutMode, 40) || null,
        layoutFit: boundedString(data.semanticDiagram.layoutFit, 40) || null,
        sourceShapeIds: boundedStringList(data.semanticDiagram.sourceShapeIds, 250),
        sourceIds: boundedStringList(data.semanticDiagram.sourceIds, 100),
        objectCount: Math.max(0, Math.trunc(finiteNumber(data.semanticDiagram.objectCount, 0))),
        relationCount: Math.max(0, Math.trunc(finiteNumber(data.semanticDiagram.relationCount, 0))),
        specDigest: boundedString(data.semanticDiagram.specDigest, 128) || null,
        object: cloneJson(data.semanticObject ?? null),
        relation: cloneJson(data.semanticRelation ?? null),
      }
    : null;
  return {
    id: element.id,
    type: element.type,
    role: data?.kind === "zone" ? "zone" : data?.role ?? (data?.kind === "relation" ? "relation" : null),
    selected,
    bounds: elementBounds(element),
    text: boundedString(data?.kind === "card" ? textParts.body : visibleText, maxTextLength) || null,
    title: data?.kind === "card" ? textParts.title : boundedString(element.name, 300) || null,
    key: boundedString(data?.key, 80) || null,
    zone: data?.kind === "zone"
      ? {
          key: boundedString(data.key, 80) || null,
          purpose: boundedString(data.purpose, 40, "thinking"),
        }
      : null,
    parentZone: isManaged(parentZone, "zone")
      ? {
          id: parentZone.id,
          key: boundedString(cowartData(parentZone)?.key, 80) || null,
          purpose: boundedString(cowartData(parentZone)?.purpose, 40, "thinking"),
        }
      : null,
    style: {
      strokeColor: element.strokeColor ?? null,
      backgroundColor: element.backgroundColor ?? null,
      fillStyle: element.fillStyle ?? null,
      strokeStyle: element.strokeStyle ?? null,
      strokeWidth: element.strokeWidth ?? null,
      roughness: element.roughness ?? null,
      opacity: element.opacity ?? null,
      fontFamily: textElement?.fontFamily ?? element.fontFamily ?? null,
      fontSize: textElement?.fontSize ?? element.fontSize ?? null,
    },
    sourceRefs: data?.sourceRefs ?? [],
    source: data?.source ?? null,
    bridge: data?.bridge ?? null,
    semantic,
    relation: relation
      ? {
          fromId: relation.fromId,
          toId: relation.toId,
          kind: data?.semanticRelation?.type ?? "relates-to",
          direction: data?.semanticRelation?.direction ?? "forward",
          path: data?.semanticRelation?.path ?? "primary",
          payload: data?.semanticRelation?.payload ?? null,
          lane: Math.trunc(finiteNumber(data?.semanticRelation?.lane, 0)),
          valid: Boolean(relation.from && relation.to),
          unsafe: false,
          invalidReason: relation.from && relation.to ? null : "The arrow is missing one or both bound endpoints.",
          label: textElement?.text ?? null,
        }
      : null,
    generatedByAgent: data?.generatedByAgent === true,
  };
}

export function summarizeExcalidrawThinkingContext({
  snapshot,
  selection = { selectedShapes: [] },
  scope = "page",
  shapeIds,
  maxShapes = MAX_CONTEXT_SHAPES,
  maxTextLength = MAX_CONTEXT_TEXT,
} = {}) {
  const scene = ensureExcalidrawSnapshot(snapshot);
  const selectedIds = new Set(
    scope === "selection" && Array.isArray(shapeIds)
      ? boundedStringList(shapeIds, MAX_CONTEXT_SHAPES, 160)
      : boundedStringList(selection?.selectedShapes, MAX_CONTEXT_SHAPES, 160),
  );
  const primary = activeElements(scene).filter((element) => {
    const data = cowartData(element);
    if (data?.kind === "card-label" || data?.kind === "relation-label") return false;
    if (element.type === "text" && element.containerId) return false;
    return true;
  });
  const relatedRelationIds = new Set();
  if (scope === "selection" && selectedIds.size > 0) {
    for (const element of primary) {
      if (element.type !== "arrow") continue;
      const endpoints = relationEndpoints(scene, element);
      if (selectedIds.has(endpoints.fromId) || selectedIds.has(endpoints.toId)) {
        relatedRelationIds.add(element.id);
      }
    }
  }
  const filtered = scope === "selection" && selectedIds.size > 0
    ? primary.filter((element) => selectedIds.has(element.id) || relatedRelationIds.has(element.id))
    : primary;
  const limited = filtered.slice(0, Math.max(1, Math.min(MAX_CONTEXT_SHAPES, maxShapes)));
  return {
    version: 1,
    runtime: "excalidraw",
    revision: cowartSnapshotRevision(scene),
    pageId: SCENE_PAGE_ID,
    scope: scope === "selection" && selectedIds.size > 0 ? "selection" : "page",
    selection: Array.from(selectedIds),
    shapes: limited.map((element) =>
      contextForElement(scene, element, selectedIds.has(element.id), Math.max(200, Math.min(MAX_CONTEXT_TEXT, maxTextLength))),
    ),
    truncated: filtered.length > limited.length,
    omittedShapeCount: Math.max(0, filtered.length - limited.length),
  };
}

function historyDirectory(args) {
  return join(resolveCanvasDir(args), "thinking-history");
}

function historyFile(args, operationId) {
  return join(historyDirectory(args), `${operationId}.json`);
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
      .filter((entry) => entry.isFile() && entry.name.startsWith("excalidraw-") && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const fileName of files.slice(HISTORY_LIMIT)) await rm(join(directory, fileName), { force: true });
}

export async function getThinkingContext(args = {}, options = {}) {
  const state = await readCowartCanvasState(args, { hydrateAssets: false });
  if (state.snapshot && state.snapshot.type !== "excalidraw") {
    throw new Error("Expected an Excalidraw canvas document.");
  }
  const currentSnapshot = ensureExcalidrawSnapshot(state.snapshot);
  const frozen = options.scope === "selection" && Array.isArray(options.shapeIds);
  const selectionState = frozen ? { selection: { selectedShapes: [] } } : await readCowartSelectionState(args);
  return {
    ...summarizeExcalidrawThinkingContext({
      snapshot: currentSnapshot,
      selection: selectionState.selection,
      scope: options.scope,
      shapeIds: options.shapeIds,
      maxShapes: options.maxShapes,
      maxTextLength: options.maxTextLength,
    }),
    projectDir: state.projectDir,
    canvasDir: state.canvasDir,
  };
}

export async function applyThinkingOperations(args = {}, options = {}) {
  const state = await readCowartCanvasState(args, { hydrateAssets: false });
  if (state.snapshot && state.snapshot.type !== "excalidraw") {
    throw new Error("Expected an Excalidraw canvas document.");
  }
  const currentSnapshot = ensureExcalidrawSnapshot(state.snapshot);
  const currentRevision = cowartSnapshotRevision(currentSnapshot);
  if (options.baseRevision && options.baseRevision !== currentRevision) {
    throw new Error(`Canvas revision changed from ${options.baseRevision} to ${currentRevision}; inspect again before applying.`);
  }
  const result = applyExcalidrawThinkingOperationsToSnapshot({
    snapshot: currentSnapshot,
    operations: options.operations,
    semanticDiagram: options.semanticDiagram,
    allowUserAuthoredEdits: options.allowUserAuthoredEdits === true,
  });
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
      layoutReport: result.layoutReport,
    };
  }

  const operationId = `excalidraw-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  const history = {
    version: HISTORY_VERSION,
    runtime: "excalidraw",
    operationId,
    createdAt: new Date().toISOString(),
    reason: boundedString(options.reason, 2_000, "Excalidraw thinking edit"),
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
    saveResult = await saveCowartCanvasSnapshot({ ...args, baseRevision: state.revision }, result.snapshot);
    if (!saveResult.ok) throw new Error(saveResult.message || "Yogurt AI refused to persist the Excalidraw operation batch.");
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
    layoutReport: result.layoutReport,
    explanation: history.explanation,
    storage: saveResult.storage,
  };
}

async function readHistoryEntries(args) {
  const directory = historyDirectory(args);
  let entries;
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith("excalidraw-") && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const histories = [];
  for (const name of entries) {
    try {
      const filePath = join(directory, name);
      const value = JSON.parse(await readFile(filePath, "utf8"));
      if (value?.runtime === "excalidraw") histories.push({ filePath, value });
    } catch (_error) {
      // Malformed history is ignored because it cannot be safely restored.
    }
  }
  return histories;
}

export async function undoThinkingOperation(args = {}, options = {}) {
  const histories = await readHistoryEntries(args);
  const candidate = histories.find(({ value }) =>
    !value.undoneAt && (!options.operationId || value.operationId === options.operationId),
  );
  if (!candidate) {
    throw new Error(options.operationId
      ? `Unknown or already undone operation ${options.operationId}.`
      : "No Excalidraw thinking operation is available to undo.");
  }
  const state = await readCowartCanvasState(args, { hydrateAssets: false });
  const currentRevision = cowartSnapshotRevision(state.snapshot);
  if (currentRevision !== candidate.value.resultRevision) {
    throw new Error(
      `Refusing stale undo: canvas revision is ${currentRevision}, but operation ${candidate.value.operationId} produced ${candidate.value.resultRevision}.`,
    );
  }
  const beforeSnapshot = ensureExcalidrawSnapshot(candidate.value.beforeSnapshot);
  const saveResult = await saveCowartCanvasSnapshot({ ...args, baseRevision: state.revision }, beforeSnapshot);
  if (!saveResult.ok) throw new Error(saveResult.message || "Yogurt AI refused to persist the Excalidraw undo snapshot.");
  const updatedHistory = {
    ...candidate.value,
    undoneAt: new Date().toISOString(),
    undoRevision: cowartSnapshotRevision(beforeSnapshot),
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

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return Boolean(pathToChild) && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function sanitizedMaterialName(fileName) {
  const extension = extname(fileName).slice(0, 16);
  const stem = basename(fileName, extension)
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120) || "material";
  return `${stem}${extension}`;
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
  const source = compactObject({
    kind: boundedString(options.kind, 32, extname(sourcePath).slice(1).toLowerCase() || "file"),
    fileName: boundedString(options.fileName, 240, basename(sourcePath)),
    originalPath: sourcePath,
    localPath,
    excerpt: boundedString(options.excerpt, 3_000),
    fileSize: sourceStat.size,
  });
  try {
    const result = await applyThinkingOperations(args, {
      baseRevision: options.baseRevision,
      dryRun: options.dryRun,
      reason: options.reason || `Import material ${source.fileName}`,
      explanation: options.explanation || "Attached source material as a provenance-preserving Excalidraw card.",
      operations: [{
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
      }],
    });
    return { ...result, source, copied: options.dryRun === true ? false : copied };
  } catch (error) {
    if (copied && isSafeChildPath(canvasDir, localPath)) await rm(localPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
