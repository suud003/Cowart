import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentAttentionForEvent,
  createAgentAttentionController
} from '../desktop/agent-attention.mjs'

function fakeWindow({ focused = false, minimized = false, visible = true } = {}) {
  const calls = []
  return {
    calls,
    isDestroyed: () => false,
    isFocused: () => focused,
    isMinimized: () => minimized,
    isVisible: () => visible,
    flashFrame: (value) => calls.push(['flashFrame', value]),
    restore: () => calls.push(['restore']),
    show: () => calls.push(['show']),
    focus: () => calls.push(['focus'])
  }
}

function fakeNotification(options) {
  const listeners = new Map()
  return {
    options,
    shown: false,
    closed: false,
    once: (event, callback) => listeners.set(event, callback),
    show() { this.shown = true },
    close() {
      this.closed = true
      listeners.get('close')?.()
    },
    emit: (event) => listeners.get(event)?.()
  }
}

test('attention policy distinguishes blocking requests, replies, and failures', () => {
  const blocking = agentAttentionForEvent({
    type: 'elicitation.requested',
    requestId: 'request-1',
    message: 'secret prompt that must not leave the app'
  })
  assert.equal(blocking.kind, 'blocking')
  assert.equal(blocking.title, 'Yogurt AI 等待你的操作')
  assert.doesNotMatch(blocking.body, /secret prompt/)

  assert.equal(agentAttentionForEvent({
    type: 'turn.completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    status: 'completed'
  }).kind, 'reply')
  assert.equal(agentAttentionForEvent({
    type: 'turn.completed',
    threadId: 'thread-1',
    turnId: 'turn-2',
    status: 'failed'
  }).kind, 'failure')
  const interrupted = agentAttentionForEvent({
    type: 'turn.completed',
    threadId: 'thread-1',
    turnId: 'turn-3',
    status: 'interrupted'
  })
  assert.equal(interrupted.kind, 'interrupted')
  assert.equal(interrupted.title, 'Yogurt AI 任务已中断')
  assert.equal(agentAttentionForEvent({ type: 'agent.delta', delta: 'secret' }), null)
})

test('background requests flash the taskbar and show only generic notification copy', () => {
  const window = fakeWindow()
  const notifications = []
  const controller = createAgentAttentionController({
    getWindow: () => window,
    isNotificationSupported: () => true,
    createNotification: (options) => {
      const notification = fakeNotification(options)
      notifications.push(notification)
      return notification
    }
  })

  const event = {
    type: 'approval.requested',
    requestId: 'approval-1',
    summary: 'Run a command containing a private path'
  }
  assert.equal(controller.handle(event), true)
  assert.deepEqual(window.calls, [['flashFrame', true]])
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].shown, true)
  assert.equal(notifications[0].options.timeoutType, 'never')
  assert.doesNotMatch(JSON.stringify(notifications[0].options), /private path/)

  assert.equal(controller.handle(event), false)
  assert.equal(notifications.length, 1)
})

test('focused windows stay quiet and notification clicks restore and focus the app', () => {
  const focusedWindow = fakeWindow({ focused: true })
  const quiet = createAgentAttentionController({
    getWindow: () => focusedWindow,
    createNotification: () => fakeNotification({})
  })
  assert.equal(quiet.handle({
    type: 'turn.completed',
    threadId: 'thread-1',
    turnId: 'turn-focused',
    status: 'completed'
  }), false)
  assert.deepEqual(focusedWindow.calls, [])

  const minimizedWindow = fakeWindow({ minimized: true, visible: false })
  let notification
  const active = createAgentAttentionController({
    getWindow: () => minimizedWindow,
    createNotification: (options) => (notification = fakeNotification(options))
  })
  active.handle({
    type: 'turn.completed',
    threadId: 'thread-1',
    turnId: 'turn-background',
    status: 'completed'
  })
  notification.emit('click')
  assert.deepEqual(minimizedWindow.calls, [
    ['flashFrame', true],
    ['restore'],
    ['show'],
    ['flashFrame', false],
    ['focus']
  ])
})

test('notification fallback still flashes and dispose clears attention', () => {
  const window = fakeWindow()
  const controller = createAgentAttentionController({
    getWindow: () => window,
    isNotificationSupported: () => false
  })
  assert.equal(controller.handle({
    type: 'elicitation.requested',
    requestId: 'request-fallback'
  }), true)
  controller.dispose()
  assert.deepEqual(window.calls, [
    ['flashFrame', true],
    ['flashFrame', false]
  ])
})

test('resolved blocking requests dismiss stale background attention', () => {
  const window = fakeWindow()
  let notification
  const controller = createAgentAttentionController({
    getWindow: () => window,
    createNotification: (options) => (notification = fakeNotification(options))
  })
  controller.handle({ type: 'approval.requested', requestId: 'approval-resolved' })
  assert.equal(notification.closed, false)
  controller.handle({ type: 'approval.resolved', requestId: 'approval-resolved' })
  assert.equal(notification.closed, true)
  assert.deepEqual(window.calls, [
    ['flashFrame', true],
    ['flashFrame', false]
  ])
})

test('attention can retry after no window exists and native notification errors stay isolated', () => {
  let window = null
  const controller = createAgentAttentionController({
    getWindow: () => window,
    createNotification: () => {
      throw new Error('native notification unavailable')
    }
  })
  const event = { type: 'elicitation.requested', requestId: 'request-retry' }
  assert.equal(controller.handle(event), false)

  window = fakeWindow()
  assert.doesNotThrow(() => controller.handle(event))
  assert.deepEqual(window.calls, [['flashFrame', true]])

  const showFailure = createAgentAttentionController({
    getWindow: () => window,
    createNotification: () => ({
      once() {},
      show() { throw new Error('show failed') }
    })
  })
  assert.doesNotThrow(() => showFailure.handle({
    type: 'turn.completed',
    threadId: 'thread-1',
    turnId: 'turn-show-error',
    status: 'completed'
  }))
})
