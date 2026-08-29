import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  persistThreadId,
  readPersistedThreadId,
  YOGURT_AGENT_SESSION_VERSION
} from '../desktop/agent-session.mjs'

test('desktop Agent sessions are reused only within the exact application version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yogurt-agent-session-'))
  const canvasDir = path.join(root, 'canvas')
  const sessionFile = path.join(canvasDir, '.yogurt-agent-session.json')
  try {
    await persistThreadId(sessionFile, canvasDir, 'thread:new', '0.2.11+codex.20260829')
    assert.equal(
      readPersistedThreadId(sessionFile, '0.2.11+codex.20260829'),
      'thread:new'
    )
    assert.equal(readPersistedThreadId(sessionFile, '0.2.12+codex.20260829'), null)

    const persisted = JSON.parse(await readFile(sessionFile, 'utf8'))
    assert.deepEqual(persisted, {
      version: YOGURT_AGENT_SESSION_VERSION,
      appVersion: '0.2.11+codex.20260829',
      threadId: 'thread:new'
    })

    await writeFile(sessionFile, `${JSON.stringify({ version: 1, threadId: 'thread:legacy' })}\n`)
    assert.equal(readPersistedThreadId(sessionFile, '0.2.11+codex.20260829'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
