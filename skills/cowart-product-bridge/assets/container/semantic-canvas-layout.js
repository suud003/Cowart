export const PAGE_CARD_WIDTH = 360;
export const PAGE_CARD_HEIGHT = 260;

export const TRANSITION_TYPES = Object.freeze([
  "flow",
  "dispatch",
  "claim",
  "sync",
  "association",
  "compare",
]);
export const TRANSITION_DIRECTIONS = Object.freeze(["forward", "bidirectional", "none"]);
export const TRANSITION_PATHS = Object.freeze(["primary", "alternative"]);

const TYPE_SET = new Set(TRANSITION_TYPES);
const DIRECTION_SET = new Set(TRANSITION_DIRECTIONS);
const PATH_SET = new Set(TRANSITION_PATHS);

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizePagePosition(value = {}) {
  const position = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    x: Number.isFinite(position.x) ? position.x : 0,
    y: Number.isFinite(position.y) ? position.y : 0,
  };
}

function defaultDirection(type) {
  if (type === "sync") return "bidirectional";
  if (type === "association" || type === "compare") return "none";
  return "forward";
}

export function normalizeTransition(value = {}) {
  const transition = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const type = TYPE_SET.has(transition.type) ? transition.type : "flow";
  const direction = DIRECTION_SET.has(transition.direction)
    ? transition.direction
    : defaultDirection(type);
  const path = PATH_SET.has(transition.path) ? transition.path : "primary";
  const label = cleanText(transition.label);
  const payload = cleanText(transition.payload);
  return {
    type,
    direction,
    path,
    label,
    payload,
    displayLabel: [...new Set([label, payload].filter(Boolean))].join(" · "),
  };
}

function pageId(value) {
  return typeof value?.id === "string" && value.id.trim() ? value.id.trim() : null;
}

function pageOrder(pages) {
  return new Map(pages.map((page, index) => [page.id, index]));
}

export function collectPageTransitions(pages = []) {
  const records = Array.isArray(pages)
    ? pages.filter((page) => pageId(page)).map((page) => ({ ...page, id: pageId(page) }))
    : [];
  const knownIds = new Set(records.map(({ id }) => id));
  const transitions = [];

  for (const source of records) {
    const sourceTransitions = Array.isArray(source.transitions) ? source.transitions : [];
    sourceTransitions.forEach((rawTransition, index) => {
      const to = cleanText(rawTransition?.to);
      if (!knownIds.has(to)) return;
      transitions.push({
        id: `${source.id}:${to}:${index}`,
        from: source.id,
        to,
        sourceIndex: index,
        ...normalizeTransition(rawTransition),
      });
    });
  }

  const laneGroups = new Map();
  for (const transition of transitions) {
    const key = [transition.from, transition.to].sort().join("\u0000");
    const group = laneGroups.get(key) ?? [];
    group.push(transition);
    laneGroups.set(key, group);
  }
  for (const group of laneGroups.values()) {
    group.forEach((transition, index) => {
      transition.lane = index - (group.length - 1) / 2;
    });
  }
  return transitions;
}

function stronglyConnectedComponents(ids, adjacency, order) {
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

    for (const target of adjacency.get(id) ?? []) {
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

  for (const id of ids) {
    if (!indexes.has(id)) visit(id);
  }
  components.sort((first, second) => order.get(first[0]) - order.get(second[0]));
  return components;
}

export function layoutPages(pages = [], options = {}) {
  const records = Array.isArray(pages)
    ? pages.filter((page) => pageId(page)).map((page) => ({ ...page, id: pageId(page) }))
    : [];
  if (records.length === 0) {
    return { positions: {}, layers: [], bounds: { x: 0, y: 0, w: 0, h: 0 } };
  }

  const direction = options.direction === "top-to-bottom" ? "top-to-bottom" : "left-to-right";
  const nodeWidth = Math.max(1, Number(options.nodeWidth) || PAGE_CARD_WIDTH);
  const nodeHeight = Math.max(1, Number(options.nodeHeight) || PAGE_CARD_HEIGHT);
  const layerGap = Math.max(0, Number(options.layerGap) || 120);
  const peerGap = Math.max(0, Number(options.peerGap) || 72);
  const originX = Number.isFinite(options.originX) ? options.originX : 80;
  const originY = Number.isFinite(options.originY) ? options.originY : 80;
  const ids = records.map(({ id }) => id);
  const order = pageOrder(records);
  const adjacency = new Map(ids.map((id) => [id, []]));

  for (const transition of collectPageTransitions(records)) {
    if (transition.from === transition.to) continue;
    const targets = adjacency.get(transition.from);
    if (!targets.includes(transition.to)) targets.push(transition.to);
  }
  for (const targets of adjacency.values()) {
    targets.sort((first, second) => order.get(first) - order.get(second));
  }

  const components = stronglyConnectedComponents(ids, adjacency, order);
  const componentFor = new Map();
  components.forEach((component, index) => {
    for (const id of component) componentFor.set(id, index);
  });
  const componentEdges = new Map(components.map((_component, index) => [index, new Set()]));
  const indegree = new Map(components.map((_component, index) => [index, 0]));
  for (const [from, targets] of adjacency) {
    const sourceComponent = componentFor.get(from);
    for (const to of targets) {
      const targetComponent = componentFor.get(to);
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

  const layerMap = new Map();
  components.forEach((component, index) => {
    const level = levels.get(index);
    const layer = layerMap.get(level) ?? [];
    layer.push(...component);
    layerMap.set(level, layer);
  });
  const layers = [...layerMap.entries()]
    .sort(([first], [second]) => first - second)
    .map(([, layer]) => layer.sort((first, second) => order.get(first) - order.get(second)));
  const positions = {};

  if (direction === "left-to-right") {
    const spans = layers.map((layer) => layer.length * nodeHeight + Math.max(0, layer.length - 1) * peerGap);
    const maximumSpan = Math.max(...spans);
    layers.forEach((layer, layerIndex) => {
      const startY = originY + (maximumSpan - spans[layerIndex]) / 2;
      layer.forEach((id, peerIndex) => {
        positions[id] = {
          x: originX + layerIndex * (nodeWidth + layerGap),
          y: startY + peerIndex * (nodeHeight + peerGap),
        };
      });
    });
  } else {
    const spans = layers.map((layer) => layer.length * nodeWidth + Math.max(0, layer.length - 1) * peerGap);
    const maximumSpan = Math.max(...spans);
    layers.forEach((layer, layerIndex) => {
      const startX = originX + (maximumSpan - spans[layerIndex]) / 2;
      layer.forEach((id, peerIndex) => {
        positions[id] = {
          x: startX + peerIndex * (nodeWidth + peerGap),
          y: originY + layerIndex * (nodeHeight + layerGap),
        };
      });
    });
  }

  const right = Math.max(...Object.values(positions).map(({ x }) => x + nodeWidth));
  const bottom = Math.max(...Object.values(positions).map(({ y }) => y + nodeHeight));
  return {
    positions,
    layers,
    bounds: { x: originX, y: originY, w: right - originX, h: bottom - originY },
  };
}

function center(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function clampedLaneOffset(lane, span) {
  const edgeInset = Math.min(24, Math.max(0, span / 2));
  const limit = Math.max(0, span / 2 - edgeInset);
  return Math.max(-limit, Math.min(limit, lane * 28));
}

function connectionPorts(fromRect, toRect, lane = 0) {
  const fromCenter = center(fromRect);
  const toCenter = center(toRect);
  const deltaX = toCenter.x - fromCenter.x;
  const deltaY = toCenter.y - fromCenter.y;
  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    const forward = deltaX >= 0;
    const startOffset = clampedLaneOffset(lane, fromRect.h);
    const endOffset = clampedLaneOffset(lane, toRect.h);
    return {
      axis: "horizontal",
      start: {
        x: forward ? fromRect.x + fromRect.w : fromRect.x,
        y: fromCenter.y + startOffset,
        outward: forward ? 1 : -1,
      },
      end: {
        x: forward ? toRect.x : toRect.x + toRect.w,
        y: toCenter.y + endOffset,
        outward: forward ? -1 : 1,
      },
    };
  }
  const forward = deltaY >= 0;
  const startOffset = clampedLaneOffset(lane, fromRect.w);
  const endOffset = clampedLaneOffset(lane, toRect.w);
  return {
    axis: "vertical",
    start: {
      x: fromCenter.x + startOffset,
      y: forward ? fromRect.y + fromRect.h : fromRect.y,
      outward: forward ? 1 : -1,
    },
    end: {
      x: toCenter.x + endOffset,
      y: forward ? toRect.y : toRect.y + toRect.h,
      outward: forward ? -1 : 1,
    },
  };
}

function cubicPoint(start, firstControl, secondControl, end, t) {
  const inverse = 1 - t;
  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse ** 2 * t * firstControl.x +
      3 * inverse * t ** 2 * secondControl.x +
      t ** 3 * end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse ** 2 * t * firstControl.y +
      3 * inverse * t ** 2 * secondControl.y +
      t ** 3 * end.y,
  };
}

function normalizedRect(rect) {
  const x = Number(rect?.x);
  const y = Number(rect?.y);
  const w = Number(rect?.w);
  const h = Number(rect?.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function expandRect(rect, amount) {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    w: rect.w + amount * 2,
    h: rect.h + amount * 2,
  };
}

function pointInsideRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h;
}

function orientation(first, second, third) {
  return (second.x - first.x) * (third.y - first.y) -
    (second.y - first.y) * (third.x - first.x);
}

function between(value, first, second) {
  return value >= Math.min(first, second) - 1e-7 && value <= Math.max(first, second) + 1e-7;
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstA = orientation(firstStart, firstEnd, secondStart);
  const firstB = orientation(firstStart, firstEnd, secondEnd);
  const secondA = orientation(secondStart, secondEnd, firstStart);
  const secondB = orientation(secondStart, secondEnd, firstEnd);
  if (((firstA > 0 && firstB < 0) || (firstA < 0 && firstB > 0)) &&
      ((secondA > 0 && secondB < 0) || (secondA < 0 && secondB > 0))) return true;
  if (Math.abs(firstA) < 1e-7 && between(secondStart.x, firstStart.x, firstEnd.x) && between(secondStart.y, firstStart.y, firstEnd.y)) return true;
  if (Math.abs(firstB) < 1e-7 && between(secondEnd.x, firstStart.x, firstEnd.x) && between(secondEnd.y, firstStart.y, firstEnd.y)) return true;
  if (Math.abs(secondA) < 1e-7 && between(firstStart.x, secondStart.x, secondEnd.x) && between(firstStart.y, secondStart.y, secondEnd.y)) return true;
  if (Math.abs(secondB) < 1e-7 && between(firstEnd.x, secondStart.x, secondEnd.x) && between(firstEnd.y, secondStart.y, secondEnd.y)) return true;
  return false;
}

function segmentIntersectsRect(start, end, rect) {
  if (pointInsideRect(start, rect) || pointInsideRect(end, rect)) return true;
  const topLeft = { x: rect.x, y: rect.y };
  const topRight = { x: rect.x + rect.w, y: rect.y };
  const bottomRight = { x: rect.x + rect.w, y: rect.y + rect.h };
  const bottomLeft = { x: rect.x, y: rect.y + rect.h };
  return segmentsIntersect(start, end, topLeft, topRight) ||
    segmentsIntersect(start, end, topRight, bottomRight) ||
    segmentsIntersect(start, end, bottomRight, bottomLeft) ||
    segmentsIntersect(start, end, bottomLeft, topLeft);
}

function cubicIntersectsObstacles(start, firstControl, secondControl, end, obstacles) {
  let previous = start;
  for (let index = 1; index <= 32; index += 1) {
    const point = cubicPoint(start, firstControl, secondControl, end, index / 32);
    if (obstacles.some((rect) => segmentIntersectsRect(previous, point, expandRect(rect, 14)))) return true;
    previous = point;
  }
  return false;
}

function compactPoints(points) {
  return points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}

function orthogonalDetour(ports, fromRect, toRect, obstacles, lane) {
  const stubDistance = 38;
  const clearance = 48 + Math.abs(lane) * 22;
  const startStub = ports.axis === "horizontal"
    ? { x: ports.start.x + ports.start.outward * stubDistance, y: ports.start.y }
    : { x: ports.start.x, y: ports.start.y + ports.start.outward * stubDistance };
  const endStub = ports.axis === "horizontal"
    ? { x: ports.end.x + ports.end.outward * stubDistance, y: ports.end.y }
    : { x: ports.end.x, y: ports.end.y + ports.end.outward * stubDistance };

  if (ports.axis === "horizontal") {
    const minimumX = Math.min(startStub.x, endStub.x);
    const maximumX = Math.max(startStub.x, endStub.x);
    const relevant = obstacles.filter((rect) => rect.x <= maximumX && rect.x + rect.w >= minimumX);
    const top = Math.min(fromRect.y, toRect.y, ...relevant.map((rect) => rect.y)) - clearance;
    const bottom = Math.max(
      fromRect.y + fromRect.h,
      toRect.y + toRect.h,
      ...relevant.map((rect) => rect.y + rect.h),
    ) + clearance;
    const channelY = lane < 0
      ? top
      : lane > 0
        ? bottom
        : Math.abs(ports.start.y - top) + Math.abs(ports.end.y - top) <=
            Math.abs(ports.start.y - bottom) + Math.abs(ports.end.y - bottom)
          ? top
          : bottom;
    const points = compactPoints([
      { x: ports.start.x, y: ports.start.y },
      startStub,
      { x: startStub.x, y: channelY },
      { x: endStub.x, y: channelY },
      endStub,
      { x: ports.end.x, y: ports.end.y },
    ]);
    return {
      points,
      labelPoint: { x: (startStub.x + endStub.x) / 2, y: channelY - 12 },
    };
  }

  const minimumY = Math.min(startStub.y, endStub.y);
  const maximumY = Math.max(startStub.y, endStub.y);
  const relevant = obstacles.filter((rect) => rect.y <= maximumY && rect.y + rect.h >= minimumY);
  const left = Math.min(fromRect.x, toRect.x, ...relevant.map((rect) => rect.x)) - clearance;
  const right = Math.max(
    fromRect.x + fromRect.w,
    toRect.x + toRect.w,
    ...relevant.map((rect) => rect.x + rect.w),
  ) + clearance;
  const channelX = lane < 0
    ? left
    : lane > 0
      ? right
      : Math.abs(ports.start.x - left) + Math.abs(ports.end.x - left) <=
          Math.abs(ports.start.x - right) + Math.abs(ports.end.x - right)
        ? left
        : right;
  const points = compactPoints([
    { x: ports.start.x, y: ports.start.y },
    startStub,
    { x: channelX, y: startStub.y },
    { x: channelX, y: endStub.y },
    endStub,
    { x: ports.end.x, y: ports.end.y },
  ]);
  return {
    points,
    labelPoint: { x: channelX, y: (startStub.y + endStub.y) / 2 - 10 },
  };
}

function selfLoopRoute(rect, relation, lane) {
  const centerY = rect.y + rect.h / 2;
  const portSpread = Math.min(rect.h / 2 - 20, 30 + Math.abs(lane) * 7);
  const laneShift = clampedLaneOffset(lane, rect.h) * 0.45;
  const start = { x: rect.x + rect.w, y: centerY - portSpread + laneShift };
  const end = { x: rect.x + rect.w, y: centerY + portSpread + laneShift };
  const clearance = 76 + Math.abs(lane) * 32 + (lane > 0 ? 18 : 0);
  const firstControl = { x: start.x + clearance, y: start.y };
  const secondControl = { x: end.x + clearance, y: end.y };
  return {
    ...relation,
    routeKind: "self-loop",
    axis: "horizontal",
    start,
    end,
    firstControl,
    secondControl,
    labelPoint: { x: start.x + clearance * 0.78 + 12, y: centerY + laneShift - 8 },
    markerStart: relation.direction === "bidirectional",
    markerEnd: relation.direction !== "none",
    d: `M ${start.x} ${start.y} C ${firstControl.x} ${firstControl.y}, ${secondControl.x} ${secondControl.y}, ${end.x} ${end.y}`,
  };
}

export function routeTransition(fromRectValue, toRectValue, transition = {}, options = {}) {
  const fromRect = normalizedRect(fromRectValue);
  const toRect = normalizedRect(toRectValue);
  if (!fromRect || !toRect) throw new Error("fromRect and toRect must contain finite x/y and positive w/h geometry.");
  const relation = { ...normalizeTransition(transition), ...transition };
  relation.type = TYPE_SET.has(relation.type) ? relation.type : "flow";
  relation.direction = DIRECTION_SET.has(relation.direction)
    ? relation.direction
    : defaultDirection(relation.type);
  relation.path = PATH_SET.has(relation.path) ? relation.path : "primary";
  relation.displayLabel = [...new Set([cleanText(relation.label), cleanText(relation.payload)].filter(Boolean))]
    .join(" · ");
  const lane = Number.isFinite(relation.lane) ? relation.lane : 0;
  const selfLoop = options.selfLoop === true || (
    options.selfLoop !== false && fromRect.x === toRect.x && fromRect.y === toRect.y &&
    fromRect.w === toRect.w && fromRect.h === toRect.h
  );
  if (selfLoop) return selfLoopRoute(fromRect, relation, lane);
  const ports = connectionPorts(fromRect, toRect, lane);
  const distance = ports.axis === "horizontal"
    ? Math.abs(ports.end.x - ports.start.x)
    : Math.abs(ports.end.y - ports.start.y);
  const controlDistance = Math.max(56, Math.min(220, distance * 0.42));
  let firstControl;
  let secondControl;

  if (ports.axis === "horizontal") {
    firstControl = {
      x: ports.start.x + ports.start.outward * controlDistance,
      y: ports.start.y,
    };
    secondControl = {
      x: ports.end.x + ports.end.outward * controlDistance,
      y: ports.end.y,
    };
  } else {
    firstControl = {
      x: ports.start.x,
      y: ports.start.y + ports.start.outward * controlDistance,
    };
    secondControl = {
      x: ports.end.x,
      y: ports.end.y + ports.end.outward * controlDistance,
    };
  }

  const obstacles = Array.isArray(options.obstacles)
    ? options.obstacles.map(normalizedRect).filter(Boolean)
    : [];
  if (obstacles.length > 0 && cubicIntersectsObstacles(
    ports.start,
    firstControl,
    secondControl,
    ports.end,
    obstacles,
  )) {
    const detour = orthogonalDetour(ports, fromRect, toRect, obstacles, lane);
    return {
      ...relation,
      routeKind: "detour",
      axis: ports.axis,
      start: { x: ports.start.x, y: ports.start.y },
      end: { x: ports.end.x, y: ports.end.y },
      firstControl: detour.points[1],
      secondControl: detour.points[detour.points.length - 2],
      points: detour.points,
      labelPoint: detour.labelPoint,
      markerStart: relation.direction === "bidirectional",
      markerEnd: relation.direction !== "none",
      d: detour.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" "),
    };
  }

  const labelPoint = cubicPoint(ports.start, firstControl, secondControl, ports.end, 0.5);
  return {
    ...relation,
    routeKind: "direct",
    axis: ports.axis,
    start: { x: ports.start.x, y: ports.start.y },
    end: { x: ports.end.x, y: ports.end.y },
    firstControl,
    secondControl,
    labelPoint: {
      x: labelPoint.x,
      y: labelPoint.y - (ports.axis === "horizontal" ? 12 : 8),
    },
    markerStart: relation.direction === "bidirectional",
    markerEnd: relation.direction !== "none",
    d: [
      `M ${ports.start.x} ${ports.start.y}`,
      `C ${firstControl.x} ${firstControl.y}, ${secondControl.x} ${secondControl.y}, ${ports.end.x} ${ports.end.y}`,
    ].join(" "),
  };
}
