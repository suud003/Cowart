const MAX_SEEN_EVENTS = 256

const ATTENTION_COPY = Object.freeze({
  blocking: Object.freeze({
    title: 'Yogurt AI 等待你的操作',
    body: 'Codex 需要你确认或补充信息。返回应用后即可继续。'
  }),
  reply: Object.freeze({
    title: 'Yogurt AI 已回复',
    body: 'Codex 已完成本次任务，返回应用查看完整回复。'
  }),
  failure: Object.freeze({
    title: 'Yogurt AI 任务需要查看',
    body: 'Codex 返回了需要处理的状态，请打开应用查看详情。'
  }),
  interrupted: Object.freeze({
    title: 'Yogurt AI 任务已中断',
    body: 'Codex 已停止本次任务，返回应用可查看当前进度。'
  })
})

function compactId(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function turnStatus(event) {
  return String(event?.status ?? event?.turn?.status ?? '').trim().toLowerCase()
}

export function agentAttentionForEvent(event) {
  if (!event || typeof event !== 'object') return null
  const type = String(event.type || '')

  if (type === 'approval.requested' || type === 'elicitation.requested') {
    const requestId = compactId(event.requestId ?? event.elicitation?.requestId)
    if (!requestId) return null
    return Object.freeze({
      kind: 'blocking',
      key: `${type}:${requestId}`,
      requestId,
      ...ATTENTION_COPY.blocking
    })
  }

  if (type !== 'turn.completed') return null
  const turnId = compactId(event.turnId ?? event.turn?.id)
  const threadId = compactId(event.threadId)
  const eventId = turnId || compactId(event.at)
  if (!eventId) return null
  const status = turnStatus(event)
  const interrupted = ['cancelled', 'canceled', 'interrupted'].includes(status)
  const failed = ['failed', 'error'].includes(status)
  return Object.freeze({
    kind: interrupted ? 'interrupted' : failed ? 'failure' : 'reply',
    key: `turn.completed:${threadId || 'thread'}:${eventId}`,
    turnId,
    ...(interrupted ? ATTENTION_COPY.interrupted : failed ? ATTENTION_COPY.failure : ATTENTION_COPY.reply)
  })
}

function usableWindow(window) {
  return Boolean(window && !window.isDestroyed?.())
}

function windowNeedsAttention(window) {
  return Boolean(
    window.isMinimized?.() ||
    window.isVisible?.() === false ||
    window.isFocused?.() === false
  )
}

function resolvedAttentionKey(event) {
  const type = String(event?.type || '')
  if (type !== 'approval.resolved' && type !== 'elicitation.resolved') return null
  const requestId = compactId(event.requestId ?? event.elicitation?.requestId)
  if (!requestId) return null
  return `${type.replace('.resolved', '.requested')}:${requestId}`
}

export function createAgentAttentionController({
  getWindow,
  createNotification,
  isNotificationSupported = () => true
} = {}) {
  if (typeof getWindow !== 'function') {
    throw new TypeError('Agent attention requires a window provider.')
  }

  const seen = new Set()
  const notifications = new Set()
  const notificationsByKey = new Map()
  const activeAttentionKeys = new Set()

  const remember = (key) => {
    seen.add(key)
    if (seen.size <= MAX_SEEN_EVENTS) return
    seen.delete(seen.values().next().value)
  }

  const stopFlashing = () => {
    const window = getWindow()
    if (usableWindow(window)) window.flashFrame?.(false)
    activeAttentionKeys.clear()
    for (const notification of notifications) notification.close?.()
    notifications.clear()
    notificationsByKey.clear()
  }

  const activate = (notification) => {
    const window = getWindow()
    if (usableWindow(window)) {
      if (window.isMinimized?.()) window.restore?.()
      if (window.isVisible?.() === false) window.show?.()
      window.flashFrame?.(false)
      window.focus?.()
    }
    notification?.close?.()
  }

  const handle = (event) => {
    const resolvedKey = resolvedAttentionKey(event)
    if (resolvedKey) {
      activeAttentionKeys.delete(resolvedKey)
      notificationsByKey.get(resolvedKey)?.close?.()
      notificationsByKey.delete(resolvedKey)
      if (activeAttentionKeys.size === 0) {
        const window = getWindow()
        if (usableWindow(window)) window.flashFrame?.(false)
      }
      return false
    }

    const attention = agentAttentionForEvent(event)
    if (!attention || seen.has(attention.key)) return false

    const window = getWindow()
    if (!usableWindow(window) || !windowNeedsAttention(window)) return false
    remember(attention.key)
    activeAttentionKeys.add(attention.key)
    window.flashFrame?.(true)

    if (typeof createNotification !== 'function' || isNotificationSupported() !== true) {
      return true
    }

    let notification
    try {
      notification = createNotification({
        title: attention.title,
        body: attention.body,
        silent: false,
        timeoutType: attention.kind === 'blocking' ? 'never' : 'default'
      })
    } catch (_error) {
      return true
    }
    if (!notification || typeof notification.show !== 'function') return true
    notifications.add(notification)
    notificationsByKey.set(attention.key, notification)
    notification.once?.('click', () => activate(notification))
    const forgetNotification = () => {
      notifications.delete(notification)
      if (notificationsByKey.get(attention.key) === notification) {
        notificationsByKey.delete(attention.key)
      }
    }
    notification.once?.('close', forgetNotification)
    notification.once?.('failed', forgetNotification)
    try {
      notification.show()
    } catch (_error) {
      forgetNotification()
    }
    return true
  }

  const dispose = () => {
    stopFlashing()
    seen.clear()
  }

  return Object.freeze({ handle, stopFlashing, dispose })
}
