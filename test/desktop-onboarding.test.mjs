import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { YogurtDesktopRuntime } from '../desktop/ipc-bridge.mjs'

test('desktop runtime remains usable when first-run workspace selection is cancelled', async (context) => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'yogurt-onboarding-'))
  context.after(() => rm(projectDir, { recursive: true, force: true }))
  const runtime = new YogurtDesktopRuntime({
    configuredWorkspace: false,
    projectDir,
    workspaceSource: 'none'
  })

  const state = runtime.getState()
  assert.equal(state.status, 'workspace-required')
  assert.equal(state.setup.workspace.status, 'required')
  assert.equal(state.capabilities.available, false)
  assert.equal(state.capabilities.security.arbitraryRpc, false)
  await assert.rejects(() => runtime.sendTask('create a PRD'), /先选择一个工作区/)

  const canvas = await runtime.callCowartTool({
    name: 'get_cowart_canvas_state',
    arguments: { projectDir: 'C:\\escape', canvasDir: 'C:\\escape\\canvas' }
  })
  assert.equal(canvas.structuredContent.projectDir, projectDir)
  assert.equal(canvas.structuredContent.snapshot, null)
})

test('desktop runtime exposes actionable Codex installation guidance without a shell bridge', () => {
  const error = new Error('Yogurt AI Desktop could not find Codex.')
  error.code = 'CODEX_CLI_NOT_FOUND'
  const runtime = new YogurtDesktopRuntime({
    configuredWorkspace: true,
    projectDir: path.resolve('C:\workspace'),
    workspaceSource: 'settings',
    agentStartError: error
  })

  const capabilities = runtime.getCapabilities()
  assert.equal(capabilities.available, false)
  assert.equal(capabilities.setup.codex.status, 'missing')
  assert.equal(capabilities.setup.codex.command, 'npm install -g @openai/codex')
  assert.equal(capabilities.security.arbitraryShell, false)
})

test('desktop runtime forwards analytics to the ready MCP bridge instead of swallowing it locally', async () => {
  const calls = []
  const agentService = new EventEmitter()
  agentService.getState = () => ({ status: 'ready' })
  agentService.getCapabilities = () => ({ available: true })
  agentService.callCowartTool = async (request) => {
    calls.push(request)
    return { structuredContent: { delivered: true } }
  }

  const runtime = new YogurtDesktopRuntime({
    agentService,
    configuredWorkspace: true,
    projectDir: path.resolve('C:/workspace'),
    workspaceSource: 'settings'
  })
  const request = {
    name: 'track_cowart_analytics_event',
    arguments: { clientId: '123.456', eventName: 'canvas_opened' }
  }

  const result = await runtime.callCowartTool(request)

  assert.deepEqual(calls, [request])
  assert.equal(result.structuredContent.delivered, true)
})
