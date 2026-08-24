export const SEMANTIC_DIAGRAM_FOLLOW_UP_UNAVAILABLE_CODE =
  'COWART_SEMANTIC_DIAGRAM_FOLLOW_UP_UNAVAILABLE'
export const SEMANTIC_DIAGRAM_SCOPE_TOO_LARGE_CODE =
  'COWART_SEMANTIC_DIAGRAM_SCOPE_TOO_LARGE'
export const SEMANTIC_DIAGRAM_MAX_CONTEXT_SHAPES = 250

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

export function getSemanticDiagramScopeSize({
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
    maxShapes: SEMANTIC_DIAGRAM_MAX_CONTEXT_SHAPES,
    isTooLarge: shapeCount > SEMANTIC_DIAGRAM_MAX_CONTEXT_SHAPES
  }
}

export function buildSemanticDiagramPrompt({
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
    'Use $cowart-semantic-diagram to turn the frozen Yogurt AI context into a traceable semantic line diagram.',
    '',
    '当前 Yogurt AI 范围：',
    `- 当前页面：${pageName} (${pageId})`,
    hasSelection
      ? `- 处理范围：当前选区，共 ${shapeIds.length} 个对象。`
      : '- 处理范围：当前整页。当前没有选中对象，请从整页提炼一个核心关系图。',
    ...(hasSelection ? [`- 冻结 shape IDs：${shapeIds.join(', ')}`] : []),
    `- 首次上下文调用：${contextToolCall}`,
    '',
    '语义与来源规则：',
    `1. 首先按上述参数调用 ${contextToolCall}。冻结 shapeIds 是用户点击菜单瞬间的权威范围，不得用之后变化的共享选区替换。`,
    '2. 合并本次对话中的文字、产品想法和画布内容；TAPD URL 只有在确实读取正文后才能转成需求关系，未读取时只保留为待解析来源。',
    '3. 先写唯一 teaching claim，再列出 objects、relations、states、visible labels、layout constraints 和 reading order。没有来源依据的关系不要画成箭头。',
    '4. 原始画布对象必须保持不动。新图保留 source shape IDs，并区分用户原话、事实、推断、假设与待确认问题。',
    '',
    '绘图与布局要求：',
    '1. 开放式思考树且关系简单时可使用 Yogurt 原生 cards/relations；流程、架构、GUI/LUI、状态、对比或关系密集图必须生成单文件 HTML 内联 SVG。',
    '2. 主流程用实线单向关系，备选路径用虚线，双向同步用双向箭头，无方向关联不用箭头，包含关系用嵌套框；并列对象不要添加伪关系。',
    '3. 先分配分组边界和连线通道，再放节点。连线必须从源对象边界连续落到目标边界；平行关系分 lane，禁止穿过无关文字/节点或长距离共线粘连。',
    '4. SVG 必须响应式、可访问、可编辑：viewBox、role=img、唯一 title/desc/marker ID、aria-labelledby、SVG text、non-scaling-stroke；禁止 script、foreignObject、远程资源、事件属性、渐变和阴影。',
    '5. 在 HTML 中用 <template data-cowart-diagram-spec> 保存最终 JSON 语义规格，并用 <template data-cowart-diagram-prompt> 保存与成品一致的可复用生成提示词。',
    '',
    '插入与验证：',
    '1. 运行插件 Skill 自带的 validate-semantic-svg.mjs，并在 Yogurt 实际显示尺寸检查文字碰撞、裁切、同级对齐、安全间距和每条连线的可追踪性。',
    hasSelection
      ? `2. 先用 dryRun:true 调用 insert_cowart_html_draft，把第一个冻结 shape ID (${shapeIds[0]}) 作为 anchorShapeId，设置 updateExistingDraft:false、replaceDraftHolder:false、matchAnchor:false、placement:"right"，在原选区旁规划新图。`
      : `2. 先用 dryRun:true 调用 insert_cowart_html_draft，在页面 ${pageId} 的空白区域规划新图，设置 updateExistingDraft:false、replaceDraftHolder:false、matchAnchor:false。`,
    '3. 同时传 semanticDiagram 元数据：version、teachingClaim、readingOrder、diagramType、sourceShapeIds、objectCount、relationCount，以及可用时的 workspaceId/zoneId/specDigest。',
    '4. 检查 dry-run 结果后，用完全相同的内容、放置参数、semanticDiagram 和返回的 baseRevision 再调用一次，设置 dryRun:false；若 revision 已变化，重新读取上下文并重新生成，禁止强行落图。',
    '5. 返回 SVG/HTML 形状 ID、核心判断、来源覆盖、未确认关系和验证结果；不要只返回代码而不插入画布。'
  ].join('\n')
}
