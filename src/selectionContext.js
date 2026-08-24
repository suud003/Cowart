function getCowartShapes(editor, shapeIds) {
  return shapeIds.map((id) => {
    const shape = editor.getShape(id)
    const asset = shape?.props?.assetId ? editor.getAsset(shape.props.assetId) : null

    return {
      id,
      type: shape?.type ?? null,
      parentId: shape?.parentId ?? null,
      x: shape?.x ?? null,
      y: shape?.y ?? null,
      rotation: shape?.rotation ?? null,
      meta: shape?.meta ?? null,
      isAiImageHolder: shape?.meta?.cowartAiImageHolder === true,
      isAiDraftHolder: shape?.meta?.cowartAiDraftHolder === true,
      isAiSlides: shape?.meta?.cowartAiSlides === true,
      isHtmlDraft:
        shape?.type === 'embed' &&
        (shape?.meta?.cowartHtmlDraft === true ||
          /^http:\/\/cowart\.local\//i.test(shape?.props?.url ?? '') ||
          /^data:text\/html(?:;[^,]*)?,/i.test(shape?.props?.url ?? '')),
      props: shape?.props ?? null,
      asset: asset
        ? {
            id: asset.id,
            type: asset.type,
            name: asset.props?.name ?? null,
            src: asset.props?.src ?? null,
            w: asset.props?.w ?? null,
            h: asset.props?.h ?? null,
            mimeType: asset.props?.mimeType ?? null,
            fileSize: asset.props?.fileSize ?? null
          }
        : null
    }
  })
}

export function expandCowartSelectionShapeIds(selectedShapeIds, getChildShapeIds) {
  const expandedShapeIds = []
  const visitedShapeIds = new Set()

  function visit(shapeId) {
    if (typeof shapeId !== 'string' || !shapeId || visitedShapeIds.has(shapeId)) return
    visitedShapeIds.add(shapeId)
    expandedShapeIds.push(shapeId)

    const childShapeIds = getChildShapeIds?.(shapeId)
    if (!childShapeIds) return
    for (const childShapeId of childShapeIds) visit(childShapeId)
  }

  for (const shapeId of selectedShapeIds ?? []) visit(shapeId)
  return expandedShapeIds
}

export function getCowartSelection(editor) {
  return getCowartShapes(editor, editor.getSelectedShapeIds())
}

export function getCowartSelectionSnapshot(editor) {
  return {
    selectedShapes: getCowartSelection(editor)
  }
}

export function getCowartFrozenSelectionIds(editor) {
  const selectedRootShapeIds = Array.from(editor.getSelectedShapeIds())
  const exactShapeIds = expandCowartSelectionShapeIds(
    selectedRootShapeIds,
    (shapeId) => editor.getSortedChildIdsForParent(shapeId)
  )

  return { selectedRootShapeIds, exactShapeIds }
}

export function getCowartFrozenSelectionSnapshot(editor) {
  const { selectedRootShapeIds, exactShapeIds } = getCowartFrozenSelectionIds(editor)
  return {
    selectedShapes: getCowartShapes(editor, exactShapeIds),
    selectedRootShapeIds,
    exactShapeIds
  }
}
