'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = Object.freeze({
  bootstrap: 'yogurt-agent:bootstrap',
  callCowartTool: 'yogurt-agent:call-cowart-tool',
  event: 'yogurt-agent:event',
  getState: 'yogurt-agent:get-state',
  refreshCapabilities: 'yogurt-agent:refresh-capabilities',
  respondApproval: 'yogurt-agent:respond-approval',
  sendTask: 'yogurt-agent:send-task',
  interrupt: 'yogurt-agent:interrupt'
})

const bootstrap = ipcRenderer.sendSync(CHANNELS.bootstrap) || {}
if (bootstrap.error) throw new Error(bootstrap.error)

const callbacks = new Set()
const dispatchEvent = (_event, payload) => {
  for (const callback of callbacks) {
    try {
      callback(payload)
    } catch {
      // A renderer listener cannot break delivery to the remaining listeners.
    }
  }
}
ipcRenderer.on(CHANNELS.event, dispatchEvent)

const yogurtAgent = Object.freeze({
  sendTask: (task) => ipcRenderer.invoke(CHANNELS.sendTask, task),
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  getCapabilities: () => bootstrap.capabilities || null,
  refreshCapabilities: () => ipcRenderer.invoke(CHANNELS.refreshCapabilities),
  subscribe(callback) {
    if (typeof callback !== 'function') throw new TypeError('subscribe requires a function.')
    callbacks.add(callback)
    return () => callbacks.delete(callback)
  },
  respondApproval: (requestId, decision) =>
    ipcRenderer.invoke(CHANNELS.respondApproval, { requestId, decision }),
  interrupt: () => ipcRenderer.invoke(CHANNELS.interrupt),
  dispose() {
    callbacks.clear()
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
