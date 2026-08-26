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
const ALLOWED_SVG_TAGS = new Set([
  "svg",
  "title",
  "desc",
  "defs",
  "marker",
  "g",
  "path",
  "rect",
  "line",
  "circle",
  "ellipse",
  "polyline",
  "polygon",
  "text",
  "tspan",
]);
const SVG_CONTAINER_TAGS = new Set(["svg", "g", "defs", "marker"]);
const SVG_STROKE_TAGS = new Set(["path", "rect", "line", "circle", "ellipse", "polyline", "polygon"]);
const SVG_MARKER_TAGS = new Set(["path", "line", "polyline"]);
const SVG_TEXT_TAGS = new Set(["text", "tspan"]);
const SVG_GEOMETRY_PROPERTIES = new Set([
  "stroke-width",
  "marker-start",
  "marker-mid",
  "marker-end",
  "font-size",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
]);
const SVG_MOTION_PROPERTIES = new Set([
  "transform",
  "transform-origin",
  "transform-box",
  "translate",
  "rotate",
  "scale",
  "offset-path",
  "offset-distance",
  "offset-rotate",
]);
const MAX_STROKE_WIDTH = 64;
const MAX_FONT_SIZE = 512;
const MAX_TEXT_SPACING = 256;
const MAX_MARKER_SIZE = 64;
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
    start: match.index ?? 0,
  }));
}

function collectOpenAncestors(source, endIndex) {
  const stack = [];
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const prefix = String(source || "").slice(0, Math.max(0, endIndex));
  const pattern = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:._-]*)([^<>]*?)>/g;
  for (const match of prefix.matchAll(pattern)) {
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    if (closing) {
      const index = stack.map((tag) => tag.name).lastIndexOf(name);
      if (index >= 0) stack.splice(index);
      continue;
    }
    if (voidTags.has(name) || /\/\s*$/.test(match[3])) continue;
    stack.push({name, attributes: parseAttributes(match[3])});
  }
  return stack;
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
  return Boolean(parseViewBox(value));
}

function parseViewBox(value) {
  if (!value) return null;
  const values = value.trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || !values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) {
    return null;
  }
  return {x: values[0], y: values[1], width: values[2], height: values[3]};
}

function finiteAttribute(attributes, name, fallback = 0) {
  const value = Number(attributes.get(name));
  return Number.isFinite(value) ? value : fallback;
}

function boundsFromPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

function unionGeometryBounds(boundsList) {
  const bounds = boundsList.filter(Boolean);
  if (bounds.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of bounds) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  }
  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

function quadraticAt(start, control, end, time) {
  const inverse = 1 - time;
  return inverse * inverse * start + 2 * inverse * time * control + time * time * end;
}

function cubicAt(start, first, second, end, time) {
  const inverse = 1 - time;
  return (
    inverse ** 3 * start +
    3 * inverse * inverse * time * first +
    3 * inverse * time * time * second +
    time ** 3 * end
  );
}

function quadraticExtrema(start, control, end) {
  const denominator = start - 2 * control + end;
  if (Math.abs(denominator) < 1e-9) return [];
  const time = (start - control) / denominator;
  return time > 0 && time < 1 ? [time] : [];
}

function cubicExtrema(start, first, second, end) {
  const a = -start + 3 * first - 3 * second + end;
  const b = 2 * (start - 2 * first + second);
  const c = first - start;
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) < 1e-9) return [];
    const time = -c / b;
    return time > 0 && time < 1 ? [time] : [];
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)]
    .filter((time) => time > 0 && time < 1);
}

function arcPoints(start, rxValue, ryValue, rotationValue, largeArcValue, sweepValue, end) {
  let rx = Math.abs(rxValue);
  let ry = Math.abs(ryValue);
  if (rx < 1e-9 || ry < 1e-9 || (Math.abs(start.x - end.x) < 1e-9 && Math.abs(start.y - end.y) < 1e-9)) {
    return [start, end];
  }
  const rotation = rotationValue * Math.PI / 180;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const midpointX = (start.x - end.x) / 2;
  const midpointY = (start.y - end.y) / 2;
  const rotatedX = cosine * midpointX + sine * midpointY;
  const rotatedY = -sine * midpointX + cosine * midpointY;
  const scale = rotatedX ** 2 / rx ** 2 + rotatedY ** 2 / ry ** 2;
  if (scale > 1) {
    const multiplier = Math.sqrt(scale);
    rx *= multiplier;
    ry *= multiplier;
  }
  const numerator = Math.max(
    0,
    rx ** 2 * ry ** 2 - rx ** 2 * rotatedY ** 2 - ry ** 2 * rotatedX ** 2,
  );
  const denominator = rx ** 2 * rotatedY ** 2 + ry ** 2 * rotatedX ** 2;
  const direction = Boolean(largeArcValue) === Boolean(sweepValue) ? -1 : 1;
  const coefficient = denominator < 1e-9 ? 0 : direction * Math.sqrt(numerator / denominator);
  const centerRotatedX = coefficient * (rx * rotatedY / ry);
  const centerRotatedY = coefficient * (-ry * rotatedX / rx);
  const center = {
    x: cosine * centerRotatedX - sine * centerRotatedY + (start.x + end.x) / 2,
    y: sine * centerRotatedX + cosine * centerRotatedY + (start.y + end.y) / 2,
  };
  const vectorAngle = (ux, uy, vx, vy) => {
    const length = Math.max(1e-9, Math.hypot(ux, uy) * Math.hypot(vx, vy));
    const angle = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / length)));
    return ux * vy - uy * vx < 0 ? -angle : angle;
  };
  const startVector = {
    x: (rotatedX - centerRotatedX) / rx,
    y: (rotatedY - centerRotatedY) / ry,
  };
  const endVector = {
    x: (-rotatedX - centerRotatedX) / rx,
    y: (-rotatedY - centerRotatedY) / ry,
  };
  const startAngle = vectorAngle(1, 0, startVector.x, startVector.y);
  let sweepAngle = vectorAngle(startVector.x, startVector.y, endVector.x, endVector.y);
  if (!sweepValue && sweepAngle > 0) sweepAngle -= Math.PI * 2;
  if (sweepValue && sweepAngle < 0) sweepAngle += Math.PI * 2;
  const samples = Math.max(24, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 48)));
  return Array.from({length: samples + 1}, (_value, index) => {
    const angle = startAngle + sweepAngle * index / samples;
    return {
      x: center.x + cosine * rx * Math.cos(angle) - sine * ry * Math.sin(angle),
      y: center.y + sine * rx * Math.cos(angle) + cosine * ry * Math.sin(angle),
    };
  });
}

function pathGeometryBounds(pathData) {
  const tokens = String(pathData || "").match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  let index = 0;
  let command = null;
  let previousCommand = null;
  let current = {x: 0, y: 0};
  let subpathStart = {x: 0, y: 0};
  let cubicControl = null;
  let quadraticControl = null;
  const points = [];
  const isCommand = (value) => /^[A-Za-z]$/.test(value || "");
  const readNumbers = (count) => {
    if (index + count > tokens.length || tokens.slice(index, index + count).some(isCommand)) return null;
    const values = tokens.slice(index, index + count).map(Number);
    if (!values.every(Number.isFinite)) return null;
    index += count;
    return values;
  };
  const point = (x, y, relative) => ({
    x: relative ? current.x + x : x,
    y: relative ? current.y + y : y,
  });
  const addLine = (end) => {
    points.push(current, end);
    current = end;
  };
  const addQuadratic = (control, end) => {
    points.push(current, end);
    for (const time of new Set([
      ...quadraticExtrema(current.x, control.x, end.x),
      ...quadraticExtrema(current.y, control.y, end.y),
    ])) {
      points.push({
        x: quadraticAt(current.x, control.x, end.x, time),
        y: quadraticAt(current.y, control.y, end.y, time),
      });
    }
    current = end;
    quadraticControl = control;
    cubicControl = null;
  };
  const addCubic = (first, second, end) => {
    points.push(current, end);
    for (const time of new Set([
      ...cubicExtrema(current.x, first.x, second.x, end.x),
      ...cubicExtrema(current.y, first.y, second.y, end.y),
    ])) {
      points.push({
        x: cubicAt(current.x, first.x, second.x, end.x, time),
        y: cubicAt(current.y, first.y, second.y, end.y, time),
      });
    }
    current = end;
    cubicControl = second;
    quadraticControl = null;
  };

  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command) return {bounds: null, error: "path data starts without a command"};
    const upper = command.toUpperCase();
    const relative = command !== upper;
    if (upper === "Z") {
      addLine(subpathStart);
      previousCommand = command;
      command = null;
      cubicControl = null;
      quadraticControl = null;
      continue;
    }
    const parameterCounts = {M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7};
    const count = parameterCounts[upper];
    if (!count) return {bounds: null, error: `unsupported path command ${command}`};
    const values = readNumbers(count);
    if (!values) return {bounds: null, error: `path command ${command} has incomplete coordinates`};

    if (upper === "M") {
      current = point(values[0], values[1], relative);
      subpathStart = current;
      points.push(current);
      command = relative ? "l" : "L";
      cubicControl = null;
      quadraticControl = null;
    } else if (upper === "L") {
      addLine(point(values[0], values[1], relative));
      cubicControl = null;
      quadraticControl = null;
    } else if (upper === "H") {
      addLine({x: relative ? current.x + values[0] : values[0], y: current.y});
      cubicControl = null;
      quadraticControl = null;
    } else if (upper === "V") {
      addLine({x: current.x, y: relative ? current.y + values[0] : values[0]});
      cubicControl = null;
      quadraticControl = null;
    } else if (upper === "C") {
      addCubic(
        point(values[0], values[1], relative),
        point(values[2], values[3], relative),
        point(values[4], values[5], relative),
      );
    } else if (upper === "S") {
      const first = previousCommand && /[CS]/i.test(previousCommand) && cubicControl
        ? {x: current.x * 2 - cubicControl.x, y: current.y * 2 - cubicControl.y}
        : current;
      addCubic(first, point(values[0], values[1], relative), point(values[2], values[3], relative));
    } else if (upper === "Q") {
      addQuadratic(point(values[0], values[1], relative), point(values[2], values[3], relative));
    } else if (upper === "T") {
      const control = previousCommand && /[QT]/i.test(previousCommand) && quadraticControl
        ? {x: current.x * 2 - quadraticControl.x, y: current.y * 2 - quadraticControl.y}
        : current;
      addQuadratic(control, point(values[0], values[1], relative));
    } else if (upper === "A") {
      const end = point(values[5], values[6], relative);
      points.push(...arcPoints(current, values[0], values[1], values[2], values[3], values[4], end));
      current = end;
      cubicControl = null;
      quadraticControl = null;
    }
    previousCommand = command;
  }
  return {bounds: boundsFromPoints(points), error: null};
}

function styleProperty(style, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(style || "").match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "i"));
  return match?.[1]?.trim() ?? null;
}

function collectCssRules(source) {
  const rules = [];
  const styleBlocks = [...String(source || "").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)];
  for (const styleBlock of styleBlocks) {
    const css = styleBlock[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim();
      if (!selector || selector.startsWith("@")) continue;
      rules.push({selector, declarations: match[2]});
    }
  }
  return rules;
}

function classStyleProperty(source, classNames, property) {
  const wantedClasses = new Set(String(classNames || "").split(/\s+/).filter(Boolean));
  if (wantedClasses.size === 0) return null;
  let resolved = null;
  for (const rule of collectCssRules(source)) {
    for (const selector of rule.selector.split(",").map((value) => value.trim())) {
      const match = selector.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)$/);
      if (!match || !wantedClasses.has(match[1])) continue;
      const value = styleProperty(rule.declarations, property);
      if (value !== null) resolved = value;
    }
  }
  return resolved;
}

function presentationStyle(attributes, source, property) {
  const inline = styleProperty(attributes.get("style"), property);
  if (inline !== null) return inline;
  const classValue = classStyleProperty(source, attributes.get("class"), property);
  if (classValue !== null) return classValue;
  return attributes.has(property) ? attributes.get(property) : null;
}

function parseStrictLength(value, {units = ["", "px"], relativeTo = 1} = {}) {
  const source = String(value ?? "").trim();
  const match = source.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(px|em)?$/i);
  if (!match) return null;
  const unit = (match[2] || "").toLowerCase();
  if (!units.includes(unit)) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return null;
  return unit === "em" ? numeric * relativeTo : numeric;
}

function numericStyle(
  attributes,
  source,
  property,
  fallback,
  {errors = null, label = property, min = 0, max = Infinity, units = ["", "px"], relativeTo = 1} = {},
) {
  const raw = presentationStyle(attributes, source, property);
  if (raw === null || raw === undefined || raw === "") return fallback;
  const value = parseStrictLength(raw, {units, relativeTo});
  if (value === null || value < min || value > max) {
    errors?.push(
      `${label} must be a finite ${units.join("/") || "unitless"} value between ${min} and ${max}; got ${raw}`,
    );
    return fallback;
  }
  return value;
}

function textStyle(attributes, source, property, fallback) {
  return presentationStyle(attributes, source, property) ?? fallback;
}

function styleDeclarations(style) {
  const declarations = new Map();
  for (const part of String(style || "").split(";")) {
    const separator = part.indexOf(":");
    if (separator < 1) continue;
    declarations.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  return declarations;
}

function allowedTagsForGeometryProperty(property) {
  if (property === "stroke-width") return SVG_STROKE_TAGS;
  if (property.startsWith("marker-")) return SVG_MARKER_TAGS;
  return SVG_TEXT_TAGS;
}

function selectorCouldTargetSvg(selector, svgClasses, ancestorClasses = new Set(), ancestorTags = new Set()) {
  const source = String(selector || "");
  if (/(?:^|[\s>+~,])(?:svg|g|path|rect|line|circle|ellipse|polyline|polygon|text|tspan)(?=$|[\s>+~,.\[:#])/i.test(source)) {
    return true;
  }
  if (/(?:^|[\s>+~,])(?:\*|:root|html|body)(?=$|[\s>+~,.\[:#])/i.test(source)) return true;
  if (/\[\s*data-cowart-/i.test(source)) return true;
  for (const match of source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
    if (svgClasses.has(match[1]) || ancestorClasses.has(match[1])) return true;
  }
  for (const tagName of ancestorTags) {
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[\\s>+~,])${escaped}(?=$|[\\s>+~,.\\[:#])`, "i").test(source)) return true;
  }
  return false;
}

function validateSvgVocabularyAndStyles(svg, label, errors, documentSource) {
  const tags = collectTags(svg.source).filter((tag) => !tag.closing);
  const ancestors = collectOpenAncestors(documentSource, svg.start ?? 0);
  const ancestorClasses = new Set();
  const ancestorTags = new Set();
  for (const ancestor of ancestors) {
    ancestorTags.add(ancestor.name);
    for (const className of String(ancestor.attributes.get("class") || "").split(/\s+/).filter(Boolean)) {
      ancestorClasses.add(className);
    }
    const declarations = styleDeclarations(ancestor.attributes.get("style"));
    for (const property of SVG_GEOMETRY_PROPERTIES) {
      if (ancestor.attributes.has(property) || declarations.has(property)) {
        errors.push(`${label} forbids inherited ${property} on ancestor <${ancestor.name}>`);
      }
    }
  }
  const svgClassTags = new Map();
  for (const tag of tags) {
    if (!ALLOWED_SVG_TAGS.has(tag.name)) {
      errors.push(`${label} contains unsupported SVG element <${tag.name}>`);
    }
    for (const className of String(tag.attributes.get("class") || "").split(/\s+/).filter(Boolean)) {
      if (!svgClassTags.has(className)) svgClassTags.set(className, new Set());
      svgClassTags.get(className).add(tag.name);
    }
    for (const property of SVG_MOTION_PROPERTIES) {
      if (tag.attributes.has(property)) {
        errors.push(`${label} cannot bounds-validate ${property} on <${tag.name}>; bake coordinates into the viewBox`);
      }
    }
    const inlineDeclarations = styleDeclarations(tag.attributes.get("style"));
    for (const property of SVG_MOTION_PROPERTIES) {
      if (inlineDeclarations.has(property)) {
        errors.push(`${label} cannot bounds-validate inline ${property} on <${tag.name}>`);
      }
    }
    if (SVG_CONTAINER_TAGS.has(tag.name)) {
      for (const property of SVG_GEOMETRY_PROPERTIES) {
        if (tag.attributes.has(property) || inlineDeclarations.has(property)) {
          errors.push(`${label} forbids inherited ${property} on container <${tag.name}>`);
        }
      }
    }
  }

  const svgClasses = new Set(svgClassTags.keys());
  for (const rule of collectCssRules(documentSource)) {
    const declarations = styleDeclarations(rule.declarations);
    for (const property of SVG_MOTION_PROPERTIES) {
      if (declarations.has(property)) {
        errors.push(`${label} cannot bounds-validate CSS ${property} in selector ${rule.selector}`);
      }
    }
    for (const property of SVG_GEOMETRY_PROPERTIES) {
      if (!declarations.has(property)) continue;
      for (const selector of rule.selector.split(",").map((value) => value.trim()).filter(Boolean)) {
        const simpleClass = selector.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)$/);
        if (simpleClass && svgClassTags.has(simpleClass[1])) {
          const allowedTags = allowedTagsForGeometryProperty(property);
          const actualTags = svgClassTags.get(simpleClass[1]);
          if ([...actualTags].some((tagName) => !allowedTags.has(tagName))) {
            errors.push(
              `${label} CSS ${property} may target unsupported or inheriting SVG elements via ${selector}`,
            );
          }
          const raw = declarations.get(property);
          if (property === "stroke-width") {
            const parsed = parseStrictLength(raw);
            if (parsed === null || parsed < 0 || parsed > MAX_STROKE_WIDTH) {
              errors.push(`${label} CSS ${property} in ${selector} must be 0–${MAX_STROKE_WIDTH}px; got ${raw}`);
            }
          } else if (property === "font-size") {
            const parsed = parseStrictLength(raw);
            if (parsed === null || parsed <= 0 || parsed > MAX_FONT_SIZE) {
              errors.push(`${label} CSS ${property} in ${selector} must be >0–${MAX_FONT_SIZE}px; got ${raw}`);
            }
          } else if (property === "letter-spacing" || property === "word-spacing") {
            const parsed = raw === "normal" ? 0 : parseStrictLength(raw, {units: ["", "px", "em"]});
            if (parsed === null || Math.abs(parsed) > MAX_TEXT_SPACING) {
              errors.push(`${label} CSS ${property} in ${selector} is not a bounded numeric value; got ${raw}`);
            }
          } else if (property === "text-anchor" && !new Set(["start", "middle", "end"]).has(raw)) {
            errors.push(`${label} CSS text-anchor in ${selector} must be start, middle, or end; got ${raw}`);
          } else if (property.startsWith("marker-") && !/^(?:none|url\(\s*#[A-Za-z_][A-Za-z0-9:._-]*\s*\))$/.test(raw)) {
            errors.push(`${label} CSS ${property} in ${selector} must be none or an internal marker URL`);
          }
          continue;
        }
        if (selectorCouldTargetSvg(selector, svgClasses, ancestorClasses, ancestorTags)) {
          errors.push(
            `${label} CSS ${property} that can affect SVG geometry must use a simple class selector on a supported leaf element: ${selector}`,
          );
        }
      }
    }
  }
}

function expandGeometryBounds(bounds, padding) {
  if (!bounds) return null;
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

function primitiveGeometryBounds(name, attributes) {
  if (name === "rect") {
    return {
      x: finiteAttribute(attributes, "x"),
      y: finiteAttribute(attributes, "y"),
      width: Math.max(0, finiteAttribute(attributes, "width")),
      height: Math.max(0, finiteAttribute(attributes, "height")),
    };
  }
  if (name === "line") {
    return boundsFromPoints([
      {x: finiteAttribute(attributes, "x1"), y: finiteAttribute(attributes, "y1")},
      {x: finiteAttribute(attributes, "x2"), y: finiteAttribute(attributes, "y2")},
    ]);
  }
  if (name === "circle") {
    const radius = Math.max(0, finiteAttribute(attributes, "r"));
    const cx = finiteAttribute(attributes, "cx");
    const cy = finiteAttribute(attributes, "cy");
    return {x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2};
  }
  if (name === "ellipse") {
    const rx = Math.max(0, finiteAttribute(attributes, "rx"));
    const ry = Math.max(0, finiteAttribute(attributes, "ry"));
    const cx = finiteAttribute(attributes, "cx");
    const cy = finiteAttribute(attributes, "cy");
    return {x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2};
  }
  if (name === "polyline" || name === "polygon") {
    const values = String(attributes.get("points") || "")
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter(Number.isFinite);
    const points = [];
    for (let index = 0; index + 1 < values.length; index += 2) {
      points.push({x: values[index], y: values[index + 1]});
    }
    return boundsFromPoints(points);
  }
  return null;
}

function decodedTextUnits(value) {
  const text = String(value || "")
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, "x")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).reduce(
    (total, character) => total + (/[^\u0000-\u00ff]/u.test(character) ? 1 : 0.58),
    0,
  );
}

function textLineBounds(attributes, text, source, inherited = {}, validation = {}) {
  const x = Number.isFinite(Number(attributes.get("x")))
    ? Number(attributes.get("x"))
    : inherited.x ?? 0;
  const y = Number.isFinite(Number(attributes.get("y")))
    ? Number(attributes.get("y"))
    : inherited.y ?? 0;
  const fontSize = numericStyle(attributes, source, "font-size", inherited.fontSize ?? 16, {
    errors: validation.errors,
    label: `${validation.label ?? "text"} font-size`,
    min: 0.01,
    max: MAX_FONT_SIZE,
  });
  const anchor = textStyle(attributes, source, "text-anchor", inherited.anchor ?? "start");
  if (!new Set(["start", "middle", "end"]).has(anchor)) {
    validation.errors?.push(`${validation.label ?? "text"} text-anchor must be start, middle, or end; got ${anchor}`);
  }
  const letterSpacingRaw = textStyle(attributes, source, "letter-spacing", "normal");
  const wordSpacingRaw = textStyle(attributes, source, "word-spacing", "normal");
  const letterSpacing = letterSpacingRaw === "normal"
    ? 0
    : numericStyle(attributes, source, "letter-spacing", 0, {
      errors: validation.errors,
      label: `${validation.label ?? "text"} letter-spacing`,
      min: -MAX_TEXT_SPACING,
      max: MAX_TEXT_SPACING,
      units: ["", "px", "em"],
      relativeTo: fontSize,
    });
  const wordSpacing = wordSpacingRaw === "normal"
    ? 0
    : numericStyle(attributes, source, "word-spacing", 0, {
      errors: validation.errors,
      label: `${validation.label ?? "text"} word-spacing`,
      min: -MAX_TEXT_SPACING,
      max: MAX_TEXT_SPACING,
      units: ["", "px", "em"],
      relativeTo: fontSize,
    });
  const characters = Array.from(String(text || ""));
  const width = Math.max(
    fontSize * 0.5,
    decodedTextUnits(text) * fontSize +
      Math.max(0, characters.length - 1) * letterSpacing +
      characters.filter((character) => /\s/u.test(character)).length * wordSpacing,
  );
  const left = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  return {
    x: left,
    y: y - fontSize,
    width,
    height: fontSize * 1.3,
    baseline: y,
    fontSize,
    anchor,
  };
}

function textGeometryBounds(attributes, body, source, validation = {}) {
  const inherited = {
    x: finiteAttribute(attributes, "x"),
    y: finiteAttribute(attributes, "y"),
    fontSize: numericStyle(attributes, source, "font-size", 16, {
      errors: validation.errors,
      label: `${validation.label ?? "text"} font-size`,
      min: 0.01,
      max: MAX_FONT_SIZE,
    }),
    anchor: textStyle(attributes, source, "text-anchor", "start"),
  };
  const tspanMatches = [...String(body || "").matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan\s*>/gi)];
  if (tspanMatches.length === 0) {
    return textLineBounds(
      attributes,
      String(body || "").replace(/<[^>]+>/g, ""),
      source,
      inherited,
      validation,
    );
  }
  let baseline = inherited.y;
  const lines = [];
  for (const match of tspanMatches) {
    const lineAttributes = parseAttributes(match[1]);
    const dy = parseStrictLength(lineAttributes.get("dy"), {units: ["", "px", "em"], relativeTo: inherited.fontSize});
    if (lineAttributes.has("dy") && dy === null) {
      validation.errors?.push(`${validation.label ?? "text"} tspan dy must be a finite number, px, or em value`);
    }
    if (!Number.isFinite(Number(lineAttributes.get("y"))) && Number.isFinite(dy)) baseline += dy;
    if (!lineAttributes.has("y")) lineAttributes.set("y", String(baseline));
    const line = textLineBounds(
      lineAttributes,
      match[2].replace(/<[^>]+>/g, ""),
      source,
      inherited,
      validation,
    );
    baseline = line.baseline;
    lines.push(line);
  }
  return unionGeometryBounds(lines);
}

function isCanvasBoundaryRect(bounds, viewBox) {
  const tolerance = 0.01;
  return (
    Math.abs(bounds.x - viewBox.x) <= tolerance &&
    Math.abs(bounds.y - viewBox.y) <= tolerance &&
    Math.abs(bounds.width - viewBox.width) <= tolerance &&
    Math.abs(bounds.height - viewBox.height) <= tolerance
  );
}

function validateGeometryBounds(bounds, viewBox, safePadding, label, errors, {allowBoundary = false} = {}) {
  if (!bounds) return;
  if (allowBoundary) return;
  const safe = {
    left: viewBox.x + safePadding,
    top: viewBox.y + safePadding,
    right: viewBox.x + viewBox.width - safePadding,
    bottom: viewBox.y + viewBox.height - safePadding,
  };
  const epsilon = 0.01;
  if (
    bounds.x < safe.left - epsilon ||
    bounds.y < safe.top - epsilon ||
    bounds.x + bounds.width > safe.right + epsilon ||
    bounds.y + bounds.height > safe.bottom + epsilon
  ) {
    errors.push(
      `${label} exceeds the safe viewBox bounds (${safe.left.toFixed(1)}, ${safe.top.toFixed(1)})–` +
      `(${safe.right.toFixed(1)}, ${safe.bottom.toFixed(1)}); enlarge the viewBox or move the element inward`,
    );
  }
}

function collectMarkerDefinitions(svgSource, label, errors) {
  const markers = new Map();
  for (const match of String(svgSource || "").matchAll(/<marker\b([^>]*)>([\s\S]*?)<\/marker\s*>/gi)) {
    const attributes = parseAttributes(match[1]);
    const id = attributes.get("id");
    if (!id) {
      errors.push(`${label} marker needs an id`);
      continue;
    }
    const markerWidth = parseStrictLength(attributes.get("markerwidth") ?? "3");
    const markerHeight = parseStrictLength(attributes.get("markerheight") ?? "3");
    if (
      markerWidth === null || markerHeight === null || markerWidth <= 0 || markerHeight <= 0 ||
      markerWidth > MAX_MARKER_SIZE || markerHeight > MAX_MARKER_SIZE
    ) {
      errors.push(`${label} marker #${id} dimensions must be >0–${MAX_MARKER_SIZE}; got ${attributes.get("markerwidth") ?? "3"} × ${attributes.get("markerheight") ?? "3"}`);
      continue;
    }
    const markerUnits = attributes.get("markerunits") || "strokeWidth";
    if (!new Set(["strokeWidth", "userSpaceOnUse"]).has(markerUnits)) {
      errors.push(`${label} marker #${id} has unsupported markerUnits ${markerUnits}`);
    }
    const markerViewBox = attributes.has("viewbox") ? parseViewBox(attributes.get("viewbox")) : null;
    if (attributes.has("viewbox") && !markerViewBox) {
      errors.push(`${label} marker #${id} needs a valid viewBox`);
    }
    const refX = parseStrictLength(attributes.get("refx") ?? "0", {units: ["", "px"]});
    const refY = parseStrictLength(attributes.get("refy") ?? "0", {units: ["", "px"]});
    if (refX === null || refY === null) {
      errors.push(`${label} marker #${id} refX/refY must be finite numbers`);
    } else if (
      markerViewBox &&
      (
        refX < markerViewBox.x || refX > markerViewBox.x + markerViewBox.width ||
        refY < markerViewBox.y || refY > markerViewBox.y + markerViewBox.height
      )
    ) {
      errors.push(`${label} marker #${id} refX/refY must stay inside its viewBox`);
    }
    markers.set(id, {width: markerWidth, height: markerHeight, units: markerUnits});
  }
  return markers;
}

function markerVisualPadding(attributes, source, strokeWidth, markers, label, errors) {
  let padding = 0;
  for (const property of ["marker-start", "marker-mid", "marker-end"]) {
    const raw = presentationStyle(attributes, source, property);
    if (raw === null || raw === "none") continue;
    const match = String(raw).trim().match(/^url\(\s*#([A-Za-z_][A-Za-z0-9:._-]*)\s*\)$/);
    if (!match) {
      errors.push(`${label} ${property} must be none or an internal marker URL`);
      continue;
    }
    const marker = markers.get(match[1]);
    if (!marker) {
      errors.push(`${label} ${property} references missing marker #${match[1]}`);
      continue;
    }
    const scale = marker.units === "strokeWidth" ? strokeWidth : 1;
    padding = Math.max(padding, Math.max(marker.width, marker.height) * scale);
  }
  return padding;
}

function validateSvgGeometry(svg, label, errors, documentSource = svg.source) {
  validateSvgVocabularyAndStyles(svg, label, errors, documentSource);
  const viewBox = parseViewBox(svg.root.get("viewbox"));
  if (!viewBox) return null;
  const safePadding = Math.max(4, Math.min(viewBox.width, viewBox.height) * 0.02);
  const visibleSource = svg.source.replace(/<defs\b[^>]*>[\s\S]*?<\/defs\s*>/gi, "");
  const markers = collectMarkerDefinitions(svg.source, label, errors);

  const primitivePattern = /<(path|rect|line|circle|ellipse|polyline|polygon)\b([^>]*)>/gi;
  let primitiveIndex = 0;
  for (const match of visibleSource.matchAll(primitivePattern)) {
    primitiveIndex += 1;
    const name = match[1].toLowerCase();
    const attributes = parseAttributes(match[2]);
    if (
      textStyle(attributes, documentSource, "display", "") === "none" ||
      textStyle(attributes, documentSource, "visibility", "") === "hidden"
    ) {
      continue;
    }
    let bounds;
    if (name === "path") {
      const result = pathGeometryBounds(attributes.get("d"));
      if (result.error || !result.bounds) {
        errors.push(`${label} path ${primitiveIndex} cannot be bounds-validated: ${result.error ?? "empty path"}`);
        continue;
      }
      bounds = result.bounds;
    } else {
      bounds = primitiveGeometryBounds(name, attributes);
    }
    const id = attributes.get("id") || attributes.get("data-cowart-object-id") ||
      attributes.get("data-cowart-relation-id") || `${name} ${primitiveIndex}`;
    const strokeWidth = numericStyle(attributes, documentSource, "stroke-width", 1.5, {
      errors,
      label: `${label} ${id} stroke-width`,
      min: 0,
      max: MAX_STROKE_WIDTH,
    });
    const hasMarker = ["marker-start", "marker-mid", "marker-end"]
      .some((property) => {
        const value = presentationStyle(attributes, documentSource, property);
        return value !== null && value !== "none";
      });
    if (hasMarker && !SVG_MARKER_TAGS.has(name)) {
      errors.push(`${label} ${id} may only use markers on path, line, or polyline elements`);
    }
    const markerPadding = markerVisualPadding(
      attributes,
      documentSource,
      strokeWidth,
      markers,
      `${label} ${id}`,
      errors,
    );
    const visualBounds = expandGeometryBounds(bounds, strokeWidth / 2 + markerPadding);
    validateGeometryBounds(
      visualBounds,
      viewBox,
      safePadding,
      `${label} ${id}`,
      errors,
      {
        allowBoundary:
          name === "rect" &&
          markerPadding === 0 &&
          strokeWidth <= safePadding * 2 &&
          isCanvasBoundaryRect(bounds, viewBox),
      },
    );
  }

  let textIndex = 0;
  for (const match of visibleSource.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text\s*>/gi)) {
    textIndex += 1;
    const attributes = parseAttributes(match[1]);
    if (
      textStyle(attributes, documentSource, "display", "") === "none" ||
      textStyle(attributes, documentSource, "visibility", "") === "hidden"
    ) {
      continue;
    }
    const id = attributes.get("id") || `text ${textIndex}`;
    const bounds = textGeometryBounds(attributes, match[2], documentSource, {
      errors,
      label: `${label} ${id}`,
    });
    validateGeometryBounds(bounds, viewBox, safePadding, `${label} ${id}`, errors);
  }
  return {viewBox, safePadding};
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
    return {filename, errors, warnings, svgCount: 0, viewBox: null};
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
    const geometry = validateSvgGeometry(svg, label, errors, source);

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
    svgInfos.push({diagramId, objectIds, relationIds, viewBox: geometry?.viewBox ?? null});
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

  return {
    filename,
    errors,
    warnings,
    svgCount: svgBlocks.length,
    viewBox: svgInfos.length === 1 ? svgInfos[0].viewBox : null,
  };
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
    [
      "cubic overflow",
      valid.replace('d="M190 115 H410"', 'd="M190 115 C 900 115 900 115 410 115"'),
      /exceeds the safe viewBox bounds/,
    ],
    [
      "node overflow",
      valid.replace('x="410" y="80" width="160"', 'x="500" y="80" width="160"'),
      /exceeds the safe viewBox bounds/,
    ],
    [
      "marker overflow",
      valid.replace('d="M190 115 H410"', 'd="M190 115 H595"'),
      /exceeds the safe viewBox bounds/,
    ],
    [
      "unbounded transform",
      valid.replace('data-cowart-object-id="decision"', 'transform="translate(200 0)" data-cowart-object-id="decision"'),
      /cannot bounds-validate transform/,
    ],
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
