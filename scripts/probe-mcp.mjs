import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["./scripts/start-mcp.mjs"],
});

const client = new Client({
  name: "cowart-probe",
  version: "0.1.0",
});

await client.connect(transport);

let downloadedProbePath = null;
let downloadedProbeDirectory = null;
let probeProjectDir = null;

function isCanvasDirectory(value) {
  const canvasDir = String(value || "");
  return (
    path.basename(path.normalize(canvasDir)) === "canvas" ||
    path.win32.basename(path.win32.normalize(canvasDir)) === "canvas"
  );
}

function semanticProbeHtml(sourceRevision) {
  const spec = {
    schemaVersion: "1",
    diagramId: "probe-semantic",
    claim: "A source-grounded idea becomes a reviewable semantic object.",
    mode: "html-svg",
    objects: [{ id: "probe-object", label: "Probe object", role: "claim", origin: "synthesis", sourceShapeIds: [] }],
    relations: [],
    states: [],
    visibleLabels: [{ text: "Probe object", role: "object-label" }],
    layout: {
      kind: "flow",
      readingOrder: "left-to-right",
      alignmentTolerance: "0.5% of viewBox height",
      minimumSafeGap: "2% of viewBox width",
    },
    trace: {
      canvasId: "canvas:probe",
      pageId: "page:probe",
      sourceRevision,
      scope: "page",
      sourceShapeIds: [],
      mappings: [],
      draftShapeId: null,
      operationIds: [],
      lastAppliedRevision: null,
    },
  };
  const prompt = {
    schemaVersion: "1",
    diagramId: "probe-semantic",
    prompt: "Rebuild the accessible semantic probe from the embedded specification.",
  };
  return [
    "<!doctype html><html><head><style>[data-cowart-stroke]{vector-effect:non-scaling-stroke;stroke:#111;fill:none}</style></head><body>",
    '<svg viewBox="0 0 400 180" role="img" aria-labelledby="probe-semantic-title probe-semantic-desc" data-cowart-diagram-id="probe-semantic" data-cowart-layout="flow" data-reading-order="left-to-right">',
    '<title id="probe-semantic-title">Semantic probe</title><desc id="probe-semantic-desc">One reviewable semantic object.</desc>',
    '<g data-cowart-object-id="probe-object" data-cowart-role="claim" data-cowart-origin="synthesis"><rect data-cowart-stroke x="80" y="50" width="240" height="80"></rect><text x="200" y="94" text-anchor="middle">Probe object</text></g>',
    "</svg>",
    `<template data-cowart-diagram-spec type="application/json">${JSON.stringify(spec).replaceAll("<", "\\u003c")}</template>`,
    `<template data-cowart-diagram-prompt type="application/json">${JSON.stringify(prompt).replaceAll("<", "\\u003c")}</template>`,
    "</body></html>",
  ].join("");
}

try {
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  const requiredTools = [
    "render_cowart_canvas_widget",
    "get_cowart_canvas_state",
    "save_cowart_canvas_state",
    "save_cowart_selection_state",
    "save_cowart_view_state",
    "save_cowart_reference_image",
    "read_cowart_page_asset",
    "download_cowart_file",
    "copy_cowart_image_to_clipboard",
    "get_cowart_selection",
    "insert_cowart_image",
    "insert_cowart_html_draft",
    "get_cowart_thinking_context",
    "import_cowart_material",
    "apply_cowart_thinking_operations",
    "undo_cowart_thinking_operation",
    "track_cowart_analytics_event",
  ];

  for (const toolName of requiredTools) {
    if (!toolNames.includes(toolName)) {
      throw new Error(`${toolName} not found. Tools: ${toolNames.join(", ")}`);
    }
  }

  const analyticsTool = tools.tools.find((tool) => tool.name === "track_cowart_analytics_event");
  if (JSON.stringify(analyticsTool?._meta?.ui?.visibility) !== JSON.stringify(["app"])) {
    throw new Error("Cowart analytics tool should only be visible to the widget app.");
  }
  if (analyticsTool?.annotations?.openWorldHint !== true) {
    throw new Error("Cowart analytics tool should declare its external GA4 side effect.");
  }
  const clipboardTool = tools.tools.find((tool) => tool.name === "copy_cowart_image_to_clipboard");
  if (JSON.stringify(clipboardTool?._meta?.ui?.visibility) !== JSON.stringify(["app"])) {
    throw new Error("Cowart clipboard tool should only be visible to the widget app.");
  }

  const projectDir = await mkdtemp(path.join(tmpdir(), "cowart-widget-probe-"));
  probeProjectDir = projectDir;
  const renderResult = await client.callTool({
    name: "render_cowart_canvas_widget",
    arguments: {
      projectDir,
      title: "Probe Cowart",
    },
  });
  if (renderResult._meta?.["openai/outputTemplate"] !== "ui://widget/cowart/canvas.html") {
    throw new Error("Cowart render tool result did not include the expected outputTemplate.");
  }
  if (renderResult.structuredContent?.preferredDisplayMode !== "fullscreen") {
    throw new Error("Cowart render tool did not default to fullscreen display mode.");
  }
  if (renderResult.structuredContent?.projectDir !== projectDir) {
    throw new Error("Cowart render tool did not preserve the requested projectDir.");
  }

  const stateResult = await client.callTool({
    name: "get_cowart_canvas_state",
    arguments: {
      projectDir,
    },
  });
  if (stateResult.structuredContent?.storage !== "empty") {
    throw new Error("A fresh Cowart project should report empty storage.");
  }
  if (!isCanvasDirectory(stateResult.structuredContent?.canvasDir)) {
    throw new Error("Cowart canvas state did not report a project-local canvas directory.");
  }
  if ((stateResult.structuredContent?.hydratedAssets || []).length !== 0) {
    throw new Error("Cowart canvas state should not hydrate image assets by default.");
  }

  const thinkingContextResult = await client.callTool({
    name: "get_cowart_thinking_context",
    arguments: { projectDir, scope: "page" },
  });
  const thinkingRevision = thinkingContextResult.structuredContent?.revision;
  if (!thinkingRevision || thinkingContextResult.structuredContent?.shapes?.length !== 0) {
    throw new Error("A fresh Cowart project should expose an empty, revisioned thinking context.");
  }

  const thinkingOperations = [{ type: "create_card", role: "question", title: "Probe question" }];
  const thinkingPreview = await client.callTool({
    name: "apply_cowart_thinking_operations",
    arguments: { projectDir, baseRevision: thinkingRevision, operations: thinkingOperations, dryRun: true },
  });
  if (thinkingPreview.structuredContent?.applied !== false) {
    throw new Error("Cowart thinking operations should support a non-persistent preview.");
  }

  const thinkingApply = await client.callTool({
    name: "apply_cowart_thinking_operations",
    arguments: { projectDir, baseRevision: thinkingRevision, operations: thinkingOperations },
  });
  const thinkingOperationId = thinkingApply.structuredContent?.operationId;
  if (!thinkingOperationId || thinkingApply.structuredContent?.applied !== true) {
    throw new Error("Cowart thinking operations did not persist an atomic edit.");
  }

  const thinkingUndo = await client.callTool({
    name: "undo_cowart_thinking_operation",
    arguments: { projectDir, operationId: thinkingOperationId },
  });
  if (thinkingUndo.structuredContent?.revision !== thinkingRevision) {
    throw new Error("Cowart thinking undo did not restore the original revision.");
  }

  const semanticHtml = semanticProbeHtml(thinkingRevision);
  const semanticDiagram = {
    version: "1",
    teachingClaim: "A source-grounded idea becomes a reviewable semantic object.",
    readingOrder: "left-to-right",
    diagramType: "flow",
    sourceShapeIds: [],
    objectCount: 1,
    relationCount: 0,
    specDigest: "probe-spec",
  };
  const rejectedSemantic = await client.callTool({
    name: "insert_cowart_html_draft",
    arguments: {
      projectDir,
      htmlContent: semanticHtml.replace("</body>", "<script>globalThis.bad=true</script></body>"),
      fileName: "rejected-semantic.html",
      semanticDiagram,
      dryRun: true,
    },
  });
  if (rejectedSemantic.isError !== true) {
    throw new Error("Semantic HTML insertion must reject active script content on the server.");
  }

  const overflowedSemantic = await client.callTool({
    name: "insert_cowart_html_draft",
    arguments: {
      projectDir,
      htmlContent: semanticHtml.replace(
        'x="80" y="50" width="240"',
        'x="300" y="50" width="240"',
      ),
      fileName: "overflowed-semantic.html",
      semanticDiagram,
      dryRun: true,
    },
  });
  if (overflowedSemantic.isError !== true) {
    throw new Error("Semantic HTML insertion must reject geometry outside the SVG viewBox.");
  }

  const semanticPreviewArguments = {
    projectDir,
    htmlContent: semanticHtml.replace('viewBox="0 0 400 180"', 'viewBox="0 0 400 800"'),
    fileName: "semantic-probe.html",
    displayWidth: 300,
    displayHeight: 100,
    matchAnchor: false,
    updateExistingDraft: false,
    replaceDraftHolder: false,
    semanticDiagram,
    shapeMeta: {
      cowartHtmlDraft: false,
      cowartHtmlDraftAssetUrl: "/page-assets/evil.html",
      cowartSemanticDiagram: { version: "bypass" },
    },
    dryRun: true,
  };
  const semanticPreview = await client.callTool({
    name: "insert_cowart_html_draft",
    arguments: semanticPreviewArguments,
  });
  if (
    semanticPreview.isError ||
    semanticPreview.structuredContent?.dryRun !== true ||
    semanticPreview.structuredContent?.baseRevision !== thinkingRevision ||
    semanticPreview.structuredContent?.bounds?.w !== 300 ||
    semanticPreview.structuredContent?.bounds?.h < 624
  ) {
    throw new Error("Semantic HTML insertion did not return a revisioned, aspect-safe dry-run preview.");
  }

  const staleThinkingApply = await client.callTool({
    name: "apply_cowart_thinking_operations",
    arguments: {
      projectDir,
      baseRevision: thinkingRevision,
      operations: [{ type: "create_card", role: "question", title: "Stale guard probe" }],
    },
  });
  const staleSemanticApply = await client.callTool({
    name: "insert_cowart_html_draft",
    arguments: {
      ...semanticPreviewArguments,
      baseRevision: semanticPreview.structuredContent.baseRevision,
      dryRun: false,
    },
  });
  if (staleSemanticApply.isError !== true) {
    throw new Error("Semantic HTML insertion must reject a stale dry-run revision.");
  }
  await client.callTool({
    name: "undo_cowart_thinking_operation",
    arguments: { projectDir, operationId: staleThinkingApply.structuredContent?.operationId },
  });

  const semanticApply = await client.callTool({
    name: "insert_cowart_html_draft",
    arguments: {
      ...semanticPreviewArguments,
      baseRevision: semanticPreview.structuredContent.baseRevision,
      dryRun: false,
    },
  });
  const semanticShapeId = semanticApply.structuredContent?.shapeId;
  if (semanticApply.isError || !semanticShapeId || !semanticApply.structuredContent?.resultRevision) {
    throw new Error("Semantic HTML insertion did not persist the validated diagram.");
  }
  const semanticContext = await client.callTool({
    name: "get_cowart_thinking_context",
    arguments: { projectDir, scope: "page" },
  });
  const semanticShape = semanticContext.structuredContent?.shapes?.find((shape) => shape.id === semanticShapeId);
  if (
    semanticShape?.visual?.kind !== "semantic-line-svg" ||
    semanticShape.visual.semanticDiagram?.teachingClaim !== semanticDiagram.teachingClaim ||
    semanticShape.visual.assetUrl === "/page-assets/evil.html"
  ) {
    throw new Error("Semantic HTML insertion did not preserve constrained metadata or block reserved shapeMeta overrides.");
  }

  const probePageAssetDir = path.join(projectDir, "canvas", "pages", "probe-page", "assets");
  await mkdir(probePageAssetDir, { recursive: true });
  await writeFile(
    path.join(probePageAssetDir, "tiny.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  );
  await writeFile(path.join(probePageAssetDir, "draft.html"), "<!doctype html><html><body>draft</body></html>");
  const pageAssetResult = await client.callTool({
    name: "read_cowart_page_asset",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/tiny.png",
    },
  });
  if (pageAssetResult.structuredContent?.mimeType !== "image/png" || !pageAssetResult.structuredContent?.dataBase64) {
    throw new Error("Cowart page asset tool did not return the expected png payload.");
  }
  const htmlAssetResult = await client.callTool({
    name: "read_cowart_page_asset",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/draft.html",
    },
  });
  if (htmlAssetResult.structuredContent?.mimeType !== "text/html" || !htmlAssetResult.structuredContent?.dataBase64) {
    throw new Error("Cowart page asset tool did not return the expected html payload.");
  }

  const clipboardResult = await client.callTool({
    name: "copy_cowart_image_to_clipboard",
    arguments: {
      projectDir,
      dataBase64: pageAssetResult.structuredContent.dataBase64,
      mimeType: "image/png",
      dryRun: true,
    },
  });
  if (
    clipboardResult.structuredContent?.dryRun !== true ||
    clipboardResult.structuredContent?.width !== 1 ||
    clipboardResult.structuredContent?.height !== 1
  ) {
    throw new Error("Cowart clipboard tool did not validate the expected PNG payload.");
  }

  const downloadResult = await client.callTool({
    name: "download_cowart_file",
    arguments: {
      projectDir,
      assetUrl: "/page-assets/probe-page/tiny.png",
      fileName: `cowart-download-probe-${process.pid}.png`,
    },
  });
  downloadedProbePath = downloadResult.structuredContent?.filePath;
  if (!downloadedProbePath || !(await readFile(downloadedProbePath)).length) {
    throw new Error("Cowart download tool did not write the expected file into Downloads.");
  }

  const folderDownloadResult = await client.callTool({
    name: "download_cowart_file",
    arguments: {
      projectDir,
      dataUrl: "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3Eprobe%3C%2Ftitle%3E",
      directoryName: `Cowart Slides Probe ${process.pid}`,
      subdirectory: "pages",
      fileName: "page-01.html",
      mimeType: "text/html",
      overwrite: true,
      uniqueDirectory: true,
    },
  });
  downloadedProbeDirectory = folderDownloadResult.structuredContent?.directoryPath;
  const folderDownloadPath = folderDownloadResult.structuredContent?.filePath;
  if (
    !downloadedProbeDirectory ||
    path.basename(path.dirname(folderDownloadPath || "")) !== "pages" ||
    !(await readFile(folderDownloadPath, "utf8")).includes("<title>probe</title>")
  ) {
    throw new Error("Cowart download tool did not create the expected Slides export folder structure.");
  }

  const resource = await client.readResource({
    uri: "ui://widget/cowart/canvas.html",
  });
  const resourceMeta = resource.contents?.[0]?._meta || {};
  const widgetCsp = resourceMeta["openai/widgetCSP"] || {};
  const connectDomains = widgetCsp.connect_domains || [];
  const requiredAnalyticsConnectDomains = [
    "https://www.google-analytics.com",
    "https://region1.google-analytics.com",
    "https://analytics.google.com",
    "https://www.googletagmanager.com",
    "https://stats.g.doubleclick.net",
    "https://www.doubleclick.net",
    "https://pagead2.googlesyndication.com",
    "https://www.googleadservices.com",
    "https://www.google.com",
    "https://www.google.cn",
    "https://www.gstatic.com",
    "https://www.googleapis.com",
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://*.googletagmanager.com",
    "https://*.doubleclick.net",
    "https://*.googlesyndication.com",
    "https://*.googleadservices.com",
    "https://*.google.com",
    "https://*.google.cn",
    "https://*.gstatic.com",
    "https://*.googleapis.com",
    "https://*.merchant-center-analytics.goog",
  ];
  for (const domain of requiredAnalyticsConnectDomains) {
    if (!connectDomains.includes(domain)) {
      throw new Error(`Cowart widget CSP should allow Google Analytics connections to ${domain}.`);
    }
  }
  const resourceDomains = widgetCsp.resource_domains || [];
  if (!resourceDomains.includes("data:") || !resourceDomains.includes("blob:")) {
    throw new Error(`Cowart widget CSP should allow local data/blob resources. Found: ${resourceDomains.join(", ")}`);
  }
  const requiredAnalyticsResourceDomains = requiredAnalyticsConnectDomains;
  for (const domain of requiredAnalyticsResourceDomains) {
    if (!resourceDomains.includes(domain)) {
      throw new Error(`Cowart widget CSP should allow Google Analytics resources from ${domain}.`);
    }
  }
  const frameDomains = widgetCsp.frame_domains || [];
  if (!frameDomains.includes("data:") || !frameDomains.includes("blob:")) {
    throw new Error(`Cowart widget CSP should allow local data/blob iframes for HTML drafts. Found: ${frameDomains.join(", ")}`);
  }

  const widgetHtml = resource.contents?.[0]?.text || "";
  if (!widgetHtml.includes("window.cowartMcp") || !widgetHtml.includes("Yogurt AI Canvas")) {
    throw new Error("Yogurt AI widget HTML does not include the expected bridge and app shell.");
  }
  if (/<script\b[^>]*\btype="module"/i.test(widgetHtml)) {
    throw new Error("Cowart widget HTML should use classic inline scripts for host compatibility.");
  }
  const shellMarkup = widgetHtml
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  if (/<iframe\b/i.test(shellMarkup) || /<script\b[^>]+\bsrc=/i.test(shellMarkup) || /<link\b[^>]+\bhref=/i.test(shellMarkup)) {
    throw new Error("Cowart widget HTML should be direct static markup without iframe or external asset tags.");
  }

  console.log("OK: Cowart MCP tools and native widget resource are available.");
} finally {
  if (downloadedProbePath) {
    await unlink(downloadedProbePath).catch(() => undefined);
  }
  if (downloadedProbeDirectory) {
    await rm(downloadedProbeDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  if (probeProjectDir) {
    await rm(probeProjectDir, { recursive: true, force: true }).catch(() => undefined);
  }
  await client.close();
}
