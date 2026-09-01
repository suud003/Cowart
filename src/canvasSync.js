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
