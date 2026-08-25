import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: 'yogurt_ai_desktop',
  title: 'Yogurt AI Desktop',
  version: '0.1.0'
})

const SIMPLE_APPROVAL_DECISIONS = new Set([
  'accept',
  'acceptForSession',
  'decline',
  'cancel'
])

const APPROVAL_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval'
])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function validateStdioArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args[0] !== 'app-server') {
    throw new TypeError('Codex sidecar args must start with "app-server".')
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index])
    if (arg === '--listen') {
      if (String(args[index + 1] || '') !== 'stdio://') {
        throw new TypeError('Yogurt AI only supports the local stdio:// App Server transport.')
      }
      index += 1
      continue
    }
    if (arg.startsWith('--listen=') && arg.slice('--listen='.length) !== 'stdio://') {
      throw new TypeError('Yogurt AI only supports the local stdio:// App Server transport.')
    }
  }
}

function rpcError(error, context = {}) {
  const message = typeof error?.message === 'string' ? error.message : 'Codex App Server request failed.'
  const result = new Error(message)
  result.name = 'CodexAppServerRpcError'
  result.code = error?.code ?? null
  result.data = error?.data
  result.method = context.method
  result.requestId = context.requestId
  return result
}

function lifecycleError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined)
  error.name = 'CodexAppServerLifecycleError'
  return error
}

export class CodexAppServerClient extends EventEmitter {
  #args
  #child = null
  #clientInfo
  #command
  #createLineReader
  #cwd
  #env
  #experimentalApi
  #initializeResult = null
  #nextRequestId = 1
  #pending = new Map()
  #pendingServerRequests = new Map()
  #requestTimeoutMs
  #spawnProcess
  #startPromise = null
  #status = 'idle'
  #stopPromise = null
  #stderr = ''
  #stdoutReader = null

  constructor({
    command = 'codex',
    args = ['app-server', '--listen', 'stdio://'],
    cwd = process.cwd(),
    env = process.env,
    clientInfo = DEFAULT_CLIENT_INFO,
    experimentalApi = false,
    requestTimeoutMs = 30_000,
    spawnProcess = spawn,
    createLineReader = (input) => createInterface({ input, crlfDelay: Infinity })
  } = {}) {
    super()
    validateStdioArgs(args)
    if (typeof command !== 'string' || !command.trim()) {
      throw new TypeError('Codex sidecar command must be a non-empty string.')
    }
    if (!isRecord(clientInfo) || !String(clientInfo.name || '').trim()) {
      throw new TypeError('clientInfo.name is required for the Codex App Server handshake.')
    }

    this.#command = command
    this.#args = args.map(String)
    this.#cwd = cwd
    this.#env = env
    this.#clientInfo = {
      name: String(clientInfo.name),
      title: String(clientInfo.title || clientInfo.name),
      version: String(clientInfo.version || '0.1.0')
    }
    this.#experimentalApi = experimentalApi === true
    this.#requestTimeoutMs = positiveInteger(requestTimeoutMs, 30_000)
    this.#spawnProcess = spawnProcess
    this.#createLineReader = createLineReader
  }

  get state() {
    return Object.freeze({
      status: this.#status,
      transport: 'stdio',
      experimentalApi: this.#experimentalApi,
      initialized: this.#status === 'ready',
      initializeResult: this.#initializeResult,
      pendingRequestCount: this.#pending.size,
      pendingServerRequestCount: this.#pendingServerRequests.size,
      pid: Number.isInteger(this.#child?.pid) ? this.#child.pid : null
    })
  }

  get pendingServerRequests() {
    return Array.from(this.#pendingServerRequests.entries(), ([requestId, message]) => ({
      requestId,
      method: message.method,
      params: message.params
    }))
  }

  async start() {
    if (this.#status === 'ready') return this.#initializeResult
    if (this.#startPromise) return this.#startPromise
    if (this.#stopPromise) await this.#stopPromise

    this.#startPromise = this.#startInternal().finally(() => {
      this.#startPromise = null
    })
    return this.#startPromise
  }

  async #startInternal() {
    this.#transition('starting')
    this.#stderr = ''

    let child
    try {
      child = this.#spawnProcess(this.#command, this.#args, {
        cwd: this.#cwd,
        env: this.#env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (cause) {
      this.#transition('failed', { error: String(cause?.message || cause) })
      throw lifecycleError('Could not start the Codex App Server sidecar.', cause)
    }

    if (!child?.stdin || !child?.stdout || typeof child.on !== 'function') {
      throw lifecycleError('The Codex App Server process did not expose stdio streams.')
    }

    this.#child = child
    this.#stdoutReader = this.#createLineReader(child.stdout)
    this.#stdoutReader.on('line', (line) => this.#handleLine(line))
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      this.#stderr = `${this.#stderr}${text}`.slice(-32_000)
      this.emit('stderr', text)
    })
    child.once('error', (error) => this.#handleProcessError(error))
    child.once('exit', (code, signal) => this.#handleProcessExit(code, signal))

    try {
      const initializeResult = await this.#requestRaw('initialize', {
        clientInfo: this.#clientInfo,
        capabilities: {
          experimentalApi: this.#experimentalApi,
          requestAttestation: false
        }
      })
      await this.#write({ method: 'initialized', params: {} })
      this.#initializeResult = initializeResult
      this.#transition('ready')
      return initializeResult
    } catch (cause) {
      if (this.#child === child) {
        try {
          child.kill()
        } catch {
          // The process may already have exited while initialization failed.
        }
      }
      this.#transition('failed', { error: String(cause?.message || cause) })
      throw cause
    }
  }

  async request(method, params = {}, options = {}) {
    await this.start()
    return this.#requestRaw(method, params, options)
  }

  async #requestRaw(method, params = {}, { timeoutMs = this.#requestTimeoutMs } = {}) {
    if (typeof method !== 'string' || !method.trim()) {
      throw new TypeError('App Server request method must be a non-empty string.')
    }
    if (!this.#child?.stdin || this.#child.stdin.destroyed) {
      throw lifecycleError('Codex App Server stdin is not available.')
    }

    const id = this.#nextRequestId
    this.#nextRequestId += 1
    const key = String(id)
    let timer

    const response = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(key)
        reject(lifecycleError(`Codex App Server request timed out: ${method}`))
      }, positiveInteger(timeoutMs, this.#requestTimeoutMs))
      timer.unref?.()
      this.#pending.set(key, { id, method, resolve, reject, timer })
    })

    try {
      await this.#write({ method, id, params: isRecord(params) ? params : {} })
    } catch (error) {
      clearTimeout(timer)
      this.#pending.delete(key)
      throw error
    }
    return response
  }

  async notify(method, params = {}) {
    await this.start()
    return this.#write({ method, params: isRecord(params) ? params : {} })
  }

  startThread(params = {}) {
    return this.request('thread/start', params)
  }

  resumeThread(threadId, overrides = {}) {
    return this.request('thread/resume', { ...overrides, threadId })
  }

  startTurn(threadId, input, overrides = {}) {
    return this.request('turn/start', {
      ...overrides,
      threadId,
      input: normalizeUserInput(input)
    })
  }

  steerTurn(threadId, expectedTurnId, input) {
    return this.request('turn/steer', {
      threadId,
      expectedTurnId,
      input: normalizeUserInput(input)
    })
  }

  interruptTurn(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId })
  }

  listModels(params = {}) {
    return this.request('model/list', params)
  }

  listMcpServers(threadId, params = {}) {
    return this.request('mcpServerStatus/list', {
      ...params,
      ...(threadId ? { threadId } : {})
    })
  }

  callMcpServerTool(threadId, server, tool, args = {}, meta) {
    return this.request('mcpServer/tool/call', {
      threadId,
      server,
      tool,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta })
    })
  }

  async respondToApproval(requestId, decision) {
    const key = String(requestId)
    const request = this.#pendingServerRequests.get(key)
    if (!request || !APPROVAL_REQUEST_METHODS.has(request.method)) {
      throw new Error(`No pending command or file approval exists for request ${key}.`)
    }
    if (!SIMPLE_APPROVAL_DECISIONS.has(decision)) {
      throw new TypeError('Approval decision must be accept, acceptForSession, decline, or cancel.')
    }
    await this.#write({ id: request.id, result: { decision } })
    this.#pendingServerRequests.delete(key)
    return { requestId: key, decision }
  }

  async respondToServerRequest(requestId, result) {
    const key = String(requestId)
    const request = this.#pendingServerRequests.get(key)
    if (!request) throw new Error(`No pending server request exists for request ${key}.`)
    await this.#write({ id: request.id, result })
    this.#pendingServerRequests.delete(key)
    return { requestId: key }
  }

  async stop({ forceAfterMs = 2_000 } = {}) {
    if (this.#stopPromise) return this.#stopPromise
    if (!this.#child) {
      this.#transition('stopped')
      return
    }

    const child = this.#child
    this.#transition('stopping')
    this.#stopPromise = new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        resolve()
      }
      const forceTimer = setTimeout(() => {
        try {
          child.kill()
        } finally {
          finish()
        }
      }, positiveInteger(forceAfterMs, 2_000))
      forceTimer.unref?.()
      child.once('exit', finish)
      try {
        child.stdin?.end()
      } catch {
        try {
          child.kill()
        } finally {
          finish()
        }
      }
    }).finally(() => {
      this.#stopPromise = null
      if (this.#child === child) this.#cleanupChild()
      this.#transition('stopped')
    })
    return this.#stopPromise
  }

  async restart() {
    await this.stop()
    return this.start()
  }

  async dispose() {
    return this.stop()
  }

  async #write(message) {
    const stdin = this.#child?.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      throw lifecycleError('Codex App Server stdin is closed.')
    }
    const line = `${JSON.stringify(message)}\n`
    await new Promise((resolve, reject) => {
      stdin.write(line, (error) => (error ? reject(error) : resolve()))
    })
  }

  #handleLine(line) {
    if (!String(line).trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch (cause) {
      const error = lifecycleError('Codex App Server emitted invalid JSONL.', cause)
      this.emit('protocolError', error)
      return
    }
    if (!isRecord(message)) {
      this.emit('protocolError', lifecycleError('Codex App Server emitted a non-object JSONL message.'))
      return
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
    const isResponse = hasId && (
      Object.prototype.hasOwnProperty.call(message, 'result') ||
      Object.prototype.hasOwnProperty.call(message, 'error')
    )
    if (isResponse) {
      const key = String(message.id)
      const pending = this.#pending.get(key)
      if (!pending) {
        this.emit('orphanResponse', message)
        return
      }
      this.#pending.delete(key)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(rpcError(message.error, { method: pending.method, requestId: pending.id }))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && hasId) {
      const key = String(message.id)
      this.#pendingServerRequests.set(key, message)
      this.emit('serverRequest', {
        requestId: key,
        id: message.id,
        method: message.method,
        params: message.params ?? {}
      })
      return
    }

    if (typeof message.method === 'string') {
      const notification = { method: message.method, params: message.params ?? {} }
      this.emit('notification', notification)
      this.emit(`notification:${message.method}`, notification.params)
      return
    }

    this.emit('protocolError', lifecycleError('Codex App Server emitted an unrecognized JSONL message.'))
  }

  #handleProcessError(cause) {
    const error = lifecycleError('Codex App Server process error.', cause)
    this.emit('processError', error)
    this.#rejectPending(error)
    if (this.#status !== 'stopping' && this.#status !== 'stopped') {
      this.#transition('failed', { error: error.message })
    }
  }

  #handleProcessExit(code, signal) {
    const wasStopping = this.#status === 'stopping' || this.#status === 'stopped'
    const details = {
      code: Number.isInteger(code) ? code : null,
      signal: signal || null,
      stderr: this.#stderr || null
    }
    const error = lifecycleError(
      `Codex App Server exited${details.code === null ? '' : ` with code ${details.code}`}.`
    )
    this.#rejectPending(error)
    this.#pendingServerRequests.clear()
    this.#cleanupChild()
    this.#transition(wasStopping ? 'stopped' : 'failed', details)
    this.emit('exit', details)
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #cleanupChild() {
    this.#stdoutReader?.close?.()
    this.#stdoutReader = null
    this.#child = null
    this.#initializeResult = null
  }

  #transition(status, details = {}) {
    this.#status = status
    this.emit('lifecycle', { status, ...details })
  }
}

export function normalizeUserInput(input) {
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) throw new TypeError('Task text must not be empty.')
    return [{ type: 'text', text, text_elements: [] }]
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('Turn input must be a string or a non-empty input array.')
  }
  return input.map((item) => {
    if (!isRecord(item) || item.type !== 'text') {
      throw new TypeError('The desktop bridge currently accepts text input only.')
    }
    const text = String(item.text || '').trim()
    if (!text) throw new TypeError('Task text must not be empty.')
    return { type: 'text', text, text_elements: [] }
  })
}

export const CODEX_APP_SERVER_PROTOCOL = Object.freeze({
  transport: 'stdio-jsonl',
  websocket: false,
  experimentalApiDefault: false,
  approvalDecisions: Object.freeze(Array.from(SIMPLE_APPROVAL_DECISIONS))
})
