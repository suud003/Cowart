import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentBridge, normalizeAgentEvent } from '../src/agentBridge.js'
import { createCodexHostAgentAdapter } from '../src/codexHostAgentAdapter.js'

function eventWindow(initial = {}) {
  const listeners = new Map()
  return {
    ...initial,
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set()
      entries.add(listener)
      listeners.set(type, entries)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener({ type })
    }
  }
}

test('Agent event normalization preserves transport event and item identities', () => {
  const event = normalizeAgentEvent({
    type: 'agent.delta',
    eventId: 'desktop-event:42',
    threadId: 'thread:one',
    turnId: 'turn:one',
    itemId: 'item:one',
    text: 'hello'
  }, '2026-08-26T12:00:00.000Z')

  assert.equal(event.eventId, 'desktop-event:42')
  assert.equal(event.itemId, 'item:one')
})

test('Codex host adapter prefers the Electron preload bridge', async () => {
  const calls = []
  const windowObject = eventWindow({
    yogurtAgent: {
      getCapabilities: () => ({ message: { image: true } }),
      sendTask: async (message, options) => {
        calls.push({ provider: 'yogurtAgent', message, options })
        return { accepted: true }
      }
    },
    cowartMcp: {
      sendFollowUpMessage: async () => calls.push({ provider: 'cowartMcp' })
    },
    openai: {
      sendFollowUpMessage: async () => calls.push({ provider: 'openai' })
    }
  })

  const adapter = createCodexHostAgentAdapter(windowObject)
  assert.deepEqual(adapter.getCapabilities(), {
    available: true,
    provider: 'yogurtAgent',
    sendTask: true,
    streaming: false,
    approvals: false,
    elicitation: false,
    interrupt: false,
    message: { image: true }
  })
  assert.deepEqual(await adapter.sendTask({ prompt: 'Map this.' }, { taskId: 'task:1' }), {
    accepted: true
  })
  assert.deepEqual(calls, [{
    provider: 'yogurtAgent',
    message: { prompt: 'Map this.' },
    options: { taskId: 'task:1' }
  }])
})

test('Electron preload can advertise onboarding without exposing a usable Agent transport', async () => {
  let selected = 0
  const setup = {
    workspace: { status: 'required', configured: false, path: null },
    codex: { status: 'waiting-for-workspace', title: '选择工作区后连接 Codex' }
  }
  const windowObject = eventWindow({
    yogurtAgent: {
      capabilities: { available: false, agent: { sendTask: false }, setup },
      getCapabilities: () => ({ available: false, agent: { sendTask: false }, setup }),
      sendTask: async () => { throw new Error('must not send') },
      selectWorkspace: async () => {
        selected += 1
        return { selected: false, restarting: false }
      }
    }
  })

  const adapter = createCodexHostAgentAdapter(windowObject)
  const bridge = createAgentBridge(adapter)
  assert.equal(bridge.capabilities.available, false)
  assert.equal(bridge.capabilities.setup.workspace.status, 'required')
  assert.deepEqual(await bridge.selectWorkspace(), { selected: false, restarting: false })
  assert.equal(selected, 1)
})

test('Electron preload exposes the fixed Codex login action through the bridge', async () => {
  let loginRequests = 0
  const setup = {
    workspace: { status: 'ready', configured: true, path: 'C:\\workspace' },
    codex: { status: 'login-required', canLogin: true }
  }
  const windowObject = eventWindow({
    yogurtAgent: {
      capabilities: { available: false, agent: { sendTask: false }, setup },
      getCapabilities: () => ({ available: false, agent: { sendTask: false }, setup }),
      sendTask: async () => { throw new Error('must not send') },
      startCodexLogin: async () => {
        loginRequests += 1
        return { status: 'waiting', browserOpened: true }
      }
    }
  })

  const adapter = createCodexHostAgentAdapter(windowObject)
  const bridge = createAgentBridge(adapter)
  assert.deepEqual(await bridge.startCodexLogin(), {
    status: 'waiting',
    browserOpened: true
  })
  assert.equal(loginRequests, 1)
})

test('Codex host adapter falls back from Cowart MCP to OpenAI host', async () => {
  const messages = []
  const windowObject = eventWindow({
    cowartMcp: {
      getHostCapabilities: () => ({ message: { image: true } }),
      sendFollowUpMessage: async (message) => messages.push(['cowart', message])
    },
    openai: {
      hostCapabilities: { message: { image: false } },
      sendFollowUpMessage: async (message) => messages.push(['openai', message])
    }
  })
  const adapter = createCodexHostAgentAdapter(windowObject)

  assert.equal(adapter.getCapabilities().provider, 'cowartMcp')
  assert.equal(adapter.getCapabilities().message.image, true)
  await adapter.sendTask('first')

  delete windowObject.cowartMcp.sendFollowUpMessage
  assert.equal(adapter.getCapabilities().provider, 'openai')
  assert.equal(adapter.getCapabilities().message.image, false)
  await adapter.sendTask('second')

  assert.deepEqual(messages, [['cowart', 'first'], ['openai', 'second']])
})

test('AgentBridge records host acceptance without treating it as agent completion', async () => {
  let now = 10
  const events = []
  const adapter = {
    getCapabilities: () => ({
      available: true,
      provider: 'test',
      sendTask: true,
      message: { image: true }
    }),
    sendTask: async (message, options) => ({ message, taskId: options.taskId })
  }
  const bridge = createAgentBridge(adapter, {
    clock: () => now++,
    taskIdFactory: () => 'task:test'
  })
  bridge.subscribe((state, event) => events.push({ state, event }))

  const result = await bridge.sendTask({ prompt: 'Build a diagram.' }, {
    metadata: { source: 'selection' }
  })

  assert.deepEqual(result, {
    message: { prompt: 'Build a diagram.' },
    taskId: 'task:test'
  })
  assert.deepEqual(events.map(({ event }) => event.type), [
    'task.started',
    'task.accepted'
  ])
  assert.equal(events[0].state.status, 'sending')
  assert.deepEqual(events[0].state.pendingTaskIds, ['task:test'])
  assert.equal(bridge.getState().status, 'idle')
  assert.equal(bridge.getState().lastTask.status, 'accepted')
  assert.equal(bridge.getState().activity.phase, 'running')
  assert.equal(Object.isFrozen(bridge.getState()), true)
  assert.equal(Object.isFrozen(bridge.getState().pendingTaskIds), true)
})

test('AgentBridge normalizes streamed App Server activity and completes the accepted task', async () => {
  let emitAgentEvent
  const responses = []
  const interruptions = []
  const adapter = {
    getCapabilities: () => ({
      available: true,
      provider: 'desktop',
      sendTask: true,
      streaming: true,
      approvals: true,
      interrupt: true
    }),
    sendTask: async () => ({ thread: { id: 'thread:one' }, turn: { id: 'turn:one' } }),
    subscribe(listener) {
      emitAgentEvent = listener
      return () => { emitAgentEvent = null }
    },
    respondApproval: async (requestId, decision) => responses.push([requestId, decision]),
    interrupt: async (options) => interruptions.push(options)
  }
  const bridge = createAgentBridge(adapter, { taskIdFactory: () => 'task:stream' })
  const eventTypes = []
  bridge.subscribe((_state, event) => eventTypes.push(event.type))

  await bridge.sendTask('stream this')
  emitAgentEvent({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread:one', turnId: 'turn:one', delta: 'Hello ' }
  })
  emitAgentEvent({
    method: 'turn/plan/updated',
    params: { threadId: 'thread:one', turnId: 'turn:one', plan: [{ step: 'Draw' }] }
  })
  emitAgentEvent({
    id: 42,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread:one', turnId: 'turn:one', command: 'npm test' }
  })

  assert.equal(bridge.getState().activity.phase, 'waiting_approval')
  assert.equal(bridge.getState().activity.message, 'Hello ')
  assert.deepEqual(bridge.getState().activity.plan, [{ step: 'Draw' }])
  assert.equal(bridge.getState().lastEvent.requestId, 42)
  await bridge.respondApproval(42, 'accept')
  await bridge.interrupt({ reason: 'user' })
  assert.deepEqual(responses, [[42, 'accept']])
  assert.deepEqual(interruptions, [{ reason: 'user' }])

  emitAgentEvent({
    method: 'turn/completed',
    params: { threadId: 'thread:one', turnId: 'turn:one' }
  })
  assert.equal(bridge.getState().activity.phase, 'completed')
  assert.equal(bridge.getState().lastTask.status, 'succeeded')
  assert.deepEqual(bridge.getState().session, {
    threadId: 'thread:one',
    turnId: 'turn:one'
  })
  assert.deepEqual(eventTypes, [
    'task.started',
    'task.accepted',
    'agent.delta',
    'agent.plan',
    'approval.requested',
    'turn.completed'
  ])
})

test('AgentBridge accepts thread-scoped elicitations without turnId, forwards responses, and clears them', async () => {
  let emitAgentEvent
  const responses = []
  const adapter = {
    getCapabilities: () => ({
      available: true,
      provider: 'desktop',
      sendTask: true,
      streaming: true,
      elicitation: true
    }),
    sendTask: async () => ({ threadId: 'thread:one', turnId: 'turn:one' }),
    subscribe(listener) {
      emitAgentEvent = listener
      return () => { emitAgentEvent = null }
    },
    respondElicitation: async (requestId, response) => {
      responses.push([requestId, response])
      return { delivered: true }
    }
  }
  const bridge = createAgentBridge(adapter, { taskIdFactory: () => 'task:elicitation' })
  await bridge.sendTask('ask me for a choice')
  emitAgentEvent({
    id: 'request:form',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread:one',
      turnId: null,
      mode: 'form',
      message: 'Choose a format',
      requestedSchema: {
        type: 'object',
        properties: { format: { type: 'string', enum: ['svg', 'html'] } }
      }
    }
  })

  assert.equal(bridge.getState().lastEvent.type, 'elicitation.requested')
  assert.equal(bridge.getState().activity.phase, 'waiting_elicitation')
  assert.equal(bridge.getState().activity.elicitation.requestId, 'request:form')
  assert.equal(bridge.getState().activity.elicitation.message, 'Choose a format')

  emitAgentEvent({
    type: 'elicitation.resolved',
    threadId: 'thread:one',
    requestId: 'request:form'
  })
  assert.equal(bridge.getState().activity.phase, 'running')
  assert.equal(bridge.getState().activity.elicitation, null)

  emitAgentEvent({
    type: 'elicitation.requested',
    requestId: 'request:form-2',
    threadId: 'thread:one',
    turnId: 'turn:one',
    mode: 'form',
    message: 'Choose again',
    requestedSchema: {
      type: 'object',
      properties: { format: { type: 'string', enum: ['svg', 'html'] } }
    }
  })

  const response = { action: 'accept', content: { format: 'svg' } }
  assert.deepEqual(await bridge.respondElicitation('request:form-2', response), { delivered: true })
  assert.deepEqual(responses, [['request:form-2', response]])
  assert.equal(bridge.getState().lastEvent.type, 'elicitation.resolved')
  assert.equal(bridge.getState().activity.phase, 'running')
  assert.equal(bridge.getState().activity.elicitation, null)
})

test('AgentBridge restores a standalone pending elicitation after the renderer bridge is rebuilt', () => {
  let emitAgentEvent
  const bridge = createAgentBridge({
    getCapabilities: () => ({
      available: true,
      provider: 'desktop',
      sendTask: true,
      streaming: true,
      elicitation: true
    }),
    sendTask: async () => ({ accepted: true }),
    subscribe(listener) {
      emitAgentEvent = listener
      return () => { emitAgentEvent = null }
    }
  })

  emitAgentEvent({
    type: 'elicitation.requested',
    requestId: 'request:restored',
    threadId: 'thread:restored',
    turnId: null,
    mode: 'form',
    message: 'Restore this request',
    requestedSchema: { type: 'object', properties: {} }
  })

  assert.equal(bridge.getState().activity.phase, 'waiting_elicitation')
  assert.equal(bridge.getState().activity.elicitation.requestId, 'request:restored')
})

test('Codex host adapter exposes only the preload elicitation responder', async () => {
  const calls = []
  const adapter = createCodexHostAgentAdapter(eventWindow({
    yogurtAgent: {
      getCapabilities: () => ({ streaming: true, elicitation: true }),
      sendTask: async () => ({ accepted: true }),
      respondElicitation: async (requestId, response) => {
        calls.push([requestId, response])
        return { delivered: true }
      }
    }
  }))

  assert.equal(adapter.getCapabilities().elicitation, true)
  assert.deepEqual(
    await adapter.respondElicitation('request:url', { action: 'accept', content: null }),
    { delivered: true }
  )
  assert.deepEqual(calls, [['request:url', { action: 'accept', content: null }]])
})

test('AgentBridge ignores streamed terminal events from a different turn', async () => {
  let emitAgentEvent
  const bridge = createAgentBridge({
    getCapabilities: () => ({ available: true, provider: 'desktop', sendTask: true, streaming: true }),
    sendTask: async () => ({ threadId: 'thread:one', turnId: 'turn:active' }),
    subscribe(listener) {
      emitAgentEvent = listener
      return () => {}
    }
  }, { taskIdFactory: () => 'task:active' })
  const eventTypes = []
  bridge.subscribe((_state, event) => eventTypes.push(event.type))

  await bridge.sendTask('keep this turn active')
  emitAgentEvent({ type: 'turn.completed', threadId: 'thread:one', turnId: 'turn:stale' })

  assert.equal(bridge.getState().lastTask.status, 'accepted')
  assert.equal(bridge.getState().activity.phase, 'running')
  assert.deepEqual(eventTypes, ['task.started', 'task.accepted'])

  emitAgentEvent({ type: 'turn.completed', threadId: 'thread:one', turnId: 'turn:active' })
  assert.equal(bridge.getState().lastTask.status, 'succeeded')
  assert.equal(bridge.getState().activity.phase, 'completed')
})

test('AgentBridge preserves an early matching completion received before turn/start resolves', async () => {
  let emitAgentEvent
  let resolveTask
  const taskAccepted = new Promise((resolve) => { resolveTask = resolve })
  const bridge = createAgentBridge({
    getCapabilities: () => ({ available: true, provider: 'desktop', sendTask: true, streaming: true }),
    sendTask: async () => taskAccepted,
    subscribe(listener) {
      emitAgentEvent = listener
      return () => {}
    }
  }, { taskIdFactory: () => 'task:early-completion' })

  const sending = bridge.sendTask('finish quickly')
  emitAgentEvent({ type: 'turn.started', threadId: 'thread:one', turnId: 'turn:fast' })
  emitAgentEvent({ type: 'turn.completed', threadId: 'thread:one', turnId: 'turn:fast' })
  resolveTask({ threadId: 'thread:one', turnId: 'turn:fast' })
  await sending

  assert.equal(bridge.getState().lastTask.status, 'succeeded')
  assert.equal(bridge.getState().lastTask.turnId, 'turn:fast')
  assert.equal(bridge.getState().activity.phase, 'completed')
  assert.deepEqual(bridge.getState().pendingTaskIds, [])
})

test('AgentBridge keeps an authoritative streamed terminal state when task dispatch rejects late', async () => {
  let emitAgentEvent
  let rejectTask
  const taskAccepted = new Promise((_resolve, reject) => { rejectTask = reject })
  const bridge = createAgentBridge({
    getCapabilities: () => ({ available: true, provider: 'desktop', sendTask: true, streaming: true }),
    sendTask: async () => taskAccepted,
    subscribe(listener) {
      emitAgentEvent = listener
      return () => {}
    }
  }, { taskIdFactory: () => 'task:early-terminal-reject' })
  const eventTypes = []
  bridge.subscribe((_state, event) => eventTypes.push(event.type))

  const sending = bridge.sendTask('finish before transport rejects')
  emitAgentEvent({ type: 'turn.started', threadId: 'thread:one', turnId: 'turn:fast' })
  emitAgentEvent({ type: 'turn.completed', threadId: 'thread:one', turnId: 'turn:fast' })
  rejectTask(new Error('late transport rejection'))
  const result = await sending

  assert.deepEqual(result, {
    threadId: 'thread:one',
    turnId: 'turn:fast',
    terminal: true,
    status: 'succeeded'
  })
  assert.equal(bridge.getState().lastTask.status, 'succeeded')
  assert.equal(bridge.getState().activity.phase, 'completed')
  assert.equal(bridge.getState().status, 'idle')
  assert.deepEqual(bridge.getState().pendingTaskIds, [])
  assert.deepEqual(eventTypes, ['task.started', 'turn.started', 'turn.completed', 'state.current'])
})

test('failed App Server completions and service errors become turn failures', async () => {
  let emitAgentEvent
  const bridge = createAgentBridge({
    getCapabilities: () => ({ available: true, provider: 'desktop', sendTask: true, streaming: true }),
    sendTask: async () => ({ turnId: 'turn:failed' }),
    subscribe(listener) {
      emitAgentEvent = listener
      return () => {}
    }
  }, { taskIdFactory: () => 'task:failed-turn' })
  await bridge.sendTask('fail later')

  emitAgentEvent({ type: 'turn.completed', turnId: 'turn:failed', status: 'failed' })
  assert.equal(bridge.getState().lastEvent.type, 'turn.failed')
  assert.equal(bridge.getState().lastTask.status, 'failed')
  assert.equal(bridge.getState().activity.phase, 'failed')

  emitAgentEvent({ type: 'error', turnId: 'turn:failed', message: 'Codex failed.' })
  assert.equal(bridge.getState().lastEvent.type, 'turn.failed')
  assert.equal(bridge.getState().activity.message, 'Codex failed.')
})

test('AgentBridge terminal turn states absorb late activity and interaction events', async () => {
  const terminalCases = [
    { type: 'turn.completed', taskStatus: 'succeeded', phase: 'completed' },
    { type: 'turn.failed', taskStatus: 'failed', phase: 'failed' },
    { type: 'turn.cancelled', taskStatus: 'cancelled', phase: 'cancelled' }
  ]

  for (const terminalCase of terminalCases) {
    let emitAgentEvent
    const bridge = createAgentBridge({
      getCapabilities: () => ({
        available: true,
        provider: 'desktop',
        sendTask: true,
        streaming: true,
        approvals: true,
        elicitation: true
      }),
      sendTask: async () => ({ threadId: 'thread:terminal', turnId: 'turn:terminal' }),
      subscribe(listener) {
        emitAgentEvent = listener
        return () => {}
      }
    }, { taskIdFactory: () => `task:${terminalCase.phase}` })
    const eventTypes = []
    bridge.subscribe((_state, event) => eventTypes.push(event.type))

    await bridge.sendTask(`reach ${terminalCase.phase}`)
    emitAgentEvent({
      type: terminalCase.type,
      threadId: 'thread:terminal',
      turnId: 'turn:terminal',
      text: terminalCase.type === 'turn.failed' ? 'Expected failure.' : null
    })
    const terminalState = bridge.getState()
    const terminalEventTypes = [...eventTypes]

    for (const lateEvent of [
      { type: 'turn.started' },
      { type: 'agent.delta', text: 'late reply' },
      { type: 'agent.plan', plan: [{ step: 'late plan' }] },
      { type: 'agent.diff', diff: 'late diff' },
      { type: 'approval.requested', requestId: 'approval:late', approval: { requestId: 'approval:late' } },
      { type: 'approval.resolved', requestId: 'approval:late' },
      { type: 'elicitation.requested', requestId: 'elicitation:late', elicitation: { requestId: 'elicitation:late' } },
      { type: 'elicitation.resolved', requestId: 'elicitation:late' },
      ...terminalCases
        .filter(({ type }) => type !== terminalCase.type)
        .map(({ type }) => ({ type }))
    ]) {
      emitAgentEvent({
        ...lateEvent,
        threadId: 'thread:terminal',
        turnId: 'turn:terminal'
      })
    }

    assert.equal(bridge.getState(), terminalState, `${terminalCase.phase} state must remain unchanged`)
    assert.equal(bridge.getState().lastTask.status, terminalCase.taskStatus)
    assert.equal(bridge.getState().activity.phase, terminalCase.phase)
    assert.deepEqual(eventTypes, terminalEventTypes, `${terminalCase.phase} must not publish late activity`)
  }
})

test('AgentBridge resolves approvals and elicitations only for the active request id', async () => {
  let emitAgentEvent
  const bridge = createAgentBridge({
    getCapabilities: () => ({
      available: true,
      provider: 'desktop',
      sendTask: true,
      streaming: true,
      approvals: true,
      elicitation: true
    }),
    sendTask: async () => ({ threadId: 'thread:requests', turnId: 'turn:requests' }),
    subscribe(listener) {
      emitAgentEvent = listener
      return () => {}
    }
  }, { taskIdFactory: () => 'task:requests' })
  const eventTypes = []
  bridge.subscribe((_state, event) => eventTypes.push(event.type))

  await bridge.sendTask('request user input')
  emitAgentEvent({
    id: 'approval:active',
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread:requests',
      turnId: 'turn:requests',
      command: 'npm test'
    }
  })
  assert.equal(bridge.getState().activity.phase, 'waiting_approval')
  assert.equal(bridge.getState().activity.approval.requestId, 'approval:active')

  const waitingApproval = bridge.getState()
  emitAgentEvent({
    type: 'approval.resolved',
    requestId: 'approval:other',
    threadId: 'thread:requests',
    turnId: 'turn:requests'
  })
  emitAgentEvent({
    type: 'elicitation.resolved',
    requestId: 'approval:active',
    threadId: 'thread:requests',
    turnId: 'turn:requests'
  })
  assert.equal(bridge.getState(), waitingApproval)
  assert.equal(bridge.getState().activity.approval.requestId, 'approval:active')

  emitAgentEvent({ type: 'approval.resolved', requestId: 'approval:active' })
  assert.equal(bridge.getState().activity.phase, 'running')
  assert.equal(bridge.getState().activity.approval, null)

  emitAgentEvent({
    id: 'elicitation:active',
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread:requests',
      turnId: 'turn:requests',
      mode: 'form',
      message: 'Choose a format',
      requestedSchema: { type: 'object', properties: {} }
    }
  })
  assert.equal(bridge.getState().activity.phase, 'waiting_elicitation')
  assert.equal(bridge.getState().activity.elicitation.requestId, 'elicitation:active')

  const waitingElicitation = bridge.getState()
  emitAgentEvent({
    type: 'elicitation.resolved',
    requestId: 'elicitation:other',
    threadId: 'thread:requests',
    turnId: 'turn:requests'
  })
  emitAgentEvent({
    type: 'approval.resolved',
    requestId: 'elicitation:active',
    threadId: 'thread:requests',
    turnId: 'turn:requests'
  })
  assert.equal(bridge.getState(), waitingElicitation)
  assert.equal(bridge.getState().activity.elicitation.requestId, 'elicitation:active')

  emitAgentEvent({ type: 'elicitation.resolved', requestId: 'elicitation:active' })
  assert.equal(bridge.getState().activity.phase, 'running')
  assert.equal(bridge.getState().activity.elicitation, null)
  assert.deepEqual(eventTypes, [
    'task.started',
    'task.accepted',
    'approval.requested',
    'approval.resolved',
    'elicitation.requested',
    'elicitation.resolved'
  ])
})

test('AgentBridge exposes failures without swallowing the host error', async () => {
  const expectedError = new Error('Host rejected task.')
  const bridge = createAgentBridge({
    getCapabilities: () => ({ available: true, provider: 'test', sendTask: true }),
    sendTask: async () => { throw expectedError }
  }, { taskIdFactory: () => 'task:failed' })

  await assert.rejects(() => bridge.sendTask('fail'), expectedError)
  assert.equal(bridge.getState().status, 'error')
  assert.deepEqual(bridge.getState().lastTask.error, {
    name: 'Error',
    message: 'Host rejected task.'
  })
  assert.equal(bridge.getState().lastEvent.type, 'task.failed')
})

test('AgentBridge refreshes availability when the host announces new globals', () => {
  const windowObject = eventWindow()
  const adapter = createCodexHostAgentAdapter(windowObject)
  const bridge = createAgentBridge(adapter)
  const events = []
  bridge.subscribe((_state, event) => events.push(event.type))

  assert.equal(bridge.getState().status, 'unavailable')
  windowObject.openai = {
    sendFollowUpMessage: async () => ({ ok: true }),
    hostCapabilities: { message: { image: true } }
  }
  windowObject.dispatch('openai:set_globals')

  assert.equal(bridge.getState().status, 'idle')
  assert.equal(bridge.capabilities.provider, 'openai')
  assert.equal(bridge.capabilities.message.image, true)
  assert.deepEqual(events, ['capabilities.changed'])
})

test('AgentBridge reports pre-aborted tasks as cancelled without contacting the host', async () => {
  let sent = false
  const bridge = createAgentBridge({
    getCapabilities: () => ({ available: true, provider: 'test', sendTask: true }),
    sendTask: async () => { sent = true }
  }, { taskIdFactory: () => 'task:cancelled' })
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    () => bridge.sendTask('cancel', { signal: controller.signal }),
    (error) => error.name === 'AbortError'
  )
  assert.equal(sent, false)
  assert.equal(bridge.getState().status, 'idle')
  assert.equal(bridge.getState().lastTask.status, 'cancelled')
})

test('async preload capabilities update the live bridge after resolution', async () => {
  let resolveCapabilities
  const capabilitiesReady = new Promise((resolve) => { resolveCapabilities = resolve })
  const windowObject = eventWindow({
    yogurtAgent: {
      sendTask: async () => ({ accepted: true }),
      getCapabilities: () => capabilitiesReady,
      respondApproval: async () => ({}),
      interrupt: async () => ({})
    }
  })
  const adapter = createCodexHostAgentAdapter(windowObject)
  const bridge = createAgentBridge(adapter)

  assert.equal(bridge.capabilities.streaming, false)
  assert.equal(bridge.capabilities.approvals, true)
  resolveCapabilities({ streaming: true, approvals: true, interrupt: true })
  await capabilitiesReady
  await Promise.resolve()

  assert.equal(bridge.capabilities.streaming, true)
  assert.equal(bridge.capabilities.approvals, true)
  assert.equal(bridge.capabilities.interrupt, true)
})
