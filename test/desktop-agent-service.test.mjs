import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'

import {
  approvalsReviewerForExecutionMode,
  executionModeEnvelope,
  taskExecutionMode,
  YOGURT_DESKTOP_CAPABILITY_CONTRACT,
  YogurtAgentService
} from '../desktop/agent-service.mjs'
import {
  IPC_CHANNELS,
  YogurtDesktopRuntime,
  normalizeCodexLoginUrl,
  registerYogurtAgentIpc
} from '../desktop/ipc-bridge.mjs'

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

  async startTurn(threadId, input, overrides = {}) {
    this.calls.push(['startTurn', threadId, input, overrides])
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

  async respondToElicitation(requestId, response) {
    this.calls.push(['respondToElicitation', requestId, response])
    return { requestId, action: response.action }
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

class FakeAuthCodexClient extends FakeCodexClient {
  constructor({
    account = null,
    authUrl = 'https://auth.openai.com/codex/authorize'
  } = {}) {
    super()
    this.accountResult = { account, requiresOpenaiAuth: true }
    this.authUrl = authUrl
  }

  async readAccount(params) {
    this.calls.push(['readAccount', params])
    return this.accountResult
  }

  async startChatgptLogin(params) {
    this.calls.push(['startChatgptLogin', params])
    return {
      type: 'chatgpt',
      loginId: 'login_1',
      authUrl: this.authUrl
    }
  }

  async cancelLogin(loginId) {
    this.calls.push(['cancelLogin', loginId])
    return {}
  }
}

function standardElicitationParams(overrides = {}) {
  return {
    mode: 'form',
    message: 'Complete the interaction-game brief.',
    serverName: 'map-systems',
    threadId: 'thr_1',
    turnId: 'turn_1',
    requestedSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', title: 'Project title', minLength: 3 },
        focus: {
          type: 'string',
          oneOf: [
            { const: 'story', title: 'Story' },
            { const: 'battle', title: 'Battle' }
          ]
        },
        systems: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['dialogue', 'combat', 'economy']
          },
          minItems: 1,
          maxItems: 2
        }
      },
      required: ['title', 'focus', 'systems']
    },
    ...overrides
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

test('YogurtAgentService sends execution guidance as hidden application context and overrides approval policy per turn', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })

  assert.equal(taskExecutionMode({ executionMode: 'autonomous' }), 'autonomous')
  assert.equal(taskExecutionMode({ executionMode: 'invalid' }), 'guided')
  assert.equal(taskExecutionMode('plain task'), 'guided')
  assert.equal(approvalsReviewerForExecutionMode('autonomous'), 'auto_review')
  assert.equal(approvalsReviewerForExecutionMode('guided'), 'user')
  assert.match(executionModeEnvelope('autonomous'), /non-interactive execution/)
  assert.match(executionModeEnvelope('autonomous'), /approvalsReviewer=auto_review/)
  assert.match(executionModeEnvelope('autonomous'), /native-diagram dry-run/)
  assert.match(executionModeEnvelope('guided'), /native editable-diagram/)
  assert.doesNotMatch(executionModeEnvelope('guided'), /cowart-auto-compose|composition reference|fan-out/)

  await service.sendTask({
    prompt: 'Compose this page.',
    runtimeContext: 'Project: Yogurt AI\nSelected page: Page 1',
    executionMode: 'autonomous'
  })
  const startTurnCall = client.calls.find(([name]) => name === 'startTurn')
  assert.equal(startTurnCall[2], 'Compose this page.')
  assert.equal(startTurnCall[3].approvalPolicy, 'on-request')
  assert.equal(startTurnCall[3].approvalsReviewer, 'auto_review')
  assert.deepEqual(Object.keys(startTurnCall[3].additionalContext), ['yogurt_ai_canvas'])
  assert.equal(startTurnCall[3].additionalContext.yogurt_ai_canvas.kind, 'application')
  assert.match(
    startTurnCall[3].additionalContext.yogurt_ai_canvas.value,
    /^\[Yogurt AI execution mode: autonomous\]/
  )
  assert.match(startTurnCall[3].additionalContext.yogurt_ai_canvas.value, /Selected page: Page 1/)
  assert.match(
    startTurnCall[3].additionalContext.yogurt_ai_canvas.value,
    /Do not quote, reproduce, or summarize quick-task templates/
  )
  assert.equal(
    startTurnCall[3].additionalContext.yogurt_ai_canvas.value.includes('Compose this page.'),
    false
  )
  const startThreadCall = client.calls.find(([name]) => name === 'startThread')
  assert.equal(startThreadCall[1].approvalPolicy, 'on-request')
  assert.equal(startThreadCall[1].sandbox, 'workspace-write')

  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } }
  })
  await service.sendTask({ prompt: 'Continue.', executionMode: 'unexpected' })
  const guidedTurnCall = client.calls.filter(([name]) => name === 'startTurn').at(-1)
  assert.equal(guidedTurnCall[2], 'Continue.')
  assert.equal(guidedTurnCall[3].approvalPolicy, 'on-request')
  assert.equal(guidedTurnCall[3].approvalsReviewer, 'user')
  assert.equal(guidedTurnCall[3].additionalContext.yogurt_ai_canvas.kind, 'application')
  assert.match(
    guidedTurnCall[3].additionalContext.yogurt_ai_canvas.value,
    /^\[Yogurt AI execution mode: guided\]/
  )
})

test('autonomous canvas execution declines protected approvals and cancels MCP elicitations without surfacing a prompt', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  const events = []
  service.on('event', (event) => events.push(event))
  await service.sendTask({ prompt: 'Compose this page.', executionMode: 'autonomous' })

  client.emit('serverRequest', {
    requestId: 'autonomous-command',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item:command', reason: 'Run a command' }
  })
  client.emit('serverRequest', {
    requestId: 'autonomous-file',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item:file', reason: 'Change a file' }
  })
  client.emit('serverRequest', {
    requestId: 'autonomous-form',
    method: 'mcpServer/elicitation/request',
    params: standardElicitationParams()
  })
  await new Promise((resolve) => setImmediate(resolve))

  for (const requestId of ['autonomous-command', 'autonomous-file', 'autonomous-form']) {
    client.emit('notification', {
      method: 'serverRequest/resolved',
      params: { threadId: 'thr_1', requestId }
    })
  }

  assert.equal(
    events.some(({ type }) => type.startsWith('approval.') || type.startsWith('elicitation.')),
    false
  )
  assert.deepEqual(
    client.calls.filter(([name]) => name === 'respondToApproval'),
    [
      ['respondToApproval', 'autonomous-command', 'decline'],
      ['respondToApproval', 'autonomous-file', 'decline']
    ]
  )
  assert.deepEqual(
    client.calls.find(([name]) => name === 'respondToElicitation'),
    ['respondToElicitation', 'autonomous-form', { action: 'cancel', content: null }]
  )
  assert.equal(service.getState().pendingElicitations, 0)
})

test('a stale turn completion does not disable autonomous request handling for the active turn', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  const events = []
  service.on('event', (event) => events.push(event))
  await service.sendTask({ prompt: 'Compose this page.', executionMode: 'autonomous' })

  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thr_old', turn: { id: 'turn_old', status: 'completed' } }
  })
  client.emit('serverRequest', {
    requestId: 'active-command-after-stale-completion',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item:command', reason: 'Run a command' }
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(
    client.calls.find((call) => call[0] === 'respondToApproval'),
    ['respondToApproval', 'active-command-after-stale-completion', 'decline']
  )
  assert.equal(events.some(({ type }) => type === 'approval.requested'), false)
  assert.equal(service.getState().turnId, 'turn_1')
})

test('guided canvas execution continues to surface protected approvals and MCP elicitations', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  const events = []
  service.on('event', (event) => events.push(event))
  await service.sendTask({ prompt: 'Compose this page.', executionMode: 'guided' })

  client.emit('serverRequest', {
    requestId: 'guided-command',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item:command', reason: 'Run a command' }
  })
  client.emit('serverRequest', {
    requestId: 'guided-file',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item:file', reason: 'Change a file' }
  })
  client.emit('serverRequest', {
    requestId: 'guided-form',
    method: 'mcpServer/elicitation/request',
    params: standardElicitationParams()
  })

  assert.deepEqual(
    events.filter(({ type }) => type === 'approval.requested').map(({ requestId }) => requestId),
    ['guided-command', 'guided-file']
  )
  assert.equal(
    events.some(({ type, requestId }) => type === 'elicitation.requested' && requestId === 'guided-form'),
    true
  )
  assert.equal(client.calls.some(([name]) => name === 'respondToApproval'), false)
  assert.equal(client.calls.some(([name]) => name === 'respondToElicitation'), false)
  assert.equal(service.getState().pendingElicitations, 1)
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

test('YogurtAgentService waits for managed ChatGPT login and connects after completion', async () => {
  const client = new FakeAuthCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })

  await service.start()
  assert.equal(service.getState().status, 'auth-required')
  assert.equal(service.getState().auth.status, 'login-required')
  assert.equal(client.calls.some(([name]) => name === 'startThread'), false)
  const runtime = new YogurtDesktopRuntime({
    agentService: service,
    configuredWorkspace: true,
    projectDir: 'C:\\workspace'
  })
  assert.equal(runtime.getSetup().codex.status, 'login-required')
  assert.equal(runtime.getSetup().codex.canLogin, true)

  const login = await service.startChatgptLogin()
  assert.equal(runtime.getSetup().codex.status, 'login-pending')
  assert.equal(login.authUrl, 'https://auth.openai.com/codex/authorize')
  assert.equal(service.getState().status, 'authenticating')
  assert.equal(service.getState().login.status, 'waiting')
  assert.equal(JSON.stringify(service.getState()).includes(login.authUrl), false)

  client.accountResult = {
    account: { type: 'chatgpt', email: 'private@example.com', planType: 'plus' },
    requiresOpenaiAuth: true
  }
  const ready = new Promise((resolve) => {
    service.on('event', (event) => {
      if (event.type === 'state.changed' && event.state?.status === 'ready') resolve(event)
    })
  })
  client.emit('notification', {
    method: 'account/login/completed',
    params: { loginId: 'login_1', success: true, error: null }
  })
  await ready

  assert.equal(service.getState().status, 'ready')
  assert.equal(service.getState().auth.authMode, 'chatgpt')
  assert.equal(client.calls.some(([name]) => name === 'startThread'), true)
  assert.equal(JSON.stringify(service.getState()).includes('private@example.com'), false)
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
    params: { threadId: 'thr_1', turnId: 'turn_1', error: { message: 'Reconnecting... 5/5' }, willRetry: true }
  })
  client.emit('notification', {
    method: 'warning',
    params: { threadId: 'thr_1', message: 'Falling back from WebSockets to HTTPS transport.' }
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
    'turn.retrying',
    'turn.warning',
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

test('retryable response-stream errors remain non-terminal until the authoritative completion', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  const events = []
  service.on('event', (event) => events.push(event))
  await service.sendTask({ prompt: 'Keep working.', executionMode: 'autonomous' })

  client.emit('notification', {
    method: 'error',
    params: {
      threadId: 'thr_1',
      turnId: 'turn_1',
      error: { message: 'Reconnecting... 5/5' },
      willRetry: true
    }
  })

  assert.equal(service.getState().turnId, 'turn_1')
  assert.equal(events.at(-1).type, 'turn.retrying')
  assert.equal(events.at(-1).willRetry, true)

  client.emit('notification', {
    method: 'warning',
    params: { threadId: 'thr_1', message: 'Falling back from WebSockets to HTTPS transport.' }
  })
  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } }
  })

  assert.equal(service.getState().turnId, null)
  assert.deepEqual(
    events.map((event) => event.type).filter((type) => type.startsWith('turn.')),
    ['turn.retrying', 'turn.warning', 'turn.completed']
  )
})

test('YogurtAgentService publishes standard MCP forms and validates the structured reply', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  await service.start()
  const events = []
  service.on('event', (event) => events.push(event))

  client.emit('serverRequest', {
    requestId: 'elicitation-form-1',
    method: 'mcpServer/elicitation/request',
    params: standardElicitationParams()
  })

  const requested = events.find((event) => event.type === 'elicitation.requested')
  assert.equal(requested.requestId, 'elicitation-form-1')
  assert.equal(requested.mode, 'form')
  assert.equal(requested.serverName, 'map-systems')
  assert.deepEqual(requested.requestedSchema.required, ['title', 'focus', 'systems'])
  assert.equal(service.getState().pendingElicitations, 1)

  await assert.rejects(
    service.respondElicitation('elicitation-form-1', {
      action: 'accept',
      content: { title: 'Echo Labyrinth', focus: 'unknown', systems: ['dialogue'] }
    }),
    /focus is not an allowed option/
  )
  await service.respondElicitation('elicitation-form-1', {
    action: 'accept',
    content: {
      title: 'Echo Labyrinth',
      focus: 'story',
      systems: ['dialogue', 'combat']
    }
  })
  const responseCall = client.calls.find(([name]) => name === 'respondToElicitation')
  assert.deepEqual(responseCall, [
    'respondToElicitation',
    'elicitation-form-1',
    {
      action: 'accept',
      content: {
        title: 'Echo Labyrinth',
        focus: 'story',
        systems: ['dialogue', 'combat']
      }
    }
  ])
})

test('YogurtAgentService serializes concurrent elicitations so every request remains answerable', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  await service.start()
  const events = []
  service.on('event', (event) => events.push(event))

  for (const requestId of ['elicitation-queue-1', 'elicitation-queue-2']) {
    client.emit('serverRequest', {
      requestId,
      method: 'mcpServer/elicitation/request',
      params: standardElicitationParams({ message: `Complete ${requestId}.` })
    })
  }

  assert.deepEqual(
    events.filter((event) => event.type === 'elicitation.requested').map((event) => event.requestId),
    ['elicitation-queue-1']
  )
  assert.equal(service.getState().pendingElicitations, 2)
  assert.deepEqual(
    service.getState().pendingElicitationRequests.map((request) => request.requestId),
    ['elicitation-queue-1']
  )
  assert.equal(service.getPendingElicitation('elicitation-queue-2'), null)

  client.emit('notification', {
    method: 'serverRequest/resolved',
    params: { threadId: 'thr_1', requestId: 'elicitation-queue-1' }
  })

  assert.deepEqual(
    events.filter((event) => event.type === 'elicitation.requested').map((event) => event.requestId),
    ['elicitation-queue-1', 'elicitation-queue-2']
  )
  assert.equal(service.getPendingElicitation('elicitation-queue-2').requestId, 'elicitation-queue-2')
})

test('YogurtAgentService hides raw URL elicitations and resolves them as elicitations', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  await service.start()
  const events = []
  service.on('event', (event) => events.push(event))

  const rawUrl = 'https://accounts.example.com/authorize?state=private-secret'
  client.emit('serverRequest', {
    requestId: 'elicitation-url-1',
    method: 'mcpServer/elicitation/request',
    params: {
      mode: 'url',
      message: 'Authorize map-systems.',
      url: rawUrl,
      elicitationId: 'external-flow-1',
      serverName: 'map-systems',
      threadId: 'thr_1',
      turnId: 'turn_1'
    }
  })

  const requested = events.find((event) => event.type === 'elicitation.requested')
  assert.equal(requested.mode, 'url')
  assert.equal(requested.urlHost, 'accounts.example.com')
  assert.equal(Object.prototype.hasOwnProperty.call(requested, 'url'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(requested, 'externalUrl'), false)
  assert.equal(JSON.stringify(requested).includes('private-secret'), false)
  assert.equal(JSON.stringify(service.getState()).includes('private-secret'), false)
  assert.equal(service.getPendingElicitation('elicitation-url-1').externalUrl, rawUrl)

  client.emit('notification', {
    method: 'serverRequest/resolved',
    params: { threadId: 'thr_1', requestId: 'elicitation-url-1' }
  })
  assert.equal(events.some((event) =>
    event.type === 'elicitation.resolved' && event.requestId === 'elicitation-url-1'
  ), true)
  assert.equal(events.some((event) =>
    event.type === 'approval.resolved' && event.requestId === 'elicitation-url-1'
  ), false)
  assert.equal(service.getState().pendingElicitations, 0)
})

test('YogurtAgentService rejects host-specific openai/form requests when not opted in', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  await service.start()
  const events = []
  service.on('event', (event) => events.push(event))

  client.emit('serverRequest', {
    requestId: 'openai-form-1',
    method: 'mcpServer/elicitation/request',
    params: standardElicitationParams({ mode: 'openai/form' })
  })
  await Promise.resolve()

  const rejection = client.calls.find(
    ([name, requestId]) => name === 'rejectServerRequest' && requestId === 'openai-form-1'
  )
  assert.equal(rejection[2].code, -32602)
  assert.match(rejection[2].message, /has not opted in to openai\/form/)
  assert.equal(events.some((event) =>
    event.type === 'elicitation.requested' && event.requestId === 'openai-form-1'
  ), false)
  assert.equal(events.some((event) =>
    event.type === 'error' && event.requestId === 'openai-form-1'
  ), true)
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

test('autonomous execution rejects unsupported interaction requests without terminalizing the turn', async () => {
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  const events = []
  service.on('event', (event) => events.push(event))
  await service.sendTask({ prompt: 'Continue without blocking.', executionMode: 'autonomous' })

  client.emit('serverRequest', {
    requestId: 'tool-input-1',
    method: 'item/tool/requestUserInput',
    params: { threadId: 'thr_1', turnId: 'turn_1' }
  })
  await Promise.resolve()

  assert.equal(events.some((event) => event.type === 'error'), false)
  const warning = events.find((event) => event.type === 'turn.warning')
  assert.equal(warning.requestId, 'tool-input-1')
  assert.equal(warning.turnId, 'turn_1')
  const rejection = client.calls.find(
    ([name, requestId]) => name === 'rejectServerRequest' && requestId === 'tool-input-1'
  )
  assert.equal(rejection[2].code, -32601)
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
  assert.equal(YOGURT_DESKTOP_CAPABILITY_CONTRACT.eventTypes.includes('turn.retrying'), true)
  assert.equal(YOGURT_DESKTOP_CAPABILITY_CONTRACT.eventTypes.includes('turn.warning'), true)
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
  let workspaceSelectionCount = 0
  const cleanup = registerYogurtAgentIpc({
    ipcMain,
    agentService: service,
    getTrustedWebContents: () => trusted,
    selectWorkspace: async () => {
      workspaceSelectionCount += 1
      return { selected: false, restarting: false }
    }
  })

  assert.deepEqual(new Set(handlers.keys()), new Set([
    IPC_CHANNELS.getState,
    IPC_CHANNELS.refreshCapabilities,
    IPC_CHANNELS.selectWorkspace,
    IPC_CHANNELS.startCodexLogin,
    IPC_CHANNELS.sendTask,
    IPC_CHANNELS.respondApproval,
    IPC_CHANNELS.respondElicitation,
    IPC_CHANNELS.interrupt,
    IPC_CHANNELS.callCowartTool
  ]))
  await assert.rejects(
    handlers.get(IPC_CHANNELS.getState)({ sender: { id: 2 } }),
    /untrusted renderer/
  )
  assert.equal((await handlers.get(IPC_CHANNELS.getState)({ sender: trusted })).projectDir, service.projectDir)
  assert.deepEqual(
    await handlers.get(IPC_CHANNELS.selectWorkspace)({ sender: trusted }),
    { selected: false, restarting: false }
  )
  assert.equal(workspaceSelectionCount, 1)
  cleanup()
  assert.equal(handlers.size, 0)
})

test('elicitation IPC opens only an accepted main-process pending HTTPS URL', async () => {
  const handlers = new Map()
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler) },
    removeHandler(channel) { handlers.delete(channel) },
    on() {},
    removeListener() {}
  }
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  await service.start()
  const trusted = { id: 1, send() {}, isDestroyed: () => false }
  const openedUrls = []
  const cleanup = registerYogurtAgentIpc({
    ipcMain,
    agentService: service,
    getTrustedWebContents: () => trusted,
    openExternal: async (url) => openedUrls.push(url)
  })
  const handler = handlers.get(IPC_CHANNELS.respondElicitation)

  client.emit('serverRequest', {
    requestId: 'url-decline-1',
    method: 'mcpServer/elicitation/request',
    params: {
      mode: 'url',
      message: 'Authorize map-systems.',
      url: 'https://accounts.example.com/declined?state=server-owned',
      elicitationId: 'external-decline-1',
      serverName: 'map-systems',
      threadId: 'thr_1'
    }
  })
  await handler(
    { sender: trusted },
    {
      requestId: 'url-decline-1',
      action: 'decline',
      content: null,
      url: 'https://attacker.example/renderer-controlled'
    }
  )
  assert.deepEqual(openedUrls, [])
  client.emit('notification', {
    method: 'serverRequest/resolved',
    params: { threadId: 'thr_1', requestId: 'url-decline-1' }
  })

  const acceptedUrl = 'https://accounts.example.com/accepted?state=server-owned'
  client.emit('serverRequest', {
    requestId: 'url-accept-1',
    method: 'mcpServer/elicitation/request',
    params: {
      mode: 'url',
      message: 'Authorize map-systems.',
      url: acceptedUrl,
      elicitationId: 'external-accept-1',
      serverName: 'map-systems',
      threadId: 'thr_1'
    }
  })
  const result = await handler(
    { sender: trusted },
    {
      requestId: 'url-accept-1',
      action: 'accept',
      content: null,
      url: 'https://attacker.example/renderer-controlled'
    }
  )
  assert.deepEqual(openedUrls, [acceptedUrl])
  assert.deepEqual(result, {
    accepted: true,
    requestId: 'url-accept-1',
    action: 'accept'
  })
  const responseCall = client.calls.find(
    ([name, requestId]) => name === 'respondToElicitation' && requestId === 'url-accept-1'
  )
  assert.deepEqual(responseCall[2], { action: 'accept', content: null })

  client.emit('serverRequest', {
    requestId: 'url-foreign-1',
    method: 'mcpServer/elicitation/request',
    params: {
      mode: 'url',
      message: 'Authorize map-systems.',
      url: 'https://accounts.example.com/foreign',
      elicitationId: 'external-foreign-1',
      serverName: 'map-systems',
      threadId: 'thr_1'
    }
  })
  await assert.rejects(
    handler(
      { sender: { id: 2 } },
      { requestId: 'url-foreign-1', action: 'accept', content: null }
    ),
    /untrusted renderer/
  )
  assert.deepEqual(openedUrls, [acceptedUrl])

  client.emit('serverRequest', {
    requestId: 'url-malicious-1',
    method: 'mcpServer/elicitation/request',
    params: {
      mode: 'url',
      message: 'Authorize map-systems.',
      url: 'javascript:alert(1)',
      elicitationId: 'external-malicious-1',
      serverName: 'map-systems',
      threadId: 'thr_1'
    }
  })
  await Promise.resolve()
  const rejection = client.calls.find(
    ([name, requestId]) => name === 'rejectServerRequest' && requestId === 'url-malicious-1'
  )
  assert.equal(rejection[2].code, -32602)
  await assert.rejects(
    handler(
      { sender: trusted },
      { requestId: 'url-malicious-1', action: 'accept', content: null }
    ),
    /No pending MCP elicitation/
  )
  assert.deepEqual(openedUrls, [acceptedUrl])
  cleanup()
})

test('elicitation IPC never returns a secret authorization URL when the OS open fails', async () => {
  const handlers = new Map()
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler) },
    removeHandler(channel) { handlers.delete(channel) },
    on() {},
    removeListener() {}
  }
  const client = new FakeCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  await service.start()
  const runtime = new YogurtDesktopRuntime({
    agentService: service,
    configuredWorkspace: true,
    projectDir: 'C:\\workspace'
  })
  const trusted = { id: 1, send() {}, isDestroyed: () => false }
  const cleanup = registerYogurtAgentIpc({
    ipcMain,
    agentService: runtime,
    getTrustedWebContents: () => trusted,
    openExternal: async (url) => {
      throw new Error(`OS rejected ${url}`)
    }
  })
  const secretUrl = 'https://accounts.example.com/authorize?state=private-secret'
  client.emit('serverRequest', {
    requestId: 'url-open-failure',
    method: 'mcpServer/elicitation/request',
    params: {
      mode: 'url',
      message: 'Authorize map-systems.',
      url: secretUrl,
      elicitationId: 'external-open-failure',
      serverName: 'map-systems',
      threadId: 'thr_1'
    }
  })

  await assert.rejects(
    handlers.get(IPC_CHANNELS.respondElicitation)(
      { sender: trusted },
      { requestId: 'url-open-failure', action: 'accept', content: null }
    ),
    (error) => {
      assert.match(error.message, /accounts\.example\.com/)
      assert.equal(error.message.includes('private-secret'), false)
      assert.equal(error.message.includes(secretUrl), false)
      return true
    }
  )
  assert.equal(service.getState().pendingElicitations, 1)
  cleanup()
})

test('desktop login IPC opens only the App Server managed OpenAI URL and does not expose it', async () => {
  const handlers = new Map()
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler) },
    removeHandler(channel) { handlers.delete(channel) },
    on() {},
    removeListener() {}
  }
  const client = new FakeAuthCodexClient()
  const service = new YogurtAgentService({ client, projectDir: 'C:\\workspace' })
  const runtime = new YogurtDesktopRuntime({
    agentService: service,
    configuredWorkspace: true,
    projectDir: 'C:\\workspace'
  })
  const trusted = { id: 1, send() {}, isDestroyed: () => false }
  const openedUrls = []
  const cleanup = registerYogurtAgentIpc({
    ipcMain,
    agentService: runtime,
    getTrustedWebContents: () => trusted,
    openExternal: async (url) => openedUrls.push(url)
  })

  const result = await handlers.get(IPC_CHANNELS.startCodexLogin)(
    { sender: trusted },
    { authUrl: 'https://attacker.example/renderer-controlled' }
  )
  assert.deepEqual(openedUrls, ['https://auth.openai.com/codex/authorize'])
  assert.deepEqual(result, {
    started: true,
    alreadyAuthenticated: false,
    status: 'waiting',
    browserOpened: true
  })
  assert.equal('authUrl' in result, false)
  cleanup()
})

test('Codex login URL validation rejects non-HTTPS and non-OpenAI hosts', () => {
  assert.equal(normalizeCodexLoginUrl('https://openai.com/login'), 'https://openai.com/login')
  assert.equal(
    normalizeCodexLoginUrl('https://auth.openai.com/codex/authorize'),
    'https://auth.openai.com/codex/authorize'
  )
  assert.equal(
    normalizeCodexLoginUrl('https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost'),
    'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost'
  )
  assert.equal(
    normalizeCodexLoginUrl('https://auth.chatgpt.com/login'),
    'https://auth.chatgpt.com/login'
  )
  assert.throws(() => normalizeCodexLoginUrl('http://auth.openai.com/login'), /refused/)
  assert.throws(() => normalizeCodexLoginUrl('https://openai.com.attacker.example/login'), /refused/)
  assert.throws(() => normalizeCodexLoginUrl('https://user@chatgpt.com/login'), /refused/)
  assert.throws(() => normalizeCodexLoginUrl('https://auth.openai.com:444/login'), /refused/)
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
  assert.match(firstEvent.returnValue.toolOutput.projectScopeId, /^project:[0-9a-f]{24}$/)
  assert.equal(provisional, firstRenderer)

  trusted = firstRenderer
  provisional = null
  const foreignEvent = { sender: { id: 11 }, returnValue: null }
  bootstrap(foreignEvent)
  assert.match(foreignEvent.returnValue.error, /untrusted renderer/)
  cleanup()
})
