import {
  ChevronDown,
  ChevronRight,
  File,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

function orderedCanvases(project) {
  return [...(project?.canvases || [])].sort((left, right) => {
    const parentOrder = String(left.parentId || '').localeCompare(String(right.parentId || ''))
    if (parentOrder !== 0) return parentOrder
    return (Number(left.order) || 0) - (Number(right.order) || 0) ||
      String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
  })
}

function descendantsOf(canvases, canvasId) {
  const children = new Map()
  for (const canvas of canvases) {
    const siblings = children.get(canvas.parentId || null) || []
    siblings.push(canvas.id)
    children.set(canvas.parentId || null, siblings)
  }
  const descendants = new Set()
  const queue = [...(children.get(canvasId) || [])]
  while (queue.length > 0) {
    const id = queue.shift()
    if (descendants.has(id)) continue
    descendants.add(id)
    queue.push(...(children.get(id) || []))
  }
  return descendants
}

function ancestorIds(canvases, canvasId) {
  const byId = new Map(canvases.map((canvas) => [canvas.id, canvas]))
  const ancestors = []
  const visited = new Set()
  let current = byId.get(canvasId)
  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId)
    ancestors.push(current.parentId)
    current = byId.get(current.parentId)
  }
  return ancestors
}

function CanvasTreeRow({
  activeCanvasId,
  allCanvases,
  busy,
  canvas,
  childrenByParent,
  depth,
  draggedCanvasId,
  editingCanvasId,
  expanded,
  nameDraft,
  onActivate,
  onBeginRename,
  onCancelRename,
  onCommitRename,
  onCreate,
  onDelete,
  onDragEnd,
  onDragStart,
  onMove,
  onNameDraftChange,
  onToggle
}) {
  const children = childrenByParent.get(canvas.id) || []
  const hasChildren = children.length > 0
  const isExpanded = expanded.has(canvas.id)
  const isActive = canvas.id === activeCanvasId
  const unavailableParents = descendantsOf(allCanvases, canvas.id)
  unavailableParents.add(canvas.id)

  return (
    <li
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-level={depth + 1}
      aria-selected={isActive}
      className="yogurt-canvas-tree-node"
      data-canvas-id={canvas.id}
      role="treeitem"
    >
      <div
        className="yogurt-canvas-tree-row"
        data-active={isActive ? 'true' : 'false'}
        data-dragging={draggedCanvasId === canvas.id ? 'true' : 'false'}
        draggable={!busy && editingCanvasId !== canvas.id}
        onDragEnd={onDragEnd}
        onDragOver={(event) => {
          if (!draggedCanvasId || draggedCanvasId === canvas.id) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDragStart={(event) => onDragStart(event, canvas.id)}
        onDrop={(event) => {
          event.preventDefault()
          if (!draggedCanvasId || unavailableParents.has(canvas.id)) return
          onMove(draggedCanvasId, canvas.id)
        }}
        style={{ '--canvas-tree-depth': depth }}
      >
        <button
          aria-label={hasChildren ? (isExpanded ? '折叠子画布' : '展开子画布') : undefined}
          className="yogurt-canvas-tree-chevron"
          disabled={!hasChildren}
          onClick={() => hasChildren && onToggle(canvas.id)}
          tabIndex={hasChildren ? 0 : -1}
          type="button"
        >
          {hasChildren
            ? (isExpanded ? <ChevronDown aria-hidden="true" size={14} /> : <ChevronRight aria-hidden="true" size={14} />)
            : <span aria-hidden="true" />}
        </button>

        {editingCanvasId === canvas.id ? (
          <input
            aria-label="画布名称"
            autoFocus
            className="yogurt-canvas-tree-rename"
            disabled={busy}
            maxLength={120}
            onBlur={() => onCommitRename(canvas)}
            onChange={(event) => onNameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onCommitRename(canvas)
              if (event.key === 'Escape') onCancelRename()
            }}
            value={nameDraft}
          />
        ) : (
          <button
            aria-current={isActive ? 'page' : undefined}
            className="yogurt-canvas-tree-label"
            disabled={busy}
            onClick={() => onActivate(canvas.id)}
            onDoubleClick={() => onBeginRename(canvas)}
            onKeyDown={(event) => {
              if (event.key === 'F2') {
                event.preventDefault()
                onBeginRename(canvas)
              }
            }}
            title={canvas.name}
            type="button"
          >
            <File aria-hidden="true" size={15} strokeWidth={1.8} />
            <span>{canvas.name}</span>
          </button>
        )}

        <button
          aria-label={`在“${canvas.name}”下新建子画布`}
          className="yogurt-canvas-tree-action"
          disabled={busy}
          onClick={() => onCreate(canvas.id)}
          title="新建子画布"
          type="button"
        >
          <Plus aria-hidden="true" size={14} />
        </button>

        <details className="yogurt-canvas-tree-menu">
          <summary aria-label={`${canvas.name}的更多操作`} title="更多操作">
            <MoreHorizontal aria-hidden="true" size={15} />
          </summary>
          <div className="yogurt-canvas-tree-popover">
            <button disabled={busy} onClick={() => onBeginRename(canvas)} type="button">
              <Pencil aria-hidden="true" size={14} />重命名
            </button>
            <label>
              <span>父级</span>
              <select
                aria-label={`${canvas.name}的父级画布`}
                disabled={busy}
                onChange={(event) => onMove(canvas.id, event.target.value || null)}
                value={canvas.parentId || ''}
              >
                <option value="">项目根级</option>
                {allCanvases
                  .filter((candidate) => !unavailableParents.has(candidate.id))
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                  ))}
              </select>
            </label>
            <button
              className="is-danger"
              disabled={busy || allCanvases.length <= 1}
              onClick={() => onDelete(canvas)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} />删除
            </button>
          </div>
        </details>
      </div>

      {hasChildren && isExpanded && (
        <ul role="group">
          {children.map((child) => (
            <CanvasTreeRow
              activeCanvasId={activeCanvasId}
              allCanvases={allCanvases}
              busy={busy}
              canvas={child}
              childrenByParent={childrenByParent}
              depth={depth + 1}
              draggedCanvasId={draggedCanvasId}
              editingCanvasId={editingCanvasId}
              expanded={expanded}
              key={child.id}
              nameDraft={nameDraft}
              onActivate={onActivate}
              onBeginRename={onBeginRename}
              onCancelRename={onCancelRename}
              onCommitRename={onCommitRename}
              onCreate={onCreate}
              onDelete={onDelete}
              onDragEnd={onDragEnd}
              onDragStart={onDragStart}
              onMove={onMove}
              onNameDraftChange={onNameDraftChange}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function CanvasNavigator({
  activeCanvasId,
  busy = false,
  onActivate,
  onCreate,
  onDelete,
  onMove,
  onRename,
  project
}) {
  const canvases = useMemo(() => orderedCanvases(project), [project])
  const childrenByParent = useMemo(() => {
    const groups = new Map()
    for (const canvas of canvases) {
      const parentId = canvas.parentId || null
      const siblings = groups.get(parentId) || []
      siblings.push(canvas)
      groups.set(parentId, siblings)
    }
    return groups
  }, [canvases])
  const [expanded, setExpanded] = useState(() => new Set())
  const [editingCanvasId, setEditingCanvasId] = useState(null)
  const [nameDraft, setNameDraft] = useState('')
  const [draggedCanvasId, setDraggedCanvasId] = useState(null)
  const previousActiveRef = useRef(null)

  useEffect(() => {
    if (!activeCanvasId || previousActiveRef.current === activeCanvasId) return
    previousActiveRef.current = activeCanvasId
    const ancestors = ancestorIds(canvases, activeCanvasId)
    if (ancestors.length === 0) return
    setExpanded((current) => new Set([...current, ...ancestors]))
  }, [activeCanvasId, canvases])

  function beginRename(canvas) {
    setEditingCanvasId(canvas.id)
    setNameDraft(canvas.name)
  }

  function commitRename(canvas) {
    if (editingCanvasId !== canvas.id) return
    const nextName = nameDraft.trim()
    setEditingCanvasId(null)
    setNameDraft('')
    if (nextName && nextName !== canvas.name) onRename(canvas.id, nextName)
  }

  function deleteCanvas(canvas) {
    const childCount = (childrenByParent.get(canvas.id) || []).length
    const detail = childCount > 0
      ? `\n它的 ${childCount} 个直接子画布会提升到当前层级，内容不会被删除。`
      : ''
    if (window.confirm(`删除画布“${canvas.name}”？${detail}`)) onDelete(canvas.id)
  }

  return (
    <div className="yogurt-canvas-navigator" data-busy={busy ? 'true' : 'false'}>
      <div className="yogurt-canvas-navigator-heading">
        <div>
          <FolderTree aria-hidden="true" size={17} />
          <strong>项目画布</strong>
          <span>{canvases.length}</span>
        </div>
        <button disabled={busy} onClick={() => onCreate(null)} type="button">
          <Plus aria-hidden="true" size={15} />新建
        </button>
      </div>

      <div
        className="yogurt-canvas-root-drop"
        onDragOver={(event) => {
          if (!draggedCanvasId) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (draggedCanvasId) onMove(draggedCanvasId, null)
        }}
      >
        拖到这里移至项目根级
      </div>

      <ul aria-label="项目画布" className="yogurt-canvas-tree" role="tree">
        {(childrenByParent.get(null) || []).map((canvas) => (
          <CanvasTreeRow
            activeCanvasId={activeCanvasId}
            allCanvases={canvases}
            busy={busy}
            canvas={canvas}
            childrenByParent={childrenByParent}
            depth={0}
            draggedCanvasId={draggedCanvasId}
            editingCanvasId={editingCanvasId}
            expanded={expanded}
            key={canvas.id}
            nameDraft={nameDraft}
            onActivate={onActivate}
            onBeginRename={beginRename}
            onCancelRename={() => {
              setEditingCanvasId(null)
              setNameDraft('')
            }}
            onCommitRename={commitRename}
            onCreate={onCreate}
            onDelete={deleteCanvas}
            onDragEnd={() => setDraggedCanvasId(null)}
            onDragStart={(event, canvasId) => {
              setDraggedCanvasId(canvasId)
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', canvasId)
            }}
            onMove={onMove}
            onNameDraftChange={setNameDraft}
            onToggle={(canvasId) => setExpanded((current) => {
              const next = new Set(current)
              if (next.has(canvasId)) next.delete(canvasId)
              else next.add(canvasId)
              return next
            })}
          />
        ))}
      </ul>
      {busy && <div aria-live="polite" className="yogurt-canvas-navigator-status">正在切换画布…</div>}
    </div>
  )
}
