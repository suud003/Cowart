import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { YogurtAgentService } from './agent-service.mjs'
import { createAgentAttentionController } from './agent-attention.mjs'
import { persistThreadId, readPersistedThreadId } from './agent-session.mjs'
import { installTrustedClipboardPermissionPolicy } from './clipboard-permission.mjs'
import { CodexAppServerClient } from './codex-app-server-client.mjs'
import { installYogurtApplicationMenu } from './ai-mode-menu.mjs'
import { registerYogurtAgentIpc, YogurtDesktopRuntime } from './ipc-bridge.mjs'
import {
  createYogurtCodexArgs,
  resolveCodexLaunch,
  resolveConfiguredWorkspace,
  resolveDesktopRuntimeRoot
} from './runtime-config.mjs'

const desktopDir = path.dirname(fileURLToPath(import.meta.url))
const applicationRoot = path.resolve(desktopDir, '..')
const preloadPath = path.join(desktopDir, 'preload.cjs')
const desktopSettingsFileName = 'yogurt-desktop-settings.json'

if (process.platform === 'win32') app.setAppUserModelId('com.yogurtai.desktop')

function rendererDevUrl(value) {
  if (!value) return null
  const url = new URL(value)
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
    throw new Error('YOGURT_VITE_DEV_URL must use HTTP on a loopback host.')
  }
  return url.toString()
}

let mainWindow = null
let provisionalWebContents = null
let unregisterIpc = null
let quitAfterCleanup = false
let relaunchScheduled = false
let desktopRuntime = null
let distIndexPath = null
let settingsFile = null
let agentAttention = null

async function readDesktopSettings(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    console.warn('Yogurt AI ignored invalid desktop settings:', error)
    return {}
  }
}

async function writeDesktopSettings(filePath, settings) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryFile, `${JSON.stringify(settings, null, 2)}\n`)
  await rename(temporaryFile, filePath)
}

async function chooseWorkspace(parentWindow = null) {
  const options = {
    title: '选择 Yogurt AI 工作区',
    buttonLabel: '选择此文件夹',
    message: '画布和 Agent 生成的文件将保存在这个文件夹中。',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  }
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options)
  const workspaceDir = result.canceled ? null : result.filePaths?.[0]
  return workspaceDir ? path.resolve(workspaceDir) : null
}

async function chooseWorkspaceAndRelaunch() {
  if (relaunchScheduled) return Object.freeze({ selected: false, restarting: true })
  const workspaceDir = await chooseWorkspace(mainWindow)
  if (!workspaceDir) return Object.freeze({ selected: false, restarting: false })
  await writeDesktopSettings(settingsFile, { version: 1, workspaceDir })
  relaunchScheduled = true
  setTimeout(() => {
    app.relaunch()
    app.quit()
  }, 180)
  return Object.freeze({ selected: true, restarting: true, workspaceDir })
}

async function initializeDesktopRuntime() {
  const appPath = applicationRoot
  distIndexPath = path.join(appPath, 'dist', 'index.html')
  settingsFile = path.join(app.getPath('userData'), desktopSettingsFileName)
  const settings = await readDesktopSettings(settingsFile)
  let workspace = resolveConfiguredWorkspace({
    env: process.env,
    persistedWorkspace: settings.workspaceDir
  })

  if (!workspace.configured) {
    const selectedWorkspace = await chooseWorkspace()
    if (selectedWorkspace) {
      await writeDesktopSettings(settingsFile, { version: 1, workspaceDir: selectedWorkspace })
      workspace = Object.freeze({
        configured: true,
        source: 'first-run',
        workspaceDir: selectedWorkspace,
        invalidPath: null
      })
    }
  }

  const scratchProjectDir = path.join(app.getPath('userData'), 'onboarding-workspace')
  const projectDir = workspace.workspaceDir || scratchProjectDir
  const canvasDir = path.join(projectDir, 'canvas')
  await mkdir(projectDir, { recursive: true })

  let agentService = null
  let agentStartError = null
  if (workspace.configured) {
    try {
      const runtimeRoot = resolveDesktopRuntimeRoot({
        appPath,
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged
      })
      const cowartMcpCommand = process.env.YOGURT_NODE_COMMAND || (app.isPackaged
        ? process.execPath
        : 'node')
      const codexLaunch = resolveCodexLaunch({
        runtimeRoot,
        isPackaged: app.isPackaged,
        execPath: process.execPath
      })
      const appVersion = app.getVersion()
      const clientVersion = process.env.YOGURT_DESKTOP_VERSION || appVersion
      const codexClient = new CodexAppServerClient({
        command: codexLaunch.command,
        commandPrefixArgs: codexLaunch.commandPrefixArgs,
        args: createYogurtCodexArgs({ repoRoot: runtimeRoot, nodeCommand: cowartMcpCommand }),
        cwd: projectDir,
        env: { ...process.env, ...(codexLaunch.env || {}) },
        clientInfo: {
          name: 'yogurt_ai_desktop',
          title: 'Yogurt AI Desktop',
          version: clientVersion
        },
        experimentalApi: true
      })
      const sessionFile = path.join(canvasDir, '.yogurt-agent-session.json')
      agentService = new YogurtAgentService({
        client: codexClient,
        projectDir,
        canvasDir,
        initialThreadId: readPersistedThreadId(sessionFile, appVersion),
        onThreadChanged: (threadId) => persistThreadId(sessionFile, canvasDir, threadId, appVersion)
      })
    } catch (error) {
      agentStartError = error
      console.warn('Yogurt AI will open without Codex Agent:', error)
    }
  }

  desktopRuntime = new YogurtDesktopRuntime({
    agentService,
    agentStartError,
    configuredWorkspace: workspace.configured,
    projectDir,
    canvasDir,
    workspaceSource: workspace.source
  })

  agentAttention = createAgentAttentionController({
    getWindow: () => mainWindow,
    isNotificationSupported: () => Notification.isSupported(),
    createNotification: (options) => new Notification(options)
  })
  desktopRuntime.on('event', agentAttention.handle)
}

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
    agentService: desktopRuntime,
    getTrustedWebContents: trustedWebContents,
    claimBootstrapWebContents,
    selectWorkspace: chooseWorkspaceAndRelaunch,
    openExternal: (url) => shell.openExternal(url)
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
      backgroundColor: '#f4f2ed',
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
  mainWindow.on('focus', () => agentAttention?.stopFlashing())
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
  const requestedWidth = Number(process.env.YOGURT_DESKTOP_CAPTURE_WIDTH)
  const requestedHeight = Number(process.env.YOGURT_DESKTOP_CAPTURE_HEIGHT)
  if (Number.isFinite(requestedWidth) || Number.isFinite(requestedHeight)) {
    const [currentWidth, currentHeight] = mainWindow.getSize()
    mainWindow.setSize(
      Number.isFinite(requestedWidth)
        ? Math.round(Math.min(Math.max(requestedWidth, 1_024), 1_920))
        : currentWidth,
      Number.isFinite(requestedHeight)
        ? Math.round(Math.min(Math.max(requestedHeight, 720), 1_200))
        : currentHeight
    )
  }
  const requestedDelay = Number(process.env.YOGURT_DESKTOP_CAPTURE_DELAY_MS)
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.min(Math.max(requestedDelay, 250), 15_000)
    : 2_500
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  const captureAgentPanel = process.env.YOGURT_DESKTOP_CAPTURE_AGENT_PANEL === '1'
  const captureAutoAdvance = process.env.YOGURT_DESKTOP_CAPTURE_AUTO_ADVANCE === '1'
  const captureSelectionId = String(process.env.YOGURT_DESKTOP_CAPTURE_SELECT_ELEMENT_ID || '').trim()
  if (captureAgentPanel || captureAutoAdvance) {
    const captureState = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
        const shouldOpenPanel = ${JSON.stringify(captureAgentPanel || captureAutoAdvance)}
        const shouldEnableAutoAdvance = ${JSON.stringify(captureAutoAdvance)}
        const nativeExcalidrawReady = Boolean(
          document.querySelector('.native-excalidraw-app[data-ai-mode="off"] .excalidraw') &&
          !document.querySelector('.tl-container')
        )
        const legacyCanvasReady = Boolean(
          document.querySelector('.cowart-native-workbench .tl-container') &&
          document.querySelector('.cowart-ai-mode-entry')
        )
        const pureCanvasReady = nativeExcalidrawReady || legacyCanvasReady
        if (shouldOpenPanel) {
          if (nativeExcalidrawReady) {
            window.dispatchEvent(new CustomEvent('yogurt:toggle-ai-mode'))
          } else {
            document.querySelector('.cowart-ai-mode-entry')?.click()
            let opener = null
            for (let attempt = 0; attempt < 40; attempt += 1) {
              opener = document.querySelector('.yogurt-app-agent-toggle')
              if (opener) break
              await sleep(100)
            }
            if (opener?.getAttribute('aria-expanded') !== 'true') opener?.click()
          }
        }
        let executionToggle = null
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const shadowRoot = document.querySelector('.native-excalidraw-agent-host')?.shadowRoot
          executionToggle = shadowRoot?.querySelector('.cowart-agent-execution-mode > button') ||
            document.querySelector('.cowart-agent-execution-mode > button')
          if (executionToggle) break
          await sleep(100)
        }
        if (
          shouldEnableAutoAdvance &&
          executionToggle &&
          executionToggle.getAttribute('aria-pressed') !== 'true'
        ) {
          executionToggle.click()
          await sleep(250)
        }
        return {
          pureCanvasReady,
          innerWidth: window.innerWidth,
          devicePixelRatio: window.devicePixelRatio,
          compactAgentLayout: window.matchMedia('(max-width: 600px)').matches,
          canvasBounds: document.querySelector('.native-excalidraw-canvas')?.getBoundingClientRect().toJSON?.() || null,
          agentBounds: document.querySelector('.native-excalidraw-agent-host')?.getBoundingClientRect().toJSON?.() || null,
          agentPanelBounds: document.querySelector('.native-excalidraw-agent-host')?.shadowRoot?.querySelector('.cowart-agent-panel')?.getBoundingClientRect().toJSON?.() || null,
          fixedAgentElements: [...(document.querySelector('.native-excalidraw-agent-host')?.shadowRoot?.querySelectorAll('*') || [])]
            .filter((element) => getComputedStyle(element).position === 'fixed')
            .slice(0, 12)
            .map((element) => ({ className: element.className, bounds: element.getBoundingClientRect().toJSON?.() || null })),
          aiModeEnabled: document.querySelector('.native-excalidraw-app[data-ai-mode="on"]') !== null ||
            document.querySelector('.cowart-workbench[data-ai-mode="on"]') !== null,
          agentPanelOpen: document.querySelector('.native-excalidraw-agent-host') !== null ||
            document.querySelector('.yogurt-app-agent-toggle')?.getAttribute('aria-expanded') === 'true',
          autoAdvanceEnabled: executionToggle?.getAttribute('aria-pressed') === 'true',
          excalidrawViewport: window.__cowartExcalidrawAPI?.getAppState?.()
            ? {
                zoom: window.__cowartExcalidrawAPI.getAppState().zoom,
                scrollX: window.__cowartExcalidrawAPI.getAppState().scrollX,
                scrollY: window.__cowartExcalidrawAPI.getAppState().scrollY
              }
            : null
        }
      })()
    `)
    console.log(`Desktop capture state: ${JSON.stringify(captureState)}`)
    if (captureState?.pureCanvasReady !== true) {
      throw new Error('Requested desktop capture did not start in pure canvas mode.')
    }
    if (captureState?.aiModeEnabled !== true) {
      throw new Error('Requested desktop capture could not enable AI mode.')
    }
    if (captureState?.agentPanelOpen !== true) {
      throw new Error('Requested desktop capture could not open the Codex Agent panel.')
    }
    if (captureAutoAdvance && captureState?.autoAdvanceEnabled !== true) {
      throw new Error('Requested desktop capture could not enable Auto-advance canvas.')
    }
  }
  const captureZoom = Number(process.env.YOGURT_DESKTOP_CAPTURE_ZOOM)
  if (Number.isFinite(captureZoom) && captureZoom > 0) {
    const zoomState = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const api = window.__cowartExcalidrawAPI
        api?.updateScene?.({ appState: { zoom: { value: ${JSON.stringify(captureZoom)} } } })
        await new Promise((resolve) => setTimeout(resolve, 200))
        return api?.getAppState?.().zoom || null
      })()
    `)
    console.log(`Desktop capture zoom: ${JSON.stringify(zoomState)}`)
  }
  if (captureSelectionId) {
    const selectionState = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
        const elementId = ${JSON.stringify(captureSelectionId)}
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const api = window.__cowartExcalidrawAPI
          const element = api?.getSceneElements?.().find((candidate) => candidate.id === elementId)
          if (api && element) {
            api.updateScene({ appState: { selectedElementIds: { [elementId]: true } } })
            api.scrollToContent?.([element], { fitToContent: false, animate: false })
            await sleep(350)
            return { selected: api.getAppState?.().selectedElementIds?.[elementId] === true }
          }
          await sleep(100)
        }
        return { selected: false }
      })()
    `)
    if (selectionState?.selected !== true) {
      throw new Error(`Requested desktop capture could not select Excalidraw element ${captureSelectionId}.`)
    }
  }
  const image = await mainWindow.webContents.capturePage()
  await mkdir(path.dirname(capturePath), { recursive: true })
  await writeFile(capturePath, image.toPNG())
  console.log(`Captured Yogurt AI Desktop at ${capturePath}`)
  app.quit()
  return true
}

await app.whenReady()
installTrustedClipboardPermissionPolicy({
  electronSession: session.defaultSession,
  getTrustedWebContents: trustedWebContents
})
await initializeDesktopRuntime()
desktopRuntime.start().catch((error) => {
  console.error('Yogurt AI Codex sidecar failed to start:', error)
})
await createMainWindow()
installYogurtApplicationMenu({ Menu, getWindow: () => mainWindow })
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
  if (desktopRuntime && agentAttention) desktopRuntime.off('event', agentAttention.handle)
  agentAttention?.dispose()
  desktopRuntime?.dispose()
    .catch((error) => console.error('Could not stop Yogurt AI Codex sidecar cleanly:', error))
    .finally(() => app.quit())
})
