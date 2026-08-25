import { existsSync } from 'node:fs'
import path from 'node:path'

function requiredString(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new TypeError(`${label} is required.`)
  return normalized
}

function tomlLiteral(value) {
  return JSON.stringify(value)
}

export function createYogurtCodexArgs({ repoRoot, nodeCommand = 'node' } = {}) {
  const normalizedRoot = path.resolve(requiredString(repoRoot, 'repoRoot'))
  const normalizedNodeCommand = requiredString(nodeCommand, 'nodeCommand')
  const mcpScript = path.join(normalizedRoot, 'scripts', 'start-mcp.mjs')

  return Object.freeze([
    'app-server',
    '--listen',
    'stdio://',
    '-c',
    `mcp_servers.cowart_thinking_mcp.command=${tomlLiteral(normalizedNodeCommand)}`,
    '-c',
    `mcp_servers.cowart_thinking_mcp.args=${tomlLiteral([mcpScript])}`,
    '-c',
    `mcp_servers.cowart_thinking_mcp.cwd=${tomlLiteral(normalizedRoot)}`,
    '-c',
    'mcp_servers.cowart_thinking_mcp.enabled=true',
    '-c',
    'mcp_servers.cowart_thinking_mcp.required=true'
  ])
}

export function resolveCodexLaunch({
  env = process.env,
  fileExists = existsSync,
  platform = process.platform
} = {}) {
  const nodeCommand = requiredString(env.YOGURT_NODE_COMMAND || 'node', 'nodeCommand')
  const scriptOverride = String(env.YOGURT_CODEX_JS || '').trim()
  if (scriptOverride) {
    const scriptPath = path.resolve(scriptOverride)
    if (!fileExists(scriptPath)) throw new Error(`YOGURT_CODEX_JS does not exist: ${scriptPath}`)
    return Object.freeze({ command: nodeCommand, commandPrefixArgs: Object.freeze([scriptPath]) })
  }

  const commandOverride = String(env.YOGURT_CODEX_COMMAND || '').trim()
  if (commandOverride) {
    if (platform === 'win32' && /\.(?:bat|cmd|ps1)$/i.test(commandOverride)) {
      throw new Error('YOGURT_CODEX_COMMAND must be an executable, not a Windows shell script. Use YOGURT_CODEX_JS for the npm Codex CLI.')
    }
    return Object.freeze({ command: commandOverride, commandPrefixArgs: Object.freeze([]) })
  }

  if (platform === 'win32') {
    const roots = [
      env.APPDATA ? path.join(env.APPDATA, 'npm') : null,
      env.npm_config_prefix || null
    ].filter(Boolean)
    for (const root of roots) {
      const scriptPath = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      if (fileExists(scriptPath)) {
        return Object.freeze({ command: nodeCommand, commandPrefixArgs: Object.freeze([scriptPath]) })
      }
    }
    throw new Error('Yogurt AI Desktop could not find a spawnable Codex CLI. Install @openai/codex with npm or set YOGURT_CODEX_JS.')
  }

  return Object.freeze({ command: 'codex', commandPrefixArgs: Object.freeze([]) })
}
