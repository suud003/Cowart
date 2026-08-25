import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createTLSchema } from '@tldraw/tlschema'

import {
  cowartSnapshotRevision,
  readCowartCanvasState,
  saveCowartCanvasSnapshot
} from '../mcp/lib/canvas-storage.mjs'
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
