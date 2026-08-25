import assert from 'node:assert/strict'
import test from 'node:test'

import {
  followUpSender,
  getCowartAgentBridge,
  supportsMessageImages
} from '../src/widgetMessaging.js'

test('follow-up sender uses the native Cowart host bridge when available', async () => {
  const messages = []
  const windowObject = {
    cowartMcp: {
      async sendFollowUpMessage(message) {
        messages.push(message)
        return { ok: true }
      }
    }
  }

  const sender = followUpSender(windowObject)
  assert.equal(typeof sender, 'function')
  assert.deepEqual(await sender({ prompt: 'Expand this selection.' }), { ok: true })
  assert.deepEqual(messages, [{ prompt: 'Expand this selection.' }])
})

test('follow-up sender prefers the Electron Yogurt Agent preload bridge', async () => {
  const messages = []
  const windowObject = {
    yogurtAgent: {
      sendTask(message) {
        messages.push(message)
        return { accepted: true }
      }
    },
    cowartMcp: {
      sendFollowUpMessage() {
        throw new Error('Cowart MCP should not be selected when the preload exists.')
      }
    }
  }

  const sender = followUpSender(windowObject)
  assert.equal(typeof sender, 'function')
  assert.deepEqual(await sender({ prompt: 'Continue in the desktop app.' }), { accepted: true })
  assert.deepEqual(messages, [{ prompt: 'Continue in the desktop app.' }])
})

test('Agent panel and follow-up entry points share one bridge per window', async () => {
  const windowObject = {
    yogurtAgent: {
      sendTask: async () => ({ threadId: 'thread:shared', turnId: 'turn:shared' })
    }
  }
  const panelBridge = getCowartAgentBridge(windowObject)
  const sameBridge = getCowartAgentBridge(windowObject)
  const sender = followUpSender(windowObject)

  assert.equal(panelBridge, sameBridge)
  await sender({ prompt: 'Use the shared task stream.' })
  assert.equal(panelBridge.getState().lastTask.status, 'accepted')
  assert.equal(panelBridge.getState().lastTask.turnId, 'turn:shared')
})

test('follow-up sender stays unavailable in a standalone browser preview', () => {
  assert.equal(followUpSender({}), null)
})

test('message image support follows native host capabilities', () => {
  assert.equal(
    supportsMessageImages({
      cowartMcp: {
        getHostCapabilities: () => ({ message: { image: true } })
      }
    }),
    true
  )
  assert.equal(supportsMessageImages({}), false)
})
