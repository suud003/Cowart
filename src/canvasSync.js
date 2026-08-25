export const REMOTE_CANVAS_REFRESH_ACTION = Object.freeze({
  APPLY: 'apply',
  IGNORE: 'ignore',
  CONFLICT: 'conflict'
})

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
