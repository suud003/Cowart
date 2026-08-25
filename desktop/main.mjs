import { app, BrowserWindow, ipcMain, session } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { YogurtAgentService } from './agent-service.mjs'
import { CodexAppServerClient } from './codex-app-server-client.mjs'
import { registerYogurtAgentIpc } from './ipc-bridge.mjs'

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
const codexClient = new CodexAppServerClient({
  command: process.env.YOGURT_CODEX_COMMAND || 'codex',
  cwd: projectDir,
  clientInfo: {
    name: 'yogurt_ai_desktop',
    title: 'Yogurt AI Desktop',
    version: process.env.YOGURT_DESKTOP_VERSION || '0.1.0'
  },
  experimentalApi: false
})
const agentService = new YogurtAgentService({ client: codexClient, projectDir, canvasDir })

let mainWindow = null
let unregisterIpc = null
let quitAfterCleanup = false

function trustedWebContents() {
  return mainWindow?.webContents ?? null
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
  mainWindow = new BrowserWindow({
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
  lockNavigation(mainWindow, devUrl)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (!unregisterIpc) {
    unregisterIpc = registerYogurtAgentIpc({
      ipcMain,
      agentService,
      getTrustedWebContents: trustedWebContents
    })
  }

  if (devUrl) await mainWindow.loadURL(devUrl)
  else await mainWindow.loadFile(distIndexPath)
}

await app.whenReady()
session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
await createMainWindow()
agentService.start().catch((error) => {
  console.error('Yogurt AI Codex sidecar failed to start:', error)
})

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
