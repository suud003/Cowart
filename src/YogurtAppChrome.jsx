import {
  ArrowClockwise,
  ArrowCounterClockwise,
  Robot,
  SidebarSimple
} from '@phosphor-icons/react'
import { useEffect, useState } from 'react'

function readCanvasTelemetry() {
  const editor = globalThis.window?.__cowartEditor
  if (!editor) {
    return {
      pageName: 'LOADING CANVAS',
      pageShapeCount: 0,
      selectedCount: 0,
      zoom: 100
    }
  }

  const page = editor.getCurrentPage?.()
  const zoomLevel = Number(editor.getZoomLevel?.())
  return {
    pageName: String(page?.name || 'UNTITLED PAGE').trim(),
    pageShapeCount: editor.getCurrentPageShapeIds?.().size || 0,
    selectedCount: editor.getSelectedShapeIds?.().length || 0,
    zoom: Number.isFinite(zoomLevel) ? Math.round(zoomLevel * 100) : 100
  }
}

function telemetryKey(value) {
  return `${value.pageName}:${value.pageShapeCount}:${value.selectedCount}:${value.zoom}`
}

export function YogurtAppChrome({
  agentAttention,
  isAgentPanelOpen,
  onAiModeChange,
  onAgentPanelOpenChange,
  projectName
}) {
  const [telemetry, setTelemetry] = useState(readCanvasTelemetry)

  useEffect(() => {
    let previousKey = telemetryKey(telemetry)
    function refreshTelemetry() {
      const nextTelemetry = readCanvasTelemetry()
      const nextKey = telemetryKey(nextTelemetry)
      if (nextKey === previousKey) return
      previousKey = nextKey
      setTelemetry(nextTelemetry)
    }

    refreshTelemetry()
    const timer = window.setInterval(refreshTelemetry, 360)
    return () => window.clearInterval(timer)
  }, [])

  const attentionLabel = agentAttention?.label || ''
  const toggleLabel = isAgentPanelOpen ? '收起 Codex Agent 面板' : '打开 Codex Agent 面板'
  const attentionAnnouncement = agentAttention?.kind === 'blocking'
    ? '有任务待处理'
    : agentAttention?.kind === 'reply'
      ? '有 Agent 新回复'
      : agentAttention?.kind === 'failure'
        ? 'Agent 任务失败'
        : ''
  const accessibleToggleLabel = attentionAnnouncement
    ? `${toggleLabel}；${attentionAnnouncement}`
    : toggleLabel
  const displayPageName = telemetry.pageName === 'Page 1' && telemetry.pageShapeCount === 0
    ? '世界与玩法'
    : telemetry.pageName

  function runEditorCommand(command) {
    globalThis.window?.__cowartEditor?.[command]?.()
  }

  return (
    <header className="yogurt-app-chrome" aria-label="Yogurt AI 应用栏">
      <nav className="yogurt-app-breadcrumb" aria-label="当前画布位置">
        <span>Yogurt</span>
        <i aria-hidden="true">/</i>
        <span>{projectName || '互动影游'}</span>
        <i aria-hidden="true">/</i>
        <strong title={displayPageName}>{displayPageName}</strong>
      </nav>

      <div className="yogurt-app-actions" aria-label="画布操作">
        <button aria-label="撤销" onClick={() => runEditorCommand('undo')} title="撤销" type="button">
          <ArrowCounterClockwise aria-hidden="true" size={18} />
        </button>
        <button aria-label="重做" onClick={() => runEditorCommand('redo')} title="重做" type="button">
          <ArrowClockwise aria-hidden="true" size={18} />
        </button>
        <button
          aria-label="关闭 AI 模式，返回纯画布"
          aria-pressed="true"
          className="yogurt-app-ai-mode-toggle"
          onClick={() => onAiModeChange(false)}
          title="关闭 AI 模式"
          type="button"
        >
          <Robot aria-hidden="true" size={16} weight="bold" />
          <span>AI 模式</span>
          <b aria-hidden="true">开启</b>
        </button>
        <button
          aria-controls="yogurt-codex-agent-panel"
          aria-expanded={isAgentPanelOpen}
          aria-label={accessibleToggleLabel}
          aria-pressed={isAgentPanelOpen}
          className="yogurt-app-agent-toggle"
          data-active={isAgentPanelOpen ? 'true' : 'false'}
          data-attention={agentAttention?.kind || 'none'}
          onClick={() => onAgentPanelOpenChange(!isAgentPanelOpen)}
          title={accessibleToggleLabel}
          type="button"
        >
          {isAgentPanelOpen ? (
            <SidebarSimple aria-hidden="true" size={16} weight="bold" />
          ) : (
            <Robot aria-hidden="true" size={16} weight="bold" />
          )}
          <span>Codex</span>
          {attentionLabel && <b aria-hidden="true">{attentionLabel}</b>}
        </button>
      </div>
    </header>
  )
}
