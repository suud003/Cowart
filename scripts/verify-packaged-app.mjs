import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(rootDir, 'output', 'desktop', 'win-unpacked')
const resourcesDir = path.join(packageDir, 'resources')
const runtimeRoot = path.join(resourcesDir, 'app.asar.unpacked')
const packagedExecutable = path.join(packageDir, 'Yogurt AI Beta.exe')
const desktopSmokeTimeoutMs = 90_000

const requiredPaths = [
  packagedExecutable,
  path.join(resourcesDir, 'app.asar'),
  path.join(runtimeRoot, 'desktop', 'launcher.cjs'),
  path.join(runtimeRoot, 'desktop', 'main.mjs'),
  path.join(runtimeRoot, 'dist', 'index.html'),
  path.join(runtimeRoot, 'index.html'),
  path.join(runtimeRoot, 'vite.config.js'),
  path.join(runtimeRoot, 'package-lock.json'),
  path.join(runtimeRoot, 'mcp', 'server.mjs'),
  path.join(runtimeRoot, 'scripts', 'start-mcp.mjs'),
  path.join(runtimeRoot, 'scripts', 'vite-build-once.mjs'),
  path.join(runtimeRoot, 'src', 'main.jsx'),
  path.join(runtimeRoot, 'public', 'cowart-logo.svg'),
  path.join(runtimeRoot, 'skills', 'cowart-thinking-agent', 'SKILL.md'),
  path.join(runtimeRoot, '.codex-plugin', 'plugin.json'),
  path.join(runtimeRoot, 'plugin.json'),
  path.join(runtimeRoot, 'licenses', 'TLDRAW-LICENSE.md'),
  path.join(runtimeRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'),
  path.join(runtimeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  path.join(runtimeRoot, 'node_modules', '@openai', 'codex-win32-x64', 'package.json'),
  path.join(runtimeRoot, 'node_modules', 'node-win-x64', 'bin', 'node.exe')
]

const missingPaths = requiredPaths.filter((target) => !existsSync(target))
if (missingPaths.length > 0) {
  throw new Error(`Packaged runtime is incomplete:\n${missingPaths.join('\n')}`)
}

const bundledCodex = path.join(runtimeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const bundledNode = path.join(runtimeRoot, 'node_modules', 'node-win-x64', 'bin', 'node.exe')
const desktopClientUrl = pathToFileURL(
  path.join(runtimeRoot, 'desktop', 'codex-app-server-client.mjs')
).href
const runtimeConfigUrl = pathToFileURL(
  path.join(runtimeRoot, 'desktop', 'runtime-config.mjs')
).href
const [{ CodexAppServerClient }, { createYogurtCodexArgs, resolveCodexLaunch }] =
  await Promise.all([import(desktopClientUrl), import(runtimeConfigUrl)])

const codexLaunch = resolveCodexLaunch({
  env: {
    YOGURT_NODE_COMMAND: bundledNode,
    YOGURT_CODEX_JS: bundledCodex
  },
  platform: 'win32',
  runtimeRoot,
  isPackaged: true,
  execPath: packagedExecutable
})
if (codexLaunch.command !== bundledNode) {
  throw new Error(`Packaged Codex did not select the bundled Node runtime: ${codexLaunch.command}`)
}
if (codexLaunch.commandPrefixArgs[0] !== bundledCodex) {
  throw new Error(`Packaged Codex did not select the bundled entrypoint: ${codexLaunch.commandPrefixArgs[0]}`)
}
const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-packaged-probe-'))
const canvasDir = path.join(projectDir, 'canvas')
const client = new CodexAppServerClient({
  command: codexLaunch.command,
  commandPrefixArgs: codexLaunch.commandPrefixArgs,
  args: createYogurtCodexArgs({
    repoRoot: runtimeRoot,
    nodeCommand: bundledNode
  }),
  cwd: projectDir,
  env: { ...process.env, ...codexLaunch.env },
  clientInfo: {
    name: 'yogurt_ai_packaged_probe',
    title: 'Yogurt AI Packaged Probe',
    version: '0.2.2'
  },
  requestTimeoutMs: 60_000
})

let threadId = null
let sidecarResult = null
try {
  await client.start()
  const started = await client.startThread({
    cwd: projectDir,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    serviceName: 'yogurt_ai_packaged_probe'
  })
  threadId = started?.thread?.id
  if (!threadId) throw new Error('Packaged App Server probe did not receive a thread id.')

  const servers = await client.listMcpServers(threadId, {
    limit: 100,
    detail: 'toolsAndAuthOnly'
  })
  const yogurtServer = servers?.data?.find((server) => server?.name === 'cowart_thinking_mcp')
  if (!yogurtServer) throw new Error('Packaged App Server could not start the Yogurt MCP server.')

  const canvas = await client.callMcpServerTool(
    threadId,
    'cowart_thinking_mcp',
    'get_cowart_canvas_state',
    { projectDir, canvasDir, hydrateAssets: false }
  )

  sidecarResult = {
    codexVersion: '0.144.3',
    transport: 'stdio',
    cowartMcp: yogurtServer.name,
    canvasToolReturned: Boolean(canvas)
  }
} finally {
  if (threadId) {
    try {
      await client.request('thread/archive', { threadId }, { timeoutMs: 3_000 })
    } catch (_error) {
      // The runtime result remains valid when archive cleanup is unavailable.
    }
  }
  await client.dispose()
  await rm(projectDir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250
  })
}

function appendBoundedLog(current, chunk) {
  return `${current}${String(chunk)}`.slice(-40_000)
}

async function terminateProcessTree(child) {
  if (!Number.isInteger(child?.pid)) return
  if (process.platform !== 'win32') {
    child.kill('SIGKILL')
    return
  }

  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    })
    const timeout = setTimeout(() => {
      killer.kill()
      finish()
    }, 5_000)
    killer.once('error', finish)
    killer.once('close', finish)
  })

  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

function waitForCleanExit(child, timeoutMs, readLogs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    const timeout = setTimeout(() => {
      const error = new Error(
        `Packaged desktop did not capture and exit within ${timeoutMs}ms.\n${readLogs()}`
      )
      error.code = 'YOGURT_PACKAGED_DESKTOP_TIMEOUT'
      finish(() => reject(error))
    }, timeoutMs)

    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code, signal) => finish(() => resolve({ code, signal })))
  })
}

function readPngDimensions(buffer) {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(pngSignature)) {
    throw new Error('Packaged desktop capture is not a valid PNG.')
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  }
}

async function probePackagedDesktop() {
  const probeRoot = await mkdtemp(path.join(tmpdir(), 'yogurt-packaged-desktop-'))
  const workspaceDir = path.join(probeRoot, 'workspace')
  const userDataDir = path.join(probeRoot, 'user-data')
  const capturePath = path.join(probeRoot, 'desktop-capture.png')
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(userDataDir, { recursive: true })
  ])

  const desktopEnv = { ...process.env }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'YOGURT_CODEX_COMMAND',
    'YOGURT_CODEX_JS',
    'YOGURT_NODE_COMMAND',
    'YOGURT_VITE_DEV_URL'
  ]) {
    delete desktopEnv[key]
  }
  Object.assign(desktopEnv, {
    YOGURT_WORKSPACE_ROOT: workspaceDir,
    YOGURT_DESKTOP_CAPTURE_PATH: capturePath,
    YOGURT_DESKTOP_CAPTURE_DELAY_MS: '7000',
    YOGURT_DESKTOP_DEBUG: '1'
  })

  let logs = ''
  let child = null
  let completed = false
  try {
    child = spawn(packagedExecutable, [`--user-data-dir=${userDataDir}`], {
      cwd: workspaceDir,
      env: desktopEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.on('data', (chunk) => {
      logs = appendBoundedLog(logs, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      logs = appendBoundedLog(logs, chunk)
    })

    const result = await waitForCleanExit(child, desktopSmokeTimeoutMs, () => logs)
    if (result.code !== 0 || result.signal) {
      throw new Error(
        `Packaged desktop exited abnormally (code ${result.code}, signal ${result.signal}).\n${logs}`
      )
    }

    const fatalLogPatterns = [
      /\[renderer\]\s+load failed/i,
      /ERR_FILE_NOT_FOUND/i,
      /Yogurt AI Desktop failed to start/i,
      /Yogurt AI packaged runtime failed to start/i,
      /Uncaught (?:Error|TypeError|ReferenceError|SyntaxError)/i
    ]
    if (fatalLogPatterns.some((pattern) => pattern.test(logs))) {
      throw new Error(`Packaged desktop reported a renderer/startup failure.\n${logs}`)
    }

    const capture = await readFile(capturePath)
    const dimensions = readPngDimensions(capture)
    if (capture.length < 25_000 || dimensions.width < 1000 || dimensions.height < 700) {
      throw new Error(
        `Packaged desktop capture looks incomplete: ${dimensions.width}x${dimensions.height}, ${capture.length} bytes.`
      )
    }

    completed = true
    return {
      desktopRendererCaptured: true,
      desktopExitCode: result.code,
      captureWidth: dimensions.width,
      captureHeight: dimensions.height,
      captureBytes: capture.length
    }
  } finally {
    if (child && !completed) await terminateProcessTree(child)
    await rm(probeRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250
    })
  }
}

const desktopResult = await probePackagedDesktop()

console.log(JSON.stringify({
  ok: true,
  packageDir,
  runtimeRoot,
  ...sidecarResult,
  ...desktopResult
}, null, 2))
