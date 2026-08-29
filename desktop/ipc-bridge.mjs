import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  readCowartCanvasState,
  readCowartPageAsset,
  saveCowartCanvasSnapshot,
  writeCowartSelectionState,
  writeCowartViewState
} from '../mcp/lib/canvas-storage.mjs'
import {
  normalizeMcpElicitationUrl,
  validateMcpElicitationResponse
} from './elicitation.mjs'

export const IPC_CHANNELS = Object.freeze({
  bootstrap: 'yogurt-agent:bootstrap',
  callCowartTool: 'yogurt-agent:call-cowart-tool',
  event: 'yogurt-agent:event',
  getState: 'yogurt-agent:get-state',
  refreshCapabilities: 'yogurt-agent:refresh-capabilities',
  selectWorkspace: 'yogurt-agent:select-workspace',
  startCodexLogin: 'yogurt-agent:start-codex-login',
  respondApproval: 'yogurt-agent:respond-approval',
  respondElicitation: 'yogurt-agent:respond-elicitation',
  sendTask: 'yogurt-agent:send-task',
  interrupt: 'yogurt-agent:interrupt'
})

const LOCAL_CANVAS_TOOLS = new Set([
  'get_cowart_canvas_state',
  'read_cowart_page_asset',
  'save_cowart_canvas_state',
  'save_cowart_selection_state',
  'save_cowart_view_state'
])

function setupErrorDetails(error) {
  const message = String(error?.message || error || '')
  const code = String(error?.code || '')
  if (code === 'CODEX_BUNDLED_CLI_MISSING') {
    return Object.freeze({
      status: 'missing',
      title: 'Codex 组件缺失',
      message: '请重新安装 Yogurt AI；你的工作区和画布不会被删除。',
      command: null
    })
  }
  if (code === 'CODEX_CLI_NOT_FOUND' || /could not find codex|codex.*not found|enoent/i.test(message)) {
    return Object.freeze({
      status: 'missing',
      title: '需要安装 Codex',
      message: '安装 Codex CLI 后重新打开 Yogurt AI。',
      command: 'npm install -g @openai/codex'
    })
  }
  if (/not logged in|login required|authentication|unauthorized|\b401\b/i.test(message)) {
    return Object.freeze({
      status: 'login-required',
      title: '需要登录 Codex',
      message: '点击“登录 Codex”，在浏览器完成授权后会自动连接。',
      command: null,
      canLogin: true
    })
  }
  return Object.freeze({
    status: 'error',
    title: 'Codex 连接异常',
    message: message || '检查 Codex 安装、登录和网络状态后重新检测。',
    command: null
  })
}

export function normalizeCodexLoginUrl(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch (_error) {
    throw new Error('Codex App Server returned an invalid login URL.')
  }
  const hostname = url.hostname.toLowerCase()
  const isOfficialHost = hostname === 'openai.com' || hostname.endsWith('.openai.com') ||
    hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
  if (
    url.protocol !== 'https:' ||
    !isOfficialHost ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password
  ) {
    throw new Error('Yogurt AI refused a non-OpenAI Codex login URL.')
  }
  return url.toString()
}

function frozenSecurityCapabilities() {
  return Object.freeze({
    arbitraryRpc: false,
    arbitraryShell: false,
    rendererProcessControl: false
  })
}

function wrapToolResult(structuredContent, { isError = false, message = '' } = {}) {
  return Object.freeze({
    ...(isError ? { isError: true } : {}),
    content: message ? Object.freeze([{ type: 'text', text: message }]) : Object.freeze([]),
    structuredContent
  })
}

async function callLocalCanvasTool({ projectDir, canvasDir }, request) {
  const name = String(request?.name || '').trim()
  if (!LOCAL_CANVAS_TOOLS.has(name)) return null
  const supplied = request?.arguments && typeof request.arguments === 'object'
    ? request.arguments
    : {}
  const args = { ...supplied, projectDir, canvasDir }

  if (name === 'get_cowart_canvas_state') {
    return wrapToolResult(
      await readCowartCanvasState(args, { hydrateAssets: supplied.hydrateAssets === true })
    )
  }
  if (name === 'read_cowart_page_asset') {
    return wrapToolResult(await readCowartPageAsset(args, { assetUrl: supplied.assetUrl }))
  }
  if (name === 'save_cowart_canvas_state') {
    const result = await saveCowartCanvasSnapshot(args, supplied.snapshot)
    return wrapToolResult(result, {
      isError: result.ok !== true,
      message: result.ok ? '' : result.message || 'Yogurt AI 无法保存当前画布。'
    })
  }
  if (name === 'save_cowart_selection_state') {
    return wrapToolResult(await writeCowartSelectionState(args, supplied.selection))
  }
  if (name === 'save_cowart_view_state') {
    return wrapToolResult(await writeCowartViewState(args, supplied.viewState))
  }
  return wrapToolResult({ configured: false, delivered: false, status: null })
}

export class YogurtDesktopRuntime extends EventEmitter {
  #agentService
  #agentStartError
  #canvasDir
  #configuredWorkspace
  #projectDir
  #workspaceSource

  constructor({
    agentService = null,
    agentStartError = null,
    configuredWorkspace = false,
    projectDir,
    canvasDir = path.join(projectDir, 'canvas'),
    workspaceSource = 'none'
  } = {}) {
    super()
    this.#agentService = agentService
    this.#agentStartError = agentStartError
    this.#configuredWorkspace = configuredWorkspace === true
    this.#projectDir = path.resolve(String(projectDir || ''))
    this.#canvasDir = path.resolve(String(canvasDir || ''))
    this.#workspaceSource = workspaceSource
    this.#agentService?.on?.('event', (event) => {
      if (event?.type === 'error' && ['sidecar', 'protocol'].includes(event.source)) {
        this.#agentStartError = new Error(event.message || 'Codex App Server failed.')
      }
      this.emit('event', event)
    })
  }

  get projectDir() {
    return this.#projectDir
  }

  get canvasDir() {
    return this.#canvasDir
  }

  getSetup() {
    const serviceState = this.#agentService?.getState?.() ?? null
    const workspace = Object.freeze({
      status: this.#configuredWorkspace ? 'ready' : 'required',
      configured: this.#configuredWorkspace,
      path: this.#configuredWorkspace ? this.#projectDir : null,
      source: this.#workspaceSource
    })
    let codex
    if (!this.#configuredWorkspace) {
      codex = Object.freeze({
        status: 'waiting-for-workspace',
        title: '选择工作区后连接 Codex',
        message: '工作区用于保存画布，并限定 Agent 可以访问的项目范围。',
        command: null
      })
    } else if (serviceState?.status === 'ready') {
      codex = Object.freeze({
        status: 'ready',
        title: 'Codex 已连接',
        message: '可以直接从画布发送任务。',
        command: null
      })
    } else if (serviceState?.status === 'starting') {
      codex = Object.freeze({
        status: 'starting',
        title: '正在连接 Codex',
        message: '首次连接可能需要几秒钟。',
        command: null
      })
    } else if (['auth-required', 'authenticating'].includes(serviceState?.status)) {
      const loginStatus = serviceState?.login?.status || 'idle'
      const waiting = ['starting', 'waiting', 'completed'].includes(loginStatus)
      codex = Object.freeze({
        status: waiting ? 'login-pending' : 'login-required',
        title: waiting ? '等待完成 Codex 登录' : '登录 Codex 后即可使用 Agent',
        message: waiting
          ? '请在浏览器完成授权；成功后 Yogurt AI 会自动连接。'
          : serviceState?.login?.error || '点击下方按钮，在浏览器安全登录 ChatGPT。',
        command: null,
        canLogin: true,
        loginStatus
      })
    } else if (this.#agentStartError || serviceState?.lastError) {
      codex = setupErrorDetails(this.#agentStartError || new Error(serviceState.lastError))
    } else {
      codex = Object.freeze({
        status: 'starting',
        title: '正在准备 Codex',
        message: 'Yogurt AI 正在启动本地 Agent。',
        command: null
      })
    }
    return Object.freeze({ workspace, codex })
  }

  getState() {
    const serviceState = this.#agentService?.getState?.() ?? {}
    return Object.freeze({
      ...serviceState,
      status: !this.#configuredWorkspace
        ? 'workspace-required'
        : serviceState.status || 'failed',
      projectDir: this.#projectDir,
      canvasDir: this.#canvasDir,
      lastError: serviceState.lastError || String(this.#agentStartError?.message || '') || null,
      capabilities: this.getCapabilities(),
      setup: this.getSetup()
    })
  }

  getCapabilities() {
    const serviceState = this.#agentService?.getState?.() ?? null
    const available = this.#configuredWorkspace && serviceState?.status === 'ready'
    const serviceCapabilities = this.#agentService?.getCapabilities?.() ?? {}
    return Object.freeze({
      ...serviceCapabilities,
      available,
      agent: Object.freeze({
        ...(serviceCapabilities.agent || {}),
        sendTask: available,
        steer: available,
        interrupt: available,
        approvals: available,
        elicitations: available
      }),
      security: serviceCapabilities.security || frozenSecurityCapabilities(),
      setup: this.getSetup()
    })
  }

  async start() {
    if (!this.#agentService || !this.#configuredWorkspace) return this.getState()
    try {
      await this.#agentService.start()
      this.#agentStartError = null
    } catch (error) {
      this.#agentStartError = error
    }
    this.emit('event', Object.freeze({
      type: 'desktop.setup.changed',
      at: new Date().toISOString(),
      setup: this.getSetup()
    }))
    return this.getState()
  }

  async refreshCapabilities() {
    if (!this.#agentService || !this.#configuredWorkspace) return this.getCapabilities()
    try {
      await this.#agentService.refreshCapabilities()
      this.#agentStartError = null
    } catch (error) {
      this.#agentStartError = error
    }
    this.emit('event', Object.freeze({
      type: 'desktop.setup.changed',
      at: new Date().toISOString(),
      setup: this.getSetup()
    }))
    return this.getCapabilities()
  }

  async sendTask(task) {
    if (!this.#configuredWorkspace) {
      throw new Error('请先选择一个工作区，再把画布任务交给 Codex。')
    }
    if (!this.#agentService) {
      throw new Error(setupErrorDetails(this.#agentStartError).message)
    }
    try {
      const result = await this.#agentService.sendTask(task)
      this.#agentStartError = null
      return result
    } catch (error) {
      this.#agentStartError = error
      throw error
    }
  }

  async startCodexLogin() {
    if (!this.#configuredWorkspace) {
      throw new Error('请先选择一个工作区，再登录 Codex。')
    }
    if (!this.#agentService?.startChatgptLogin) {
      throw new Error('当前 Codex 组件不支持应用内登录。')
    }
    try {
      const result = await this.#agentService.startChatgptLogin()
      this.#agentStartError = null
      return result
    } catch (error) {
      this.#agentStartError = error
      throw error
    }
  }

  async cancelCodexLogin(loginId) {
    return this.#agentService?.cancelChatgptLogin?.(loginId)
  }

  async respondApproval(requestId, decision) {
    if (!this.#agentService) throw new Error('Codex Agent 尚未连接。')
    return this.#agentService.respondApproval(requestId, decision)
  }

  getPendingElicitation(requestId) {
    return this.#agentService?.getPendingElicitation?.(requestId) ?? null
  }

  async respondElicitation(requestId, response) {
    if (!this.#agentService) throw new Error('Codex Agent 尚未连接。')
    return this.#agentService.respondElicitation(requestId, response)
  }

  async interrupt() {
    if (!this.#agentService) return Object.freeze({ accepted: false, reason: 'agent-unavailable' })
    return this.#agentService.interrupt()
  }

  async callCowartTool(request) {
    const localResult = await callLocalCanvasTool(this, request)
    if (localResult) return localResult
    if (!this.#agentService) {
      throw new Error('这项操作需要 Codex Agent。请按面板提示完成安装或登录。')
    }
    return this.#agentService.callCowartTool(request)
  }

  async dispose() {
    await this.#agentService?.dispose?.()
  }
}

function sameWebContents(sender, trusted) {
  return Boolean(sender && trusted && (sender === trusted || sender.id === trusted.id))
}

export function createDesktopBootstrap(agentService) {
  const setup = agentService.getSetup?.() ?? null
  const projectScopeId = `project:${createHash('sha256')
    .update(path.resolve(agentService.projectDir), 'utf8')
    .digest('hex')
    .slice(0, 24)}`
  return Object.freeze({
    toolOutput: Object.freeze({
      projectDir: agentService.projectDir,
      canvasDir: agentService.canvasDir,
      projectScopeId,
      workspaceName: setup?.workspace?.configured
        ? path.basename(agentService.projectDir)
        : '开始使用 Yogurt AI'
    }),
    capabilities: agentService.getCapabilities(),
    setup
  })
}

export function registerYogurtAgentIpc({
  ipcMain,
  agentService,
  getTrustedWebContents,
  claimBootstrapWebContents,
  selectWorkspace,
  openExternal
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('registerYogurtAgentIpc requires Electron ipcMain.')
  }
  if (!agentService || typeof agentService.sendTask !== 'function') {
    throw new TypeError('registerYogurtAgentIpc requires a YogurtAgentService.')
  }

  const trustedSender = (event, { allowBootstrapClaim = false } = {}) => {
    const trusted = getTrustedWebContents?.()
    if (sameWebContents(event?.sender, trusted)) return trusted
    if (
      allowBootstrapClaim &&
      !trusted &&
      typeof claimBootstrapWebContents === 'function' &&
      claimBootstrapWebContents(event?.sender) === true
    ) {
      return event.sender
    }
    throw new Error('Rejected IPC from an untrusted renderer.')
  }

  const bootstrapHandler = (event) => {
    try {
      trustedSender(event, { allowBootstrapClaim: true })
      event.returnValue = createDesktopBootstrap(agentService)
    } catch (error) {
      event.returnValue = { error: String(error?.message || error) }
    }
  }
  ipcMain.on(IPC_CHANNELS.bootstrap, bootstrapHandler)

  const handlers = new Map([
    [IPC_CHANNELS.getState, async (event) => {
      trustedSender(event)
      return agentService.getState()
    }],
    [IPC_CHANNELS.refreshCapabilities, async (event) => {
      trustedSender(event)
      return agentService.refreshCapabilities()
    }],
    [IPC_CHANNELS.selectWorkspace, async (event) => {
      trustedSender(event)
      if (typeof selectWorkspace !== 'function') {
        throw new Error('Workspace selection is not available in this host.')
      }
      return selectWorkspace()
    }],
    [IPC_CHANNELS.startCodexLogin, async (event) => {
      trustedSender(event)
      if (typeof agentService.startCodexLogin !== 'function') {
        throw new Error('Codex login is not available in this host.')
      }
      const result = await agentService.startCodexLogin()
      if (!result?.authUrl) {
        return Object.freeze({
          started: result?.started === true,
          alreadyAuthenticated: result?.alreadyAuthenticated === true,
          status: result?.status || 'ready',
          browserOpened: false
        })
      }
      let authUrl
      try {
        authUrl = normalizeCodexLoginUrl(result.authUrl)
      } catch (error) {
        await agentService.cancelCodexLogin?.(result.loginId)
        throw error
      }
      if (typeof openExternal !== 'function') {
        await agentService.cancelCodexLogin?.(result.loginId)
        throw new Error('Yogurt AI cannot open the Codex login page in this host.')
      }
      try {
        await openExternal(authUrl)
      } catch (error) {
        await agentService.cancelCodexLogin?.(result.loginId)
        throw error
      }
      return Object.freeze({
        started: result.started === true,
        alreadyAuthenticated: false,
        status: result.status || 'waiting',
        browserOpened: true
      })
    }],
    [IPC_CHANNELS.sendTask, async (event, task) => {
      trustedSender(event)
      return agentService.sendTask(task)
    }],
    [IPC_CHANNELS.respondApproval, async (event, payload) => {
      trustedSender(event)
      return agentService.respondApproval(payload?.requestId, payload?.decision)
    }],
    [IPC_CHANNELS.respondElicitation, async (event, payload) => {
      trustedSender(event)
      const request = agentService.getPendingElicitation?.(payload?.requestId)
      if (!request) {
        throw new Error(`No pending MCP elicitation exists for request ${String(payload?.requestId || '')}.`)
      }
      const response = validateMcpElicitationResponse(request, {
        action: payload?.action,
        content: payload?.content
      })
      if (request.mode === 'url' && response.action === 'accept') {
        if (typeof openExternal !== 'function') {
          throw new Error('Yogurt AI cannot open this MCP authorization page in the current host.')
        }
        try {
          await openExternal(normalizeMcpElicitationUrl(request.externalUrl))
        } catch (_error) {
          throw new Error(`Yogurt AI could not open the authorization page for ${request.publicRequest.urlHost}.`)
        }
      }
      return agentService.respondElicitation(payload?.requestId, response)
    }],
    [IPC_CHANNELS.interrupt, async (event) => {
      trustedSender(event)
      return agentService.interrupt()
    }],
    [IPC_CHANNELS.callCowartTool, async (event, request) => {
      trustedSender(event)
      return agentService.callCowartTool(request)
    }]
  ])

  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler)

  const forwardEvent = (payload) => {
    const webContents = getTrustedWebContents?.()
    if (!webContents || webContents.isDestroyed?.()) return
    webContents.send(IPC_CHANNELS.event, payload)
  }
  agentService.on('event', forwardEvent)

  return () => {
    ipcMain.removeListener(IPC_CHANNELS.bootstrap, bootstrapHandler)
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel)
    agentService.off('event', forwardEvent)
  }
}
