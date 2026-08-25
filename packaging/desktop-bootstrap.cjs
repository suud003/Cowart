'use strict'

const { app, dialog } = require('electron')
const { existsSync } = require('node:fs')
const path = require('node:path')

function requireRuntimeFile(runtimeRoot, ...parts) {
  const target = path.join(runtimeRoot, ...parts)
  if (!existsSync(target)) {
    throw new Error(`The Yogurt AI installation is incomplete: ${target}`)
  }
  return target
}

try {
  const runtimeRoot = path.join(process.resourcesPath, 'app.asar.unpacked')
  const launcherPath = requireRuntimeFile(runtimeRoot, 'desktop', 'launcher.cjs')
  const bundledNode = requireRuntimeFile(
    runtimeRoot,
    'node_modules',
    'node-win-x64',
    'bin',
    'node.exe'
  )
  const bundledCodex = requireRuntimeFile(
    runtimeRoot,
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js'
  )

  // Normal installed use is self-contained. Explicit overrides remain
  // available for development and diagnostics.
  process.env.YOGURT_NODE_COMMAND ||= bundledNode
  process.env.YOGURT_CODEX_JS ||= bundledCodex
  process.env.YOGURT_DESKTOP_VERSION ||= app.getVersion()

  require(launcherPath)
} catch (error) {
  const message = String(error?.stack || error?.message || error)
  console.error('Yogurt AI packaged runtime failed to start:', message)
  try {
    dialog.showErrorBox('Yogurt AI failed to start', message)
  } finally {
    app.exit(1)
  }
}
