import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  classifyRemoteCanvasRefresh,
  collectNewSemanticDiagramRootIds,
  cowartExcalidrawViewState,
  isExplicitEmptyCowartCanvasState,
  mergeCowartExcalidrawViewState,
  newestCowartPendingScene,
  shouldIgnoreCanvasRefreshAfterFetch,
  REMOTE_CANVAS_REFRESH_ACTION
} from '../src/canvasSync.js'

test('focuses only newly added top-level semantic diagram frames', () => {
  const page = { id: 'page:one', typeName: 'page' }
  const existing = {
    id: 'shape:existing',
    typeName: 'shape',
    type: 'frame',
    parentId: page.id,
    meta: {
      cowartSemanticZone: true,
      cowartSemanticDiagram: { diagramId: 'diagram:existing' }
    }
  }
  const created = {
    id: 'shape:created',
    typeName: 'shape',
    type: 'frame',
    parentId: page.id,
    meta: {
      cowartSemanticZone: true,
      cowartSemanticDiagram: { diagramId: 'diagram:created' }
    }
  }
  const nested = {
    id: 'shape:nested',
    typeName: 'shape',
    type: 'frame',
    parentId: created.id,
    meta: {
      cowartSemanticZone: true,
      cowartSemanticDiagram: { diagramId: 'diagram:created' }
    }
  }

  assert.deepEqual(
    collectNewSemanticDiagramRootIds({
      localStore: { [page.id]: page, [existing.id]: existing },
      remoteStore: {
        [page.id]: page,
        [existing.id]: existing,
        [created.id]: created,
        [nested.id]: nested
      },
      pageId: page.id
    }),
    [created.id]
  )
})

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

test('a refresh response is ignored when local state changes while the request is in flight', () => {
  const stable = {
    generationBeforeFetch: 4,
    currentGeneration: 4,
    revisionBeforeFetch: 'revision-a',
    currentRevision: 'revision-a'
  }
  assert.equal(shouldIgnoreCanvasRefreshAfterFetch(stable), false)
  assert.equal(shouldIgnoreCanvasRefreshAfterFetch({
    ...stable,
    currentGeneration: 5
  }), true)
  assert.equal(shouldIgnoreCanvasRefreshAfterFetch({
    ...stable,
    currentRevision: 'revision-local-save'
  }), true)
  assert.equal(shouldIgnoreCanvasRefreshAfterFetch({
    ...stable,
    hasPendingScene: true
  }), true)
  assert.equal(shouldIgnoreCanvasRefreshAfterFetch({
    ...stable,
    saveInFlight: true
  }), true)
  assert.equal(shouldIgnoreCanvasRefreshAfterFetch({
    ...stable,
    hasSaveConflict: true
  }), true)
  assert.equal(shouldIgnoreCanvasRefreshAfterFetch({
    ...stable,
    canvasOperationChanged: true
  }), true)
})

test('CAS conflict retention keeps the newest exact local scene', () => {
  const failed = { canvasId: 'canvas-a', generation: 3, signature: 'failed' }
  const editedAgain = { canvasId: 'canvas-a', generation: 4, signature: 'newer' }
  assert.equal(newestCowartPendingScene(failed, null), failed)
  assert.equal(newestCowartPendingScene(failed, editedAgain), editedAgain)
  assert.equal(newestCowartPendingScene(editedAgain, failed), editedAgain)
})

test('per-canvas Excalidraw view state restores only the camera fields', () => {
  const document = {
    elements: [{ id: 'shape-a' }],
    appState: {
      viewBackgroundColor: '#fafafa',
      gridSize: 20,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 }
    },
    files: {}
  }
  const viewState = cowartExcalidrawViewState('canvas-a', {
    scrollX: 128,
    scrollY: -64,
    zoom: { value: 1.75 }
  }, '2026-09-02T00:00:00.000Z')
  const restored = mergeCowartExcalidrawViewState(document, viewState, 'canvas-a')

  assert.notEqual(restored, document)
  assert.deepEqual(restored.elements, document.elements)
  assert.equal(restored.appState.viewBackgroundColor, '#fafafa')
  assert.equal(restored.appState.gridSize, 20)
  assert.equal(restored.appState.scrollX, 128)
  assert.equal(restored.appState.scrollY, -64)
  assert.equal(restored.appState.zoom.value, 1.75)

  assert.equal(mergeCowartExcalidrawViewState(document, viewState, 'canvas-b'), document)
  assert.equal(mergeCowartExcalidrawViewState(document, {
    version: 1,
    currentPageId: null,
    camera: { x: 0, y: 0, z: 1 },
    updatedAt: null
  }, 'canvas-a'), document)
})

test('native editor fails closed and exposes retained conflict retry wiring', async () => {
  const source = await readFile(new URL('../src/NativeExcalidrawApp.jsx', import.meta.url), 'utf8')
  assert.match(source, /setEditorSession\(null\)/)
  assert.match(source, /setCanvasLoadError\(\{/)
  assert.doesNotMatch(source, /catch \(error\) \{[\s\S]{0,900}snapshot: emptyExcalidrawDocument\(\)/)
  assert.match(source, /const isExplicitEmptyProject = isExplicitEmptyCowartCanvasState\(state\)/)
  assert.match(source, /const normalizedDocument = isExplicitEmptyProject[\s\S]*emptyExcalidrawDocument\(\)/)
  assert.match(source, /registerSaveConflict\(pending\.canvasId, retained, error\)/)
  assert.match(source, /conflictRetry: conflict/)
  assert.match(source, /保存本地版本/)
  assert.match(source, /shouldIgnoreCanvasRefreshAfterFetch\(\{[\s\S]*generationBeforeFetch/)
})

test('only the complete successful empty-workspace contract may open a blank scene', () => {
  const canvas = {
    id: 'canvas_main',
    name: '主画布',
    parentId: null,
    order: 0,
    createdAt: null,
    updatedAt: null
  }
  const successfulEmptyState = {
    snapshot: null,
    storage: 'empty',
    revision: '44136fa355b3678a1146',
    canvasId: 'canvas_main',
    canvas,
    project: {
      type: 'yogurt-canvas-project',
      version: 1,
      createdAt: null,
      updatedAt: null,
      activeCanvasId: 'canvas_main',
      canvases: [canvas]
    }
  }

  assert.equal(isExplicitEmptyCowartCanvasState(successfulEmptyState), true)
  assert.equal(isExplicitEmptyCowartCanvasState({
    ...successfulEmptyState,
    storage: 'invalid'
  }), false)
  assert.equal(isExplicitEmptyCowartCanvasState({
    ...successfulEmptyState,
    revision: null
  }), false)
  assert.equal(isExplicitEmptyCowartCanvasState({
    snapshot: null,
    storage: 'empty'
  }), false)
})

test('all App canvas writes flow through the revision-aware save state machine', async () => {
  const appSource = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const directSaves = appSource.match(/saveCowartCanvasSnapshot\(/g) ?? []
  assert.equal(directSaves.length, 1)
  assert.match(appSource, /baseRevision:\s*canvasRevisionRef\.current/)
  assert.match(appSource, /const flushCanvasSnapshot = cowartCanvasSnapshotFlushers\.get\(editor\)/)
})
