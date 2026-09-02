import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTLSchema } from '@tldraw/tlschema'

import {
  cowartSnapshotRevision,
  readCowartCanvasState,
  readCowartSelectionState,
  readCowartViewState,
  saveCowartCanvasSnapshot,
  writeCowartSelectionState,
  writeCowartViewState
} from '../mcp/lib/canvas-storage.mjs'
import { createCowartCanvas } from '../mcp/lib/canvas-project-storage.mjs'
import {
  applyThinkingOperationsToSnapshot,
  snapshotRevision
} from '../mcp/lib/thinking-canvas.mjs'

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII='

function snapshotWithPageName(name) {
  return {
    schema: createTLSchema().serialize(),
    store: {
      'page:test': {
        id: 'page:test',
        typeName: 'page',
        name,
        index: 'a0',
        meta: {}
      }
    }
  }
}

function excalidrawScene(label, elements = null) {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/suud003/Cowart',
    elements: elements ?? [
      {
        id: `element-${label}`,
        type: 'rectangle',
        x: 20,
        y: 30,
        width: 240,
        height: 120,
        strokeColor: '#1b1b1f',
        backgroundColor: 'transparent',
        version: 1,
        versionNonce: 101
      }
    ],
    appState: {
      viewBackgroundColor: '#ffffff',
      name: label
    },
    files: {}
  }
}

function multiPageSnapshotWithCards() {
  const initial = {
    schema: createTLSchema().serialize(),
    store: {
      'page:one': {
        id: 'page:one',
        typeName: 'page',
        name: 'One',
        index: 'a0',
        meta: {}
      },
      'page:two': {
        id: 'page:two',
        typeName: 'page',
        name: 'Two',
        index: 'a1',
        meta: {}
      }
    }
  }
  const first = applyThinkingOperationsToSnapshot({
    snapshot: initial,
    pageId: 'page:one',
    operations: [{ type: 'create_card', key: 'one', title: 'One card' }]
  })
  return applyThinkingOperationsToSnapshot({
    snapshot: first.snapshot,
    pageId: 'page:two',
    operations: [{ type: 'create_card', key: 'two', title: 'Two card' }]
  }).snapshot
}

function snapshotWithDataAsset() {
  return {
    schema: createTLSchema().serialize(),
    store: {
      'page:test': {
        id: 'page:test',
        typeName: 'page',
        name: 'Test',
        index: 'a0',
        meta: {}
      },
      'asset:test': {
        id: 'asset:test',
        typeName: 'asset',
        type: 'image',
        props: {
          name: 'asset-test.png',
          src: ONE_PIXEL_PNG,
          w: 1,
          h: 1,
          fileSize: 68,
          mimeType: 'image/png',
          isAnimated: false
        },
        meta: {}
      },
      'shape:image': {
        id: 'shape:image',
        typeName: 'shape',
        type: 'image',
        parentId: 'page:test',
        index: 'a1',
        x: 0,
        y: 0,
        rotation: 0,
        isLocked: false,
        opacity: 1,
        props: {
          w: 1,
          h: 1,
          assetId: 'asset:test',
          playing: true,
          url: '',
          crop: null,
          flipX: false,
          flipY: false,
          altText: 'Test image'
        },
        meta: {}
      }
    }
  }
}

function startCrossProcessSave({ projectDir, baseRevision, barrierPath, variant }) {
  const storageModuleUrl = new URL('../mcp/lib/canvas-storage.mjs', import.meta.url).href
  const childSource = `
    import { existsSync } from 'node:fs';
    import { setTimeout as wait } from 'node:timers/promises';
    import { createTLSchema } from '@tldraw/tlschema';
    import { saveCowartCanvasSnapshot } from ${JSON.stringify(storageModuleUrl)};

    const projectDir = process.env.COWART_CAS_PROJECT_DIR;
    const baseRevision = process.env.COWART_CAS_BASE_REVISION;
    const barrierPath = process.env.COWART_CAS_BARRIER_PATH;
    const variant = process.env.COWART_CAS_VARIANT;
    const payload = variant + ':' + 'x'.repeat(2_000_000);
    const snapshot = {
      schema: createTLSchema().serialize(),
      store: {
        'page:one': { id: 'page:one', typeName: 'page', name: variant + ' one', index: 'a0', meta: { payload } },
        'page:two': { id: 'page:two', typeName: 'page', name: variant + ' two', index: 'a1', meta: { payload } }
      }
    };

    process.stdout.write('READY\\n');
    while (!existsSync(barrierPath)) await wait(5);
    const result = await saveCowartCanvasSnapshot({ projectDir, baseRevision }, snapshot);
    process.stdout.write('RESULT ' + JSON.stringify(result) + '\\n');
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COWART_CAS_PROJECT_DIR: projectDir,
      COWART_CAS_BASE_REVISION: baseRevision,
      COWART_CAS_BARRIER_PATH: barrierPath,
      COWART_CAS_VARIANT: variant
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let readyResolve
  let readyReject
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady
    readyReject = rejectReady
  })
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
    if (stdout.includes('READY\n')) readyResolve()
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const result = new Promise((resolveResult, rejectResult) => {
    child.once('error', (error) => {
      readyReject(error)
      rejectResult(error)
    })
    child.once('exit', (code) => {
      if (code !== 0) {
        const error = new Error(`Canvas save child exited ${code}: ${stderr || stdout}`)
        readyReject(error)
        rejectResult(error)
        return
      }
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('RESULT '))
      if (!line) {
        rejectResult(new Error(`Canvas save child did not return a result: ${stderr || stdout}`))
        return
      }
      resolveResult(JSON.parse(line.slice('RESULT '.length)))
    })
  })
  return { child, ready, result }
}

test('snapshot revisions ignore JSON object insertion order across canvas consumers', () => {
  const first = snapshotWithPageName('Stable')
  first.store['page:test'].meta = { z: { second: 2, first: 1 }, a: true }
  const second = {
    schema: first.schema,
    store: {
      'page:test': {
        meta: { a: true, z: { first: 1, second: 2 } },
        index: 'a0',
        name: 'Stable',
        typeName: 'page',
        id: 'page:test'
      }
    }
  }

  assert.equal(cowartSnapshotRevision(first), cowartSnapshotRevision(second))
  assert.equal(snapshotRevision(first), cowartSnapshotRevision(first))

  const changedPrototypeKey = structuredClone(second)
  changedPrototypeKey.store['page:test'].meta = JSON.parse('{"__proto__":{"value":1}}')
  assert.notEqual(cowartSnapshotRevision(second), cowartSnapshotRevision(changedPrototypeKey))
})

test('Excalidraw revisions canonicalize object keys but preserve element z-order', () => {
  const back = {
    id: 'back',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    version: 1
  }
  const front = {
    id: 'front',
    type: 'text',
    x: 20,
    y: 20,
    width: 100,
    height: 30,
    text: 'Front',
    version: 1
  }
  const first = excalidrawScene('Stable', [back, front])
  first.files = { image: { mimeType: 'image/png', id: 'image' } }

  const sameSceneWithDifferentObjectKeyOrder = {
    files: { image: { id: 'image', mimeType: 'image/png' } },
    appState: { name: 'Stable', viewBackgroundColor: '#ffffff' },
    elements: [
      {
        version: 1,
        height: 100,
        width: 200,
        y: 0,
        x: 0,
        type: 'rectangle',
        id: 'back'
      },
      {
        version: 1,
        text: 'Front',
        height: 30,
        width: 100,
        y: 20,
        x: 20,
        type: 'text',
        id: 'front'
      }
    ],
    source: first.source,
    version: 2,
    type: 'excalidraw'
  }

  assert.equal(
    cowartSnapshotRevision(first),
    cowartSnapshotRevision(sameSceneWithDifferentObjectKeyOrder)
  )

  const reordered = structuredClone(first)
  reordered.elements.reverse()
  assert.notEqual(cowartSnapshotRevision(first), cowartSnapshotRevision(reordered))
})

test('Excalidraw scenes save atomically to the active project canvas and take read priority', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-excalidraw-priority-'))
  try {
    const legacySnapshot = snapshotWithPageName('Legacy tldraw page')
    const legacySave = await saveCowartCanvasSnapshot({ projectDir }, legacySnapshot)
    assert.equal(legacySave.ok, true)

    const canvasDir = path.join(projectDir, 'canvas')
    const legacySingleFile = path.join(canvasDir, 'cowart-canvas.json')
    await writeFile(legacySingleFile, `${JSON.stringify(legacySnapshot, null, 2)}\n`)
    const legacyPageFile = legacySave.paths[0]
    const legacySingleBefore = await readFile(legacySingleFile, 'utf8')
    const legacyPageBefore = await readFile(legacyPageFile, 'utf8')

    const beforeMigration = await readCowartCanvasState({ projectDir })
    assert.equal(beforeMigration.storage, 'per-page')

    const scene = excalidrawScene('Native scene')
    const saved = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: beforeMigration.revision },
      scene
    )
    const scenePath = path.join(canvasDir, 'canvases', 'canvas_main', 'scene.excalidraw')
    assert.equal(saved.ok, true)
    assert.equal(saved.storage, 'excalidraw')
    assert.deepEqual(saved.paths, [scenePath])
    assert.deepEqual(JSON.parse(await readFile(scenePath, 'utf8')), scene)

    const storedNames = await readdir(canvasDir)
    assert.equal(storedNames.some((name) => name.endsWith('.tmp')), false)

    const loaded = await readCowartCanvasState({ projectDir })
    assert.equal(loaded.storage, 'excalidraw')
    assert.equal(loaded.path, scenePath)
    assert.deepEqual(loaded.snapshot, scene)
    assert.equal(loaded.revision, saved.revision)

    assert.equal(await readFile(legacySingleFile, 'utf8'), legacySingleBefore)
    assert.equal(await readFile(legacyPageFile, 'utf8'), legacyPageBefore)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('Excalidraw hydrateAssets reads native files without tldraw assumptions', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-excalidraw-hydrate-'))
  try {
    const scene = excalidrawScene('Hydrated')
    scene.files = {
      'file-1': {
        id: 'file-1',
        mimeType: 'image/png',
        dataURL: ONE_PIXEL_PNG,
        created: 1
      }
    }
    const saved = await saveCowartCanvasSnapshot({ projectDir }, scene)
    assert.equal(saved.ok, true)

    const hydrated = await readCowartCanvasState({ projectDir }, { hydrateAssets: true })
    assert.deepEqual(hydrated.snapshot, scene)
    assert.deepEqual(hydrated.hydratedAssets, [])
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('Excalidraw saves enforce CAS and keep the winning scene intact', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-excalidraw-cas-'))
  try {
    const initial = await readCowartCanvasState({ projectDir })
    const winner = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: initial.revision },
      excalidrawScene('Winner')
    )
    assert.equal(winner.ok, true)

    const stale = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: initial.revision },
      excalidrawScene('Stale')
    )
    assert.equal(stale.ok, false)
    assert.equal(stale.storage, 'revision-conflict')
    assert.equal(stale.expectedRevision, initial.revision)
    assert.equal(stale.currentRevision, winner.revision)

    const persisted = await readCowartCanvasState({ projectDir })
    assert.equal(persisted.snapshot.appState.name, 'Winner')
    assert.equal(persisted.revision, winner.revision)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('multi-canvas Excalidraw scenes stay isolated and explicit reads identify their canvas', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-excalidraw-multi-canvas-'))
  try {
    const initial = await readCowartCanvasState({ projectDir })
    const rootSave = await saveCowartCanvasSnapshot(
      { projectDir, canvasId: 'canvas_main', baseRevision: initial.revision },
      excalidrawScene('Root scene')
    )
    assert.equal(rootSave.ok, true)
    assert.equal(rootSave.canvasId, 'canvas_main')

    const childCreated = await createCowartCanvas(
      { projectDir },
      {
        canvasId: 'canvas_child',
        name: 'Child scene',
        parentId: 'canvas_main',
        baseProjectRevision: rootSave.projectRevision
      }
    )
    const childInitial = await readCowartCanvasState({ projectDir, canvasId: 'canvas_child' })
    const childSave = await saveCowartCanvasSnapshot(
      { projectDir, canvasId: 'canvas_child', baseRevision: childInitial.revision },
      excalidrawScene('Child scene')
    )
    assert.equal(childSave.ok, true)
    assert.equal(childSave.projectRevision, childCreated.projectRevision)

    const [root, child] = await Promise.all([
      readCowartCanvasState({ projectDir, canvasId: 'canvas_main' }),
      readCowartCanvasState({ projectDir, canvasId: 'canvas_child' })
    ])
    assert.equal(root.canvasId, 'canvas_main')
    assert.equal(root.canvas.name, '主画布')
    assert.equal(root.snapshot.appState.name, 'Root scene')
    assert.equal(child.canvasId, 'canvas_child')
    assert.equal(child.canvas.parentId, 'canvas_main')
    assert.equal(child.snapshot.appState.name, 'Child scene')
    assert.notEqual(root.path, child.path)

    await assert.rejects(
      readCowartCanvasState({ projectDir }, { requireExplicitCanvasId: true }),
      (error) => error.code === 'COWART_CANVAS_ID_REQUIRED'
    )
    await assert.rejects(
      readCowartCanvasState({ projectDir, canvasId: 'canvas_missing' }),
      (error) => error.code === 'COWART_CANVAS_NOT_FOUND'
    )
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('selection and view state are persisted independently for every project canvas', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-canvas-local-state-'))
  try {
    const initial = await readCowartCanvasState({ projectDir })
    const rootSave = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: initial.revision },
      excalidrawScene('Root')
    )
    await createCowartCanvas(
      { projectDir },
      {
        canvasId: 'canvas_child',
        parentId: 'canvas_main',
        baseProjectRevision: rootSave.projectRevision
      }
    )

    await Promise.all([
      writeCowartSelectionState(
        { projectDir, canvasId: 'canvas_main' },
        { selectedShapes: ['root-shape'] }
      ),
      writeCowartSelectionState(
        { projectDir, canvasId: 'canvas_child' },
        { selectedShapes: ['child-shape'] }
      ),
      writeCowartViewState(
        { projectDir, canvasId: 'canvas_main' },
        { version: 1, currentPageId: null, camera: { x: 10, y: 20, z: 1 } }
      ),
      writeCowartViewState(
        { projectDir, canvasId: 'canvas_child' },
        { version: 1, currentPageId: null, camera: { x: 30, y: 40, z: 2 } }
      )
    ])

    const [rootSelection, childSelection, rootView, childView] = await Promise.all([
      readCowartSelectionState({ projectDir, canvasId: 'canvas_main' }),
      readCowartSelectionState({ projectDir, canvasId: 'canvas_child' }),
      readCowartViewState({ projectDir, canvasId: 'canvas_main' }),
      readCowartViewState({ projectDir, canvasId: 'canvas_child' })
    ])
    assert.deepEqual(rootSelection.selection.selectedShapes, ['root-shape'])
    assert.deepEqual(childSelection.selection.selectedShapes, ['child-shape'])
    assert.equal(rootView.viewState.camera.x, 10)
    assert.equal(childView.viewState.camera.x, 30)
    assert.match(rootSelection.selectionFile, /canvases[\\/]canvas_main[\\/]selection\.json$/)
    assert.match(childView.viewStateFile, /canvases[\\/]canvas_child[\\/]view-state\.json$/)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('different canvases can save concurrently even when their scene revisions are identical', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-canvas-parallel-scenes-'))
  try {
    const initial = await readCowartCanvasState({ projectDir })
    const rootSave = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: initial.revision },
      excalidrawScene('Root seed')
    )
    await createCowartCanvas(
      { projectDir },
      {
        canvasId: 'canvas_child',
        parentId: 'canvas_main',
        baseProjectRevision: rootSave.projectRevision
      }
    )

    const root = await readCowartCanvasState({ projectDir, canvasId: 'canvas_main' })
    const child = await readCowartCanvasState({ projectDir, canvasId: 'canvas_child' })
    const [savedRoot, savedChild] = await Promise.all([
      saveCowartCanvasSnapshot(
        { projectDir, canvasId: 'canvas_main', baseRevision: root.revision },
        excalidrawScene('Root concurrent')
      ),
      saveCowartCanvasSnapshot(
        { projectDir, canvasId: 'canvas_child', baseRevision: child.revision },
        excalidrawScene('Child concurrent')
      )
    ])
    assert.equal(savedRoot.ok, true)
    assert.equal(savedChild.ok, true)
    assert.equal(
      (await readCowartCanvasState({ projectDir, canvasId: 'canvas_main' })).snapshot.appState.name,
      'Root concurrent'
    )
    assert.equal(
      (await readCowartCanvasState({ projectDir, canvasId: 'canvas_child' })).snapshot.appState.name,
      'Child concurrent'
    )
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('Vite canvas API persists Excalidraw scenes and returns HTTP 409 for stale CAS', { timeout: 20_000 }, async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-excalidraw-vite-cas-'))
  const previousProjectDir = process.env.COWART_PROJECT_DIR
  let server
  try {
    process.env.COWART_PROJECT_DIR = projectDir
    const { createServer } = await import('vite')
    server = await createServer({
      configFile: path.resolve('vite.config.js'),
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0 }
    })
    await server.listen()
    const address = server.httpServer.address()
    assert.equal(typeof address, 'object')
    const endpoint = `http://127.0.0.1:${address.port}/api/canvas`

    const initialResponse = await fetch(endpoint)
    assert.equal(initialResponse.status, 200)
    const initial = await initialResponse.json()
    assert.equal(typeof initial.revision, 'string')

    const winnerResponse = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshot: excalidrawScene('Vite winner'),
        baseRevision: initial.revision
      })
    })
    assert.equal(winnerResponse.status, 200)
    const winner = await winnerResponse.json()
    assert.equal(winner.ok, true)
    assert.equal(winner.storage, 'excalidraw')

    const staleResponse = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshot: excalidrawScene('Vite stale'),
        baseRevision: initial.revision
      })
    })
    assert.equal(staleResponse.status, 409)
    const stale = await staleResponse.json()
    assert.equal(stale.ok, false)
    assert.equal(stale.storage, 'revision-conflict')
    assert.equal(stale.currentRevision, winner.revision)

    const persistedResponse = await fetch(`${endpoint}?hydrateAssets=true`)
    assert.equal(persistedResponse.status, 200)
    const persisted = await persistedResponse.json()
    assert.equal(persisted.snapshot.appState.name, 'Vite winner')
    assert.equal(persisted.revision, winner.revision)
    assert.deepEqual(persisted.hydratedAssets, [])

    const projectEndpoint = `http://127.0.0.1:${address.port}/api/canvas-project`
    const createdResponse = await fetch(projectEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        canvasId: 'canvas_child',
        name: 'Child',
        parentId: 'canvas_main',
        activate: false,
        baseProjectRevision: winner.projectRevision
      })
    })
    assert.equal(createdResponse.status, 200)
    const created = await createdResponse.json()
    assert.equal(created.canvas.id, 'canvas_child')

    const childResponse = await fetch(`${endpoint}?canvasId=canvas_child`)
    assert.equal(childResponse.status, 200)
    const child = await childResponse.json()
    assert.equal(child.canvasId, 'canvas_child')
    assert.equal(child.snapshot.elements.length, 0)

    const childSaveResponse = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: 'canvas_child',
        snapshot: excalidrawScene('Vite child'),
        baseRevision: child.revision
      })
    })
    assert.equal(childSaveResponse.status, 200)
    assert.equal((await childSaveResponse.json()).canvasId, 'canvas_child')
    assert.equal(
      (await (await fetch(`${endpoint}?canvasId=canvas_main`)).json()).snapshot.appState.name,
      'Vite winner'
    )

    const selectionEndpoint = `http://127.0.0.1:${address.port}/api/selection`
    const selectionWrite = await fetch(selectionEndpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: 'canvas_child', selectedShapes: ['shape:child'] })
    })
    assert.equal(selectionWrite.status, 200)
    const selected = await (await fetch(`${selectionEndpoint}?canvasId=canvas_child`)).json()
    assert.deepEqual(selected.selection.selectedShapes, ['shape:child'])

    const viewEndpoint = `http://127.0.0.1:${address.port}/api/view-state`
    const viewWrite = await fetch(viewEndpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        canvasId: 'canvas_child',
        version: 1,
        currentPageId: 'canvas_child',
        camera: { x: 12, y: 34, z: 1.5 }
      })
    })
    assert.equal(viewWrite.status, 200)
    const childView = await (await fetch(`${viewEndpoint}?canvasId=canvas_child`)).json()
    assert.deepEqual(childView.viewState.camera, { x: 12, y: 34, z: 1.5 })

    const staleProjectResponse = await fetch(projectEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        canvasId: 'canvas_stale',
        baseProjectRevision: winner.projectRevision
      })
    })
    assert.equal(staleProjectResponse.status, 409)
    const staleProject = await staleProjectResponse.json()
    assert.equal(staleProject.code, 'COWART_PROJECT_REVISION_CONFLICT')
  } finally {
    await server?.close()
    if (previousProjectDir === undefined) delete process.env.COWART_PROJECT_DIR
    else process.env.COWART_PROJECT_DIR = previousProjectDir
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('multi-page persistence returns the same canonical revision that the next read observes', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-canvas-multi-page-revision-'))
  try {
    const initial = await readCowartCanvasState({ projectDir })
    const snapshot = multiPageSnapshotWithCards()
    const saved = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: initial.revision },
      snapshot
    )
    assert.equal(saved.ok, true)

    const persisted = await readCowartCanvasState({ projectDir })
    assert.equal(saved.revision, persisted.revision)
    assert.notDeepEqual(Object.keys(snapshot.store), Object.keys(persisted.snapshot.store))

    const repeated = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: saved.revision },
      snapshot
    )
    assert.equal(repeated.ok, true)
    assert.equal(repeated.revision, saved.revision)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('asset localization returns the persisted revision instead of the data URL revision', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-canvas-asset-revision-'))
  try {
    const initial = await readCowartCanvasState({ projectDir })
    const snapshot = snapshotWithDataAsset()
    const saved = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: initial.revision },
      snapshot
    )
    assert.equal(saved.ok, true)

    const persisted = await readCowartCanvasState({ projectDir })
    assert.equal(saved.revision, persisted.revision)
    assert.equal(
      persisted.snapshot.store['asset:test'].props.src,
      '/page-assets/test/asset-test.png'
    )

    const repeated = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: saved.revision },
      snapshot
    )
    assert.equal(repeated.ok, true)
    assert.equal(repeated.revision, saved.revision)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('canvas saves reject stale revisions instead of overwriting Agent changes', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-canvas-cas-'))
  try {
    const initial = await readCowartCanvasState({ projectDir })
    assert.equal(typeof initial.revision, 'string')

    const firstSave = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: initial.revision },
      snapshotWithPageName('Agent result')
    )
    assert.equal(firstSave.ok, true)
    assert.notEqual(firstSave.revision, initial.revision)

    const staleSave = await saveCowartCanvasSnapshot(
      { projectDir, baseRevision: initial.revision },
      snapshotWithPageName('Stale renderer')
    )
    assert.equal(staleSave.ok, false)
    assert.equal(staleSave.storage, 'revision-conflict')
    assert.equal(staleSave.currentRevision, firstSave.revision)

    const persisted = await readCowartCanvasState({ projectDir })
    assert.equal(persisted.snapshot.store['page:test'].name, 'Agent result')
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('concurrent canvas saves serialize the revision check with the write', async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-canvas-concurrent-cas-'))
  try {
    const initial = await readCowartCanvasState({ projectDir })
    const [agentSave, rendererSave] = await Promise.all([
      saveCowartCanvasSnapshot(
        { projectDir, baseRevision: initial.revision },
        snapshotWithPageName('Agent result')
      ),
      saveCowartCanvasSnapshot(
        { projectDir, baseRevision: initial.revision },
        snapshotWithPageName('Renderer result')
      )
    ])

    const successful = [agentSave, rendererSave].filter((result) => result.ok)
    const conflicted = [agentSave, rendererSave].filter(
      (result) => !result.ok && result.storage === 'revision-conflict'
    )
    assert.equal(successful.length, 1)
    assert.equal(conflicted.length, 1)
    assert.equal(conflicted[0].currentRevision, successful[0].revision)

    const persisted = await readCowartCanvasState({ projectDir })
    assert.equal(
      persisted.snapshot.store['page:test'].name,
      successful[0] === agentSave ? 'Agent result' : 'Renderer result'
    )
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
})

test('independent canvas processes serialize CAS by canvas directory', { timeout: 30_000 }, async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), 'yogurt-canvas-process-cas-'))
  const barrierPath = path.join(projectDir, 'start-canvas-save')
  const children = []
  try {
    const initial = await readCowartCanvasState({ projectDir })
    children.push(
      startCrossProcessSave({
        projectDir,
        baseRevision: initial.revision,
        barrierPath,
        variant: 'Agent'
      }),
      startCrossProcessSave({
        projectDir,
        baseRevision: initial.revision,
        barrierPath,
        variant: 'Renderer'
      })
    )
    await Promise.all(children.map((entry) => entry.ready))
    await writeFile(barrierPath, 'go\n')

    const results = await Promise.all(children.map((entry) => entry.result))
    const successful = results.filter((result) => result.ok)
    const conflicted = results.filter(
      (result) => !result.ok && result.storage === 'revision-conflict'
    )
    assert.equal(successful.length, 1)
    assert.equal(conflicted.length, 1)
    assert.equal(conflicted[0].currentRevision, successful[0].revision)

    const persisted = await readCowartCanvasState({ projectDir })
    const winner = results[0].ok ? 'Agent' : 'Renderer'
    assert.equal(persisted.snapshot.store['page:one'].name, `${winner} one`)
    assert.equal(persisted.revision, successful[0].revision)
  } finally {
    for (const entry of children) {
      if (entry.child.exitCode === null) entry.child.kill()
    }
    await rm(projectDir, { recursive: true, force: true })
  }
})
