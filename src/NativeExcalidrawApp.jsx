import {
  CaptureUpdateAction,
  Excalidraw,
  Sidebar,
  serializeAsJSON
} from '@excalidraw/excalidraw'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { FolderTree } from 'lucide-react'

import { CowartAgentPanel } from './AgentPanel.jsx'
import { CanvasNavigator } from './CanvasNavigator.jsx'
import agentBaseStyles from './styles.css?inline'
import agentEditorialStyles from './editorialTheme.css?inline'
import agentAtelierStyles from './atelierTheme.css?inline'
import { persistCowartAiMode, readCowartAiMode } from './aiMode.js'
import {
  createCowartCanvas,
  deleteCowartCanvas,
  loadCowartCanvasState,
  moveCowartCanvas,
  refreshCowartCanvasState,
  renameCowartCanvas,
  saveCowartCanvasSnapshot,
  saveCowartSelectionState,
  saveCowartViewState,
  setActiveCowartCanvas
} from './cowartClient.js'
import {
  cowartExcalidrawViewState,
  cowartViewStateSignature,
  isExplicitEmptyCowartCanvasState,
  mergeCowartExcalidrawViewState,
  newestCowartPendingScene,
  shouldIgnoreCanvasRefreshAfterFetch
} from './canvasSync.js'
import {
  emptyExcalidrawDocument,
  isExcalidrawDocument,
  normalizeExcalidrawDocument
} from './excalidrawDocument.js'
import { getCowartAgentBridge } from './widgetMessaging.js'

const SCENE_POLL_INTERVAL_MS = 1_100
const SCENE_SAVE_DELAY_MS = 450
const VIEW_STATE_SAVE_DELAY_MS = 300
const MAX_CONTEXT_IDS = 250

const AGENT_SHADOW_OVERRIDES = `
  :host {
    display: block;
    min-width: 0;
    width: 100%;
    height: 100%;
    background: #fbfaf7;
    border-left: 1px solid #dedbd3;
    color: #1f1f1d;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  *, *::before, *::after { box-sizing: border-box; }
  .native-agent-shadow-root,
  .cowart-workbench {
    position: relative !important;
    inset: auto !important;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: block !important;
    background: #fbfaf7;
  }
  .cowart-agent-panel {
    position: relative !important;
    inset: auto !important;
    grid-area: auto !important;
    width: 100% !important;
    max-width: none !important;
    height: 100% !important;
    max-height: none !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  .cowart-agent-panel-launcher { display: none !important; }
  .cowart-agent-quick-grid,
  .cowart-agent-selected-invocation { display: none !important; }
`

function sceneSignature(elements, appState, files) {
  return JSON.stringify({
    elements: (elements || []).map((element) => [
      element.id,
      element.version,
      element.versionNonce,
      element.isDeleted,
      element.index
    ]),
    background: appState?.viewBackgroundColor || '#ffffff',
    files: Object.values(files || {}).map((file) => [file.id, file.created, file.lastRetrieved])
  })
}

function cowartProjectIdentity(windowObject = globalThis.window) {
  const output =
    windowObject?.yogurtAgent?.toolOutput ??
    windowObject?.cowartMcp?.toolOutput ??
    windowObject?.openai?.toolOutput ??
    null
  const explicitName = String(
    output?.projectName || output?.workspaceName || output?.canvasName || ''
  ).trim()
  const projectDir = String(output?.projectDir || '').trim().replace(/[\\/]+$/, '')
  return {
    projectName: explicitName || projectDir.split(/[\\/]/).filter(Boolean).at(-1) || 'Yogurt AI 画布',
    projectScopeId: String(output?.projectScopeId || '').trim() || null
  }
}

function canvasBreadcrumb(project, canvasId) {
  const byId = new Map((project?.canvases || []).map((canvas) => [canvas.id, canvas]))
  const labels = []
  const visited = new Set()
  let current = byId.get(canvasId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    labels.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : null
  }
  return labels
}

function canvasProjectMutationRevision(project, revision) {
  return project?.createdAt ? revision || undefined : undefined
}

function canvasConflictMessage(error) {
  const message = error instanceof Error ? error.message : ''
  return message || '画布在本地编辑期间被其他操作更新。你的本地版本已保留。'
}

function createAgentContext(api, canvas, project, projectRevision = null) {
  const appState = api?.getAppState?.() || {}
  const elements = api?.getSceneElements?.() || []
  const selectedIds = Object.entries(appState.selectedElementIds || {})
    .filter(([, selected]) => selected)
    .map(([id]) => id)
  const exactShapeIds = selectedIds.slice(0, MAX_CONTEXT_IDS)
  const identity = cowartProjectIdentity()
  const canvasId = canvas?.id || project?.activeCanvasId || 'canvas_main'
  const pageName = canvas?.name || api?.getName?.() || 'Yogurt AI'
  const breadcrumb = canvasBreadcrumb(project, canvasId)
  return {
    ...identity,
    canvasId,
    canvasName: pageName,
    parentCanvasId: canvas?.parentId || null,
    canvasBreadcrumb: breadcrumb,
    projectRevision,
    pageId: canvasId,
    pageName,
    pageShapeCount: elements.length,
    scope: selectedIds.length > 0 ? 'selection' : 'page',
    selectedCount: selectedIds.length,
    selectedShapeIds: exactShapeIds,
    exactShapeIds,
    shapeIdsTruncated: exactShapeIds.length < selectedIds.length
  }
}

function fitSceneToVisibleCanvas(api) {
  const canvas = document.querySelector('.native-excalidraw-canvas')
  const viewport = canvas?.getBoundingClientRect?.()
  const elements = (api?.getSceneElements?.() || []).filter((element) => !element.isDeleted)
  if (!viewport || elements.length === 0) return

  const bounds = elements.map((element) => {
    if ((element.type === 'arrow' || element.type === 'line') && element.points?.length) {
      const points = element.points.map(([x, y]) => ({ x: element.x + x, y: element.y + y }))
      return {
        left: Math.min(...points.map((point) => point.x)),
        top: Math.min(...points.map((point) => point.y)),
        right: Math.max(...points.map((point) => point.x)),
        bottom: Math.max(...points.map((point) => point.y))
      }
    }
    return {
      left: element.x,
      top: element.y,
      right: element.x + element.width,
      bottom: element.y + element.height
    }
  })
  const scene = {
    left: Math.min(...bounds.map((bound) => bound.left)),
    top: Math.min(...bounds.map((bound) => bound.top)),
    right: Math.max(...bounds.map((bound) => bound.right)),
    bottom: Math.max(...bounds.map((bound) => bound.bottom))
  }
  const sceneWidth = Math.max(1, scene.right - scene.left)
  const sceneHeight = Math.max(1, scene.bottom - scene.top)
  const padding = { left: 32, right: 32, top: 96, bottom: 48 }
  const zoomValue = Math.max(0.1, Math.min(
    1,
    (viewport.width - padding.left - padding.right) / sceneWidth,
    (viewport.height - padding.top - padding.bottom) / sceneHeight
  ))
  api.updateScene?.({
    appState: {
      zoom: { value: zoomValue },
      scrollX: padding.left / zoomValue - scene.left,
      scrollY: padding.top / zoomValue - scene.top
    }
  })
}

function AgentShadowPanel(props) {
  const hostRef = useRef(null)
  const [portalRoot, setPortalRoot] = useState(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const shadowRoot = host.shadowRoot || host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = [
      agentBaseStyles,
      agentEditorialStyles,
      agentAtelierStyles,
      AGENT_SHADOW_OVERRIDES
    ].join('\n')
    const root = document.createElement('div')
    root.className = 'native-agent-shadow-root'
    shadowRoot.replaceChildren(style, root)
    setPortalRoot(root)
    return () => setPortalRoot(null)
  }, [])

  return (
    <aside className="native-excalidraw-agent-host" ref={hostRef}>
      {portalRoot && createPortal(
        <div className="cowart-workbench" data-agent-open="true" data-ai-mode="on">
          <CowartAgentPanel {...props} isOpen />
        </div>,
        portalRoot
      )}
    </aside>
  )
}

export default function NativeExcalidrawApp() {
  const [isAiModeEnabled, setIsAiModeEnabled] = useState(readCowartAiMode)
  const [agentBridge, setAgentBridge] = useState(null)
  const [agentAttention, setAgentAttention] = useState(null)
  const [canvasProjectState, setCanvasProjectState] = useState(null)
  const [editorSession, setEditorSession] = useState(null)
  const [isCanvasBusy, setIsCanvasBusy] = useState(true)
  const [canvasLoadError, setCanvasLoadError] = useState(null)
  const [canvasSaveConflict, setCanvasSaveConflict] = useState(null)
  const [isCanvasNavigatorOpen, setIsCanvasNavigatorOpen] = useState(false)
  const [isCanvasNavigatorDocked, setIsCanvasNavigatorDocked] = useState(true)
  const apiRef = useRef(null)
  const activeCanvasIdRef = useRef(null)
  const canvasProjectRef = useRef(null)
  const projectRevisionRef = useRef(null)
  const revisionByCanvasRef = useRef(new Map())
  const signatureByCanvasRef = useRef(new Map())
  const sceneGenerationByCanvasRef = useRef(new Map())
  const viewGenerationByCanvasRef = useRef(new Map())
  const viewSignatureByCanvasRef = useRef(new Map())
  const pendingViewStateByCanvasRef = useRef(new Map())
  const viewSaveTimerByCanvasRef = useRef(new Map())
  const saveConflictsByCanvasRef = useRef(new Map())
  const pendingSceneRef = useRef(null)
  const saveTimerRef = useRef(null)
  const saveChainRef = useRef(Promise.resolve())
  const viewSaveChainRef = useRef(Promise.resolve())
  const suppressSceneSaveRef = useRef(false)
  const viewportBeforeAiRef = useRef(null)
  const navigatorOpenRef = useRef(false)
  const canvasOperationRef = useRef(0)
  const initialLoadOperationRef = useRef(0)
  const savesInFlightByCanvasRef = useRef(new Map())

  const applyProjectState = useCallback((project, projectRevision) => {
    if (!project) return
    const nextRevision = projectRevision ?? projectRevisionRef.current ?? null
    canvasProjectRef.current = project
    projectRevisionRef.current = nextRevision
    setCanvasProjectState({ project, projectRevision: nextRevision })
  }, [])

  const registerSaveConflict = useCallback((canvasId, pending, error) => {
    const previous = saveConflictsByCanvasRef.current.get(canvasId)
    const next = {
      canvasId,
      pending: newestCowartPendingScene(previous?.pending, pending),
      error,
      remoteRevision:
        error?.details?.currentRevision ??
        error?.details?.revision ??
        previous?.remoteRevision ??
        null
    }
    saveConflictsByCanvasRef.current.set(canvasId, next)
    if (activeCanvasIdRef.current === canvasId) setCanvasSaveConflict(next)
    return next
  }, [])

  const installCanvasState = useCallback((state, projectOverride = null) => {
    const project = projectOverride?.project || state.project || canvasProjectRef.current
    const canvasId = state.canvasId || state.canvas?.id || project?.activeCanvasId || 'canvas_main'
    const canvas = state.canvas || project?.canvases?.find((item) => item.id === canvasId)
    if (!canvas) throw new Error(`画布 ${canvasId} 不在当前项目中。`)
    const isLegacyTldrawDocument = Boolean(state.snapshot?.store && state.snapshot?.schema)
    const isExplicitEmptyProject = isExplicitEmptyCowartCanvasState(state)
    if (
      !isExcalidrawDocument(state.snapshot) &&
      !isLegacyTldrawDocument &&
      !isExplicitEmptyProject
    ) {
      throw new Error('项目没有返回可识别的 Excalidraw 画布，已停止打开以保护现有内容。')
    }
    const normalizedDocument = isExplicitEmptyProject
      ? emptyExcalidrawDocument()
      : normalizeExcalidrawDocument(state.snapshot)
    const document = mergeCowartExcalidrawViewState(
      normalizedDocument,
      state.viewState,
      canvasId
    )
    const projectRevision = projectOverride?.projectRevision ?? state.projectRevision ?? null

    apiRef.current = null
    activeCanvasIdRef.current = canvasId
    pendingSceneRef.current = null
    pendingViewStateByCanvasRef.current.delete(canvasId)
    saveConflictsByCanvasRef.current.delete(canvasId)
    setCanvasSaveConflict(null)
    revisionByCanvasRef.current.set(canvasId, state.revision ?? null)
    sceneGenerationByCanvasRef.current.set(
      canvasId,
      (sceneGenerationByCanvasRef.current.get(canvasId) || 0) + 1
    )
    viewGenerationByCanvasRef.current.set(
      canvasId,
      (viewGenerationByCanvasRef.current.get(canvasId) || 0) + 1
    )
    signatureByCanvasRef.current.set(
      canvasId,
      sceneSignature(document.elements, document.appState, document.files)
    )
    viewSignatureByCanvasRef.current.set(
      canvasId,
      cowartViewStateSignature(cowartExcalidrawViewState(canvasId, document.appState, null))
    )
    applyProjectState(project, projectRevision)
    setEditorSession({ canvasId, document })
  }, [applyProjectState])

  const loadInitialCanvas = useCallback(async () => {
    const operationId = ++initialLoadOperationRef.current
    setIsCanvasBusy(true)
    setCanvasLoadError(null)
    try {
      const state = await loadCowartCanvasState()
      if (operationId !== initialLoadOperationRef.current) return
      installCanvasState(state)
    } catch (error) {
      console.error('Unable to load the Yogurt AI Excalidraw project.', error)
      if (operationId !== initialLoadOperationRef.current) return
      apiRef.current = null
      activeCanvasIdRef.current = null
      setEditorSession(null)
      setCanvasLoadError({
        message: error instanceof Error && error.message
          ? error.message
          : '无法读取画布项目。'
      })
    } finally {
      if (operationId === initialLoadOperationRef.current) setIsCanvasBusy(false)
    }
  }, [installCanvasState])

  useEffect(() => {
    loadInitialCanvas()
    return () => { initialLoadOperationRef.current += 1 }
  }, [loadInitialCanvas])

  const persistPendingViewState = useCallback(async (requestedCanvasId = null) => {
    const canvasId = requestedCanvasId || activeCanvasIdRef.current
    if (!canvasId) return viewSaveChainRef.current
    const timer = viewSaveTimerByCanvasRef.current.get(canvasId)
    if (timer) {
      window.clearTimeout(timer)
      viewSaveTimerByCanvasRef.current.delete(canvasId)
    }
    const pending = pendingViewStateByCanvasRef.current.get(canvasId)
    if (!pending) return viewSaveChainRef.current
    pendingViewStateByCanvasRef.current.delete(canvasId)

    const operation = viewSaveChainRef.current.catch(() => undefined).then(async () => {
      const result = await saveCowartViewState(pending.viewState, { canvasId })
      viewSignatureByCanvasRef.current.set(canvasId, pending.signature)
      return result
    })
    viewSaveChainRef.current = operation.catch((error) => {
      console.error('Unable to save the Yogurt AI Excalidraw viewport.', error)
      if (
        !pendingViewStateByCanvasRef.current.has(canvasId) &&
        (viewGenerationByCanvasRef.current.get(canvasId) || 0) <= pending.generation
      ) {
        pendingViewStateByCanvasRef.current.set(canvasId, pending)
      }
      return null
    })
    return operation
  }, [])

  const queueViewState = useCallback((canvasId, appState) => {
    if (!canvasId) return
    const viewState = cowartExcalidrawViewState(canvasId, appState)
    const signature = cowartViewStateSignature(viewState)
    if (!signature) return
    const pending = pendingViewStateByCanvasRef.current.get(canvasId)
    if (
      signature === viewSignatureByCanvasRef.current.get(canvasId) ||
      signature === pending?.signature
    ) return

    const generation = (viewGenerationByCanvasRef.current.get(canvasId) || 0) + 1
    viewGenerationByCanvasRef.current.set(canvasId, generation)
    pendingViewStateByCanvasRef.current.set(canvasId, { viewState, signature, generation })
    const previousTimer = viewSaveTimerByCanvasRef.current.get(canvasId)
    if (previousTimer) window.clearTimeout(previousTimer)
    viewSaveTimerByCanvasRef.current.set(canvasId, window.setTimeout(() => {
      viewSaveTimerByCanvasRef.current.delete(canvasId)
      persistPendingViewState(canvasId).catch(() => undefined)
    }, VIEW_STATE_SAVE_DELAY_MS))
  }, [persistPendingViewState])

  const persistPendingScene = useCallback(async (options = {}) => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const retryConflict = options.conflictRetry || null
    const canvasId = retryConflict?.canvasId || activeCanvasIdRef.current
    const pending = retryConflict?.pending || pendingSceneRef.current
    if (!pending) {
      await saveChainRef.current
      const conflict = canvasId ? saveConflictsByCanvasRef.current.get(canvasId) : null
      if (conflict) throw conflict.error
      const retained = pendingSceneRef.current?.canvasId === canvasId
        ? pendingSceneRef.current
        : null
      if (retained) {
        throw retained.saveError || new Error('本地画布尚未保存，已阻止切换以保护修改。')
      }
      return null
    }
    if (pendingSceneRef.current === pending) pendingSceneRef.current = null

    const currentConflict = saveConflictsByCanvasRef.current.get(pending.canvasId)
    if (currentConflict && !retryConflict) {
      const conflict = registerSaveConflict(pending.canvasId, pending, currentConflict.error)
      throw conflict.error
    }

    const operation = saveChainRef.current.catch(() => undefined).then(async () => {
      const queuedConflict = saveConflictsByCanvasRef.current.get(pending.canvasId)
      if (queuedConflict && !retryConflict) {
        const conflict = registerSaveConflict(pending.canvasId, pending, queuedConflict.error)
        throw conflict.error
      }

      savesInFlightByCanvasRef.current.set(
        pending.canvasId,
        (savesInFlightByCanvasRef.current.get(pending.canvasId) || 0) + 1
      )
      const serialized = serializeAsJSON(
        pending.elements,
        pending.appState,
        pending.files,
        'local'
      )
      const document = {
        ...JSON.parse(serialized),
        source: 'https://github.com/suud003/Cowart',
        yogurt: {
          runtime: 'official-excalidraw',
          canvasId: pending.canvasId,
          savedAt: new Date().toISOString()
        }
      }
      try {
        const result = await saveCowartCanvasSnapshot(document, {
          canvasId: pending.canvasId,
          baseRevision: options.baseRevision ??
            revisionByCanvasRef.current.get(pending.canvasId) ??
            undefined
        })
        revisionByCanvasRef.current.set(
          pending.canvasId,
          result?.revision ?? revisionByCanvasRef.current.get(pending.canvasId) ?? null
        )
        signatureByCanvasRef.current.set(pending.canvasId, pending.signature)
        if (retryConflict) {
          const retained = saveConflictsByCanvasRef.current.get(pending.canvasId)
          if (!retained || (retained.pending?.generation ?? 0) <= (pending.generation ?? 0)) {
            saveConflictsByCanvasRef.current.delete(pending.canvasId)
            if (activeCanvasIdRef.current === pending.canvasId) setCanvasSaveConflict(null)
          }
        }
        return result
      } catch (error) {
        console.error('Unable to save the Yogurt AI Excalidraw document.', error)
        const queued = pendingSceneRef.current?.canvasId === pending.canvasId
          ? pendingSceneRef.current
          : null
        if (queued) pendingSceneRef.current = null
        const retained = newestCowartPendingScene(pending, queued)
        if (error?.code === 'COWART_REVISION_CONFLICT') {
          registerSaveConflict(pending.canvasId, retained, error)
        } else if (
          !pendingSceneRef.current &&
          (sceneGenerationByCanvasRef.current.get(pending.canvasId) || 0) <=
            (retained.generation ?? 0)
        ) {
          pendingSceneRef.current = { ...retained, saveError: error }
        }
        throw error
      } finally {
        const remaining = Math.max(
          0,
          (savesInFlightByCanvasRef.current.get(pending.canvasId) || 1) - 1
        )
        if (remaining > 0) savesInFlightByCanvasRef.current.set(pending.canvasId, remaining)
        else savesInFlightByCanvasRef.current.delete(pending.canvasId)
      }
    })
    saveChainRef.current = operation.catch(() => null)
    return operation
  }, [registerSaveConflict])

  const handleSceneChange = useCallback((elements, appState, files) => {
    if (suppressSceneSaveRef.current || isCanvasBusy) return
    const canvasId = activeCanvasIdRef.current
    if (!canvasId) return
    queueViewState(canvasId, appState)
    const signature = sceneSignature(elements, appState, files)
    const conflict = saveConflictsByCanvasRef.current.get(canvasId)
    if (signature === signatureByCanvasRef.current.get(canvasId) && !conflict) {
      if (pendingSceneRef.current?.canvasId === canvasId) pendingSceneRef.current = null
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      return
    }
    const priorPending = conflict?.pending || (
      pendingSceneRef.current?.canvasId === canvasId ? pendingSceneRef.current : null
    )
    const generation = priorPending?.signature === signature
      ? priorPending.generation
      : (sceneGenerationByCanvasRef.current.get(canvasId) || 0) + 1
    sceneGenerationByCanvasRef.current.set(canvasId, generation)
    const pending = { canvasId, elements, appState, files, signature, generation }
    if (conflict) {
      registerSaveConflict(canvasId, pending, conflict.error)
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      return
    }
    pendingSceneRef.current = pending
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      persistPendingScene().catch(() => undefined)
    }, SCENE_SAVE_DELAY_MS)
  }, [isCanvasBusy, persistPendingScene, queueViewState, registerSaveConflict])

  const handleExcalidrawApi = useCallback((api) => {
    apiRef.current = api
    globalThis.window.__cowartExcalidrawAPI = api
    globalThis.window.__cowartEditor = api
    if (navigatorOpenRef.current) {
      window.requestAnimationFrame(() => {
        api.toggleSidebar?.({ name: 'yogurt-canvases', force: true })
      })
    }
  }, [])

  const showCanvasError = useCallback((error, fallback) => {
    console.error(fallback, error)
    apiRef.current?.setToast?.({
      message: error instanceof Error && error.message ? error.message : fallback,
      closable: true,
      duration: 6000
    })
  }, [])

  const flushCurrentViewState = useCallback(async () => {
    const canvasId = activeCanvasIdRef.current
    const api = apiRef.current
    if (!canvasId) return
    if (api) queueViewState(canvasId, api.getAppState?.() || {})
    try {
      await persistPendingViewState(canvasId)
    } catch (error) {
      showCanvasError(error, '无法保存当前画布视口。')
    }
  }, [persistPendingViewState, queueViewState, showCanvasError])

  const retryConflictedSave = useCallback(async () => {
    const conflict = canvasSaveConflict
    if (!conflict || conflict.canvasId !== activeCanvasIdRef.current || isCanvasBusy) return
    const operationId = ++canvasOperationRef.current
    setIsCanvasBusy(true)
    try {
      let baseRevision = conflict.remoteRevision
      if (!baseRevision) {
        const remote = await refreshCowartCanvasState({ canvasId: conflict.canvasId })
        if (operationId !== canvasOperationRef.current) return
        baseRevision = remote.revision ?? null
      }
      if (!baseRevision) {
        throw new Error('无法读取远端画布版本，本地修改仍已保留，请稍后重试。')
      }
      revisionByCanvasRef.current.set(conflict.canvasId, baseRevision)
      await persistPendingScene({
        baseRevision,
        conflictRetry: conflict
      })
      apiRef.current?.setToast?.({
        message: '本地画布已基于最新版本重新保存。',
        closable: true,
        duration: 3500
      })
    } catch (error) {
      showCanvasError(error, '重试保存失败，本地版本仍然保留。')
    } finally {
      if (operationId === canvasOperationRef.current) setIsCanvasBusy(false)
    }
  }, [canvasSaveConflict, isCanvasBusy, persistPendingScene, showCanvasError])

  const switchCanvas = useCallback(async (canvasId) => {
    if (!canvasId || canvasId === activeCanvasIdRef.current || isCanvasBusy) return
    const operationId = ++canvasOperationRef.current
    setIsCanvasBusy(true)
    try {
      await persistPendingScene()
      await flushCurrentViewState()
      const loaded = await loadCowartCanvasState({ canvasId })
      const activation = await setActiveCowartCanvas(canvasId, {
        baseProjectRevision: loaded.projectRevision ?? projectRevisionRef.current ?? undefined
      })
      if (operationId !== canvasOperationRef.current) return
      installCanvasState(loaded, {
        project: activation.project || loaded.project,
        projectRevision: activation.projectRevision ?? loaded.projectRevision
      })
    } catch (error) {
      showCanvasError(error, '无法切换画布。')
    } finally {
      if (operationId === canvasOperationRef.current) setIsCanvasBusy(false)
    }
  }, [flushCurrentViewState, installCanvasState, isCanvasBusy, persistPendingScene, showCanvasError])

  const createCanvas = useCallback(async (parentId) => {
    if (isCanvasBusy) return
    const operationId = ++canvasOperationRef.current
    setIsCanvasBusy(true)
    try {
      await persistPendingScene()
      await flushCurrentViewState()
      const nextCanvasNumber = (canvasProjectRef.current?.canvases?.length || 0) + 1
      const created = await createCowartCanvas({
        name: `画布 ${nextCanvasNumber}`,
        parentId,
        activate: true,
        baseProjectRevision: canvasProjectMutationRevision(
          canvasProjectRef.current,
          projectRevisionRef.current
        )
      })
      const canvasId = created.canvas?.id || created.project?.activeCanvasId
      if (!canvasId) throw new Error('新画布已创建，但没有返回画布标识。')
      const loaded = await loadCowartCanvasState({ canvasId })
      if (operationId !== canvasOperationRef.current) return
      installCanvasState(loaded, {
        project: created.project || loaded.project,
        projectRevision: created.projectRevision ?? loaded.projectRevision
      })
    } catch (error) {
      showCanvasError(error, '无法新建画布。')
    } finally {
      if (operationId === canvasOperationRef.current) setIsCanvasBusy(false)
    }
  }, [flushCurrentViewState, installCanvasState, isCanvasBusy, persistPendingScene, showCanvasError])

  const renameCanvas = useCallback(async (canvasId, name) => {
    if (isCanvasBusy) return
    const operationId = ++canvasOperationRef.current
    setIsCanvasBusy(true)
    try {
      const result = await renameCowartCanvas(canvasId, name, {
        baseProjectRevision: canvasProjectMutationRevision(
          canvasProjectRef.current,
          projectRevisionRef.current
        )
      })
      if (operationId !== canvasOperationRef.current) return
      applyProjectState(result.project, result.projectRevision)
    } catch (error) {
      showCanvasError(error, '无法重命名画布。')
    } finally {
      if (operationId === canvasOperationRef.current) setIsCanvasBusy(false)
    }
  }, [applyProjectState, isCanvasBusy, showCanvasError])

  const moveCanvas = useCallback(async (canvasId, parentId) => {
    if (isCanvasBusy) return
    const operationId = ++canvasOperationRef.current
    setIsCanvasBusy(true)
    try {
      const result = await moveCowartCanvas(canvasId, parentId, {
        baseProjectRevision: canvasProjectMutationRevision(
          canvasProjectRef.current,
          projectRevisionRef.current
        )
      })
      if (operationId !== canvasOperationRef.current) return
      applyProjectState(result.project, result.projectRevision)
    } catch (error) {
      showCanvasError(error, '无法移动画布。')
    } finally {
      if (operationId === canvasOperationRef.current) setIsCanvasBusy(false)
    }
  }, [applyProjectState, isCanvasBusy, showCanvasError])

  const removeCanvas = useCallback(async (canvasId) => {
    if (isCanvasBusy) return
    const operationId = ++canvasOperationRef.current
    const wasActive = canvasId === activeCanvasIdRef.current
    setIsCanvasBusy(true)
    try {
      await persistPendingScene()
      await flushCurrentViewState()
      const result = await deleteCowartCanvas(canvasId, {
        reparentChildren: true,
        baseProjectRevision: canvasProjectMutationRevision(
          canvasProjectRef.current,
          projectRevisionRef.current
        )
      })
      if (wasActive) {
        const nextCanvasId = result.project?.activeCanvasId
        if (!nextCanvasId) throw new Error('删除后没有可打开的画布。')
        const loaded = await loadCowartCanvasState({ canvasId: nextCanvasId })
        if (operationId !== canvasOperationRef.current) return
        installCanvasState(loaded, {
          project: result.project || loaded.project,
          projectRevision: result.projectRevision ?? loaded.projectRevision
        })
      } else {
        applyProjectState(result.project, result.projectRevision)
      }
    } catch (error) {
      showCanvasError(error, '无法删除画布。')
    } finally {
      if (operationId === canvasOperationRef.current) setIsCanvasBusy(false)
    }
  }, [
    applyProjectState,
    flushCurrentViewState,
    installCanvasState,
    isCanvasBusy,
    persistPendingScene,
    showCanvasError
  ])

  const handleAiModeChange = useCallback((enabled) => {
    const api = apiRef.current
    if (enabled && api) {
      const appState = api.getAppState?.() || {}
      viewportBeforeAiRef.current = {
        scrollX: appState.scrollX,
        scrollY: appState.scrollY,
        zoom: appState.zoom
      }
    }
    setIsAiModeEnabled(persistCowartAiMode(enabled))
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const nextApi = apiRef.current
      nextApi?.refresh?.()
      if (!nextApi) return
      if (enabled) return
      if (viewportBeforeAiRef.current) {
        nextApi.updateScene?.({ appState: viewportBeforeAiRef.current })
        viewportBeforeAiRef.current = null
      }
    }))
  }, [])

  useEffect(() => {
    if (!isAiModeEnabled) return undefined
    apiRef.current?.refresh?.()
    fitSceneToVisibleCanvas(apiRef.current)
    return undefined
  }, [isAiModeEnabled])

  const getAgentContext = useCallback(() => {
    const project = canvasProjectRef.current
    const canvasId = activeCanvasIdRef.current
    const canvas = project?.canvases?.find((item) => item.id === canvasId) || null
    return createAgentContext(apiRef.current, canvas, project, projectRevisionRef.current)
  }, [])

  const prepareAgentTask = useCallback(async () => {
    const api = apiRef.current
    if (!api) throw new Error('Excalidraw 画布尚未就绪，请稍后再发送。')
    const canvasId = activeCanvasIdRef.current
    const project = canvasProjectRef.current
    const canvas = project?.canvases?.find((item) => item.id === canvasId) || null
    const context = createAgentContext(api, canvas, project, projectRevisionRef.current)
    const elements = api.getSceneElements()
    const elementsById = new Map(elements.map((element) => [element.id, element]))
    const selection = {
      canvasId,
      canvasName: context.canvasName,
      selectedShapes: context.exactShapeIds.map((id) => {
        const element = elementsById.get(id)
        return {
          id,
          type: element?.type || null,
          customData: element?.customData || null
        }
      }),
      selectedRootShapeIds: context.selectedShapeIds,
      exactShapeIds: context.exactShapeIds,
      scope: context.scope,
      currentPageId: context.pageId,
      currentPageName: context.pageName,
      requestType: 'agent-panel',
      updatedAt: new Date().toISOString()
    }
    await persistPendingScene()
    await saveCowartSelectionState(selection, { canvasId })
    return context
  }, [persistPendingScene])

  useEffect(() => {
    function handleKeyDown(event) {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'a') {
        event.preventDefault()
        handleAiModeChange(!isAiModeEnabled)
      }
      if (key === 'o') {
        event.preventDefault()
        const nextOpen = !navigatorOpenRef.current
        navigatorOpenRef.current = nextOpen
        setIsCanvasNavigatorOpen(nextOpen)
        apiRef.current?.toggleSidebar?.({ name: 'yogurt-canvases', force: nextOpen })
      }
    }

    function handleNativeToggle() {
      handleAiModeChange(!isAiModeEnabled)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('yogurt:toggle-ai-mode', handleNativeToggle)
    const unsubscribe = window.yogurtDesktop?.subscribeAiModeToggle?.(handleNativeToggle)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('yogurt:toggle-ai-mode', handleNativeToggle)
      unsubscribe?.()
    }
  }, [handleAiModeChange, isAiModeEnabled])

  useEffect(() => {
    if (!isAiModeEnabled) {
      setAgentBridge(null)
      return undefined
    }
    const bridge = getCowartAgentBridge(window)
    setAgentBridge(bridge)
    Promise.resolve(bridge.refreshCapabilities()).catch((error) => {
      console.error('Unable to refresh the Codex Agent bridge.', error)
    })
    return undefined
  }, [isAiModeEnabled])

  useEffect(() => {
    let disposed = false
    async function refreshScene() {
      if (
        disposed ||
        !apiRef.current ||
        pendingSceneRef.current ||
        saveConflictsByCanvasRef.current.size > 0 ||
        isCanvasBusy
      ) return
      const canvasId = activeCanvasIdRef.current
      const api = apiRef.current
      if (!canvasId) return
      if ((savesInFlightByCanvasRef.current.get(canvasId) || 0) > 0) return
      const generationBeforeFetch = sceneGenerationByCanvasRef.current.get(canvasId) || 0
      const revisionBeforeFetch = revisionByCanvasRef.current.get(canvasId) ?? null
      const canvasOperationBeforeFetch = canvasOperationRef.current
      try {
        const state = await refreshCowartCanvasState({ canvasId })
        if (disposed || activeCanvasIdRef.current !== canvasId || apiRef.current !== api) return
        if (state.canvasId && state.canvasId !== canvasId) return
        if (shouldIgnoreCanvasRefreshAfterFetch({
          generationBeforeFetch,
          currentGeneration: sceneGenerationByCanvasRef.current.get(canvasId) || 0,
          revisionBeforeFetch,
          currentRevision: revisionByCanvasRef.current.get(canvasId) ?? null,
          hasPendingScene: pendingSceneRef.current?.canvasId === canvasId,
          saveInFlight: (savesInFlightByCanvasRef.current.get(canvasId) || 0) > 0,
          hasSaveConflict: saveConflictsByCanvasRef.current.has(canvasId),
          canvasOperationChanged: canvasOperationBeforeFetch !== canvasOperationRef.current
        })) return
        if (state.project && state.projectRevision !== projectRevisionRef.current) {
          applyProjectState(state.project, state.projectRevision)
        }
        if (!isExcalidrawDocument(state?.snapshot)) return
        if (state.revision && state.revision === revisionByCanvasRef.current.get(canvasId)) return
        const document = normalizeExcalidrawDocument(state.snapshot)
        const signature = sceneSignature(document.elements, document.appState, document.files)
        if (signature === signatureByCanvasRef.current.get(canvasId)) {
          revisionByCanvasRef.current.set(
            canvasId,
            state.revision ?? revisionByCanvasRef.current.get(canvasId) ?? null
          )
          return
        }
        suppressSceneSaveRef.current = true
        api.addFiles(Object.values(document.files || {}))
        api.updateScene({
          elements: document.elements,
          appState: { viewBackgroundColor: document.appState?.viewBackgroundColor || '#ffffff' },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
        revisionByCanvasRef.current.set(
          canvasId,
          state.revision ?? revisionByCanvasRef.current.get(canvasId) ?? null
        )
        signatureByCanvasRef.current.set(canvasId, signature)
        window.setTimeout(() => {
          suppressSceneSaveRef.current = false
        }, 0)
      } catch (error) {
        if (!disposed) console.error('Unable to refresh the Excalidraw scene.', error)
      }
    }

    const timer = window.setInterval(refreshScene, SCENE_POLL_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [applyProjectState, isCanvasBusy])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    persistPendingScene().catch(() => undefined)
    flushCurrentViewState().catch(() => undefined)
    for (const timer of viewSaveTimerByCanvasRef.current.values()) {
      window.clearTimeout(timer)
    }
    viewSaveTimerByCanvasRef.current.clear()
    for (const canvasId of pendingViewStateByCanvasRef.current.keys()) {
      persistPendingViewState(canvasId).catch(() => undefined)
    }
    delete globalThis.window.__cowartExcalidrawAPI
    delete globalThis.window.__cowartEditor
  }, [flushCurrentViewState, persistPendingScene, persistPendingViewState])

  const project = canvasProjectState?.project || null
  const activeCanvas = project?.canvases?.find((canvas) => canvas.id === editorSession?.canvasId) || null

  return (
    <main
      aria-label={isAiModeEnabled ? 'Yogurt AI Excalidraw workspace' : 'Excalidraw canvas'}
      className="native-excalidraw-app"
      data-ai-mode={isAiModeEnabled ? 'on' : 'off'}
    >
      <section
        className="native-excalidraw-canvas"
        aria-busy={isCanvasBusy}
        aria-label="Excalidraw"
        data-canvas-navigator-open={isCanvasNavigatorOpen ? 'true' : 'false'}
      >
        {editorSession ? (
          <>
            <Excalidraw
              autoFocus
              excalidrawAPI={handleExcalidrawApi}
              handleKeyboardGlobally
              initialData={editorSession.document}
              key={editorSession.canvasId}
              langCode="zh-CN"
              name={activeCanvas?.name || 'Yogurt AI'}
              onChange={handleSceneChange}
            >
              <Sidebar
                className="yogurt-canvas-sidebar"
                docked={isCanvasNavigatorDocked && !isAiModeEnabled}
                name="yogurt-canvases"
                onDock={setIsCanvasNavigatorDocked}
                onStateChange={(state) => {
                  const open = state?.name === 'yogurt-canvases'
                  navigatorOpenRef.current = open
                  setIsCanvasNavigatorOpen(open)
                }}
              >
                <Sidebar.Header>
                  <span className="yogurt-canvas-sidebar-title">画布导航</span>
                </Sidebar.Header>
                <CanvasNavigator
                  activeCanvasId={editorSession.canvasId}
                  busy={isCanvasBusy}
                  onActivate={switchCanvas}
                  onCreate={createCanvas}
                  onDelete={removeCanvas}
                  onMove={moveCanvas}
                  onRename={renameCanvas}
                  project={project}
                />
              </Sidebar>
              <Sidebar.Trigger
                icon={<FolderTree aria-hidden="true" size={18} />}
                name="yogurt-canvases"
                title="画布导航（Ctrl/Cmd + Shift + O）"
              />
            </Excalidraw>
            {canvasSaveConflict?.canvasId === editorSession.canvasId && (
              <aside className="yogurt-canvas-conflict" role="alert">
                <div>
                  <strong>本地修改尚未保存</strong>
                  <span>远端画布已更新；当前本地内容已完整保留，重试将保存这个本地版本。</span>
                  <small>{canvasConflictMessage(canvasSaveConflict.error)}</small>
                </div>
                <button disabled={isCanvasBusy} onClick={retryConflictedSave} type="button">
                  保存本地版本
                </button>
              </aside>
            )}
          </>
        ) : canvasLoadError ? (
          <div className="yogurt-canvas-load-error" role="alert">
            <div>
              <strong>画布没有打开</strong>
              <span>为避免覆盖已有内容，Yogurt AI 没有创建空白画布。</span>
              <small>{canvasLoadError.message}</small>
            </div>
            <button disabled={isCanvasBusy} onClick={loadInitialCanvas} type="button">
              重新读取项目
            </button>
          </div>
        ) : (
          <div className="yogurt-canvas-loading" role="status">正在打开画布…</div>
        )}
      </section>
      {isAiModeEnabled && (
        <AgentShadowPanel
          beforeSend={prepareAgentTask}
          bridge={agentBridge}
          contextProvider={getAgentContext}
          isModal={false}
          onAttentionChange={setAgentAttention}
          onOpenChange={(open) => {
            if (!open) handleAiModeChange(false)
          }}
        />
      )}
      <span className="native-excalidraw-agent-announcer" aria-live="polite">
        {agentAttention?.accessibleLabel || ''}
      </span>
    </main>
  )
}
