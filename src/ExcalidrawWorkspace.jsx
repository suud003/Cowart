import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Workflow } from 'lucide-react'
import { useEditor, useToasts } from 'tldraw'
import {
  getExcalidrawKeyboardAction,
  isEditableKeyboardTarget
} from './excalidrawInteraction.js'
import {
  PRODUCT_BRIDGE_FOLLOW_UP_UNAVAILABLE_CODE,
  PRODUCT_BRIDGE_SCOPE_TOO_LARGE_CODE
} from './productBridgePrompt.js'
import {
  SEMANTIC_DIAGRAM_FOLLOW_UP_UNAVAILABLE_CODE,
  SEMANTIC_DIAGRAM_SCOPE_TOO_LARGE_CODE
} from './semanticDiagramPrompt.js'

const PRODUCT_NAME = 'Yogurt AI'

function clickToolbarTool(toolId) {
  const candidates = document.querySelectorAll(
    `[data-testid="tools.${toolId}"], [data-value="${toolId}"]`
  )
  const button = Array.from(candidates).find(
    (candidate) => candidate instanceof HTMLButtonElement && !candidate.disabled
  )
  button?.click()
  return Boolean(button)
}

function ExcalidrawShortcutBridge() {
  const editor = useEditor()

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.defaultPrevented || event.repeat || isEditableKeyboardTarget(event.target)) return
      const action = getExcalidrawKeyboardAction(event)
      if (!action) return

      if (action === 'toggle-tool-lock') {
        editor.updateInstanceState({
          isToolLocked: !editor.getInstanceState().isToolLocked
        })
      } else if (!clickToolbarTool(action)) {
        editor.setCurrentTool(action)
      }

      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [editor])

  return null
}

function CowartAiMenu({ brandIcon, items }) {
  const menuRef = useRef(null)
  const { addToast } = useToasts()
  const [isOpen, setIsOpen] = useState(false)
  const [activeItemId, setActiveItemId] = useState(null)

  useEffect(() => {
    if (!isOpen) return undefined

    function handlePointerDown(event) {
      if (!menuRef.current?.contains(event.target)) setIsOpen(false)
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') setIsOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isOpen])

  async function handleSelect(item) {
    if (activeItemId) return
    setIsOpen(false)
    if (!item.successTitle) {
      item.onSelect()
      return
    }

    setActiveItemId(item.id)
    try {
      const result = await item.onSelect()
      addToast({
        title: item.successTitle,
        description: item.successDescription?.(result) || result?.filePath || result?.fileName,
        severity: 'success'
      })
    } catch (error) {
      if (
        error?.code === PRODUCT_BRIDGE_SCOPE_TOO_LARGE_CODE ||
        error?.code === SEMANTIC_DIAGRAM_SCOPE_TOO_LARGE_CODE
      ) {
        addToast({
          title: '范围过大，请缩小选区',
          description: error.message,
          severity: 'error'
        })
        return
      }
      if (
        error?.code === PRODUCT_BRIDGE_FOLLOW_UP_UNAVAILABLE_CODE ||
        error?.code === SEMANTIC_DIAGRAM_FOLLOW_UP_UNAVAILABLE_CODE
      ) {
        addToast({
          title: '当前是本地预览',
          description:
            error.message || '生成可编辑图需要在 Codex 原生 Yogurt AI 画布中使用。',
          severity: 'info'
        })
        return
      }
      console.error(error)
      addToast({
        title: item.errorTitle || '画布整合导出失败',
        description: error instanceof Error ? error.message : '请稍后重试。',
        severity: 'error'
      })
    } finally {
      setActiveItemId(null)
    }
  }

  return (
    <div className="cowart-excalidraw-ai-menu" ref={menuRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-busy={Boolean(activeItemId)}
        className="cowart-excalidraw-ai-trigger"
        disabled={Boolean(activeItemId)}
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <span className="cowart-excalidraw-ai-trigger-icon">
          {activeItemId ? <LoaderCircle aria-hidden="true" className="cowart-spin" /> : brandIcon}
        </span>
        <span>{activeItemId ? '正在整合画布' : PRODUCT_NAME}</span>
      </button>
      {isOpen && (
        <div aria-label={PRODUCT_NAME} className="cowart-excalidraw-ai-popover" role="menu">
          <div className="cowart-excalidraw-ai-popover-heading">
            <strong>{PRODUCT_NAME}</strong>
            <span>AI 生成 Excalidraw 风格原生可编辑图</span>
          </div>
          {items.map((item) => (
            <button
              className="cowart-excalidraw-ai-option"
              data-action={item.id}
              data-divider={item.divider || undefined}
              key={item.id}
              onClick={() => handleSelect(item)}
              role="menuitem"
              type="button"
            >
              <span className="cowart-excalidraw-ai-option-icon">{item.icon}</span>
              <span className="cowart-excalidraw-ai-option-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              {item.shortcut ? (
                <kbd>{item.shortcut}</kbd>
              ) : (
                <span className="cowart-excalidraw-ai-option-badge">{item.badge}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ExcalidrawCowartChrome({
  aiModeEnabled = false,
  onCreateSemanticDiagram
}) {
  const editor = useEditor()

  const items = [
    {
      id: 'editable-diagram',
      label: '生成可编辑图',
      description: '原生节点、文字和绑定箭头均可继续编辑',
      icon: <Workflow aria-hidden="true" />,
      badge: 'EDIT',
      onSelect: () => onCreateSemanticDiagram(editor),
      successTitle: '已发送给可编辑图 Agent',
      successDescription: (result) =>
        result?.scope === 'selection'
          ? `已携带当前选区的 ${result.selectedCount} 个对象。`
          : '当前没有选中对象，已使用当前整页作为语义来源。',
      errorTitle: '可编辑图生成任务发送失败'
    }
  ]

  return (
    <>
      <ExcalidrawShortcutBridge />
      {aiModeEnabled && (
        <CowartAiMenu brandIcon={<Workflow aria-hidden="true" />} items={items} />
      )}
    </>
  )
}
