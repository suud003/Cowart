export const REMOTE_CANVAS_REFRESH_ACTION = Object.freeze({
  APPLY: 'apply',
  IGNORE: 'ignore',
  CONFLICT: 'conflict'
})

export function collectNewSemanticDiagramRootIds({
  localStore = {},
  remoteStore = {},
  pageId = null
} = {}) {
  return Object.values(remoteStore)
    .filter((record) => {
      if (
        record?.typeName !== 'shape' ||
        record.type !== 'frame' ||
        record.meta?.cowartSemanticZone !== true ||
        !record.meta?.cowartSemanticDiagram?.diagramId ||
        localStore?.[record.id]
      ) {
        return false
      }

      const parent = remoteStore?.[record.parentId]
      if (parent?.typeName !== 'page') return false
      return !pageId || record.parentId === pageId
    })
    .map((record) => record.id)
}

export function classifyRemoteCanvasRefresh({
  revisionBeforeFetch = null,
  currentRevision = null,
  remoteRevision = null,
  preserveLocalChanges = false
} = {}) {
  if (!preserveLocalChanges) return REMOTE_CANVAS_REFRESH_ACTION.APPLY

  // The remote response already reflects the current local base, so there is
  // nothing to merge while local document changes are pending.
  if (remoteRevision === currentRevision) return REMOTE_CANVAS_REFRESH_ACTION.IGNORE

  // A local save completed while the refresh request was in flight. Ignore a
  // response from the older base instead of mistaking it for an external edit.
  if (currentRevision !== revisionBeforeFetch && remoteRevision === revisionBeforeFetch) {
    return REMOTE_CANVAS_REFRESH_ACTION.IGNORE
  }

  return REMOTE_CANVAS_REFRESH_ACTION.CONFLICT
}

function finiteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function zoomValue(appState) {
  const value = typeof appState?.zoom === 'number'
    ? appState.zoom
    : appState?.zoom?.value
  return Math.max(0.01, finiteNumber(value, 1))
}

export function cowartExcalidrawViewState(canvasId, appState = {}, updatedAt = new Date().toISOString()) {
  return {
    version: 1,
    currentPageId: canvasId || null,
    camera: {
      x: finiteNumber(appState.scrollX),
      y: finiteNumber(appState.scrollY),
      z: zoomValue(appState)
    },
    updatedAt
  }
}

export function cowartViewStateSignature(viewState) {
  const camera = viewState?.camera
  if (
    viewState?.version !== 1 ||
    !camera ||
    !Number.isFinite(camera.x) ||
    !Number.isFinite(camera.y) ||
    !Number.isFinite(camera.z) ||
    camera.z <= 0
  ) {
    return null
  }
  return JSON.stringify([camera.x, camera.y, camera.z])
}

export function mergeCowartExcalidrawViewState(document, viewState, canvasId) {
  const signature = cowartViewStateSignature(viewState)
  const belongsToCanvas =
    viewState?.currentPageId === null ||
    viewState?.currentPageId === canvasId
  const wasPersisted = Boolean(viewState?.updatedAt || viewState?.currentPageId)
  if (!signature || !belongsToCanvas || !wasPersisted) return document

  return {
    ...document,
    appState: {
      ...(document?.appState || {}),
      scrollX: viewState.camera.x,
      scrollY: viewState.camera.y,
      zoom: {
        ...(document?.appState?.zoom && typeof document.appState.zoom === 'object'
          ? document.appState.zoom
          : {}),
        value: viewState.camera.z
      }
    }
  }
}

export function shouldIgnoreCanvasRefreshAfterFetch({
  generationBeforeFetch = 0,
  currentGeneration = 0,
  revisionBeforeFetch = null,
  currentRevision = null,
  hasPendingScene = false,
  saveInFlight = false,
  hasSaveConflict = false,
  canvasOperationChanged = false
} = {}) {
  return Boolean(
    generationBeforeFetch !== currentGeneration ||
    revisionBeforeFetch !== currentRevision ||
    hasPendingScene ||
    saveInFlight ||
    hasSaveConflict ||
    canvasOperationChanged
  )
}

export function newestCowartPendingScene(first, second) {
  if (!first) return second || null
  if (!second) return first
  return (second.generation ?? 0) >= (first.generation ?? 0) ? second : first
}

export function isExplicitEmptyCowartCanvasState(state) {
  const canvasId = state?.canvasId
  const canvases = state?.project?.canvases
  return Boolean(
    state &&
    state.snapshot === null &&
    state.storage === 'empty' &&
    typeof state.revision === 'string' &&
    state.revision.length > 0 &&
    canvasId === 'canvas_main' &&
    state.canvas?.id === canvasId &&
    state.canvas?.createdAt === null &&
    state.project?.type === 'yogurt-canvas-project' &&
    state.project?.version === 1 &&
    state.project?.createdAt === null &&
    state.project?.activeCanvasId === canvasId &&
    Array.isArray(canvases) &&
    canvases.length === 1 &&
    canvases[0]?.id === canvasId
  )
}
