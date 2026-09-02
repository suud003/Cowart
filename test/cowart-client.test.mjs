import assert from 'node:assert/strict'
import test from 'node:test'

import { loadCowartCanvasState } from '../src/cowartClient.js'

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload
  }
}

test('HTTP canvas load uses the view state returned by the same canvas response', async () => {
  const previousWindow = globalThis.window
  const calls = []
  globalThis.window = {
    fetch: async (url) => {
      calls.push(String(url))
      return jsonResponse({
        canvasId: 'canvas_child',
        canvas: { id: 'canvas_child', name: 'Child' },
        snapshot: { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} },
        revision: 'revision-child',
        viewState: {
          version: 1,
          currentPageId: 'canvas_child',
          camera: { x: 44, y: -18, z: 1.4 },
          updatedAt: '2026-09-02T00:00:00.000Z'
        }
      })
    }
  }

  try {
    const state = await loadCowartCanvasState()
    assert.deepEqual(calls, ['/api/canvas'])
    assert.equal(state.canvasId, 'canvas_child')
    assert.equal(state.viewState.camera.x, 44)
  } finally {
    globalThis.window = previousWindow
  }
})

test('legacy HTTP canvas load scopes its fallback view request to the resolved canvas', async () => {
  const previousWindow = globalThis.window
  const calls = []
  globalThis.window = {
    fetch: async (url) => {
      calls.push(String(url))
      if (String(url) === '/api/canvas') {
        return jsonResponse({
          canvasId: 'canvas_child',
          canvas: { id: 'canvas_child', name: 'Child' },
          snapshot: { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} },
          revision: 'revision-child'
        })
      }
      return jsonResponse({
        viewState: {
          version: 1,
          currentPageId: 'canvas_child',
          camera: { x: 12, y: 34, z: 1.2 },
          updatedAt: '2026-09-02T00:00:00.000Z'
        }
      })
    }
  }

  try {
    const state = await loadCowartCanvasState()
    assert.deepEqual(calls, [
      '/api/canvas',
      '/api/view-state?canvasId=canvas_child'
    ])
    assert.equal(state.viewState.camera.y, 34)
  } finally {
    globalThis.window = previousWindow
  }
})
