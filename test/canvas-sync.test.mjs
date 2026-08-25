import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  classifyRemoteCanvasRefresh,
  REMOTE_CANVAS_REFRESH_ACTION
} from '../src/canvasSync.js'

test('applies a remote refresh when there are no pending local edits', () => {
  assert.equal(
    classifyRemoteCanvasRefresh({
      revisionBeforeFetch: 'revision-a',
      currentRevision: 'revision-a',
      remoteRevision: 'revision-b',
      preserveLocalChanges: false
    }),
    REMOTE_CANVAS_REFRESH_ACTION.APPLY
  )
})

test('keeps the local base revision when pending edits see an unchanged remote canvas', () => {
  assert.equal(
    classifyRemoteCanvasRefresh({
      revisionBeforeFetch: 'revision-a',
      currentRevision: 'revision-a',
      remoteRevision: 'revision-a',
      preserveLocalChanges: true
    }),
    REMOTE_CANVAS_REFRESH_ACTION.IGNORE
  )
})

test('ignores a stale refresh response when a local save completed in flight', () => {
  assert.equal(
    classifyRemoteCanvasRefresh({
      revisionBeforeFetch: 'revision-a',
      currentRevision: 'revision-b',
      remoteRevision: 'revision-a',
      preserveLocalChanges: true
    }),
    REMOTE_CANVAS_REFRESH_ACTION.IGNORE
  )
})

test('blocks saving when Agent changes arrive over pending local edits', () => {
  assert.equal(
    classifyRemoteCanvasRefresh({
      revisionBeforeFetch: 'revision-a',
      currentRevision: 'revision-a',
      remoteRevision: 'revision-agent',
      preserveLocalChanges: true
    }),
    REMOTE_CANVAS_REFRESH_ACTION.CONFLICT
  )
})

test('detects an Agent revision that follows a completed local save', () => {
  assert.equal(
    classifyRemoteCanvasRefresh({
      revisionBeforeFetch: 'revision-a',
      currentRevision: 'revision-local',
      remoteRevision: 'revision-agent',
      preserveLocalChanges: true
    }),
    REMOTE_CANVAS_REFRESH_ACTION.CONFLICT
  )
})

test('all App canvas writes flow through the revision-aware save state machine', async () => {
  const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const directSaves = appSource.match(/saveCowartCanvasSnapshot\(/g) ?? []
  assert.equal(directSaves.length, 1)
  assert.match(appSource, /baseRevision:\s*canvasRevisionRef\.current/)
  assert.match(appSource, /const flushCanvasSnapshot = cowartCanvasSnapshotFlushers\.get\(editor\)/)
})
