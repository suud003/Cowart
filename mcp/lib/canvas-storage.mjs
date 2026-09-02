import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const PAGE_ID_PREFIX = "page:";
const GLOBAL_ASSETS_ROUTE = "/assets/";
const PAGE_ASSETS_ROUTE = "/page-assets/";
const CANVAS_FILE_NAME = "cowart-canvas.json";
const EXCALIDRAW_FILE_NAME = "yogurt.excalidraw";
const CANVAS_PROJECT_FILE_NAME = "project.json";
const CANVASES_DIRECTORY_NAME = "canvases";
const CANVAS_SCENE_FILE_NAME = "scene.excalidraw";
const DEFAULT_EXCALIDRAW_CANVAS_ID = "canvas_main";
const EXCALIDRAW_CANVAS_ID_PATTERN = /^canvas_[a-z0-9][a-z0-9_-]{0,119}$/;
const CANVAS_SAVE_LOCK_FILE = ".cowart-canvas-save.lock";
const CANVAS_SAVE_LOCKS_DIRECTORY = ".locks";
const CANVAS_SAVE_LOCK_HEARTBEAT_MS = 2_000;
const CANVAS_SAVE_LOCK_STALE_MS = 15_000;
const CANVAS_SAVE_LOCK_HARD_STALE_MS = 5 * 60_000;
const CANVAS_SAVE_LOCK_TIMEOUT_MS = 20_000;
const canvasSaveQueues = new Map();

const mimeTypes = new Map([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".htm", "text/html"],
  [".html", "text/html"],
]);

export function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function pathResolve(value) {
  return resolve(String(value));
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

export function cowartSnapshotRevision(snapshot) {
  if (isExcalidrawSnapshot(snapshot)) {
    // Excalidraw array order is the scene's z-order and must remain significant.
    // Object key insertion order is not meaningful, however, so canonicalize
    // each element (without sorting the array) and the document maps.
    const content = JSON.stringify({
      elements: snapshot.elements.map(canonicalJsonValue),
      appState: canonicalJsonValue(snapshot.appState ?? {}),
      files: canonicalJsonValue(snapshot.files ?? {}),
    });
    return createHash("sha256").update(content).digest("hex").slice(0, 20);
  }
  // A tldraw store is an ID-addressed record map: object insertion order has no
  // semantic meaning. Per-page persistence can legitimately reload the same
  // records in a different order, so hash a canonical representation rather
  // than the current in-memory key order.
  const content = JSON.stringify(canonicalJsonValue(snapshot?.store ?? {}));
  return createHash("sha256").update(content).digest("hex").slice(0, 20);
}

export function resolveCowartPaths(args = {}) {
  const explicitProjectDir = nonEmptyString(args.projectDir);
  const explicitCanvasDir = nonEmptyString(args.canvasDir);
  const envProjectDir = nonEmptyString(process.env.COWART_PROJECT_DIR);
  const envCanvasDir = nonEmptyString(process.env.COWART_CANVAS_DIR);

  const projectDir = pathResolve(explicitProjectDir || envProjectDir || process.cwd());
  const canvasDir = explicitCanvasDir
    ? pathResolve(explicitCanvasDir)
    : envCanvasDir
      ? pathResolve(envCanvasDir)
      : join(projectDir, "canvas");

  return { projectDir, canvasDir };
}

export function resolveCanvasDir(args = {}) {
  return resolveCowartPaths(args).canvasDir;
}

function canvasSaveQueueKey(args) {
  const canvasDir = resolveCanvasDir(args);
  const canvasId = nonEmptyString(args.canvasId) ?? "__legacy__";
  const key = `${canvasDir}::${canvasId}`;
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function waitForCanvasSaveLock(delayMs) {
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

async function reclaimStaleCanvasSaveLock(lockPath) {
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
  if (ageMs < CANVAS_SAVE_LOCK_STALE_MS) return false;
  if (processExists(Number(owner?.pid)) && ageMs < CANVAS_SAVE_LOCK_HARD_STALE_MS) return false;

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

async function acquireCanvasSaveLock(args) {
  const canvasId = nonEmptyString(args.canvasId);
  const canvasDir = resolveCanvasDir(args);
  const lockPath = canvasId
    ? join(canvasDir, CANVAS_SAVE_LOCKS_DIRECTORY, `${assertExcalidrawCanvasId(canvasId)}.save.lock`)
    : join(canvasDir, CANVAS_SAVE_LOCK_FILE);
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    let lockHandle;
    try {
      lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(`${JSON.stringify({ version: 1, token, pid: process.pid })}\n`);

      const heartbeat = setInterval(() => {
        const now = new Date();
        lockHandle.utimes(now, now).catch(() => undefined);
      }, CANVAS_SAVE_LOCK_HEARTBEAT_MS);
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
      await reclaimStaleCanvasSaveLock(lockPath);
      if (Date.now() - startedAt >= CANVAS_SAVE_LOCK_TIMEOUT_MS) {
        const timeoutError = new Error(`Timed out waiting for the Yogurt AI canvas save lock at ${lockPath}.`);
        timeoutError.code = "COWART_CANVAS_SAVE_LOCK_TIMEOUT";
        throw timeoutError;
      }
      await waitForCanvasSaveLock(20 + Math.floor(Math.random() * 31));
    }
  }
}

async function withCanvasSaveLock(args, operation) {
  const release = await acquireCanvasSaveLock(args);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function serializeCanvasSave(args, operation) {
  const queueKey = canvasSaveQueueKey(args);
  const previous = canvasSaveQueues.get(queueKey) ?? Promise.resolve();
  const result = previous.then(() => withCanvasSaveLock(args, operation));
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  canvasSaveQueues.set(queueKey, tail);

  return result.finally(() => {
    if (canvasSaveQueues.get(queueKey) === tail) canvasSaveQueues.delete(queueKey);
  });
}

// Project deletion and scene persistence must share the same queue and
// cross-process lock. The lock file lives outside the canvas directory so a
// Windows rename-to-trash can proceed while the lock is held.
export function withCowartCanvasSaveTransaction(args = {}, operation) {
  if (typeof operation !== "function") {
    throw new TypeError("A canvas save transaction requires an operation function.");
  }
  return serializeCanvasSave(args, operation);
}

export function resolveSelectionFile(args = {}) {
  const canvasId = nonEmptyString(args.canvasId);
  return canvasId
    ? join(dirname(excalidrawCanvasFile(args, canvasId)), "selection.json")
    : join(resolveCanvasDir(args), "cowart-selection.json");
}

export function resolveViewStateFile(args = {}) {
  const canvasId = nonEmptyString(args.canvasId);
  return canvasId
    ? join(dirname(excalidrawCanvasFile(args, canvasId)), "view-state.json")
    : join(resolveCanvasDir(args), "cowart-view-state.json");
}

export function pageDirName(pageId) {
  return encodeURIComponent(String(pageId).replace(PAGE_ID_PREFIX, ""));
}

export function pageAssetUrl(pageId, fileName) {
  return `${PAGE_ASSETS_ROUTE}${pageDirName(pageId)}/${encodeURIComponent(fileName)}`;
}

function canvasFile(args = {}) {
  return join(resolveCanvasDir(args), CANVAS_FILE_NAME);
}

function legacyExcalidrawFile(args = {}) {
  return join(resolveCanvasDir(args), EXCALIDRAW_FILE_NAME);
}

function canvasProjectFile(args = {}) {
  return join(resolveCanvasDir(args), CANVAS_PROJECT_FILE_NAME);
}

function canvasStorageError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function assertExcalidrawCanvasId(canvasId) {
  const normalizedId = nonEmptyString(canvasId);
  if (!normalizedId || !EXCALIDRAW_CANVAS_ID_PATTERN.test(normalizedId)) {
    throw canvasStorageError(
      "COWART_CANVAS_ID_INVALID",
      `Invalid Yogurt AI canvas ID: ${String(canvasId || "")}`,
      { canvasId },
    );
  }
  return normalizedId;
}

function excalidrawCanvasFile(args = {}, canvasId = args.canvasId) {
  const normalizedId = assertExcalidrawCanvasId(canvasId);
  return join(resolveCanvasDir(args), CANVASES_DIRECTORY_NAME, normalizedId, CANVAS_SCENE_FILE_NAME);
}

function canvasPagesDir(args = {}) {
  return join(resolveCanvasDir(args), "pages");
}

function canvasAssetsDir(args = {}) {
  return join(resolveCanvasDir(args), "assets");
}

function pagesManifestFile(args = {}) {
  return join(canvasPagesDir(args), "manifest.json");
}

function pageFilePath(args, pageId) {
  return join(canvasPagesDir(args), pageDirName(pageId), CANVAS_FILE_NAME);
}

function pageAssetsDir(args, pageId) {
  return join(canvasPagesDir(args), pageDirName(pageId), "assets");
}

function isCanvasSnapshot(value) {
  return value && typeof value === "object" && value.store && value.schema;
}

export function isExcalidrawSnapshot(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.type === "excalidraw" &&
    Array.isArray(value.elements) &&
    (!value.files || typeof value.files === "object"),
  );
}

function isSelectionState(value) {
  return value && typeof value === "object" && Array.isArray(value.selectedShapes);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isViewState(value) {
  return (
    value &&
    typeof value === "object" &&
    value.version === 1 &&
    (value.currentPageId === null || typeof value.currentPageId === "string") &&
    value.camera &&
    typeof value.camera === "object" &&
    isFiniteNumber(value.camera.x) &&
    isFiniteNumber(value.camera.y) &&
    isFiniteNumber(value.camera.z)
  );
}

function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function defaultViewState() {
  return {
    version: 1,
    currentPageId: null,
    camera: { x: 0, y: 0, z: 1 },
    updatedAt: null,
  };
}

function getPageRecords(snapshot) {
  return Object.values(snapshot.store)
    .filter((record) => record?.typeName === "page")
    .sort((a, b) => String(a.index ?? "").localeCompare(String(b.index ?? "")));
}

function getAssetIdsForShapes(shapes) {
  return new Set(
    shapes
      .map((shape) => shape?.props?.assetId)
      .filter((assetId) => typeof assetId === "string"),
  );
}

function getShapeRecordsForPage(snapshot, pageId) {
  const shapesByParent = new Map();
  for (const record of Object.values(snapshot.store)) {
    if (record?.typeName !== "shape") continue;
    const siblings = shapesByParent.get(record.parentId) ?? [];
    siblings.push(record);
    shapesByParent.set(record.parentId, siblings);
  }

  const shapes = [];
  const queue = [...(shapesByParent.get(pageId) ?? [])];
  while (queue.length > 0) {
    const shape = queue.shift();
    shapes.push(shape);
    queue.push(...(shapesByParent.get(shape.id) ?? []));
  }
  return shapes;
}

function isBindingForShapes(record, shapeIds) {
  if (record?.typeName !== "binding") return false;
  const fromId = record.fromId ?? record.props?.fromId;
  const toId = record.toId ?? record.props?.toId;
  return shapeIds.has(fromId) || shapeIds.has(toId);
}

function snapshotForPage(snapshot, page) {
  const pageId = page.id;
  const pageShapes = getShapeRecordsForPage(snapshot, pageId);
  const shapeIds = new Set(pageShapes.map((shape) => shape.id));
  const assetIds = getAssetIdsForShapes(pageShapes);
  const store = {};

  for (const record of Object.values(snapshot.store)) {
    if (!record?.id) continue;
    if (record.typeName === "page") {
      if (record.id === pageId) store[record.id] = record;
      continue;
    }
    if (record.typeName === "shape") {
      if (shapeIds.has(record.id)) store[record.id] = record;
      continue;
    }
    if (record.typeName === "asset") {
      if (assetIds.has(record.id)) store[record.id] = record;
      continue;
    }
    if (record.typeName === "binding") {
      if (isBindingForShapes(record, shapeIds)) store[record.id] = record;
      continue;
    }
    store[record.id] = record;
  }

  return {
    schema: snapshot.schema,
    store,
  };
}

function extensionFromMimeType(mimeType) {
  switch (mimeType) {
    case "image/apng":
      return ".apng";
    case "image/avif":
      return ".avif";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/svg+xml":
      return ".svg";
    case "image/webp":
      return ".webp";
    case "text/html":
      return ".html";
    default:
      return ".bin";
  }
}

function sanitizeAssetFileName(name, fallbackName, mimeType) {
  const rawName = basename(String(name || fallbackName || "asset"));
  const extension = extname(rawName) || extensionFromMimeType(mimeType);
  const baseName = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || "asset"}${extension}`;
}

async function uniqueAssetFilePath(dir, requestedName) {
  const safeName = sanitizeAssetFileName(requestedName, "asset", null);
  const extension = extname(safeName);
  const baseName = safeName.slice(0, safeName.length - extension.length);
  let fileName = safeName;
  let counter = 2;

  while (true) {
    const filePath = join(dir, fileName);
    try {
      await stat(filePath);
      fileName = `${baseName}-v${counter}${extension}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return { fileName, filePath };
      throw error;
    }
  }
}

function parseDataUrl(src) {
  const match = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s.exec(src);
  if (!match) return null;
  const mimeType = match[1] || "application/octet-stream";
  const encoded = match[2];
  const isBase64 = /^data:[^,]*;base64,/i.test(src);
  const buffer = isBase64 ? Buffer.from(encoded, "base64") : Buffer.from(decodeURIComponent(encoded));
  return { buffer, mimeType };
}

function localAssetFilePathFromUrl(src, args = {}) {
  let route = null;
  let baseDir = null;
  if (src.startsWith(GLOBAL_ASSETS_ROUTE)) {
    route = GLOBAL_ASSETS_ROUTE;
    baseDir = canvasAssetsDir(args);
  } else if (src.startsWith(PAGE_ASSETS_ROUTE)) {
    const parts = src.slice(PAGE_ASSETS_ROUTE.length).split("/");
    const pageDir = decodeURIComponent(parts.shift() ?? "");
    if (!pageDir || parts.length === 0) return null;
    const assetDir = join(canvasPagesDir(args), pageDir, "assets");
    const filePath = resolve(assetDir, ...parts.map(decodeURIComponent));
    return isSafeChildPath(assetDir, filePath) ? filePath : null;
  } else {
    return null;
  }

  const requestedPath = decodeURIComponent(src.slice(route.length));
  const filePath = resolve(baseDir, requestedPath);
  return isSafeChildPath(baseDir, filePath) ? filePath : null;
}

function stringSet(value) {
  return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
}

function getImageShapeRefs(snapshot) {
  if (!isCanvasSnapshot(snapshot)) return [];

  const refs = [];
  for (const page of getPageRecords(snapshot)) {
    for (const shape of getShapeRecordsForPage(snapshot, page.id)) {
      if (shape?.typeName !== "shape" || shape.type !== "image") continue;

      const assetId = typeof shape.props?.assetId === "string" ? shape.props.assetId : null;
      const asset = assetId ? snapshot.store[assetId] : null;
      refs.push({
        pageId: page.id,
        shapeId: shape.id,
        assetId,
        assetSrc: typeof asset?.props?.src === "string" ? asset.props.src : null,
        assetName: typeof asset?.props?.name === "string" ? asset.props.name : null,
      });
    }
  }
  return refs;
}

async function hasRecoverableImagePayload(args, imageRef) {
  if (typeof imageRef.assetSrc !== "string") return false;
  if (imageRef.assetSrc.startsWith("data:")) return true;

  const filePath = localAssetFilePathFromUrl(imageRef.assetSrc, args);
  if (!filePath) return false;

  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function getUnacknowledgedImageLosses(args, previousSnapshot, nextSnapshot) {
  if (!args.protectImageRecords) return [];

  const acknowledgedDeletes = stringSet(args.acknowledgedImageShapeDeletes);
  const nextImageShapeIds = new Set(getImageShapeRefs(nextSnapshot).map((ref) => ref.shapeId));
  const losses = [];

  for (const imageRef of getImageShapeRefs(previousSnapshot)) {
    if (nextImageShapeIds.has(imageRef.shapeId)) continue;
    if (acknowledgedDeletes.has(imageRef.shapeId)) continue;
    if (!(await hasRecoverableImagePayload(args, imageRef))) continue;
    losses.push(imageRef);
  }

  return losses;
}

async function localizePageAsset(args, asset, pageId) {
  const src = asset?.props?.src;
  if (!src || typeof src !== "string" || /^https?:\/\//.test(src)) return asset;

  const currentPagePrefix = `${PAGE_ASSETS_ROUTE}${pageDirName(pageId)}/`;
  if (src.startsWith(currentPagePrefix)) return asset;

  const localizedAsset = cloneJson(asset);
  const dataUrl = src.startsWith("data:") ? parseDataUrl(src) : null;
  const sourceFilePath = dataUrl ? null : localAssetFilePathFromUrl(src, args);
  if (!dataUrl && !sourceFilePath) return localizedAsset;

  const fileName = sanitizeAssetFileName(
    dataUrl ? null : localizedAsset.props.name,
    sourceFilePath ? basename(sourceFilePath) : localizedAsset.id.replace(":", "-"),
    dataUrl?.mimeType ?? localizedAsset.props.mimeType,
  );
  const destinationDir = pageAssetsDir(args, pageId);
  const destinationPath = join(destinationDir, fileName);

  await mkdir(destinationDir, { recursive: true });
  if (dataUrl) {
    await writeFile(destinationPath, dataUrl.buffer);
    localizedAsset.props.mimeType = localizedAsset.props.mimeType ?? dataUrl.mimeType;
    localizedAsset.props.fileSize = dataUrl.buffer.length;
  } else if (resolve(sourceFilePath) !== resolve(destinationPath)) {
    await copyFile(sourceFilePath, destinationPath);
    localizedAsset.props.fileSize = (await stat(destinationPath)).size;
  }

  localizedAsset.props.name = fileName;
  localizedAsset.props.src = pageAssetUrl(pageId, fileName);
  return localizedAsset;
}

async function localizePageAssets(args, pageSnapshot, pageId) {
  const entries = await Promise.all(
    Object.entries(pageSnapshot.store).map(async ([id, record]) => {
      if (record?.typeName !== "asset") return [id, record];
      return [id, await localizePageAsset(args, record, pageId)];
    }),
  );
  return {
    ...pageSnapshot,
    store: Object.fromEntries(entries),
  };
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readPageSnapshots(args = {}) {
  let manifest = null;
  try {
    manifest = await readJsonFile(pagesManifestFile(args));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (manifest) {
    if (!Array.isArray(manifest.pages)) throw new Error(`Invalid pages manifest in ${pagesManifestFile(args)}`);
    const snapshots = [];
    for (const page of manifest.pages) {
      const filePath = pageFilePath(args, page.id);
      const snapshot = await readJsonFile(filePath);
      if (!isCanvasSnapshot(snapshot)) {
        throw new Error(`Invalid canvas snapshot in ${filePath}`);
      }
      snapshots.push({ filePath, snapshot });
    }
    return snapshots;
  }

  let entries;
  try {
    entries = await readdir(canvasPagesDir(args), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = join(canvasPagesDir(args), entry.name, CANVAS_FILE_NAME);
    try {
      const snapshot = await readJsonFile(filePath);
      if (isCanvasSnapshot(snapshot)) snapshots.push({ filePath, snapshot });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return snapshots;
}

async function loadStoredCanvasSnapshot(args = {}) {
  const canvasId = nonEmptyString(args.canvasId);
  if (canvasId) {
    const sceneFile = excalidrawCanvasFile(args, canvasId);
    try {
      const snapshot = await readJsonFile(sceneFile);
      if (!isExcalidrawSnapshot(snapshot)) {
        const error = new Error(`Invalid Excalidraw document in ${sceneFile}`);
        error.code = "COWART_CANVAS_SCENE_INVALID";
        throw error;
      }
      return {
        snapshot,
        path: sceneFile,
        storage: "excalidraw",
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const missing = new Error(`Canvas ${canvasId} has no stored Excalidraw scene at ${sceneFile}.`);
      missing.code = "COWART_CANVAS_SCENE_NOT_FOUND";
      missing.canvasId = canvasId;
      missing.path = sceneFile;
      throw missing;
    }
  }

  try {
    const sceneFile = legacyExcalidrawFile(args);
    const snapshot = await readJsonFile(sceneFile);
    if (!isExcalidrawSnapshot(snapshot)) {
      throw new Error(`Invalid Excalidraw document in ${sceneFile}`);
    }
    return {
      snapshot,
      path: sceneFile,
      storage: "excalidraw",
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const pageSnapshots = await readPageSnapshots(args);
  if (pageSnapshots.length > 0) {
    const [{ snapshot: firstSnapshot }] = pageSnapshots;
    const mergedSnapshot = {
      schema: firstSnapshot.schema,
      store: {},
    };

    for (const { snapshot } of pageSnapshots) {
      Object.assign(mergedSnapshot.store, snapshot.store);
    }
    return {
      snapshot: mergedSnapshot,
      path: canvasPagesDir(args),
      storage: "per-page",
    };
  }

  try {
    return {
      snapshot: await readJsonFile(canvasFile(args)),
      path: canvasFile(args),
      storage: "legacy-single-file",
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { snapshot: null, path: canvasPagesDir(args), storage: "empty" };
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`);
  await rename(tempFile, filePath);
}

async function saveStoredCanvasSnapshot(args, snapshot) {
  if (isExcalidrawSnapshot(snapshot)) {
    const sceneFile = nonEmptyString(args.canvasId)
      ? excalidrawCanvasFile(args, args.canvasId)
      : legacyExcalidrawFile(args);
    await writeJsonAtomic(sceneFile, snapshot);
    return { storage: "excalidraw", paths: [sceneFile] };
  }

  const pages = getPageRecords(snapshot);
  if (pages.length === 0) {
    await writeJsonAtomic(canvasFile(args), snapshot);
    return { storage: "legacy-single-file", paths: [canvasFile(args)] };
  }

  let previousManifest = null;
  try {
    previousManifest = await readJsonFile(pagesManifestFile(args));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const paths = [];
  for (const page of pages) {
    const filePath = pageFilePath(args, page.id);
    const pageSnapshot = await localizePageAssets(args, snapshotForPage(snapshot, page), page.id);
    await writeJsonAtomic(filePath, pageSnapshot);
    paths.push(filePath);
  }

  const manifest = {
    version: 1,
    source: "cowart",
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      index: page.index,
      path: relative(resolveCanvasDir(args), pageFilePath(args, page.id)),
    })),
  };
  await writeJsonAtomic(pagesManifestFile(args), manifest);

  const currentPageIds = new Set(pages.map((page) => page.id));
  for (const previousPage of previousManifest?.pages ?? []) {
    if (!nonEmptyString(previousPage?.id) || currentPageIds.has(previousPage.id)) continue;
    await rm(dirname(pageFilePath(args, previousPage.id)), { recursive: true, force: true });
  }

  return { storage: "per-page", paths };
}

async function hydrateSnapshotAssets(args, snapshot) {
  if (!snapshot) return { snapshot, hydratedAssets: [] };
  if (isExcalidrawSnapshot(snapshot)) {
    return { snapshot: cloneJson(snapshot), hydratedAssets: [] };
  }

  const hydrated = cloneJson(snapshot);
  const hydratedAssets = [];

  for (const record of Object.values(hydrated.store)) {
    if (record?.typeName !== "asset" || record.type !== "image") continue;
    const src = record.props?.src;
    if (typeof src !== "string" || src.startsWith("data:") || /^https?:\/\//.test(src)) continue;

    const filePath = localAssetFilePathFromUrl(src, args);
    if (!filePath) continue;

    try {
      const buffer = await readFile(filePath);
      const mimeType = record.props.mimeType || mimeTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream";
      record.props.src = `data:${mimeType};base64,${buffer.toString("base64")}`;
      record.props.mimeType = mimeType;
      record.props.fileSize = record.props.fileSize ?? buffer.length;
      hydratedAssets.push({ assetId: record.id, source: src, filePath });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return { snapshot: hydrated, hydratedAssets };
}

export async function writeCowartPageAsset(args = {}, options = {}) {
  const pageId = nonEmptyString(options.pageId);
  if (!pageId) throw new Error("pageId is required to save a Cowart page asset.");

  const dataUrl = nonEmptyString(options.dataUrl);
  const dataBase64 = nonEmptyString(options.dataBase64);
  let parsed = null;
  if (dataUrl) {
    parsed = parseDataUrl(dataUrl);
  } else if (dataBase64) {
    parsed = {
      buffer: Buffer.from(dataBase64, "base64"),
      mimeType: nonEmptyString(options.mimeType) || "application/octet-stream",
    };
  }
  if (!parsed?.buffer?.length) {
    throw new Error("Expected a non-empty dataUrl or dataBase64 image payload.");
  }

  const mimeType = nonEmptyString(options.mimeType) || parsed.mimeType || "application/octet-stream";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Cowart page assets only accept image payloads. Received ${mimeType}.`);
  }

  const canvasDir = resolveCanvasDir(args);
  const destinationDir = pageAssetsDir(args, pageId);
  if (!isSafeChildPath(canvasDir, destinationDir)) {
    throw new Error(`Unsafe Cowart page assets directory: ${destinationDir}`);
  }

  const requestedName = sanitizeAssetFileName(
    options.fileName,
    `reference-${Date.now()}`,
    mimeType,
  );
  const { fileName, filePath } = await uniqueAssetFilePath(destinationDir, requestedName);
  await mkdir(destinationDir, { recursive: true });
  await writeFile(filePath, parsed.buffer);

  return {
    ok: true,
    canvasDir,
    pageId,
    fileName,
    assetPath: filePath,
    assetUrl: pageAssetUrl(pageId, fileName),
    mimeType,
    fileSize: parsed.buffer.length,
  };
}

export async function readCowartPageAsset(args = {}, options = {}) {
  const assetUrl = nonEmptyString(options.assetUrl);
  if (!assetUrl) throw new Error("assetUrl is required to read a Cowart page asset.");
  if (!assetUrl.startsWith(PAGE_ASSETS_ROUTE) && !assetUrl.startsWith(GLOBAL_ASSETS_ROUTE)) {
    throw new Error(`Unsupported Cowart asset URL: ${assetUrl}`);
  }

  const filePath = localAssetFilePathFromUrl(assetUrl, args);
  if (!filePath) throw new Error(`Unsafe Cowart asset URL: ${assetUrl}`);

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error(`Cowart asset is not a file: ${assetUrl}`);

  const mimeType = mimeTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream";
  if (!mimeType.startsWith("image/") && mimeType !== "text/html") {
    throw new Error(`Cowart page assets only expose image or HTML payloads. Received ${mimeType}.`);
  }

  const buffer = await readFile(filePath);
  return {
    ok: true,
    canvasDir: resolveCanvasDir(args),
    assetUrl,
    assetPath: filePath,
    mimeType,
    fileSize: fileStat.size,
    dataBase64: buffer.toString("base64"),
  };
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function canvasProjectStorage() {
  // canvas-project-storage imports resolveCowartPaths from this module. Keep
  // this edge dynamic so both modules can initialize without a static cycle.
  return import("./canvas-project-storage.mjs");
}

function selectProjectCanvas(project, requestedCanvasId, { requireExplicitCanvasId = false } = {}) {
  const explicitCanvasId = nonEmptyString(requestedCanvasId);
  if (requireExplicitCanvasId && project.canvases.length > 1 && !explicitCanvasId) {
    throw canvasStorageError(
      "COWART_CANVAS_ID_REQUIRED",
      "canvasId is required when a Yogurt AI project contains more than one canvas.",
      { activeCanvasId: project.activeCanvasId, canvasCount: project.canvases.length },
    );
  }

  const canvasId = assertExcalidrawCanvasId(explicitCanvasId || project.activeCanvasId);
  const canvas = project.canvases.find((entry) => entry.id === canvasId);
  if (!canvas) {
    throw canvasStorageError(
      "COWART_CANVAS_NOT_FOUND",
      `Unknown Yogurt AI canvas: ${canvasId}.`,
      { canvasId },
    );
  }
  return { canvasId, canvas };
}

function legacyCanvasName(snapshot) {
  if (isExcalidrawSnapshot(snapshot)) {
    return nonEmptyString(snapshot.appState?.name) || "主画布";
  }
  if (isCanvasSnapshot(snapshot)) {
    return nonEmptyString(getPageRecords(snapshot)[0]?.name) || "主画布";
  }
  return "主画布";
}

function legacyText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map(legacyText)
    .filter(Boolean)
    .join(value.type === "doc" ? "\n" : "");
}

function legacyShapeText(shape) {
  const props = shape?.props ?? {};
  return [
    legacyText(props.richText),
    typeof props.text === "string" ? props.text : "",
    typeof props.label === "string" ? props.label : "",
    typeof props.name === "string" ? props.name : "",
  ].find((value) => value.trim()) ?? "";
}

function legacyColor(value, fallback = "#1b1b1f") {
  const colors = {
    black: "#1b1b1f",
    blue: "#1e1aa8",
    green: "#087f5b",
    grey: "#868e96",
    gray: "#868e96",
    lightblue: "#4dabf7",
    lightgreen: "#69db7c",
    lightred: "#ffa8a8",
    lightviolet: "#d0bfff",
    orange: "#e8590c",
    red: "#c92a2a",
    violet: "#7048e8",
    white: "#ffffff",
    yellow: "#f08c00",
  };
  const raw = String(value || "").trim();
  const normalized = raw.toLowerCase().replace(/[^a-z]/g, "");
  return colors[normalized] || (raw.startsWith("#") ? raw : fallback);
}

function stableElementNumber(value, salt) {
  const digest = createHash("sha256").update(`${salt}:${String(value)}`).digest();
  return Math.max(1, digest.readUInt32BE(0));
}

function legacyShapePosition(store, shape, pageOffsets, cache = new Map(), visited = new Set()) {
  if (cache.has(shape.id)) return cache.get(shape.id);
  if (visited.has(shape.id)) return { x: Number(shape.x) || 0, y: Number(shape.y) || 0 };
  visited.add(shape.id);
  let x = Number(shape.x) || 0;
  let y = Number(shape.y) || 0;
  const parent = store[shape.parentId];
  if (parent?.typeName === "shape") {
    const parentPosition = legacyShapePosition(store, parent, pageOffsets, cache, visited);
    x += parentPosition.x;
    y += parentPosition.y;
  } else if (parent?.typeName === "page") {
    x += pageOffsets.get(parent.id) ?? 0;
  }
  visited.delete(shape.id);
  const position = { x, y };
  cache.set(shape.id, position);
  return position;
}

function legacyFontSize(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(8, value);
  if (value === "xl") return 32;
  if (value === "l") return 28;
  if (value === "s") return 16;
  return 20;
}

function legacyStrokeWidth(value) {
  if (value === "xl") return 4;
  if (value === "l") return 3;
  if (value === "m") return 2;
  return 1;
}

function legacyElementBase(snapshot, shape, position, type) {
  const props = shape.props ?? {};
  const parent = snapshot.store[shape.parentId];
  const width = Math.max(16, Number(props.w) || 240);
  const height = Math.max(16, Number(props.h) || 140);
  return {
    id: String(shape.id),
    type,
    x: position.x,
    y: position.y,
    width,
    height,
    angle: Number(shape.rotation) || 0,
    strokeColor: legacyColor(props.color),
    backgroundColor: props.fill === "none"
      ? "transparent"
      : legacyColor(props.color, "#ffffff"),
    fillStyle: props.fill === "solid" ? "solid" : "hachure",
    strokeWidth: legacyStrokeWidth(props.size),
    strokeStyle: props.dash === "dashed"
      ? "dashed"
      : props.dash === "dotted" ? "dotted" : "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: parent?.type === "frame" ? parent.id : null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: stableElementNumber(shape.id, "seed"),
    version: 1,
    versionNonce: stableElementNumber(shape.id, "nonce"),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: typeof props.url === "string" && props.url ? props.url : null,
    locked: Boolean(shape.isLocked),
    customData: {
      yogurt: {
        migratedFrom: "tldraw",
        originalType: shape.type,
        originalRecord: cloneJson(shape),
      },
    },
  };
}

function migratedTextElement(snapshot, shape, position) {
  const props = shape.props ?? {};
  const text = legacyShapeText(shape) || " ";
  const fontSize = legacyFontSize(props.size);
  return {
    ...legacyElementBase(snapshot, shape, position, "text"),
    text,
    originalText: text,
    fontSize,
    fontFamily: props.font === "mono" ? 3 : props.font === "sans" ? 2 : 1,
    textAlign: props.textAlign === "end" ? "right" : props.textAlign === "middle" ? "center" : "left",
    verticalAlign: "top",
    baseline: Math.round(fontSize * 1.25),
    lineHeight: 1.25,
    containerId: null,
    autoResize: true,
    backgroundColor: "transparent",
    fillStyle: "solid",
    roundness: null,
  };
}

function migratedArrowElement(snapshot, shape, position) {
  const props = shape.props ?? {};
  const start = props.start ?? { x: 0, y: 0 };
  const end = props.end ?? { x: 240, y: 0 };
  const x = position.x + (Number(start.x) || 0);
  const y = position.y + (Number(start.y) || 0);
  const dx = (Number(end.x) || 240) - (Number(start.x) || 0);
  const dy = (Number(end.y) || 0) - (Number(start.y) || 0);
  return {
    ...legacyElementBase(snapshot, shape, { x, y }, "arrow"),
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [[0, 0], [dx, dy]],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: props.arrowheadStart === "none" ? null : props.arrowheadStart ?? null,
    endArrowhead: props.arrowheadEnd === "none" ? null : props.arrowheadEnd ?? "arrow",
    elbowed: false,
    backgroundColor: "transparent",
    fillStyle: "solid",
    roundness: { type: 2 },
  };
}

// This server-safe migration intentionally keeps the complete source snapshot
// in document metadata, even for record types that can only be represented as
// a generic Excalidraw box. Legacy files also remain untouched on disk.
export function migrateLegacyTldrawSnapshotToExcalidraw(snapshot) {
  if (!isCanvasSnapshot(snapshot)) {
    return {
      type: "excalidraw",
      version: 2,
      source: "https://github.com/suud003/Cowart",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
  }

  const pages = getPageRecords(snapshot);
  const pageOffsets = new Map(pages.map((page, index) => [page.id, index * 1600]));
  const positions = new Map();
  const shapes = Object.values(snapshot.store)
    .filter((record) => record?.typeName === "shape")
    .sort((left, right) => {
      const leftFrame = left.type === "frame" ? 0 : 1;
      const rightFrame = right.type === "frame" ? 0 : 1;
      return leftFrame - rightFrame || String(left.index ?? left.id).localeCompare(String(right.index ?? right.id));
    });
  const elements = shapes.map((shape) => {
    const position = legacyShapePosition(snapshot.store, shape, pageOffsets, positions);
    if (shape.type === "text") return migratedTextElement(snapshot, shape, position);
    if (shape.type === "arrow") return migratedArrowElement(snapshot, shape, position);
    const props = shape.props ?? {};
    const type = shape.type === "frame"
      ? "frame"
      : shape.type === "geo" && ["ellipse", "diamond"].includes(props.geo)
        ? props.geo
        : "rectangle";
    const element = legacyElementBase(snapshot, shape, position, type);
    if (type === "frame") {
      element.name = legacyShapeText(shape) || "Frame";
      element.backgroundColor = "transparent";
      element.fillStyle = "solid";
      element.roundness = null;
    }
    const label = legacyShapeText(shape);
    if (label && type !== "frame") {
      element.customData.yogurt.visibleLabel = label;
    }
    return element;
  });

  return {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/suud003/Cowart",
    elements,
    appState: {
      viewBackgroundColor: "#ffffff",
      scrollToContent: elements.length > 0,
    },
    files: {},
    yogurt: {
      migratedFrom: "tldraw",
      legacyTldrawSnapshot: cloneJson(snapshot),
    },
  };
}

export async function readCowartLegacyMigrationSource(args = {}) {
  const legacyArgs = { ...args };
  delete legacyArgs.canvasId;
  const loaded = await loadStoredCanvasSnapshot(legacyArgs);
  if (!isCanvasSnapshot(loaded.snapshot) && loaded.snapshot !== null) return null;
  let sourceTimestamp = null;
  try {
    sourceTimestamp = new Date((await stat(loaded.path)).mtimeMs).toISOString();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    snapshot: cloneJson(loaded.snapshot),
    scene: migrateLegacyTldrawSnapshotToExcalidraw(loaded.snapshot),
    name: legacyCanvasName(loaded.snapshot),
    source: loaded.storage === "empty" ? "empty" : `legacy-${loaded.storage}`,
    sourceRevision: cowartSnapshotRevision(loaded.snapshot),
    sourceTimestamp,
    migrated: isCanvasSnapshot(loaded.snapshot),
  };
}

async function syntheticLegacyProject(snapshot) {
  const { CANVAS_PROJECT_TYPE, CANVAS_PROJECT_VERSION, canvasProjectRevision } = await canvasProjectStorage();
  const canvas = {
    id: DEFAULT_EXCALIDRAW_CANVAS_ID,
    name: legacyCanvasName(snapshot),
    parentId: null,
    order: 0,
    createdAt: null,
    updatedAt: null,
  };
  const project = {
    type: CANVAS_PROJECT_TYPE,
    version: CANVAS_PROJECT_VERSION,
    createdAt: null,
    updatedAt: null,
    activeCanvasId: canvas.id,
    canvases: [canvas],
  };
  return {
    project,
    projectRevision: canvasProjectRevision(project),
    canvas,
    canvasId: canvas.id,
    persisted: false,
  };
}

async function persistedProjectScope(args, options = {}) {
  const { readCowartCanvasProject } = await canvasProjectStorage();
  const result = await readCowartCanvasProject(args);
  const selected = selectProjectCanvas(result.project, args.canvasId, options);
  return {
    project: result.project,
    projectRevision: result.projectRevision,
    ...selected,
    persisted: true,
  };
}

async function readCanvasScope(args, { requireExplicitCanvasId = false } = {}) {
  const projectFile = canvasProjectFile(args);
  if (await fileExists(projectFile)) {
    const scope = await persistedProjectScope(args, { requireExplicitCanvasId });
    const storageArgs = { ...args, canvasId: scope.canvasId };
    return { scope, storageArgs, loaded: await loadStoredCanvasSnapshot(storageArgs) };
  }

  // Read the legacy store before creating project.json. A tldraw project may
  // still be in active use; eagerly creating an empty Excalidraw scene would
  // make those records disappear on the next read.
  const legacyArgs = { ...args };
  delete legacyArgs.canvasId;
  const legacy = await loadStoredCanvasSnapshot(legacyArgs);

  // Another process may have completed migration while the legacy read was in
  // flight. Honor project.json as the cutover marker if it now exists.
  if (await fileExists(projectFile)) {
    const scope = await persistedProjectScope(args, { requireExplicitCanvasId });
    const storageArgs = { ...args, canvasId: scope.canvasId };
    return { scope, storageArgs, loaded: await loadStoredCanvasSnapshot(storageArgs) };
  }

  if (isCanvasSnapshot(legacy.snapshot) || legacy.snapshot === null) {
    const scope = await syntheticLegacyProject(legacy.snapshot);
    selectProjectCanvas(scope.project, args.canvasId, { requireExplicitCanvasId });
    return { scope, storageArgs: legacyArgs, loaded: legacy };
  }

  // Legacy yogurt.excalidraw migrates lazily. The project module copies its
  // bytes exactly and writes
  // project.json last, so a failed migration cannot hide the old scene.
  const { ensureCowartCanvasProject } = await canvasProjectStorage();
  await ensureCowartCanvasProject(args);
  const scope = await persistedProjectScope(args, { requireExplicitCanvasId });
  const storageArgs = { ...args, canvasId: scope.canvasId };
  return { scope, storageArgs, loaded: await loadStoredCanvasSnapshot(storageArgs) };
}

function projectFields(scope) {
  return {
    canvasId: scope.canvasId,
    canvas: scope.canvas,
    project: scope.project,
    projectRevision: scope.projectRevision,
  };
}

async function assertCanvasStillExists(args, canvasId) {
  const projectFile = canvasProjectFile(args);
  let project;
  try {
    project = await readJsonFile(projectFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw canvasStorageError(
      "COWART_CANVAS_NOT_FOUND",
      `Canvas ${canvasId} no longer belongs to this Yogurt AI project.`,
      { canvasId },
    );
  }
  if (!Array.isArray(project?.canvases) || !project.canvases.some((canvas) => canvas?.id === canvasId)) {
    throw canvasStorageError(
      "COWART_CANVAS_NOT_FOUND",
      `Canvas ${canvasId} was deleted before its scene could be saved.`,
      { canvasId },
    );
  }
}

export async function readCowartCanvasState(
  args = {},
  { hydrateAssets = false, requireExplicitCanvasId = false } = {},
) {
  const { projectDir, canvasDir } = resolveCowartPaths(args);
  const { scope, storageArgs, loaded } = await readCanvasScope(args, { requireExplicitCanvasId });
  const hydrated = hydrateAssets
    ? await hydrateSnapshotAssets(storageArgs, loaded.snapshot)
    : { snapshot: loaded.snapshot, hydratedAssets: [] };
  const { viewState, viewStateFile } = await readCowartViewState(storageArgs);

  return {
    version: 1,
    projectDir,
    canvasDir,
    ...projectFields(scope),
    snapshot: hydrated.snapshot,
    revision: cowartSnapshotRevision(loaded.snapshot),
    path: loaded.path,
    storage: loaded.storage,
    viewState,
    viewStateFile,
    selectionFile: resolveSelectionFile(storageArgs),
    hydratedAssets: hydrated.hydratedAssets,
  };
}

export async function saveCowartCanvasSnapshot(args = {}, snapshot) {
  const sanitized = isExcalidrawSnapshot(snapshot)
    ? { snapshot: cloneJson(snapshot), skippedRecords: [] }
    : await import("../../src/canvasSnapshot.js")
      .then(({ sanitizeCanvasSnapshotForTldraw }) => sanitizeCanvasSnapshotForTldraw(snapshot));
  if (!sanitized.snapshot) {
    return {
      ok: false,
      storage: "invalid",
      paths: [],
      skippedRecords: sanitized.skippedRecords,
    };
  }

  let scope;
  let storageArgs = { ...args };
  let transitionRevision = null;
  let transitionTargetRevision = null;

  if (isExcalidrawSnapshot(sanitized.snapshot)) {
    const hadProject = await fileExists(canvasProjectFile(args));
    const requestedCanvasId = nonEmptyString(args.canvasId)
      ? assertExcalidrawCanvasId(args.canvasId)
      : null;
    if (!hadProject && requestedCanvasId && requestedCanvasId !== DEFAULT_EXCALIDRAW_CANVAS_ID) {
      throw canvasStorageError(
        "COWART_CANVAS_NOT_FOUND",
        `Unknown Yogurt AI canvas: ${requestedCanvasId}. Create it before saving its scene.`,
        { canvasId: requestedCanvasId },
      );
    }
    let legacyBeforeMigration = null;
    if (!hadProject) {
      const legacyArgs = { ...args };
      delete legacyArgs.canvasId;
      legacyBeforeMigration = await loadStoredCanvasSnapshot(legacyArgs);
    }

    const { ensureCowartCanvasProject } = await canvasProjectStorage();
    const ensured = await ensureCowartCanvasProject(args);
    scope = {
      project: ensured.project,
      projectRevision: ensured.projectRevision,
      ...selectProjectCanvas(ensured.project, args.canvasId),
      persisted: true,
    };
    storageArgs = { ...args, canvasId: scope.canvasId };

    // The first native Excalidraw save can be a conversion of a legacy tldraw
    // snapshot. Accept its tldraw base revision exactly once, but only while
    // the newly-created target scene is still byte-for-byte unchanged.
    if (
      ensured.created &&
      (isCanvasSnapshot(legacyBeforeMigration?.snapshot) || legacyBeforeMigration?.snapshot === null)
    ) {
      transitionRevision = cowartSnapshotRevision(legacyBeforeMigration.snapshot);
      transitionTargetRevision = cowartSnapshotRevision(
        (await loadStoredCanvasSnapshot(storageArgs)).snapshot,
      );
    }
  } else if (await fileExists(canvasProjectFile(args))) {
    scope = await persistedProjectScope(args);
  } else {
    const legacyArgs = { ...args };
    delete legacyArgs.canvasId;
    storageArgs = legacyArgs;
    const previous = await loadStoredCanvasSnapshot(legacyArgs);
    scope = await syntheticLegacyProject(previous.snapshot ?? sanitized.snapshot);
  }

  return serializeCanvasSave(storageArgs, async () => {
    if (scope.persisted) {
      await assertCanvasStillExists(storageArgs, scope.canvasId);
    }
    const previous = await loadStoredCanvasSnapshot(storageArgs);
    const currentRevision = cowartSnapshotRevision(previous.snapshot);
    const expectedRevision = nonEmptyString(args.baseRevision);
    const validTransition = Boolean(
      expectedRevision &&
      transitionRevision &&
      expectedRevision === transitionRevision &&
      currentRevision === transitionTargetRevision
    );
    if (expectedRevision && expectedRevision !== currentRevision && !validTransition) {
      return {
        ok: false,
        storage: "revision-conflict",
        paths: [],
        expectedRevision,
        currentRevision,
        skippedRecords: sanitized.skippedRecords,
        ...projectFields(scope),
        message: `Yogurt AI canvas changed from ${expectedRevision} to ${currentRevision}; reload and merge before saving.`,
      };
    }
    const imageLosses = await getUnacknowledgedImageLosses(
      storageArgs,
      previous.snapshot,
      sanitized.snapshot,
    );
    if (imageLosses.length > 0) {
      return {
        ok: false,
        storage: "blocked-destructive-image-loss",
        paths: [],
        skippedRecords: sanitized.skippedRecords,
        blockedImageLosses: imageLosses,
        ...projectFields(scope),
        message: `Yogurt AI refused to save because ${imageLosses.length} existing image shape(s) disappeared without a user delete confirmation.`,
      };
    }

    const result = await saveStoredCanvasSnapshot(storageArgs, sanitized.snapshot);
    const persisted = await loadStoredCanvasSnapshot(storageArgs);
    return {
      ok: true,
      ...result,
      ...projectFields(scope),
      baseRevision: currentRevision,
      // Persistence can normalize assets (for example, a data URL becomes a
      // page-local asset URL). Return the revision clients will observe on the
      // next read, not a hash of the pre-persistence in-memory representation.
      revision: cowartSnapshotRevision(persisted.snapshot),
      skippedRecords: sanitized.skippedRecords,
    };
  });
}

export async function readCowartSelectionState(args = {}) {
  const selectionFile = resolveSelectionFile(args);
  try {
    const selection = await readJsonFile(selectionFile);
    if (!isSelectionState(selection)) {
      throw new Error(`Invalid selection state in ${selectionFile}`);
    }
    return { selection, selectionFile };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        selection: { selectedShapes: [], updatedAt: null },
        selectionFile,
      };
    }
    throw error;
  }
}

export async function writeCowartSelectionState(args = {}, selection) {
  if (!isSelectionState(selection)) {
    throw new Error("Expected a Cowart selection state.");
  }
  const selectionFile = resolveSelectionFile(args);
  const payload = {
    ...selection,
    updatedAt: selection.updatedAt ?? new Date().toISOString(),
  };
  const persist = async () => {
    if (nonEmptyString(args.canvasId)) {
      await assertCanvasStillExists(args, args.canvasId);
    }
    await writeJsonAtomic(selectionFile, payload);
    return { ok: true, path: selectionFile, selection: payload };
  };
  return nonEmptyString(args.canvasId)
    ? serializeCanvasSave(args, persist)
    : persist();
}

export async function readCowartViewState(args = {}) {
  const viewStateFile = resolveViewStateFile(args);
  try {
    const viewState = await readJsonFile(viewStateFile);
    return { viewState: isViewState(viewState) ? viewState : defaultViewState(), viewStateFile };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { viewState: defaultViewState(), viewStateFile };
    }
    throw error;
  }
}

export async function writeCowartViewState(args = {}, viewState) {
  if (!isViewState(viewState)) {
    throw new Error("Expected a Cowart view state.");
  }
  const viewStateFile = resolveViewStateFile(args);
  const payload = {
    ...viewState,
    updatedAt: viewState.updatedAt ?? new Date().toISOString(),
  };
  const persist = async () => {
    if (nonEmptyString(args.canvasId)) {
      await assertCanvasStillExists(args, args.canvasId);
    }
    await writeJsonAtomic(viewStateFile, payload);
    return { ok: true, path: viewStateFile, viewState: payload };
  };
  return nonEmptyString(args.canvasId)
    ? serializeCanvasSave(args, persist)
    : persist();
}
