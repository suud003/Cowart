import { sendTrackedWidgetMessage } from './analytics.js'
import { createAgentBridge } from './agentBridge.js'
import { createCodexHostAgentAdapter } from './codexHostAgentAdapter.js'

const bridgesByWindow = new WeakMap()

export function getCowartAgentBridge(windowObject = globalThis.window) {
  if (!windowObject || (typeof windowObject !== 'object' && typeof windowObject !== 'function')) {
    return createAgentBridge(null)
  }

  let bridge = bridgesByWindow.get(windowObject)
  if (bridge) return bridge

  const adapter = createCodexHostAgentAdapter(windowObject)
  bridge = createAgentBridge(adapter, {
    dispatchTask: (currentAdapter, message, options) =>
      sendTrackedWidgetMessage(
        (value) => currentAdapter.sendTask(value, options),
        message,
        options.analyticsContext
      )
  })
  bridgesByWindow.set(windowObject, bridge)
  return bridge
}

export function imageContentFromDataUrl(dataUrl, meta = {}) {
  const match = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
  if (!match) throw new Error('The exported canvas region is not a valid image data URL.')
  return {
    type: 'image',
    data: match[2],
    mimeType: match[1],
    _meta: meta
  }
}

export function followUpSender(windowObject = globalThis.window) {
  const bridge = getCowartAgentBridge(windowObject)
  bridge.refreshCapabilities({ emit: false })
  if (!bridge.capabilities.sendTask) return null

  return (message, analyticsContext = {}) => bridge.sendTask(message, { analyticsContext })
}

export function supportsMessageImages(windowObject = globalThis.window) {
  const bridge = getCowartAgentBridge(windowObject)
  bridge.refreshCapabilities({ emit: false })
  return bridge.capabilities.message.image
}
