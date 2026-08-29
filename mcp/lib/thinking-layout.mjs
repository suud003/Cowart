const MIN_CARD_WIDTH = 180;
const MAX_CARD_WIDTH = 560;
const MIN_CARD_HEIGHT = 96;
const MAX_CARD_HEIGHT = 460;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function textUnits(value) {
  let units = 0;
  for (const character of String(value || "")) {
    if (character === "\n") continue;
    units += /[\u2e80-\u9fff\uf900-\ufaff]/u.test(character) ? 1 : 0.56;
  }
  return units;
}

function estimatedLines(value, unitsPerLine) {
  if (!value) return 0;
  return String(value)
    .split(/\r?\n/u)
    .reduce((total, line) => total + Math.max(1, Math.ceil(textUnits(line) / unitsPerLine)), 0);
}

export function estimateThinkingCardSize({ title = "", body = "", w, h } = {}) {
  const hasBody = Boolean(String(body).trim());
  const titleWidth = 72 + textUnits(title) * 19;
  const bodyWidth = 300 + Math.sqrt(Math.max(1, textUnits(body))) * 12;
  const width = clamp(
    Number.isFinite(w) ? w : hasBody ? bodyWidth : titleWidth,
    MIN_CARD_WIDTH,
    MAX_CARD_WIDTH,
  );

  if (Number.isFinite(h)) {
    return { w: width, h: clamp(h, 80, 2_000) };
  }

  if (!hasBody) return { w: width, h: MIN_CARD_HEIGHT };

  const contentWidth = Math.max(120, width - 48);
  const unitsPerLine = Math.max(8, contentWidth / 18);
  const titleLines = estimatedLines(title, unitsPerLine);
  const bodyLines = estimatedLines(body, unitsPerLine);
  // tldraw's draw font has a larger real line box than its nominal font size.
  // Keep an explicit bottom safety band so the last body line never clips at
  // common Windows font-rendering scales.
  const height = 64 + titleLines * 28 + bodyLines * 27 + (title && body ? 18 : 0);
  return { w: width, h: clamp(height, 152, MAX_CARD_HEIGHT) };
}

export function layoutThinkingGraph({
  nodes,
  edges,
  originX = 0,
  originY = 0,
  horizontalGap = 72,
  verticalGap = 104,
  readingOrder = "top-to-bottom",
} = {}) {
  const validNodes = Array.isArray(nodes)
    ? nodes.filter((node) => node?.id && Number.isFinite(node.w) && Number.isFinite(node.h))
    : [];
  if (validNodes.length === 0) return new Map();

  const nodeIds = new Set(validNodes.map((node) => node.id));
  const order = new Map(validNodes.map((node, index) => [node.id, index]));
  const outgoing = new Map(validNodes.map((node) => [node.id, []]));

  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!nodeIds.has(edge?.from) || !nodeIds.has(edge?.to) || edge.from === edge.to) continue;
    if (outgoing.get(edge.from).includes(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
  }

  let nextIndex = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const stacked = new Set();
  const components = [];
  function visit(id) {
    indexes.set(id, nextIndex);
    lowLinks.set(id, nextIndex);
    nextIndex += 1;
    stack.push(id);
    stacked.add(id);
    for (const target of outgoing.get(id)) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(id, Math.min(lowLinks.get(id), lowLinks.get(target)));
      } else if (stacked.has(target)) {
        lowLinks.set(id, Math.min(lowLinks.get(id), indexes.get(target)));
      }
    }
    if (lowLinks.get(id) !== indexes.get(id)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      stacked.delete(member);
      component.push(member);
      if (member === id) break;
    }
    component.sort((first, second) => order.get(first) - order.get(second));
    components.push(component);
  }
  for (const node of validNodes) {
    if (!indexes.has(node.id)) visit(node.id);
  }

  const componentFor = new Map();
  components.forEach((component, index) => component.forEach((id) => componentFor.set(id, index)));
  const componentEdges = new Map(components.map((_component, index) => [index, new Set()]));
  const indegree = new Map(components.map((_component, index) => [index, 0]));
  for (const [from, targets] of outgoing) {
    const sourceComponent = componentFor.get(from);
    for (const target of targets) {
      const targetComponent = componentFor.get(target);
      if (sourceComponent === targetComponent || componentEdges.get(sourceComponent).has(targetComponent)) continue;
      componentEdges.get(sourceComponent).add(targetComponent);
      indegree.set(targetComponent, indegree.get(targetComponent) + 1);
    }
  }

  const componentOrder = new Map(
    components.map((component, index) => [index, Math.min(...component.map((id) => order.get(id)))]),
  );
  const queue = [...indegree.entries()]
    .filter(([, value]) => value === 0)
    .map(([index]) => index)
    .sort((first, second) => componentOrder.get(first) - componentOrder.get(second));
  const levels = new Map(components.map((_component, index) => [index, 0]));
  while (queue.length > 0) {
    const current = queue.shift();
    const targets = [...componentEdges.get(current)].sort(
      (first, second) => componentOrder.get(first) - componentOrder.get(second),
    );
    for (const target of targets) {
      levels.set(target, Math.max(levels.get(target), levels.get(current) + 1));
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        queue.push(target);
        queue.sort((first, second) => componentOrder.get(first) - componentOrder.get(second));
      }
    }
  }

  const nodeById = new Map(validNodes.map((node) => [node.id, node]));
  const componentPredecessors = new Map(components.map((_component, index) => [index, []]));
  for (const [source, targets] of componentEdges) {
    for (const target of targets) componentPredecessors.get(target).push(source);
  }
  const componentLayerMap = new Map();
  components.forEach((_component, componentIndex) => {
    const layer = componentLayerMap.get(levels.get(componentIndex)) ?? [];
    layer.push(componentIndex);
    componentLayerMap.set(levels.get(componentIndex), layer);
  });
  const componentRanks = new Map();
  const layers = [...componentLayerMap.entries()]
    .sort(([first], [second]) => first - second)
    .map(([, componentIndexes]) => {
      componentIndexes.sort((first, second) => {
        const barycenter = (componentIndex) => {
          const ranks = componentPredecessors.get(componentIndex)
            .map((predecessor) => componentRanks.get(predecessor))
            .filter(Number.isFinite);
          return ranks.length > 0
            ? ranks.reduce((total, rank) => total + rank, 0) / ranks.length
            : Number.POSITIVE_INFINITY;
        };
        return (
          barycenter(first) - barycenter(second) ||
          componentOrder.get(first) - componentOrder.get(second)
        );
      });
      componentIndexes.forEach((componentIndex, index) => componentRanks.set(componentIndex, index));
      return componentIndexes.flatMap((componentIndex) =>
        components[componentIndex].map((id) => nodeById.get(id)),
      );
    });
  const positions = new Map();

  if (readingOrder === "center-out") {
    // Collapse cycles before finding the visual center. This keeps every SCC in
    // one radial layer and avoids making the first node in a cycle look like its
    // upstream cause.
    const adjacency = new Map(components.map((_component, index) => [index, new Set()]));
    for (const [source, targets] of componentEdges) {
      for (const target of targets) {
        adjacency.get(source).add(target);
        adjacency.get(target).add(source);
      }
    }

    function distancesFrom(start) {
      const distances = new Map([[start, 0]]);
      const pending = [start];
      while (pending.length > 0) {
        const current = pending.shift();
        const neighbors = [...adjacency.get(current)].sort(
          (first, second) => componentOrder.get(first) - componentOrder.get(second),
        );
        for (const neighbor of neighbors) {
          if (distances.has(neighbor)) continue;
          distances.set(neighbor, distances.get(current) + 1);
          pending.push(neighbor);
        }
      }
      return distances;
    }

    // Prefer the graph-theoretic center of the largest connected component.
    // Every tie-break ultimately falls back to source order, so identical input
    // always produces identical coordinates.
    let centerComponent = 0;
    let centerScore = null;
    for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
      const distances = distancesFrom(componentIndex);
      const values = [...distances.values()];
      const score = {
        reachable: values.length,
        eccentricity: Math.max(...values),
        totalDistance: values.reduce((total, value) => total + value, 0),
        degree: adjacency.get(componentIndex).size,
        order: componentOrder.get(componentIndex),
      };
      const isBetter =
        centerScore === null ||
        score.reachable > centerScore.reachable ||
        (score.reachable === centerScore.reachable && score.eccentricity < centerScore.eccentricity) ||
        (score.reachable === centerScore.reachable &&
          score.eccentricity === centerScore.eccentricity &&
          score.totalDistance < centerScore.totalDistance) ||
        (score.reachable === centerScore.reachable &&
          score.eccentricity === centerScore.eccentricity &&
          score.totalDistance === centerScore.totalDistance &&
          score.degree > centerScore.degree) ||
        (score.reachable === centerScore.reachable &&
          score.eccentricity === centerScore.eccentricity &&
          score.totalDistance === centerScore.totalDistance &&
          score.degree === centerScore.degree &&
          score.order < centerScore.order);
      if (isBetter) {
        centerComponent = componentIndex;
        centerScore = score;
      }
    }

    const centerDistances = distancesFrom(centerComponent);
    const outerRing = Math.max(...centerDistances.values()) + 1;
    const rings = new Map();
    components.forEach((_component, componentIndex) => {
      const ringIndex = centerDistances.get(componentIndex) ?? outerRing;
      const ring = rings.get(ringIndex) ?? [];
      ring.push(componentIndex);
      rings.set(ringIndex, ring);
    });
    for (const ring of rings.values()) {
      ring.sort((first, second) => componentOrder.get(first) - componentOrder.get(second));
    }

    const componentGroups = new Map(
      components.map((component, componentIndex) => {
        const groupNodes = component.map((id) => nodeById.get(id));
        const width = Math.max(...groupNodes.map((node) => node.w));
        const height =
          groupNodes.reduce((total, node) => total + node.h, 0) +
          horizontalGap * Math.max(0, groupNodes.length - 1);
        return [
          componentIndex,
          {
            nodes: groupNodes,
            width,
            height,
            halfDiagonal: Math.hypot(width, height) / 2,
          },
        ];
      }),
    );

    function placeGroup(componentIndex, centerX, centerY) {
      const group = componentGroups.get(componentIndex);
      let y = centerY - group.height / 2;
      for (const node of group.nodes) {
        positions.set(node.id, {
          x: centerX - node.w / 2,
          y,
        });
        y += node.h + horizontalGap;
      }
    }

    placeGroup(centerComponent, 0, 0);
    let previousOuterRadius = componentGroups.get(centerComponent).halfDiagonal;
    const radialGap = Math.max(horizontalGap, verticalGap);
    const orderedRings = [...rings.keys()].filter((ringIndex) => ringIndex > 0).sort((a, b) => a - b);
    for (const ringIndex of orderedRings) {
      const ring = rings.get(ringIndex);
      const maxHalfDiagonal = Math.max(
        ...ring.map((componentIndex) => componentGroups.get(componentIndex).halfDiagonal),
      );
      const minimumRadialRadius = previousOuterRadius + maxHalfDiagonal + radialGap;
      const minimumAngularRadius =
        ring.length > 1
          ? (2 * maxHalfDiagonal + horizontalGap) / (2 * Math.sin(Math.PI / ring.length))
          : 0;
      const radius = Math.max(minimumRadialRadius, minimumAngularRadius);
      ring.forEach((componentIndex, index) => {
        const angle = (2 * Math.PI * index) / ring.length;
        placeGroup(componentIndex, radius * Math.cos(angle), radius * Math.sin(angle));
      });
      previousOuterRadius = radius + maxHalfDiagonal;
    }

    let minimumX = Infinity;
    let minimumY = Infinity;
    for (const node of validNodes) {
      const position = positions.get(node.id);
      minimumX = Math.min(minimumX, position.x);
      minimumY = Math.min(minimumY, position.y);
    }
    const offsetX = originX - minimumX;
    const offsetY = originY - minimumY;
    for (const position of positions.values()) {
      position.x = Math.round((position.x + offsetX) * 1_000_000) / 1_000_000;
      position.y = Math.round((position.y + offsetY) * 1_000_000) / 1_000_000;
    }
    return positions;
  }

  const horizontal = ["left-to-right", "right-to-left", "board-to-peers"].includes(readingOrder);

  if (horizontal) {
    const layerWidths = layers.map((layer) => Math.max(...layer.map((node) => node.w)));
    const layerHeights = layers.map((layer) =>
      layer.reduce((total, node) => total + node.h, 0) + horizontalGap * Math.max(0, layer.length - 1),
    );
    const graphHeight = Math.max(...layerHeights);
    let x = originX;
    layers.forEach((layer, layerIndex) => {
      let y = originY + (graphHeight - layerHeights[layerIndex]) / 2;
      for (const node of layer) {
        positions.set(node.id, { x: x + (layerWidths[layerIndex] - node.w) / 2, y });
        y += node.h + horizontalGap;
      }
      x += layerWidths[layerIndex] + verticalGap;
    });
    if (readingOrder === "right-to-left") {
      const graphWidth = x - originX - verticalGap;
      for (const node of validNodes) {
        const position = positions.get(node.id);
        position.x = originX + graphWidth - (position.x - originX) - node.w;
      }
    }
  } else {
    const layerWidths = layers.map((layer) =>
      layer.reduce((total, node) => total + node.w, 0) + horizontalGap * Math.max(0, layer.length - 1),
    );
    const layerHeights = layers.map((layer) => Math.max(...layer.map((node) => node.h)));
    const graphWidth = Math.max(...layerWidths);
    let y = originY;
    layers.forEach((layer, layerIndex) => {
      let x = originX + (graphWidth - layerWidths[layerIndex]) / 2;
      for (const node of layer) {
        positions.set(node.id, { x, y: y + (layerHeights[layerIndex] - node.h) / 2 });
        x += node.w + horizontalGap;
      }
      y += layerHeights[layerIndex] + verticalGap;
    });
    if (readingOrder === "bottom-to-top") {
      const graphHeight = y - originY - verticalGap;
      for (const node of validNodes) {
        const position = positions.get(node.id);
        position.y = originY + graphHeight - (position.y - originY) - node.h;
      }
    }
  }

  return positions;
}

export function estimateThinkingRelationGap(label = "") {
  return clamp(88 + textUnits(label) * 18, 128, 360);
}
