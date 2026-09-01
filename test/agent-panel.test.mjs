import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let CowartAgentPanel
let AGENT_ACTIVITY_MAX_ITEMS
let AGENT_CONVERSATION_MAX_TURNS
let agentExecutionInstructions
let agentExecutionModeScope
let agentExecutionModeStorageKey
let buildAgentPanelMessage
let buildAgentPanelTaskRequest
let buildElicitationContent
let claimAgentSubmission
let conversationTurnParts
let createAgentConversationState
let createElicitationInitialValues
let approvalStatusForRequest
let approvalCanRespond
let codexLoginButtonLabel
let connectionPresentation
let mergeAgentActivityItems
let normalizeActivityEvent
let normalizeAgentExecutionMode
let normalizeElicitationRequest
let persistAgentExecutionMode
let readAgentExecutionMode
let resolveAgentExecutionModeForTask
let reduceAgentConversation
let releaseAgentSubmission
let restoreAgentConversationState
let safeElicitationDomain
let taskStatusPresentation
let viteServer
let previousReactGlobal

test.before(async () => {
  previousReactGlobal = globalThis.React
  globalThis.React = React
  viteServer = await createServer({
    root: process.cwd(),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  })
  ;({
    AGENT_ACTIVITY_MAX_ITEMS,
    AGENT_CONVERSATION_MAX_TURNS,
    CowartAgentPanel,
    agentExecutionInstructions,
    agentExecutionModeScope,
    agentExecutionModeStorageKey,
    buildAgentPanelMessage,
    buildAgentPanelTaskRequest,
    buildElicitationContent,
    claimAgentSubmission,
    conversationTurnParts,
    createAgentConversationState,
    createElicitationInitialValues,
    approvalStatusForRequest,
    approvalCanRespond,
    codexLoginButtonLabel,
    connectionPresentation,
    mergeAgentActivityItems,
    normalizeActivityEvent,
    normalizeAgentExecutionMode,
    normalizeElicitationRequest,
    persistAgentExecutionMode,
    readAgentExecutionMode,
    resolveAgentExecutionModeForTask,
    reduceAgentConversation,
    releaseAgentSubmission,
    restoreAgentConversationState,
    safeElicitationDomain,
    taskStatusPresentation
  } = await viteServer.ssrLoadModule('/src/AgentPanel.jsx'))
})

test.after(async () => {
  await viteServer?.close()
  if (previousReactGlobal === undefined) delete globalThis.React
  else globalThis.React = previousReactGlobal
})

test('Agent panel tasks include stable page and selection IDs instead of screenshot coordinates', () => {
  const message = buildAgentPanelMessage('整理这些产品想法', {
    projectName: 'AI 互动影游',
    pageId: 'page:story-map',
    pageName: '故事地图',
    selectedCount: 2,
    selectedShapeIds: ['shape:brief', 'shape:choice'],
    exactShapeIds: ['shape:brief', 'shape:choice', 'shape:ending']
  })

  assert.equal(message.prompt, '整理这些产品想法')
  assert.equal(typeof message.runtimeContext, 'string')
  assert.doesNotMatch(message.prompt, /page:story-map|shape:brief|\$cowart-auto-compose/)
  assert.doesNotMatch(message.runtimeContext, /整理这些产品想法/)
  assert.match(message.runtimeContext, /page:story-map/)
  assert.match(message.runtimeContext, /shape:brief/)
  assert.match(message.runtimeContext, /shape:ending/)
  assert.match(message.runtimeContext, /不要依赖截图坐标/)
  assert.match(message.runtimeContext, /当前选中的 2 个对象/)
  assert.match(message.runtimeContext, /\$cowart-semantic-diagram/)
  assert.doesNotMatch(message.runtimeContext, /\$cowart-auto-compose/)
  assert.equal(message.executionMode, 'guided')
  assert.match(message.runtimeContext, /原生可编辑图/)
  assert.match(message.runtimeContext, /layoutEngine:"html-line-svg"/)
  assert.match(message.runtimeContext, /执行方式：分步确认/)
})

test('quick task presets stay in hidden application context instead of the persisted user prompt', () => {
  const preset = 'INTERNAL EDITABLE DIAGRAM PRESET: create a validated native graph.'
  const taskRequest = buildAgentPanelTaskRequest({
    id: 'editable-diagram',
    label: '生成可编辑图',
    prompt: preset
  }, '')
  const message = buildAgentPanelMessage(taskRequest.prompt, {
    projectName: 'AI 互动影游',
    pageId: 'page:story-map'
  }, {
    applicationTask: taskRequest.applicationTask
  })

  assert.equal(taskRequest.prompt, '执行“生成可编辑图”。')
  assert.deepEqual(taskRequest.invocation, { id: 'editable-diagram', label: '生成可编辑图' })
  assert.equal(message.prompt, '执行“生成可编辑图”。')
  assert.doesNotMatch(message.prompt, /INTERNAL EDITABLE DIAGRAM PRESET/)
  assert.match(message.runtimeContext, /INTERNAL EDITABLE DIAGRAM PRESET/)

  const supplemented = buildAgentPanelTaskRequest({
    id: 'editable-diagram',
    label: '生成可编辑图',
    prompt: preset
  }, '优先梳理玩家核心循环')
  assert.equal(supplemented.prompt, '优先梳理玩家核心循环')
  assert.equal(supplemented.userText, '优先梳理玩家核心循环')
  assert.equal(supplemented.applicationTask, preset)
})

test('Agent execution mode is fail-closed, project-scoped, and explicit in each task envelope', () => {
  const memory = new Map()
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value)
  }

  assert.equal(normalizeAgentExecutionMode(undefined), 'guided')
  assert.equal(normalizeAgentExecutionMode('invalid'), 'guided')
  assert.equal(readAgentExecutionMode(storage, 'Project A'), 'guided')
  assert.equal(agentExecutionModeStorageKey('Project A').includes('Project%20A'), true)
  persistAgentExecutionMode('autonomous', storage, 'Project A')
  assert.equal(readAgentExecutionMode(storage, 'Project A'), 'autonomous')
  assert.equal(readAgentExecutionMode(storage, 'Project B'), 'guided')
  assert.equal(agentExecutionModeScope({ projectScopeId: 'project:aaa', projectName: 'Same' }), 'project:aaa')
  assert.equal(resolveAgentExecutionModeForTask({
    currentMode: 'autonomous',
    currentProjectScope: 'project:aaa',
    taskContext: { projectScopeId: 'project:bbb', projectName: 'Same' },
    storage
  }), 'guided')

  const message = buildAgentPanelMessage('自动编排这个需求', {
    projectName: 'Project A',
    executionMode: readAgentExecutionMode(storage, 'Project A')
  })
  assert.equal(message.executionMode, 'autonomous')
  assert.equal(message.prompt, '自动编排这个需求')
  assert.doesNotMatch(message.prompt, /执行方式|工作区|审批/)
  assert.match(message.runtimeContext, /执行方式：自动执行/)
  assert.match(message.runtimeContext, /当前工作区内/)
  assert.match(message.runtimeContext, /不要请求交互式审批或表单/)
  assert.match(message.runtimeContext, /html-line-svg 布局验证/)
  assert.match(message.runtimeContext, /只生成原生可编辑卡片/)
  assert.doesNotMatch(message.runtimeContext, /图像预演|证据卡|整页视觉预演/)
  assert.match(agentExecutionInstructions('guided'), /直接完成原生可编辑图/)
  assert.match(agentExecutionInstructions('guided'), /不要生成视觉预演/)
})

test('Agent panel bounds structured shape context to 250 IDs', () => {
  const shapeIds = Array.from({ length: 251 }, (_, index) => `shape:${index + 1}`)
  const message = buildAgentPanelMessage('整理选区', {
    pageId: 'page:one',
    selectedCount: shapeIds.length,
    selectedShapeIds: shapeIds,
    exactShapeIds: shapeIds
  })

  assert.equal(message.prompt, '整理选区')
  assert.match(message.runtimeContext, /"shapeIdsTruncated": true/)
  assert.match(message.runtimeContext, /shape:250/)
  assert.doesNotMatch(message.runtimeContext, /shape:251/)
})

test('Agent panel approval state is isolated by request id', () => {
  const firstResolution = { requestId: 'approval:one', status: 'accept' }

  assert.equal(approvalStatusForRequest(firstResolution, 'approval:one'), 'accept')
  assert.equal(approvalStatusForRequest(firstResolution, 'approval:two'), 'idle')
  assert.equal(approvalStatusForRequest({ requestId: 0, status: 'sending' }, 0), 'sending')
})

test('Agent panel distinguishes accepted and completed task labels', () => {
  assert.equal(taskStatusPresentation('accepted').label, '已交给 Codex')
  assert.equal(taskStatusPresentation('succeeded').label, '已完成')
  assert.equal(taskStatusPresentation('completed').label, '已完成')
})

test('ordinary turn failures do not mark an available connection as broken', () => {
  assert.deepEqual(connectionPresentation({
    status: 'error',
    capabilities: { available: true },
    lastEvent: { type: 'turn.failed', payload: { source: 'turn' } }
  }), { label: '已连接', tone: 'connected' })

  assert.deepEqual(connectionPresentation({
    status: 'error',
    capabilities: { available: true },
    lastEvent: { type: 'turn.failed', payload: { source: 'sidecar' } }
  }), { label: '连接异常', tone: 'error' })
})

test('Agent panel presents desktop onboarding before generic connection state', () => {
  assert.deepEqual(connectionPresentation({
    status: 'unavailable',
    capabilities: {
      available: false,
      setup: { workspace: { status: 'required' }, codex: { status: 'waiting-for-workspace' } }
    }
  }), { label: '待设置', tone: 'offline' })

  assert.deepEqual(connectionPresentation({
    status: 'unavailable',
    capabilities: {
      available: false,
      setup: { workspace: { status: 'ready' }, codex: { status: 'login-required' } }
    }
  }), { label: '需配置', tone: 'offline' })

  assert.deepEqual(connectionPresentation({
    status: 'unavailable',
    capabilities: {
      available: false,
      setup: { workspace: { status: 'ready' }, codex: { status: 'login-pending' } }
    }
  }), { label: '连接中', tone: 'working' })

  assert.equal(codexLoginButtonLabel('login-required'), '登录 Codex')
  assert.equal(codexLoginButtonLabel('login-pending'), '重新打开登录页')
  assert.equal(codexLoginButtonLabel('login-pending', true), '正在打开…')
})

test('Agent panel exposes one focused editable-diagram task and hides unrelated generators', async () => {
  const state = {
    status: 'ready',
    capabilities: { available: true, provider: 'desktop' },
    pendingTaskIds: [],
    activity: { phase: 'idle' },
    lastTask: null,
    lastEvent: null
  }
  const markup = renderToStaticMarkup(React.createElement(CowartAgentPanel, {
    bridge: {
      getState: () => state,
      refreshCapabilities: () => state.capabilities
    },
    contextProvider: () => ({ projectName: 'Test', pageShapeCount: 0 }),
    isOpen: true,
    onOpenChange: () => {}
  }))
  const actionMenuSource = await readFile('src/ExcalidrawWorkspace.jsx', 'utf8')

  assert.match(markup, /生成可编辑图/)
  assert.match(markup, /Excalidraw 风格 · 节点和箭头都能改/)
  assert.match(markup, /描述结构，直接生成可编辑图/)
  assert.match(markup, /自动完成可编辑图/)
  assert.match(markup, /aria-pressed="false"/)
  assert.match(markup, /自动模式不弹审批；超出工作区、外部授权或敏感操作会停止并说明/)
  assert.doesNotMatch(markup, /智能编排|生成 PRD|整理选区|整页视觉预演/)
  assert.match(actionMenuSource, /生成可编辑图/)
  assert.doesNotMatch(actionMenuSource, /label: 'AI 图片'|label: 'AI HTML'|label: 'AI Slides'|label: '生成交互 PRD'/)
})

test('compact Agent panel exposes dialog semantics and a stable controlled id', () => {
  const state = {
    status: 'ready',
    capabilities: { available: true, provider: 'desktop' },
    pendingTaskIds: [],
    activity: { phase: 'idle' },
    lastTask: null,
    lastEvent: null
  }
  const markup = renderToStaticMarkup(React.createElement(CowartAgentPanel, {
    bridge: {
      getState: () => state,
      refreshCapabilities: () => state.capabilities
    },
    contextProvider: () => ({ projectName: 'Test', pageShapeCount: 0 }),
    isModal: true,
    isOpen: true,
    onOpenChange: () => {}
  }))

  assert.match(markup, /id="yogurt-codex-agent-panel"/)
  assert.match(markup, /role="dialog"/)
  assert.match(markup, /aria-modal="true"/)
})

test('Agent activity normalization preserves complete replies and line breaks', () => {
  const longReply = `${'第一段\n'.repeat(90)}最后一句 `
  const item = normalizeActivityEvent({
    type: 'agent.delta',
    at: '2026-08-26T10:00:00.000Z',
    turnId: 'turn:one',
    text: longReply
  })

  assert.equal(item.label, 'Codex Agent')
  assert.equal(item.metaLabel, '回复')
  assert.equal(item.text, longReply)
  assert.match(item.text, /最后一句 $/)
})

test('retry notifications are visible progress and do not terminalize the conversation', () => {
  const retryItem = normalizeActivityEvent({
    type: 'turn.retrying',
    at: '2026-08-29T12:08:00.000Z',
    turnId: 'turn:retry',
    text: 'Reconnecting... 5/5'
  })
  assert.equal(retryItem.kind, 'progress')
  assert.equal(retryItem.metaLabel, '重试中')

  let state = createAgentConversationState()
  state = reduceAgentConversation(state, {
    type: 'task.started',
    task: { id: 'task:retry', status: 'sending' },
    at: '2026-08-29T12:07:59.000Z'
  })
  state = reduceAgentConversation(state, {
    type: 'turn.retrying',
    taskId: 'task:retry',
    turnId: 'turn:retry',
    text: 'Reconnecting... 5/5',
    at: '2026-08-29T12:08:00.000Z'
  })
  assert.equal(state.turns[0].status, 'retrying')
  assert.equal(conversationTurnParts(state.turns[0]).errorText, '')

  state = reduceAgentConversation(state, {
    type: 'turn.completed',
    taskId: 'task:retry',
    turnId: 'turn:retry',
    at: '2026-08-29T12:10:00.000Z'
  })
  assert.equal(state.turns[0].status, 'completed')
})

test('Agent activity keeps complete card text while bounding retained card count', () => {
  let items = []
  for (let index = 0; index < AGENT_ACTIVITY_MAX_ITEMS + 2; index += 1) {
    items = mergeAgentActivityItems(items, {
      id: `item:${index}`,
      kind: 'complete',
      type: 'turn.completed',
      text: `完整内容 ${index}`
    })
  }

  assert.equal(items.length, AGENT_ACTIVITY_MAX_ITEMS)
  assert.equal(items[0].text, '完整内容 2')
  assert.equal(items.at(-1).text, `完整内容 ${AGENT_ACTIVITY_MAX_ITEMS + 1}`)

  const streamed = mergeAgentActivityItems([], {
    id: 'delta:one', type: 'agent.delta', turnId: 'turn:one', text: '前半段 '
  })
  const merged = mergeAgentActivityItems(streamed, {
    id: 'delta:two', type: 'agent.delta', turnId: 'turn:one', text: '后半段'
  })
  assert.equal(merged[0].text, '前半段 后半段')

  const first = normalizeActivityEvent({
    type: 'agent.delta',
    at: '2026-08-26T10:00:00.000Z',
    turnId: 'turn:collision',
    itemId: 'item:collision',
    text: '第一段'
  })
  const whitespace = normalizeActivityEvent({
    type: 'agent.delta',
    at: '2026-08-26T10:00:00.000Z',
    turnId: 'turn:collision',
    itemId: 'item:collision',
    text: '\n\n'
  })
  const final = normalizeActivityEvent({
    type: 'agent.delta',
    at: '2026-08-26T10:00:00.000Z',
    turnId: 'turn:collision',
    itemId: 'item:collision',
    text: '第二段'
  })
  const collisionSafe = [first, whitespace, final].reduce(mergeAgentActivityItems, [])
  assert.equal(collisionSafe.length, 1)
  assert.equal(collisionSafe[0].text, '第一段\n\n第二段')

  const separateItems = mergeAgentActivityItems([first], {
    ...final,
    id: 'agent.delta:item:second:2026-08-26T10:00:00.000Z',
    itemId: 'item:second'
  })
  assert.equal(separateItems.length, 2)
  assert.equal(separateItems[0].text, '第一段')
  assert.equal(separateItems[1].text, '第二段')

  const identifiedAfterLegacy = mergeAgentActivityItems(streamed, {
    id: 'delta:identified',
    type: 'agent.delta',
    turnId: 'turn:one',
    itemId: 'item:identified',
    text: '独立回复'
  })
  assert.equal(identifiedAfterLegacy.length, 2)

  const prefixLikeDelta = [
    { id: 'prefix:1', sourceEventId: 'source:1', type: 'agent.delta', turnId: 'turn:prefix', itemId: 'item:prefix', text: 'A' },
    { id: 'prefix:2', sourceEventId: 'source:2', type: 'agent.delta', turnId: 'turn:prefix', itemId: 'item:prefix', text: 'Apple' }
  ].reduce(mergeAgentActivityItems, [])
  assert.equal(prefixLikeDelta[0].text, 'AApple', 'delta chunks must append even when one begins with the previous text')

  const replayedEvent = mergeAgentActivityItems(prefixLikeDelta, {
    id: 'prefix:2',
    sourceEventId: 'source:2',
    type: 'agent.delta',
    turnId: 'turn:prefix',
    itemId: 'item:prefix',
    text: 'Apple'
  })
  assert.equal(replayedEvent[0].text, 'AApple', 'the same transported event must not be appended twice')

  const replayedEarlierEvent = mergeAgentActivityItems(prefixLikeDelta, {
    id: 'prefix:1',
    sourceEventId: 'source:1',
    type: 'agent.delta',
    turnId: 'turn:prefix',
    itemId: 'item:prefix',
    text: 'A'
  })
  assert.equal(replayedEarlierEvent[0].text, 'AApple', 'an earlier chunk replay must remain deduplicated after later chunks merge')
})

test('Agent conversation groups one task into a user turn, one complete reply, trace, and change summary', () => {
  const events = [
    {
      type: 'task.started',
      task: {
        id: 'task:one',
        status: 'sending',
        startedAt: '2026-08-26T10:00:00.000Z',
        metadata: { userText: '梳理这张玩法画布并找出缺口' }
      },
      at: '2026-08-26T10:00:00.000Z'
    },
    { type: 'turn.started', eventId: 'event:start', threadId: 'thread:one', turnId: 'turn:one', at: '2026-08-26T10:00:01.000Z' },
    { type: 'agent.delta', eventId: 'event:a', threadId: 'thread:one', turnId: 'turn:one', itemId: 'message:one', text: '我先确认玩法核心，', at: '2026-08-26T10:00:02.000Z' },
    { type: 'agent.delta', eventId: 'event:b', threadId: 'thread:one', turnId: 'turn:one', itemId: 'message:one', text: '再检查循环。', at: '2026-08-26T10:00:03.000Z' },
    { type: 'agent.delta', eventId: 'event:c', threadId: 'thread:one', turnId: 'turn:one', itemId: 'message:two', text: '结论：当前缺少失败后的回流路径。', at: '2026-08-26T10:00:04.000Z' },
    { type: 'agent.plan', eventId: 'event:plan-old', turnId: 'turn:one', plan: [{ step: '旧计划' }] },
    { type: 'agent.plan', eventId: 'event:plan-new', turnId: 'turn:one', plan: [{ step: '读取画布' }, { step: '补齐循环' }] },
    { type: 'agent.diff', eventId: 'event:diff-old', turnId: 'turn:one', diff: '旧变更' },
    { type: 'agent.diff', eventId: 'event:diff-new', turnId: 'turn:one', diff: '新增失败回流节点并连接核心循环' },
    { type: 'turn.completed', eventId: 'event:done', threadId: 'thread:one', turnId: 'turn:one', at: '2026-08-26T10:00:05.000Z' }
  ]
  const state = events.reduce(reduceAgentConversation, createAgentConversationState())
  const turn = state.turns[0]
  const parts = conversationTurnParts(turn)

  assert.equal(state.turns.length, 1)
  assert.equal(turn.userText, '梳理这张玩法画布并找出缺口')
  assert.equal(turn.status, 'completed')
  assert.equal(parts.assistantText, '我先确认玩法核心，再检查循环。\n\n结论：当前缺少失败后的回流路径。')
  assert.equal(parts.traceItems.length, 2, 'turn start and the latest plan remain in the trace')
  assert.match(parts.traceItems.at(-1).text, /读取画布 · 补齐循环/)
  assert.doesNotMatch(parts.traceItems.at(-1).text, /旧计划/)
  assert.equal(parts.changeText, '新增失败回流节点并连接核心循环')
})

test('Agent conversation hides ambiguous instructions and renders only explicit user presentation metadata', () => {
  const hiddenRuntimeInstruction = '内部预制指令：不要把这段文字显示给用户。'
  const hidden = reduceAgentConversation(createAgentConversationState(), {
    type: 'task.started',
    task: {
      id: 'task:hidden-runtime',
      metadata: { instruction: hiddenRuntimeInstruction }
    }
  })

  assert.equal(hidden.turns[0].userText, '')
  assert.equal(hidden.turns[0].invocation, null)

  const userText = '请保留我输入的 $cowart-auto-compose 字样'
  const presentationMetadata = {
    instruction: hiddenRuntimeInstruction,
    userText,
    invocation: { id: 'auto-compose', label: '智能编排' }
  }
  const visible = reduceAgentConversation(createAgentConversationState(), {
    type: 'task.started',
    task: { id: 'task:visible-presentation', metadata: presentationMetadata }
  })

  assert.equal(visible.turns[0].userText, userText)
  assert.deepEqual(visible.turns[0].invocation, { id: 'auto-compose', label: '智能编排' })

  const bridgeState = {
    status: 'sending',
    capabilities: { available: true, provider: 'desktop', streaming: true },
    pendingTaskIds: ['task:visible-presentation'],
    activity: { phase: 'running' },
    lastTask: {
      id: 'task:visible-presentation',
      status: 'accepted',
      startedAt: '2026-08-29T10:00:00.000Z',
      metadata: presentationMetadata
    },
    lastEvent: null
  }
  const markup = renderToStaticMarkup(React.createElement(CowartAgentPanel, {
    bridge: { getState: () => bridgeState },
    contextProvider: () => ({ projectName: 'Test', pageShapeCount: 0 }),
    isOpen: true,
    onOpenChange: () => {}
  }))

  assert.match(markup, /智能编排/)
  assert.match(markup, /请保留我输入的 \$cowart-auto-compose 字样/)
  assert.doesNotMatch(markup, /内部预制指令/)
})

test('Agent conversation shows a final reply carried only by turn completion', () => {
  let state = reduceAgentConversation(createAgentConversationState(), {
    type: 'task.started',
    task: { id: 'task:terminal-only', metadata: { userText: '给出最终结论' } }
  })
  state = reduceAgentConversation(state, {
    type: 'turn.completed',
    eventId: 'event:terminal-only',
    taskId: 'task:terminal-only',
    text: '最终结论：先验证核心循环，再扩展支线内容。'
  })
  assert.equal(
    conversationTurnParts(state.turns[0]).assistantText,
    '最终结论：先验证核心循环，再扩展支线内容。'
  )

  let defaultOnly = reduceAgentConversation(createAgentConversationState(), {
    type: 'task.started',
    task: { id: 'task:default-only', metadata: { userText: '执行任务' } }
  })
  defaultOnly = reduceAgentConversation(defaultOnly, {
    type: 'turn.completed',
    taskId: 'task:default-only'
  })
  assert.equal(conversationTurnParts(defaultOnly.turns[0]).assistantText, '')
})

test('Agent panel submission lock rejects a second pre-send claim until released', () => {
  const lock = { current: false }
  assert.equal(claimAgentSubmission(lock), true)
  assert.equal(claimAgentSubmission(lock), false)
  releaseAgentSubmission(lock)
  assert.equal(claimAgentSubmission(lock), true)
})

test('Agent conversation terminal states and blocking requests are monotonic and request-scoped', () => {
  let state = reduceAgentConversation(createAgentConversationState(), {
    type: 'task.started',
    task: { id: 'task:one', metadata: { userText: '检查风险' } }
  })
  state = reduceAgentConversation(state, { type: 'turn.started', turnId: 'turn:one' })
  state = reduceAgentConversation(state, {
    type: 'approval.requested',
    eventId: 'event:approval',
    turnId: 'turn:one',
    requestId: 'request:one',
    approval: { requestId: 'request:one' }
  })
  assert.equal(state.turns[0].status, 'waiting_approval')

  const wrongResolution = reduceAgentConversation(state, {
    type: 'approval.resolved',
    eventId: 'event:wrong',
    requestId: 'request:other'
  })
  assert.equal(wrongResolution, state)

  state = reduceAgentConversation(state, {
    type: 'approval.resolved',
    eventId: 'event:resolved',
    requestId: 'request:one'
  })
  assert.equal(state.turns[0].status, 'running')
  state = reduceAgentConversation(state, { type: 'turn.completed', eventId: 'event:done', turnId: 'turn:one' })
  const completed = state
  state = reduceAgentConversation(state, {
    type: 'agent.delta',
    eventId: 'event:late',
    turnId: 'turn:one',
    text: '不应出现的迟到回复'
  })
  assert.equal(state, completed)
  assert.equal(state.turns[0].status, 'completed')
  assert.doesNotMatch(conversationTurnParts(state.turns[0]).assistantText, /迟到回复/)

  state = reduceAgentConversation(state, {
    type: 'task.failed',
    task: { id: 'task:one', status: 'failed', error: { message: '迟到的传输错误' } }
  })
  assert.equal(state, completed)
  assert.equal(conversationTurnParts(state.turns[0]).errorText, '')
})

test('Agent conversation resolves a reused request id against the newest active turn', () => {
  let state = reduceAgentConversation(createAgentConversationState(), {
    type: 'task.started',
    task: { id: 'task:old', metadata: { userText: '旧任务' } }
  })
  state = reduceAgentConversation(state, {
    type: 'approval.requested',
    taskId: 'task:old',
    requestId: 'request:reused',
    approval: { requestId: 'request:reused' }
  })
  state = reduceAgentConversation(state, { type: 'turn.completed', taskId: 'task:old' })
  state = reduceAgentConversation(state, {
    type: 'task.started',
    task: { id: 'task:new', metadata: { userText: '新任务' } }
  })
  state = reduceAgentConversation(state, {
    type: 'approval.requested',
    taskId: 'task:new',
    requestId: 'request:reused',
    approval: { requestId: 'request:reused' }
  })
  state = reduceAgentConversation(state, {
    type: 'approval.resolved',
    requestId: 'request:reused'
  })

  assert.equal(state.turns[0].status, 'completed')
  assert.equal(state.turns[1].status, 'running')
})

test('Agent conversation retains the latest twenty completed turns', () => {
  let state = createAgentConversationState()
  for (let index = 0; index < AGENT_CONVERSATION_MAX_TURNS + 2; index += 1) {
    const taskId = `task:${index}`
    state = reduceAgentConversation(state, {
      type: 'task.started',
      task: { id: taskId, metadata: { userText: `任务 ${index}` } }
    })
    state = reduceAgentConversation(state, { type: 'turn.completed', taskId })
  }

  assert.equal(state.turns.length, AGENT_CONVERSATION_MAX_TURNS)
  assert.equal(state.turns[0].userText, '任务 2')
  assert.equal(state.turns.at(-1).userText, `任务 ${AGENT_CONVERSATION_MAX_TURNS + 1}`)
})

test('Agent conversation restores a reviewable turn and renders it as dialogue instead of an event feed', () => {
  const state = {
    status: 'sending',
    capabilities: { available: true, provider: 'desktop', streaming: true, interrupt: true },
    pendingTaskIds: ['task:restored'],
    activity: { phase: 'running' },
    lastTask: {
      id: 'task:restored',
      status: 'accepted',
      threadId: 'thread:restored',
      turnId: 'turn:restored',
      startedAt: '2026-08-26T10:00:00.000Z',
      metadata: { userText: '把战斗、构筑和地图风险整理成一个核心循环' }
    },
    lastEvent: {
      type: 'agent.delta',
      eventId: 'event:restored',
      threadId: 'thread:restored',
      turnId: 'turn:restored',
      itemId: 'message:restored',
      text: '我会保留现有结构，并补充失败回流。最后一句必须完整显示。'
    }
  }
  const restored = restoreAgentConversationState(state)
  const markup = renderToStaticMarkup(React.createElement(CowartAgentPanel, {
    bridge: {
      getState: () => state,
      refreshCapabilities: () => state.capabilities,
      interrupt: async () => ({ interrupted: true })
    },
    contextProvider: () => ({ pageName: '核心循环', pageShapeCount: 12 }),
    isOpen: true,
    onOpenChange: () => {}
  }))

  assert.equal(restored.turns.length, 1)
  assert.equal(restored.turns[0].userText, '把战斗、构筑和地图风险整理成一个核心循环')
  assert.match(markup, /把战斗、构筑和地图风险整理成一个核心循环/)
  assert.match(markup, /最后一句必须完整显示/)
  assert.match(markup, /正在执行/)
  assert.match(markup, /停止/)
  assert.doesNotMatch(markup, /最近任务|Agent 对话与进度|快捷任务/)
})

test('failed approval submissions remain actionable for retry', () => {
  assert.equal(approvalCanRespond('idle'), true)
  assert.equal(approvalCanRespond('error'), true)
  assert.equal(approvalCanRespond('sending'), false)
  assert.equal(approvalCanRespond('accept'), false)
  assert.equal(approvalCanRespond('decline'), false)
})

test('Agent conversation messages are not visually line-clamped', async () => {
  const styles = await readFile('src/styles.css', 'utf8')
  const messageRule = styles.match(/\.cowart-agent-message-content\s*\{([\s\S]*?)\}/)?.[1] || ''

  assert.match(messageRule, /white-space:\s*pre-wrap/)
  assert.match(messageRule, /overflow-wrap:\s*anywhere/)
  assert.doesNotMatch(messageRule, /line-clamp|overflow:\s*hidden/)
})

test('collapsed Agent launcher distinguishes unread replies from blocking requests', () => {
  const baseState = {
    status: 'sending',
    capabilities: { available: true, provider: 'desktop', streaming: true, elicitation: true },
    pendingTaskIds: [],
    lastTask: null
  }
  const unreadState = {
    ...baseState,
    activity: { phase: 'running' },
    lastEvent: { type: 'agent.delta', text: '有新结果' }
  }
  const unreadMarkup = renderToStaticMarkup(React.createElement(CowartAgentPanel, {
    bridge: { getState: () => unreadState, refreshCapabilities: () => unreadState.capabilities },
    contextProvider: () => ({}),
    isOpen: false,
    onOpenChange: () => {}
  }))
  const blockingState = {
    ...baseState,
    activity: {
      phase: 'waiting_elicitation',
      elicitation: {
        requestId: 'request:one',
        mode: 'form',
        requestedSchema: { type: 'object', properties: {} }
      }
    },
    lastEvent: { type: 'elicitation.requested', requestId: 'request:one' }
  }
  const blockingMarkup = renderToStaticMarkup(React.createElement(CowartAgentPanel, {
    bridge: { getState: () => blockingState, refreshCapabilities: () => blockingState.capabilities },
    contextProvider: () => ({}),
    isOpen: false,
    onOpenChange: () => {}
  }))

  assert.match(unreadMarkup, /data-attention="reply"/)
  assert.match(unreadMarkup, /有新回复/)
  assert.match(unreadMarkup, />新回复</)
  assert.match(blockingMarkup, /data-attention="blocking"/)
  assert.match(blockingMarkup, /有任务等待你的操作/)
  assert.match(blockingMarkup, />待处理</)
  assert.deepEqual(connectionPresentation(blockingState), { label: '等待你', tone: 'attention' })
})

test('elicitation forms preserve supported primitive and multi-select values', () => {
  const request = {
    mode: 'form',
    message: '补齐发布参数',
    requestedSchema: {
      type: 'object',
      required: ['title', 'audience', 'score'],
      properties: {
        title: {
          type: 'string',
          title: '标题',
          description: '用于画布卡片',
          minLength: 2,
          maxLength: 40,
          default: '杀戮尖塔'
        },
        contact: { type: 'string', title: '邮箱', format: 'email' },
        audience: {
          type: 'string',
          title: '受众',
          oneOf: [
            { const: 'core', title: '核心玩家' },
            { const: 'new', title: '新玩家' }
          ]
        },
        score: { type: 'integer', title: '优先级', minimum: 1, maximum: 5 },
        public: { type: 'boolean', title: '公开', default: true },
        platforms: {
          type: 'array',
          title: '平台',
          minItems: 1,
          maxItems: 2,
          items: {
            anyOf: [
              { const: 'pc', title: 'PC' },
              { const: 'mobile', title: '移动端' }
            ]
          }
        }
      }
    }
  }
  const model = normalizeElicitationRequest(request, 'request:form')
  const initial = createElicitationInitialValues(model)

  assert.equal(model.supported, true)
  assert.equal(model.fields.length, 6)
  assert.equal(initial.title, '杀戮尖塔')
  assert.equal(initial.public, true)
  const result = buildElicitationContent(model, {
    ...initial,
    audience: 'core',
    score: '4',
    platforms: ['pc', 'mobile']
  })
  assert.equal(result.valid, true)
  assert.deepEqual(result.content, {
    title: '杀戮尖塔',
    audience: 'core',
    score: 4,
    public: true,
    platforms: ['pc', 'mobile']
  })
})

test('optional boolean and multi-select fields can remain omitted', () => {
  const model = normalizeElicitationRequest({
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: {
        includeRisks: { type: 'boolean', title: '标记风险' },
        systems: {
          type: 'array',
          title: '覆盖系统',
          minItems: 1,
          items: { type: 'string', enum: ['core', 'combat'] }
        }
      }
    }
  })
  const initial = createElicitationInitialValues(model)
  const omitted = buildElicitationContent(model, initial)

  assert.equal(initial.includeRisks, undefined)
  assert.deepEqual(initial.systems, [])
  assert.equal(omitted.valid, true)
  assert.deepEqual(omitted.content, {})
  assert.deepEqual(
    buildElicitationContent(model, { includeRisks: false, systems: ['core'] }).content,
    { includeRisks: false, systems: ['core'] }
  )
})

test('unsupported elicitation fields fail closed instead of producing lossy content', () => {
  const model = normalizeElicitationRequest({
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: {
        nested: { type: 'object', title: '<img src=x onerror=alert(1)>' }
      }
    }
  })
  const result = buildElicitationContent(model, { nested: { unsafe: true } })

  assert.equal(model.supported, false)
  assert.match(model.unsupportedReasons[0], /暂不支持 object 类型/)
  assert.deepEqual(result, {
    valid: false,
    content: null,
    errors: ['此请求无法安全提交。']
  })
})

test('elicitation URL presentation exposes only safe HTTPS domains', () => {
  assert.equal(safeElicitationDomain('https://accounts.example.com/authorize?secret=one'), 'accounts.example.com')
  assert.equal(safeElicitationDomain('http://accounts.example.com/authorize'), '')
  assert.equal(safeElicitationDomain('javascript:alert(1)'), '')
  assert.equal(safeElicitationDomain('data:text/html,<script>alert(1)</script>'), '')

  const model = normalizeElicitationRequest({
    mode: 'url',
    urlHost: 'accounts.example.com',
    message: '<script>alert(1)</script>'
  }, 'request:url')
  assert.equal(model.supported, true)
  assert.equal(model.domain, 'accounts.example.com')
  assert.equal(model.message, '<script>alert(1)</script>')
  assert.equal(Object.hasOwn(model, 'url'), false)
})

test('elicitation content creation does not allow prototype pollution', () => {
  const request = JSON.parse('{"mode":"form","requestedSchema":{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string","title":"Safe"}}}}')
  const values = JSON.parse('{"__proto__":"kept as data"}')
  const result = buildElicitationContent(request, values)

  assert.equal(result.valid, true)
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(result.content, '__proto__'), true)
  assert.equal(result.content.__proto__, 'kept as data')
})

test('elicitation URL UI escapes server text and never exposes a renderer link', () => {
  const state = {
    status: 'sending',
    capabilities: {
      available: true,
      provider: 'desktop',
      sendTask: true,
      streaming: true,
      elicitation: true,
      message: { image: false }
    },
    pendingTaskIds: [],
    session: { threadId: 'thread:one', turnId: 'turn:one' },
    activity: {
      phase: 'waiting_elicitation',
      message: '',
      plan: null,
      diff: null,
      approval: null,
      elicitation: {
        requestId: 'request:url',
        mode: 'url',
        message: '<img src=x onerror=alert(1)>',
        urlHost: 'accounts.example.com'
      }
    },
    lastTask: null,
    lastEvent: { type: 'elicitation.requested', requestId: 'request:url' }
  }
  const markup = renderToStaticMarkup(React.createElement(CowartAgentPanel, {
    bridge: {
      getState: () => state,
      refreshCapabilities: () => state.capabilities,
      respondElicitation: async () => ({ delivered: true })
    },
    contextProvider: () => ({ projectName: 'Test', pageShapeCount: 0 }),
    isOpen: true,
    onOpenChange: () => {}
  }))

  assert.match(markup, /accounts\.example\.com/)
  assert.match(markup, /打开并继续/)
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(markup, /<img src=x/)
  assert.doesNotMatch(markup, /href=/)
})
