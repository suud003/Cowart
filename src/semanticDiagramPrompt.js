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
    'Use $cowart-semantic-diagram to draw a traceable semantic line diagram directly on the current Yogurt AI canvas.',
    'This is a canvas operation, not a Product Bridge or Interaction PRD task. Do not create, update, or embed a PRD workspace.',
    '输出必须直接在当前 Yogurt AI canvas 落图。',
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
    '2. 合并本次对话中的文字、产品想法和画布内容；外部链接只有在当前上下文确实包含正文后才能转成需求关系，未读取时只保留为待补充来源。',
    '3. 先写唯一 teaching claim，再列出 objects、relations、states、visible labels、layout constraints 和 reading order。没有来源依据的关系不要画成箭头。',
    '4. 原始画布对象必须保持不动。新图保留 source shape IDs，并区分用户原话、事实、推断、假设与待确认问题。',
    '',
    '绘图与布局要求：',
    '1. 默认使用 apply_cowart_safe_thinking_operations 生成可单独选择和编辑的 Yogurt 原生 cards、purpose:"semantic" 的 zones 与 bound relations；不要因为它是流程、架构、状态或对比图就自动改成 PRD 页面或 HTML。',
    '2. 顶层传 semanticDiagram：version:"1"、稳定 diagramId、teachingClaim、readingOrder、diagramType、layoutEngine:"html-line-svg"、layoutMode:"balanced"、layoutFit、sourceShapeIds/sourceIds、完整 objectCount/relationCount，以及可用时的 specDigest。保持分区标题简短；如需显示核心判断，用可换行的 claim card。每个节点/分区传稳定 semantic.id、type、state、origin、order 与 sourceShapeIds。',
    '3. 主流程关系使用 direction:"forward" + path:"primary"；备选路径使用 path:"alternative" 并写清 label/payload；双向同步使用 direction:"bidirectional"；无向关联使用 direction:"none"。每条关系同时传稳定 semanticId、origin、sourceShapeIds/sourceIds 与 lane；包含关系用 parentZoneId 表达，并列对象靠同层布局表达，不添加伪箭头。',
    '4. 选择与 teaching claim 匹配的 readingOrder。先分层与分组，再对齐同级节点并留出安全间距；平行关系使用不同 lane，连线必须绑定源/目标边界，禁止穿过无关文字或节点。',
    '5. 只有用户明确要求 SVG，或原生对象无法无歧义表达精确端口、泳道、GUI/LUI 或密集避障几何时，才生成单文件 HTML 内联 SVG；它仍必须作为一个独立图块插入当前 Yogurt 画布，不能加入 interaction-prd.json。',
    '6. SVG 路线必须响应式、可访问且无脚本：viewBox、role=img、唯一 title/desc/marker ID、aria-labelledby、SVG text、non-scaling-stroke；所有可见坐标直接写入 SVG，禁止对可见分组/节点/路径/文字使用 transform；viewBox 必须覆盖节点、文字、描边、marker 与直线/贝塞尔曲线真实极值，并在四周保留不少于 viewBox 较短边 2% 的安全区。禁止 script、foreignObject、远程资源、事件属性、渐变和阴影，并保存 data-cowart-diagram-spec / data-cowart-diagram-prompt。',
    '',
    '插入与验证：',
    '1. 原生路线先用当前 revision + dryRun:true 调用 apply_cowart_safe_thinking_operations，要求 layoutReport.engine 为 html-line-svg、valid 为 true、collisions/outOfBounds 为空，再用完全相同的 semanticDiagram 和 operations 配合返回的 baseRevision 正式应用，并核对 layoutDigest 不变。',
    hasSelection
      ? `2. 若 revision 已变化，重新读取上下文并重新规划，禁止强行落图。原始来源对象必须保持不动，新图放在冻结选区 (${shapeIds[0]}) 旁的空白位置。`
      : `2. 若 revision 已变化，重新读取上下文并重新规划，禁止强行落图。原始来源对象必须保持不动，新图放在当前页面 ${pageId} 的空白位置。`,
    '3. 在 Yogurt 实际显示尺寸检查文字碰撞、裁切、同级对齐、安全间距、边界端口和平行 lane；确认 simple/native 路线没有产生 cowartHtmlDraft。',
    '4. 仅当选择 SVG 路线时运行 validate-semantic-svg.mjs，再使用 insert_cowart_html_draft 的 dry-run/baseRevision 流程把图块放到当前画布。',
    '5. 返回所选表示、diagramId、核心判断、原生 shape/relation IDs 或 SVG 图块 ID、来源覆盖、未确认关系和验证结果；不要只返回代码而不落到画布。'
  ].join('\n')
}
