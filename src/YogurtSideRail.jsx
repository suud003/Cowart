import {
  BellSimple,
  ImageSquare,
  SquaresFour,
  Tray
} from '@phosphor-icons/react'

function triggerCanvasAssetPicker() {
  const assetButton = document.querySelector('[data-testid="tools.asset"]')
  if (assetButton instanceof HTMLElement) assetButton.click()
}

export function YogurtSideRail({
  agentAttention,
  isAgentPanelOpen,
  onAgentPanelOpenChange
}) {
  const inboxLabel = agentAttention?.label || ''

  return (
    <aside className="yogurt-side-rail" aria-label="Yogurt AI 工作区导航">
      <div className="yogurt-side-brand" aria-label="Yogurt AI">
        <span aria-hidden="true">Y</span>
      </div>

      <nav className="yogurt-side-nav" aria-label="工作区">
        <button
          aria-current={isAgentPanelOpen ? 'page' : undefined}
          data-active={isAgentPanelOpen ? 'true' : 'false'}
          data-attention={agentAttention?.kind || 'none'}
          onClick={() => onAgentPanelOpenChange(true)}
          title="打开 Codex Agent"
          type="button"
        >
          <Tray aria-hidden="true" size={22} weight="regular" />
          <span>Codex</span>
          {inboxLabel && <b aria-hidden="true">{inboxLabel}</b>}
        </button>
        <button
          aria-current={!isAgentPanelOpen ? 'page' : undefined}
          data-active={!isAgentPanelOpen ? 'true' : 'false'}
          onClick={() => onAgentPanelOpenChange(false)}
          type="button"
        >
          <SquaresFour aria-hidden="true" size={22} weight="regular" />
          <span>画布</span>
        </button>
        <button onClick={triggerCanvasAssetPicker} title="向画布添加素材" type="button">
          <ImageSquare aria-hidden="true" size={22} weight="regular" />
          <span>素材</span>
        </button>
      </nav>

      <div className="yogurt-side-utilities">
        <button
          aria-label="查看 Agent 通知"
          data-attention={agentAttention?.kind || 'none'}
          onClick={() => onAgentPanelOpenChange(true)}
          title="通知"
          type="button"
        >
          <BellSimple aria-hidden="true" size={22} weight="regular" />
        </button>
      </div>
    </aside>
  )
}
