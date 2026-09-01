import { createReadStream, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDir = path.join(rootDir, 'output', 'desktop', 'win-unpacked')
const resourcesDir = path.join(packageDir, 'resources')
const runtimeRoot = path.join(resourcesDir, 'app.asar.unpacked')
const packagedExecutable = path.join(packageDir, 'Yogurt AI Beta.exe')
const desktopSmokeTimeoutMs = 90_000
const sourcePackage = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'))
const releaseVersion = String(sourcePackage.version || '').split('+')[0]
const installerPath = path.join(
  rootDir,
  'output',
  'desktop',
  `Yogurt-AI-Beta-Setup-${releaseVersion}-x64.exe`
)
const installerBlockmapPath = `${installerPath}.blockmap`
const minimumInstallerBytes = 50 * 1024 * 1024
const minimumBlockmapBytes = 10 * 1024

const requiredPaths = [
  packagedExecutable,
  path.join(resourcesDir, 'app.asar'),
  path.join(runtimeRoot, 'desktop', 'launcher.cjs'),
  path.join(runtimeRoot, 'desktop', 'main.mjs'),
  path.join(runtimeRoot, 'desktop', 'ai-mode-menu.mjs'),
  path.join(runtimeRoot, 'desktop', 'agent-service.mjs'),
  path.join(runtimeRoot, 'desktop', 'codex-app-server-client.mjs'),
  path.join(runtimeRoot, 'desktop', 'ipc-bridge.mjs'),
  path.join(runtimeRoot, 'desktop', 'preload.cjs'),
  path.join(runtimeRoot, 'dist', 'index.html'),
  path.join(runtimeRoot, 'index.html'),
  path.join(runtimeRoot, 'vite.config.js'),
  path.join(runtimeRoot, 'package-lock.json'),
  path.join(runtimeRoot, 'mcp', 'server.mjs'),
  path.join(runtimeRoot, 'mcp', 'lib', 'auto-compose-plan.mjs'),
  path.join(runtimeRoot, 'mcp', 'lib', 'canvas-runtime-helpers.mjs'),
  path.join(runtimeRoot, 'mcp', 'lib', 'excalidraw-thinking-canvas.mjs'),
  path.join(runtimeRoot, 'mcp', 'lib', 'semantic-layout.mjs'),
  path.join(runtimeRoot, 'mcp', 'lib', 'thinking-layout.mjs'),
  path.join(runtimeRoot, 'mcp', 'lib', 'thinking-runtime.mjs'),
  path.join(runtimeRoot, 'scripts', 'start-mcp.mjs'),
  path.join(runtimeRoot, 'scripts', 'vite-build-once.mjs'),
  path.join(runtimeRoot, 'src', 'main.jsx'),
  path.join(runtimeRoot, 'src', 'NativeExcalidrawApp.jsx'),
  path.join(runtimeRoot, 'src', 'excalidrawDocument.js'),
  path.join(runtimeRoot, 'src', 'nativeExcalidraw.css'),
  path.join(runtimeRoot, 'public', 'cowart-logo.svg'),
  path.join(runtimeRoot, 'skills', 'cowart-auto-compose', 'SKILL.md'),
  path.join(runtimeRoot, 'skills', 'cowart-auto-compose', 'references', 'routing-contract.md'),
  path.join(runtimeRoot, 'skills', 'cowart-auto-compose', 'agents', 'openai.yaml'),
  path.join(runtimeRoot, 'skills', 'cowart-thinking-agent', 'SKILL.md'),
  path.join(runtimeRoot, '.codex-plugin', 'plugin.json'),
  path.join(runtimeRoot, 'plugin.json'),
  path.join(runtimeRoot, 'licenses', 'EXCALIDRAW-LICENSE.md'),
  path.join(runtimeRoot, 'public', 'excalidraw-assets', 'SOURCE.json'),
  path.join(runtimeRoot, 'node_modules', '@excalidraw', 'excalidraw', 'package.json'),
  path.join(runtimeRoot, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'),
  path.join(runtimeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  path.join(runtimeRoot, 'node_modules', '@openai', 'codex-win32-x64', 'package.json'),
  path.join(runtimeRoot, 'node_modules', 'node-win-x64', 'bin', 'node.exe'),
  installerPath,
  installerBlockmapPath
]

const missingPaths = requiredPaths.filter((target) => !existsSync(target))
if (missingPaths.length > 0) {
  throw new Error(`Packaged runtime is incomplete:\n${missingPaths.join('\n')}`)
}

const forbiddenLegacyPaths = [
  path.join(runtimeRoot, 'node_modules', 'tldraw', 'package.json'),
  path.join(runtimeRoot, 'node_modules', '@tldraw', 'assets', 'package.json'),
  path.join(runtimeRoot, 'node_modules', '@tldraw', 'store', 'package.json'),
  path.join(runtimeRoot, 'node_modules', '@tldraw', 'tlschema', 'package.json'),
  path.join(runtimeRoot, 'mcp', 'lib', 'thinking-canvas.mjs'),
  path.join(runtimeRoot, 'src', 'App.jsx'),
  path.join(runtimeRoot, 'licenses', 'TLDRAW-LICENSE.md')
]
const shippedLegacyPaths = forbiddenLegacyPaths.filter((target) => existsSync(target))
if (shippedLegacyPaths.length > 0) {
  throw new Error(`Packaged runtime unexpectedly includes legacy tldraw files:\n${shippedLegacyPaths.join('\n')}`)
}

const [installerStat, installerBlockmapStat, packagedExecutableStat, packagedAsarStat] = await Promise.all([
  stat(installerPath),
  stat(installerBlockmapPath),
  stat(packagedExecutable),
  stat(path.join(resourcesDir, 'app.asar'))
])
if (!installerStat.isFile() || installerStat.size < minimumInstallerBytes) {
  throw new Error(
    `Packaged installer is incomplete: expected at least ${minimumInstallerBytes} bytes, got ${installerStat.size}.`
  )
}
if (!installerBlockmapStat.isFile() || installerBlockmapStat.size < minimumBlockmapBytes) {
  throw new Error(
    `Packaged installer blockmap is incomplete: expected at least ${minimumBlockmapBytes} bytes, got ${installerBlockmapStat.size}.`
  )
}
const newestUnpackedRuntimeMtime = Math.max(packagedExecutableStat.mtimeMs, packagedAsarStat.mtimeMs)
if (installerStat.mtimeMs < newestUnpackedRuntimeMtime) {
  throw new Error('Packaged installer predates the unpacked runtime and may be stale.')
}
if (installerBlockmapStat.mtimeMs < installerStat.mtimeMs) {
  throw new Error('Packaged installer blockmap predates the installer and may be stale.')
}

const sourceParityPaths = [
  'plugin.json',
  path.join('.codex-plugin', 'plugin.json'),
  path.join('mcp', 'server.mjs'),
  path.join('mcp', 'lib', 'auto-compose-plan.mjs'),
  path.join('mcp', 'lib', 'canvas-runtime-helpers.mjs'),
  path.join('mcp', 'lib', 'excalidraw-thinking-canvas.mjs'),
  path.join('mcp', 'lib', 'semantic-layout.mjs'),
  path.join('mcp', 'lib', 'thinking-layout.mjs'),
  path.join('mcp', 'lib', 'thinking-runtime.mjs'),
  path.join('mcp', 'lib', 'thinking-tools.mjs'),
  path.join('desktop', 'ai-mode-menu.mjs'),
  path.join('desktop', 'agent-service.mjs'),
  path.join('desktop', 'codex-app-server-client.mjs'),
  path.join('desktop', 'ipc-bridge.mjs'),
  path.join('desktop', 'main.mjs'),
  path.join('desktop', 'preload.cjs'),
  path.join('src', 'AgentPanel.jsx'),
  path.join('src', 'NativeExcalidrawApp.jsx'),
  path.join('src', 'autoComposePrompt.js'),
  path.join('src', 'excalidrawDocument.js'),
  path.join('src', 'nativeExcalidraw.css'),
  path.join('licenses', 'EXCALIDRAW-LICENSE.md'),
  path.join('public', 'excalidraw-assets', 'SOURCE.json'),
  path.join('skills', 'cowart-auto-compose', 'SKILL.md'),
  path.join('skills', 'cowart-auto-compose', 'references', 'routing-contract.md'),
  path.join('skills', 'cowart-auto-compose', 'agents', 'openai.yaml'),
  path.join('skills', 'cowart-image-gen', 'SKILL.md'),
  path.join('skills', 'cowart-semantic-diagram', 'SKILL.md'),
  path.join('skills', 'cowart-thinking-agent', 'SKILL.md')
]

const packagedPackage = JSON.parse(await readFile(path.join(runtimeRoot, 'package.json'), 'utf8'))
const runtimePackageFields = ['name', 'version', 'main', 'type', 'dependencies']
for (const field of runtimePackageFields) {
  if (JSON.stringify(sourcePackage[field]) !== JSON.stringify(packagedPackage[field])) {
    throw new Error(`Packaged runtime is stale: package.json field ${field} differs from the current source tree.`)
  }
}

async function listRelativeFiles(directory, relativeDirectory = '') {
  const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(directory, relativePath))
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`Packaged dist parity does not support non-file entry: ${relativePath}`)
    }
    files.push(relativePath)
  }
  return files.sort((left, right) => left.localeCompare(right))
}

const sourceDistDir = path.join(rootDir, 'dist')
const packagedDistDir = path.join(runtimeRoot, 'dist')
const [sourceDistFiles, packagedDistFiles] = await Promise.all([
  listRelativeFiles(sourceDistDir),
  listRelativeFiles(packagedDistDir)
])
if (JSON.stringify(sourceDistFiles) !== JSON.stringify(packagedDistFiles)) {
  const sourceOnly = sourceDistFiles.filter((file) => !packagedDistFiles.includes(file))
  const packagedOnly = packagedDistFiles.filter((file) => !sourceDistFiles.includes(file))
  throw new Error(
    `Packaged dist file set differs from the current build. Source-only: ${sourceOnly.join(', ') || '(none)'}; packaged-only: ${packagedOnly.join(', ') || '(none)'}.`
  )
}
for (const relativePath of sourceDistFiles) {
  const [source, packaged] = await Promise.all([
    readFile(path.join(sourceDistDir, relativePath)),
    readFile(path.join(packagedDistDir, relativePath))
  ])
  if (!source.equals(packaged)) {
    throw new Error(`Packaged dist is stale: ${relativePath} differs from the current build.`)
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath)
    input.on('data', (chunk) => hash.update(chunk))
    input.once('error', reject)
    input.once('end', resolve)
  })
  return hash.digest('hex').toUpperCase()
}

const installerSha256 = await sha256File(installerPath)

for (const relativePath of sourceParityPaths) {
  const [source, packaged] = await Promise.all([
    readFile(path.join(rootDir, relativePath)),
    readFile(path.join(runtimeRoot, relativePath))
  ])
  if (!source.equals(packaged)) {
    throw new Error(`Packaged runtime is stale: ${relativePath} differs from the current source tree.`)
  }
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
    version: sourcePackage.version
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
    codexVersion: sourcePackage.dependencies['@openai/codex'],
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
    YOGURT_DESKTOP_CAPTURE_AGENT_PANEL: '1',
    YOGURT_DESKTOP_CAPTURE_AUTO_ADVANCE: '1',
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
  sourceParityFiles: sourceParityPaths.length + sourceDistFiles.length + 1,
  installerPath,
  installerBytes: installerStat.size,
  installerBlockmapBytes: installerBlockmapStat.size,
  installerSha256,
  ...sidecarResult,
  ...desktopResult
}, null, 2))
