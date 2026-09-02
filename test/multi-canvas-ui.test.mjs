import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('the official Excalidraw editor hosts a hierarchical multi-canvas sidebar', async () => {
  const [appSource, navigatorSource] = await Promise.all([
    readProjectFile('src/NativeExcalidrawApp.jsx'),
    readProjectFile('src/CanvasNavigator.jsx')
  ])

  assert.match(appSource, /<Sidebar[\s\S]*name="yogurt-canvases"/)
  assert.match(appSource, /<Sidebar\.Trigger/)
  assert.match(appSource, /key=\{editorSession\.canvasId\}/)
  assert.match(appSource, /loadCowartCanvasState\(\{ canvasId \}\)/)
  assert.match(appSource, /setActiveCowartCanvas\(canvasId/)
  assert.match(navigatorSource, /role="tree"/)
  assert.match(navigatorSource, /role="treeitem"/)
  assert.match(navigatorSource, /onMove\(draggedCanvasId, canvas\.id\)/)
})

test('scene saves and Agent context remain bound to the originating canvas', async () => {
  const appSource = await readProjectFile('src/NativeExcalidrawApp.jsx')

  assert.match(appSource, /const pending = \{ canvasId, elements, appState, files, signature, generation \}/)
  assert.match(appSource, /canvasId: pending\.canvasId/)
  assert.match(appSource, /const canvasId = activeCanvasIdRef\.current[\s\S]*const context = createAgentContext/)
  assert.match(appSource, /saveCowartSelectionState\(selection, \{ canvasId \}\)/)
  assert.match(appSource, /activeCanvasIdRef\.current !== canvasId/)
})
