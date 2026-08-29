import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'

export const YOGURT_AGENT_SESSION_VERSION = 2

function requiredVersion(value) {
  const version = String(value || '').trim()
  if (!version) throw new TypeError('appVersion is required.')
  return version
}

export function readPersistedThreadId(sessionFile, expectedAppVersion) {
  const appVersion = requiredVersion(expectedAppVersion)
  try {
    const state = JSON.parse(readFileSync(sessionFile, 'utf8'))
    if (state?.version !== YOGURT_AGENT_SESSION_VERSION) return null
    if (state?.appVersion !== appVersion) return null
    return typeof state?.threadId === 'string' && state.threadId.trim()
      ? state.threadId.trim()
      : null
  } catch (_error) {
    return null
  }
}

export async function persistThreadId(sessionFile, canvasDir, threadId, appVersion) {
  const normalizedThreadId = String(threadId || '').trim()
  if (!normalizedThreadId) throw new TypeError('threadId is required.')
  const normalizedAppVersion = requiredVersion(appVersion)
  await mkdir(canvasDir, { recursive: true })
  const temporaryFile = `${sessionFile}.${process.pid}.${randomUUID()}.tmp`
  const state = {
    version: YOGURT_AGENT_SESSION_VERSION,
    appVersion: normalizedAppVersion,
    threadId: normalizedThreadId
  }
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`)
  await rename(temporaryFile, sessionFile)
}
