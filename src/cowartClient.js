const CANVAS_ENDPOINT = '/api/canvas'
const CANVAS_PROJECT_ENDPOINT = '/api/canvas-project'
const SELECTION_ENDPOINT = '/api/selection'
const VIEW_STATE_ENDPOINT = '/api/view-state'

const TOOL_GET_CANVAS_STATE = 'get_cowart_canvas_state'
const TOOL_SAVE_CANVAS_STATE = 'save_cowart_canvas_state'
const TOOL_MANAGE_CANVAS_PROJECT = 'manage_cowart_canvas_project'
const TOOL_SAVE_SELECTION_STATE = 'save_cowart_selection_state'
const TOOL_SAVE_VIEW_STATE = 'save_cowart_view_state'
const TOOL_SAVE_REFERENCE_IMAGE = 'save_cowart_reference_image'
const TOOL_READ_PAGE_ASSET = 'read_cowart_page_asset'
const TOOL_DOWNLOAD_FILE = 'download_cowart_file'
const TOOL_COPY_IMAGE_TO_CLIPBOARD = 'copy_cowart_image_to_clipboard'
const TOOL_INSERT_HTML_DRAFT = 'insert_cowart_html_draft'
const WIDGET_PAYLOAD_TIMEOUT_MS = 5000

globalThis.__COWART_WIDGET_FETCH_GUARD__ = true

export const IS_COWART_WIDGET_BUILD =
  typeof __COWART_WIDGET_BUILD__ !== 'undefined' && __COWART_WIDGET_BUILD__

export function hasCowartWidgetBridge() {
  return Boolean(window.cowartMcp && typeof window.cowartMcp.callServerTool === 'function')
}

function currentWidgetPayload() {
  return window.openai?.toolOutput && typeof window.openai.toolOutput === 'object'
    ? window.openai.toolOutput
    : {}
}

function hasWidgetStorageTarget() {
  const payload = currentWidgetPayload()
  return Boolean(payload.projectDir || payload.canvasDir)
}

function serverToolArgs(extra = {}) {
  const payload = currentWidgetPayload()
  return removeUndefined({
    projectDir: payload.projectDir,
    canvasDir: payload.canvasDir,
    ...extra
  })
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([_key, item]) => item !== undefined))
}

function abortError() {
  return new DOMException('The operation was aborted.', 'AbortError')
}

async function waitForWidgetPayload(signal) {
  if (!hasCowartWidgetBridge()) return
  if (hasWidgetStorageTarget()) return

  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('Yogurt AI storage target was not ready. Refusing to read or write without projectDir/canvasDir.'))
    }, WIDGET_PAYLOAD_TIMEOUT_MS)
    const cleanup = () => {
      window.clearTimeout(timer)
      window.removeEventListener('openai:set_globals', handleGlobals)
      signal?.removeEventListener('abort', handleAbort)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    const handleGlobals = () => {
      if (hasWidgetStorageTarget()) finish()
    }
    const handleAbort = () => {
      cleanup()
      reject(abortError())
    }

    window.addEventListener('openai:set_globals', handleGlobals, { once: true })
    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

async function callCowartServerTool(name, args = {}, options = {}) {
  await waitForWidgetPayload(options.signal)
  if (options.signal?.aborted) throw abortError()
  const result = await window.cowartMcp.callServerTool({
    name,
    arguments: serverToolArgs(args)
  })
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === 'text')?.text
    const error = new Error(message || `Yogurt AI server tool failed: ${name}`)
    const storageError = result.structuredContent?.storage
    error.code = storageError === 'revision-conflict'
      ? 'COWART_REVISION_CONFLICT'
      : storageError === 'project-revision-conflict'
        ? 'COWART_PROJECT_REVISION_CONFLICT'
        : result.structuredContent?.code || 'COWART_TOOL_ERROR'
    error.details = result.structuredContent ?? null
    throw error
  }
  return result.structuredContent ?? result
}

async function fetchJson(url, options = {}) {
  const response = await window.fetch(url, options)
  if (!response.ok) {
    const details = await response.json().catch(() => null)
    const error = new Error(
      details?.message || details?.error ||
      `Yogurt AI request failed: ${response.status} - ${response.statusText}`
    )
    error.code = response.status === 409
      ? (details?.code === 'COWART_PROJECT_REVISION_CONFLICT'
          ? 'COWART_PROJECT_REVISION_CONFLICT'
          : 'COWART_REVISION_CONFLICT')
      : details?.code || 'COWART_HTTP_ERROR'
    error.details = details
    throw error
  }
  return response.json()
}

function isAbortSignal(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof value.addEventListener === 'function' &&
    typeof value.aborted === 'boolean'
  )
}

function canvasRequestOptions(signalOrOptions) {
  if (isAbortSignal(signalOrOptions)) return { signal: signalOrOptions }
  return signalOrOptions && typeof signalOrOptions === 'object' ? signalOrOptions : {}
}

function canvasStateUrl(canvasId) {
  if (!canvasId) return CANVAS_ENDPOINT
  return `${CANVAS_ENDPOINT}?${new URLSearchParams({ canvasId: String(canvasId) })}`
}

function canvasScopedUrl(endpoint, canvasId) {
  if (!canvasId) return endpoint
  return `${endpoint}?${new URLSearchParams({ canvasId: String(canvasId) })}`
}

export async function loadCowartCanvasState(signalOrOptions) {
  const { canvasId, signal } = canvasRequestOptions(signalOrOptions)
  if (hasCowartWidgetBridge()) {
    const state = await callCowartServerTool(
      TOOL_GET_CANVAS_STATE,
      { hydrateAssets: false, canvasId },
      { signal }
    )
    return {
      snapshot: state.snapshot,
      revision: state.revision ?? null,
      viewState: state.viewState ?? null,
      storage: state.storage,
      canvasId: state.canvasId ?? null,
      canvas: state.canvas ?? null,
      project: state.project ?? null,
      projectRevision: state.projectRevision ?? null,
      skippedRecords: []
    }
  }

  const canvasData = await fetchJson(canvasStateUrl(canvasId), { signal })
  const resolvedCanvasId = canvasData.canvasId ?? canvasId
  const viewStateData = canvasData.viewState === undefined
    ? await fetchJson(canvasScopedUrl(VIEW_STATE_ENDPOINT, resolvedCanvasId), { signal })
    : { viewState: canvasData.viewState }
  return {
    snapshot: canvasData.snapshot,
    revision: canvasData.revision ?? null,
    viewState: viewStateData.viewState ?? null,
    storage: canvasData.storage,
    canvasId: canvasData.canvasId ?? null,
    canvas: canvasData.canvas ?? null,
    project: canvasData.project ?? null,
    projectRevision: canvasData.projectRevision ?? null,
    skippedRecords: []
  }
}

export async function refreshCowartCanvasSnapshot(signalOrOptions) {
  const { canvasId, signal } = canvasRequestOptions(signalOrOptions)
  if (hasCowartWidgetBridge()) {
    const state = await callCowartServerTool(
      TOOL_GET_CANVAS_STATE,
      { hydrateAssets: false, canvasId },
      { signal }
    )
    return state.snapshot
  }

  const canvasData = await fetchJson(canvasStateUrl(canvasId), { signal })
  return canvasData.snapshot
}

export async function refreshCowartCanvasState(signalOrOptions) {
  const { canvasId, signal } = canvasRequestOptions(signalOrOptions)
  if (hasCowartWidgetBridge()) {
    return callCowartServerTool(
      TOOL_GET_CANVAS_STATE,
      { hydrateAssets: false, canvasId },
      { signal }
    )
  }

  const canvasData = await fetchJson(canvasStateUrl(canvasId), { signal })
  return {
    snapshot: canvasData.snapshot,
    revision: canvasData.revision ?? null,
    canvasId: canvasData.canvasId ?? null,
    canvas: canvasData.canvas ?? null,
    project: canvasData.project ?? null,
    projectRevision: canvasData.projectRevision ?? null
  }
}

export async function saveCowartCanvasSnapshot(snapshot, options = {}) {
  if (hasCowartWidgetBridge()) {
    return callCowartServerTool(TOOL_SAVE_CANVAS_STATE, {
      snapshot,
      canvasId: options.canvasId,
      baseRevision: options.baseRevision,
      protectImageRecords: options.protectImageRecords,
      acknowledgedImageShapeDeletes: options.acknowledgedImageShapeDeletes
    })
  }

  return fetchJson(CANVAS_ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      snapshot,
      canvasId: options.canvasId,
      baseRevision: options.baseRevision,
      protectImageRecords: options.protectImageRecords,
      acknowledgedImageShapeDeletes: options.acknowledgedImageShapeDeletes
    })
  })
}

export async function manageCowartCanvasProject(operation = {}) {
  const payload = removeUndefined({
    action: operation.action,
    canvasId: operation.canvasId,
    name: operation.name,
    parentId: operation.parentId,
    order: operation.order ?? operation.index,
    mode: operation.mode,
    reparentChildren: operation.reparentChildren,
    activate: operation.activate,
    baseProjectRevision: operation.baseProjectRevision
  })
  if (Object.prototype.hasOwnProperty.call(operation, 'parentId')) {
    payload.parentId = operation.parentId
  }

  if (hasCowartWidgetBridge()) {
    return callCowartServerTool(TOOL_MANAGE_CANVAS_PROJECT, payload)
  }

  return fetchJson(CANVAS_PROJECT_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

export function createCowartCanvas(options = {}) {
  return manageCowartCanvasProject({ ...options, action: 'create' })
}

export function renameCowartCanvas(canvasId, name, options = {}) {
  return manageCowartCanvasProject({ ...options, action: 'update', canvasId, name })
}

export function moveCowartCanvas(canvasId, parentId, options = {}) {
  return manageCowartCanvasProject({ ...options, action: 'update', canvasId, parentId })
}

export function setActiveCowartCanvas(canvasId, options = {}) {
  return manageCowartCanvasProject({ ...options, action: 'set-active', canvasId })
}

export function deleteCowartCanvas(canvasId, options = {}) {
  return manageCowartCanvasProject({
    mode: 'reparent-children',
    reparentChildren: true,
    ...options,
    action: 'delete',
    canvasId
  })
}

export async function saveCowartSelectionState(selection, options = {}) {
  if (hasCowartWidgetBridge()) {
    return callCowartServerTool(TOOL_SAVE_SELECTION_STATE, {
      canvasId: options.canvasId,
      selection
    })
  }

  return fetchJson(SELECTION_ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...selection, canvasId: options.canvasId ?? selection.canvasId })
  })
}

export async function saveCowartViewState(viewState, options = {}) {
  if (hasCowartWidgetBridge()) {
    return callCowartServerTool(TOOL_SAVE_VIEW_STATE, {
      canvasId: options.canvasId,
      viewState
    })
  }

  return fetchJson(VIEW_STATE_ENDPOINT, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...viewState, canvasId: options.canvasId ?? viewState.canvasId })
  })
}

export async function saveCowartReferenceImage(reference) {
  if (!hasCowartWidgetBridge()) {
    throw new Error('当前 Yogurt AI 画布没有可用的 Codex MCP 文件保存桥。')
  }

  return callCowartServerTool(TOOL_SAVE_REFERENCE_IMAGE, reference)
}

export async function downloadCowartFile(download) {
  if (!hasCowartWidgetBridge()) {
    throw new Error('当前 Yogurt AI 画布没有可用的 Codex MCP 文件下载桥。')
  }

  return callCowartServerTool(TOOL_DOWNLOAD_FILE, download)
}

export async function copyCowartImageToClipboard(image) {
  if (!hasCowartWidgetBridge()) {
    throw new Error('当前 Yogurt AI 画布没有可用的系统剪贴板桥。')
  }

  return callCowartServerTool(TOOL_COPY_IMAGE_TO_CLIPBOARD, image)
}

export async function updateCowartHtmlDraft({ draftShapeId, htmlContent }) {
  if (!hasCowartWidgetBridge()) {
    return fetchJson('/api/html-draft', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draftShapeId, htmlContent })
    })
  }

  return callCowartServerTool(TOOL_INSERT_HTML_DRAFT, {
    draftShapeId,
    htmlContent,
    updateExistingDraft: true
  })
}

export async function readCowartPageAsset(assetUrl, options = {}) {
  if (!hasCowartWidgetBridge()) {
    throw new Error('当前 Yogurt AI 画布没有可用的 Codex MCP 文件读取桥。')
  }

  return callCowartServerTool(TOOL_READ_PAGE_ASSET, { assetUrl }, options)
}
