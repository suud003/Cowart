import assert from 'node:assert/strict'
import test from 'node:test'

import { createServer } from 'vite'

let buildAgentPanelMessage
let approvalStatusForRequest
let connectionPresentation
let taskStatusPresentation
let viteServer

test.before(async () => {
  viteServer = await createServer({
    root: process.cwd(),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  })
  ;({
    buildAgentPanelMessage,
    approvalStatusForRequest,
    connectionPresentation,
    taskStatusPresentation
  } = await viteServer.ssrLoadModule('/src/AgentPanel.jsx'))
})

test.after(async () => {
  await viteServer?.close()
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

  assert.equal(typeof message.prompt, 'string')
  assert.match(message.prompt, /page:story-map/)
  assert.match(message.prompt, /shape:brief/)
  assert.match(message.prompt, /shape:ending/)
  assert.match(message.prompt, /不要依赖截图坐标/)
  assert.match(message.prompt, /当前选中的 2 个对象/)
})

test('Agent panel bounds structured shape context to 250 IDs', () => {
  const shapeIds = Array.from({ length: 251 }, (_, index) => `shape:${index + 1}`)
  const message = buildAgentPanelMessage('整理选区', {
    pageId: 'page:one',
    selectedCount: shapeIds.length,
    selectedShapeIds: shapeIds,
    exactShapeIds: shapeIds
  })

  assert.match(message.prompt, /"shapeIdsTruncated": true/)
  assert.match(message.prompt, /shape:250/)
  assert.doesNotMatch(message.prompt, /shape:251/)
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
