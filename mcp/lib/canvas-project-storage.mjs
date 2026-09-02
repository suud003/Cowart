import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  resolveCowartPaths,
  withCowartCanvasSaveTransaction,
} from "./canvas-storage.mjs";

export const DEFAULT_CANVAS_ID = "canvas_main";
export const CANVAS_PROJECT_TYPE = "yogurt-canvas-project";
export const CANVAS_PROJECT_VERSION = 1;

const PROJECT_FILE_NAME = "project.json";
const LEGACY_EXCALIDRAW_FILE_NAME = "yogurt.excalidraw";
const CANVASES_DIRECTORY_NAME = "canvases";
const SCENE_FILE_NAME = "scene.excalidraw";
const PROJECT_LOCK_FILE_NAME = ".cowart-project.lock";
const PROJECT_LOCK_HEARTBEAT_MS = 2_000;
const PROJECT_LOCK_STALE_MS = 15_000;
const PROJECT_LOCK_HARD_STALE_MS = 5 * 60_000;
const PROJECT_LOCK_TIMEOUT_MS = 20_000;
// Lowercase-only IDs avoid case-folding aliases on Windows/macOS filesystems.
const CANVAS_ID_PATTERN = /^canvas_[a-z0-9][a-z0-9_-]{0,119}$/;
const MAX_CANVAS_NAME_LENGTH = 120;
const projectMutationQueues = new Map();

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;

  const canonical = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalJsonValue(value[key]);
  }
  return canonical;
}

function projectError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizedCanvasName(value, fallback = null) {
  const name = typeof value === "string" ? value.trim() : "";
  const resolved = name || fallback;
  if (!resolved) {
    throw projectError("COWART_CANVAS_NAME_INVALID", "Canvas name must not be empty.");
  }
  if (resolved.length > MAX_CANVAS_NAME_LENGTH) {
    throw projectError(
      "COWART_CANVAS_NAME_INVALID",
      `Canvas name must be at most ${MAX_CANVAS_NAME_LENGTH} characters.`,
    );
  }
  return resolved;
}

function assertCanvasId(canvasId, label = "canvasId") {
  if (typeof canvasId !== "string" || !CANVAS_ID_PATTERN.test(canvasId)) {
    throw projectError(
      "COWART_CANVAS_ID_INVALID",
      `${label} must match ${CANVAS_ID_PATTERN}.`,
      { canvasId },
    );
  }
  return canvasId;
}

function assertSafeChildPath(parent, child, label) {
  const pathToChild = relative(resolve(parent), resolve(child));
  if (!pathToChild || pathToChild.startsWith("..") || pathToChild.includes(`..${sep}`)) {
    throw projectError("COWART_CANVAS_PATH_UNSAFE", `Unsafe ${label}: ${child}`);
  }
}

function projectStoragePaths(args = {}) {
  const { projectDir, canvasDir } = resolveCowartPaths(args);
  const projectFile = join(canvasDir, PROJECT_FILE_NAME);
  const canvasesDir = join(canvasDir, CANVASES_DIRECTORY_NAME);
  const legacyExcalidrawFile = join(canvasDir, LEGACY_EXCALIDRAW_FILE_NAME);
  return {
    projectDir,
    canvasDir,
    projectFile,
    canvasesDir,
    legacyExcalidrawFile,
    projectLockFile: join(canvasDir, PROJECT_LOCK_FILE_NAME),
    trashDir: join(canvasDir, ".trash"),
  };
}

export function resolveCowartCanvasPaths(args = {}, canvasId) {
  const safeCanvasId = assertCanvasId(canvasId);
  const storage = projectStoragePaths(args);
  const canvasDirectory = join(storage.canvasesDir, safeCanvasId);
  assertSafeChildPath(storage.canvasesDir, canvasDirectory, "canvas directory");
  return {
    ...storage,
    canvasRootDir: storage.canvasDir,
    // Existing canvas-storage callers can pass this value back as `canvasDir`
    // and become isolated to the selected project canvas.
    canvasDir: canvasDirectory,
    canvasId: safeCanvasId,
    canvasDirectory,
    sceneFile: join(canvasDirectory, SCENE_FILE_NAME),
    selectionFile: join(canvasDirectory, "selection.json"),
    viewStateFile: join(canvasDirectory, "view-state.json"),
    historyDir: join(canvasDirectory, "thinking-history"),
    assetsDir: join(canvasDirectory, "assets"),
  };
}

function validateCanvasRecord(record, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw projectError("COWART_CANVAS_PROJECT_INVALID", `Canvas record ${index} is invalid.`);
  }
  const id = assertCanvasId(record.id, `canvases[${index}].id`);
  const parentId = record.parentId === null
    ? null
    : assertCanvasId(record.parentId, `canvases[${index}].parentId`);
  if (!Number.isInteger(record.order) || record.order < 0) {
    throw projectError(
      "COWART_CANVAS_PROJECT_INVALID",
      `Canvas ${id} must have a non-negative integer order.`,
    );
  }
  return {
    id,
    name: normalizedCanvasName(record.name),
    parentId,
    order: record.order,
    createdAt: typeof record.createdAt === "string" && record.createdAt
      ? record.createdAt
      : null,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt
      ? record.updatedAt
      : null,
  };
}

function validateProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw projectError("COWART_CANVAS_PROJECT_INVALID", "Expected a Yogurt AI canvas project object.");
  }
  if (project.type !== CANVAS_PROJECT_TYPE || project.version !== CANVAS_PROJECT_VERSION) {
    throw projectError(
      "COWART_CANVAS_PROJECT_INVALID",
      `Unsupported canvas project ${String(project.type)}@${String(project.version)}.`,
    );
  }
  if (!Array.isArray(project.canvases) || project.canvases.length === 0) {
    throw projectError("COWART_CANVAS_PROJECT_INVALID", "Canvas project must contain at least one canvas.");
  }

  const canvases = project.canvases.map(validateCanvasRecord);
  const byId = new Map();
  for (const canvas of canvases) {
    if (byId.has(canvas.id)) {
      throw projectError("COWART_CANVAS_PROJECT_INVALID", `Duplicate canvas ID: ${canvas.id}.`);
    }
    byId.set(canvas.id, canvas);
  }

  for (const canvas of canvases) {
    if (canvas.parentId === canvas.id) {
      throw projectError("COWART_CANVAS_TREE_CYCLE", `Canvas ${canvas.id} cannot be its own parent.`);
    }
    if (canvas.parentId && !byId.has(canvas.parentId)) {
      throw projectError(
        "COWART_CANVAS_PARENT_NOT_FOUND",
        `Canvas ${canvas.id} references missing parent ${canvas.parentId}.`,
      );
    }

    const visited = new Set([canvas.id]);
    let cursor = canvas;
    while (cursor.parentId) {
      if (visited.has(cursor.parentId)) {
        throw projectError(
          "COWART_CANVAS_TREE_CYCLE",
          `Canvas hierarchy contains a cycle through ${cursor.parentId}.`,
        );
      }
      visited.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
    }
  }

  const siblingOrders = new Set();
  for (const canvas of canvases) {
    const key = `${canvas.parentId ?? "__root__"}:${canvas.order}`;
    if (siblingOrders.has(key)) {
      throw projectError(
        "COWART_CANVAS_PROJECT_INVALID",
        `Sibling canvases under ${canvas.parentId ?? "the project root"} share order ${canvas.order}.`,
      );
    }
    siblingOrders.add(key);
  }

  const activeCanvasId = assertCanvasId(project.activeCanvasId, "activeCanvasId");
  if (!byId.has(activeCanvasId)) {
    throw projectError(
      "COWART_CANVAS_PROJECT_INVALID",
      `Active canvas ${activeCanvasId} does not exist.`,
    );
  }

  return {
    type: CANVAS_PROJECT_TYPE,
    version: CANVAS_PROJECT_VERSION,
    createdAt: typeof project.createdAt === "string" && project.createdAt
      ? project.createdAt
      : null,
    updatedAt: typeof project.updatedAt === "string" && project.updatedAt
      ? project.updatedAt
      : null,
    activeCanvasId,
    canvases,
    ...(project.migration && typeof project.migration === "object"
      ? { migration: cloneJson(project.migration) }
      : {}),
  };
}

export function canvasProjectRevision(project) {
  const validated = validateProject(project);
  const canonicalProject = {
    ...validated,
    canvases: [...validated.canvases].sort((left, right) => left.id.localeCompare(right.id)),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(canonicalProject)))
    .digest("hex")
    .slice(0, 20);
}

function projectResult(args, project, options = {}) {
  const validated = validateProject(project);
  const canvasId = options.canvasId ?? validated.activeCanvasId;
  const canvas = validated.canvases.find((entry) => entry.id === canvasId) ?? null;
  const paths = canvas ? resolveCowartCanvasPaths(args, canvas.id) : projectStoragePaths(args);
  return {
    project: validated,
    projectRevision: canvasProjectRevision(validated),
    canvas,
    projectDir: paths.projectDir,
    canvasDir: paths.canvasDir,
    canvasRootDir: paths.canvasRootDir ?? paths.canvasDir,
    projectFile: paths.projectFile,
    ...(canvas ? { canvasPaths: paths } : {}),
    ...options.extra,
  };
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readProjectFileOrNull(args = {}) {
  const { projectFile } = projectStoragePaths(args);
  try {
    return validateProject(await readJsonFile(projectFile));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code?.startsWith?.("COWART_")) throw error;
    throw projectError(
      "COWART_CANVAS_PROJECT_INVALID",
      `Invalid canvas project in ${projectFile}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function writeBufferAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempFile, payload);
    await rename(tempFile, filePath);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await writeBufferAtomic(filePath, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
}

async function writeExactBytesIfCompatible(filePath, payload, label) {
  try {
    const existing = await readFile(filePath);
    if (existing.equals(payload)) return false;
    throw projectError(
      "COWART_CANVAS_MIGRATION_CONFLICT",
      `${label} already exists with different content: ${filePath}`,
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeBufferAtomic(filePath, payload);
  return true;
}

function wait(delayMs) {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function reclaimStaleProjectLock(lockPath) {
  let lockStat;
  let owner = null;
  try {
    [lockStat, owner] = await Promise.all([
      stat(lockPath),
      readFile(lockPath, "utf8")
        .then((content) => JSON.parse(content))
        .catch(() => null),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }

  const ageMs = Date.now() - lockStat.mtimeMs;
  if (ageMs < PROJECT_LOCK_STALE_MS) return false;
  if (processExists(Number(owner?.pid)) && ageMs < PROJECT_LOCK_HARD_STALE_MS) return false;

  const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return false;
    throw error;
  }
  await rm(stalePath, { force: true }).catch(() => undefined);
  return true;
}

async function acquireProjectLock(args = {}) {
  const { canvasDir, projectLockFile: lockPath } = projectStoragePaths(args);
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  await mkdir(canvasDir, { recursive: true });

  while (true) {
    let lockHandle;
    try {
      lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${JSON.stringify({ version: 1, token, pid: process.pid })}\n`);
      const heartbeat = setInterval(() => {
        const currentTime = new Date();
        lockHandle.utimes(currentTime, currentTime).catch(() => undefined);
      }, PROJECT_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();

      return async () => {
        clearInterval(heartbeat);
        await lockHandle.close().catch(() => undefined);
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8"));
          if (owner?.token === token) await rm(lockPath, { force: true });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      await lockHandle?.close().catch(() => undefined);
      if (lockHandle && error?.code !== "EEXIST") {
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
      if (error?.code !== "EEXIST") throw error;
      await reclaimStaleProjectLock(lockPath);
      if (Date.now() - startedAt >= PROJECT_LOCK_TIMEOUT_MS) {
        throw projectError(
          "COWART_CANVAS_PROJECT_LOCK_TIMEOUT",
          `Timed out waiting for the Yogurt AI canvas project lock at ${lockPath}.`,
        );
      }
      await wait(20 + Math.floor(Math.random() * 31));
    }
  }
}

async function withProjectLock(args, operation) {
  const release = await acquireProjectLock(args);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function projectMutationQueueKey(args) {
  const projectFile = projectStoragePaths(args).projectFile;
  return process.platform === "win32" ? projectFile.toLowerCase() : projectFile;
}

function serializeProjectMutation(args, operation) {
  const queueKey = projectMutationQueueKey(args);
  const previous = projectMutationQueues.get(queueKey) ?? Promise.resolve();
  const result = previous.then(() => withProjectLock(args, operation));
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  projectMutationQueues.set(queueKey, tail);
  return result.finally(() => {
    if (projectMutationQueues.get(queueKey) === tail) projectMutationQueues.delete(queueKey);
  });
}

function emptyExcalidrawBytes() {
  return Buffer.from(`${JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://github.com/suud003/Cowart",
    elements: [],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  }, null, 2)}\n`, "utf8");
}

function assertExcalidrawBytes(payload, filePath) {
  let scene;
  try {
    scene = JSON.parse(payload.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw projectError(
      "COWART_LEGACY_EXCALIDRAW_INVALID",
      `Invalid legacy Excalidraw JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!scene || scene.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    throw projectError(
      "COWART_LEGACY_EXCALIDRAW_INVALID",
      `Expected an Excalidraw document in ${filePath}.`,
    );
  }
  return scene;
}

function sourceSceneRevision(payload) {
  return createHash("sha256").update(payload).digest("hex").slice(0, 20);
}

function initialProject({ name, timestamp, migration = null }) {
  return validateProject({
    type: CANVAS_PROJECT_TYPE,
    version: CANVAS_PROJECT_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    activeCanvasId: DEFAULT_CANVAS_ID,
    canvases: [{
      id: DEFAULT_CANVAS_ID,
      name,
      parentId: null,
      order: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    ...(migration ? { migration } : {}),
  });
}

async function copyOptionalLegacyState(storage, canvasPaths, fileName, targetFile) {
  const sourceFile = join(storage.canvasDir, fileName);
  try {
    const payload = await readFile(sourceFile);
    await writeExactBytesIfCompatible(targetFile, payload, `Legacy ${fileName}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function ensureCowartCanvasProject(args = {}) {
  const existing = await readProjectFileOrNull(args);
  if (existing) return projectResult(args, existing, { extra: { created: false, migrated: false } });

  return serializeProjectMutation(args, async () => {
    const racedProject = await readProjectFileOrNull(args);
    if (racedProject) {
      return projectResult(args, racedProject, { extra: { created: false, migrated: false } });
    }

    const storage = projectStoragePaths(args);
    const defaultPaths = resolveCowartCanvasPaths(args, DEFAULT_CANVAS_ID);
    let legacyPayload = null;
    let legacyScene = null;
    let legacyStat = null;
    let legacyMigrationSource = null;
    try {
      [legacyPayload, legacyStat] = await Promise.all([
        readFile(storage.legacyExcalidrawFile),
        stat(storage.legacyExcalidrawFile),
      ]);
      legacyScene = assertExcalidrawBytes(legacyPayload, storage.legacyExcalidrawFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    if (!legacyPayload) {
      const { readCowartLegacyMigrationSource } = await import("./canvas-storage.mjs");
      legacyMigrationSource = await readCowartLegacyMigrationSource(args);
    }

    const scenePayload = legacyPayload ?? (legacyMigrationSource
      ? Buffer.from(`${JSON.stringify(legacyMigrationSource.scene, null, 2)}\n`, "utf8")
      : emptyExcalidrawBytes());
    await writeExactBytesIfCompatible(
      defaultPaths.sceneFile,
      scenePayload,
      legacyPayload ? "Migrated Excalidraw scene" : "Default Excalidraw scene",
    );
    if (legacyPayload || legacyMigrationSource) {
      await copyOptionalLegacyState(storage, defaultPaths, "cowart-selection.json", defaultPaths.selectionFile);
      await copyOptionalLegacyState(storage, defaultPaths, "cowart-view-state.json", defaultPaths.viewStateFile);
    }

    const timestamp = legacyStat?.mtimeMs
      ? new Date(legacyStat.mtimeMs).toISOString()
      : legacyMigrationSource?.sourceTimestamp ?? nowIso();
    const initialName = normalizedCanvasName(
      legacyScene?.appState?.name,
      legacyMigrationSource?.name ?? "主画布",
    );
    const sourceProjectRevision = canvasProjectRevision(initialProject({
      name: initialName,
      timestamp: null,
    }));
    const project = initialProject({
      name: initialName,
      timestamp,
      migration: legacyPayload
        ? {
          source: LEGACY_EXCALIDRAW_FILE_NAME,
          sourceRevision: sourceSceneRevision(legacyPayload),
          sourceProjectRevision,
          format: "excalidraw",
          // Use source metadata rather than wall-clock migration time so a
          // retry after a crash produces the same project document/revision.
          migratedAt: timestamp,
        }
        : legacyMigrationSource
          ? {
            source: legacyMigrationSource.source,
            sourceRevision: legacyMigrationSource.sourceRevision,
            sourceProjectRevision,
            format: legacyMigrationSource.migrated ? "tldraw" : "empty",
            migratedAt: timestamp,
          }
          : null,
    });

    // project.json is the migration cutover marker and must be committed last.
    await writeJsonAtomic(storage.projectFile, project);
    return projectResult(args, project, {
      extra: {
        created: true,
        migrated: Boolean(legacyPayload || legacyMigrationSource?.migrated),
        sourceProjectRevision,
      },
    });
  });
}

export async function readCowartCanvasProject(args = {}) {
  return ensureCowartCanvasProject(args);
}

function expectedProjectRevision(options = {}) {
  const revision = options.baseProjectRevision ?? options.baseRevision;
  return typeof revision === "string" && revision.trim() ? revision.trim() : null;
}

function assertProjectCas(project, options = {}) {
  const expectedRevision = expectedProjectRevision(options);
  const currentRevision = canvasProjectRevision(project);
  const sourceProjectRevision = typeof project.migration?.sourceProjectRevision === "string"
    ? project.migration.sourceProjectRevision
    : null;
  if (
    expectedRevision &&
    expectedRevision !== currentRevision &&
    expectedRevision !== sourceProjectRevision
  ) {
    throw projectError(
      "COWART_PROJECT_REVISION_CONFLICT",
      `Yogurt AI canvas project changed from ${expectedRevision} to ${currentRevision}; reload before updating the hierarchy.`,
      { expectedRevision, currentRevision },
    );
  }
  return currentRevision;
}

function retireSourceProjectRevision(project) {
  if (!project.migration || typeof project.migration !== "object") return;
  delete project.migration.sourceProjectRevision;
}

function canvasById(project, canvasId) {
  const safeCanvasId = assertCanvasId(canvasId);
  const canvas = project.canvases.find((entry) => entry.id === safeCanvasId);
  if (!canvas) {
    throw projectError("COWART_CANVAS_NOT_FOUND", `Unknown canvas ${safeCanvasId}.`, {
      canvasId: safeCanvasId,
    });
  }
  return canvas;
}

function sortSiblings(canvases) {
  return [...canvases].sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id));
}

function reindexAllSiblings(canvases) {
  const groups = new Map();
  for (const canvas of canvases) {
    const key = canvas.parentId ?? "__root__";
    const siblings = groups.get(key) ?? [];
    siblings.push(canvas);
    groups.set(key, siblings);
  }
  for (const siblings of groups.values()) {
    sortSiblings(siblings).forEach((canvas, order) => {
      canvas.order = order;
    });
  }
}

function placeCanvas(canvases, canvasId, parentId, requestedOrder) {
  const target = canvases.find((entry) => entry.id === canvasId);
  target.parentId = parentId;

  const siblings = sortSiblings(
    canvases.filter((entry) => entry.id !== canvasId && entry.parentId === parentId),
  );
  const insertionIndex = requestedOrder === undefined
    ? siblings.length
    : Math.max(0, Math.min(siblings.length, Math.trunc(requestedOrder)));
  siblings.splice(insertionIndex, 0, target);
  siblings.forEach((canvas, order) => {
    canvas.order = order;
  });
  reindexAllSiblings(canvases);
}

function metadataSignature(canvases) {
  return JSON.stringify(
    [...canvases]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, name, parentId, order }) => ({ id, name, parentId, order })),
  );
}

function generatedCanvasId() {
  return `canvas_${randomUUID().replaceAll("-", "")}`;
}

function validateSceneSnapshot(scene) {
  if (!scene || typeof scene !== "object" || scene.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    throw projectError("COWART_CANVAS_SCENE_INVALID", "New canvas scene must be an Excalidraw document.");
  }
  return cloneJson(scene);
}

async function canvasDirectoryExists(canvasDirectory) {
  try {
    await stat(canvasDirectory);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function createCowartCanvas(args = {}, options = {}) {
  await ensureCowartCanvasProject(args);
  return serializeProjectMutation(args, async () => {
    const current = await readProjectFileOrNull(args);
    assertProjectCas(current, options);

    const canvasId = assertCanvasId(options.canvasId ?? options.id ?? generatedCanvasId());
    if (current.canvases.some((canvas) => canvas.id === canvasId)) {
      throw projectError("COWART_CANVAS_ALREADY_EXISTS", `Canvas ${canvasId} already exists.`);
    }
    const parentId = options.parentId === undefined || options.parentId === null
      ? null
      : canvasById(current, options.parentId).id;
    if (options.order !== undefined && (!Number.isFinite(options.order) || options.order < 0)) {
      throw projectError("COWART_CANVAS_ORDER_INVALID", "Canvas order must be a non-negative number.");
    }

    const timestamp = nowIso();
    const next = cloneJson(current);
    const canvas = {
      id: canvasId,
      name: normalizedCanvasName(options.name, "新画布"),
      parentId,
      order: Number.MAX_SAFE_INTEGER,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    next.canvases.push(canvas);
    placeCanvas(next.canvases, canvasId, parentId, options.order);
    if (options.activate !== false) next.activeCanvasId = canvasId;
    retireSourceProjectRevision(next);
    next.updatedAt = timestamp;
    const validated = validateProject(next);

    const canvasPaths = resolveCowartCanvasPaths(args, canvasId);
    if (await canvasDirectoryExists(canvasPaths.canvasDirectory)) {
      throw projectError(
        "COWART_CANVAS_STORAGE_CONFLICT",
        `Canvas storage already exists for ${canvasId}: ${canvasPaths.canvasDirectory}`,
      );
    }
    const scene = options.scene === undefined
      ? null
      : validateSceneSnapshot(options.scene);
    const scenePayload = scene
      ? Buffer.from(`${JSON.stringify(scene, null, 2)}\n`, "utf8")
      : emptyExcalidrawBytes();
    let createdDirectory = false;
    try {
      await writeBufferAtomic(canvasPaths.sceneFile, scenePayload);
      createdDirectory = true;
      await writeJsonAtomic(projectStoragePaths(args).projectFile, validated);
    } catch (error) {
      if (createdDirectory) {
        await rm(canvasPaths.canvasDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }

    return projectResult(args, validated, {
      canvasId,
      extra: { created: true, migrated: false },
    });
  });
}

export async function updateCowartCanvas(args = {}, options = {}) {
  await ensureCowartCanvasProject(args);
  return serializeProjectMutation(args, async () => {
    const current = await readProjectFileOrNull(args);
    assertProjectCas(current, options);
    const canvasId = assertCanvasId(options.canvasId);
    canvasById(current, canvasId);

    const next = cloneJson(current);
    const canvas = canvasById(next, canvasId);
    const beforeSignature = metadataSignature(next.canvases);
    if (options.name !== undefined) canvas.name = normalizedCanvasName(options.name);

    const parentWasSupplied = Object.hasOwn(options, "parentId");
    const nextParentId = parentWasSupplied
      ? (options.parentId === null ? null : canvasById(next, options.parentId).id)
      : canvas.parentId;
    if (options.order !== undefined && (!Number.isFinite(options.order) || options.order < 0)) {
      throw projectError("COWART_CANVAS_ORDER_INVALID", "Canvas order must be a non-negative number.");
    }
    if (parentWasSupplied || options.order !== undefined) {
      const requestedOrder = options.order === undefined && nextParentId === canvas.parentId
        ? canvas.order
        : options.order;
      placeCanvas(next.canvases, canvasId, nextParentId, requestedOrder);
    }

    const afterSignature = metadataSignature(next.canvases);
    if (beforeSignature === afterSignature) {
      return projectResult(args, current, { canvasId, extra: { updated: false } });
    }
    const timestamp = nowIso();
    canvas.updatedAt = timestamp;
    retireSourceProjectRevision(next);
    next.updatedAt = timestamp;
    const validated = validateProject(next);
    await writeJsonAtomic(projectStoragePaths(args).projectFile, validated);
    return projectResult(args, validated, { canvasId, extra: { updated: true } });
  });
}

export async function setActiveCowartCanvas(args = {}, options = {}) {
  await ensureCowartCanvasProject(args);
  return serializeProjectMutation(args, async () => {
    const current = await readProjectFileOrNull(args);
    assertProjectCas(current, options);
    const canvasId = canvasById(current, options.canvasId).id;
    if (current.activeCanvasId === canvasId) {
      return projectResult(args, current, { canvasId, extra: { updated: false } });
    }
    const next = cloneJson(current);
    next.activeCanvasId = canvasId;
    retireSourceProjectRevision(next);
    next.updatedAt = nowIso();
    const validated = validateProject(next);
    await writeJsonAtomic(projectStoragePaths(args).projectFile, validated);
    return projectResult(args, validated, { canvasId, extra: { updated: true } });
  });
}

function sortedCanvases(canvases) {
  return [...canvases].sort((left, right) =>
    String(left.parentId ?? "").localeCompare(String(right.parentId ?? "")) ||
    left.order - right.order ||
    left.id.localeCompare(right.id));
}

async function moveCanvasDirectoryToTrash(args, canvasId) {
  const paths = resolveCowartCanvasPaths(args, canvasId);
  try {
    await stat(paths.canvasDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const storage = projectStoragePaths(args);
  await mkdir(storage.trashDir, { recursive: true });
  const trashPath = join(
    storage.trashDir,
    `${canvasId}.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}`,
  );
  assertSafeChildPath(storage.trashDir, trashPath, "canvas trash path");
  await rename(paths.canvasDirectory, trashPath);
  return trashPath;
}

export async function deleteCowartCanvas(args = {}, options = {}) {
  await ensureCowartCanvasProject(args);
  return serializeProjectMutation(args, async () => {
    const current = await readProjectFileOrNull(args);
    assertProjectCas(current, options);
    const canvasId = assertCanvasId(options.canvasId);
    const deletedCanvas = canvasById(current, canvasId);
    if (current.canvases.length === 1) {
      throw projectError("COWART_CANVAS_LAST_DELETE_REFUSED", "The final project canvas cannot be deleted.");
    }

    const children = current.canvases.filter((canvas) => canvas.parentId === canvasId);
    if (children.length > 0 && options.reparentChildren !== true) {
      throw projectError(
        "COWART_CANVAS_HAS_CHILDREN",
        `Canvas ${canvasId} has ${children.length} child canvas(es); pass reparentChildren=true or move them first.`,
        { childCanvasIds: children.map((canvas) => canvas.id) },
      );
    }

    const next = cloneJson(current);
    next.canvases = next.canvases.filter((canvas) => canvas.id !== canvasId);
    if (options.reparentChildren === true) {
      for (const child of next.canvases) {
        if (child.parentId === canvasId) child.parentId = deletedCanvas.parentId;
      }
    }
    reindexAllSiblings(next.canvases);
    if (next.activeCanvasId === canvasId) {
      const parent = deletedCanvas.parentId
        ? next.canvases.find((canvas) => canvas.id === deletedCanvas.parentId)
        : null;
      next.activeCanvasId = parent?.id ?? sortedCanvases(next.canvases)[0].id;
    }
    retireSourceProjectRevision(next);
    next.updatedAt = nowIso();
    const validated = validateProject(next);
    const projectFile = projectStoragePaths(args).projectFile;
    return withCowartCanvasSaveTransaction({ ...args, canvasId }, async () => {
      await writeJsonAtomic(projectFile, validated);

      let trashPath = null;
      try {
        trashPath = await moveCanvasDirectoryToTrash(args, canvasId);
      } catch (error) {
        // Restore the index while both the project and canvas locks are held
        // so a failed Windows rename cannot race a scene save.
        await writeJsonAtomic(projectFile, current).catch(() => undefined);
        throw error;
      }

      return projectResult(args, validated, {
        extra: {
          deleted: true,
          deletedCanvas,
          trashPath,
        },
      });
    });
  });
}
