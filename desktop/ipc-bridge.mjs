export const IPC_CHANNELS = Object.freeze({
  bootstrap: 'yogurt-agent:bootstrap',
  callCowartTool: 'yogurt-agent:call-cowart-tool',
  event: 'yogurt-agent:event',
  getState: 'yogurt-agent:get-state',
  refreshCapabilities: 'yogurt-agent:refresh-capabilities',
  respondApproval: 'yogurt-agent:respond-approval',
  sendTask: 'yogurt-agent:send-task',
  interrupt: 'yogurt-agent:interrupt'
})

function sameWebContents(sender, trusted) {
  return Boolean(sender && trusted && (sender === trusted || sender.id === trusted.id))
}

export function createDesktopBootstrap(agentService) {
  return Object.freeze({
    toolOutput: Object.freeze({
      projectDir: agentService.projectDir,
      canvasDir: agentService.canvasDir
    }),
    capabilities: agentService.getCapabilities()
  })
}

export function registerYogurtAgentIpc({
  ipcMain,
  agentService,
  getTrustedWebContents,
  claimBootstrapWebContents
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('registerYogurtAgentIpc requires Electron ipcMain.')
  }
  if (!agentService || typeof agentService.sendTask !== 'function') {
    throw new TypeError('registerYogurtAgentIpc requires a YogurtAgentService.')
  }

  const trustedSender = (event, { allowBootstrapClaim = false } = {}) => {
    const trusted = getTrustedWebContents?.()
    if (sameWebContents(event?.sender, trusted)) return trusted
    if (
      allowBootstrapClaim &&
      !trusted &&
      typeof claimBootstrapWebContents === 'function' &&
      claimBootstrapWebContents(event?.sender) === true
    ) {
      return event.sender
    }
    throw new Error('Rejected IPC from an untrusted renderer.')
  }

  const bootstrapHandler = (event) => {
    try {
      trustedSender(event, { allowBootstrapClaim: true })
      event.returnValue = createDesktopBootstrap(agentService)
    } catch (error) {
      event.returnValue = { error: String(error?.message || error) }
    }
  }
  ipcMain.on(IPC_CHANNELS.bootstrap, bootstrapHandler)

  const handlers = new Map([
    [IPC_CHANNELS.getState, async (event) => {
      trustedSender(event)
      return agentService.getState()
    }],
    [IPC_CHANNELS.refreshCapabilities, async (event) => {
      trustedSender(event)
      return agentService.refreshCapabilities()
    }],
    [IPC_CHANNELS.sendTask, async (event, task) => {
      trustedSender(event)
      return agentService.sendTask(task)
    }],
    [IPC_CHANNELS.respondApproval, async (event, payload) => {
      trustedSender(event)
      return agentService.respondApproval(payload?.requestId, payload?.decision)
    }],
    [IPC_CHANNELS.interrupt, async (event) => {
      trustedSender(event)
      return agentService.interrupt()
    }],
    [IPC_CHANNELS.callCowartTool, async (event, request) => {
      trustedSender(event)
      return agentService.callCowartTool(request)
    }]
  ])

  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler)

  const forwardEvent = (payload) => {
    const webContents = getTrustedWebContents?.()
    if (!webContents || webContents.isDestroyed?.()) return
    webContents.send(IPC_CHANNELS.event, payload)
  }
  agentService.on('event', forwardEvent)

  return () => {
    ipcMain.removeListener(IPC_CHANNELS.bootstrap, bootstrapHandler)
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel)
    agentService.off('event', forwardEvent)
  }
}
