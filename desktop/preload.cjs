'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = Object.freeze({
  bootstrap: 'yogurt-agent:bootstrap',
  callCowartTool: 'yogurt-agent:call-cowart-tool',
  event: 'yogurt-agent:event',
  getState: 'yogurt-agent:get-state',
  refreshCapabilities: 'yogurt-agent:refresh-capabilities',
  selectWorkspace: 'yogurt-agent:select-workspace',
  startCodexLogin: 'yogurt-agent:start-codex-login',
  respondApproval: 'yogurt-agent:respond-approval',
  respondElicitation: 'yogurt-agent:respond-elicitation',
  sendTask: 'yogurt-agent:send-task',
  interrupt: 'yogurt-agent:interrupt'
})

const bootstrap = ipcRenderer.sendSync(CHANNELS.bootstrap) || {}
if (bootstrap.error) throw new Error(bootstrap.error)

const callbacks = new Set()
const deliveredElicitations = new WeakMap()
const resolvedElicitationIds = new Set()

function elicitationRequestId(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (!String(payload.type || '').startsWith('elicitation.')) return null
  const requestId = payload.requestId ?? payload.elicitation?.requestId ?? null
  return requestId == null ? null : String(requestId)
}

function rememberResolvedElicitation(requestId) {
  resolvedElicitationIds.add(requestId)
  if (resolvedElicitationIds.size <= 256) return
  resolvedElicitationIds.delete(resolvedElicitationIds.values().next().value)
}

const dispatchEvent = (_event, payload) => {
  const requestId = elicitationRequestId(payload)
  const isRequested = payload?.type === 'elicitation.requested'
  const isResolved = payload?.type === 'elicitation.resolved'
  if (isRequested && requestId) resolvedElicitationIds.delete(requestId)
  if (isResolved && requestId) rememberResolvedElicitation(requestId)
  for (const callback of callbacks) {
    let delivered = deliveredElicitations.get(callback)
    if (!delivered) {
      delivered = new Set()
      deliveredElicitations.set(callback, delivered)
    }
    if (isRequested && requestId && delivered.has(requestId)) continue
    if (isRequested && requestId) delivered.add(requestId)
    if (isResolved && requestId) delivered.delete(requestId)
    try {
      callback(payload)
    } catch {
      // A renderer listener cannot break delivery to the remaining listeners.
    }
  }
}
ipcRenderer.on(CHANNELS.event, dispatchEvent)

const yogurtAgent = Object.freeze({
  capabilities: bootstrap.capabilities || null,
  sendTask: (task) => ipcRenderer.invoke(CHANNELS.sendTask, task),
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  getCapabilities: () => ipcRenderer
    .invoke(CHANNELS.getState)
    .then((state) => state?.capabilities || bootstrap.capabilities || null),
  refreshCapabilities: () => ipcRenderer.invoke(CHANNELS.refreshCapabilities),
  selectWorkspace: () => ipcRenderer.invoke(CHANNELS.selectWorkspace),
  startCodexLogin: () => ipcRenderer.invoke(CHANNELS.startCodexLogin),
  subscribe(callback) {
    if (typeof callback !== 'function') throw new TypeError('subscribe requires a function.')
    callbacks.add(callback)
    deliveredElicitations.set(callback, new Set())
    ipcRenderer.invoke(CHANNELS.getState).then((state) => {
      if (!callbacks.has(callback)) return
      const delivered = deliveredElicitations.get(callback)
      const requests = Array.isArray(state?.pendingElicitationRequests)
        ? state.pendingElicitationRequests
        : []
      for (const request of requests) {
        const requestId = request?.requestId == null ? null : String(request.requestId)
        if (!requestId || resolvedElicitationIds.has(requestId) || delivered?.has(requestId)) continue
        delivered?.add(requestId)
        callback({
          ...request,
          type: 'elicitation.requested',
          at: new Date().toISOString()
        })
      }
    }).catch(() => {
      // Live event delivery remains available when pending-request hydration fails.
    })
    return () => callbacks.delete(callback)
  },
  respondApproval: (requestId, decision) =>
    ipcRenderer.invoke(CHANNELS.respondApproval, { requestId, decision }),
  respondElicitation: (requestId, response) =>
    ipcRenderer.invoke(CHANNELS.respondElicitation, {
      requestId,
      action: response?.action,
      content: response?.content
    }),
  interrupt: () => ipcRenderer.invoke(CHANNELS.interrupt),
  dispose() {
    callbacks.clear()
    resolvedElicitationIds.clear()
    ipcRenderer.removeListener(CHANNELS.event, dispatchEvent)
  }
})

const cowartMcp = Object.freeze({
  callServerTool: (request) => ipcRenderer.invoke(CHANNELS.callCowartTool, request),
  sendFollowUpMessage: (message) => ipcRenderer.invoke(CHANNELS.sendTask, message),
  getHostCapabilities: () => bootstrap.capabilities || null
})

const openai = Object.freeze({
  toolOutput: Object.freeze({
    projectDir: bootstrap.toolOutput?.projectDir,
    canvasDir: bootstrap.toolOutput?.canvasDir
  })
})

contextBridge.exposeInMainWorld('yogurtAgent', yogurtAgent)
contextBridge.exposeInMainWorld('cowartMcp', cowartMcp)
contextBridge.exposeInMainWorld('openai', openai)
