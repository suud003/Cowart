#!/usr/bin/env node

import {readFileSync} from "node:fs";
import {isAbsolute, relative, resolve} from "node:path";
import {pathToFileURL} from "node:url";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_TAGS = new Set([
  "script",
  "foreignobject",
  "image",
  "filter",
  "iframe",
  "object",
  "embed",
  "link",
  "base",
  "audio",
  "video",
  "canvas",
  "form",
  "input",
  "button",
  "select",
  "textarea",
]);
const OBJECT_ROLES = new Set([
  "interface",
  "agent",
  "task",
  "container",
  "document",
  "state",
  "claim",
  "evidence",
  "question",
  "decision",
  "zone",
  "system",
]);
const ORIGINS = new Set(["source", "user", "synthesis", "inference", "unknown"]);
const RELATION_TYPES = new Set([
  "flow",
  "dispatch",
  "claim",
  "sync",
  "association",
  "compare",
  "contains",
  "transition",
  "call",
  "dependency",
]);
const DIRECTIONS = new Set(["forward", "bidirectional", "none"]);
const PATH_TYPES = new Set(["primary", "alternative"]);
const LAYOUT_TYPES = new Set([
  "hierarchy",
  "flow",
  "comparison",
  "board-to-peers",
  "containment",
  "swimlane",
  "interface",
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

function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function collectTags(source) {
  const tags = [];
  const pattern = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:._-]*)([^<>]*?)>/g;
  for (const match of source.matchAll(pattern)) {
    tags.push({
      closing: Boolean(match[1]),
      name: match[2].toLowerCase(),
      attributes: parseAttributes(match[3]),
    });
  }
  return tags;
}

function collectTemplates(source, markerName) {
  const templates = [];
  const pattern = /<template\b([^>]*)>([\s\S]*?)<\/template\s*>/gi;
  for (const match of source.matchAll(pattern)) {
    const attributes = parseAttributes(match[1]);
    if (attributes.has(markerName)) {
      templates.push({attributes, body: match[2].trim()});
    }
  }
  return templates;
}

function collectSvgBlocks(source) {
  return [...source.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg\s*>/gi)].map((match) => ({
    root: parseAttributes(match[1]),
    source: match[0],
  }));
}

function collectNamedElement(source, name) {
  const pattern = new RegExp("<" + name + "\\b([^>]*)>([\\s\\S]*?)<\\/" + name + "\\s*>", "i");
  const match = source.match(pattern);
  if (!match) return null;
  return {
    attributes: parseAttributes(match[1]),
    text: match[2].replace(/<[^>]+>/g, "").trim(),
  };
}

function validViewBox(value) {
  if (!value) return false;
  const values = value.trim().split(/[\s,]+/).map(Number);
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0;
}

function isInternalFragment(value) {
  return /^#[A-Za-z_][A-Za-z0-9:._-]*$/.test(value.trim());
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value));
}

function validateTemplateJson(template, label, errors) {
  if (!template) return null;
  if (template.attributes.get("type") !== "application/json") {
    errors.push(label + ' template must set type="application/json"');
  }
  if (template.body.includes("<")) {
    errors.push(label + " template contains a raw < character; JSON-escape it as \\u003c");
    return null;
  }
  try {
    return JSON.parse(template.body);
  } catch (error) {
    errors.push(label + " template is not valid JSON: " + error.message);
    return null;
  }
}

function validateSpec(spec, svgInfo, errors) {
  if (!spec || !svgInfo) return;
  if (String(spec.schemaVersion) !== "1") errors.push("diagram spec schemaVersion must be 1");
  if (typeof spec.diagramId !== "string" || !spec.diagramId.trim()) errors.push("diagram spec needs diagramId");
  if (typeof spec.claim !== "string" || !spec.claim.trim()) errors.push("diagram spec needs a non-empty claim");
  if (spec.mode !== "html-svg") errors.push("diagram spec mode must be html-svg");
  if (!Array.isArray(spec.objects) || spec.objects.length === 0) errors.push("diagram spec needs objects");
  if (!Array.isArray(spec.relations)) errors.push("diagram spec relations must be an array");
  if (!spec.layout || !LAYOUT_TYPES.has(spec.layout.kind)) errors.push("diagram spec needs a supported layout.kind");
  if (!spec.layout || !READING_ORDERS.has(spec.layout.readingOrder)) {
    errors.push("diagram spec needs a supported layout.readingOrder");
  }
  for (const field of ["alignmentTolerance", "minimumSafeGap"]) {
    if (!spec.layout || typeof spec.layout[field] !== "string" || !spec.layout[field].trim()) {
      errors.push("diagram spec layout." + field + " is required");
    }
  }

  if (!spec.trace || typeof spec.trace !== "object") {
    errors.push("diagram spec needs trace metadata");
  } else {
    for (const key of ["canvasId", "pageId", "sourceRevision"]) {
      if (typeof spec.trace[key] !== "string" || !spec.trace[key].trim()) {
        errors.push("diagram spec trace." + key + " is required");
      }
    }
    if (!new Set(["selection", "page"]).has(spec.trace.scope)) {
      errors.push("diagram spec trace.scope must be selection or page");
    }
    if (!Array.isArray(spec.trace.sourceShapeIds)) {
      errors.push("diagram spec trace.sourceShapeIds must be an array");
    }
  }

  if (spec.diagramId && spec.diagramId !== svgInfo.diagramId) {
    errors.push("diagram spec diagramId " + spec.diagramId + " does not match SVG " + svgInfo.diagramId);
  }

  if (Array.isArray(spec.objects)) {
    const specIds = new Set();
    for (const object of spec.objects) {
      if (!object || typeof object.id !== "string" || !object.id) {
        errors.push("every diagram spec object needs an id");
        continue;
      }
      if (specIds.has(object.id)) errors.push("duplicate diagram spec object id: " + object.id);
      specIds.add(object.id);
      if (!OBJECT_ROLES.has(object.role)) errors.push("unsupported object role in spec: " + object.role);
      if (!ORIGINS.has(object.origin)) errors.push("unsupported object origin in spec: " + object.origin);
      if (!Array.isArray(object.sourceShapeIds)) {
        errors.push("spec object " + object.id + " needs sourceShapeIds array");
      }
    }
    for (const id of difference(specIds, svgInfo.objectIds)) errors.push("spec object missing from SVG: " + id);
    for (const id of difference(svgInfo.objectIds, specIds)) errors.push("SVG object missing from spec: " + id);
  }

  if (Array.isArray(spec.relations)) {
    const specIds = new Set();
    for (const relation of spec.relations) {
      if (!relation || typeof relation.id !== "string" || !relation.id) {
        errors.push("every diagram spec relation needs an id");
        continue;
      }
      if (specIds.has(relation.id)) errors.push("duplicate diagram spec relation id: " + relation.id);
      specIds.add(relation.id);
      if (!RELATION_TYPES.has(relation.type)) errors.push("unsupported relation type in spec: " + relation.type);
      if (!DIRECTIONS.has(relation.direction)) {
        errors.push("unsupported relation direction in spec: " + relation.direction);
      }
      if (!PATH_TYPES.has(relation.path)) errors.push("unsupported relation path in spec: " + relation.path);
      if (!ORIGINS.has(relation.origin)) errors.push("unsupported relation origin in spec: " + relation.origin);
      if (!Array.isArray(relation.sourceShapeIds)) {
        errors.push("spec relation " + relation.id + " needs sourceShapeIds array");
      }
    }
    for (const id of difference(specIds, svgInfo.relationIds)) errors.push("spec relation missing from SVG: " + id);
    for (const id of difference(svgInfo.relationIds, specIds)) errors.push("SVG relation missing from spec: " + id);
  }
}

function validatePrompt(prompt, diagramId, errors) {
  if (!prompt) return;
  if (String(prompt.schemaVersion) !== "1") errors.push("diagram prompt schemaVersion must be 1");
  if (prompt.diagramId !== diagramId) errors.push("diagram prompt diagramId must match the SVG");
  if (typeof prompt.prompt !== "string" || prompt.prompt.trim().length < 20) {
    errors.push("diagram prompt must contain a reusable prompt of at least 20 characters");
  }
}

export function validateSemanticSvg(source, options = {}) {
  const filename = options.filename ?? "<markup>";
  const errors = [];
  const warnings = [];

  if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES) {
    errors.push("input exceeds " + MAX_INPUT_BYTES + " bytes");
    return {filename, errors, warnings, svgCount: 0};
  }

  const tags = collectTags(source);
  const documentIds = new Set();
  for (const tag of tags) {
    if (tag.closing) continue;
    if (FORBIDDEN_TAGS.has(tag.name)) errors.push("forbidden element <" + tag.name + ">");
    for (const [name, value] of tag.attributes) {
      if (/^on[a-z0-9_-]+$/i.test(name)) errors.push("forbidden event attribute " + name);
      if (name === "filter") errors.push("forbidden filter attribute");
      if (name === "href" || name === "xlink:href") {
        if (!isInternalFragment(value)) errors.push("external " + name + " is forbidden: " + value);
      }
      if (name === "src") errors.push("external or embedded src is forbidden: " + value);
      if (tag.name === "meta" && name === "http-equiv" && value.toLowerCase() === "refresh") {
        errors.push("meta refresh is forbidden");
      }
      if (name === "id") {
        if (documentIds.has(value)) errors.push("duplicate document id: " + value);
        documentIds.add(value);
      }
    }
  }

  if (/@import\b|expression\s*\(|javascript\s*:/i.test(source)) {
    errors.push("active or external CSS/URL syntax is forbidden");
  }
  if (/(?:^|[;{\s])filter\s*:/im.test(source)) errors.push("CSS filter is forbidden");

  for (const match of source.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const reference = match[2].trim();
    if (!isInternalFragment(reference)) {
      errors.push("external CSS/SVG URL is forbidden: " + reference);
    } else if (!documentIds.has(reference.slice(1))) {
      errors.push("URL references missing id: " + reference);
    }
  }
  for (const tag of tags) {
    if (tag.closing) continue;
    for (const name of ["href", "xlink:href"]) {
      const value = tag.attributes.get(name);
      if (value && isInternalFragment(value) && !documentIds.has(value.slice(1))) {
        errors.push(name + " references missing id: " + value);
      }
    }
  }

  const svgBlocks = collectSvgBlocks(source);
  if (svgBlocks.length !== 1) errors.push("expected exactly one inline SVG, found " + svgBlocks.length);
  const svgInfos = [];

  for (const [index, svg] of svgBlocks.entries()) {
    const label = "SVG " + (index + 1);
    const root = svg.root;
    if (!validViewBox(root.get("viewbox"))) {
      errors.push(label + " needs a valid viewBox with positive width and height");
    }
    if (root.get("role") !== "img") errors.push(label + ' must set role="img"');
    if (root.has("width") || root.has("height")) {
      warnings.push(label + " root width/height should be controlled by responsive CSS");
    }

    const diagramId = root.get("data-cowart-diagram-id");
    const layout = root.get("data-cowart-layout");
    const readingOrder = root.get("data-reading-order");
    if (!diagramId) errors.push(label + " needs data-cowart-diagram-id");
    if (!LAYOUT_TYPES.has(layout)) errors.push(label + " needs a supported data-cowart-layout");
    if (!READING_ORDERS.has(readingOrder)) errors.push(label + " needs a supported data-reading-order");

    const title = collectNamedElement(svg.source, "title");
    const desc = collectNamedElement(svg.source, "desc");
    const titleId = title?.attributes.get("id");
    const descId = desc?.attributes.get("id");
    if (!titleId || !title?.text) errors.push(label + " needs a non-empty title with an id");
    if (!descId || !desc?.text) errors.push(label + " needs a non-empty desc with an id");
    const labelledBy = new Set((root.get("aria-labelledby") ?? "").trim().split(/\s+/).filter(Boolean));
    if (!titleId || !descId || !labelledBy.has(titleId) || !labelledBy.has(descId)) {
      errors.push(label + " aria-labelledby must reference both title and desc");
    }
    if (!/vector-effect\s*(?::|=)\s*(?:["']\s*)?non-scaling-stroke\b/i.test(source)) {
      errors.push(label + " needs vector-effect: non-scaling-stroke");
    }

    const objectIds = new Set();
    const relationIds = new Set();
    let semanticStrokeCount = 0;
    const svgTags = collectTags(svg.source);
    for (const tag of svgTags) {
      if (tag.closing) continue;
      if (tag.attributes.has("data-cowart-stroke")) semanticStrokeCount += 1;

      const objectId = tag.attributes.get("data-cowart-object-id");
      if (objectId !== undefined) {
        if (tag.name !== "g") errors.push("semantic object " + objectId + " must be a <g>");
        if (!objectId) errors.push("data-cowart-object-id cannot be empty");
        if (objectIds.has(objectId)) errors.push("duplicate semantic object id: " + objectId);
        objectIds.add(objectId);
        const role = tag.attributes.get("data-cowart-role");
        const origin = tag.attributes.get("data-cowart-origin");
        if (!OBJECT_ROLES.has(role)) errors.push("semantic object " + objectId + " has unsupported role: " + role);
        if (!ORIGINS.has(origin)) errors.push("semantic object " + objectId + " has unsupported origin: " + origin);
        if ((origin === "source" || origin === "user") && !tag.attributes.get("data-cowart-source-ids")) {
          errors.push("source-backed semantic object " + objectId + " needs data-cowart-source-ids");
        }
      }

      const relationId = tag.attributes.get("data-cowart-relation-id");
      if (relationId !== undefined) {
        if (tag.name !== "g") errors.push("semantic relation " + relationId + " must be a <g>");
        if (!relationId) errors.push("data-cowart-relation-id cannot be empty");
        if (relationIds.has(relationId)) errors.push("duplicate semantic relation id: " + relationId);
        relationIds.add(relationId);
        const from = tag.attributes.get("data-from");
        const to = tag.attributes.get("data-to");
        const type = tag.attributes.get("data-relation");
        const direction = tag.attributes.get("data-direction");
        const path = tag.attributes.get("data-path");
        const origin = tag.attributes.get("data-cowart-origin");
        if (!from || !to) errors.push("semantic relation " + relationId + " needs data-from and data-to");
        if (!RELATION_TYPES.has(type)) {
          errors.push("semantic relation " + relationId + " has unsupported type: " + type);
        }
        if (!DIRECTIONS.has(direction)) {
          errors.push("semantic relation " + relationId + " has unsupported direction: " + direction);
        }
        if (!PATH_TYPES.has(path)) {
          errors.push("semantic relation " + relationId + " has unsupported path: " + path);
        }
        if (!ORIGINS.has(origin)) {
          errors.push("semantic relation " + relationId + " has unsupported origin: " + origin);
        }
        if (type === "sync" && direction !== "bidirectional") {
          errors.push("sync relation " + relationId + " must be bidirectional");
        }
        if (new Set(["association", "compare", "contains"]).has(type) && direction !== "none") {
          errors.push(type + " relation " + relationId + " must use direction none");
        }
      }
    }
    if (objectIds.size === 0) errors.push(label + " needs at least one data-cowart-object-id group");
    if (semanticStrokeCount === 0) errors.push(label + " needs data-cowart-stroke on visible stroked primitives");

    for (const tag of svgTags) {
      if (tag.closing || !tag.attributes.has("data-cowart-relation-id")) continue;
      const relationId = tag.attributes.get("data-cowart-relation-id");
      const from = tag.attributes.get("data-from");
      const to = tag.attributes.get("data-to");
      if (from && !objectIds.has(from)) {
        errors.push("relation " + relationId + " references missing source object: " + from);
      }
      if (to && !objectIds.has(to)) {
        errors.push("relation " + relationId + " references missing target object: " + to);
      }
    }
    svgInfos.push({diagramId, objectIds, relationIds});
  }

  const htmlMode = /<html\b/i.test(source)
    || /data-cowart-diagram-(?:spec|prompt)/i.test(source)
    || /\.html?$/i.test(filename);
  if (htmlMode) {
    const specTemplates = collectTemplates(source, "data-cowart-diagram-spec");
    const promptTemplates = collectTemplates(source, "data-cowart-diagram-prompt");
    if (specTemplates.length !== 1) {
      errors.push("expected one data-cowart-diagram-spec template, found " + specTemplates.length);
    }
    if (promptTemplates.length !== 1) {
      errors.push("expected one data-cowart-diagram-prompt template, found " + promptTemplates.length);
    }
    const spec = validateTemplateJson(specTemplates[0], "diagram spec", errors);
    const prompt = validateTemplateJson(promptTemplates[0], "diagram prompt", errors);
    validateSpec(spec, svgInfos[0], errors);
    validatePrompt(prompt, svgInfos[0]?.diagramId, errors);
  }

  return {filename, errors, warnings, svgCount: svgBlocks.length};
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("&", "\\u0026");
}

function validFixture() {
  const spec = {
    schemaVersion: "1",
    diagramId: "demo",
    claim: "A source claim becomes a reviewable decision.",
    mode: "html-svg",
    objects: [
      {id: "source", label: "Source", role: "claim", origin: "source", sourceShapeIds: ["shape:source"]},
      {id: "decision", label: "Decision", role: "decision", origin: "synthesis", sourceShapeIds: []},
    ],
    relations: [
      {
        id: "source-to-decision",
        from: "source",
        to: "decision",
        type: "flow",
        direction: "forward",
        path: "primary",
        label: "supports",
        origin: "synthesis",
        sourceShapeIds: ["shape:source"],
      },
    ],
    states: [],
    visibleLabels: [],
    layout: {
      kind: "flow",
      readingOrder: "left-to-right",
      alignmentTolerance: "0.5% of viewBox height",
      minimumSafeGap: "2% of viewBox width",
    },
    trace: {
      canvasId: "canvas:test",
      pageId: "page:test",
      sourceRevision: "revision-1",
      scope: "selection",
      sourceShapeIds: ["shape:source"],
      mappings: [],
      draftShapeId: null,
      operationIds: [],
      lastAppliedRevision: null,
    },
  };
  const prompt = {
    schemaVersion: "1",
    diagramId: "demo",
    prompt: "Rebuild the accessible source-grounded semantic flow from the embedded specification.",
  };
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><style>',
    "[data-cowart-stroke] { vector-effect: non-scaling-stroke; stroke: #111; fill: none; }",
    "</style></head><body><main>",
    '<svg viewBox="0 0 600 240" role="img" aria-labelledby="demo-title demo-desc" data-cowart-diagram-id="demo" data-cowart-layout="flow" data-reading-order="left-to-right">',
    '<title id="demo-title">Source to decision</title><desc id="demo-desc">A source claim flows to a reviewable decision.</desc>',
    '<defs><marker id="demo-arrow"><path data-cowart-stroke d="M0 0 L10 5 L0 10 Z"></path></marker></defs>',
    '<g data-cowart-object-id="source" data-cowart-role="claim" data-cowart-origin="source" data-cowart-source-ids="shape:source"><rect data-cowart-stroke x="30" y="80" width="160" height="70"></rect><text x="110" y="120">Source</text></g>',
    '<g data-cowart-object-id="decision" data-cowart-role="decision" data-cowart-origin="synthesis"><rect data-cowart-stroke x="410" y="80" width="160" height="70"></rect><text x="490" y="120">Decision</text></g>',
    '<g data-cowart-relation-id="source-to-decision" data-from="source" data-to="decision" data-relation="flow" data-direction="forward" data-path="primary" data-cowart-origin="synthesis"><path data-cowart-stroke d="M190 115 H410" marker-end="url(#demo-arrow)"></path></g>',
    "</svg></main>",
    '<template data-cowart-diagram-spec type="application/json">' + safeJson(spec) + "</template>",
    '<template data-cowart-diagram-prompt type="application/json">' + safeJson(prompt) + "</template>",
    "</body></html>",
  ].join("\n");
}

function runSelfTest() {
  const valid = validFixture();
  const validResult = validateSemanticSvg(valid, {filename: "valid.html"});
  if (validResult.errors.length) {
    throw new Error("valid fixture failed: " + validResult.errors.join("; "));
  }

  const attacks = [
    ["script", valid.replace("</body>", "<script>bad()</script></body>"), /forbidden element <script>/],
    ["foreignObject", valid.replace("</svg>", "<foreignObject></foreignObject></svg>"), /forbidden element <foreignobject>/],
    ["image", valid.replace("</svg>", '<image href="#demo-arrow"></image></svg>'), /forbidden element <image>/],
    ["filter", valid.replace("</svg>", '<filter id="bad-filter"></filter></svg>'), /forbidden element <filter>/],
    ["event", valid.replace('role="img"', 'role="img" onload="bad()"'), /forbidden event attribute onload/],
    ["external href", valid.replace("</svg>", '<a href="https:\/\/example.com"></a></svg>'), /external href is forbidden/],
    ["viewBox", valid.replace('viewBox="0 0 600 240"', ""), /needs a valid viewBox/],
    ["duplicate id", valid.replace('id="demo-desc"', 'id="demo-title"'), /duplicate document id/],
    ["non-scaling stroke", valid.replace("vector-effect: non-scaling-stroke;", ""), /needs vector-effect/],
    ["semantic root", valid.replace(' data-cowart-diagram-id="demo"', ""), /needs data-cowart-diagram-id/],
  ];

  for (const [name, source, expected] of attacks) {
    const result = validateSemanticSvg(source, {filename: name + ".html"});
    if (!result.errors.some((error) => expected.test(error))) {
      throw new Error(name + " fixture did not trigger " + expected + ": " + result.errors.join("; "));
    }
  }
  console.log("Self-test passed: 1 valid fixture and " + attacks.length + " rejection fixtures.");
}

function parseCliArgs(argv) {
  const options = {files: [], root: null, stdin: false, selfTest: false};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--self-test") options.selfTest = true;
    else if (value === "--stdin") options.stdin = true;
    else if (value === "--root") {
      index += 1;
      if (!argv[index]) throw new Error("--root requires a directory");
      options.root = resolve(argv[index]);
    } else options.files.push(value);
  }
  return options;
}

function resolveInput(file, root) {
  const filename = resolve(file);
  if (root) {
    const pathFromRoot = relative(root, filename);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      throw new Error(filename + " is outside --root " + root);
    }
  }
  return filename;
}

function printResult(result) {
  console.log((result.errors.length ? "[fail] " : "[ok] ") + result.filename + ": " + result.svgCount + " SVG");
  for (const error of result.errors) console.error("  error: " + error);
  for (const warning of result.warnings) console.warn("  warning: " + warning);
}

function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  if (options.selfTest) {
    try {
      runSelfTest();
    } catch (error) {
      console.error("Self-test failed: " + error.message);
      process.exitCode = 1;
    }
    return;
  }

  if (!options.stdin && options.files.length === 0) {
    console.error("Usage: node validate-semantic-svg.mjs [--root <dir>] <svg-or-html> [...] | --stdin | --self-test");
    process.exitCode = 2;
    return;
  }

  const results = [];
  if (options.stdin) {
    results.push(validateSemanticSvg(readFileSync(0, "utf8"), {filename: "<stdin>"}));
  }
  for (const file of options.files) {
    try {
      const filename = resolveInput(file, options.root);
      results.push(validateSemanticSvg(readFileSync(filename, "utf8"), {filename}));
    } catch (error) {
      results.push({filename: file, errors: [error.message], warnings: [], svgCount: 0});
    }
  }
  for (const result of results) printResult(result);
  process.exitCode = results.some((result) => result.errors.length) ? 1 : 0;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) main();
