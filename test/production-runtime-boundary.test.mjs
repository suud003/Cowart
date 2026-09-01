import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  normalizeAutoComposeImageMetadata,
  snapshotRevision,
} from "../mcp/lib/canvas-runtime-helpers.mjs";
import {
  applyThinkingOperations,
  getThinkingContext,
} from "../mcp/lib/thinking-runtime.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

test("production dependencies use Excalidraw while tldraw remains development-only", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(packageJson.dependencies["@excalidraw/excalidraw"], "0.18.1");

  for (const packageName of ["tldraw", "@tldraw/assets", "@tldraw/store", "@tldraw/tlschema"]) {
    assert.equal(packageJson.dependencies[packageName], undefined, `${packageName} must not be a production dependency`);
    assert.ok(packageJson.devDependencies[packageName], `${packageName} must remain available for legacy development tests`);
  }
});

test("normal MCP startup does not statically load or reinstall the legacy tldraw runtime", async () => {
  const [serverSource, runtimeSource, startSource, startShellSource] = await Promise.all([
    read("mcp/server.mjs"),
    read("mcp/lib/thinking-runtime.mjs"),
    read("scripts/start-mcp.mjs"),
    read("scripts/start-mcp.sh"),
  ]);

  assert.match(serverSource, /from "\.\/lib\/canvas-runtime-helpers\.mjs"/);
  assert.doesNotMatch(serverSource, /from "\.\/lib\/thinking-canvas\.mjs"/);
  assert.doesNotMatch(runtimeSource, /^import .*from ["']\.\/thinking-canvas\.mjs["'];?$/m);
  assert.match(runtimeSource, /import\("\.\/thinking-canvas\.mjs"\)/);
  assert.doesNotMatch(startSource, /["'](?:tldraw|@tldraw\/[^"']+)["']/);
  assert.match(startSource, /"install", "--omit=dev"/);
  assert.doesNotMatch(startShellSource, /node_modules\/(?:tldraw|@tldraw\/)/);
  assert.match(startShellSource, /npm install --omit=dev/);
});

test("a fresh packaged-style workspace defaults to the Excalidraw runtime", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "yogurt-production-boundary-"));
  try {
    const context = await getThinkingContext({ projectDir }, { scope: "page" });
    assert.equal(context.runtime, "excalidraw");
    assert.equal(context.shapes.length, 0);

    const result = await applyThinkingOperations(
      { projectDir },
      {
        baseRevision: context.revision,
        operations: [{ type: "create_card", key: "first", title: "First native card" }],
      },
    );
    assert.equal(result.applied, true);
    assert.equal(result.storage, "excalidraw");
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("installer includes Excalidraw and excludes legacy tldraw runtime files", async () => {
  const [builderSource, verifierSource, packagingReadme] = await Promise.all([
    read("electron-builder.yml"),
    read("scripts/verify-packaged-app.mjs"),
    read("packaging/README.md"),
  ]);

  assert.match(builderSource, /!node_modules\/tldraw\/\*\*\/\*/);
  assert.match(builderSource, /!node_modules\/@tldraw\/\*\*\/\*/);
  assert.match(builderSource, /!mcp\/lib\/thinking-canvas\.mjs/);
  assert.match(builderSource, /license: LICENSE/);
  assert.doesNotMatch(builderSource, /license: .*TLDRAW/i);
  assert.match(verifierSource, /'@excalidraw', 'excalidraw', 'package\.json'/);
  assert.match(verifierSource, /forbiddenLegacyPaths/);
  assert.match(packagingReadme, /official `@excalidraw\/excalidraw@0\.18\.1` runtime/);
});

test("neutral canvas helpers preserve metadata and revision contracts", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(
    normalizeAutoComposeImageMetadata({
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "composition:test",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: digest,
      cowartAutoComposeSourceShapeIds: ["shape:a", "shape:a", "shape:b"],
    }),
    {
      cowartAutoComposeVersion: "3",
      cowartAutoComposeId: "composition:test",
      cowartAutoComposeRole: "composition-reference",
      cowartAutoComposePagePlanDigest: digest,
      cowartAutoComposeSourceShapeIds: ["shape:a", "shape:b"],
    },
  );

  const scene = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
  assert.equal(snapshotRevision(scene), snapshotRevision(structuredClone(scene)));
});
