export const AI_MODE_TOGGLE_CHANNEL = 'yogurt-desktop:toggle-ai-mode'
export const AI_MODE_TOGGLE_ACCELERATOR = 'CmdOrCtrl+Shift+A'

export function createYogurtApplicationMenuTemplate({
  platform = process.platform,
  onToggleAiMode
} = {}) {
  if (typeof onToggleAiMode !== 'function') {
    throw new TypeError('createYogurtApplicationMenuTemplate requires onToggleAiMode.')
  }

  const applicationMenu = [
    ...(platform === 'darwin'
      ? [
          { role: 'about' },
          { type: 'separator' }
        ]
      : []),
    {
      id: 'yogurt-ai-toggle-mode',
      label: '切换 AI 模式',
      accelerator: AI_MODE_TOGGLE_ACCELERATOR,
      click: onToggleAiMode
    },
    { type: 'separator' },
    ...(platform === 'darwin'
      ? [
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      : [{ role: 'quit' }])
  ]

  return [
    {
      label: 'Yogurt AI',
      submenu: applicationMenu
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        ...(platform === 'darwin'
          ? [{ role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }])
      ]
    }
  ]
}

export function sendAiModeToggle(getWindow, now = () => new Date().toISOString()) {
  const window = typeof getWindow === 'function' ? getWindow() : null
  const webContents = window?.webContents
  if (!webContents || webContents.isDestroyed?.()) return false
  webContents.send(AI_MODE_TOGGLE_CHANNEL, Object.freeze({
    type: 'toggle',
    source: 'application-menu',
    at: now()
  }))
  return true
}

export function installYogurtApplicationMenu({ Menu, getWindow, platform = process.platform }) {
  if (
    !Menu ||
    typeof Menu.buildFromTemplate !== 'function' ||
    typeof Menu.setApplicationMenu !== 'function'
  ) {
    throw new TypeError('installYogurtApplicationMenu requires Electron Menu.')
  }

  const template = createYogurtApplicationMenuTemplate({
    platform,
    onToggleAiMode: () => sendAiModeToggle(getWindow)
  })
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  return menu
}
