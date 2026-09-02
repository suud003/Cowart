import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readCowartCanvasState,
  saveCowartCanvasSnapshot,
  withCowartCanvasSaveTransaction,
} from "../mcp/lib/canvas-storage.mjs";
import {
  DEFAULT_CANVAS_ID,
  canvasProjectRevision,
  createCowartCanvas,
  deleteCowartCanvas,
  ensureCowartCanvasProject,
  readCowartCanvasProject,
  resolveCowartCanvasPaths,
  setActiveCowartCanvas,
  updateCowartCanvas,
} from "../mcp/lib/canvas-project-storage.mjs";

function legacyScene(name = "Legacy board") {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [{ id: "legacy-shape", type: "rectangle", x: 10, y: 20, width: 100, height: 80 }],
    appState: { name, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

async function temporaryProject(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function seedLegacyTldraw(projectDir) {
  const snapshot = {
    schema: { schemaVersion: 2, sequences: {} },
    store: {
      "page:test": {
        id: "page:test",
        typeName: "page",
        name: "Legacy ideas",
        index: "a0",
        meta: {},
      },
      "shape:keep-me": {
        id: "shape:keep-me",
        typeName: "shape",
        type: "geo",
        parentId: "page:test",
        index: "a1",
        x: 40,
        y: 60,
        rotation: 0,
        isLocked: false,
        props: {
          w: 240,
          h: 120,
          geo: "rectangle",
          color: "blue",
          fill: "solid",
          text: "Keep this source idea",
        },
        meta: { source: "legacy-test" },
      },
    },
  };
  const pagesDir = path.join(projectDir, "canvas", "pages");
  const pageDir = path.join(pagesDir, "test");
  await mkdir(pageDir, { recursive: true });
  const pageFile = path.join(pageDir, "cowart-canvas.json");
  const sourceBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFile(pageFile, sourceBytes);
  await writeFile(path.join(pagesDir, "manifest.json"), `${JSON.stringify({
    version: 1,
    source: "cowart",
    pages: [{ id: "page:test", name: "Legacy ideas", index: "a0" }],
  }, null, 2)}\n`);
  return { snapshot, pageFile, sourceBytes };
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (true) {
    try {
      await stat(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function spawnProjectCreate({ projectDir, canvasId, baseProjectRevision, barrierFile, readyFile }) {
  const moduleUrl = new URL("../mcp/lib/canvas-project-storage.mjs", import.meta.url).href;
  const script = `
    import { existsSync } from "node:fs";
    import { writeFile } from "node:fs/promises";
    import { createCowartCanvas } from ${JSON.stringify(moduleUrl)};
    const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
    await writeFile(process.env.COWART_READY_FILE, "ready");
    while (!existsSync(process.env.COWART_BARRIER_FILE)) await delay(10);
    try {
      const result = await createCowartCanvas(
        { projectDir: process.env.COWART_TEST_PROJECT_DIR },
        {
          canvasId: process.env.COWART_TEST_CANVAS_ID,
          baseProjectRevision: process.env.COWART_TEST_BASE_REVISION,
        },
      );
      console.log(JSON.stringify({ ok: true, projectRevision: result.projectRevision }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error?.code, message: error?.message }));
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      COWART_TEST_PROJECT_DIR: projectDir,
      COWART_TEST_CANVAS_ID: canvasId,
      COWART_TEST_BASE_REVISION: baseProjectRevision,
      COWART_BARRIER_FILE: barrierFile,
      COWART_READY_FILE: readyFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = new Promise((resolveResult, rejectResult) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectResult);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectResult(new Error(`Project create child exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) {
        rejectResult(new Error(`Project create child returned no result: ${stderr}`));
        return;
      }
      resolveResult(JSON.parse(line));
    });
  });
  return { child, result };
}

test("resolves safe per-canvas paths and rejects path-like IDs", async () => {
  const projectDir = await temporaryProject("yogurt-project-paths-");
  try {
    const paths = resolveCowartCanvasPaths({ projectDir }, "canvas_child-1");
    assert.equal(paths.canvasRootDir, path.join(projectDir, "canvas"));
    assert.equal(paths.canvasDir, path.join(projectDir, "canvas", "canvases", "canvas_child-1"));
    assert.equal(paths.sceneFile, path.join(projectDir, "canvas", "canvases", "canvas_child-1", "scene.excalidraw"));
    assert.equal(paths.selectionFile, path.join(projectDir, "canvas", "canvases", "canvas_child-1", "selection.json"));
    assert.throws(
      () => resolveCowartCanvasPaths({ projectDir }, "../outside"),
      (error) => error.code === "COWART_CANVAS_ID_INVALID",
    );
    assert.throws(
      () => resolveCowartCanvasPaths({ projectDir }, "canvas_CASE_ALIAS"),
      (error) => error.code === "COWART_CANVAS_ID_INVALID",
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("lazy migration copies legacy Excalidraw bytes exactly and commits project.json last", async () => {
  const projectDir = await temporaryProject("yogurt-project-migration-");
  try {
    const canvasDir = path.join(projectDir, "canvas");
    const legacyFile = path.join(canvasDir, "yogurt.excalidraw");
    const legacySelection = path.join(canvasDir, "cowart-selection.json");
    const rawLegacy = Buffer.from(` {\n  "type": "excalidraw",\n  "version": 2,\n  "source": "https://excalidraw.com",\n  "elements": [],\n  "appState": { "name": "Migrated root" },\n  "files": {}\n}\n`, "utf8");
    await mkdir(canvasDir, { recursive: true });
    await writeFile(legacyFile, rawLegacy);
    await writeFile(legacySelection, "{\"selectedShapes\":[]}\n");

    const migrated = await ensureCowartCanvasProject({ projectDir });
    const target = resolveCowartCanvasPaths({ projectDir }, DEFAULT_CANVAS_ID);
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.project.activeCanvasId, DEFAULT_CANVAS_ID);
    assert.equal(migrated.canvas.name, "Migrated root");
    assert.deepEqual(await readFile(target.sceneFile), rawLegacy);
    assert.equal(await readFile(legacyFile, "utf8"), rawLegacy.toString("utf8"));
    assert.equal(await readFile(target.selectionFile, "utf8"), "{\"selectedShapes\":[]}\n");

    const sceneStat = await stat(target.sceneFile);
    const projectStat = await stat(path.join(canvasDir, "project.json"));
    assert.ok(projectStat.mtimeMs >= sceneStat.mtimeMs);

    const repeated = await ensureCowartCanvasProject({ projectDir });
    assert.equal(repeated.migrated, false);
    assert.equal(repeated.projectRevision, migrated.projectRevision);
    assert.deepEqual(await readFile(target.sceneFile), rawLegacy);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("invalid project metadata never falls back to or overwrites legacy content", async () => {
  const projectDir = await temporaryProject("yogurt-project-invalid-index-");
  try {
    const canvasDir = path.join(projectDir, "canvas");
    await mkdir(canvasDir, { recursive: true });
    await writeFile(path.join(canvasDir, "project.json"), "{not valid json\n");
    const legacyFile = path.join(canvasDir, "yogurt.excalidraw");
    const legacyBytes = Buffer.from(`${JSON.stringify(legacyScene())}\n`);
    await writeFile(legacyFile, legacyBytes);

    await assert.rejects(
      ensureCowartCanvasProject({ projectDir }),
      (error) => error.code === "COWART_CANVAS_PROJECT_INVALID",
    );
    assert.deepEqual(await readFile(legacyFile), legacyBytes);
    await assert.rejects(stat(resolveCowartCanvasPaths({ projectDir }, DEFAULT_CANVAS_ID).sceneFile), {
      code: "ENOENT",
    });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("migration refuses to overwrite a different orphaned default scene", async () => {
  const projectDir = await temporaryProject("yogurt-project-migration-conflict-");
  try {
    const canvasDir = path.join(projectDir, "canvas");
    const target = resolveCowartCanvasPaths({ projectDir }, DEFAULT_CANVAS_ID);
    await mkdir(path.dirname(target.sceneFile), { recursive: true });
    const orphanBytes = Buffer.from(`${JSON.stringify(legacyScene("Orphan"))}\n`);
    const legacyBytes = Buffer.from(`${JSON.stringify(legacyScene("Legacy"))}\n`);
    await writeFile(target.sceneFile, orphanBytes);
    await writeFile(path.join(canvasDir, "yogurt.excalidraw"), legacyBytes);

    await assert.rejects(
      ensureCowartCanvasProject({ projectDir }),
      (error) => error.code === "COWART_CANVAS_MIGRATION_CONFLICT",
    );
    assert.deepEqual(await readFile(target.sceneFile), orphanBytes);
    await assert.rejects(stat(path.join(canvasDir, "project.json")), { code: "ENOENT" });
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("first hierarchy mutation materializes an empty project without synthetic CAS conflict", async () => {
  const projectDir = await temporaryProject("yogurt-project-empty-first-mutation-");
  try {
    const initial = await readCowartCanvasState({ projectDir });
    assert.equal(initial.project.createdAt, null);

    const created = await createCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_child",
        name: "Child",
        parentId: DEFAULT_CANVAS_ID,
        baseProjectRevision: initial.projectRevision,
      },
    );
    assert.equal(created.project.canvases.length, 2);
    assert.equal(created.project.activeCanvasId, "canvas_child");
    assert.equal(created.project.migration?.sourceProjectRevision, undefined);

    const root = await readCowartCanvasState({ projectDir, canvasId: DEFAULT_CANVAS_ID });
    assert.equal(root.snapshot.type, "excalidraw");
    assert.deepEqual(root.snapshot.elements, []);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("first hierarchy mutation converts legacy tldraw before project.json cutover and preserves source", async () => {
  const projectDir = await temporaryProject("yogurt-project-tldraw-first-mutation-");
  try {
    const legacy = await seedLegacyTldraw(projectDir);
    const initial = await readCowartCanvasState({ projectDir });
    assert.equal(initial.storage, "per-page");
    assert.equal(initial.snapshot.store["shape:keep-me"].props.text, "Keep this source idea");

    const created = await createCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_child",
        name: "Child",
        parentId: DEFAULT_CANVAS_ID,
        baseProjectRevision: initial.projectRevision,
      },
    );
    assert.equal(created.project.canvases.length, 2);

    const root = await readCowartCanvasState({ projectDir, canvasId: DEFAULT_CANVAS_ID });
    assert.equal(root.snapshot.type, "excalidraw");
    assert.ok(root.snapshot.elements.some((element) => element.id === "shape:keep-me"));
    assert.deepEqual(root.snapshot.yogurt?.legacyTldrawSnapshot, legacy.snapshot);
    assert.deepEqual(await readFile(legacy.pageFile), legacy.sourceBytes);

    const sceneStat = await stat(resolveCowartCanvasPaths({ projectDir }, DEFAULT_CANVAS_ID).sceneFile);
    const projectStat = await stat(path.join(projectDir, "canvas", "project.json"));
    assert.ok(projectStat.mtimeMs >= sceneStat.mtimeMs);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("project revision is independent from scene bytes", async () => {
  const projectDir = await temporaryProject("yogurt-project-revision-");
  try {
    const initial = await ensureCowartCanvasProject({ projectDir });
    const paths = resolveCowartCanvasPaths({ projectDir }, DEFAULT_CANVAS_ID);
    const changedScene = legacyScene("Scene-only change");
    await writeFile(paths.sceneFile, `${JSON.stringify(changedScene)}\n`);
    const afterSceneChange = await readCowartCanvasProject({ projectDir });
    assert.equal(afterSceneChange.projectRevision, initial.projectRevision);

    const reorderedObjectKeys = {
      canvases: initial.project.canvases.map((canvas) => ({
        updatedAt: canvas.updatedAt,
        order: canvas.order,
        parentId: canvas.parentId,
        name: canvas.name,
        id: canvas.id,
        createdAt: canvas.createdAt,
      })),
      activeCanvasId: initial.project.activeCanvasId,
      updatedAt: initial.project.updatedAt,
      createdAt: initial.project.createdAt,
      version: initial.project.version,
      type: initial.project.type,
      migration: initial.project.migration
        ? Object.fromEntries(Object.entries(initial.project.migration).reverse())
        : undefined,
    };
    assert.equal(canvasProjectRevision(reorderedObjectKeys), initial.projectRevision);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("creates, renames, reparents, reorders, and activates canvases with tree validation", async () => {
  const projectDir = await temporaryProject("yogurt-project-tree-");
  try {
    const initial = await ensureCowartCanvasProject({ projectDir });
    const child = await createCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_child",
        name: "Child",
        parentId: DEFAULT_CANVAS_ID,
        baseProjectRevision: initial.projectRevision,
      },
    );
    assert.equal(child.canvas.parentId, DEFAULT_CANVAS_ID);
    assert.equal(child.project.activeCanvasId, "canvas_child");

    const sibling = await createCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_sibling",
        name: "Sibling",
        parentId: DEFAULT_CANVAS_ID,
        order: 0,
        activate: false,
        baseProjectRevision: child.projectRevision,
      },
    );
    assert.deepEqual(
      sibling.project.canvases
        .filter((canvas) => canvas.parentId === DEFAULT_CANVAS_ID)
        .sort((left, right) => left.order - right.order)
        .map((canvas) => canvas.id),
      ["canvas_sibling", "canvas_child"],
    );

    const moved = await updateCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_child",
        name: "Renamed child",
        parentId: "canvas_sibling",
        baseProjectRevision: sibling.projectRevision,
      },
    );
    assert.equal(moved.canvas.name, "Renamed child");
    assert.equal(moved.canvas.parentId, "canvas_sibling");

    await assert.rejects(
      updateCowartCanvas(
        { projectDir },
        {
          canvasId: "canvas_sibling",
          parentId: "canvas_child",
          baseProjectRevision: moved.projectRevision,
        },
      ),
      (error) => error.code === "COWART_CANVAS_TREE_CYCLE",
    );

    const active = await setActiveCowartCanvas(
      { projectDir },
      { canvasId: DEFAULT_CANVAS_ID, baseProjectRevision: moved.projectRevision },
    );
    assert.equal(active.project.activeCanvasId, DEFAULT_CANVAS_ID);
    assert.equal(active.canvas.id, DEFAULT_CANVAS_ID);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("project CAS serializes concurrent hierarchy mutations", async () => {
  const projectDir = await temporaryProject("yogurt-project-cas-");
  try {
    const initial = await ensureCowartCanvasProject({ projectDir });
    const outcomes = await Promise.allSettled([
      createCowartCanvas(
        { projectDir },
        { canvasId: "canvas_first", baseProjectRevision: initial.projectRevision },
      ),
      createCowartCanvas(
        { projectDir },
        { canvasId: "canvas_second", baseProjectRevision: initial.projectRevision },
      ),
    ]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    const conflict = outcomes.find((result) => result.status === "rejected");
    assert.equal(conflict.reason.code, "COWART_PROJECT_REVISION_CONFLICT");

    const persisted = await readCowartCanvasProject({ projectDir });
    assert.equal(persisted.project.canvases.length, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("project CAS also has one winner across independent processes", { timeout: 30_000 }, async () => {
  const projectDir = await temporaryProject("yogurt-project-process-cas-");
  const barrierFile = path.join(projectDir, "start-project-writes");
  const children = [];
  try {
    const initial = await ensureCowartCanvasProject({ projectDir });
    children.push(
      spawnProjectCreate({
        projectDir,
        canvasId: "canvas_process_first",
        baseProjectRevision: initial.projectRevision,
        barrierFile,
        readyFile: path.join(projectDir, "ready-first"),
      }),
      spawnProjectCreate({
        projectDir,
        canvasId: "canvas_process_second",
        baseProjectRevision: initial.projectRevision,
        barrierFile,
        readyFile: path.join(projectDir, "ready-second"),
      }),
    );
    await Promise.all([
      waitForFile(path.join(projectDir, "ready-first")),
      waitForFile(path.join(projectDir, "ready-second")),
    ]);
    await writeFile(barrierFile, "go");
    const results = await Promise.all(children.map((entry) => entry.result));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(
      results.filter((result) => !result.ok && result.code === "COWART_PROJECT_REVISION_CONFLICT").length,
      1,
    );
    assert.equal((await readCowartCanvasProject({ projectDir })).project.canvases.length, 2);
  } finally {
    for (const entry of children) {
      if (entry.child.exitCode === null) entry.child.kill();
    }
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("delete refuses children by default and explicitly reparents them to the deleted parent", async () => {
  const projectDir = await temporaryProject("yogurt-project-delete-");
  try {
    const initial = await ensureCowartCanvasProject({ projectDir });
    const parent = await createCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_parent",
        name: "Parent",
        parentId: DEFAULT_CANVAS_ID,
        baseProjectRevision: initial.projectRevision,
      },
    );
    const child = await createCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_grandchild",
        name: "Grandchild",
        parentId: "canvas_parent",
        baseProjectRevision: parent.projectRevision,
      },
    );

    await assert.rejects(
      deleteCowartCanvas(
        { projectDir },
        { canvasId: "canvas_parent", baseProjectRevision: child.projectRevision },
      ),
      (error) => error.code === "COWART_CANVAS_HAS_CHILDREN",
    );

    const deleted = await deleteCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_parent",
        reparentChildren: true,
        baseProjectRevision: child.projectRevision,
      },
    );
    const grandchild = deleted.project.canvases.find((canvas) => canvas.id === "canvas_grandchild");
    assert.equal(grandchild.parentId, DEFAULT_CANVAS_ID);
    assert.equal(deleted.deletedCanvas.id, "canvas_parent");
    assert.ok(deleted.trashPath);
    await stat(deleted.trashPath);

    await deleteCowartCanvas(
      { projectDir },
      { canvasId: "canvas_grandchild", baseProjectRevision: deleted.projectRevision },
    );
    const rootOnly = await readCowartCanvasProject({ projectDir });
    await assert.rejects(
      deleteCowartCanvas(
        { projectDir },
        { canvasId: DEFAULT_CANVAS_ID, baseProjectRevision: rootOnly.projectRevision },
      ),
      (error) => error.code === "COWART_CANVAS_LAST_DELETE_REFUSED",
    );
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("delete and a queued scene save share one lock and cannot recreate an orphan canvas", async () => {
  const projectDir = await temporaryProject("yogurt-project-delete-save-race-");
  let releaseBlocker;
  try {
    const initial = await ensureCowartCanvasProject({ projectDir });
    const child = await createCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_child",
        name: "Child",
        parentId: DEFAULT_CANVAS_ID,
        baseProjectRevision: initial.projectRevision,
      },
    );
    const childState = await readCowartCanvasState({ projectDir, canvasId: "canvas_child" });

    let blockerStarted;
    const started = new Promise((resolveStarted) => { blockerStarted = resolveStarted; });
    const blocked = new Promise((resolveBlocked) => { releaseBlocker = resolveBlocked; });
    const blocker = withCowartCanvasSaveTransaction(
      { projectDir, canvasId: "canvas_child" },
      async () => {
        blockerStarted();
        await blocked;
      },
    );
    await started;

    const deleting = deleteCowartCanvas(
      { projectDir },
      {
        canvasId: "canvas_child",
        baseProjectRevision: child.projectRevision,
      },
    );
    await waitForFile(path.join(projectDir, "canvas", ".cowart-project.lock"));
    // The project lock proves delete is in its critical section. Give it one
    // turn to enqueue behind the held per-canvas lock before queuing the save.
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));

    const lateSave = saveCowartCanvasSnapshot(
      {
        projectDir,
        canvasId: "canvas_child",
        baseRevision: childState.revision,
      },
      legacyScene("Late save"),
    ).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );

    releaseBlocker();
    await blocker;
    const deleted = await deleting;
    const saveOutcome = await lateSave;
    assert.equal(deleted.deleted, true);
    assert.equal(saveOutcome.status, "rejected");
    assert.equal(saveOutcome.reason.code, "COWART_CANVAS_NOT_FOUND");
    await assert.rejects(
      stat(resolveCowartCanvasPaths({ projectDir }, "canvas_child").canvasDirectory),
      { code: "ENOENT" },
    );
    await stat(deleted.trashPath);
  } finally {
    releaseBlocker?.();
    await rm(projectDir, { recursive: true, force: true });
  }
});
