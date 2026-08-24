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

test('semantic diagram prompt freezes the selected Yogurt scope and requests traceable SVG', () => {
  const prompt = buildSemanticDiagramPrompt({
    selectedShapeIds: ['shape:idea', 'shape:tapd', 'shape:idea', ''],
    currentPageId: 'page:product',
    currentPageName: 'UGC AI 助手'
  })

  assert.match(prompt, /Use \$cowart-semantic-diagram/)
  assert.match(prompt, /当前选区，共 2 个对象/)
  assert.match(prompt, /冻结 shape IDs：shape:idea, shape:tapd/)
  assert.match(
    prompt,
    /get_cowart_thinking_context\(scope: "selection", shapeIds: \["shape:idea","shape:tapd"\]\)/
  )
  assert.match(prompt, /唯一 teaching claim/)
  assert.match(prompt, /连线必须从源对象边界连续落到目标边界/)
  assert.match(prompt, /data-cowart-diagram-spec/)
  assert.match(prompt, /anchorShapeId/)
  assert.match(prompt, /semanticDiagram 元数据/)
  assert.match(prompt, /dryRun:true/)
  assert.match(prompt, /返回的 baseRevision/)
  assert.match(prompt, /revision 已变化/)
  assert.match(prompt, /不要只返回代码而不插入画布/)
})

test('semantic diagram prompt uses the whole page when selection is empty', () => {
  const prompt = buildSemanticDiagramPrompt({
    currentPageId: 'page:whole',
    currentPageName: '产品探索'
  })

  assert.match(prompt, /处理范围：当前整页/)
  assert.match(prompt, /get_cowart_thinking_context\(scope: "page", pageId: "page:whole"\)/)
  assert.doesNotMatch(prompt, /冻结 shape IDs/)
  assert.match(prompt, /未读取时只保留为待解析来源/)
  assert.match(prompt, /页面 page:whole 的空白区域/)
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
