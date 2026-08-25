import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'

import {
  YOGURT_DESKTOP_CAPABILITY_CONTRACT,
  YogurtAgentService
} from '../desktop/agent-service.mjs'
import { IPC_CHANNELS, registerYogurtAgentIpc } from '../desktop/ipc-bridge.mjs'

class FakeCodexClient extends EventEmitter {
  constructor() {
    super()
    this.calls = []
    this.pendingServerRequests = []
    this.state = { status: 'ready', transport: 'stdio' }
  }

  async start() {
    this.calls.push(['start'])
  }

  async startThread(params) {
    this.calls.push(['startThread', params])
    return { thread: { id: 'thr_1' } }
  }

  async resumeThread(threadId, params) {
    this.calls.push(['resumeThread', threadId, params])
    return { thread: { id: threadId } }
  }

  async startTurn(threadId, input) {
    this.calls.push(['startTurn', threadId, input])
    return { turn: { id: 'turn_1' } }
  }

  async steerTurn(threadId, turnId, input) {
    this.calls.push(['steerTurn', threadId, turnId, input])
    return { turnId }
  }

  async interruptTurn(threadId, turnId) {
    this.calls.push(['interruptTurn', threadId, turnId])
    return {}
  }

  async respondToApproval(requestId, decision) {
    this.calls.push(['respondToApproval', requestId, decision])
    return { requestId, decision }
  }

  async rejectServerRequest(requestId, error) {
    this.calls.push(['rejectServerRequest', requestId, error])
    return { requestId, code: error?.code }
  }

  async callMcpServerTool(...args) {
    this.calls.push(['callMcpServerTool', ...args])
    return { structuredContent: { ok: true } }
  }

  async listModels() {
    return { data: [{ id: 'model-1', model: 'model-1', displayName: 'Model 1', isDefault: true }] }
  }

  async listMcpServers() {
    return { data: [{ name: 'cowart_thinking_mcp', tools: { get_cowart_canvas_state: {} } }] }
  }

  async dispose() {
    this.calls.push(['dispose'])
  }
}

test('YogurtAgentService starts and steers turns while returning acceptance only', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({
    client,
    projectDir: 'C:\\workspace',
    canvasDir: 'C:\\workspace\\canvas'
  })

  const first = await service.sendTask({ prompt: 'Build a PRD.' })
  const second = await service.sendTask({ prompt: 'Focus on the prototype.' })

  assert.deepEqual(first, {
    accepted: true,
    mode: 'started',
    threadId: 'thr_1',
    turnId: 'turn_1'
  })
  assert.equal(second.mode, 'steered')
  assert.equal(client.calls.some(([name]) => name === 'startTurn'), true)
  assert.equal(client.calls.some(([name]) => name === 'steerTurn'), true)
  const startThreadCall = client.calls.find(([name]) => name === 'startThread')
  assert.equal(startThreadCall[1].approvalPolicy, 'on-request')
  assert.equal(startThreadCall[1].sandbox, 'workspace-write')
})

test('YogurtAgentService resumes and persists one Codex thread per project', async () => {
  const client = new FakeCodexClient()
  const persistedThreadIds = []
  const service = new YogurtAgentService({
    client,
    projectDir: 'C:\\workspace',
    initialThreadId: 'thr_saved',
    onThreadChanged: (threadId) => persistedThreadIds.push(threadId)
  })

  await service.start()

  const resumeCall = client.calls.find(([name]) => name === 'resumeThread')
  assert.deepEqual(resumeCall.slice(1, 2), ['thr_saved'])
  assert.equal(resumeCall[2].approvalPolicy, 'on-request')
  assert.equal(resumeCall[2].sandbox, 'workspace-write')
  assert.equal(service.getState().threadId, 'thr_saved')
  assert.deepEqual(persistedThreadIds, ['thr_saved'])
})

test('YogurtAgentService resumes its thread and starts a fresh turn after a sidecar failure', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })

  await service.sendTask({ prompt: 'First turn.' })
  client.emit('lifecycle', { status: 'failed', error: 'Sidecar exited.' })
  assert.equal(service.getState().status, 'failed')
  assert.equal(service.getState().turnId, null)

  await service.sendTask({ prompt: 'Continue after restart.' })
  const resumeCalls = client.calls.filter(([name]) => name === 'resumeThread')
  const turnCalls = client.calls.filter(([name]) => name === 'startTurn')
  const steerCalls = client.calls.filter(([name]) => name === 'steerTurn')
  assert.equal(resumeCalls.length, 1)
  assert.equal(resumeCalls[0][1], 'thr_1')
  assert.equal(turnCalls.length, 2)
  assert.equal(steerCalls.length, 0)
})

test('YogurtAgentService normalizes agent, approval, diff, plan, turn, and error events', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  await service.start()
  const events = []
  service.on('event', (event) => events.push(event))

  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', delta: 'Hello' }
  })
  client.emit('notification', {
    method: 'turn/plan/updated',
    params: { threadId: 'thr_1', turnId: 'turn_1', plan: [{ step: 'Test', status: 'inProgress' }] }
  })
  client.emit('notification', {
    method: 'turn/diff/updated',
    params: { threadId: 'thr_1', turnId: 'turn_1', diff: 'diff --git' }
  })
  client.emit('notification', {
    method: 'turn/started',
    params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'inProgress' } }
  })
  client.emit('serverRequest', {
    requestId: 'approval-1',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_2', reason: 'Apply edits' }
  })
  client.emit('notification', {
    method: 'serverRequest/resolved',
    params: { threadId: 'thr_1', requestId: 'approval-1' }
  })
  client.emit('notification', {
    method: 'error',
    params: { threadId: 'thr_1', turnId: 'turn_1', error: { message: 'Failed' }, willRetry: false }
  })
  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'failed', error: { message: 'Failed' } } }
  })

  const types = events.map((event) => event.type)
  for (const expected of [
    'agent.delta',
    'plan.updated',
    'diff.updated',
    'turn.started',
    'approval.requested',
    'approval.resolved',
    'turn.completed',
    'error'
  ]) {
    assert.equal(types.includes(expected), true, `missing ${expected}`)
  }
  const approval = events.find((event) => event.type === 'approval.requested')
  assert.equal(approval.requestId, 'approval-1')
  assert.equal(approval.kind, 'fileChange')
  assert.deepEqual(approval.availableDecisions, ['accept', 'acceptForSession', 'decline', 'cancel'])
})

test('YogurtAgentService rejects unsupported server requests instead of leaving a turn blocked', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  await service.start()
  const errors = []
  service.on('event', (event) => {
    if (event.type === 'error') errors.push(event)
  })

  client.emit('serverRequest', {
    requestId: 'permission-1',
    method: 'item/permissions/requestApproval',
    params: { threadId: 'thr_1', turnId: 'turn_1' }
  })
  await Promise.resolve()

  const rejection = client.calls.find(([name]) => name === 'rejectServerRequest')
  assert.equal(rejection[1], 'permission-1')
  assert.deepEqual(rejection[2], {
    code: -32601,
    message: 'Unsupported Codex server request: item/permissions/requestApproval'
  })
  assert.equal(errors.at(-1).requestId, 'permission-1')
})

test('Cowart tool bridge uses a fixed server, fixed paths, and a strict tool allowlist', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({
    client,
    projectDir: 'C:\\workspace',
    canvasDir: 'C:\\workspace\\canvas'
  })
  await service.callCowartTool({
    name: 'get_cowart_canvas_state',
    arguments: { projectDir: 'C:\\escape', canvasDir: 'C:\\escape\\canvas' }
  })
  const call = client.calls.find(([name]) => name === 'callMcpServerTool')
  assert.equal(call[2], 'cowart_thinking_mcp')
  assert.equal(call[3], 'get_cowart_canvas_state')
  assert.equal(call[4].projectDir, service.projectDir)
  assert.equal(call[4].canvasDir, service.canvasDir)
  await assert.rejects(
    service.callCowartTool({ name: 'command/exec', arguments: {} }),
    /not exposed/
  )
  assert.equal(YOGURT_DESKTOP_CAPABILITY_CONTRACT.cowartToolNames.includes('command/exec'), false)
})

test('desktop bridge exposes the widget analytics tool without adding canvas paths', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  const analyticsArguments = {
    clientId: '123.456',
    eventName: 'widget_prompt_sent',
    appVersion: '0.2.1',
    parameters: { prompt_type: 'other', has_reference: 'no' }
  }

  await service.callCowartTool({
    name: 'track_cowart_analytics_event',
    arguments: analyticsArguments
  })

  const call = client.calls.find(
    ([name, _threadId, _serverName, toolName]) =>
      name === 'callMcpServerTool' && toolName === 'track_cowart_analytics_event'
  )
  assert.equal(call[2], 'cowart_thinking_mcp')
  assert.deepEqual(call[4], analyticsArguments)
  assert.equal('projectDir' in call[4], false)
  assert.equal('canvasDir' in call[4], false)
  assert.equal(
    YOGURT_DESKTOP_CAPABILITY_CONTRACT.cowartToolNames.includes('track_cowart_analytics_event'),
    true
  )
})

test('IPC bridge registers only the renderer whitelist and rejects foreign senders', async () => {
  const handlers = new Map()
  const listeners = new Map()
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler) },
    removeHandler(channel) { handlers.delete(channel) },
    on(channel, handler) { listeners.set(channel, handler) },
    removeListener(channel) { listeners.delete(channel) }
  }
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  const trusted = { id: 1, send() {}, isDestroyed: () => false }
  const cleanup = registerYogurtAgentIpc({
    ipcMain,
    agentService: service,
    getTrustedWebContents: () => trusted
  })

  assert.deepEqual(new Set(handlers.keys()), new Set([
    IPC_CHANNELS.getState,
    IPC_CHANNELS.refreshCapabilities,
    IPC_CHANNELS.sendTask,
    IPC_CHANNELS.respondApproval,
    IPC_CHANNELS.interrupt,
    IPC_CHANNELS.callCowartTool
  ]))
  await assert.rejects(
    handlers.get(IPC_CHANNELS.getState)({ sender: { id: 2 } }),
    /untrusted renderer/
  )
  assert.equal((await handlers.get(IPC_CHANNELS.getState)({ sender: trusted })).projectDir, service.projectDir)
  cleanup()
  assert.equal(handlers.size, 0)
})

test('IPC bootstrap can claim exactly one provisional renderer before BrowserWindow construction returns', () => {
  const handlers = new Map()
  const listeners = new Map()
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler) },
    removeHandler(channel) { handlers.delete(channel) },
    on(channel, handler) { listeners.set(channel, handler) },
    removeListener(channel) { listeners.delete(channel) }
  }
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  let trusted = null
  let provisional = null
  const cleanup = registerYogurtAgentIpc({
    ipcMain,
    agentService: service,
    getTrustedWebContents: () => trusted ?? provisional,
    claimBootstrapWebContents(sender) {
      if (provisional) return provisional === sender
      provisional = sender
      return true
    }
  })
  const bootstrap = listeners.get(IPC_CHANNELS.bootstrap)
  const firstRenderer = { id: 10 }
  const firstEvent = { sender: firstRenderer, returnValue: null }
  bootstrap(firstEvent)
  assert.equal(firstEvent.returnValue.toolOutput.projectDir, service.projectDir)
  assert.equal(provisional, firstRenderer)

  trusted = firstRenderer
  provisional = null
  const foreignEvent = { sender: { id: 11 }, returnValue: null }
  bootstrap(foreignEvent)
  assert.match(foreignEvent.returnValue.error, /untrusted renderer/)
  cleanup()
})
