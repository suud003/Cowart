import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  COWART_AI_MODE_STORAGE_KEY,
  isCowartAiOnlyTool,
  normalizeCowartAiMode,
  persistCowartAiMode,
  readCowartAiMode
} from '../src/aiMode.js'

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

function memoryStorage(initialValue = null) {
  let value = initialValue
  return {
    getItem(key) {
      assert.equal(key, COWART_AI_MODE_STORAGE_KEY)
      return value
    },
    setItem(key, nextValue) {
      assert.equal(key, COWART_AI_MODE_STORAGE_KEY)
      value = nextValue
    },
    value() {
      return value
    }
  }
}

test('AI mode is opt-in and persists an explicit on/off preference', () => {
  assert.equal(normalizeCowartAiMode(null), false)
  assert.equal(normalizeCowartAiMode('off'), false)
  assert.equal(normalizeCowartAiMode('on'), true)
  assert.equal(normalizeCowartAiMode(true), true)

  const storage = memoryStorage()
  assert.equal(readCowartAiMode(storage), false)
  assert.equal(persistCowartAiMode(true, storage), true)
  assert.equal(storage.value(), 'on')
  assert.equal(readCowartAiMode(storage), true)
  assert.equal(persistCowartAiMode(false, storage), false)
  assert.equal(storage.value(), 'off')
})

test('AI mode safely stays off when browser storage is unavailable', () => {
  const blockedStorage = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    }
  }
  assert.equal(readCowartAiMode(blockedStorage), false)
  assert.equal(persistCowartAiMode(true, blockedStorage), true)
})

test('AI mode catches a browser that blocks the localStorage getter itself', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('security error')
    }
  })
  try {
    assert.equal(readCowartAiMode(), false)
    assert.equal(persistCowartAiMode(true), true)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})

test('only Yogurt AI tools are removed when switching back to the pure canvas', () => {
  for (const toolId of ['cowart-agent-lasso', 'cowart-annotation', 'ai-image', 'ai-draft', 'ai-slides']) {
    assert.equal(isCowartAiOnlyTool(toolId), true)
  }
  for (const toolId of ['select', 'draw', 'arrow', 'text', 'frame']) {
    assert.equal(isCowartAiOnlyTool(toolId), false)
  }
})

test('the renderer gates the complete AI shell and restores native drawing components', async () => {
  const [appSource, chromeSource, desktopSource, theme] = await Promise.all([
    readProjectFile('src/App.jsx'),
    readProjectFile('src/YogurtAppChrome.jsx'),
    readProjectFile('desktop/main.mjs'),
    readProjectFile('src/atelierTheme.css')
  ])

  assert.match(appSource, /useState\(readCowartAiMode\)/)
  assert.match(appSource, /isAiModeEnabled && \(\s*<YogurtSideRail/s)
  assert.match(appSource, /isAiModeEnabled && \(\s*<YogurtAppChrome/s)
  assert.match(appSource, /isAiModeEnabled && \(\s*<CowartAgentPanel/s)
  assert.match(appSource, /components=\{isAiModeEnabled \? cowartComponents : cowartNativeComponents\}/)
  assert.match(appSource, /const cowartTools = Object\.freeze\(\[CowartAnnotationTool, CowartAgentLassoTool\]\)/)
  assert.match(appSource, /tools=\{cowartTools\}/)
  assert.doesNotMatch(appSource, /tools=\{isAiModeEnabled \?/)
  assert.match(appSource, /CowartFrameShapeUtilBase\.configure\(\{ showColors: true \}\)/)
  assert.match(appSource, /<DefaultStylePanelContent \/>/)
  assert.match(appSource, /<CowartLabelColorStyleControls \/>/)
  assert.match(chromeSource, /onAiModeChange\(false\)/)
  assert.match(desktopSource, /pureCanvasReady/)
  assert.ok(
    desktopSource.indexOf("document.querySelector('.cowart-ai-mode-entry')?.click()") <
      desktopSource.indexOf("document.querySelector('.yogurt-app-agent-toggle')"),
    'the packaged smoke test must enable AI before opening the Agent panel'
  )
  assert.match(theme, /\.cowart-native-workbench\s*\{/)
  assert.doesNotMatch(theme, /\.cowart-canvas \.tlui-style-panel[^}]*display:\s*none/s)
})
