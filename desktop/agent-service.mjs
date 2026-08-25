import { EventEmitter } from 'node:events'
import path from 'node:path'

const COWART_MCP_SERVER = 'cowart_thinking_mcp'
const COWART_TOOL_NAMES = Object.freeze([
  'copy_cowart_image_to_clipboard',
  'download_cowart_file',
  'get_cowart_canvas_state',
  'insert_cowart_html_draft',
  'read_cowart_page_asset',
  'save_cowart_canvas_state',
  'save_cowart_reference_image',
  'save_cowart_selection_state',
  'save_cowart_view_state',
  'track_cowart_analytics_event'
])
const COWART_TOOL_SET = new Set(COWART_TOOL_NAMES)
const APPROVAL_DECISIONS = Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value, label, maxLength = 100_000) {
  const text = String(value ?? '').trim()
  if (!text) throw new TypeError(`${label} is required.`)
  if (text.length > maxLength) throw new TypeError(`${label} exceeds ${maxLength} characters.`)
  return text
}

function taskText(task) {
  if (typeof task === 'string') return requiredString(task, 'Task text')
  if (!isRecord(task)) throw new TypeError('sendTask expects a string or task object.')
  if (typeof task.prompt === 'string') return requiredString(task.prompt, 'Task prompt')
  if (typeof task.content === 'string') return requiredString(task.content, 'Task content')
  if (Array.isArray(task.content)) {
    const parts = task.content
      .filter((item) => isRecord(item) && item.type === 'text')
      .map((item) => String(item.text || '').trim())
      .filter(Boolean)
    return requiredString(parts.join('\n\n'), 'Task content')
  }
  throw new TypeError('sendTask requires prompt or text content.')
}

function turnIdFrom(response) {
  return response?.turn?.id || response?.turnId || null
}

function approvalKind(method) {
  if (method === 'item/commandExecution/requestApproval') return 'command'
  if (method === 'item/fileChange/requestApproval') return 'fileChange'
  return 'unsupported'
}

function approvalSummary(kind, params) {
  if (kind === 'command') {
    if (params?.networkApprovalContext?.host) {
      const protocol = params.networkApprovalContext.protocol
      return `Allow ${protocol ? `${protocol} ` : ''}access to ${params.networkApprovalContext.host}`
    }
    return String(params?.reason || params?.command || 'Run the requested command.')
  }
  if (kind === 'fileChange') {
    return String(params?.reason || (params?.grantRoot ? `Allow writes under ${params.grantRoot}` : 'Apply the proposed file changes.'))
  }
  return 'Codex requested an unsupported client response.'
}

function normalizedEvent(type, fields = {}) {
  return Object.freeze({ type, at: new Date().toISOString(), ...fields })
}

function compactModels(result) {
  return Array.isArray(result?.data)
    ? result.data.map((model) => ({
        id: model.id,
        model: model.model,
        displayName: model.displayName,
        isDefault: model.isDefault === true,
        inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : []
      }))
    : []
}

function compactMcpServer(result) {
  const server = Array.isArray(result?.data)
    ? result.data.find((entry) => entry?.name === COWART_MCP_SERVER)
    : null
  return server
    ? {
        name: server.name,
        available: true,
        authStatus: server.authStatus ?? null,
        toolNames: Object.keys(server.tools || {}).sort()
      }
    : { name: COWART_MCP_SERVER, available: false, authStatus: null, toolNames: [] }
}

export class YogurtAgentService extends EventEmitter {
  #activeThreadId = null
  #activeTurnId = null
  #canvasDir
  #capabilities
  #client
  #lastError = null
  #onThreadChanged
  #projectDir
  #startPromise = null
  #status = 'idle'
  #threadNeedsResume = false

  constructor({
    client,
    projectDir,
    canvasDir = path.join(projectDir, 'canvas'),
    initialThreadId = null,
    onThreadChanged = null
  } = {}) {
    super()
    if (!client || typeof client.start !== 'function') {
      throw new TypeError('YogurtAgentService requires a Codex App Server client.')
    }
    this.#client = client
    this.#projectDir = path.resolve(requiredString(projectDir, 'projectDir', 4_096))
    this.#canvasDir = path.resolve(requiredString(canvasDir, 'canvasDir', 4_096))
    this.#activeThreadId = initialThreadId
      ? requiredString(initialThreadId, 'initialThreadId', 512)
      : null
    this.#threadNeedsResume = Boolean(this.#activeThreadId)
    this.#onThreadChanged = typeof onThreadChanged === 'function' ? onThreadChanged : null
    this.#capabilities = this.#baseCapabilities()
    this.#bindClientEvents()
  }

  get projectDir() {
    return this.#projectDir
  }

  get canvasDir() {
    return this.#canvasDir
  }

  async start() {
    if (this.#status === 'ready' && this.#activeThreadId) return this.getState()
    if (this.#startPromise) return this.#startPromise
    this.#status = 'starting'
    this.#emitEvent(normalizedEvent('state.changed', { state: this.getState() }))
    this.#startPromise = (async () => {
      try {
        await this.#client.start()
        await this.#ensureThread()
        this.#status = 'ready'
        this.#lastError = null
        this.#emitEvent(normalizedEvent('state.changed', { state: this.getState() }))
        return this.getState()
      } catch (error) {
        this.#status = 'failed'
        this.#lastError = String(error?.message || error)
        this.#emitError(error, 'sidecar')
        throw error
      }
    })().finally(() => {
      this.#startPromise = null
    })
    return this.#startPromise
  }

  getState() {
    return Object.freeze({
      status: this.#status,
      threadId: this.#activeThreadId,
      turnId: this.#activeTurnId,
      projectDir: this.#projectDir,
      canvasDir: this.#canvasDir,
      pendingApprovals: this.#client.pendingServerRequests?.filter((request) =>
        request.method === 'item/commandExecution/requestApproval' ||
        request.method === 'item/fileChange/requestApproval'
      ).length ?? 0,
      lastError: this.#lastError,
      sidecar: this.#client.state
    })
  }

  getCapabilities() {
    return this.#capabilities
  }

  async refreshCapabilities() {
    await this.start()
    const [modelsResult, mcpResult] = await Promise.allSettled([
      this.#client.listModels({ limit: 100 }),
      this.#client.listMcpServers(this.#activeThreadId, {
        limit: 100,
        detail: 'toolsAndAuthOnly'
      })
    ])
    this.#capabilities = Object.freeze({
      ...this.#baseCapabilities(),
      models: modelsResult.status === 'fulfilled' ? compactModels(modelsResult.value) : [],
      cowartMcp: mcpResult.status === 'fulfilled'
        ? compactMcpServer(mcpResult.value)
        : { name: COWART_MCP_SERVER, available: false, authStatus: null, toolNames: [] },
      refreshErrors: [modelsResult, mcpResult]
        .filter((result) => result.status === 'rejected')
        .map((result) => String(result.reason?.message || result.reason))
    })
    return this.#capabilities
  }

  async sendTask(task) {
    await this.start()
    const text = taskText(task)
    const requestedThreadId = isRecord(task) && task.threadId
      ? requiredString(task.threadId, 'threadId', 512)
      : null
    if (requestedThreadId && requestedThreadId !== this.#activeThreadId) {
      await this.#resumeThread(requestedThreadId)
    }

    const requestedTurnId = isRecord(task) && task.expectedTurnId
      ? requiredString(task.expectedTurnId, 'expectedTurnId', 512)
      : null
    const activeTurnId = requestedTurnId || this.#activeTurnId
    if (activeTurnId) {
      const result = await this.#client.steerTurn(this.#activeThreadId, activeTurnId, text)
      const acceptedTurnId = result?.turnId || activeTurnId
      this.#activeTurnId = acceptedTurnId
      return Object.freeze({
        accepted: true,
        mode: 'steered',
        threadId: this.#activeThreadId,
        turnId: acceptedTurnId
      })
    }

    const result = await this.#client.startTurn(this.#activeThreadId, text)
    const turnId = turnIdFrom(result)
    if (!turnId) throw new Error('Codex App Server accepted turn/start without returning a turn id.')
    this.#activeTurnId = turnId
    return Object.freeze({
      accepted: true,
      mode: 'started',
      threadId: this.#activeThreadId,
      turnId
    })
  }

  async respondApproval(requestId, decision) {
    await this.start()
    const normalizedRequestId = requiredString(requestId, 'requestId', 512)
    if (!APPROVAL_DECISIONS.includes(decision)) {
      throw new TypeError(`Unsupported approval decision: ${String(decision)}`)
    }
    const result = await this.#client.respondToApproval(normalizedRequestId, decision)
    return Object.freeze({ accepted: true, ...result })
  }

  async interrupt() {
    await this.start()
    if (!this.#activeThreadId || !this.#activeTurnId) {
      return Object.freeze({ accepted: false, reason: 'no-active-turn' })
    }
    const threadId = this.#activeThreadId
    const turnId = this.#activeTurnId
    await this.#client.interruptTurn(threadId, turnId)
    return Object.freeze({ accepted: true, threadId, turnId })
  }

  async callCowartTool(request) {
    await this.start()
    if (!isRecord(request)) throw new TypeError('Cowart tool request must be an object.')
    const name = requiredString(request.name, 'Cowart tool name', 160)
    if (!COWART_TOOL_SET.has(name)) {
      throw new Error(`Cowart tool is not exposed by the desktop bridge: ${name}`)
    }
    const suppliedArguments = isRecord(request.arguments) ? request.arguments : {}
    const args = name === 'track_cowart_analytics_event'
      ? suppliedArguments
      : {
          ...suppliedArguments,
          projectDir: this.#projectDir,
          canvasDir: this.#canvasDir
        }
    return this.#client.callMcpServerTool(
      this.#activeThreadId,
      COWART_MCP_SERVER,
      name,
      args
    )
  }

  async dispose() {
    this.#status = 'stopping'
    this.#emitEvent(normalizedEvent('state.changed', { state: this.getState() }))
    await this.#client.dispose()
    this.#status = 'stopped'
    this.#activeTurnId = null
    this.#threadNeedsResume = Boolean(this.#activeThreadId)
    this.#emitEvent(normalizedEvent('state.changed', { state: this.getState() }))
  }

  async #ensureThread() {
    if (this.#activeThreadId && !this.#threadNeedsResume) return this.#activeThreadId
    if (this.#activeThreadId && this.#threadNeedsResume) {
      const persistedThreadId = this.#activeThreadId
      try {
        await this.#resumeThread(persistedThreadId)
        return this.#activeThreadId
      } catch (_error) {
        this.#activeThreadId = null
        this.#activeTurnId = null
        this.#threadNeedsResume = false
      }
    }
    const result = await this.#client.startThread({
      cwd: this.#projectDir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      serviceName: 'yogurt_ai_desktop'
    })
    const threadId = result?.thread?.id
    if (!threadId) throw new Error('Codex App Server did not return a thread id.')
    this.#activeThreadId = threadId
    await this.#notifyThreadChanged(threadId)
    return threadId
  }

  async #resumeThread(threadId) {
    const result = await this.#client.resumeThread(threadId, {
      cwd: this.#projectDir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    })
    const resumedThreadId = result?.thread?.id
    if (!resumedThreadId) throw new Error('Codex App Server did not return the resumed thread id.')
    this.#activeThreadId = resumedThreadId
    this.#activeTurnId = null
    this.#threadNeedsResume = false
    await this.#notifyThreadChanged(resumedThreadId)
  }

  async #notifyThreadChanged(threadId) {
    if (!this.#onThreadChanged) return
    try {
      await this.#onThreadChanged(threadId)
    } catch (_error) {
      // Session persistence is a convenience; the active Codex thread remains usable.
    }
  }

  #baseCapabilities() {
    return Object.freeze({
      protocol: Object.freeze({
        transport: 'stdio-jsonl',
        experimentalApi: false,
        websocket: false
      }),
      message: Object.freeze({ text: true, image: false }),
      agent: Object.freeze({
        sendTask: true,
        steer: true,
        interrupt: true,
        approvals: true
      }),
      security: Object.freeze({
        arbitraryRpc: false,
        arbitraryShell: false,
        rendererProcessControl: false
      }),
      cowartMcp: Object.freeze({
        name: COWART_MCP_SERVER,
        available: null,
        toolNames: COWART_TOOL_NAMES
      }),
      models: Object.freeze([]),
      refreshErrors: Object.freeze([])
    })
  }

  #bindClientEvents() {
    this.#client.on('notification', ({ method, params }) => this.#handleNotification(method, params))
    this.#client.on('serverRequest', (request) => this.#handleServerRequest(request))
    this.#client.on('lifecycle', ({ status, ...details }) => {
      if (status === 'failed') {
        this.#status = 'failed'
        this.#lastError = details.error || details.stderr || 'Codex App Server failed.'
        this.#activeTurnId = null
        this.#threadNeedsResume = Boolean(this.#activeThreadId)
        this.#emitError(new Error(this.#lastError), 'sidecar')
      }
    })
    this.#client.on('protocolError', (error) => this.#emitError(error, 'protocol'))
    this.#client.on('processError', (error) => this.#emitError(error, 'sidecar'))
  }

  #handleNotification(method, params = {}) {
    if (method === 'item/agentMessage/delta') {
      this.#emitEvent(normalizedEvent('agent.delta', {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        delta: String(params.delta || '')
      }))
      return
    }
    if (method === 'turn/plan/updated') {
      this.#emitEvent(normalizedEvent('plan.updated', {
        threadId: params.threadId,
        turnId: params.turnId,
        explanation: params.explanation ?? null,
        plan: Array.isArray(params.plan) ? params.plan : []
      }))
      return
    }
    if (method === 'turn/diff/updated') {
      this.#emitEvent(normalizedEvent('diff.updated', {
        threadId: params.threadId,
        turnId: params.turnId,
        diff: String(params.diff || '')
      }))
      return
    }
    if (method === 'turn/started') {
      const turnId = params.turn?.id || null
      this.#activeThreadId = params.threadId || this.#activeThreadId
      this.#activeTurnId = turnId || this.#activeTurnId
      this.#emitEvent(normalizedEvent('turn.started', {
        threadId: this.#activeThreadId,
        turnId,
        turn: params.turn ?? null
      }))
      return
    }
    if (method === 'turn/completed') {
      const turnId = params.turn?.id || null
      if (!turnId || turnId === this.#activeTurnId) this.#activeTurnId = null
      this.#emitEvent(normalizedEvent('turn.completed', {
        threadId: params.threadId || this.#activeThreadId,
        turnId,
        status: params.turn?.status || 'unknown',
        turn: params.turn ?? null
      }))
      if (params.turn?.status === 'failed' && params.turn?.error) {
        this.#emitError(new Error(params.turn.error.message || 'Codex turn failed.'), 'turn', {
          threadId: params.threadId,
          turnId
        })
      }
      return
    }
    if (method === 'serverRequest/resolved') {
      this.#emitEvent(normalizedEvent('approval.resolved', {
        threadId: params.threadId ?? this.#activeThreadId,
        requestId: params.requestId == null ? null : String(params.requestId)
      }))
      return
    }
    if (method === 'error') {
      this.#emitError(new Error(params.error?.message || 'Codex turn failed.'), 'turn', {
        threadId: params.threadId,
        turnId: params.turnId,
        willRetry: params.willRetry === true,
        details: params.error ?? null
      })
    }
  }

  #handleServerRequest(request) {
    const kind = approvalKind(request.method)
    if (kind === 'unsupported') {
      const message = `Unsupported Codex server request: ${request.method}`
      this.#emitError(new Error(message), 'protocol', {
        requestId: request.requestId
      })
      Promise.resolve(
        this.#client.rejectServerRequest?.(request.requestId, {
          code: -32601,
          message
        })
      ).catch((error) => {
        this.#emitError(error, 'protocol', {
          requestId: request.requestId,
          rejectedMethod: request.method
        })
      })
      return
    }
    const params = request.params || {}
    this.#emitEvent(normalizedEvent('approval.requested', {
      requestId: String(request.requestId),
      kind,
      summary: approvalSummary(kind, params),
      availableDecisions: Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : APPROVAL_DECISIONS,
      threadId: params.threadId ?? null,
      turnId: params.turnId ?? null,
      itemId: params.itemId ?? null,
      details: params
    }))
  }

  #emitError(error, source, fields = {}) {
    this.#emitEvent(normalizedEvent('error', {
      source,
      message: String(error?.message || error),
      code: error?.code ?? null,
      ...fields
    }))
  }

  #emitEvent(event) {
    this.emit('event', event)
  }
}

export const YOGURT_DESKTOP_CAPABILITY_CONTRACT = Object.freeze({
  cowartMcpServer: COWART_MCP_SERVER,
  cowartToolNames: COWART_TOOL_NAMES,
  approvalDecisions: APPROVAL_DECISIONS,
  eventTypes: Object.freeze([
    'agent.delta',
    'plan.updated',
    'diff.updated',
    'approval.requested',
    'approval.resolved',
    'turn.started',
    'turn.completed',
    'error',
    'state.changed'
  ])
})
