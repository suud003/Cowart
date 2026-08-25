import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  createYogurtCodexArgs,
  normalizeWorkspaceDirectory,
  resolveCodexLaunch,
  resolveConfiguredWorkspace,
  resolveDesktopRuntimeRoot
} from '../desktop/runtime-config.mjs'

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

test('desktop workspace resolution never falls back to the process cwd', () => {
  const existing = path.resolve('C:/Users/tester/Projects/story-game')
  const getStat = (candidate) => ({ isDirectory: () => candidate === existing })

  assert.equal(normalizeWorkspaceDirectory(existing, { getStat }), existing)
  assert.equal(normalizeWorkspaceDirectory('C:/missing', { getStat }), null)
  assert.deepEqual(resolveConfiguredWorkspace({ env: {}, persistedWorkspace: null, getStat }), {
    configured: false,
    source: 'none',
    workspaceDir: null,
    invalidPath: null
  })
  assert.deepEqual(resolveConfiguredWorkspace({ env: {}, persistedWorkspace: existing, getStat }), {
    configured: true,
    source: 'settings',
    workspaceDir: existing,
    invalidPath: null
  })
})

test('packaged desktop resolves unpacked runtime assets and runs bundled Codex through bundled Node', () => {
  const resourcesPath = path.resolve('C:/Program Files/Yogurt AI/resources')
  const runtimeRoot = resolveDesktopRuntimeRoot({
    appPath: path.join(resourcesPath, 'app.asar'),
    resourcesPath,
    isPackaged: true
  })
  const bundledCodex = path.join(
    runtimeRoot,
    'node_modules',
    '@openai',
    'codex',
    'bin',
      'codex.js'
  )
  const bundledNode = path.join(
    runtimeRoot,
    'node_modules',
    'node-win-x64',
    'bin',
    'node.exe'
  )
  const launch = resolveCodexLaunch({
    platform: 'win32',
    env: {
      YOGURT_CODEX_JS: bundledCodex,
      YOGURT_NODE_COMMAND: bundledNode
    },
    runtimeRoot,
    isPackaged: true,
    execPath: 'C:\\Program Files\\Yogurt AI\\Yogurt AI.exe',
    fileExists: (candidate) => candidate === bundledCodex
  })

  assert.equal(runtimeRoot, path.join(resourcesPath, 'app.asar.unpacked'))
  assert.equal(launch.command, bundledNode)
  assert.deepEqual(launch.commandPrefixArgs, [bundledCodex])
  assert.throws(
    () => resolveCodexLaunch({
      platform: 'win32',
      env: {},
      runtimeRoot,
      isPackaged: true,
      execPath: launch.command,
      fileExists: () => false
    }),
    (error) => error.code === 'CODEX_BUNDLED_CLI_MISSING'
  )
})
