import { convertToExcalidrawElements, restore } from '@excalidraw/excalidraw'

const COLOR_BY_TLDRAW_NAME = Object.freeze({
  black: '#1b1b1f',
  blue: '#1e1aa8',
  green: '#087f5b',
  grey: '#868e96',
  gray: '#868e96',
  lightblue: '#4dabf7',
  lightgreen: '#69db7c',
  lightred: '#ffa8a8',
  lightviolet: '#d0bfff',
  orange: '#e8590c',
  red: '#c92a2a',
  violet: '#7048e8',
  white: '#ffffff',
  yellow: '#f08c00'
})

export function emptyExcalidrawDocument() {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/suud003/Cowart',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {}
  }
}

export function isExcalidrawDocument(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.type === 'excalidraw' &&
    Array.isArray(value.elements)
  )
}

function richTextToPlainText(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (!Array.isArray(value.content)) return ''
  return value.content.map(richTextToPlainText).filter(Boolean).join(value.type === 'doc' ? '\n' : '')
}

function tldrawColor(value, fallback = '#1b1b1f') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '')
  return COLOR_BY_TLDRAW_NAME[normalized] || (String(value || '').startsWith('#') ? value : fallback)
}

function tldrawFill(value) {
  if (value === 'solid') return 'solid'
  if (value === 'none') return 'hachure'
  return value === 'pattern' || value === 'semi' ? 'hachure' : 'solid'
}

function tldrawStrokeStyle(value) {
  if (value === 'dashed') return 'dashed'
  if (value === 'dotted') return 'dotted'
  return 'solid'
}

function tldrawStrokeWidth(value) {
  if (value === 'xl') return 4
  if (value === 'l') return 3
  if (value === 'm') return 2
  return 1
}

function tldrawFontFamily(value) {
  if (value === 'mono') return 3
  if (value === 'sans') return 2
  return 1
}

function tldrawFontSize(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(8, value)
  if (value === 'xl') return 32
  if (value === 'l') return 28
  if (value === 's') return 16
  return 20
}

function mapGeoType(value) {
  if (value === 'ellipse' || value === 'oval') return 'ellipse'
  if (value === 'diamond') return 'diamond'
  return 'rectangle'
}

function pagePositionForShape(store, shape, cache = new Map()) {
  if (cache.has(shape.id)) return cache.get(shape.id)
  let x = Number(shape.x) || 0
  let y = Number(shape.y) || 0
  const parent = store[shape.parentId]
  if (parent?.typeName === 'shape') {
    const parentPosition = pagePositionForShape(store, parent, cache)
    x += parentPosition.x
    y += parentPosition.y
  }
  const position = { x, y }
  cache.set(shape.id, position)
  return position
}

function textForShape(shape) {
  return [
    richTextToPlainText(shape?.props?.richText),
    typeof shape?.props?.text === 'string' ? shape.props.text : '',
    typeof shape?.props?.label === 'string' ? shape.props.label : ''
  ].find((value) => value.trim()) || ''
}

function elementSkeletonForShape(store, shape, position) {
  const props = shape.props || {}
  const common = {
    id: shape.id,
    x: position.x,
    y: position.y,
    width: Math.max(16, Number(props.w) || 240),
    height: Math.max(16, Number(props.h) || 140),
    angle: Number(shape.rotation) || 0,
    strokeColor: tldrawColor(props.color),
    backgroundColor: tldrawColor(props.fill === 'none' ? '#ffffff' : props.color, '#ffffff'),
    fillStyle: tldrawFill(props.fill),
    strokeWidth: tldrawStrokeWidth(props.size),
    strokeStyle: tldrawStrokeStyle(props.dash),
    roughness: 1,
    opacity: 100,
    frameId: store[shape.parentId]?.type === 'frame' ? shape.parentId : null,
    link: typeof props.url === 'string' && props.url ? props.url : null,
    customData: {
      cowart: {
        migratedFrom: 'tldraw',
        originalType: shape.type,
        ...(shape.meta && typeof shape.meta === 'object' ? shape.meta : {})
      }
    }
  }

  if (shape.type === 'frame') {
    const children = Object.values(store)
      .filter((record) => record?.typeName === 'shape' && record.parentId === shape.id)
      .map((record) => record.id)
    return { type: 'frame', children, name: props.name || textForShape(shape) || 'Frame', ...common }
  }

  if (shape.type === 'text') {
    return {
      type: 'text',
      text: textForShape(shape),
      fontFamily: tldrawFontFamily(props.font),
      fontSize: tldrawFontSize(props.size),
      textAlign: props.textAlign === 'end' ? 'right' : props.textAlign === 'middle' ? 'center' : 'left',
      verticalAlign: 'top',
      ...common
    }
  }

  const label = textForShape(shape)
  return {
    type: shape.type === 'geo' ? mapGeoType(props.geo) : 'rectangle',
    ...common,
    ...(label ? {
      label: {
        text: label,
        fontFamily: tldrawFontFamily(props.font),
        fontSize: tldrawFontSize(props.size),
        textAlign: props.align === 'start' ? 'left' : props.align === 'end' ? 'right' : 'center',
        verticalAlign: props.verticalAlign === 'start' ? 'top' : props.verticalAlign === 'end' ? 'bottom' : 'middle'
      }
    } : {})
  }
}

function arrowSkeletons(store, positions) {
  const bindings = Object.values(store).filter(
    (record) => record?.typeName === 'binding' && record.type === 'arrow'
  )
  const bindingsByArrow = new Map()
  for (const binding of bindings) {
    const list = bindingsByArrow.get(binding.fromId) || []
    list.push(binding)
    bindingsByArrow.set(binding.fromId, list)
  }

  return Object.values(store)
    .filter((shape) => shape?.typeName === 'shape' && shape.type === 'arrow')
    .map((shape) => {
      const props = shape.props || {}
      const shapeBindings = bindingsByArrow.get(shape.id) || []
      const startBinding = shapeBindings.find((binding) => binding.props?.terminal === 'start')
      const endBinding = shapeBindings.find((binding) => binding.props?.terminal === 'end')
      const position = pagePositionForShape(store, shape, positions)
      const start = props.start || { x: 0, y: 0 }
      const end = props.end || { x: 240, y: 0 }
      const label = textForShape(shape)
      return {
        type: 'arrow',
        id: shape.id,
        x: position.x + (Number(start.x) || 0),
        y: position.y + (Number(start.y) || 0),
        points: [[0, 0], [
          (Number(end.x) || 240) - (Number(start.x) || 0),
          (Number(end.y) || 0) - (Number(start.y) || 0)
        ]],
        strokeColor: tldrawColor(props.color),
        strokeWidth: tldrawStrokeWidth(props.size),
        strokeStyle: tldrawStrokeStyle(props.dash),
        roughness: 1,
        startArrowhead: props.arrowheadStart === 'none' ? null : props.arrowheadStart || null,
        endArrowhead: props.arrowheadEnd === 'none' ? null : props.arrowheadEnd || 'arrow',
        ...(startBinding?.toId ? { start: { id: startBinding.toId } } : {}),
        ...(endBinding?.toId ? { end: { id: endBinding.toId } } : {}),
        ...(label ? { label: { text: label, fontFamily: 1, fontSize: 16 } } : {}),
        customData: { cowart: { migratedFrom: 'tldraw', ...(shape.meta || {}) } }
      }
    })
}

export function migrateTldrawSnapshot(snapshot) {
  if (!snapshot?.store || !snapshot?.schema) return emptyExcalidrawDocument()
  const store = snapshot.store
  const positions = new Map()
  const shapes = Object.values(store).filter(
    (shape) => shape?.typeName === 'shape' && shape.type !== 'arrow' && shape.type !== 'image'
  )
  const skeletons = [
    ...shapes.map((shape) => elementSkeletonForShape(
      store,
      shape,
      pagePositionForShape(store, shape, positions)
    )),
    ...arrowSkeletons(store, positions)
  ]

  let elements = []
  try {
    elements = convertToExcalidrawElements(skeletons, { regenerateIds: false })
  } catch (error) {
    console.error('Legacy Yogurt canvas migration failed.', error)
  }

  return {
    ...emptyExcalidrawDocument(),
    elements,
    appState: {
      viewBackgroundColor: '#ffffff',
      scrollToContent: elements.length > 0
    },
    yogurt: {
      migratedFrom: 'tldraw',
      migratedAt: new Date().toISOString()
    }
  }
}

export function normalizeExcalidrawDocument(snapshot) {
  const document = isExcalidrawDocument(snapshot)
    ? snapshot
    : migrateTldrawSnapshot(snapshot)
  const restored = restore(document, null, null, { repairBindings: true })
  return {
    ...emptyExcalidrawDocument(),
    ...document,
    elements: restored.elements,
    appState: restored.appState,
    files: restored.files || {}
  }
}
