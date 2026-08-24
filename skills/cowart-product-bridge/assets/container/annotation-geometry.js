function positive(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function createAnnotationCoordinateMapper({
  frameRect,
  frameOffsetWidth,
  frameOffsetHeight,
  frameClientLeft = 0,
  frameClientTop = 0,
  layerRect,
  layerOffsetWidth,
  layerOffsetHeight,
  layerClientLeft = 0,
  layerClientTop = 0,
} = {}) {
  if (!frameRect || !layerRect) throw new Error("frameRect and layerRect are required.");
  const frameScaleX = positive(frameRect.width) / positive(frameOffsetWidth);
  const frameScaleY = positive(frameRect.height) / positive(frameOffsetHeight);
  const layerScaleX = positive(layerRect.width) / positive(layerOffsetWidth);
  const layerScaleY = positive(layerRect.height) / positive(layerOffsetHeight);
  const frameOrigin = {
    x: finite(frameRect.left) + finite(frameClientLeft) * frameScaleX,
    y: finite(frameRect.top) + finite(frameClientTop) * frameScaleY,
  };
  const layerOrigin = {
    x: finite(layerRect.left) + finite(layerClientLeft) * layerScaleX,
    y: finite(layerRect.top) + finite(layerClientTop) * layerScaleY,
  };

  function frameToScreen(point) {
    return {
      x: frameOrigin.x + finite(point?.x) * frameScaleX,
      y: frameOrigin.y + finite(point?.y) * frameScaleY,
    };
  }

  function screenToFrame(point) {
    return {
      x: (finite(point?.x) - frameOrigin.x) / frameScaleX,
      y: (finite(point?.y) - frameOrigin.y) / frameScaleY,
    };
  }

  function screenToLayer(point) {
    return {
      x: (finite(point?.x) - layerOrigin.x) / layerScaleX,
      y: (finite(point?.y) - layerOrigin.y) / layerScaleY,
    };
  }

  function frameToLayer(point) {
    return screenToLayer(frameToScreen(point));
  }

  function frameRectToLayer(rect) {
    const topLeft = frameToLayer({ x: rect?.left, y: rect?.top });
    const bottomRight = frameToLayer({
      x: finite(rect?.left) + finite(rect?.width),
      y: finite(rect?.top) + finite(rect?.height),
    });
    return {
      left: topLeft.x,
      top: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  return { frameToLayer, frameRectToLayer, frameToScreen, screenToFrame, screenToLayer };
}
