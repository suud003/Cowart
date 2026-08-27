export const PRODUCT_BRIDGE_FOLLOW_UP_UNAVAILABLE_CODE =
  'COWART_PRODUCT_BRIDGE_FOLLOW_UP_UNAVAILABLE'
export const PRODUCT_BRIDGE_SCOPE_TOO_LARGE_CODE = 'COWART_PRODUCT_BRIDGE_SCOPE_TOO_LARGE'
export const PRODUCT_BRIDGE_MAX_CONTEXT_SHAPES = 250

function normalizedText(value, fallback) {
  const text = String(value ?? '').trim()
  return text || fallback
}

function normalizedShapeIds(selectedShapeIds) {
  return Array.from(
    new Set(
      (Array.isArray(selectedShapeIds) ? selectedShapeIds : [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
    )
  )
}

export function getProductBridgeScopeSize({
  selectedShapeIds = [],
  currentPageShapeCount = 0
} = {}) {
  const selectionShapeCount = normalizedShapeIds(selectedShapeIds).length
  const numericPageShapeCount = Number(currentPageShapeCount)
  const pageShapeCount = Number.isFinite(numericPageShapeCount)
    ? Math.max(0, Math.floor(numericPageShapeCount))
    : 0
  const scope = selectionShapeCount > 0 ? 'selection' : 'page'
  const shapeCount = scope === 'selection' ? selectionShapeCount : pageShapeCount

  return {
    scope,
    shapeCount,
    maxShapes: PRODUCT_BRIDGE_MAX_CONTEXT_SHAPES,
    isTooLarge: shapeCount > PRODUCT_BRIDGE_MAX_CONTEXT_SHAPES
  }
}

export function buildProductBridgePrompt({
  selectedShapeIds = [],
  currentPageId,
  currentPageName
} = {}) {
  const shapeIds = normalizedShapeIds(selectedShapeIds)
  const hasSelection = shapeIds.length > 0
  const pageId = normalizedText(currentPageId, 'unknown-page')
  const pageName = normalizedText(currentPageName, '未命名页面')
  const contextToolCall = hasSelection
    ? `get_cowart_thinking_context(scope: "selection", shapeIds: ${JSON.stringify(shapeIds)})`
    : `get_cowart_thinking_context(scope: "page", pageId: ${JSON.stringify(pageId)})`

  return [
    'Use $cowart-product-bridge to turn the current Yogurt AI product context into a reviewable Interaction PRD workspace.',
    '',
    '当前 Yogurt AI 范围：',
    `- 当前页面：${pageName} (${pageId})`,
    hasSelection
      ? `- 处理范围：当前选区，共 ${shapeIds.length} 个对象。`
      : '- 处理范围：当前整页。当前没有选中对象，请将该页面的全部产品内容作为输入。',
    ...(hasSelection ? [`- 精确目标 shape IDs：${shapeIds.join(', ')}`] : []),
    `- 冻结上下文调用：${contextToolCall}`,
    '',
    '来源整理规则：',
    '1. 合并本次对话里的文字叙述、零散产品想法、用户直接提供的需求摘录、项目文档，以及已保存的 Yogurt AI 画布上下文；不要要求用户先整理成完整文档。',
    `2. 首先按上述参数调用 ${contextToolCall}，并保留所有来源到画布对象的可追溯关系。`,
    ...(hasSelection
      ? [
          '   这些 shapeIds 是用户点击菜单瞬间冻结的权威范围；不要重新读取或依赖之后可能被轮询覆盖的共享选区。'
        ]
      : []),
    '3. 外部链接本身只算来源地址；只有当前上下文确实包含其正文时才算已读取。否则标记为“待补充”，保留 URL，并请用户粘贴正文或提供导出文件，绝不能猜测链接内容。',
    '4. 对事实、用户原话、产品假设、推断、待确认问题和约束分别标注，不要把推断写成已确认需求。',
    '',
    '生成要求：',
    '1. 先形成 source packet、产品目标、用户与场景、范围/非范围、关键假设、待确认项和决策记录。',
    '2. 基于来源生成画布分区、EARS 风格需求、模块 PRD，以及可直接评审的自包含交互 HTML 原型。',
    '3. 原型标注必须绑定稳定的 data-annotation-anchor 语义锚点；不得把截图像素坐标当作唯一定位依据。',
    '4. 维护 trace map：sourceId -> yogurtShapeId -> zoneId -> requirementId -> pageId#annotationId -> lastSyncedRevision。',
    '5. 交付工作区/评审链接、生成内容摘要、来源覆盖情况、待补充的外部材料与仍需确认的问题。',
    '6. Product Bridge 不生成语义框线图，也不把 SVG 加入 interaction-prd.json。画布框线图是另一项独立的 Yogurt 画布操作。',
    '',
    '回流 Yogurt AI 的要求：',
    '1. 如果对话中已经有 Interaction PRD 工作区、画布或评审链接，优先读取其 manifest 和分区映射，进入更新/回流流程，避免重新生成重复内容。',
    '2. 将 PRD 摘要、画布分区、关键流程、原型入口和来源映射组织成可回写 Yogurt AI 的 typed operations；新建 Product Bridge 分区必须用 create_zone + purpose:"product"，已有分区用 update_zone，并给分区内卡片传 parentZoneId。',
    '3. 必须先基于最新 revision 做 dry-run 并向用户展示变更预览；只有获得用户明确确认后才能正式回写。',
    `4. 回写只能作用于${hasSelection ? '当前选区对应的产品区域' : '当前页面的产品区域'}，不得覆盖无关内容；返回 operation ID、applied revision 和撤销方式。`,
    '5. 若当前只能完成生成而不能安全回写，明确说明阻塞原因并保留可继续同步的工作区与 trace map。'
  ].join('\n')
}
