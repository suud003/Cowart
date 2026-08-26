import assert from "node:assert/strict";
import test from "node:test";

import { validateSemanticSvg } from "../skills/cowart-semantic-diagram/scripts/validate-semantic-svg.mjs";

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function semanticHtml({ relationPath = "M 190 115 H 410", extra = "" } = {}) {
  const spec = {
    schemaVersion: "1",
    diagramId: "bounds-demo",
    claim: "Every visible relation remains inside the semantic diagram viewport.",
    mode: "html-svg",
    objects: [
      { id: "source", label: "Source", role: "claim", origin: "source", sourceShapeIds: ["shape:source"] },
      { id: "target", label: "Target", role: "decision", origin: "synthesis", sourceShapeIds: [] },
    ],
    relations: [{
      id: "source-target",
      from: "source",
      to: "target",
      type: "flow",
      direction: "forward",
      path: "primary",
      origin: "synthesis",
      sourceShapeIds: ["shape:source"],
    }],
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
      scope: "page",
      sourceShapeIds: ["shape:source"],
      mappings: [],
      draftShapeId: null,
      operationIds: [],
      lastAppliedRevision: null,
    },
  };
  const prompt = {
    schemaVersion: "1",
    diagramId: "bounds-demo",
    prompt: "Rebuild the source-to-target flow with every visible element inside the SVG viewBox.",
  };
  return [
    "<!doctype html><html><head><style>",
    ".edge{stroke-width:2}[data-cowart-stroke]{vector-effect:non-scaling-stroke;stroke:#111;fill:none}",
    "</style></head><body>",
    '<svg viewBox="0 0 600 240" role="img" aria-labelledby="bounds-title bounds-desc" data-cowart-diagram-id="bounds-demo" data-cowart-layout="flow" data-reading-order="left-to-right">',
    '<title id="bounds-title">Bounds demo</title><desc id="bounds-desc">A source flows to a target.</desc>',
    '<rect data-cowart-stroke x="0" y="0" width="600" height="240"></rect>',
    '<defs><marker id="bounds-arrow" markerWidth="7" markerHeight="7"><path d="M0 0 L10 5 L0 10 Z"></path></marker></defs>',
    '<g data-cowart-object-id="source" data-cowart-role="claim" data-cowart-origin="source" data-cowart-source-ids="shape:source"><rect data-cowart-stroke x="30" y="80" width="160" height="70"></rect><text x="110" y="120" text-anchor="middle">Source</text></g>',
    '<g data-cowart-object-id="target" data-cowart-role="decision" data-cowart-origin="synthesis"><rect data-cowart-stroke x="410" y="80" width="160" height="70"></rect><text x="490" y="120" text-anchor="middle">Target</text></g>',
    `<g data-cowart-relation-id="source-target" data-from="source" data-to="target" data-relation="flow" data-direction="forward" data-path="primary" data-cowart-origin="synthesis"><path class="edge" data-cowart-stroke d="${relationPath}" marker-end="url(#bounds-arrow)"></path></g>`,
    extra,
    "</svg>",
    `<template data-cowart-diagram-spec type="application/json">${safeJson(spec)}</template>`,
    `<template data-cowart-diagram-prompt type="application/json">${safeJson(prompt)}</template>`,
    "</body></html>",
  ].join("");
}

test("semantic SVG validation returns a usable viewBox for aspect-safe canvas sizing", () => {
  const result = validateSemanticSvg(semanticHtml(), { filename: "bounds-demo.html" });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.viewBox, { x: 0, y: 0, width: 600, height: 240 });
});

test("semantic SVG validation rejects a cubic curve whose extrema leave the viewBox", () => {
  const result = validateSemanticSvg(
    semanticHtml({ relationPath: "M 190 115 C 900 115 900 115 410 115" }),
    { filename: "curve-overflow.html" },
  );

  assert.ok(result.errors.some((error) => /exceeds the safe viewBox bounds/.test(error)));
});

test("semantic SVG validation rejects labels that would be clipped by the viewport", () => {
  const result = validateSemanticSvg(
    semanticHtml({ extra: '<text x="590" y="120">This label is outside</text>' }),
    { filename: "label-overflow.html" },
  );

  assert.ok(result.errors.some((error) => /text .*exceeds the safe viewBox bounds/.test(error)));
});

test("semantic SVG validation rejects geometry features that can bypass viewBox bounds", async (t) => {
  const valid = semanticHtml();
  const cases = [
    {
      name: "inline group transform",
      source: valid.replace(
        '<g data-cowart-object-id="target"',
        '<g style="transform:translate(100000px,0)" data-cowart-object-id="target"',
      ),
      expected: /inline transform/,
    },
    {
      name: "root transform",
      source: valid.replace('<svg viewBox=', '<svg transform="translate(100000 0)" viewBox='),
      expected: /cannot bounds-validate transform/,
    },
    {
      name: "CSS translate",
      source: valid.replace('.edge{', '.edge{translate:100000px;'),
      expected: /CSS translate/,
    },
    {
      name: "use element",
      source: valid.replace('</svg>', '<use href="#bounds-arrow" x="100000"></use></svg>'),
      expected: /unsupported SVG element <use>/,
    },
    {
      name: "animate element",
      source: valid.replace('</svg>', '<animate attributeName="x" to="100000"></animate></svg>'),
      expected: /unsupported SVG element <animate>/,
    },
    {
      name: "inherited group stroke width",
      source: valid.replace(
        '<g data-cowart-object-id="target"',
        '<g stroke-width="100000" data-cowart-object-id="target"',
      ),
      expected: /forbids inherited stroke-width/,
    },
    {
      name: "CSS group font size",
      source: valid.replace('</style>', 'g{font-size:100000px}</style>'),
      expected: /CSS font-size .*simple class selector/,
    },
    {
      name: "CSS ancestor font size",
      source: valid
        .replace('<body>', '<body class="diagram-shell">')
        .replace('</style>', '.diagram-shell{font-size:100000px}</style>'),
      expected: /CSS font-size .*simple class selector/,
    },
    {
      name: "CSS variable stroke width",
      source: valid
        .replace('</style>', ':root{--evil:100000px}.node-frame{stroke-width:var(--evil)}</style>')
        .replace('data-cowart-stroke x="410"', 'class="node-frame" data-cowart-stroke x="410"'),
      expected: /CSS stroke-width .*must be/,
    },
    {
      name: "oversized marker",
      source: valid.replace('markerWidth="7"', 'markerWidth="100000"'),
      expected: /marker #bounds-arrow dimensions/,
    },
    {
      name: "oversized text",
      source: valid.replace('x="490" y="120"', 'x="490" y="120" font-size="100000"'),
      expected: /font-size must be/,
    },
    {
      name: "boundary stroke cannot bypass padding",
      source: valid.replace(
        'data-cowart-stroke x="0" y="0"',
        'data-cowart-stroke stroke-width="100000" x="0" y="0"',
      ),
      expected: /stroke-width must be/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const result = validateSemanticSvg(fixture.source, { filename: `${fixture.name}.html` });
      assert.ok(
        result.errors.some((error) => fixture.expected.test(error)),
        `expected ${fixture.expected}; got ${result.errors.join("; ")}`,
      );
    });
  }
});
