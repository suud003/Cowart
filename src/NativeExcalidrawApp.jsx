import {
  CaptureUpdateAction,
  Excalidraw,
  restore,
  serializeAsJSON
} from '@excalidraw/excalidraw'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'

import { CowartAgentPanel } from './AgentPanel.jsx'
import agentBaseStyles from './styles.css?inline'
import agentEditorialStyles from './editorialTheme.css?inline'
import agentAtelierStyles from './atelierTheme.css?inline'
import { persistCowartAiMode, readCowartAiMode } from './aiMode.js'
import {
  loadCowartCanvasState,
  refreshCowartCanvasState,
  saveCowartCanvasSnapshot,
  saveCowartSelectionState
} from './cowartClient.js'
import {
  emptyExcalidrawDocument,
  isExcalidrawDocument,
  normalizeExcalidrawDocument
} from './excalidrawDocument.js'
import { getCowartAgentBridge } from './widgetMessaging.js'

const SCENE_POLL_INTERVAL_MS = 1_100
const SCENE_SAVE_DELAY_MS = 450
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

function createAgentContext(api) {
  const appState = api?.getAppState?.() || {}
  const elements = api?.getSceneElements?.() || []
  const selectedIds = Object.entries(appState.selectedElementIds || {})
    .filter(([, selected]) => selected)
    .map(([id]) => id)
  const exactShapeIds = selectedIds.slice(0, MAX_CONTEXT_IDS)
  const identity = cowartProjectIdentity()
  return {
    ...identity,
    pageId: 'excalidraw:scene',
    pageName: api?.getName?.() || 'Yogurt AI',
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
  const apiRef = useRef(null)
  const revisionRef = useRef(null)
  const lastPersistedSignatureRef = useRef(null)
  const pendingSceneRef = useRef(null)
  const saveTimerRef = useRef(null)
  const saveChainRef = useRef(Promise.resolve())
  const suppressSceneSaveRef = useRef(false)
  const viewportBeforeAiRef = useRef(null)

  const initialData = useMemo(() => async () => {
    try {
      const state = await loadCowartCanvasState()
      revisionRef.current = state.revision ?? null
      const document = state.snapshot
        ? normalizeExcalidrawDocument(state.snapshot)
        : emptyExcalidrawDocument()
      lastPersistedSignatureRef.current = isExcalidrawDocument(state.snapshot)
        ? sceneSignature(document.elements, document.appState, document.files)
        : null
      return document
    } catch (error) {
      console.error('Unable to load the Yogurt AI Excalidraw document.', error)
      return emptyExcalidrawDocument()
    }
  }, [])

  const persistPendingScene = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingSceneRef.current
    if (!pending) return saveChainRef.current
    pendingSceneRef.current = null

    const operation = saveChainRef.current.catch(() => undefined).then(async () => {
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
          savedAt: new Date().toISOString()
        }
      }
      const result = await saveCowartCanvasSnapshot(document, {
        baseRevision: revisionRef.current || undefined
      })
      revisionRef.current = result?.revision ?? revisionRef.current
      lastPersistedSignatureRef.current = pending.signature
      return result
    })
    saveChainRef.current = operation.catch((error) => {
      console.error('Unable to save the Yogurt AI Excalidraw document.', error)
      if (error?.code === 'COWART_REVISION_CONFLICT') {
        lastPersistedSignatureRef.current = null
      }
      return null
    })
    return operation
  }, [])

  const handleSceneChange = useCallback((elements, appState, files) => {
    if (suppressSceneSaveRef.current) return
    const signature = sceneSignature(elements, appState, files)
    if (signature === lastPersistedSignatureRef.current) return
    pendingSceneRef.current = { elements, appState, files, signature }
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      persistPendingScene().catch(() => undefined)
    }, SCENE_SAVE_DELAY_MS)
  }, [persistPendingScene])

  const handleExcalidrawApi = useCallback((api) => {
    apiRef.current = api
    globalThis.window.__cowartExcalidrawAPI = api
    globalThis.window.__cowartEditor = api
  }, [])

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

  const getAgentContext = useCallback(() => createAgentContext(apiRef.current), [])

  const prepareAgentTask = useCallback(async () => {
    const api = apiRef.current
    if (!api) throw new Error('Excalidraw 画布尚未就绪，请稍后再发送。')
    await persistPendingScene()
    const context = createAgentContext(api)
    const elementsById = new Map(api.getSceneElements().map((element) => [element.id, element]))
    const selection = {
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
    await saveCowartSelectionState(selection)
    return context
  }, [persistPendingScene])

  useEffect(() => {
    function handleKeyDown(event) {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== 'a') {
        return
      }
      event.preventDefault()
      handleAiModeChange(!isAiModeEnabled)
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
      if (disposed || !apiRef.current || pendingSceneRef.current) return
      try {
        const state = await refreshCowartCanvasState()
        if (!isExcalidrawDocument(state?.snapshot)) return
        if (state.revision && state.revision === revisionRef.current) return
        const document = normalizeExcalidrawDocument(state.snapshot)
        const signature = sceneSignature(document.elements, document.appState, document.files)
        if (signature === lastPersistedSignatureRef.current) {
          revisionRef.current = state.revision ?? revisionRef.current
          return
        }
        suppressSceneSaveRef.current = true
        apiRef.current.addFiles(Object.values(document.files || {}))
        apiRef.current.updateScene({
          elements: document.elements,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
        revisionRef.current = state.revision ?? revisionRef.current
        lastPersistedSignatureRef.current = signature
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
  }, [])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    persistPendingScene().catch(() => undefined)
    delete globalThis.window.__cowartExcalidrawAPI
    delete globalThis.window.__cowartEditor
  }, [persistPendingScene])

  return (
    <main
      aria-label={isAiModeEnabled ? 'Yogurt AI Excalidraw workspace' : 'Excalidraw canvas'}
      className="native-excalidraw-app"
      data-ai-mode={isAiModeEnabled ? 'on' : 'off'}
    >
      <section className="native-excalidraw-canvas" aria-label="Excalidraw">
        <Excalidraw
          autoFocus
          excalidrawAPI={handleExcalidrawApi}
          handleKeyboardGlobally
          initialData={initialData}
          langCode="zh-CN"
          name="Yogurt AI"
          onChange={handleSceneChange}
        />
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
