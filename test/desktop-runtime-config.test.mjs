import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { createYogurtCodexArgs, resolveCodexLaunch } from '../desktop/runtime-config.mjs'

test('desktop Codex args force local stdio and the bundled Yogurt MCP server', () => {
  const repoRoot = path.resolve('C:\\workspace\\Cowart')
  const args = createYogurtCodexArgs({ repoRoot, nodeCommand: 'node' })

  assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://'])
  assert.equal(args.includes('mcp_servers.cowart_thinking_mcp.command="node"'), true)
  assert.equal(
    args.some((arg) => arg.includes('mcp_servers.cowart_thinking_mcp.args=') && arg.includes('start-mcp.mjs')),
    true
  )
  assert.equal(args.includes('mcp_servers.cowart_thinking_mcp.enabled=true'), true)
  assert.equal(args.includes('mcp_servers.cowart_thinking_mcp.required=true'), true)
  assert.throws(() => createYogurtCodexArgs({ repoRoot: '' }), /repoRoot is required/)
})

test('Windows desktop launch resolves the npm Codex JavaScript entry without a shell', () => {
  const appData = path.resolve('C:\\Users\\tester\\AppData\\Roaming')
  const expectedScript = path.join(
    appData,
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js'
  )
  const launch = resolveCodexLaunch({
    platform: 'win32',
    env: { APPDATA: appData, YOGURT_NODE_COMMAND: 'node.exe' },
    fileExists: (filePath) => filePath === expectedScript
  })

  assert.equal(launch.command, 'node.exe')
  assert.deepEqual(launch.commandPrefixArgs, [expectedScript])
  assert.throws(
    () => resolveCodexLaunch({
      platform: 'win32',
      env: { YOGURT_CODEX_COMMAND: 'codex.cmd' },
      fileExists: () => false
    }),
    /must be an executable/
  )
})
