import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  FileText,
  FolderOpen,
  LoaderCircle,
  LogIn,
  PanelRightClose,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Square,
  Terminal,
  X,
  Workflow
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const EMPTY_BRIDGE_STATE = {
  status: 'unavailable',
  capabilities: {
    available: false,
    provider: 'none'
  },
  pendingTaskIds: [],
  lastTask: null,
  lastEvent: null
}

const AGENT_CONTEXT_MAX_SHAPE_IDS = 250

const QUICK_TASKS = [
  { icon: Sparkles, label: '整理选区', prompt: '整理当前画布选区；如果没有选中对象，则整理当前页面。找出主题、关系与待确认问题。' },
  { icon: FileText, label: '生成 PRD', prompt: '根据当前画布与选区信息，生成可评审的产品 PRD 和交互原型。' },
  { icon: Workflow, label: '生成框线图', prompt: '把当前内容整理为语义清晰的框线图，并写回 Yogurt AI 画布。' }
]

function stableContextKey(context) {
  return JSON.stringify([
    context?.projectName,
    context?.pageId,
    context?.pageName,
    context?.selectedCount,
    context?.pageShapeCount
  ])
}

function readContext(contextProvider) {
  try {
    return contextProvider?.() ?? null
  } catch (error) {
    console.warn('Yogurt AI could not read Agent panel context.', error)
    return null
  }
}

export function connectionPresentation(state) {
  const setup = state?.capabilities?.setup
  if (setup?.workspace?.status === 'required') {
    return { label: '待设置', tone: 'offline' }
  }
  if (['starting', 'waiting-for-workspace', 'login-pending'].includes(setup?.codex?.status)) {
    return { label: '连接中', tone: 'working' }
  }
  if (['missing', 'login-required'].includes(setup?.codex?.status)) {
    return { label: '需配置', tone: 'offline' }
  }
  if (
    state?.status === 'sending' ||
    (state?.capabilities?.streaming &&
      ['submitting', 'running', 'waiting_approval'].includes(state?.activity?.phase))
  ) {
    return { label: '执行中', tone: 'working' }
  }
  const errorSource = state?.lastEvent?.source || state?.lastEvent?.payload?.source || null
  const isOrdinaryTurnFailure =
    state?.lastEvent?.type === 'turn.failed' && !['sidecar', 'protocol', 'transport'].includes(errorSource)
  if (state?.status === 'error' && !isOrdinaryTurnFailure) {
    return { label: '连接异常', tone: 'error' }
  }
  if (state?.capabilities?.available) {
    return { label: '已连接', tone: 'connected' }
  }
  return { label: '未连接', tone: 'offline' }
}

export function taskStatusPresentation(status) {
  if (status === 'sending' || status === 'pending') {
    return { label: '正在交给 Codex', tone: 'working', Icon: LoaderCircle }
  }
  if (['succeeded', 'completed', 'complete'].includes(status)) {
    return { label: '已完成', tone: 'success', Icon: CheckCircle2 }
  }
  if (['accepted', 'sent'].includes(status)) {
    return { label: '已交给 Codex', tone: 'success', Icon: CheckCircle2 }
  }
  if (['cancelled', 'canceled'].includes(status)) {
    return { label: '已中断', tone: 'idle', Icon: Square }
  }
  if (['error', 'failed'].includes(status)) {
    return { label: '发送失败', tone: 'error', Icon: AlertCircle }
  }
  return { label: '等待处理', tone: 'idle', Icon: Circle }
}

export function codexLoginButtonLabel(status, busy = false) {
  if (busy) return '正在打开…'
  return status === 'login-pending' ? '重新打开登录页' : '登录 Codex'
}

function taskStatusFromActivity(activity, fallbackStatus, followsActivity) {
  if (!followsActivity) return fallbackStatus
  if (['submitting', 'running', 'waiting_approval', 'waiting_elicitation'].includes(activity?.phase)) return 'sending'
  if (activity?.phase === 'completed') return 'completed'
  if (activity?.phase === 'failed') return 'failed'
  if (activity?.phase === 'cancelled') return 'cancelled'
  return fallbackStatus
}

function formatTaskTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function taskExcerpt(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  return compact.length > 54 ? `${compact.slice(0, 54)}…` : compact
}

function activityText(value) {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        return item?.text || item?.step || item?.title || item?.summary || item?.description || ''
      })
      .filter(Boolean)
      .join(' · ')
  }
  if (!value || typeof value !== 'object') return ''
  const direct = value.text || value.summary || value.message || value.title || value.description
  if (typeof direct === 'string') return direct.trim()
  if (Array.isArray(value.items)) return activityText(value.items)
  if (Array.isArray(value.steps)) return activityText(value.steps)
  if (Array.isArray(value.files)) {
    const files = value.files
      .map((file) => (typeof file === 'string' ? file : file?.path || file?.name || ''))
      .filter(Boolean)
    return files.length ? `涉及 ${files.length} 个文件：${files.slice(0, 3).join('、')}` : ''
  }
  return ''
}

function clipActivityText(value, maxLength = 560) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact
}

const ELICITATION_STRING_FORMATS = new Set(['email', 'uri', 'date', 'date-time'])
const ELICITATION_MAX_FIELDS = 50
const ELICITATION_MAX_OPTIONS = 100

function safeElicitationText(value, maxLength = 320) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function ownValue(object, key) {
  return object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : undefined
}

function setSafeProperty(object, key, value) {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
  return object
}

function primitiveValue(value) {
  return ['string', 'number', 'boolean'].includes(typeof value) &&
    (typeof value !== 'number' || Number.isFinite(value))
}

function optionList(schema, { anyOf = false } = {}) {
  const enumValues = Array.isArray(schema?.enum) ? schema.enum : null
  const variants = Array.isArray(schema?.[anyOf ? 'anyOf' : 'oneOf'])
    ? schema[anyOf ? 'anyOf' : 'oneOf']
    : null
  if (!enumValues && !variants) return { options: null, supported: true }

  let values
  if (enumValues) {
    const titles = Array.isArray(schema.enumNames)
      ? schema.enumNames
      : Array.isArray(schema['x-enumNames']) ? schema['x-enumNames'] : []
    values = enumValues.map((value, index) => ({
      value,
      title: safeElicitationText(titles[index], 120) || String(value)
    }))
  } else {
    values = variants.map((variant) => {
      if (!variant || typeof variant !== 'object' || !Object.prototype.hasOwnProperty.call(variant, 'const')) {
        return null
      }
      return {
        value: variant.const,
        title: safeElicitationText(variant.title, 120) || String(variant.const)
      }
    })
  }

  const supported = values.length > 0 &&
    values.length <= ELICITATION_MAX_OPTIONS &&
    values.every((option) => option && primitiveValue(option.value)) &&
    values.every((option, index) =>
      values.findIndex((candidate) => candidate && Object.is(candidate.value, option.value)) === index
    )
  return { options: supported ? values : null, supported }
}

function finiteConstraint(value, { integer = false, minimum = -Infinity } = {}) {
  if (value == null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isInteger(number))) return null
  return number
}

function normalizeElicitationField(name, rawSchema, required, index) {
  const schema = rawSchema && typeof rawSchema === 'object' && !Array.isArray(rawSchema)
    ? rawSchema
    : null
  const fallbackTitle = safeElicitationText(name, 120) || `字段 ${index + 1}`
  if (!schema || Array.isArray(schema.type)) {
    return { name, title: fallbackTitle, supported: false, reason: '字段结构暂不支持' }
  }

  const type = String(schema.type || (Array.isArray(schema.enum) || Array.isArray(schema.oneOf) ? 'string' : ''))
  const field = {
    name,
    title: safeElicitationText(schema.title, 120) || fallbackTitle,
    description: safeElicitationText(schema.description),
    required,
    type,
    defaultValue: ownValue(schema, 'default'),
    supported: true
  }

  if (type === 'string') {
    const choices = optionList(schema)
    if (
      !choices.supported ||
      (choices.options && choices.options.some((option) => typeof option.value !== 'string'))
    ) return { ...field, supported: false, reason: '选项结构暂不支持' }
    const minLength = finiteConstraint(schema.minLength, { integer: true, minimum: 0 })
    const maxLength = finiteConstraint(schema.maxLength, { integer: true, minimum: 0 })
    if (minLength === null || maxLength === null || (minLength != null && maxLength != null && minLength > maxLength)) {
      return { ...field, supported: false, reason: '文本长度约束无效' }
    }
    const format = schema.format == null ? '' : String(schema.format)
    if (format && !ELICITATION_STRING_FORMATS.has(format)) {
      return { ...field, supported: false, reason: `暂不支持 ${safeElicitationText(format, 40)} 格式` }
    }
    return { ...field, options: choices.options, minLength, maxLength, format }
  }

  if (type === 'number' || type === 'integer') {
    const minimum = finiteConstraint(schema.minimum)
    const maximum = finiteConstraint(schema.maximum)
    if (minimum === null || maximum === null || (minimum != null && maximum != null && minimum > maximum)) {
      return { ...field, supported: false, reason: '数值范围约束无效' }
    }
    return { ...field, minimum, maximum }
  }

  if (type === 'boolean') return field

  if (type === 'array') {
    const items = schema.items
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      return { ...field, supported: false, reason: '多选项结构暂不支持' }
    }
    const choices = optionList(items, { anyOf: true })
    const minItems = finiteConstraint(schema.minItems, { integer: true, minimum: 0 })
    const maxItems = finiteConstraint(schema.maxItems, { integer: true, minimum: 0 })
    if (
      !choices.supported || !choices.options ||
      choices.options.some((option) => typeof option.value !== 'string') ||
      minItems === null || maxItems === null ||
      (minItems != null && maxItems != null && minItems > maxItems)
    ) {
      return { ...field, supported: false, reason: '多选项或数量约束暂不支持' }
    }
    return { ...field, options: choices.options, minItems, maxItems }
  }

  return { ...field, supported: false, reason: `暂不支持 ${safeElicitationText(type || '未知', 40)} 类型` }
}

export function safeElicitationDomain(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (parsed.protocol !== 'https:' || !parsed.hostname) return ''
    return parsed.hostname
  } catch (_error) {
    return ''
  }
}

function safeElicitationHost(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || /[\s/@?#\\]/.test(text)) return ''
  try {
    const parsed = new URL(`https://${text}`)
    return parsed.hostname === text || parsed.hostname === text.toLowerCase() ? parsed.hostname : ''
  } catch (_error) {
    return ''
  }
}

export function normalizeElicitationRequest(rawRequest, requestId = null) {
  const raw = rawRequest && typeof rawRequest === 'object' ? rawRequest : {}
  const request = raw.elicitation && typeof raw.elicitation === 'object'
    ? raw.elicitation
    : raw.request && typeof raw.request === 'object' ? raw.request : raw
  const url = ownValue(request, 'url') ?? ownValue(request, 'elicitationUrl') ?? ''
  const urlHost = ownValue(request, 'urlHost') ?? ''
  const inferredMode = url || urlHost ? 'url' : 'form'
  const mode = String(request.mode || inferredMode).toLowerCase()
  const base = {
    kind: 'elicitation-model',
    requestId: requestId ?? request.requestId ?? request.id ?? null,
    title: safeElicitationText(request.title, 120) || 'Codex 需要你补充信息',
    message: safeElicitationText(request.message || request.description, 600)
  }

  if (mode === 'url') {
    const domain = safeElicitationDomain(url) || safeElicitationHost(urlHost)
    return {
      ...base,
      mode,
      domain,
      supported: Boolean(domain),
      unsupportedReasons: domain ? [] : ['外部地址无效或使用了不支持的协议']
    }
  }

  const schema = request.requestedSchema ?? request.schema
  if (mode !== 'form' || !schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
    return {
      ...base,
      mode,
      fields: [],
      supported: false,
      unsupportedReasons: ['请求没有提供受支持的对象表单结构']
    }
  }

  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return {
      ...base,
      mode,
      fields: [],
      supported: false,
      unsupportedReasons: ['表单字段结构无效']
    }
  }
  const entries = Object.entries(properties)
  if (entries.length > ELICITATION_MAX_FIELDS) {
    return {
      ...base,
      mode,
      fields: [],
      supported: false,
      unsupportedReasons: [`表单字段超过 ${ELICITATION_MAX_FIELDS} 项安全上限`]
    }
  }
  const requiredNames = Array.isArray(schema.required) ? schema.required.map(String) : []
  const propertyNames = new Set(entries.map(([name]) => String(name)))
  const invalidRequired = requiredNames.some((name, index) =>
    !propertyNames.has(name) || requiredNames.indexOf(name) !== index
  )
  if (schema.required != null && (!Array.isArray(schema.required) || invalidRequired)) {
    return {
      ...base,
      mode,
      fields: [],
      supported: false,
      unsupportedReasons: ['必填字段声明无效']
    }
  }
  const required = new Set(requiredNames)
  const fields = entries.map(([name, fieldSchema], index) =>
    normalizeElicitationField(String(name), fieldSchema, required.has(String(name)), index)
  )
  const unsupportedReasons = fields
    .filter((field) => !field.supported)
    .map((field) => `${field.title}：${field.reason}`)
  return {
    ...base,
    mode,
    fields,
    supported: unsupportedReasons.length === 0,
    unsupportedReasons
  }
}

export function createElicitationInitialValues(requestOrModel) {
  const model = requestOrModel?.kind === 'elicitation-model'
    ? requestOrModel
    : normalizeElicitationRequest(requestOrModel)
  const values = {}
  for (const field of model.fields || []) {
    if (!field.supported) continue
    let value
    if (field.type === 'array') {
      const defaults = Array.isArray(field.defaultValue) ? field.defaultValue : []
      value = defaults.filter((candidate) => field.options.some((option) => Object.is(option.value, candidate)))
    } else if (field.options) {
      value = field.options.some((option) => Object.is(option.value, field.defaultValue))
        ? field.defaultValue
        : undefined
    } else if (field.type === 'boolean') {
      value = typeof field.defaultValue === 'boolean'
        ? field.defaultValue
        : field.required ? false : undefined
    } else if (field.type === 'number' || field.type === 'integer') {
      value = typeof field.defaultValue === 'number' && Number.isFinite(field.defaultValue)
        ? String(field.defaultValue)
        : ''
    } else {
      value = typeof field.defaultValue === 'string' ? field.defaultValue : ''
    }
    setSafeProperty(values, field.name, value)
  }
  return values
}

export function buildElicitationContent(requestOrModel, values = {}) {
  const model = requestOrModel?.kind === 'elicitation-model'
    ? requestOrModel
    : normalizeElicitationRequest(requestOrModel)
  if (model.mode !== 'form' || !model.supported) {
    return { valid: false, content: null, errors: ['此请求无法安全提交。'] }
  }

  const content = {}
  const errors = []
  for (const field of model.fields) {
    const rawValue = ownValue(values, field.name)
    const label = field.title
    if (field.type === 'array') {
      const selected = Array.isArray(rawValue) ? rawValue : []
      const shouldInclude = field.required || selected.length > 0
      const hasInvalidSelection = selected.some((value) =>
        !field.options.some((option) => Object.is(option.value, value))
      ) || selected.some((value, index) => selected.findIndex((candidate) => Object.is(candidate, value)) !== index)
      if (hasInvalidSelection) errors.push(`${label}包含无效或重复选项。`)
      if (shouldInclude && ((field.minItems != null && selected.length < field.minItems) || (field.required && selected.length === 0))) {
        errors.push(`${label}至少选择 ${Math.max(field.minItems ?? 0, field.required ? 1 : 0)} 项。`)
      } else if (shouldInclude && field.maxItems != null && selected.length > field.maxItems) {
        errors.push(`${label}最多选择 ${field.maxItems} 项。`)
      }
      if (shouldInclude) setSafeProperty(content, field.name, selected)
      continue
    }

    if (field.options) {
      const matched = field.options.some((option) => Object.is(option.value, rawValue))
      if (field.required && !matched) errors.push(`请选择${label}。`)
      if (matched) setSafeProperty(content, field.name, rawValue)
      continue
    }

    if (field.type === 'boolean') {
      if (typeof rawValue === 'boolean') {
        setSafeProperty(content, field.name, rawValue)
      } else if (field.required) {
        errors.push(`请选择${label}。`)
      }
      continue
    }

    if (field.type === 'number' || field.type === 'integer') {
      if (rawValue === '' || rawValue == null) {
        if (field.required) errors.push(`请输入${label}。`)
        continue
      }
      const number = Number(rawValue)
      if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) {
        errors.push(`${label}必须是${field.type === 'integer' ? '整数' : '数字'}。`)
      } else if (field.minimum != null && number < field.minimum) {
        errors.push(`${label}不能小于 ${field.minimum}。`)
      } else if (field.maximum != null && number > field.maximum) {
        errors.push(`${label}不能大于 ${field.maximum}。`)
      } else {
        setSafeProperty(content, field.name, number)
      }
      continue
    }

    const string = typeof rawValue === 'string' ? rawValue : ''
    const shouldInclude = field.required || string.length > 0 || field.defaultValue === ''
    if (field.required && string.length === 0) errors.push(`请输入${label}。`)
    if (shouldInclude && field.minLength != null && string.length < field.minLength) {
      errors.push(`${label}至少需要 ${field.minLength} 个字符。`)
    } else if (shouldInclude && field.maxLength != null && string.length > field.maxLength) {
      errors.push(`${label}最多允许 ${field.maxLength} 个字符。`)
    }
    if (shouldInclude) {
      setSafeProperty(content, field.name, string)
    }
  }
  return { valid: errors.length === 0, content, errors }
}

function normalizeActivityEvent(event) {
  if (!event || typeof event !== 'object') return null
  const type = String(event.type || '')
  const common = {
    id: `${event.at || Date.now()}:${type}:${event.requestId || event.turnId || ''}:${String(event.text || '').slice(0, 24)}`,
    type,
    at: event.at || new Date().toISOString(),
    requestId: event.requestId || event.approval?.requestId || event.approval?.id || null,
    turnId: event.turnId || null,
    approval: event.approval || null
  }

  if (type === 'agent.delta') {
    const text = clipActivityText(event.text)
    return text ? { ...common, kind: 'message', label: 'Agent 回复', text } : null
  }
  if (type === 'agent.plan') {
    const text = clipActivityText(activityText(event.plan) || event.text)
    return text ? { ...common, kind: 'plan', label: '执行计划', text } : null
  }
  if (type === 'agent.diff') {
    const text = clipActivityText(activityText(event.diff) || event.text)
    return text ? { ...common, kind: 'diff', label: '修改摘要', text } : null
  }
  if (type === 'approval.requested') {
    const text = clipActivityText(activityText(event.approval) || event.text || '这一步需要你确认后继续。')
    return { ...common, kind: 'approval', label: '等待确认', text }
  }
  if (type === 'approval.resolved') {
    const text = clipActivityText(event.text || '已记录你的选择。')
    return { ...common, kind: 'status', label: '已确认', text }
  }
  if (type === 'turn.started') {
    return { ...common, kind: 'status', label: 'Codex 开始执行', text: event.text || '正在读取画布上下文…' }
  }
  if (type === 'turn.completed') {
    return { ...common, kind: 'status', label: '任务完成', text: event.text || '结果已返回 Yogurt AI。' }
  }
  if (type === 'turn.failed') {
    return { ...common, kind: 'error', label: '任务失败', text: event.text || '执行中遇到错误。' }
  }
  if (type === 'turn.cancelled' || type === 'task.cancelled') {
    return { ...common, kind: 'status', label: '任务已中断', text: event.text || '已停止当前执行。' }
  }
  return null
}

function activityIcon(kind) {
  if (kind === 'plan') return Workflow
  if (kind === 'diff') return FileText
  if (kind === 'approval' || kind === 'error') return AlertCircle
  if (kind === 'status') return CheckCircle2
  return Bot
}

function approvalRequestIdFromBridgeState(state) {
  return (
    state?.activity?.approval?.requestId ??
    state?.activity?.approval?.id ??
    state?.lastEvent?.requestId ??
    state?.lastEvent?.approval?.requestId ??
    null
  )
}

function elicitationRequestIdFromBridgeState(state) {
  return (
    state?.activity?.elicitation?.requestId ??
    state?.activity?.elicitation?.id ??
    (state?.lastEvent?.type === 'elicitation.requested' ? state.lastEvent.requestId : null) ??
    null
  )
}

export function approvalStatusForRequest(resolution, requestId) {
  if (requestId == null || requestId === '') return 'idle'
  if (resolution?.requestId == null || String(resolution.requestId) !== String(requestId)) {
    return 'idle'
  }
  return resolution.status || 'idle'
}

export function buildAgentPanelMessage(instruction, context = {}) {
  const selectedCount = Number(context.selectedCount) || 0
  const scope = selectedCount > 0 ? `当前选中的 ${selectedCount} 个对象` : '当前页面'
  const selectedShapeIds = Array.isArray(context.selectedShapeIds)
    ? context.selectedShapeIds.slice(0, AGENT_CONTEXT_MAX_SHAPE_IDS)
    : []
  const exactShapeIds = Array.isArray(context.exactShapeIds)
    ? context.exactShapeIds.slice(0, AGENT_CONTEXT_MAX_SHAPE_IDS)
    : []
  const stableContext = {
    pageId: context.pageId || null,
    pageName: context.pageName || '未命名页面',
    scope: selectedCount > 0 ? 'selection' : 'page',
    selectedShapeIds,
    exactShapeIds,
    shapeIdsTruncated:
      context.shapeIdsTruncated === true ||
      selectedShapeIds.length < (context.selectedShapeIds?.length || 0) ||
      exactShapeIds.length < (context.exactShapeIds?.length || 0)
  }
  return {
    prompt: [
      '[@cowart-thinking-canvas](plugin://cowart-thinking-canvas@cowart-thinking-github) Yogurt AI Agent 任务',
      '',
      `项目：${context.projectName || 'Yogurt AI 画布'}`,
      `页面：${context.pageName || '未命名页面'}`,
      `作用范围：${scope}`,
      '',
      '画布上下文（请使用这些稳定 ID，不要依赖截图坐标）：',
      '```json',
      JSON.stringify(stableContext, null, 2),
      '```',
      '',
      '请使用已保存的 Yogurt AI 画布与选区上下文完成以下任务：',
      String(instruction || '').trim()
    ].join('\n')
  }
}

function createTaskId() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `cowart-agent-${Date.now()}-${suffix}`
}

function AgentTaskStatus({ task }) {
  if (!task) {
    return (
      <div className="cowart-agent-empty-task">
        <span className="cowart-agent-empty-task-icon" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <span>从画布选区或当前页面发起一个任务</span>
      </div>
    )
  }

  const presentation = taskStatusPresentation(task.status)
  const { Icon } = presentation
  return (
    <article className="cowart-agent-task" data-tone={presentation.tone}>
      <span className="cowart-agent-task-icon" aria-hidden="true">
        <Icon className={presentation.tone === 'working' ? 'cowart-spin' : undefined} size={15} />
      </span>
      <span className="cowart-agent-task-copy">
        <strong>{taskExcerpt(task.title) || '画布任务'}</strong>
        <small>
          {presentation.label}
          {formatTaskTime(task.startedAt) ? ` · ${formatTaskTime(task.startedAt)}` : ''}
        </small>
      </span>
    </article>
  )
}

function elicitationInputType(format) {
  return {
    email: 'email',
    uri: 'url',
    date: 'date',
    'date-time': 'datetime-local'
  }[format] || 'text'
}

function valueWithField(previous, name, value) {
  const next = { ...previous }
  return setSafeProperty(next, name, value)
}

function ElicitationField({ field, index, value, error, onChange }) {
  const fieldId = `cowart-agent-elicitation-field-${index}`
  const descriptionId = field.description ? `${fieldId}-description` : undefined
  const errorId = error ? `${fieldId}-error` : undefined
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined
  const label = (
    <>
      {field.title}
      {field.required && <span aria-hidden="true"> *</span>}
    </>
  )

  if (field.type === 'array') {
    const selected = Array.isArray(value) ? value : []
    return (
      <fieldset className="cowart-agent-elicitation-field" aria-describedby={describedBy}>
        <legend>{label}</legend>
        {field.description && <small id={descriptionId}>{field.description}</small>}
        <div className="cowart-agent-elicitation-options">
          {field.options.map((option, optionIndex) => {
            const optionId = `${fieldId}-option-${optionIndex}`
            const checked = selected.some((candidate) => Object.is(candidate, option.value))
            return (
              <label htmlFor={optionId} key={optionId}>
                <input
                  checked={checked}
                  id={optionId}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((candidate) => !Object.is(candidate, option.value))
                    onChange(next)
                  }}
                  type="checkbox"
                />
                <span>{option.title}</span>
              </label>
            )
          })}
        </div>
        {error && <small className="cowart-agent-elicitation-error" id={errorId}>{error}</small>}
      </fieldset>
    )
  }

  if (field.type === 'boolean') {
    if (!field.required) {
      return (
        <div className="cowart-agent-elicitation-field">
          <label htmlFor={fieldId}>{label}</label>
          {field.description && <small id={descriptionId}>{field.description}</small>}
          <select
            aria-describedby={describedBy}
            id={fieldId}
            onChange={(event) => {
              onChange(event.target.value === '' ? undefined : event.target.value === 'true')
            }}
            value={typeof value === 'boolean' ? String(value) : ''}
          >
            <option value="">未设置</option>
            <option value="true">是</option>
            <option value="false">否</option>
          </select>
          {error && <small className="cowart-agent-elicitation-error" id={errorId}>{error}</small>}
        </div>
      )
    }
    return (
      <div className="cowart-agent-elicitation-field" data-boolean="true">
        <label htmlFor={fieldId}>
          <input
            aria-describedby={describedBy}
            checked={Boolean(value)}
            id={fieldId}
            onChange={(event) => onChange(event.target.checked)}
            type="checkbox"
          />
          <span>{label}</span>
        </label>
        {field.description && <small id={descriptionId}>{field.description}</small>}
        {error && <small className="cowart-agent-elicitation-error" id={errorId}>{error}</small>}
      </div>
    )
  }

  if (field.options) {
    const selectedIndex = field.options.findIndex((option) => Object.is(option.value, value))
    return (
      <div className="cowart-agent-elicitation-field">
        <label htmlFor={fieldId}>{label}</label>
        {field.description && <small id={descriptionId}>{field.description}</small>}
        <select
          aria-describedby={describedBy}
          id={fieldId}
          onChange={(event) => {
            const nextIndex = Number(event.target.value)
            onChange(Number.isInteger(nextIndex) ? field.options[nextIndex]?.value : undefined)
          }}
          required={field.required}
          value={selectedIndex >= 0 ? String(selectedIndex) : ''}
        >
          <option value="">请选择</option>
          {field.options.map((option, optionIndex) => (
            <option key={`${fieldId}-option-${optionIndex}`} value={String(optionIndex)}>
              {option.title}
            </option>
          ))}
        </select>
        {error && <small className="cowart-agent-elicitation-error" id={errorId}>{error}</small>}
      </div>
    )
  }

  const numeric = field.type === 'number' || field.type === 'integer'
  return (
    <div className="cowart-agent-elicitation-field">
      <label htmlFor={fieldId}>{label}</label>
      {field.description && <small id={descriptionId}>{field.description}</small>}
      <input
        aria-describedby={describedBy}
        id={fieldId}
        max={numeric ? field.maximum : undefined}
        maxLength={!numeric ? field.maxLength : undefined}
        min={numeric ? field.minimum : undefined}
        minLength={!numeric ? field.minLength : undefined}
        onChange={(event) => onChange(event.target.value)}
        required={field.required}
        step={field.type === 'integer' ? 1 : numeric ? 'any' : undefined}
        type={numeric ? 'number' : elicitationInputType(field.format)}
        value={value ?? ''}
      />
      {error && <small className="cowart-agent-elicitation-error" id={errorId}>{error}</small>}
    </div>
  )
}

function ElicitationCard({ request, requestId, responseStatus, onRespond }) {
  const model = useMemo(() => normalizeElicitationRequest(request, requestId), [request, requestId])
  const [values, setValues] = useState(() => createElicitationInitialValues(model))
  const [errors, setErrors] = useState([])
  const isSending = responseStatus === 'sending'

  useEffect(() => {
    setValues(createElicitationInitialValues(model))
    setErrors([])
  }, [model])

  function errorForField(field) {
    return errors.find((error) => error.startsWith(field.title)) || ''
  }

  async function handleFormSubmit(event) {
    event.preventDefault()
    if (!model.supported || isSending) return
    const result = buildElicitationContent(model, values)
    setErrors(result.errors)
    if (!result.valid) return
    await onRespond('accept', result.content)
  }

  const rejectButton = (
    <button disabled={isSending} onClick={() => onRespond('decline', null)} type="button">
      <X aria-hidden="true" size={13} />
      拒绝
    </button>
  )

  return (
    <section
      className="cowart-agent-elicitation"
      aria-labelledby="cowart-agent-elicitation-title"
      data-mode={model.mode}
    >
      <header>
        <span aria-hidden="true"><ShieldAlert size={15} /></span>
        <div>
          <strong id="cowart-agent-elicitation-title">{model.title}</strong>
          {model.message && <p>{model.message}</p>}
        </div>
      </header>

      {model.mode === 'url' && model.supported && (
        <div className="cowart-agent-elicitation-url">
          <span>即将前往外部网站</span>
          <strong>{model.domain}</strong>
          <small>地址会交给桌面应用验证并打开；画布页面不会直接访问该链接。</small>
        </div>
      )}

      {!model.supported && (
        <div className="cowart-agent-elicitation-unsupported" role="alert">
          <strong>此请求无法安全呈现</strong>
          <p>为避免提交错误或不完整的信息，本次只能拒绝。</p>
          <ul>
            {model.unsupportedReasons.slice(0, 6).map((reason, index) => (
              <li key={`${index}:${reason}`}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {model.mode === 'form' && model.supported ? (
        <form onSubmit={handleFormSubmit}>
          <div className="cowart-agent-elicitation-fields">
            {model.fields.map((field, index) => (
              <ElicitationField
                error={errorForField(field)}
                field={field}
                index={index}
                key={`${index}:${field.name}`}
                onChange={(value) => {
                  setValues((previous) => valueWithField(previous, field.name, value))
                  setErrors([])
                }}
                value={ownValue(values, field.name)}
              />
            ))}
          </div>
          {errors.length > 0 && (
            <div className="cowart-agent-elicitation-errors" role="alert">
              {errors.map((error, index) => <p key={`${index}:${error}`}>{error}</p>)}
            </div>
          )}
          <div className="cowart-agent-elicitation-actions">
            {rejectButton}
            <button data-primary="true" disabled={isSending} type="submit">
              {isSending ? <LoaderCircle aria-hidden="true" className="cowart-spin" size={13} /> : <CheckCircle2 aria-hidden="true" size={13} />}
              {isSending ? '正在提交…' : '提交并继续'}
            </button>
          </div>
        </form>
      ) : (
        <div className="cowart-agent-elicitation-actions">
          {rejectButton}
          {model.mode === 'url' && model.supported && (
            <button
              data-primary="true"
              disabled={isSending}
              onClick={() => onRespond('accept', null)}
              type="button"
            >
              {isSending ? <LoaderCircle aria-hidden="true" className="cowart-spin" size={13} /> : <ExternalLink aria-hidden="true" size={13} />}
              {isSending ? '正在打开…' : '打开并继续'}
            </button>
          )}
        </div>
      )}
      {responseStatus === 'error' && (
        <small className="cowart-agent-elicitation-response-error" role="alert">
          提交失败，请检查连接后重试。
        </small>
      )}
    </section>
  )
}

export function CowartAgentPanel({
  beforeSend,
  bridge,
  contextProvider,
  isOpen,
  onOpenChange
}) {
  const [bridgeState, setBridgeState] = useState(() => bridge?.getState?.() ?? EMPTY_BRIDGE_STATE)
  const [context, setContext] = useState(() => readContext(contextProvider))
  const [instruction, setInstruction] = useState('')
  const [localTask, setLocalTask] = useState(null)
  const [activityItems, setActivityItems] = useState([])
  const [approvalResolution, setApprovalResolution] = useState({ requestId: null, status: 'idle' })
  const [elicitationResolution, setElicitationResolution] = useState({ requestId: null, status: 'idle' })
  const [isInterrupting, setIsInterrupting] = useState(false)
  const [isSelectingWorkspace, setIsSelectingWorkspace] = useState(false)
  const [isRefreshingCodex, setIsRefreshingCodex] = useState(false)
  const [isStartingCodexLogin, setIsStartingCodexLogin] = useState(false)
  const [setupNotice, setSetupNotice] = useState('')
  const [sendError, setSendError] = useState('')
  const textAreaRef = useRef(null)

  useEffect(() => {
    if (!bridge) {
      setBridgeState(EMPTY_BRIDGE_STATE)
      return undefined
    }

    function recordActivity(event) {
      const nextItem = normalizeActivityEvent(event)
      if (!nextItem) return
      setActivityItems((items) => {
        const existingIndex = items.findIndex((item) => item.id === nextItem.id)
        if (existingIndex >= 0) {
          return items.map((item, index) => (index === existingIndex ? nextItem : item))
        }
        const lastItem = items.at(-1)
        if (
          nextItem.type === 'agent.delta' &&
          lastItem?.type === 'agent.delta' &&
          lastItem.turnId === nextItem.turnId
        ) {
          const nextText = nextItem.text.startsWith(lastItem.text)
            ? nextItem.text
            : `${lastItem.text}${nextItem.text}`
          return [
            ...items.slice(0, -1),
            { ...nextItem, text: clipActivityText(nextText), id: lastItem.id }
          ]
        }
        return [...items, nextItem].slice(-8)
      })
    }

    const initialState = bridge.getState()
    setBridgeState(initialState)
    recordActivity(initialState.lastEvent)
    const unsubscribe = bridge.subscribe(
      (nextState, event) => {
        setBridgeState(nextState)
        recordActivity(event ?? nextState.lastEvent)
      },
      { emitCurrent: true }
    )
    Promise.resolve(bridge.refreshCapabilities()).catch((error) => {
      console.warn('Yogurt AI could not refresh Agent capabilities.', error)
    })
    return unsubscribe
  }, [bridge])

  useEffect(() => {
    if (!isOpen) return undefined
    let previousKey = ''
    function syncContext() {
      const nextContext = readContext(contextProvider)
      const nextKey = stableContextKey(nextContext)
      if (nextKey === previousKey) return
      previousKey = nextKey
      setContext(nextContext)
    }
    syncContext()
    const interval = window.setInterval(syncContext, 400)
    return () => window.clearInterval(interval)
  }, [contextProvider, isOpen])

  const bridgeTask = bridgeState.lastTask
  const recentTask = useMemo(() => {
    if (!bridgeTask) return localTask
    if (!localTask || bridgeTask.id !== localTask.id) {
      return {
        id: bridgeTask.id,
        title: bridgeTask.metadata?.instruction || '画布任务',
        status: taskStatusFromActivity(
          bridgeState.activity,
          bridgeTask.status,
          bridgeState.capabilities?.streaming
        ),
        startedAt: bridgeTask.startedAt
      }
    }
    return {
      ...localTask,
      status: taskStatusFromActivity(
        bridgeState.activity,
        bridgeTask.status,
        bridgeState.capabilities?.streaming
      ),
      startedAt: bridgeTask.startedAt || localTask.startedAt
    }
  }, [bridgeState.activity, bridgeState.capabilities?.streaming, bridgeTask, localTask])

  const connection = connectionPresentation(bridgeState)
  const desktopSetup = bridgeState.capabilities?.setup ?? null
  const workspaceSetup = desktopSetup?.workspace ?? null
  const codexSetup = desktopSetup?.codex ?? null
  const isAvailable = Boolean(bridgeState.capabilities?.available)
  const activityPhase = bridgeState.activity?.phase || 'idle'
  const approvalRequestId = approvalRequestIdFromBridgeState(bridgeState)
  const approvalStatus = approvalStatusForRequest(approvalResolution, approvalRequestId)
  const pendingElicitation = bridgeState.activity?.elicitation ?? null
  const elicitationRequestId = elicitationRequestIdFromBridgeState(bridgeState)
  const elicitationStatus = approvalStatusForRequest(elicitationResolution, elicitationRequestId)
  const followsAgentActivity = Boolean(
    bridgeState.capabilities?.streaming ||
    bridgeState.capabilities?.approvals ||
    bridgeState.capabilities?.elicitation
  )
  const isSending =
    bridgeState.status === 'sending' ||
    bridgeState.pendingTaskIds?.length > 0 ||
    Boolean(pendingElicitation) ||
    (followsAgentActivity && ['submitting', 'running', 'waiting_approval', 'waiting_elicitation'].includes(activityPhase))
  const selectedCount = Number(context?.selectedCount) || 0
  const pageShapeCount = Number(context?.pageShapeCount) || 0
  const scopeLabel = selectedCount > 0 ? `已选 ${selectedCount} 项` : `页面 ${pageShapeCount} 项`

  const applyQuickTask = useCallback((prompt) => {
    setInstruction(prompt)
    window.requestAnimationFrame(() => textAreaRef.current?.focus())
  }, [])

  async function handleSelectWorkspace() {
    if (typeof bridge?.selectWorkspace !== 'function' || isSelectingWorkspace) return
    setIsSelectingWorkspace(true)
    setSetupNotice('')
    try {
      const result = await bridge.selectWorkspace()
      if (result?.selected) {
        setSetupNotice('工作区已保存，正在重新打开 Yogurt AI…')
      } else if (result?.restarting) {
        setSetupNotice('Yogurt AI 正在重新打开…')
      } else {
        setSetupNotice('没有选择文件夹。你仍可预览画布，稍后再设置。')
      }
      if (!result?.selected) setIsSelectingWorkspace(false)
    } catch (error) {
      console.error(error)
      setSetupNotice(error?.message || '无法选择工作区。')
      setIsSelectingWorkspace(false)
    }
  }

  async function handleRefreshCodex() {
    if (typeof bridge?.refreshCapabilities !== 'function' || isRefreshingCodex) return
    setIsRefreshingCodex(true)
    setSetupNotice('')
    try {
      await bridge.refreshCapabilities()
      setSetupNotice('已重新检测 Codex 状态。')
    } catch (error) {
      console.error(error)
      setSetupNotice(error?.message || 'Codex 状态检测失败。')
    } finally {
      setIsRefreshingCodex(false)
    }
  }

  async function handleStartCodexLogin() {
    if (typeof bridge?.startCodexLogin !== 'function' || isStartingCodexLogin) return
    setIsStartingCodexLogin(true)
    setSetupNotice('')
    try {
      const result = await bridge.startCodexLogin()
      if (result?.alreadyAuthenticated) {
        setSetupNotice('Codex 已登录，正在连接 Agent…')
      } else if (result?.browserOpened) {
        setSetupNotice('登录页已在浏览器打开；授权成功后会自动回到已连接状态。')
      } else {
        setSetupNotice('已发起 Codex 登录，请在浏览器完成授权。')
      }
    } catch (error) {
      console.error(error)
      setSetupNotice(error?.message || '无法打开 Codex 登录页。')
    } finally {
      setIsStartingCodexLogin(false)
    }
  }

  async function handleApproval(decision) {
    const requestId = approvalRequestId
    if (
      requestId == null ||
      requestId === '' ||
      typeof bridge?.respondApproval !== 'function' ||
      approvalStatus === 'sending'
    ) {
      return
    }

    setApprovalResolution({ requestId, status: 'sending' })
    setSendError('')
    try {
      await bridge.respondApproval(requestId, decision)
      setApprovalResolution({ requestId, status: decision })
    } catch (error) {
      console.error(error)
      setApprovalResolution({ requestId, status: 'error' })
      setSendError(error?.message || '无法提交审批结果。')
    }
  }

  async function handleElicitation(action, content) {
    const requestId = elicitationRequestId
    if (
      requestId == null ||
      requestId === '' ||
      typeof bridge?.respondElicitation !== 'function' ||
      elicitationStatus === 'sending'
    ) {
      return
    }

    setElicitationResolution({ requestId, status: 'sending' })
    setSendError('')
    try {
      await bridge.respondElicitation(requestId, { action, content })
      setElicitationResolution({ requestId, status: action })
    } catch (error) {
      console.error(error)
      setElicitationResolution({ requestId, status: 'error' })
      setSendError(error?.message || '无法提交补充信息。')
    }
  }

  async function handleInterrupt() {
    if (typeof bridge?.interrupt !== 'function' || isInterrupting) return
    setIsInterrupting(true)
    setSendError('')
    try {
      await bridge.interrupt()
    } catch (error) {
      console.error(error)
      setSendError(error?.message || '无法中断当前任务。')
    } finally {
      setIsInterrupting(false)
    }
  }

  async function handleSubmit(event) {
    event?.preventDefault()
    const request = instruction.trim()
    if (!request || isSending || !isAvailable || !bridge) return

    setSendError('')
    setActivityItems([])
    setApprovalResolution({ requestId: null, status: 'idle' })
    setElicitationResolution({ requestId: null, status: 'idle' })
    const taskId = createTaskId()
    let taskContext = readContext(contextProvider) ?? context ?? {}
    const startedAt = new Date().toISOString()
    setLocalTask({ id: taskId, title: request, status: 'sending', startedAt })

    try {
      const preparedContext = await beforeSend?.(taskContext)
      if (preparedContext) taskContext = preparedContext
      await bridge.sendTask(buildAgentPanelMessage(request, taskContext), {
        taskId,
        metadata: {
          source: 'cowart-agent-panel',
          instruction: request,
          projectName: taskContext.projectName || null,
          pageId: taskContext.pageId || null,
          pageName: taskContext.pageName || null,
          selectedCount: Number(taskContext.selectedCount) || 0
        },
        analyticsContext: {
          promptType: 'other',
          hasReference: Number(taskContext.selectedCount) > 0
        }
      })
      setLocalTask((task) => (task?.id === taskId ? { ...task, status: 'sent' } : task))
      setInstruction('')
    } catch (error) {
      console.error(error)
      setLocalTask((task) => (task?.id === taskId ? { ...task, status: 'error' } : task))
      setSendError(error?.message || '无法发送任务，请稍后重试。')
    }
  }

  if (!isOpen) {
    return (
      <button
        aria-label="打开 Codex Agent 面板"
        className="cowart-agent-panel-launcher"
        onClick={() => onOpenChange(true)}
        title="打开 Codex Agent"
        type="button"
      >
        <Bot aria-hidden="true" size={19} />
        <span>Agent</span>
        <ChevronRight aria-hidden="true" size={15} />
      </button>
    )
  }

  return (
    <aside className="cowart-agent-panel" aria-label="Codex Agent 工作台">
      <header className="cowart-agent-panel-header">
        <span className="cowart-agent-avatar" aria-hidden="true">
          <Bot size={19} />
        </span>
        <span className="cowart-agent-heading">
          <strong>Codex Agent</strong>
          <small>画布任务工作台</small>
        </span>
        <span className="cowart-agent-connection" data-tone={connection.tone} aria-live="polite">
          <i aria-hidden="true" />
          {connection.label}
        </span>
        <button
          aria-label="收起 Codex Agent 面板"
          className="cowart-agent-close"
          onClick={() => onOpenChange(false)}
          title="收起面板"
          type="button"
        >
          <PanelRightClose aria-hidden="true" size={18} />
        </button>
      </header>

      <div className="cowart-agent-panel-body">
        {workspaceSetup?.status === 'required' && (
          <section className="cowart-agent-setup-card" data-kind="workspace" aria-labelledby="cowart-agent-setup-title">
            <span className="cowart-agent-setup-icon" aria-hidden="true">
              <FolderOpen size={19} />
            </span>
            <div>
              <strong id="cowart-agent-setup-title">先选择一个工作区</strong>
              <p>画布和生成文件会保存在你选择的文件夹中，Yogurt AI 不再依赖启动位置。</p>
              <button disabled={isSelectingWorkspace} onClick={handleSelectWorkspace} type="button">
                <FolderOpen aria-hidden="true" size={14} />
                {isSelectingWorkspace ? '正在打开…' : '选择文件夹'}
              </button>
            </div>
          </section>
        )}

        {workspaceSetup?.status === 'ready' && codexSetup && codexSetup.status !== 'ready' && (
          <section className="cowart-agent-setup-card" data-kind="codex" aria-labelledby="cowart-agent-codex-setup-title">
            <span className="cowart-agent-setup-icon" aria-hidden="true">
              {['starting', 'login-pending'].includes(codexSetup.status) ? (
                <LoaderCircle className="cowart-spin" size={19} />
              ) : (
                <Terminal size={19} />
              )}
            </span>
            <div>
              <strong id="cowart-agent-codex-setup-title">{codexSetup.title || '连接 Codex'}</strong>
              <p>{codexSetup.message || '完成 Codex 设置后即可从画布发送任务。'}</p>
              {codexSetup.command && <code>{codexSetup.command}</code>}
              {codexSetup.canLogin && ['login-required', 'login-pending'].includes(codexSetup.status) ? (
                <button
                  disabled={isStartingCodexLogin}
                  onClick={handleStartCodexLogin}
                  type="button"
                >
                  {isStartingCodexLogin ? (
                    <LoaderCircle aria-hidden="true" className="cowart-spin" size={14} />
                  ) : (
                    <LogIn aria-hidden="true" size={14} />
                  )}
                  {codexLoginButtonLabel(codexSetup.status, isStartingCodexLogin)}
                </button>
              ) : codexSetup.status !== 'starting' && (
                <button disabled={isRefreshingCodex} onClick={handleRefreshCodex} type="button">
                  <RefreshCw
                    aria-hidden="true"
                    className={isRefreshingCodex ? 'cowart-spin' : undefined}
                    size={14}
                  />
                  {isRefreshingCodex ? '正在检测…' : '重新检测'}
                </button>
              )}
            </div>
          </section>
        )}

        {setupNotice && (
          <p className="cowart-agent-setup-notice" role="status">{setupNotice}</p>
        )}

        <section className="cowart-agent-context-card" aria-labelledby="cowart-agent-context-title">
          <div className="cowart-agent-section-heading">
            <span id="cowart-agent-context-title">项目上下文</span>
            <span className="cowart-agent-context-actions">
              {workspaceSetup?.status === 'ready' && typeof bridge?.selectWorkspace === 'function' && (
                <button
                  disabled={isSelectingWorkspace}
                  onClick={handleSelectWorkspace}
                  title="更换工作区并重新打开应用"
                  type="button"
                >
                  <FolderOpen aria-hidden="true" size={12} />
                  更换
                </button>
              )}
              <span className="cowart-agent-scope-chip" data-selection={selectedCount > 0 ? 'true' : 'false'}>
                {scopeLabel}
              </span>
            </span>
          </div>
          <strong className="cowart-agent-project-name">
            {context?.projectName || 'Yogurt AI 画布'}
          </strong>
          <span className="cowart-agent-page-name">
            <span aria-hidden="true">当前页</span>
            <b>{context?.pageName || '未命名页面'}</b>
          </span>
          <p>
            {selectedCount > 0
              ? 'Agent 会优先使用已选对象，同时保留它们在页面中的关系。'
              : '未选中对象，Agent 将以当前页面作为工作范围。'}
          </p>
        </section>

        <section className="cowart-agent-quick-section" aria-labelledby="cowart-agent-quick-title">
          <div className="cowart-agent-section-heading">
            <span id="cowart-agent-quick-title">快捷任务</span>
          </div>
          <div className="cowart-agent-quick-grid">
            {QUICK_TASKS.map(({ icon: Icon, label, prompt }) => (
              <button key={label} onClick={() => applyQuickTask(prompt)} type="button">
                <Icon aria-hidden="true" size={15} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="cowart-agent-recent" aria-labelledby="cowart-agent-recent-title">
          <div className="cowart-agent-section-heading">
            <span id="cowart-agent-recent-title">最近任务</span>
          </div>
          <AgentTaskStatus task={recentTask} />
        </section>

        {(activityItems.length > 0 || pendingElicitation || (followsAgentActivity && activityPhase !== 'idle')) && (
          <section className="cowart-agent-activity" aria-labelledby="cowart-agent-activity-title">
            <div className="cowart-agent-section-heading">
              <span id="cowart-agent-activity-title">Agent 动态</span>
              {isSending &&
                bridgeState.capabilities?.interrupt &&
                typeof bridge?.interrupt === 'function' && (
                  <button
                    className="cowart-agent-interrupt"
                    disabled={isInterrupting}
                    onClick={handleInterrupt}
                    type="button"
                  >
                    <Square aria-hidden="true" size={10} />
                    {isInterrupting ? '正在中断' : '中断'}
                  </button>
                )}
            </div>
            <div className="cowart-agent-activity-list" aria-live="polite">
              {activityItems.length > 0 ? (
                activityItems.slice(-5).map((item) => {
                  const Icon = activityIcon(item.kind)
                  return (
                    <article key={item.id} className="cowart-agent-activity-item" data-kind={item.kind}>
                      <span aria-hidden="true">
                        <Icon size={14} />
                      </span>
                      <div>
                        <strong>{item.label}</strong>
                        <p>{item.text}</p>
                      </div>
                    </article>
                  )
                })
              ) : (
                <div className="cowart-agent-activity-waiting">
                  <LoaderCircle aria-hidden="true" className="cowart-spin" size={14} />
                  <span>{bridgeState.activity?.message || 'Codex 正在处理画布任务…'}</span>
                </div>
              )}
            </div>
            {activityPhase === 'waiting_approval' && bridgeState.activity?.approval && (
              <div className="cowart-agent-approval">
                <strong>需要你确认</strong>
                <p>
                  {activityText(bridgeState.activity.approval) ||
                    '这一步可能会修改画布或项目文件。'}
                </p>
                {typeof bridge?.respondApproval === 'function' && approvalStatus === 'idle' && (
                  <div>
                    <button onClick={() => handleApproval('decline')} type="button">
                      <X aria-hidden="true" size={13} />
                      拒绝
                    </button>
                    <button data-primary="true" onClick={() => handleApproval('accept')} type="button">
                      <CheckCircle2 aria-hidden="true" size={13} />
                      允许
                    </button>
                  </div>
                )}
                {approvalStatus !== 'idle' && (
                  <small aria-live="polite">
                    {approvalStatus === 'sending'
                      ? '正在提交…'
                      : approvalStatus === 'accept'
                        ? '已允许，Codex 将继续执行。'
                        : approvalStatus === 'decline'
                          ? '已拒绝这一步。'
                          : '提交失败，请重试。'}
                  </small>
                )}
              </div>
            )}
            {pendingElicitation && elicitationRequestId != null && (
              <ElicitationCard
                key={String(elicitationRequestId)}
                onRespond={handleElicitation}
                request={pendingElicitation}
                requestId={elicitationRequestId}
                responseStatus={elicitationStatus}
              />
            )}
          </section>
        )}
      </div>

      <form className="cowart-agent-composer" onSubmit={handleSubmit}>
        <label htmlFor="cowart-agent-instruction">告诉 Agent 你想完成什么</label>
        <textarea
          ref={textAreaRef}
          id="cowart-agent-instruction"
          aria-describedby={sendError ? 'cowart-agent-send-error' : undefined}
          disabled={isSending}
          maxLength={2400}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={
            isAvailable
              ? '例如：把这些想法整理成产品结构并补齐缺口…'
              : workspaceSetup?.status === 'required'
                ? '选择工作区后即可连接 Codex Agent'
                : '按上方提示完成 Codex 设置'
          }
          rows={4}
          value={instruction}
        />
        {sendError && (
          <p className="cowart-agent-send-error" id="cowart-agent-send-error" role="alert">
            <AlertCircle aria-hidden="true" size={14} />
            <span>{sendError}</span>
          </p>
        )}
        {!isAvailable && !sendError && (
          <p className="cowart-agent-offline-note">
            {codexSetup?.message || '连接 Codex Agent 后，这里会直接发送画布任务。'}
          </p>
        )}
        <div className="cowart-agent-composer-footer">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <button
            aria-label={isSending ? '正在发送任务' : '发送给 Codex Agent'}
            disabled={!instruction.trim() || isSending || !isAvailable}
            type="submit"
          >
            {isSending ? (
              <LoaderCircle aria-hidden="true" className="cowart-spin" size={16} />
            ) : (
              <Send aria-hidden="true" size={16} />
            )}
            <span>{isSending ? '发送中' : '发送'}</span>
          </button>
        </div>
      </form>
    </aside>
  )
}
