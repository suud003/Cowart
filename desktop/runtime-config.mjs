import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

function requiredString(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new TypeError(`${label} is required.`)
  return normalized
}

function tomlLiteral(value) {
  return JSON.stringify(value)
}

function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

export function normalizeWorkspaceDirectory(value, {
  getStat = statSync
} = {}) {
  const normalized = String(value || '').trim()
  if (!normalized) return null
  const workspaceDir = path.resolve(normalized)
  try {
    if (!getStat(workspaceDir).isDirectory()) return null
  } catch (_error) {
    return null
  }
  return workspaceDir
}

export function resolveConfiguredWorkspace({
  env = process.env,
  persistedWorkspace = null,
  getStat = statSync
} = {}) {
  const environmentWorkspace = String(env.YOGURT_WORKSPACE_ROOT || '').trim()
  if (environmentWorkspace) {
    const workspaceDir = normalizeWorkspaceDirectory(environmentWorkspace, { getStat })
    return Object.freeze({
      configured: Boolean(workspaceDir),
      source: 'environment',
      workspaceDir,
      invalidPath: workspaceDir ? null : path.resolve(environmentWorkspace)
    })
  }

  const workspaceDir = normalizeWorkspaceDirectory(persistedWorkspace, { getStat })
  return Object.freeze({
    configured: Boolean(workspaceDir),
    source: workspaceDir ? 'settings' : 'none',
    workspaceDir,
    invalidPath: persistedWorkspace && !workspaceDir ? path.resolve(String(persistedWorkspace)) : null
  })
}

export function resolveDesktopRuntimeRoot({
  appPath,
  resourcesPath,
  isPackaged = false
} = {}) {
  const normalizedAppPath = path.resolve(requiredString(appPath, 'appPath'))
  if (!isPackaged) return normalizedAppPath

  return path.join(
    path.resolve(requiredString(resourcesPath, 'resourcesPath')),
    'app.asar.unpacked'
  )
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
  platform = process.platform,
  runtimeRoot = null,
  isPackaged = false,
  execPath = process.execPath
} = {}) {
  const nodeCommand = requiredString(env.YOGURT_NODE_COMMAND || 'node', 'nodeCommand')
  const scriptOverride = String(env.YOGURT_CODEX_JS || '').trim()
  if (scriptOverride) {
    const scriptPath = path.resolve(scriptOverride)
    if (!fileExists(scriptPath)) {
      throw codedError(`YOGURT_CODEX_JS does not exist: ${scriptPath}`, 'CODEX_CLI_NOT_FOUND')
    }
    return Object.freeze({ command: nodeCommand, commandPrefixArgs: Object.freeze([scriptPath]) })
  }

  const commandOverride = String(env.YOGURT_CODEX_COMMAND || '').trim()
  if (commandOverride) {
    if (platform === 'win32' && /\.(?:bat|cmd|ps1)$/i.test(commandOverride)) {
      throw new Error('YOGURT_CODEX_COMMAND must be an executable, not a Windows shell script. Use YOGURT_CODEX_JS for the npm Codex CLI.')
    }
    return Object.freeze({ command: commandOverride, commandPrefixArgs: Object.freeze([]) })
  }

  const bundledScript = runtimeRoot
    ? path.join(
        path.resolve(runtimeRoot),
        'node_modules',
        '@openai',
        'codex',
        'bin',
        'codex.js'
      )
    : null
  if (bundledScript && fileExists(bundledScript)) {
    if (isPackaged) {
      return Object.freeze({
        command: requiredString(execPath, 'execPath'),
        commandPrefixArgs: Object.freeze([bundledScript]),
        env: Object.freeze({ ELECTRON_RUN_AS_NODE: '1' })
      })
    }
    return Object.freeze({ command: nodeCommand, commandPrefixArgs: Object.freeze([bundledScript]) })
  }
  if (isPackaged) {
    throw codedError(
      `The packaged Yogurt AI Codex component is missing: ${bundledScript || 'unknown path'}`,
      'CODEX_BUNDLED_CLI_MISSING'
    )
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
    throw codedError(
      'Yogurt AI Desktop could not find Codex. Install @openai/codex, then reopen Yogurt AI.',
      'CODEX_CLI_NOT_FOUND'
    )
  }

  return Object.freeze({ command: 'codex', commandPrefixArgs: Object.freeze([]) })
}
