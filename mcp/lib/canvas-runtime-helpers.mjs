import { cowartSnapshotRevision } from "./canvas-storage.mjs";

const MAX_SOURCE_SHAPE_IDS = 250;
const AUTO_COMPOSE_ROLES = new Set(["composition-reference", "visual-part"]);
const AUTO_COMPOSE_METADATA_KEYS = new Set([
  "cowartAutoComposeVersion",
  "cowartAutoComposeId",
  "cowartAutoComposeRole",
  "cowartAutoComposeBlockId",
  "cowartAutoComposeSlotId",
  "cowartAutoComposeReferenceShapeId",
  "cowartAutoComposePagePlanDigest",
  "cowartAutoComposeSourceShapeIds",
]);

function exactBoundedMetadataString(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

export function normalizeAutoComposeImageMetadata(value, { allowLineage = true } = {}) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Image metadata must be an object.");
  }

  const normalized = { ...value };
  const lineageKeys = Object.keys(normalized).filter((key) => key.startsWith("cowartAutoCompose"));
  if (lineageKeys.length === 0) return normalized;
  if (!allowLineage) {
    throw new Error("Auto-compose lineage belongs on shapeMeta, not assetMeta.");
  }

  const unsupportedKey = lineageKeys.find((key) => !AUTO_COMPOSE_METADATA_KEYS.has(key));
  if (unsupportedKey) {
    throw new Error(`Unsupported auto-compose image metadata field: ${unsupportedKey}.`);
  }

  const compositionId = exactBoundedMetadataString(normalized.cowartAutoComposeId, 160);
  const role = exactBoundedMetadataString(normalized.cowartAutoComposeRole, 40);
  const pagePlanDigest = exactBoundedMetadataString(
    normalized.cowartAutoComposePagePlanDigest,
    64,
  );
  if (normalized.cowartAutoComposeVersion !== "3") {
    throw new Error('cowartAutoComposeVersion must be exactly "3".');
  }
  if (!compositionId) {
    throw new Error("cowartAutoComposeId must be a non-empty string of at most 160 characters.");
  }
  if (!AUTO_COMPOSE_ROLES.has(role)) {
    throw new Error('cowartAutoComposeRole must be either "composition-reference" or "visual-part".');
  }
  if (!pagePlanDigest || !/^[0-9a-f]{64}$/.test(pagePlanDigest)) {
    throw new Error("cowartAutoComposePagePlanDigest must be exactly 64 lowercase hexadecimal characters.");
  }

  const blockId = exactBoundedMetadataString(normalized.cowartAutoComposeBlockId, 160);
  const slotId = exactBoundedMetadataString(normalized.cowartAutoComposeSlotId, 160);
  const referenceShapeId = exactBoundedMetadataString(
    normalized.cowartAutoComposeReferenceShapeId,
    160,
  );
  const rawSourceShapeIds = normalized.cowartAutoComposeSourceShapeIds;
  if (rawSourceShapeIds !== undefined && !Array.isArray(rawSourceShapeIds)) {
    throw new Error("cowartAutoComposeSourceShapeIds must be an array.");
  }
  if (Array.isArray(rawSourceShapeIds) && rawSourceShapeIds.length > MAX_SOURCE_SHAPE_IDS) {
    throw new Error(`cowartAutoComposeSourceShapeIds cannot exceed ${MAX_SOURCE_SHAPE_IDS} items.`);
  }
  const sourceShapeIds = [];
  for (const sourceShapeId of rawSourceShapeIds ?? []) {
    const exactId = exactBoundedMetadataString(sourceShapeId, 160);
    if (!exactId) {
      throw new Error("Every cowartAutoComposeSourceShapeIds item must be a non-empty string of at most 160 characters.");
    }
    if (!sourceShapeIds.includes(exactId)) sourceShapeIds.push(exactId);
  }

  if (role === "composition-reference") {
    if (blockId || slotId || referenceShapeId) {
      throw new Error("Composition-reference images cannot declare a block ID, slot ID, or reference shape ID.");
    }
    delete normalized.cowartAutoComposeBlockId;
    delete normalized.cowartAutoComposeSlotId;
    delete normalized.cowartAutoComposeReferenceShapeId;
  } else if (!blockId || !slotId || !referenceShapeId) {
    throw new Error("Visual-part images require a block ID, slot ID, and reference shape ID.");
  }

  normalized.cowartAutoComposeVersion = "3";
  normalized.cowartAutoComposeId = compositionId;
  normalized.cowartAutoComposeRole = role;
  normalized.cowartAutoComposePagePlanDigest = pagePlanDigest;
  if (blockId) normalized.cowartAutoComposeBlockId = blockId;
  if (slotId) normalized.cowartAutoComposeSlotId = slotId;
  if (referenceShapeId) normalized.cowartAutoComposeReferenceShapeId = referenceShapeId;
  if (rawSourceShapeIds !== undefined) {
    normalized.cowartAutoComposeSourceShapeIds = sourceShapeIds;
  }
  return normalized;
}

export function snapshotRevision(snapshot) {
  return cowartSnapshotRevision(snapshot);
}
