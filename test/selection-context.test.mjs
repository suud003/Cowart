import assert from 'node:assert/strict'
import test from 'node:test'

import {
  expandCowartSelectionShapeIds,
  getCowartFrozenSelectionSnapshot
} from '../src/selectionContext.js'

test('selection scope recursively expands frame and group descendants in stable order', () => {
  const children = new Map([
    ['shape:frame', ['shape:card', 'shape:group']],
    ['shape:group', ['shape:detail', 'shape:card']],
    ['shape:detail', ['shape:label']]
  ])

  const shapeIds = expandCowartSelectionShapeIds(
    ['shape:frame', 'shape:detail'],
    (shapeId) => children.get(shapeId) ?? []
  )

  assert.deepEqual(shapeIds, [
    'shape:frame',
    'shape:card',
    'shape:group',
    'shape:detail',
    'shape:label'
  ])
})

test('frozen selection snapshot keeps exact descendant IDs after the live selection changes', () => {
  let selectedShapeIds = ['shape:frame']
  const children = new Map([
    ['shape:frame', ['shape:card', 'shape:group']],
    ['shape:group', ['shape:detail']]
  ])
  const shapes = new Map(
    ['shape:frame', 'shape:card', 'shape:group', 'shape:detail', 'shape:outside'].map((id) => [
      id,
      { id, type: id.includes('frame') ? 'frame' : 'geo', parentId: 'page:one', props: {} }
    ])
  )
  const editor = {
    getSelectedShapeIds: () => selectedShapeIds,
    getSortedChildIdsForParent: (shapeId) => children.get(shapeId) ?? [],
    getShape: (shapeId) => shapes.get(shapeId),
    getAsset: () => null
  }

  const frozenSnapshot = getCowartFrozenSelectionSnapshot(editor)
  selectedShapeIds = ['shape:outside']

  assert.deepEqual(frozenSnapshot.selectedRootShapeIds, ['shape:frame'])
  assert.deepEqual(frozenSnapshot.exactShapeIds, [
    'shape:frame',
    'shape:card',
    'shape:group',
    'shape:detail'
  ])
  assert.deepEqual(
    frozenSnapshot.selectedShapes.map((shape) => shape.id),
    frozenSnapshot.exactShapeIds
  )
})
