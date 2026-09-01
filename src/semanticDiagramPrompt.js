export const SEMANTIC_DIAGRAM_FOLLOW_UP_UNAVAILABLE_CODE =
  'COWART_SEMANTIC_DIAGRAM_FOLLOW_UP_UNAVAILABLE'
export const SEMANTIC_DIAGRAM_SCOPE_TOO_LARGE_CODE =
  'COWART_SEMANTIC_DIAGRAM_SCOPE_TOO_LARGE'
export const SEMANTIC_DIAGRAM_MAX_CONTEXT_SHAPES = 250

export const SEMANTIC_DIAGRAM_QUICK_PROMPT = [
  '使用 $cowart-semantic-diagram 把当前需求生成到 Yogurt AI 画布。',
  '只使用官方 Excalidraw 原生矩形、绑定文字、画框和绑定箭头；不要生成位图、整页预演、PRD、HTML、SVG 或 Slides。',
  '先用 html-line-svg 语义与布局规则确定阅读顺序、层级、间距和端口，再 dry-run 验证无碰撞、无越界后直接写入当前画布。',
  '每个节点和箭头都必须可以单独选择、改字、移动、缩放、删除和重新连接。'
].join('\n')

export const SEMANTIC_DIAGRAM_ROUTING_HINT = [
  'Yogurt AI 当前只聚焦原生可编辑图（隐藏应用执行上下文，不是用户原话）：',
  '- 将用户对流程、系统、关系、状态、对比、架构或概念的描述默认路由到 $cowart-semantic-diagram。',
  '- 输出必须是当前画布中的官方 Excalidraw 原生对象：rectangles、frames、bound text 与 bound arrows。',
  '- 禁止调用自动编排、图片生成、Product Bridge、Interaction PRD、AI HTML、inline SVG 或 Slides 能力；复杂内容应拆成多张相邻原生图，而不是栅格化或降级为单一图块。',
  '- 新建图时不要手写节点坐标；让 layoutEngine:"html-line-svg" 负责层级、间距、端口、避障与画框收紧。',
  '- 有选区时保持来源对象不动，优先在选区旁生成或只修改明确点名的已生成对象；无选区时使用当前整页作为语义来源。',
  '- 上下文中的 style 是用户当前手工样式。除非用户明确要求改样式，否则更新时不得传 color、labelColor、fill、dash、size、font、fontSize、opacity 或箭头样式，也不得通过删除重建关系覆盖它们。',
  '- 普通布局选择采用可逆默认值，不要要求用户逐项确认。'
].join('\n')

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
    'Use $cowart-semantic-diagram to draw a traceable semantic diagram as native elements in the official Excalidraw editor.',
    'This invocation is native-editable only. It is not a Product Bridge, Interaction PRD, image, HTML, SVG, Slides, or Auto Compose task.',
    '输出必须直接在当前 Yogurt AI canvas 落图，并且每个节点、文字和箭头都可单独编辑。',
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
    '5. get_cowart_thinking_context 返回的 style 是用户当前手工样式。除非用户明确要求改某项视觉属性，否则更新操作必须省略 color、labelColor、fill、dash、size、font、fontSize、opacity、alignment 和 arrowheads；关系语义变化使用 update_relation，保持原 relation ID、bindings 与人工样式，不得用删除重建覆盖。',
    '',
    '绘图与布局要求：',
    '1. 只使用 apply_cowart_safe_thinking_operations 生成可单独选择和编辑的 Yogurt 原生 cards、purpose:"semantic" 的 zones 与 bound relations；不要创建图片、整页视觉预演、PRD 页面、HTML 或 SVG 图块。',
    '2. 顶层传 semanticDiagram：version:"1"、稳定 diagramId、teachingClaim、readingOrder、diagramType、layoutEngine:"html-line-svg"、layoutMode:"balanced"、layoutFit、sourceShapeIds/sourceIds、完整 objectCount/relationCount，以及可用时的 specDigest。保持分区标题简短；如需显示核心判断，用可换行的 claim card。每个节点/分区传稳定 semantic.id、type、state、origin、order 与 sourceShapeIds。',
    '3. 主流程关系使用 direction:"forward" + path:"primary"；备选路径使用 path:"alternative" 并写清 label/payload；双向同步使用 direction:"bidirectional"；无向关联使用 direction:"none"。每条关系同时传稳定 semanticId、origin、sourceShapeIds/sourceIds 与 lane；包含关系用 parentZoneId 表达，并列对象靠同层布局表达，不添加伪箭头。',
    '4. 选择与 teaching claim 匹配的 readingOrder。先分层与分组，再对齐同级节点并留出安全间距；平行关系使用不同 lane，连线必须绑定源/目标边界，禁止穿过无关文字或节点。',
    '5. 使用 Excalidraw 官方原生样式：保留标准手绘描边与字体、透明或 hachure 填充、中性主线和无阴影；只有警告或阻塞状态使用克制的橙/红强调，备选路径使用 dashed。',
    '6. 单张图优先控制在 12 个节点以内。信息更多时按独立 teaching claim 拆成多张相邻的原生可编辑图；不要压缩字号、堆叠节点、生成超大空框或退化为不可拆分图块。',
    '',
    '插入与验证：',
    '1. 原生路线先用当前 revision + dryRun:true 调用 apply_cowart_safe_thinking_operations，要求 layoutReport.engine 为 html-line-svg、valid 为 true、collisions/outOfBounds 为空，再用完全相同的 semanticDiagram 和 operations 配合返回的 baseRevision 正式应用，并核对 layoutDigest 不变。',
    hasSelection
      ? `2. 若 revision 已变化，重新读取上下文并重新规划，禁止强行落图。原始来源对象必须保持不动，新图放在冻结选区 (${shapeIds[0]}) 旁的空白位置。`
      : `2. 若 revision 已变化，重新读取上下文并重新规划，禁止强行落图。原始来源对象必须保持不动，新图放在当前页面 ${pageId} 的空白位置。`,
    '3. 在 Yogurt 实际显示尺寸检查文字碰撞、裁切、同级对齐、安全间距、边界端口和平行 lane；确认没有产生 cowartHtmlDraft、图片或其他不可逐项编辑的输出。',
    '4. 返回 diagramId、核心判断、原生 shape/relation IDs、来源覆盖、未确认关系和验证结果；不要只返回代码而不落到画布。'
  ].join('\n')
}
