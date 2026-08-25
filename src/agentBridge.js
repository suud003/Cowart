const DEFAULT_CAPABILITIES = Object.freeze({
  available: false,
  provider: 'none',
  sendTask: false,
  streaming: false,
  approvals: false,
  interrupt: false,
  message: Object.freeze({ image: false })
})

const EMPTY_SESSION = Object.freeze({ threadId: null, turnId: null })

let fallbackTaskSequence = 0

function defaultTaskIdFactory() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `task:${globalThis.crypto.randomUUID()}`
  }
  fallbackTaskSequence += 1
  return `task:${Date.now().toString(36)}-${fallbackTaskSequence.toString(36)}`
}

function normalizedCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return DEFAULT_CAPABILITIES

  const canSendTask = Boolean(capabilities.sendTask ?? capabilities.available)
  return Object.freeze({
    available: Boolean(capabilities.available ?? canSendTask) && canSendTask,
    provider: String(capabilities.provider || (canSendTask ? 'unknown' : 'none')),
    sendTask: canSendTask,
    streaming: Boolean(capabilities.streaming),
    approvals: Boolean(capabilities.approvals),
    interrupt: Boolean(capabilities.interrupt),
    message: Object.freeze({ image: Boolean(capabilities.message?.image) })
  })
}

function sameCapabilities(left, right) {
  return (
    left.available === right.available &&
    left.provider === right.provider &&
    left.sendTask === right.sendTask &&
    left.streaming === right.streaming &&
    left.approvals === right.approvals &&
    left.interrupt === right.interrupt &&
    left.message.image === right.message.image
  )
}

function errorDetails(error) {
  return Object.freeze({
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown agent bridge error.')
  })
}

function abortError() {
  const error = new Error('The agent task was aborted.')
  error.name = 'AbortError'
  return error
}

function valueAt(object, paths) {
  for (const path of paths) {
    let value = object
    for (const key of path) value = value?.[key]
    if (value !== undefined && value !== null) return value
  }
  return null
}

function canonicalAgentEventType(sourceType) {
  const compact = String(sourceType || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (compact.includes('approval') && compact.includes('request')) return 'approval.requested'
  if (compact.includes('approval') && /(resolve|respond|complete|decision)/.test(compact)) {
    return 'approval.resolved'
  }
  if (compact.includes('turn') && compact.includes('start')) return 'turn.started'
  if (compact.includes('turn') && /(cancel|interrupt)/.test(compact)) return 'turn.cancelled'
  if (compact.includes('turn') && /(fail|error)/.test(compact)) return 'turn.failed'
  if (compact.includes('turn') && /(complete|finish)/.test(compact)) return 'turn.completed'
  if (compact.includes('plan')) return 'agent.plan'
  if (compact.includes('diff') || compact.includes('patch')) return 'agent.diff'
  if (compact.includes('delta') && (compact.includes('agent') || compact.includes('message'))) {
    return 'agent.delta'
  }
  if (compact === 'error' || compact.endsWith('error')) return 'turn.failed'
  return 'agent.event'
}

/** Converts App Server, preload, and custom adapter events into one UI-safe shape. */
export function normalizeAgentEvent(rawEvent, at = Date.now()) {
  const eventObject = rawEvent?.event && typeof rawEvent.event === 'object'
    ? rawEvent.event
    : rawEvent
  const sourceType = String(
    eventObject?.sourceType || eventObject?.type || eventObject?.method || rawEvent?.method || 'unknown'
  )
  const payload = eventObject?.params ?? eventObject?.payload ?? rawEvent?.params ?? eventObject ?? {}
  let type = canonicalAgentEventType(sourceType)
  if (type === 'turn.completed') {
    const turnStatus = String(valueAt(payload, [['status'], ['turn', 'status']]) || '').toLowerCase()
    if (turnStatus === 'failed' || turnStatus === 'error') type = 'turn.failed'
    if (turnStatus === 'cancelled' || turnStatus === 'canceled' || turnStatus === 'interrupted') {
      type = 'turn.cancelled'
    }
  }
  const threadId = valueAt(payload, [['threadId'], ['thread', 'id']]) ?? eventObject?.threadId ?? null
  const turnId = valueAt(payload, [['turnId'], ['turn', 'id']]) ?? eventObject?.turnId ?? null
  const requestId = eventObject?.requestId ?? rawEvent?.id ?? valueAt(payload, [['requestId'], ['id']])
  const text = valueAt(payload, [
    ['delta'],
    ['text'],
    ['message'],
    ['message', 'text'],
    ['item', 'text'],
    ['explanation']
  ])
  const plan = valueAt(payload, [['plan'], ['items']])
  const diff = valueAt(payload, [['diff'], ['patch'], ['changes']])
  const approval = type.startsWith('approval.')
    ? valueAt(payload, [['approval']]) ?? payload
    : null

  return Object.freeze({
    type,
    sourceType,
    threadId,
    turnId,
    requestId: requestId ?? null,
    text: typeof text === 'string' ? text : null,
    plan,
    diff,
    approval,
    payload: rawEvent,
    at
  })
}

function sessionFrom(value, previous = EMPTY_SESSION) {
  const payload = value?.params ?? value?.payload ?? value ?? {}
  return Object.freeze({
    threadId: valueAt(payload, [['threadId'], ['thread', 'id']]) ?? previous.threadId,
    turnId: valueAt(payload, [['turnId'], ['turn', 'id']]) ?? previous.turnId
  })
}

function taskWithSession(task, session) {
  return Object.freeze({
    ...task,
    threadId: session.threadId ?? task?.threadId ?? null,
    turnId: session.turnId ?? task?.turnId ?? null
  })
}

function isTaskScopedEvent(event) {
  if (!event?.type) return false
  if (event.type === 'turn.failed' && !event.turnId && !event.threadId) return false
  return (
    event.type.startsWith('turn.') ||
    event.type.startsWith('agent.') ||
    event.type.startsWith('approval.')
  )
}

function eventMatchesTask(event, task) {
  if (!event || !task) return false
  const eventTurnId = event.turnId == null ? null : String(event.turnId)
  const taskTurnId = task.turnId == null ? null : String(task.turnId)
  const eventThreadId = event.threadId == null ? null : String(event.threadId)
  const taskThreadId = task.threadId == null ? null : String(task.threadId)

  if (eventTurnId || taskTurnId) {
    if (!eventTurnId || !taskTurnId || eventTurnId !== taskTurnId) return false
    if (eventThreadId && taskThreadId && eventThreadId !== taskThreadId) return false
    return true
  }
  if (eventThreadId || taskThreadId) {
    return Boolean(eventThreadId && taskThreadId && eventThreadId === taskThreadId)
  }
  return true
}

function emptyActivity() {
  return Object.freeze({
    phase: 'idle',
    message: '',
    plan: null,
    diff: null,
    approval: null,
    updatedAt: null
  })
}

function activityFromEvent(previous, event) {
  let phase = previous.phase
  let message = previous.message
  let plan = previous.plan
  let diff = previous.diff
  let approval = previous.approval

  switch (event.type) {
    case 'turn.started':
      phase = 'running'
      message = ''
      plan = null
      diff = null
      approval = null
      break
    case 'agent.delta':
      phase = 'running'
      if (event.text) message += event.text
      break
    case 'agent.plan':
      phase = 'running'
      plan = event.plan ?? event.text ?? event.payload
      break
    case 'agent.diff':
      phase = 'running'
      diff = event.diff ?? event.payload
      break
    case 'approval.requested':
      phase = 'waiting_approval'
      approval = event.approval
      break
    case 'approval.resolved':
      phase = 'running'
      approval = null
      break
    case 'turn.completed':
      phase = 'completed'
      approval = null
      break
    case 'turn.failed':
      phase = 'failed'
      approval = null
      if (event.text) message = event.text
      break
    case 'turn.cancelled':
      phase = 'cancelled'
      approval = null
      break
    default:
      break
  }

  return Object.freeze({ phase, message, plan, diff, approval, updatedAt: event.at })
}

function initialState(capabilities) {
  return Object.freeze({
    status: capabilities.available ? 'idle' : 'unavailable',
    capabilities,
    pendingTaskIds: Object.freeze([]),
    session: EMPTY_SESSION,
    activity: emptyActivity(),
    lastTask: null,
    lastEvent: null
  })
}

/**
 * Creates a host-neutral agent bridge.
 *
 * Adapters need `sendTask(message, options)` and `getCapabilities()`. Optional
 * subscriptions, approval responses, and interruption progressively enhance
 * the same API for a full Codex App Server host.
 */
export function createAgentBridge(adapter, {
  clock = () => Date.now(),
  taskIdFactory = defaultTaskIdFactory,
  dispatchTask = (currentAdapter, message, options) => currentAdapter.sendTask(message, options),
  onSubscriberError = (error) => console.error('Yogurt AgentBridge subscriber failed.', error)
} = {}) {
  const listeners = new Set()
  const pendingTasks = new Map()
  let disposed = false
  let state = initialState(readCapabilities())

  function readCapabilities() {
    if (!adapter || typeof adapter.getCapabilities !== 'function') return DEFAULT_CAPABILITIES
    try {
      return normalizedCapabilities(adapter.getCapabilities())
    } catch (_error) {
      return DEFAULT_CAPABILITIES
    }
  }

  function publish(event, stateOverrides = {}) {
    state = Object.freeze({
      ...state,
      ...stateOverrides,
      pendingTaskIds: Object.freeze([...pendingTasks.keys()]),
      lastEvent: Object.freeze(event)
    })
    for (const listener of [...listeners]) {
      try {
        listener(state, state.lastEvent)
      } catch (error) {
        onSubscriberError(error)
      }
    }
  }

  function updateCapabilities({ emit = true } = {}) {
    const capabilities = disposed ? DEFAULT_CAPABILITIES : readCapabilities()
    const changed = !sameCapabilities(state.capabilities, capabilities)
    const nextStatus = pendingTasks.size > 0
      ? 'sending'
      : capabilities.available
        ? state.status === 'error' ? 'error' : 'idle'
        : 'unavailable'

    if (changed && emit) {
      publish(
        { type: 'capabilities.changed', capabilities, at: clock() },
        { capabilities, status: nextStatus }
      )
    } else if (changed || state.status !== nextStatus) {
      state = Object.freeze({ ...state, capabilities, status: nextStatus })
    }
    return capabilities
  }

  function refreshCapabilities({ emit = true } = {}) {
    try {
      const refreshed = adapter?.refreshCapabilities?.()
      if (refreshed && typeof refreshed.then === 'function') {
        refreshed.then(() => updateCapabilities({ emit })).catch(() => {})
      }
    } catch (_error) {
      // The cached/synchronous capability snapshot below remains authoritative.
    }
    return updateCapabilities({ emit })
  }

  function receiveAdapterEvent(rawEvent) {
    if (disposed || !rawEvent) return
    const event = normalizeAgentEvent(rawEvent, clock())
    let lastTask = state.lastTask
    if (
      isTaskScopedEvent(event) &&
      lastTask?.status === 'sending' &&
      !lastTask.turnId &&
      event.type === 'turn.started' &&
      event.turnId &&
      pendingTasks.size === 1
    ) {
      lastTask = taskWithSession(lastTask, sessionFrom(event, state.session))
      pendingTasks.set(lastTask.id, lastTask)
    }
    if (isTaskScopedEvent(event) && !eventMatchesTask(event, lastTask)) return

    const session = sessionFrom(event, state.session)
    const activity = activityFromEvent(state.activity, event)
    if (['accepted', 'sending'].includes(lastTask?.status) && event.type.startsWith('turn.')) {
      const terminalStatus = {
        'turn.completed': 'succeeded',
        'turn.failed': 'failed',
        'turn.cancelled': 'cancelled'
      }[event.type]
      if (terminalStatus) {
        lastTask = Object.freeze({ ...lastTask, status: terminalStatus, finishedAt: event.at })
        if (pendingTasks.has(lastTask.id)) pendingTasks.set(lastTask.id, lastTask)
      }
    }
    const status = event.type === 'turn.failed'
      ? 'error'
      : pendingTasks.size > 0
        ? 'sending'
        : state.capabilities.available ? 'idle' : 'unavailable'
    publish(event, { session, activity, lastTask, status })
  }

  async function sendTask(message, options = {}) {
    if (disposed) throw new Error('The agent bridge has been disposed.')

    const capabilities = updateCapabilities({ emit: false })
    const taskId = String(options.taskId || taskIdFactory())
    if (pendingTasks.has(taskId)) {
      throw new Error(`An agent task with id "${taskId}" is already running.`)
    }

    const startedAt = clock()
    const task = Object.freeze({
      id: taskId,
      status: 'sending',
      startedAt,
      metadata: options.metadata ?? null
    })

    if (options.signal?.aborted) {
      const error = abortError()
      const cancelledTask = Object.freeze({
        ...task,
        status: 'cancelled',
        finishedAt: clock(),
        error: errorDetails(error)
      })
      publish(
        { type: 'task.cancelled', task: cancelledTask, at: cancelledTask.finishedAt },
        {
          status: capabilities.available ? 'idle' : 'unavailable',
          activity: Object.freeze({ ...state.activity, phase: 'cancelled', updatedAt: cancelledTask.finishedAt }),
          lastTask: cancelledTask
        }
      )
      throw error
    }

    if (!capabilities.available || typeof adapter?.sendTask !== 'function') {
      const error = new Error('No Yogurt AI agent host is available.')
      const failedTask = Object.freeze({
        ...task,
        status: 'failed',
        finishedAt: clock(),
        error: errorDetails(error)
      })
      publish(
        { type: 'task.failed', task: failedTask, error: failedTask.error, at: failedTask.finishedAt },
        {
          status: 'unavailable',
          activity: Object.freeze({ ...state.activity, phase: 'failed', message: error.message, updatedAt: failedTask.finishedAt }),
          lastTask: failedTask
        }
      )
      throw error
    }

    pendingTasks.set(taskId, task)
    publish(
      { type: 'task.started', task, at: startedAt },
      {
        status: 'sending',
        capabilities,
        activity: Object.freeze({ ...emptyActivity(), phase: 'submitting', updatedAt: startedAt }),
        lastTask: task
      }
    )

    try {
      const result = await dispatchTask(adapter, message, { ...options, taskId })
      const pendingTask = pendingTasks.get(taskId) ?? task
      pendingTasks.delete(taskId)
      const acceptedAt = clock()
      const resultSession = sessionFrom(result, EMPTY_SESSION)
      const acceptedSession = Object.freeze({
        threadId: resultSession.threadId ?? state.session.threadId,
        turnId: resultSession.turnId
      })
      const taskWithAcceptedSession = taskWithSession(pendingTask, acceptedSession)
      const wasAlreadyTerminal = ['succeeded', 'failed', 'cancelled'].includes(
        taskWithAcceptedSession.status
      )
      const acceptedTask = Object.freeze({
        ...taskWithAcceptedSession,
        status: wasAlreadyTerminal ? taskWithAcceptedSession.status : 'accepted',
        acceptedAt
      })
      publish(
        { type: 'task.accepted', task: acceptedTask, result, at: acceptedAt },
        {
          status: pendingTasks.size > 0
            ? 'sending'
            : acceptedTask.status === 'failed' ? 'error' : 'idle',
          session: acceptedSession,
          activity: wasAlreadyTerminal
            ? state.activity
            : Object.freeze({ ...state.activity, phase: 'running', updatedAt: acceptedAt }),
          lastTask: acceptedTask
        }
      )
      return result
    } catch (error) {
      pendingTasks.delete(taskId)
      const cancelled = error?.name === 'AbortError' || options.signal?.aborted
      const completedTask = Object.freeze({
        ...task,
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt: clock(),
        error: errorDetails(error)
      })
      publish(
        {
          type: cancelled ? 'task.cancelled' : 'task.failed',
          task: completedTask,
          error: completedTask.error,
          at: completedTask.finishedAt
        },
        {
          status: pendingTasks.size > 0 ? 'sending' : cancelled ? 'idle' : 'error',
          activity: Object.freeze({
            ...state.activity,
            phase: cancelled ? 'cancelled' : 'failed',
            message: completedTask.error.message,
            updatedAt: completedTask.finishedAt
          }),
          lastTask: completedTask
        }
      )
      throw error
    }
  }

  async function respondApproval(requestId, decision) {
    if (disposed) throw new Error('The agent bridge has been disposed.')
    const capabilities = updateCapabilities({ emit: false })
    if (!capabilities.approvals || typeof adapter?.respondApproval !== 'function') {
      throw new Error('The current agent host does not support approvals.')
    }
    return await adapter.respondApproval(requestId, decision)
  }

  async function interrupt(options) {
    if (disposed) throw new Error('The agent bridge has been disposed.')
    const capabilities = updateCapabilities({ emit: false })
    if (!capabilities.interrupt || typeof adapter?.interrupt !== 'function') {
      throw new Error('The current agent host does not support interruption.')
    }
    return await adapter.interrupt(options)
  }

  function subscribe(listener, { emitCurrent = false } = {}) {
    if (typeof listener !== 'function') throw new TypeError('AgentBridge listener must be a function.')
    if (disposed) return () => {}
    listeners.add(listener)
    if (emitCurrent) {
      try {
        listener(state, { type: 'state.current', at: clock() })
      } catch (error) {
        onSubscriberError(error)
      }
    }
    return () => listeners.delete(listener)
  }

  let unsubscribeCapabilities = null
  if (typeof adapter?.subscribeCapabilities === 'function') {
    try {
      const unsubscribe = adapter.subscribeCapabilities(() => updateCapabilities())
      if (typeof unsubscribe === 'function') unsubscribeCapabilities = unsubscribe
    } catch (_error) {
      // Manual refresh remains available for adapters without subscriptions.
    }
  }

  let unsubscribeEvents = null
  if (typeof adapter?.subscribe === 'function') {
    try {
      const unsubscribe = adapter.subscribe(receiveAdapterEvent)
      if (typeof unsubscribe === 'function') unsubscribeEvents = unsubscribe
    } catch (_error) {
      // Task submission remains available for hosts without event streams.
    }
  }

  return Object.freeze({
    sendTask,
    respondApproval,
    interrupt,
    get capabilities() {
      return state.capabilities
    },
    getState() {
      return state
    },
    subscribe,
    refreshCapabilities,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeEvents?.()
      unsubscribeCapabilities?.()
      adapter?.dispose?.()
      listeners.clear()
      updateCapabilities({ emit: false })
    }
  })
}

export { DEFAULT_CAPABILITIES as UNAVAILABLE_AGENT_CAPABILITIES }
