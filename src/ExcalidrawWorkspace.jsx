import { useEffect, useRef, useState } from 'react'
import { useEditor } from 'tldraw'
import {
  getExcalidrawKeyboardAction,
  isEditableKeyboardTarget
} from './excalidrawInteraction.js'

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

function ExcalidrawShortcutBridge({ onCreateHtml, onCreateImage, onCreateSlides }) {
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
      } else if (action === 'cowart-ai-image') {
        onCreateImage(editor)
      } else if (action === 'cowart-ai-html') {
        onCreateHtml(editor)
      } else if (action === 'cowart-ai-slides') {
        onCreateSlides(editor)
      } else if (!clickToolbarTool(action)) {
        editor.setCurrentTool(action)
      }

      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [editor, onCreateHtml, onCreateImage, onCreateSlides])

  return null
}

function CowartAiMenu({ brandIcon, items }) {
  const menuRef = useRef(null)
  const [isOpen, setIsOpen] = useState(false)

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

  return (
    <div className="cowart-excalidraw-ai-menu" ref={menuRef}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="menu"
        className="cowart-excalidraw-ai-trigger"
        onClick={() => setIsOpen((open) => !open)}
        type="button"
      >
        <span className="cowart-excalidraw-ai-trigger-icon">{brandIcon}</span>
        <span>Cowart AI</span>
      </button>
      {isOpen && (
        <div aria-label="Cowart AI" className="cowart-excalidraw-ai-popover" role="menu">
          <div className="cowart-excalidraw-ai-popover-heading">
            <strong>Cowart AI</strong>
            <span>在画布中创建可编辑内容</span>
          </div>
          {items.map((item) => (
            <button
              className="cowart-excalidraw-ai-option"
              key={item.id}
              onClick={() => {
                item.onSelect()
                setIsOpen(false)
              }}
              role="menuitem"
              type="button"
            >
              <span className="cowart-excalidraw-ai-option-icon">{item.icon}</span>
              <span className="cowart-excalidraw-ai-option-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
              <kbd>{item.shortcut}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ExcalidrawCowartChrome({
  htmlIcon,
  imageIcon,
  onCreateHtml,
  onCreateImage,
  onCreateSlides,
  slidesIcon
}) {
  const editor = useEditor()

  const items = [
    {
      id: 'image',
      label: 'AI 图片',
      description: '创建图片生成区域',
      icon: imageIcon,
      shortcut: '⇧ I',
      onSelect: () => onCreateImage(editor)
    },
    {
      id: 'html',
      label: 'AI HTML',
      description: '创建可编辑网页草稿',
      icon: htmlIcon,
      shortcut: '⇧ H',
      onSelect: () => onCreateHtml(editor)
    },
    {
      id: 'slides',
      label: 'AI Slides',
      description: '创建演示文稿画框',
      icon: slidesIcon,
      shortcut: '⇧ S',
      onSelect: () => onCreateSlides(editor)
    }
  ]

  return (
    <>
      <ExcalidrawShortcutBridge
        onCreateHtml={onCreateHtml}
        onCreateImage={onCreateImage}
        onCreateSlides={onCreateSlides}
      />
      <CowartAiMenu brandIcon={imageIcon} items={items} />
    </>
  )
}
