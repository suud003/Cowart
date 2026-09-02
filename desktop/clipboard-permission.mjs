const CLIPBOARD_WRITE_PERMISSION = 'clipboard-sanitized-write'

function comparableDocumentUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

export function isTrustedClipboardPermissionRequest({
  webContents,
  permission,
  details,
  getTrustedWebContents
}) {
  if (permission !== CLIPBOARD_WRITE_PERMISSION) return false
  if (!webContents || webContents.isDestroyed?.()) return false
  if (details?.isMainFrame !== true) return false

  const trustedWebContents = getTrustedWebContents?.()
  if (!trustedWebContents || trustedWebContents.isDestroyed?.()) return false
  if (webContents !== trustedWebContents) return false

  const requestingUrl = comparableDocumentUrl(details?.requestingUrl)
  const trustedUrl = comparableDocumentUrl(trustedWebContents.getURL?.())
  return Boolean(requestingUrl && trustedUrl && requestingUrl === trustedUrl)
}

export function installTrustedClipboardPermissionPolicy({
  electronSession,
  getTrustedWebContents
}) {
  if (
    !electronSession ||
    typeof electronSession.setPermissionCheckHandler !== 'function' ||
    typeof electronSession.setPermissionRequestHandler !== 'function'
  ) {
    throw new TypeError('A complete Electron session permission API is required.')
  }
  if (typeof getTrustedWebContents !== 'function') {
    throw new TypeError('getTrustedWebContents must be a function.')
  }

  const isAllowed = (webContents, permission, details) =>
    isTrustedClipboardPermissionRequest({
      webContents,
      permission,
      details,
      getTrustedWebContents
    })

  electronSession.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    isAllowed(webContents, permission, details)
  )
  electronSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isAllowed(webContents, permission, details))
  })

  return () => {
    electronSession.setPermissionCheckHandler(null)
    electronSession.setPermissionRequestHandler(null)
  }
}
