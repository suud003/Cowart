import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AI_MODE_TOGGLE_ACCELERATOR,
  AI_MODE_TOGGLE_CHANNEL,
  createYogurtApplicationMenuTemplate,
  installYogurtApplicationMenu,
  sendAiModeToggle
} from '../desktop/ai-mode-menu.mjs'

test('native Yogurt AI menu toggles AI mode without adding canvas UI', () => {
  let toggled = 0
  const template = createYogurtApplicationMenuTemplate({
    platform: 'win32',
    onToggleAiMode: () => { toggled += 1 }
  })
  const yogurtMenu = template.find((item) => item.label === 'Yogurt AI')
  const toggle = yogurtMenu.submenu.find((item) => item.id === 'yogurt-ai-toggle-mode')

  assert.equal(toggle.label, '切换 AI 模式')
  assert.equal(toggle.accelerator, AI_MODE_TOGGLE_ACCELERATOR)
  toggle.click()
  assert.equal(toggled, 1)
})

test('native menu sends a narrow, one-way toggle event to the active renderer', () => {
  const messages = []
  const window = {
    webContents: {
      isDestroyed: () => false,
      send: (...args) => messages.push(args)
    }
  }

  assert.equal(sendAiModeToggle(() => window, () => '2026-09-02T00:00:00.000Z'), true)
  assert.deepEqual(messages, [[AI_MODE_TOGGLE_CHANNEL, {
    type: 'toggle',
    source: 'application-menu',
    at: '2026-09-02T00:00:00.000Z'
  }]])
  assert.equal(sendAiModeToggle(() => null), false)
})

test('application menu installer binds Electron Menu and preload exposes only subscription', async () => {
  const calls = []
  const Menu = {
    buildFromTemplate(template) {
      calls.push(['build', template])
      return { template }
    },
    setApplicationMenu(menu) {
      calls.push(['set', menu])
    }
  }
  const menu = installYogurtApplicationMenu({ Menu, getWindow: () => null, platform: 'linux' })
  assert.equal(calls[0][0], 'build')
  assert.deepEqual(calls[1], ['set', menu])

  const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8')
  assert.match(preload, /ipcRenderer\.on\(CHANNELS\.aiModeToggle, dispatchAiModeToggle\)/)
  assert.match(preload, /subscribeAiModeToggle\(callback\)/)
  assert.match(preload, /exposeInMainWorld\('yogurtDesktop', yogurtDesktop\)/)
  assert.doesNotMatch(preload, /invoke\(CHANNELS\.aiModeToggle/)
})
