import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSemanticDiagramPrompt,
  getSemanticDiagramScopeSize,
  SEMANTIC_DIAGRAM_MAX_CONTEXT_SHAPES
} from '../src/semanticDiagramPrompt.js'

function shapeIds(count) {
  return Array.from({ length: count }, (_, index) => `shape:${index + 1}`)
}

test('semantic diagram prompt freezes the selected Yogurt scope and requests a native canvas diagram', () => {
  const prompt = buildSemanticDiagramPrompt({
    selectedShapeIds: ['shape:idea', 'shape:requirement', 'shape:idea', ''],
    currentPageId: 'page:product',
    currentPageName: 'UGC AI 助手'
  })

  assert.match(prompt, /Use \$cowart-semantic-diagram/)
  assert.match(prompt, /当前选区，共 2 个对象/)
  assert.match(prompt, /冻结 shape IDs：shape:idea, shape:requirement/)
  assert.match(
    prompt,
    /get_cowart_thinking_context\(scope: "selection", shapeIds: \["shape:idea","shape:requirement"\]\)/
  )
  assert.match(prompt, /唯一 teaching claim/)
  assert.match(prompt, /直接在当前 Yogurt AI canvas/)
  assert.match(prompt, /not a Product Bridge or Interaction PRD task/)
  assert.match(prompt, /apply_cowart_safe_thinking_operations/)
  assert.match(prompt, /layoutEngine:"html-line-svg"/)
  assert.match(prompt, /layoutReport\.engine/)
  assert.match(prompt, /layoutDigest/)
  assert.match(prompt, /purpose:"semantic"/)
  assert.match(prompt, /semanticDiagram/)
  assert.match(prompt, /direction:"bidirectional"/)
  assert.match(prompt, /连线必须绑定源\/目标边界/)
  assert.match(prompt, /data-cowart-diagram-spec/)
  assert.match(prompt, /禁止对可见分组\/节点\/路径\/文字使用 transform/)
  assert.match(prompt, /贝塞尔曲线真实极值/)
  assert.match(prompt, /较短边 2% 的安全区/)
  assert.match(prompt, /不能加入 interaction-prd.json/)
  assert.match(prompt, /dryRun:true/)
  assert.match(prompt, /返回的 baseRevision/)
  assert.match(prompt, /revision 已变化/)
  assert.match(prompt, /不要只返回代码而不落到画布/)
  assert.doesNotMatch(prompt, /TAPD/i)
})

test('semantic diagram prompt uses the whole page when selection is empty', () => {
  const prompt = buildSemanticDiagramPrompt({
    currentPageId: 'page:whole',
    currentPageName: '产品探索'
  })

  assert.match(prompt, /处理范围：当前整页/)
  assert.match(prompt, /get_cowart_thinking_context\(scope: "page", pageId: "page:whole"\)/)
  assert.doesNotMatch(prompt, /冻结 shape IDs/)
  assert.match(prompt, /未读取时只保留为待补充来源/)
  assert.match(prompt, /当前页面.*空白位置/)
})

test('semantic diagram scope allows 250 shapes and rejects 251 without truncation', () => {
  assert.equal(SEMANTIC_DIAGRAM_MAX_CONTEXT_SHAPES, 250)
  assert.equal(getSemanticDiagramScopeSize({ selectedShapeIds: shapeIds(250) }).isTooLarge, false)
  assert.equal(getSemanticDiagramScopeSize({ selectedShapeIds: shapeIds(251) }).isTooLarge, true)
  assert.equal(
    getSemanticDiagramScopeSize({ currentPageShapeCount: 251 }).isTooLarge,
    true
  )
})
