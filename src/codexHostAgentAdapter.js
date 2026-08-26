function isPromiseLike(value) {
  return Boolean(value && typeof value.then === 'function')
}

function readOpenAiCapabilities(openai) {
  try {
    if (typeof openai?.getHostCapabilities === 'function') return openai.getHostCapabilities()
    return openai?.hostCapabilities ?? null
  } catch (_error) {
    return null
  }
}

function normalizedHostCapabilities(host) {
  if (!host) {
    return {
      available: false,
      provider: 'none',
      sendTask: false,
      streaming: false,
      approvals: false,
      elicitation: false,
      interrupt: false,
      message: { image: false }
    }
  }

  const capabilities = host.capabilities ?? {}
  const advertisedSendTask = capabilities.available ?? capabilities.agent?.sendTask
  const canSendTask = Boolean(host.sendTask) && advertisedSendTask !== false
  return {
    available: canSendTask,
    provider: host.provider,
    sendTask: canSendTask,
    streaming: canSendTask && Boolean(capabilities.streaming ?? capabilities.agent?.streaming ?? host.subscribe),
    approvals: canSendTask && Boolean(capabilities.approvals ?? capabilities.agent?.approvals ?? host.respondApproval),
    elicitation: canSendTask && Boolean(
      capabilities.elicitation ??
      capabilities.elicitations ??
      capabilities.mcpElicitation ??
      capabilities.agent?.elicitation ??
      capabilities.agent?.elicitations ??
      host.respondElicitation
    ),
    interrupt: canSendTask && Boolean(capabilities.interrupt ?? capabilities.agent?.interrupt ?? host.interrupt),
    message: {
      image: Boolean(capabilities.message?.image ?? capabilities.messageImages)
    },
    ...(capabilities.setup ? { setup: capabilities.setup } : {})
  }
}

/**
 * Adapts Electron's allow-listed preload API and both Codex widget globals to
 * one host-neutral transport. The preload wins whenever it can submit tasks.
 */
export function createCodexHostAgentAdapter(windowObject = globalThis.window) {
  const capabilityListeners = new Set()
  const eventListeners = new Set()
  const hostUnsubscribers = new Map()
  let disposed = false
  let preloadCapabilityHost = null
  let preloadCapabilities = null
  let preloadCapabilityReadStarted = false

  function notifyCapabilitiesChanged() {
    for (const listener of [...capabilityListeners]) listener()
  }

  function notifyAgentEvent(event) {
    if (!event) return
    for (const listener of [...eventListeners]) listener(event)
  }

  function updatePreloadCapabilities(host, capabilities) {
    if (host !== windowObject?.yogurtAgent || !capabilities || typeof capabilities !== 'object') return
    preloadCapabilities = capabilities
    notifyCapabilitiesChanged()
  }

  function readPreloadCapabilities(host) {
    if (!host) return null
    if (preloadCapabilityHost !== host) {
      preloadCapabilityHost = host
      preloadCapabilities = null
      preloadCapabilityReadStarted = false
    }

    if (!preloadCapabilities && host.capabilities && !isPromiseLike(host.capabilities)) {
      preloadCapabilities = host.capabilities
    }

    if (!preloadCapabilityReadStarted && typeof host.getCapabilities === 'function') {
      try {
        const returned = host.getCapabilities()
        if (isPromiseLike(returned)) {
          preloadCapabilityReadStarted = true
          returned
            .then((capabilities) => updatePreloadCapabilities(host, capabilities))
            .catch(() => {})
        } else if (returned) {
          preloadCapabilities = returned
        }
      } catch (_error) {
        // A preload may be present while its backing process is still connecting.
      }
    }

    if (!preloadCapabilities && typeof host.getState === 'function') {
      try {
        const currentState = host.getState()
        if (isPromiseLike(currentState)) currentState.catch(() => {})
        else preloadCapabilities = currentState?.capabilities ?? null
      } catch (_error) {
        // The method presence still provides safe progressive enhancement.
      }
    }
    return preloadCapabilities
  }

  function currentHost({ requireSendTask = true } = {}) {
    const yogurtAgent = windowObject?.yogurtAgent
    if (yogurtAgent && (!requireSendTask || typeof yogurtAgent.sendTask === 'function')) {
      return {
        provider: 'yogurtAgent',
        host: yogurtAgent,
        sendTask: typeof yogurtAgent.sendTask === 'function'
          ? (message, options) => yogurtAgent.sendTask(message, options)
          : null,
        subscribe: typeof yogurtAgent.subscribe === 'function',
        respondApproval: typeof yogurtAgent.respondApproval === 'function'
          ? (requestId, decision) => yogurtAgent.respondApproval(requestId, decision)
          : null,
        respondElicitation: typeof yogurtAgent.respondElicitation === 'function'
          ? (requestId, response) => yogurtAgent.respondElicitation(requestId, response)
          : null,
        interrupt: typeof yogurtAgent.interrupt === 'function'
          ? (options) => yogurtAgent.interrupt(options)
          : null,
        selectWorkspace: typeof yogurtAgent.selectWorkspace === 'function'
          ? () => yogurtAgent.selectWorkspace()
          : null,
        startCodexLogin: typeof yogurtAgent.startCodexLogin === 'function'
          ? () => yogurtAgent.startCodexLogin()
          : null,
        capabilities: readPreloadCapabilities(yogurtAgent)
      }
    }

    const cowartMcp = windowObject?.cowartMcp
    if (cowartMcp && (!requireSendTask || typeof cowartMcp.sendFollowUpMessage === 'function')) {
      let capabilities = null
      try {
        capabilities = cowartMcp.getHostCapabilities?.() ??
          windowObject?.__COWART_MCP_APP__?.getHostCapabilities?.() ??
          globalThis.__COWART_MCP_APP__?.getHostCapabilities?.() ??
          null
      } catch (_error) {
        // Host capability negotiation is a progressive enhancement.
      }
      return {
        provider: 'cowartMcp',
        host: cowartMcp,
        sendTask: typeof cowartMcp.sendFollowUpMessage === 'function'
          ? (message) => cowartMcp.sendFollowUpMessage(message)
          : null,
        subscribe: false,
        respondApproval: null,
        respondElicitation: null,
        interrupt: null,
        capabilities
      }
    }

    const openai = windowObject?.openai
    if (openai && (!requireSendTask || typeof openai.sendFollowUpMessage === 'function')) {
      return {
        provider: 'openai',
        host: openai,
        sendTask: typeof openai.sendFollowUpMessage === 'function'
          ? (message) => openai.sendFollowUpMessage(message)
          : null,
        subscribe: false,
        respondApproval: null,
        respondElicitation: null,
        interrupt: null,
        capabilities: readOpenAiCapabilities(openai)
      }
    }

    const globalCapabilities = (() => {
      try {
        return windowObject?.__COWART_MCP_APP__?.getHostCapabilities?.() ??
          globalThis.__COWART_MCP_APP__?.getHostCapabilities?.() ??
          null
      } catch (_error) {
        return null
      }
    })()
    return globalCapabilities
      ? {
          provider: 'cowartMcp',
          host: null,
          sendTask: null,
          subscribe: false,
          respondApproval: null,
          respondElicitation: null,
          interrupt: null,
          capabilities: globalCapabilities
        }
      : null
  }

  function subscribeToYogurtHost() {
    const yogurtAgent = windowObject?.yogurtAgent
    if (
      !yogurtAgent ||
      typeof yogurtAgent.subscribe !== 'function' ||
      hostUnsubscribers.has(yogurtAgent)
    ) return

    try {
      const unsubscribe = yogurtAgent.subscribe((...args) => {
        const candidate = args[1]?.type || args[1]?.method
          ? args[1]
          : args[0]?.lastEvent ?? args[0]
        preloadCapabilityReadStarted = false
        readPreloadCapabilities(yogurtAgent)
        notifyCapabilitiesChanged()
        if (candidate?.type || candidate?.method || candidate?.event) notifyAgentEvent(candidate)
      })
      hostUnsubscribers.set(yogurtAgent, typeof unsubscribe === 'function' ? unsubscribe : () => {})
    } catch (_error) {
      // A preload can omit subscriptions without disabling direct task sends.
    }
  }

  const handleHostGlobals = () => {
    subscribeToYogurtHost()
    notifyCapabilitiesChanged()
  }

  subscribeToYogurtHost()
  windowObject?.addEventListener?.('openai:set_globals', handleHostGlobals)
  windowObject?.addEventListener?.('yogurt-agent:state-changed', handleHostGlobals)

  return Object.freeze({
    getCapabilities() {
      return normalizedHostCapabilities(
        disposed ? null : currentHost() ?? currentHost({ requireSendTask: false })
      )
    },

    async sendTask(message, options = {}) {
      if (disposed) throw new Error('The Codex host adapter has been disposed.')
      const host = currentHost()
      if (!host?.sendTask) throw new Error('No Yogurt AI agent host is available.')
      return await host.sendTask(message, options)
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Agent event listener must be a function.')
      if (disposed) return () => {}
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },

    subscribeCapabilities(listener) {
      if (typeof listener !== 'function') throw new TypeError('Capability listener must be a function.')
      if (disposed) return () => {}
      capabilityListeners.add(listener)
      return () => capabilityListeners.delete(listener)
    },

    async respondApproval(requestId, decision) {
      if (disposed) throw new Error('The Codex host adapter has been disposed.')
      const host = currentHost()
      if (!host?.respondApproval) throw new Error('The current agent host does not support approvals.')
      return await host.respondApproval(requestId, decision)
    },

    async respondElicitation(requestId, response) {
      if (disposed) throw new Error('The Codex host adapter has been disposed.')
      const host = currentHost()
      if (!host?.respondElicitation) {
        throw new Error('The current agent host does not support elicitation responses.')
      }
      return await host.respondElicitation(requestId, response)
    },

    async interrupt(options) {
      if (disposed) throw new Error('The Codex host adapter has been disposed.')
      const host = currentHost()
      if (!host?.interrupt) throw new Error('The current agent host does not support interruption.')
      return await host.interrupt(options)
    },

    async selectWorkspace() {
      if (disposed) throw new Error('The Codex host adapter has been disposed.')
      const host = currentHost({ requireSendTask: false })
      if (!host?.selectWorkspace) {
        throw new Error('Workspace selection is only available in Yogurt AI Desktop.')
      }
      return await host.selectWorkspace()
    },

    async startCodexLogin() {
      if (disposed) throw new Error('The Codex host adapter has been disposed.')
      const host = currentHost({ requireSendTask: false })
      if (!host?.startCodexLogin) {
        throw new Error('Codex login is only available in Yogurt AI Desktop.')
      }
      return await host.startCodexLogin()
    },

    refreshCapabilities() {
      const yogurtAgent = windowObject?.yogurtAgent
      if (yogurtAgent) {
        preloadCapabilityReadStarted = false
        try {
          const refreshed = yogurtAgent.refreshCapabilities?.()
          if (isPromiseLike(refreshed)) {
            refreshed
              .then((capabilities) => {
                if (capabilities) updatePreloadCapabilities(yogurtAgent, capabilities)
                else readPreloadCapabilities(yogurtAgent)
              })
              .catch(() => {})
          } else if (refreshed) {
            updatePreloadCapabilities(yogurtAgent, refreshed)
          } else {
            readPreloadCapabilities(yogurtAgent)
          }
        } catch (_error) {
          readPreloadCapabilities(yogurtAgent)
        }
      }
      notifyCapabilitiesChanged()
      return normalizedHostCapabilities(
        disposed ? null : currentHost() ?? currentHost({ requireSendTask: false })
      )
    },

    dispose() {
      if (disposed) return
      disposed = true
      windowObject?.removeEventListener?.('openai:set_globals', handleHostGlobals)
      windowObject?.removeEventListener?.('yogurt-agent:state-changed', handleHostGlobals)
      for (const unsubscribe of hostUnsubscribers.values()) unsubscribe()
      hostUnsubscribers.clear()
      eventListeners.clear()
      capabilityListeners.clear()
    }
  })
}
