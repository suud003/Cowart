import { app, BrowserWindow, clipboard, ClipboardItem as ElectronClipboardItem, session } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { installTrustedClipboardPermissionPolicy } from '../desktop/clipboard-permission.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.join(scriptDir, 'fixtures', 'clipboard-probe.html')
const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const execFileAsync = promisify(execFile)

let probeWindow = null
let previousClipboardItems = []
let disposePermissionPolicy = null
let stage = 'start'
let failure = null
let clipboardSnapshotCaptured = false
const clipboardGateEvents = []

function within(milliseconds, promise, fallback) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

async function cloneClipboardItems(items) {
  const clones = []
  for (const item of items) {
    const payloads = {}
    for (const type of item.types) payloads[type] = await item.getType(type)
    clones.push(new ElectronClipboardItem(payloads))
  }
  return clones
}

async function readSystemClipboardImageDimensions() {
  if (process.platform !== 'win32') return null
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-STA',
      '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $image = [System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 0 }; try { Write-Output ("{0}x{1}" -f $image.Width, $image.Height) } finally { $image.Dispose() }'
    ],
    { timeout: 5_000 }
  )
  const match = String(stdout).trim().match(/^(\d+)x(\d+)$/)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

try {
  stage = 'app-ready'
  await app.whenReady()
  stage = 'read-current-clipboard'
  const currentClipboardItems = await within(1_500, clipboard.read(), null)
  if (!Array.isArray(currentClipboardItems)) {
    throw new Error('Could not snapshot the current clipboard before the destructive probe.')
  }
  stage = 'clone-current-clipboard'
  const clonedClipboardItems = await within(1_500, cloneClipboardItems(currentClipboardItems), null)
  if (!Array.isArray(clonedClipboardItems) || clonedClipboardItems.length !== currentClipboardItems.length) {
    throw new Error('Could not clone the current clipboard before the destructive probe.')
  }
  previousClipboardItems = clonedClipboardItems
  clipboardSnapshotCaptured = true
  stage = 'install-permission-policy'
  const tracedSession = {
    setPermissionCheckHandler(handler) {
      if (!handler) {
        session.defaultSession.setPermissionCheckHandler(null)
        return
      }
      session.defaultSession.setPermissionCheckHandler((...args) => {
        const allowed = handler(...args)
        if (String(args[1]).includes('clipboard')) {
          const event = {
            gate: 'check',
            permission: args[1],
            requestingUrl: args[3]?.requestingUrl,
            isMainFrame: args[3]?.isMainFrame,
            trustedUrl: probeWindow?.webContents.getURL(),
            allowed
          }
          clipboardGateEvents.push(event)
          console.error(JSON.stringify(event))
        }
        return allowed
      })
    },
    setPermissionRequestHandler(handler) {
      if (!handler) {
        session.defaultSession.setPermissionRequestHandler(null)
        return
      }
      session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        handler(webContents, permission, (allowed) => {
          if (String(permission).includes('clipboard')) {
            const event = {
              gate: 'request',
              permission,
              requestingUrl: details?.requestingUrl,
              isMainFrame: details?.isMainFrame,
              trustedUrl: probeWindow?.webContents.getURL(),
              allowed
            }
            clipboardGateEvents.push(event)
            console.error(JSON.stringify(event))
          }
          callback(allowed)
        }, details)
      })
    }
  }
  disposePermissionPolicy = installTrustedClipboardPermissionPolicy({
    electronSession: tracedSession,
    getTrustedWebContents: () => probeWindow?.webContents ?? null
  })

  probeWindow = new BrowserWindow({
    show: true,
    width: 360,
    height: 180,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  stage = 'load-fixture'
  await probeWindow.loadFile(fixturePath)
  probeWindow.focus()
  await new Promise((resolve) => setTimeout(resolve, 150))

  stage = 'renderer-write-png'
  const result = await within(8_000, probeWindow.webContents.executeJavaScript(`
    (async () => {
      try {
        const binary = atob(${JSON.stringify(onePixelPng)})
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        const blob = new Blob([bytes], { type: 'image/png' })
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ])
        return { ok: true, type: blob.type, size: blob.size }
      } catch (error) {
        return {
          ok: false,
          name: error?.name,
          message: error?.message,
          isSecureContext,
          hasClipboard: Boolean(navigator.clipboard),
          hasClipboardItem: typeof ClipboardItem === 'function',
          visibilityState: document.visibilityState,
          focused: document.hasFocus()
        }
      }
    })()
  `, true), null)

  const clipboardItems = await within(3_000, clipboard.read(), [])
  const clipboardTypes = clipboardItems.flatMap((item) => item.types)
  const systemImageDimensions = await within(6_000, readSystemClipboardImageDimensions(), null)
  const allowedWriteRequest = clipboardGateEvents.some((event) =>
    event.gate === 'request' &&
    event.permission === 'clipboard-sanitized-write' &&
    event.allowed === true
  )
  const hasExpectedSystemImage = process.platform === 'win32'
    ? systemImageDimensions?.width === 1 && systemImageDimensions?.height === 1
    : clipboardTypes.includes('image/png')
  if (result?.ok !== true || !allowedWriteRequest || !hasExpectedSystemImage) {
    throw new Error(
      `Electron did not expose the expected renderer PNG on the system clipboard: ${JSON.stringify({
        result,
        clipboardTypes,
        systemImageDimensions,
        allowedWriteRequest
      })}`
    )
  }
  console.log(JSON.stringify({
    ok: true,
    permission: 'clipboard-sanitized-write',
    mimeType: result.type,
    fileSize: result.size,
    systemImageDimensions
  }))
} catch (error) {
  const details = error?.stack || error?.message || JSON.stringify(error)
  failure = new Error(`Clipboard probe failed during ${stage}: ${details || 'unknown error'}`)
} finally {
  if (clipboardSnapshotCaptured) {
    try {
      if (previousClipboardItems.length > 0) {
        const restored = await within(
          1_500,
          clipboard.write(previousClipboardItems).then(() => true),
          false
        )
        if (!restored) throw new Error('Timed out while restoring the previous clipboard contents.')
      } else {
        clipboard.clear()
      }
    } catch (error) {
      const restoreDetails = error?.stack || error?.message || String(error)
      failure = failure
        ? new Error(`${failure.message}\nClipboard restoration also failed: ${restoreDetails}`)
        : new Error(`Clipboard restoration failed: ${restoreDetails}`)
    }
  }
  probeWindow?.destroy()
  disposePermissionPolicy?.()
}

if (failure) throw failure
app.quit()
