import { app, BrowserWindow, ipcMain, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { YogurtAgentService } from './agent-service.mjs'
import { CodexAppServerClient } from './codex-app-server-client.mjs'
import { registerYogurtAgentIpc } from './ipc-bridge.mjs'
import { createYogurtCodexArgs, resolveCodexLaunch } from './runtime-config.mjs'

const desktopDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(desktopDir, '..')
const preloadPath = path.join(desktopDir, 'preload.cjs')
const distIndexPath = path.join(repoRoot, 'dist', 'index.html')

function rendererDevUrl(value) {
  if (!value) return null
  const url = new URL(value)
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
    throw new Error('YOGURT_VITE_DEV_URL must use HTTP on a loopback host.')
  }
  return url.toString()
}

const projectDir = path.resolve(process.env.YOGURT_WORKSPACE_ROOT || process.cwd())
const canvasDir = path.join(projectDir, 'canvas')
const sessionFile = path.join(canvasDir, '.yogurt-agent-session.json')

function readPersistedThreadId() {
  try {
    const state = JSON.parse(readFileSync(sessionFile, 'utf8'))
    return typeof state?.threadId === 'string' && state.threadId.trim()
      ? state.threadId.trim()
      : null
  } catch (_error) {
    return null
  }
}

async function persistThreadId(threadId) {
  await mkdir(canvasDir, { recursive: true })
  const temporaryFile = `${sessionFile}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify({ version: 1, threadId }, null, 2)}\n`)
  await rename(temporaryFile, sessionFile)
}

const cowartMcpCommand = process.env.YOGURT_NODE_COMMAND || 'node'
const codexArgs = createYogurtCodexArgs({ repoRoot, nodeCommand: cowartMcpCommand })
const codexLaunch = resolveCodexLaunch()
const codexClient = new CodexAppServerClient({
  command: codexLaunch.command,
  commandPrefixArgs: codexLaunch.commandPrefixArgs,
  args: codexArgs,
  cwd: projectDir,
  clientInfo: {
    name: 'yogurt_ai_desktop',
    title: 'Yogurt AI Desktop',
    version: process.env.YOGURT_DESKTOP_VERSION || '0.1.0'
  },
  experimentalApi: false
})
const agentService = new YogurtAgentService({
  client: codexClient,
  projectDir,
  canvasDir,
  initialThreadId: readPersistedThreadId(),
  onThreadChanged: persistThreadId
})

let mainWindow = null
let provisionalWebContents = null
let unregisterIpc = null
let quitAfterCleanup = false

function trustedWebContents() {
  return mainWindow?.webContents ?? provisionalWebContents
}

function claimBootstrapWebContents(sender) {
  if (!sender || sender.isDestroyed?.()) return false
  if (provisionalWebContents) return provisionalWebContents === sender
  const ownerWindow = BrowserWindow.fromWebContents(sender)
  const applicationWindows = BrowserWindow.getAllWindows()
  if (!ownerWindow || applicationWindows.length !== 1 || applicationWindows[0] !== ownerWindow) {
    return false
  }
  provisionalWebContents = sender
  return true
}

function ensureIpcRegistered() {
  if (unregisterIpc) return
  unregisterIpc = registerYogurtAgentIpc({
    ipcMain,
    agentService,
    getTrustedWebContents: trustedWebContents,
    claimBootstrapWebContents
  })
}

function lockNavigation(window, allowedUrl) {
  const allowedFileUrl = pathToFileURL(distIndexPath).toString()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const allowed = allowedUrl
      ? targetUrl.startsWith(allowedUrl)
      : targetUrl === allowedFileUrl
    if (!allowed) event.preventDefault()
  })
}

async function createMainWindow() {
  const devUrl = rendererDevUrl(process.env.YOGURT_VITE_DEV_URL)
  ensureIpcRegistered()
  let createdWindow
  try {
    createdWindow = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1024,
      minHeight: 720,
      show: false,
      backgroundColor: '#f7f7f5',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
  } catch (error) {
    provisionalWebContents = null
    throw error
  }
  if (provisionalWebContents && provisionalWebContents !== createdWindow.webContents) {
    provisionalWebContents = null
    createdWindow.destroy()
    throw new Error('Yogurt AI rejected an unexpected renderer during bootstrap.')
  }
  mainWindow = createdWindow
  provisionalWebContents = null
  lockNavigation(mainWindow, devUrl)
  if (process.env.YOGURT_DESKTOP_DEBUG === '1') {
    mainWindow.webContents.on('console-message', (_event, detailsOrLevel, legacyMessage) => {
      const message = typeof detailsOrLevel === 'object'
        ? detailsOrLevel?.message
        : legacyMessage
      if (message) console.error(`[renderer] ${message}`)
    })
    mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`[renderer] load failed ${code}: ${description} (${url})`)
    })
  }
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (devUrl) await mainWindow.loadURL(devUrl)
  else await mainWindow.loadFile(distIndexPath)
}

async function captureDesktopIfRequested() {
  const requestedPath = String(process.env.YOGURT_DESKTOP_CAPTURE_PATH || '').trim()
  if (!requestedPath || !mainWindow) return false

  const capturePath = path.resolve(requestedPath)
  const requestedDelay = Number(process.env.YOGURT_DESKTOP_CAPTURE_DELAY_MS)
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.min(Math.max(requestedDelay, 250), 15_000)
    : 2_500
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  const image = await mainWindow.webContents.capturePage()
  await mkdir(path.dirname(capturePath), { recursive: true })
  await writeFile(capturePath, image.toPNG())
  console.log(`Captured Yogurt AI Desktop at ${capturePath}`)
  app.quit()
  return true
}

await app.whenReady()
session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
agentService.start().catch((error) => {
  console.error('Yogurt AI Codex sidecar failed to start:', error)
})
await createMainWindow()
await captureDesktopIfRequested()

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow().catch((error) => console.error('Could not recreate Yogurt AI window:', error))
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitAfterCleanup) return
  event.preventDefault()
  quitAfterCleanup = true
  unregisterIpc?.()
  agentService.dispose()
    .catch((error) => console.error('Could not stop Yogurt AI Codex sidecar cleanly:', error))
    .finally(() => app.quit())
})
