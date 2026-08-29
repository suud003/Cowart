import { createHash } from "node:crypto";

const PAGE_WIDTH = 1600;
const PAGE_HEIGHT = 1000;
const MIN_SLOTS = 2;
const MAX_SLOTS = 12;
const MAX_VISUAL_SLOTS = 6;
const MIN_SPACING = 24;

const ROUTES = new Set(["visual", "diagram", "evidence"]);
const FITS = {
  visual: new Set(["cover", "contain"]),
  diagram: new Set(["native"]),
  evidence: new Set(["native"]),
};
const DIAGRAM_TYPES = new Set([
  "flow",
  "state",
  "hierarchy",
  "architecture",
  "comparison",
  "concept",
  "custom",
]);
const READING_ORDERS = new Set([
  "left-to-right",
  "right-to-left",
  "top-to-bottom",
  "bottom-to-top",
  "center-out",
  "board-to-peers",
]);
const DIRECTIONS = new Set(["forward", "bidirectional", "none"]);
const PATHS = new Set(["primary", "alternative"]);
const EVIDENCE_ROLES = new Set([
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
const BLOCK_ID_PATTERN = /^block:[0-9a-f]{12}$/u;
const SLOT_ID_PATTERN = /^slot:[0-9a-f]{12}$/u;

function fail(path, message) {
  throw new TypeError(`${path} ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, path, allowedKeys) {
  if (!isPlainObject(value)) fail(path, "must be a plain object.");
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key}`, "is not supported.");
  }
  return value;
}

function normalizeUnicode(value) {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n");
}

function requireString(value, path, { min = 1, max, identifier = false } = {}) {
  if (typeof value !== "string") fail(path, "must be a string.");
  const normalized = normalizeUnicode(value);
  const length = [...normalized].length;
  if (length < min) fail(path, `must contain at least ${min} character(s).`);
  if (max !== undefined && length > max) fail(path, `cannot exceed ${max} characters.`);
  if (identifier && normalized.trim() !== normalized) {
    fail(path, "cannot contain leading or trailing whitespace.");
  }
  return normalized;
}

function requireInteger(value, path, { min, max } = {}) {
  if (!Number.isInteger(value)) fail(path, "must be an integer.");
  if (min !== undefined && value < min) fail(path, `must be at least ${min}.`);
  if (max !== undefined && value > max) fail(path, `cannot exceed ${max}.`);
  return value;
}

function optionalString(value, path, options) {
  return value === undefined ? undefined : requireString(value, path, options);
}

function normalizeUniqueStrings(value, path, { maxItems, maxLength }) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(path, "must be an array.");
  if (value.length > maxItems) fail(path, `cannot contain more than ${maxItems} items.`);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = requireString(value[index], `${path}[${index}]`, {
      max: maxLength,
      identifier: true,
    });
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function normalizeVisualSpec(value, path) {
  if (!isPlainObject(value)) fail(path, "must be a plain object.");
  if (value.type !== "visual") fail(`${path}.type`, 'must be "visual" for a visual slot.');
  const spec = requireObject(value, path, new Set([
    "type",
    "brief",
    "focalPoint",
    "styleSourceIds",
  ]));
  const focalPoint = optionalString(spec.focalPoint, `${path}.focalPoint`, { max: 200 });
  const styleSourceIds = normalizeUniqueStrings(spec.styleSourceIds, `${path}.styleSourceIds`, {
    maxItems: 8,
    maxLength: 160,
  });
  return {
    type: "visual",
    brief: requireString(spec.brief, `${path}.brief`, { max: 800 }),
    ...(focalPoint !== undefined ? { focalPoint } : {}),
    ...(styleSourceIds !== undefined ? { styleSourceIds } : {}),
  };
}

function normalizeDiagramObject(value, path) {
  const object = requireObject(value, path, new Set([
    "id",
    "label",
    "type",
    "state",
    "sourceShapeIds",
    "sourceIds",
  ]));
  const type = optionalString(object.type, `${path}.type`, { max: 80, identifier: true });
  const state = optionalString(object.state, `${path}.state`, { max: 80, identifier: true });
  const sourceShapeIds = normalizeUniqueStrings(object.sourceShapeIds, `${path}.sourceShapeIds`, {
    maxItems: 100,
    maxLength: 160,
  });
  const sourceIds = normalizeUniqueStrings(object.sourceIds, `${path}.sourceIds`, {
    maxItems: 100,
    maxLength: 160,
  });
  return {
    id: requireString(object.id, `${path}.id`, { max: 80, identifier: true }),
    label: requireString(object.label, `${path}.label`, { max: 160 }),
    ...(type !== undefined ? { type } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(sourceShapeIds !== undefined ? { sourceShapeIds } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
  };
}

function normalizeDiagramRelation(value, path, objectIds) {
  const relation = requireObject(value, path, new Set([
    "id",
    "from",
    "to",
    "label",
    "direction",
    "path",
    "sourceShapeIds",
    "sourceIds",
  ]));
  const id = requireString(relation.id, `${path}.id`, { max: 80, identifier: true });
  const from = requireString(relation.from, `${path}.from`, { max: 80, identifier: true });
  const to = requireString(relation.to, `${path}.to`, { max: 80, identifier: true });
  if (!objectIds.has(from)) fail(`${path}.from`, `references unknown object ${from}.`);
  if (!objectIds.has(to)) fail(`${path}.to`, `references unknown object ${to}.`);
  const direction = relation.direction ?? "forward";
  const relationPath = relation.path ?? "primary";
  if (!DIRECTIONS.has(direction)) fail(`${path}.direction`, "is not supported.");
  if (!PATHS.has(relationPath)) fail(`${path}.path`, "is not supported.");
  const label = optionalString(relation.label, `${path}.label`, { max: 160 });
  const sourceShapeIds = normalizeUniqueStrings(relation.sourceShapeIds, `${path}.sourceShapeIds`, {
    maxItems: 100,
    maxLength: 160,
  });
  const sourceIds = normalizeUniqueStrings(relation.sourceIds, `${path}.sourceIds`, {
    maxItems: 100,
    maxLength: 160,
  });
  return {
    id,
    from,
    to,
    ...(label !== undefined ? { label } : {}),
    direction,
    path: relationPath,
    ...(sourceShapeIds !== undefined ? { sourceShapeIds } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
  };
}

function normalizeDiagramSpec(value, path) {
  if (!isPlainObject(value)) fail(path, "must be a plain object.");
  if (value.type !== "diagram") fail(`${path}.type`, 'must be "diagram" for a diagram slot.');
  const spec = requireObject(value, path, new Set([
    "type",
    "diagramType",
    "teachingClaim",
    "readingOrder",
    "objects",
    "relations",
  ]));
  if (!DIAGRAM_TYPES.has(spec.diagramType)) fail(`${path}.diagramType`, "is not supported.");
  if (!READING_ORDERS.has(spec.readingOrder)) fail(`${path}.readingOrder`, "is not supported.");
  if (!Array.isArray(spec.objects)) fail(`${path}.objects`, "must be an array.");
  if (spec.objects.length < 1 || spec.objects.length > 8) {
    fail(`${path}.objects`, "must contain between 1 and 8 objects.");
  }
  const objects = spec.objects.map((item, index) => normalizeDiagramObject(
    item,
    `${path}.objects[${index}]`,
  ));
  const objectIds = new Set();
  for (const object of objects) {
    if (objectIds.has(object.id)) fail(`${path}.objects`, `contains duplicate id ${object.id}.`);
    objectIds.add(object.id);
  }
  if (!Array.isArray(spec.relations)) fail(`${path}.relations`, "must be an array.");
  if (spec.relations.length > 10) fail(`${path}.relations`, "cannot contain more than 10 relations.");
  const relations = spec.relations.map((item, index) => normalizeDiagramRelation(
    item,
    `${path}.relations[${index}]`,
    objectIds,
  ));
  const relationIds = new Set();
  for (const relation of relations) {
    if (relationIds.has(relation.id)) fail(`${path}.relations`, `contains duplicate id ${relation.id}.`);
    relationIds.add(relation.id);
  }
  return {
    type: "diagram",
    diagramType: spec.diagramType,
    teachingClaim: requireString(spec.teachingClaim, `${path}.teachingClaim`, { max: 500 }),
    readingOrder: spec.readingOrder,
    objects,
    relations,
  };
}

function normalizeEvidenceCard(value, path) {
  const card = requireObject(value, path, new Set([
    "id",
    "role",
    "title",
    "body",
    "sourceShapeIds",
    "sourceRefs",
  ]));
  const id = requireString(card.id, `${path}.id`, { max: 80, identifier: true });
  const role = card.role ?? "evidence";
  if (!EVIDENCE_ROLES.has(role)) fail(`${path}.role`, "is not supported.");
  const title = optionalString(card.title, `${path}.title`, { min: 0, max: 300 });
  const body = optionalString(card.body, `${path}.body`, { min: 0, max: 280 });
  if (!(title?.trim() || body?.trim())) fail(path, "requires a non-empty title or body.");
  const sourceShapeIds = normalizeUniqueStrings(card.sourceShapeIds, `${path}.sourceShapeIds`, {
    maxItems: 100,
    maxLength: 160,
  });
  const sourceRefs = normalizeUniqueStrings(card.sourceRefs, `${path}.sourceRefs`, {
    maxItems: 50,
    maxLength: 500,
  });
  return {
    id,
    role,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(sourceShapeIds !== undefined ? { sourceShapeIds } : {}),
    ...(sourceRefs !== undefined ? { sourceRefs } : {}),
  };
}

function normalizeEvidenceSpec(value, path) {
  if (!isPlainObject(value)) fail(path, "must be a plain object.");
  if (value.type !== "evidence") fail(`${path}.type`, 'must be "evidence" for an evidence slot.');
  const spec = requireObject(value, path, new Set(["type", "cards"]));
  if (!Array.isArray(spec.cards)) fail(`${path}.cards`, "must be an array.");
  if (spec.cards.length < 1 || spec.cards.length > 4) {
    fail(`${path}.cards`, "must contain between 1 and 4 cards.");
  }
  const cards = spec.cards.map((item, index) => normalizeEvidenceCard(
    item,
    `${path}.cards[${index}]`,
  ));
  const cardIds = new Set();
  for (const card of cards) {
    if (cardIds.has(card.id)) fail(`${path}.cards`, `contains duplicate id ${card.id}.`);
    cardIds.add(card.id);
  }
  return { type: "evidence", cards };
}

function normalizeContentSpec(value, route, path) {
  if (route === "visual") return normalizeVisualSpec(value, path);
  if (route === "diagram") return normalizeDiagramSpec(value, path);
  return normalizeEvidenceSpec(value, path);
}

function normalizeRect(value, path, padding) {
  const rect = requireObject(value, path, new Set(["x", "y", "w", "h"]));
  const x = requireInteger(rect.x, `${path}.x`, { min: 0, max: PAGE_WIDTH });
  const y = requireInteger(rect.y, `${path}.y`, { min: 0, max: PAGE_HEIGHT });
  const w = requireInteger(rect.w, `${path}.w`, { min: 1, max: PAGE_WIDTH });
  const h = requireInteger(rect.h, `${path}.h`, { min: 1, max: PAGE_HEIGHT });
  if (x < padding || y < padding || x + w > PAGE_WIDTH - padding || y + h > PAGE_HEIGHT - padding) {
    fail(path, `must fit inside the ${PAGE_WIDTH}x${PAGE_HEIGHT} frame with ${padding} units of padding.`);
  }
  return { x, y, w, h };
}

function normalizeSlot(value, index, padding) {
  const path = `plan.pagePlan.slots[${index}]`;
  const slot = requireObject(value, path, new Set([
    "id",
    "blockId",
    "route",
    "region",
    "rect",
    "padding",
    "order",
    "fit",
    "contentSpec",
  ]));
  if (!ROUTES.has(slot.route)) fail(`${path}.route`, "is not supported.");
  if (!FITS[slot.route].has(slot.fit)) {
    fail(`${path}.fit`, `is not supported for route ${slot.route}.`);
  }
  const slotPadding = requireInteger(slot.padding, `${path}.padding`, { min: MIN_SPACING, max: 128 });
  const rect = normalizeRect(slot.rect, `${path}.rect`, padding);
  const minimumSize = {
    visual: { w: 300, h: 220 },
    diagram: { w: 480, h: 320 },
    evidence: { w: 300, h: 180 },
  }[slot.route];
  if (rect.w < minimumSize.w || rect.h < minimumSize.h) {
    fail(`${path}.rect`, `must be at least ${minimumSize.w}x${minimumSize.h} for route ${slot.route}.`);
  }
  if (rect.w <= slotPadding * 2 || rect.h <= slotPadding * 2) {
    fail(`${path}.padding`, "leaves no positive inset content rectangle.");
  }
  const id = requireString(slot.id, `${path}.id`, { max: 80, identifier: true });
  const blockId = requireString(slot.blockId, `${path}.blockId`, { max: 160, identifier: true });
  if (!SLOT_ID_PATTERN.test(id)) fail(`${path}.id`, 'must match "slot:<12-lowercase-hex>".');
  if (!BLOCK_ID_PATTERN.test(blockId)) fail(`${path}.blockId`, 'must match "block:<12-lowercase-hex>".');
  return {
    id,
    blockId,
    route: slot.route,
    region: requireString(slot.region, `${path}.region`, { max: 120 }),
    rect,
    padding: slotPadding,
    order: requireInteger(slot.order, `${path}.order`, { min: 1, max: MAX_SLOTS }),
    fit: slot.fit,
    contentSpec: normalizeContentSpec(slot.contentSpec, slot.route, `${path}.contentSpec`),
  };
}

function axisGap(aStart, aSize, bStart, bSize) {
  const aEnd = aStart + aSize;
  const bEnd = bStart + bSize;
  if (aEnd <= bStart) return bStart - aEnd;
  if (bEnd <= aStart) return aStart - bEnd;
  return 0;
}

function validateSlotSeparation(slots, gutter) {
  for (let leftIndex = 0; leftIndex < slots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < slots.length; rightIndex += 1) {
      const left = slots[leftIndex];
      const right = slots[rightIndex];
      const horizontalGap = axisGap(left.rect.x, left.rect.w, right.rect.x, right.rect.w);
      const verticalGap = axisGap(left.rect.y, left.rect.h, right.rect.y, right.rect.h);
      if (horizontalGap === 0 && verticalGap === 0) {
        fail(
          "plan.pagePlan.slots",
          `contains overlapping slots ${left.id} and ${right.id}.`,
        );
      }
      if (Math.max(horizontalGap, verticalGap) < gutter) {
        fail(
          "plan.pagePlan.slots",
          `slots ${left.id} and ${right.id} must have at least ${gutter} units of gutter.`,
        );
      }
    }
  }
}

function normalizePlan(plan) {
  const root = requireObject(plan, "plan", new Set(["schemaVersion", "pagePlan"]));
  if (root.schemaVersion !== "3") fail("plan.schemaVersion", 'must be exactly "3".');
  const pagePlan = requireObject(root.pagePlan, "plan.pagePlan", new Set([
    "version",
    "frame",
    "padding",
    "gutter",
    "slots",
  ]));
  if (pagePlan.version !== "3") fail("plan.pagePlan.version", 'must be exactly "3".');
  const frame = requireObject(pagePlan.frame, "plan.pagePlan.frame", new Set(["width", "height"]));
  if (frame.width !== PAGE_WIDTH || frame.height !== PAGE_HEIGHT) {
    fail("plan.pagePlan.frame", `must be exactly ${PAGE_WIDTH}x${PAGE_HEIGHT}.`);
  }
  const padding = requireInteger(pagePlan.padding, "plan.pagePlan.padding", {
    min: MIN_SPACING,
    max: 256,
  });
  const gutter = requireInteger(pagePlan.gutter, "plan.pagePlan.gutter", {
    min: MIN_SPACING,
    max: 256,
  });
  if (!Array.isArray(pagePlan.slots)) fail("plan.pagePlan.slots", "must be an array.");
  if (pagePlan.slots.length < MIN_SLOTS || pagePlan.slots.length > MAX_SLOTS) {
    fail("plan.pagePlan.slots", `must contain between ${MIN_SLOTS} and ${MAX_SLOTS} slots.`);
  }
  const slots = pagePlan.slots.map((slot, index) => normalizeSlot(slot, index, padding));
  const ids = new Set();
  const blockIds = new Set();
  const orders = new Set();
  let visualCount = 0;
  for (const slot of slots) {
    if (ids.has(slot.id)) fail("plan.pagePlan.slots", `contains duplicate slot id ${slot.id}.`);
    if (blockIds.has(slot.blockId)) {
      fail("plan.pagePlan.slots", `contains duplicate block id ${slot.blockId}.`);
    }
    if (orders.has(slot.order)) fail("plan.pagePlan.slots", `contains duplicate order ${slot.order}.`);
    ids.add(slot.id);
    blockIds.add(slot.blockId);
    orders.add(slot.order);
    if (slot.route === "visual") visualCount += 1;
  }
  if (visualCount > MAX_VISUAL_SLOTS) {
    fail("plan.pagePlan.slots", `cannot contain more than ${MAX_VISUAL_SLOTS} visual slots.`);
  }
  validateSlotSeparation(slots, gutter);
  slots.sort((left, right) => left.order - right.order);
  return {
    schemaVersion: "3",
    pagePlan: {
      version: "3",
      frame: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
      padding,
      gutter,
      slots,
    },
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (typeof value === "string") return normalizeUnicode(value);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [normalizeUnicode(key), canonicalize(value[key])]),
    );
  }
  return value;
}

export function validateAutoComposePagePlan(plan) {
  return deepFreeze(normalizePlan(plan));
}

export function digestAutoComposePagePlan(plan) {
  const normalized = validateAutoComposePagePlan(plan);
  const canonicalJson = JSON.stringify(canonicalize(normalized));
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}
