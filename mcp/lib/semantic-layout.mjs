import { layoutThinkingGraph } from "./thinking-layout.mjs";

const DEFAULT_MAX_CENTER_SCALE = 1.5;
const GEOMETRY_EPSILON = 1e-7;
const MIN_WRAPPED_GAP = 24;

function assertTargetRect(targetRect) {
  if (
    !targetRect ||
    !Number.isFinite(targetRect.x) ||
    !Number.isFinite(targetRect.y) ||
    !Number.isFinite(targetRect.w) ||
    !Number.isFinite(targetRect.h) ||
    targetRect.w <= 0 ||
    targetRect.h <= 0
  ) {
    throw new TypeError("targetRect must contain finite x/y values and positive w/h values");
  }
}

function assertNodes(nodes) {
  if (!Array.isArray(nodes)) throw new TypeError("nodes must be an array");
  const ids = new Set();
  for (const node of nodes) {
    if (!node?.id || !Number.isFinite(node.w) || node.w <= 0 || !Number.isFinite(node.h) || node.h <= 0) {
      throw new TypeError("every node must contain an id and positive finite w/h values");
    }
    if (ids.has(node.id)) throw new TypeError(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
}

function positionFor(positions, id) {
  const position = positions instanceof Map ? positions.get(id) : positions?.[id];
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new TypeError(`missing finite position for node: ${id}`);
  }
  return position;
}

function copyPositions(nodes, positions) {
  return new Map(
    nodes.map((node) => {
      const position = positionFor(positions, node.id);
      return [node.id, { x: position.x, y: position.y }];
    }),
  );
}

function boundsFor(nodes, positions, targetRect) {
  if (nodes.length === 0) {
    return {
      x: targetRect.x + targetRect.w / 2,
      y: targetRect.y + targetRect.h / 2,
      w: 0,
      h: 0,
    };
  }

  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const position = positionFor(positions, node.id);
    left = Math.min(left, position.x);
    top = Math.min(top, position.y);
    right = Math.max(right, position.x + node.w);
    bottom = Math.max(bottom, position.y + node.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function axisSpan(nodes, positions, axis, scale, origin) {
  const sizeKey = axis === "x" ? "w" : "h";
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const position = positionFor(positions, node.id);
    const halfSize = node[sizeKey] / 2;
    const center = position[axis] + halfSize;
    const scaledCenter = origin + (center - origin) * scale;
    minimum = Math.min(minimum, scaledCenter - halfSize);
    maximum = Math.max(maximum, scaledCenter + halfSize);
  }
  return maximum - minimum;
}

function largestFittingScale(nodes, positions, axis, origin, targetSize, maxCenterScale) {
  if (nodes.length < 2 || maxCenterScale === 1) return 1;
  if (axisSpan(nodes, positions, axis, maxCenterScale, origin) <= targetSize) {
    return maxCenterScale;
  }

  let lower = 1;
  let upper = maxCenterScale;
  // A fixed iteration count makes the result deterministic on every call while
  // providing substantially more precision than canvas coordinates require.
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const candidate = (lower + upper) / 2;
    if (axisSpan(nodes, positions, axis, candidate, origin) <= targetSize) {
      lower = candidate;
    } else {
      upper = candidate;
    }
  }
  return lower;
}

function scaleCenters(nodes, positions, bounds, scaleX, scaleY) {
  const originX = bounds.x + bounds.w / 2;
  const originY = bounds.y + bounds.h / 2;
  return new Map(
    nodes.map((node) => {
      const position = positionFor(positions, node.id);
      const centerX = position.x + node.w / 2;
      const centerY = position.y + node.h / 2;
      return [
        node.id,
        {
          x: originX + (centerX - originX) * scaleX - node.w / 2,
          y: originY + (centerY - originY) * scaleY - node.h / 2,
        },
      ];
    }),
  );
}

function centerPositions(nodes, positions, targetRect) {
  const bounds = boundsFor(nodes, positions, targetRect);
  const offsetX = targetRect.x + targetRect.w / 2 - (bounds.x + bounds.w / 2);
  const offsetY = targetRect.y + targetRect.h / 2 - (bounds.y + bounds.h / 2);
  return new Map(
    nodes.map((node) => {
      const position = positionFor(positions, node.id);
      return [node.id, { x: position.x + offsetX, y: position.y + offsetY }];
    }),
  );
}

function findCollisions(nodes, positions) {
  const collisions = [];
  for (let firstIndex = 0; firstIndex < nodes.length; firstIndex += 1) {
    const first = nodes[firstIndex];
    const firstPosition = positionFor(positions, first.id);
    for (let secondIndex = firstIndex + 1; secondIndex < nodes.length; secondIndex += 1) {
      const second = nodes[secondIndex];
      const secondPosition = positionFor(positions, second.id);
      const overlapWidth =
        Math.min(firstPosition.x + first.w, secondPosition.x + second.w) -
        Math.max(firstPosition.x, secondPosition.x);
      const overlapHeight =
        Math.min(firstPosition.y + first.h, secondPosition.y + second.h) -
        Math.max(firstPosition.y, secondPosition.y);
      if (overlapWidth > GEOMETRY_EPSILON && overlapHeight > GEOMETRY_EPSILON) {
        collisions.push({ a: first.id, b: second.id });
      }
    }
  }
  return collisions;
}

function findOutOfBounds(nodes, positions, targetRect) {
  const targetRight = targetRect.x + targetRect.w;
  const targetBottom = targetRect.y + targetRect.h;
  return nodes
    .filter((node) => {
      const position = positionFor(positions, node.id);
      return (
        position.x < targetRect.x - GEOMETRY_EPSILON ||
        position.y < targetRect.y - GEOMETRY_EPSILON ||
        position.x + node.w > targetRight + GEOMETRY_EPSILON ||
        position.y + node.h > targetBottom + GEOMETRY_EPSILON
      );
    })
    .map((node) => node.id);
}

function utilizationFor(diagramBounds, targetRect) {
  const width = diagramBounds.w / targetRect.w;
  const height = diagramBounds.h / targetRect.h;
  return { width, height, area: width * height };
}

function cyclicNodeIds(nodes, edges) {
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const outgoing = new Map(nodes.map(({ id }) => [id, []]));
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!nodeIds.has(edge?.from) || !nodeIds.has(edge?.to)) continue;
    outgoing.get(edge.from).push(edge.to);
  }
  const cyclic = new Set();
  for (const node of nodes) {
    const pending = [...outgoing.get(node.id)];
    const visited = new Set();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === node.id) {
        cyclic.add(node.id);
        break;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(outgoing.get(current) ?? []));
    }
  }
  return cyclic;
}

function initialLayers(nodes, positions, axis, reverse) {
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const coordinateFor = (node, selectedAxis) => {
    const size = selectedAxis === "x" ? node.w : node.h;
    return positionFor(positions, node.id)[selectedAxis] + size / 2;
  };
  const sorted = [...nodes].sort((first, second) => {
    const firstCoordinate = coordinateFor(first, axis);
    const secondCoordinate = coordinateFor(second, axis);
    return (
      (reverse ? secondCoordinate - firstCoordinate : firstCoordinate - secondCoordinate) ||
      order.get(first.id) - order.get(second.id)
    );
  });
  const layers = [];
  for (const node of sorted) {
    const coordinate = coordinateFor(node, axis);
    const previous = layers.at(-1);
    if (!previous || Math.abs(previous.coordinate - coordinate) > GEOMETRY_EPSILON) {
      layers.push({ coordinate, nodes: [node] });
    } else {
      previous.nodes.push(node);
    }
  }
  const crossAxis = axis === "x" ? "y" : "x";
  for (const layer of layers) {
    layer.nodes.sort((first, second) =>
      coordinateFor(first, crossAxis) - coordinateFor(second, crossAxis) ||
      order.get(first.id) - order.get(second.id),
    );
  }
  return layers.map(({ nodes: layerNodes }) => layerNodes);
}

function splitCyclicBands(layer, targetCrossSize, crossSizeKey) {
  const maximumBandSize = Math.max(1, Math.ceil(layer.length / 2));
  for (let bandSize = maximumBandSize; bandSize >= 2; bandSize -= 1) {
    const remainder = layer.length % bandSize;
    const bandSizes = [
      ...(remainder > 0 ? [remainder] : []),
      ...Array.from({ length: Math.floor(layer.length / bandSize) }, () => bandSize),
    ];
    let offset = 0;
    const bands = bandSizes.map((size) => {
      const band = layer.slice(offset, offset + size);
      offset += size;
      return band;
    });
    const requiredCrossSize = Math.max(
      ...bands.map((band) =>
        band.reduce((total, node) => total + node[crossSizeKey], 0) +
        MIN_WRAPPED_GAP * Math.max(0, band.length - 1),
      ),
    );
    if (requiredCrossSize <= targetCrossSize + GEOMETRY_EPSILON) return bands;
  }
  return null;
}

function splitIntoFittingRows(layer, targetWidth, cyclic) {
  if (cyclic && layer.length > 2) {
    const cycleBands = splitCyclicBands(layer, targetWidth, "w");
    if (cycleBands) return cycleBands;
  }
  const rows = [];
  let row = [];
  let width = 0;
  for (const node of layer) {
    const candidateWidth = width + (row.length > 0 ? MIN_WRAPPED_GAP : 0) + node.w;
    if (row.length > 0 && candidateWidth > targetWidth + GEOMETRY_EPSILON) {
      rows.push(row);
      row = [];
      width = 0;
    }
    if (node.w > targetWidth + GEOMETRY_EPSILON) return null;
    width += (row.length > 0 ? MIN_WRAPPED_GAP : 0) + node.w;
    row.push(node);
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function splitIntoFittingColumns(layer, targetHeight, cyclic) {
  if (cyclic && layer.length > 2) {
    const cycleBands = splitCyclicBands(layer, targetHeight, "h");
    if (cycleBands) return cycleBands;
  }
  const columns = [];
  let column = [];
  let height = 0;
  for (const node of layer) {
    const candidateHeight = height + (column.length > 0 ? MIN_WRAPPED_GAP : 0) + node.h;
    if (column.length > 0 && candidateHeight > targetHeight + GEOMETRY_EPSILON) {
      columns.push(column);
      column = [];
      height = 0;
    }
    if (node.h > targetHeight + GEOMETRY_EPSILON) return null;
    height += (column.length > 0 ? MIN_WRAPPED_GAP : 0) + node.h;
    column.push(node);
  }
  if (column.length > 0) columns.push(column);
  return columns;
}

function wrappedVerticalPositions({
  nodes,
  edges,
  initialPositions,
  targetRect,
  horizontalGap,
  verticalGap,
  reverse,
}) {
  const cyclic = cyclicNodeIds(nodes, edges);
  const rows = [];
  for (const layer of initialLayers(nodes, initialPositions, "y", reverse)) {
    const wrapped = splitIntoFittingRows(
      layer,
      targetRect.w,
      layer.length > 1 && layer.every((node) => cyclic.has(node.id)),
    );
    if (!wrapped) return null;
    rows.push(...wrapped);
  }
  const heights = rows.map((row) => Math.max(...row.map((node) => node.h)));
  const totalNodeHeight = heights.reduce((total, height) => total + height, 0);
  const availableGap = rows.length > 1
    ? (targetRect.h - totalNodeHeight) / (rows.length - 1)
    : 0;
  if (rows.length > 1 && availableGap < MIN_WRAPPED_GAP - GEOMETRY_EPSILON) return null;
  const rowGap = rows.length > 1 ? Math.min(verticalGap, availableGap) : 0;
  const positions = new Map();
  let y = targetRect.y;
  rows.forEach((row, rowIndex) => {
    const nodeWidth = row.reduce((total, node) => total + node.w, 0);
    const availableCrossGap = row.length > 1
      ? (targetRect.w - nodeWidth) / (row.length - 1)
      : 0;
    if (row.length > 1 && availableCrossGap < MIN_WRAPPED_GAP - GEOMETRY_EPSILON) return;
    const gap = row.length > 1 ? Math.min(horizontalGap, availableCrossGap) : 0;
    const rowWidth = nodeWidth + gap * Math.max(0, row.length - 1);
    let x = targetRect.x + (targetRect.w - rowWidth) / 2;
    for (const node of row) {
      positions.set(node.id, { x, y: y + (heights[rowIndex] - node.h) / 2 });
      x += node.w + gap;
    }
    y += heights[rowIndex] + rowGap;
  });
  if (positions.size !== nodes.length) return null;
  if (reverse) {
    for (const node of nodes) {
      const position = positions.get(node.id);
      position.y = targetRect.y + targetRect.h - (position.y - targetRect.y) - node.h;
    }
  }
  return positions;
}

function wrappedHorizontalPositions({
  nodes,
  edges,
  initialPositions,
  targetRect,
  horizontalGap,
  verticalGap,
  reverse,
}) {
  const cyclic = cyclicNodeIds(nodes, edges);
  const columns = [];
  for (const layer of initialLayers(nodes, initialPositions, "x", reverse)) {
    const wrapped = splitIntoFittingColumns(
      layer,
      targetRect.h,
      layer.length > 1 && layer.every((node) => cyclic.has(node.id)),
    );
    if (!wrapped) return null;
    columns.push(...wrapped);
  }
  const widths = columns.map((column) => Math.max(...column.map((node) => node.w)));
  const totalNodeWidth = widths.reduce((total, width) => total + width, 0);
  const availableGap = columns.length > 1
    ? (targetRect.w - totalNodeWidth) / (columns.length - 1)
    : 0;
  if (columns.length > 1 && availableGap < MIN_WRAPPED_GAP - GEOMETRY_EPSILON) return null;
  const columnGap = columns.length > 1 ? Math.min(verticalGap, availableGap) : 0;
  const positions = new Map();
  let x = targetRect.x;
  columns.forEach((column, columnIndex) => {
    const nodeHeight = column.reduce((total, node) => total + node.h, 0);
    const availableCrossGap = column.length > 1
      ? (targetRect.h - nodeHeight) / (column.length - 1)
      : 0;
    if (column.length > 1 && availableCrossGap < MIN_WRAPPED_GAP - GEOMETRY_EPSILON) return;
    const gap = column.length > 1 ? Math.min(horizontalGap, availableCrossGap) : 0;
    const columnHeight = nodeHeight + gap * Math.max(0, column.length - 1);
    let y = targetRect.y + (targetRect.h - columnHeight) / 2;
    for (const node of column) {
      positions.set(node.id, { x: x + (widths[columnIndex] - node.w) / 2, y });
      y += node.h + gap;
    }
    x += widths[columnIndex] + columnGap;
  });
  if (positions.size !== nodes.length) return null;
  if (reverse) {
    for (const node of nodes) {
      const position = positions.get(node.id);
      position.x = targetRect.x + targetRect.w - (position.x - targetRect.x) - node.w;
    }
  }
  return positions;
}

function wrappedSemanticPositions(options) {
  const horizontal = ["left-to-right", "right-to-left", "board-to-peers"].includes(
    options.readingOrder,
  );
  if (horizontal) {
    return wrappedHorizontalPositions({
      ...options,
      reverse: options.readingOrder === "right-to-left",
    });
  }
  return wrappedVerticalPositions({
    ...options,
    reverse: options.readingOrder === "bottom-to-top",
  });
}

/**
 * Fits precomputed node positions into a fixed rectangle without changing node
 * dimensions. Only center-to-center distances may grow, so existing gaps never
 * become smaller. A layout that is already too large is centered for diagnosis
 * but remains invalid; targetRect is never expanded and the graph is never shrunk.
 */
export function fitSemanticLayout({
  nodes = [],
  positions,
  targetRect,
  maxCenterScale = DEFAULT_MAX_CENTER_SCALE,
} = {}) {
  assertTargetRect(targetRect);
  assertNodes(nodes);
  if (!Number.isFinite(maxCenterScale) || maxCenterScale < 1) {
    throw new TypeError("maxCenterScale must be a finite number greater than or equal to 1");
  }

  const initialPositions = copyPositions(nodes, positions ?? new Map());
  const initialBounds = boundsFor(nodes, initialPositions, targetRect);
  const initiallyFits = initialBounds.w <= targetRect.w && initialBounds.h <= targetRect.h;
  const originX = initialBounds.x + initialBounds.w / 2;
  const originY = initialBounds.y + initialBounds.h / 2;
  const centerScale = initiallyFits
    ? {
        x: largestFittingScale(
          nodes,
          initialPositions,
          "x",
          originX,
          targetRect.w,
          maxCenterScale,
        ),
        y: largestFittingScale(
          nodes,
          initialPositions,
          "y",
          originY,
          targetRect.h,
          maxCenterScale,
        ),
      }
    : { x: 1, y: 1 };

  const expandedPositions = scaleCenters(
    nodes,
    initialPositions,
    initialBounds,
    centerScale.x,
    centerScale.y,
  );
  const fittedPositions = centerPositions(nodes, expandedPositions, targetRect);
  const diagramBounds = boundsFor(nodes, fittedPositions, targetRect);
  const collisions = findCollisions(nodes, fittedPositions);
  const outOfBounds = findOutOfBounds(nodes, fittedPositions, targetRect);

  return {
    positions: fittedPositions,
    diagramBounds,
    utilization: utilizationFor(diagramBounds, targetRect),
    collisions,
    outOfBounds,
    valid: initiallyFits && collisions.length === 0 && outOfBounds.length === 0,
    engine: "html-line-svg",
    centerScale,
  };
}

/**
 * Runs the existing deterministic thinking-graph layout and fits its positions
 * into targetRect using fitSemanticLayout.
 */
export function layoutSemanticGraph({
  nodes = [],
  edges = [],
  targetRect,
  readingOrder = "top-to-bottom",
  horizontalGap = 72,
  verticalGap = 104,
  maxCenterScale = DEFAULT_MAX_CENTER_SCALE,
} = {}) {
  const initialPositions = layoutThinkingGraph({
    nodes,
    edges,
    originX: 0,
    originY: 0,
    horizontalGap,
    verticalGap,
    readingOrder,
  });
  const initialReport = fitSemanticLayout({
    nodes,
    positions: initialPositions,
    targetRect,
    maxCenterScale,
  });
  const preferCycleBands = cyclicNodeIds(nodes, edges).size >= 3;
  if ((initialReport.valid && !preferCycleBands) || nodes.length < 2) return initialReport;

  const wrappedPositions = wrappedSemanticPositions({
    nodes,
    edges,
    initialPositions,
    targetRect,
    readingOrder,
    horizontalGap,
    verticalGap,
  });
  if (!wrappedPositions) return initialReport;
  const wrappedReport = fitSemanticLayout({
    nodes,
    positions: wrappedPositions,
    targetRect,
    maxCenterScale,
  });
  return wrappedReport.valid ? wrappedReport : initialReport;
}
