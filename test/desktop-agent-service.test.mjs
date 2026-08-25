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
