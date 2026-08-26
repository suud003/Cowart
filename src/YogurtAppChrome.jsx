import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CaretDown,
  DotsThree,
  Robot,
  ShareNetwork,
  SidebarSimple,
  UserPlus
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
  onAgentPanelOpenChange,
  projectName
}) {
  const [telemetry, setTelemetry] = useState(readCanvasTelemetry)
  const [shareStatus, setShareStatus] = useState('idle')

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

  async function handleShare() {
    const pageName = displayPageName || 'Yogurt AI 画布'
    try {
      if (navigator.share) {
        await navigator.share({ title: pageName, text: `Yogurt AI · ${pageName}` })
      } else {
        await navigator.clipboard.writeText(globalThis.location?.href || pageName)
      }
      setShareStatus('shared')
      window.setTimeout(() => setShareStatus('idle'), 1800)
    } catch (error) {
      if (error?.name !== 'AbortError') setShareStatus('error')
    }
  }

  return (
    <header className="yogurt-app-chrome" aria-label="Yogurt AI 应用栏">
      <nav className="yogurt-app-breadcrumb" aria-label="当前画布位置">
        <span>Yogurt</span>
        <i aria-hidden="true">/</i>
        <span>{projectName || '互动影游'}</span>
        <i aria-hidden="true">/</i>
        <strong title={displayPageName}>{displayPageName}</strong>
        <CaretDown aria-hidden="true" size={12} weight="bold" />
      </nav>

      <div className="yogurt-app-actions" aria-label="画布操作">
        <button aria-label="撤销" onClick={() => runEditorCommand('undo')} title="撤销" type="button">
          <ArrowCounterClockwise aria-hidden="true" size={18} />
        </button>
        <button aria-label="重做" onClick={() => runEditorCommand('redo')} title="重做" type="button">
          <ArrowClockwise aria-hidden="true" size={18} />
        </button>
        <span className="yogurt-app-action-divider" aria-hidden="true" />
        <button aria-label="邀请协作者" disabled title="协作能力即将接入" type="button">
          <UserPlus aria-hidden="true" size={18} />
        </button>
        <span className="yogurt-app-collaborators" aria-label="当前协作者">
          <i>林</i><i>顾</i><i>乔</i><small>+2</small>
        </span>
        <button
          className="yogurt-app-share"
          data-status={shareStatus}
          onClick={handleShare}
          type="button"
        >
          <ShareNetwork aria-hidden="true" size={16} />
          <span>{shareStatus === 'shared' ? '已复制' : shareStatus === 'error' ? '重试' : '分享'}</span>
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
        <button aria-label="更多操作" title="更多" type="button">
          <DotsThree aria-hidden="true" size={20} weight="bold" />
        </button>
      </div>
    </header>
  )
}
