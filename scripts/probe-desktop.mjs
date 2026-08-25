import path from 'node:path'

import { CodexAppServerClient } from '../desktop/codex-app-server-client.mjs'
import { createYogurtCodexArgs, resolveCodexLaunch } from '../desktop/runtime-config.mjs'

const repoRoot = process.cwd()
const projectDir = path.resolve(process.env.YOGURT_WORKSPACE_ROOT || repoRoot)
const canvasDir = path.join(projectDir, 'canvas')
const codexLaunch = resolveCodexLaunch()
const client = new CodexAppServerClient({
  command: codexLaunch.command,
  commandPrefixArgs: codexLaunch.commandPrefixArgs,
  args: createYogurtCodexArgs({
    repoRoot,
    nodeCommand: process.env.YOGURT_NODE_COMMAND || 'node'
  }),
  cwd: projectDir,
  clientInfo: {
    name: 'yogurt_ai_desktop_probe',
    title: 'Yogurt AI Desktop Probe',
    version: '0.1.0'
  }
})

let threadId = null
try {
  await client.start()
  const started = await client.startThread({
    cwd: projectDir,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    serviceName: 'yogurt_ai_desktop_probe'
  })
  threadId = started?.thread?.id
  if (!threadId) throw new Error('Desktop probe did not receive a Codex thread id.')

  const servers = await client.listMcpServers(threadId, {
    limit: 100,
    detail: 'toolsAndAuthOnly'
  })
  const yogurtServer = servers?.data?.find((server) => server?.name === 'cowart_thinking_mcp')
  if (!yogurtServer) throw new Error('Desktop probe could not find the bundled Yogurt MCP server.')

  const canvas = await client.callMcpServerTool(
    threadId,
    'cowart_thinking_mcp',
    'get_cowart_canvas_state',
    { projectDir, canvasDir, hydrateAssets: false }
  )

  console.log(JSON.stringify({
    ok: true,
    transport: 'stdio',
    threadId,
    cowartMcp: yogurtServer.name,
    canvasToolReturned: Boolean(canvas)
  }, null, 2))
} finally {
  if (threadId) {
    try {
      await client.request('thread/archive', { threadId }, { timeoutMs: 3_000 })
    } catch (_error) {
      // The probe result remains useful even when cleanup is unavailable.
    }
  }
  await client.dispose()
}
