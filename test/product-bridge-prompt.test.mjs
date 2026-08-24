import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildProductBridgePrompt,
  getProductBridgeScopeSize,
  PRODUCT_BRIDGE_MAX_CONTEXT_SHAPES
} from '../src/productBridgePrompt.js'

function shapeIds(count) {
  return Array.from({ length: count }, (_, index) => `shape:${index + 1}`)
}

test('product bridge prompt scopes generation and return flow to the selected Yogurt shapes', () => {
  const prompt = buildProductBridgePrompt({
    selectedShapeIds: ['shape:idea', 'shape:tapd', 'shape:idea', ''],
    currentPageId: 'page:product',
    currentPageName: 'UGC AI 助手'
  })

  assert.match(prompt, /Use \$cowart-product-bridge/)
  assert.match(prompt, /UGC AI 助手 \(page:product\)/)
  assert.match(prompt, /当前选区，共 2 个对象/)
  assert.match(prompt, /精确目标 shape IDs：shape:idea, shape:tapd/)
  assert.match(
    prompt,
    /get_cowart_thinking_context\(scope: "selection", shapeIds: \["shape:idea","shape:tapd"\]\)/
  )
  assert.match(prompt, /点击菜单瞬间冻结的权威范围/)
  assert.match(prompt, /不要重新读取或依赖.*共享选区/)
  assert.match(prompt, /文字叙述、零散产品想法、已粘贴的 TAPD 链接/)
  assert.match(prompt, /data-annotation-anchor/)
  assert.match(prompt, /\$cowart-semantic-diagram/)
  assert.match(prompt, /未解析 TAPD 不得成为方向箭头的依据/)
  assert.match(prompt, /sourceId -> yogurtShapeId -> svgObjectId\/annotationAnchor -> zoneId -> requirementId/)
  assert.match(prompt, /pageId#annotationId -> lastSyncedRevision/)
  assert.match(prompt, /dry-run/)
  assert.match(prompt, /只有获得用户明确确认后才能正式回写/)
  assert.match(prompt, /不得覆盖无关内容/)
})

test('product bridge prompt uses the whole current page when the selection is empty', () => {
  const prompt = buildProductBridgePrompt({
    selectedShapeIds: [],
    currentPageId: 'page:whole',
    currentPageName: '产品探索'
  })

  assert.match(prompt, /处理范围：当前整页/)
  assert.match(prompt, /该页面的全部产品内容作为输入/)
  assert.doesNotMatch(prompt, /精确目标 shape IDs/)
  assert.match(
    prompt,
    /get_cowart_thinking_context\(scope: "page", pageId: "page:whole"\)/
  )
  assert.match(prompt, /缺少登录态或权限/)
  assert.match(prompt, /标记为“待解析”/)
  assert.match(prompt, /当前页面的产品区域/)
})

test('product bridge scope allows 250 shapes and rejects 251 without truncation', () => {
  assert.equal(PRODUCT_BRIDGE_MAX_CONTEXT_SHAPES, 250)

  const selectionAtLimit = getProductBridgeScopeSize({ selectedShapeIds: shapeIds(250) })
  const selectionOverLimit = getProductBridgeScopeSize({ selectedShapeIds: shapeIds(251) })
  const pageAtLimit = getProductBridgeScopeSize({
    selectedShapeIds: [],
    currentPageShapeCount: 250
  })
  const pageOverLimit = getProductBridgeScopeSize({
    selectedShapeIds: [],
    currentPageShapeCount: 251
  })

  assert.deepEqual(selectionAtLimit, {
    scope: 'selection',
    shapeCount: 250,
    maxShapes: 250,
    isTooLarge: false
  })
  assert.deepEqual(selectionOverLimit, {
    scope: 'selection',
    shapeCount: 251,
    maxShapes: 250,
    isTooLarge: true
  })
  assert.equal(pageAtLimit.isTooLarge, false)
  assert.equal(pageAtLimit.shapeCount, 250)
  assert.equal(pageOverLimit.isTooLarge, true)
  assert.equal(pageOverLimit.shapeCount, 251)
})
