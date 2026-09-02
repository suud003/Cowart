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
  Zap,
  X,
  Workflow
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  SEMANTIC_DIAGRAM_QUICK_PROMPT,
  SEMANTIC_DIAGRAM_ROUTING_HINT
} from './semanticDiagramPrompt.js'

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
export const AGENT_ACTIVITY_MAX_ITEMS = 80
export const AGENT_ACTIVITY_MAX_EVENT_IDS = 4_096
export const AGENT_CONVERSATION_MAX_TURNS = 20
export const AGENT_EXECUTION_MODE_STORAGE_KEY = 'yogurt-agent-execution-mode-v1'

export function normalizeAgentExecutionMode(value) {
  return value === 'autonomous' ? 'autonomous' : 'guided'
}

export function agentExecutionModeStorageKey(projectName) {
  const scope = String(projectName || 'default').trim() || 'default'
  return `${AGENT_EXECUTION_MODE_STORAGE_KEY}:${encodeURIComponent(scope)}`
}

export function agentExecutionModeScope(context = {}) {
  return String(context?.projectScopeId || context?.projectName || 'default').trim() || 'default'
}

export function resolveAgentExecutionModeForTask({
  currentMode,
  currentProjectScope,
  taskContext,
  storage = globalThis.window?.localStorage
} = {}) {
  const taskProjectScope = agentExecutionModeScope(taskContext)
  if (taskProjectScope !== currentProjectScope) {
    return readAgentExecutionMode(storage, taskProjectScope)
  }
  return normalizeAgentExecutionMode(currentMode)
}

export function readAgentExecutionMode(storage = globalThis.window?.localStorage, projectName) {
  try {
    const stored = storage?.getItem?.(agentExecutionModeStorageKey(projectName))
    return stored === null || stored === undefined
      ? 'autonomous'
      : normalizeAgentExecutionMode(stored)
  } catch {
    return 'autonomous'
  }
}

export function persistAgentExecutionMode(mode, storage = globalThis.window?.localStorage, projectName) {
  const normalized = normalizeAgentExecutionMode(mode)
  try {
    storage?.setItem?.(agentExecutionModeStorageKey(projectName), normalized)
  } catch {
    // Storage is a convenience. The in-memory execution choice still applies.
  }
  return normalized
}

export function agentExecutionInstructions(mode) {
  if (normalizeAgentExecutionMode(mode) === 'guided') {
    return [
      '执行方式：分步确认。',
      '- 直接完成原生可编辑图的上下文读取、语义规划、dry-run 与安全写入；不要生成视觉预演，也不要为普通布局、配色或可合理默认的信息暂停。',
      '- 只有语义歧义会实质改变结果，或任务涉及删除用户内容、外部访问、项目外写入、凭据、付费等受保护操作时才询问。',
      '- 不要创建图片、PRD、HTML、SVG 或 Slides。'
    ].join('\n')
  }
  return [
    '执行方式：自动执行（用户已在 Yogurt AI 面板明确开启）。',
    '- 对当前工作区内的上下文读取、语义规划、html-line-svg 布局验证与原生可逆画布写入连续执行；不要为普通布局选择或可合理默认的信息发起补充点击。',
    '- 只生成原生可编辑卡片、分区、文字与绑定箭头；不要创建视觉预演、图片、PRD、HTML、SVG 或 Slides。',
    '- 信息不完整时采用最小、可逆且不改变核心意图的合理假设，并在最终结果中列出；只有缺失信息会导致越权、不可逆结果或使结果发生实质变化时才询问。',
    '- 不要请求交互式审批或表单。超出工作区权限、外部授权、凭据、付费或删除用户内容的动作应安全停止，并说明未执行的部分。'
  ].join('\n')
}

const AGENT_TURN_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const AGENT_TURN_EVENTS_ABSORBED_AFTER_TERMINAL = new Set([
  'turn.started',
  'agent.delta',
  'agent.plan',
  'agent.diff',
  'approval.requested',
  'approval.resolved',
  'elicitation.requested',
  'elicitation.resolved'
])

const DEFAULT_TERMINAL_ACTIVITY_TEXT = new Set([
  '结果已返回 Yogurt AI。',
  '执行中遇到错误。',
  '已停止当前执行。'
])

const QUICK_TASKS = [
  {
    id: 'editable-diagram',
    icon: Workflow,
    kind: 'editable-diagram',
    label: '生成可编辑图',
    description: '官方 Excalidraw 原生元素',
    prompt: SEMANTIC_DIAGRAM_QUICK_PROMPT
  }
]

function stableContextKey(context) {
  return JSON.stringify([
    context?.projectScopeId,
    context?.projectName,
    context?.canvasId,
    context?.canvasName,
    context?.parentCanvasId,
    context?.projectRevision,
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
  if (['waiting_approval', 'waiting_elicitation'].includes(state?.activity?.phase)) {
    return { label: '等待你', tone: 'attention' }
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

function normalizeActivityText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
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

export function normalizeActivityEvent(event) {
  if (!event || typeof event !== 'object') return null
  const type = String(event.type || '')
  const eventIdentity = event.itemId || event.requestId || event.turnId || ''
  const common = {
    id: event.eventId || `${type}:${eventIdentity}:${event.at || ''}`,
    sourceEventId: event.eventId || null,
    sourceEventIds: event.eventId ? [event.eventId] : [],
    type,
    at: event.at || new Date().toISOString(),
    requestId: event.requestId || event.approval?.requestId || event.approval?.id || null,
    turnId: event.turnId || null,
    itemId: event.itemId || null,
    approval: event.approval || null
  }

  if (type === 'agent.delta') {
    const text = normalizeActivityText(event.text)
    return text.length > 0 ? { ...common, kind: 'message', label: 'Codex Agent', metaLabel: '回复', text } : null
  }
  if (type === 'agent.plan') {
    const text = normalizeActivityText(activityText(event.plan) || event.text)
    return text.trim() ? { ...common, kind: 'plan', label: '执行计划', metaLabel: '计划', text } : null
  }
  if (type === 'agent.diff') {
    const text = normalizeActivityText(activityText(event.diff) || event.text)
    return text.trim() ? { ...common, kind: 'diff', label: '修改摘要', metaLabel: '变更', text } : null
  }
  if (type === 'approval.requested') {
    const text = normalizeActivityText(activityText(event.approval) || event.text || '这一步需要你确认后继续。')
    return { ...common, kind: 'approval', label: '等待确认', metaLabel: '需要你', text }
  }
  if (type === 'approval.resolved') {
    const text = normalizeActivityText(event.text || '已记录你的选择。')
    return { ...common, kind: 'complete', label: '已确认', metaLabel: '状态', text }
  }
  if (type === 'turn.started') {
    return { ...common, kind: 'progress', label: 'Codex 开始执行', metaLabel: '进度', text: event.text || '正在读取画布上下文…' }
  }
  if (type === 'turn.retrying') {
    return { ...common, kind: 'progress', label: '连接波动，正在恢复', metaLabel: '重试中', text: event.text || 'Agent 正在恢复响应流，任务仍会继续。' }
  }
  if (type === 'turn.warning') {
    return { ...common, kind: 'progress', label: '执行提示', metaLabel: '继续执行', text: event.text || 'Agent 遇到临时问题，正在继续。' }
  }
  if (type === 'turn.completed') {
    return { ...common, kind: 'complete', label: '任务完成', metaLabel: '已完成', text: event.text || '结果已返回 Yogurt AI。' }
  }
  if (type === 'turn.failed') {
    return { ...common, kind: 'error', label: '任务失败', metaLabel: '需要检查', text: event.text || '执行中遇到错误。' }
  }
  if (type === 'turn.cancelled' || type === 'task.cancelled') {
    return { ...common, kind: 'complete', label: '任务已中断', metaLabel: '已停止', text: event.text || '已停止当前执行。' }
  }
  return null
}

function activityIcon(kind) {
  if (kind === 'plan') return Workflow
  if (kind === 'diff') return FileText
  if (kind === 'approval' || kind === 'error') return AlertCircle
  if (kind === 'progress') return LoaderCircle
  if (kind === 'complete') return CheckCircle2
  return Bot
}

function AgentActivityItem({ item }) {
  const Icon = activityIcon(item.kind)
  return (
    <article
      aria-label={`${item.label}：${item.metaLabel || '动态'}`}
      className="cowart-agent-activity-item"
      data-kind={item.kind}
    >
      <span aria-hidden="true">
        <Icon className={item.kind === 'progress' ? 'cowart-spin' : undefined} size={15} />
      </span>
      <div className="cowart-agent-activity-copy">
        <header>
          <strong>{item.label}</strong>
          <small>{item.metaLabel || '动态'}</small>
        </header>
        <p>{item.text}</p>
      </div>
    </article>
  )
}

export function mergeAgentActivityItems(items, nextItem) {
  const currentItems = Array.isArray(items) ? items : []
  if (!nextItem) return currentItems.slice(-AGENT_ACTIVITY_MAX_ITEMS)
  const nextSourceEventIds = Array.from(new Set([
    ...(Array.isArray(nextItem.sourceEventIds) ? nextItem.sourceEventIds : []),
    ...(nextItem.sourceEventId ? [nextItem.sourceEventId] : [])
  ]))
  if (
    nextSourceEventIds.length > 0 &&
    currentItems.some((item) => {
      const seen = Array.isArray(item.sourceEventIds) ? item.sourceEventIds : []
      return nextSourceEventIds.some((eventId) => (
        item.sourceEventId === eventId || seen.includes(eventId)
      ))
    })
  ) {
    return currentItems.slice(-AGENT_ACTIVITY_MAX_ITEMS)
  }
  const lastItem = currentItems.at(-1)
  const sameDeltaStream = (
    nextItem.type === 'agent.delta' &&
    lastItem?.type === 'agent.delta' &&
    lastItem.turnId === nextItem.turnId &&
    (lastItem.itemId || null) === (nextItem.itemId || null)
  )
  if (
    sameDeltaStream
  ) {
    const nextText = `${lastItem.text}${nextItem.text}`
    return [
      ...currentItems.slice(0, -1),
      {
        ...nextItem,
        text: normalizeActivityText(nextText),
        id: lastItem.id,
        sourceEventIds: Array.from(new Set([
          ...(Array.isArray(lastItem.sourceEventIds) ? lastItem.sourceEventIds : []),
          ...(lastItem.sourceEventId ? [lastItem.sourceEventId] : []),
          ...nextSourceEventIds
        ])).slice(-AGENT_ACTIVITY_MAX_EVENT_IDS)
      }
    ].slice(-AGENT_ACTIVITY_MAX_ITEMS)
  }
  const existingIndex = currentItems.findIndex((item) => item.id === nextItem.id)
  if (existingIndex >= 0) {
    return currentItems
      .map((item, index) => (index === existingIndex ? nextItem : item))
      .slice(-AGENT_ACTIVITY_MAX_ITEMS)
  }
  return [...currentItems, nextItem].slice(-AGENT_ACTIVITY_MAX_ITEMS)
}

function idText(value) {
  return value == null || value === '' ? null : String(value)
}

function taskFromConversationEvent(event) {
  return event?.task && typeof event.task === 'object' ? event.task : null
}

function taskIdFromConversationEvent(event) {
  const task = taskFromConversationEvent(event)
  return idText(event?.taskId ?? task?.id ?? task?.taskId)
}

function threadIdFromConversationEvent(event) {
  const task = taskFromConversationEvent(event)
  return idText(event?.threadId ?? task?.threadId)
}

function turnIdFromConversationEvent(event) {
  const task = taskFromConversationEvent(event)
  return idText(event?.turnId ?? task?.turnId)
}

function conversationRequestKey(event) {
  const type = String(event?.type || '')
  const family = type.startsWith('elicitation.')
    ? 'elicitation'
    : type.startsWith('approval.')
      ? 'approval'
      : null
  if (!family) return null
  const requestId = idText(
    event?.requestId ??
      event?.approval?.requestId ??
      event?.approval?.id ??
      event?.elicitation?.requestId ??
      event?.elicitation?.id
  )
  return requestId ? `${family}:${requestId}` : null
}

function isConversationEvent(event) {
  const type = String(event?.type || '')
  return (
    type === 'task.restored' ||
    type.startsWith('task.') ||
    type.startsWith('turn.') ||
    type.startsWith('agent.') ||
    type.startsWith('approval.') ||
    type.startsWith('elicitation.')
  )
}

function isTerminalTurnStatus(status) {
  return AGENT_TURN_TERMINAL_STATUSES.has(status)
}

function conversationStatusFromTask(status) {
  const normalized = String(status || '').toLowerCase()
  if (['succeeded', 'completed', 'complete'].includes(normalized)) return 'completed'
  if (['failed', 'error'].includes(normalized)) return 'failed'
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled'
  if (['accepted', 'sent', 'running'].includes(normalized)) return 'running'
  if (['sending', 'pending', 'submitting'].includes(normalized)) return 'submitting'
  return null
}

function terminalStatusFromConversationEvent(event) {
  const taskStatus = conversationStatusFromTask(taskFromConversationEvent(event)?.status)
  if (isTerminalTurnStatus(taskStatus)) return taskStatus
  if (event?.type === 'turn.completed') return 'completed'
  if (event?.type === 'turn.failed' || event?.type === 'task.failed') return 'failed'
  if (event?.type === 'turn.cancelled' || event?.type === 'task.cancelled') return 'cancelled'
  return null
}

function conversationStatusFromEvent(event, currentStatus = 'submitting') {
  if (isTerminalTurnStatus(currentStatus)) return currentStatus
  const taskStatus = conversationStatusFromTask(taskFromConversationEvent(event)?.status)
  if (taskStatus) return taskStatus
  switch (event?.type) {
    case 'task.started':
      return 'submitting'
    case 'task.accepted':
    case 'task.restored':
    case 'turn.started':
    case 'agent.delta':
    case 'agent.plan':
    case 'agent.diff':
    case 'approval.resolved':
    case 'elicitation.resolved':
      return 'running'
    case 'turn.retrying':
      return 'retrying'
    case 'turn.warning':
      return 'running'
    case 'approval.requested':
      return 'waiting_approval'
    case 'elicitation.requested':
      return 'waiting_input'
    case 'turn.completed':
      return 'completed'
    case 'task.failed':
    case 'turn.failed':
      return 'failed'
    case 'task.cancelled':
    case 'turn.cancelled':
      return 'cancelled'
    default:
      return currentStatus
  }
}

function userTextFromConversationEvent(event) {
  const task = taskFromConversationEvent(event)
  const metadata = task?.metadata ?? event?.metadata ?? null
  return normalizeActivityText(
    metadata?.userText ??
      (metadata?.visibility === 'user-authored' ? metadata?.instruction : '')
  ).trim()
}

function invocationFromConversationEvent(event) {
  const task = taskFromConversationEvent(event)
  const invocation = task?.metadata?.invocation ?? event?.metadata?.invocation
  if (!invocation || typeof invocation !== 'object') return null
  const id = String(invocation.id || '').trim()
  const label = String(invocation.label || '').trim()
  return id && label ? { id, label } : null
}

function conversationErrorItem(event) {
  if (!['task.failed', 'turn.failed'].includes(event?.type)) return null
  const task = taskFromConversationEvent(event)
  const message = normalizeActivityText(
    event?.error?.message ?? task?.error?.message ?? event?.text ?? '执行中遇到错误。'
  ).trim()
  return {
    id: event?.eventId || `${event?.type}:${taskIdFromConversationEvent(event) || turnIdFromConversationEvent(event) || event?.at || ''}`,
    sourceEventId: event?.eventId || null,
    sourceEventIds: event?.eventId ? [event.eventId] : [],
    type: event?.type,
    kind: 'error',
    label: '任务失败',
    metaLabel: '需要检查',
    text: message,
    at: event?.at || task?.finishedAt || new Date().toISOString(),
    turnId: turnIdFromConversationEvent(event),
    itemId: null
  }
}

function mergeConversationTurnItem(items, nextItem) {
  if (!nextItem) return Array.isArray(items) ? items.slice(-AGENT_ACTIVITY_MAX_ITEMS) : []
  const currentItems = Array.isArray(items) ? items : []
  if (['agent.plan', 'agent.diff'].includes(nextItem.type)) {
    return [...currentItems.filter((item) => item.type !== nextItem.type), nextItem]
      .slice(-AGENT_ACTIVITY_MAX_ITEMS)
  }
  if (nextItem.type === 'turn.started') {
    return [...currentItems.filter((item) => item.type !== 'turn.started'), nextItem]
      .slice(-AGENT_ACTIVITY_MAX_ITEMS)
  }
  if (['turn.completed', 'turn.failed', 'turn.cancelled', 'task.failed', 'task.cancelled'].includes(nextItem.type)) {
    return [
      ...currentItems.filter((item) => ![
        'turn.completed',
        'turn.failed',
        'turn.cancelled',
        'task.failed',
        'task.cancelled'
      ].includes(item.type)),
      nextItem
    ].slice(-AGENT_ACTIVITY_MAX_ITEMS)
  }
  return mergeAgentActivityItems(currentItems, nextItem)
}

function newConversationTurn(event, index) {
  const task = taskFromConversationEvent(event)
  const taskId = taskIdFromConversationEvent(event)
  const threadId = threadIdFromConversationEvent(event)
  const turnId = turnIdFromConversationEvent(event)
  const requestKey = conversationRequestKey(event)
  const fallbackKey = `${String(event?.type || 'event')}:${event?.at || index}`
  return {
    key: taskId ? `task:${taskId}` : turnId ? `turn:${turnId}` : requestKey || fallbackKey,
    taskId,
    threadId,
    turnId,
    userText: userTextFromConversationEvent(event),
    invocation: invocationFromConversationEvent(event),
    startedAt: event?.at || task?.startedAt || new Date().toISOString(),
    finishedAt: task?.finishedAt || null,
    status: conversationStatusFromEvent(event),
    items: [],
    requestKeys: requestKey ? [requestKey] : [],
    seenEventIds: []
  }
}

function findConversationTurnIndex(turns, event) {
  const taskId = taskIdFromConversationEvent(event)
  const turnId = turnIdFromConversationEvent(event)
  const threadId = threadIdFromConversationEvent(event)
  const requestKey = conversationRequestKey(event)
  if (taskId) {
    const index = turns.findIndex((turn) => turn.taskId === taskId)
    if (index >= 0) return index
  }
  if (turnId) {
    const index = turns.findIndex((turn) => turn.turnId === turnId)
    if (index >= 0) return index
  }
  if (requestKey) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (!isTerminalTurnStatus(turns[index].status) && turns[index].requestKeys.includes(requestKey)) return index
    }
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index].requestKeys.includes(requestKey)) return index
    }
    if (String(event?.type || '').endsWith('.resolved')) return -1
  }

  const activeTurns = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => !isTerminalTurnStatus(turn.status))
  if (threadId) {
    const sameThread = activeTurns.filter(({ turn }) => turn.threadId === threadId)
    if (sameThread.length === 1) return sameThread[0].index
    const unbound = activeTurns.filter(({ turn }) => !turn.threadId)
    if (sameThread.length === 0 && unbound.length === 1) return unbound[0].index
  }
  if (turnId) {
    const unbound = activeTurns.filter(({ turn }) => !turn.turnId)
    if (unbound.length === 1) return unbound[0].index
    return -1
  }
  if (activeTurns.length === 1 && !String(event?.type || '').startsWith('task.')) {
    return activeTurns[0].index
  }
  return -1
}

export function createAgentConversationState() {
  return { turns: [] }
}

export function reduceAgentConversation(state = createAgentConversationState(), event) {
  if (event?.type === 'conversation.reset') {
    return restoreAgentConversationState(event.bridgeState)
  }
  if (!isConversationEvent(event)) return state

  const turns = Array.isArray(state?.turns) ? state.turns : []
  let turnIndex = findConversationTurnIndex(turns, event)
  if (turnIndex < 0 && String(event?.type || '').endsWith('.resolved')) return state
  let turn = turnIndex >= 0 ? turns[turnIndex] : newConversationTurn(event, turns.length)
  const eventId = idText(event?.eventId)
  if (eventId && turn.seenEventIds.includes(eventId)) return state
  if (
    isTerminalTurnStatus(turn.status) &&
    AGENT_TURN_EVENTS_ABSORBED_AFTER_TERMINAL.has(String(event?.type || ''))
  ) {
    return state
  }
  const incomingTerminalStatus = terminalStatusFromConversationEvent(event)
  if (
    isTerminalTurnStatus(turn.status) &&
    incomingTerminalStatus &&
    incomingTerminalStatus !== turn.status
  ) {
    return state
  }

  const task = taskFromConversationEvent(event)
  const requestKey = conversationRequestKey(event)
  const nextItem = conversationErrorItem(event) || normalizeActivityEvent(event)
  const nextTurn = {
    ...turn,
    taskId: turn.taskId || taskIdFromConversationEvent(event),
    threadId: turn.threadId || threadIdFromConversationEvent(event),
    turnId: turn.turnId || turnIdFromConversationEvent(event),
    userText: turn.userText || userTextFromConversationEvent(event),
    invocation: turn.invocation || invocationFromConversationEvent(event),
    startedAt: turn.startedAt || event?.at || task?.startedAt || null,
    finishedAt: task?.finishedAt || (
      ['turn.completed', 'turn.failed', 'turn.cancelled', 'task.failed', 'task.cancelled'].includes(event?.type)
        ? event?.at || turn.finishedAt
        : turn.finishedAt
    ),
    status: conversationStatusFromEvent(event, turn.status),
    items: mergeConversationTurnItem(turn.items, nextItem),
    requestKeys: requestKey && !turn.requestKeys.includes(requestKey)
      ? [...turn.requestKeys, requestKey]
      : turn.requestKeys,
    seenEventIds: eventId
      ? [...turn.seenEventIds, eventId].slice(-AGENT_ACTIVITY_MAX_EVENT_IDS)
      : turn.seenEventIds
  }

  const nextTurns = turnIndex >= 0
    ? turns.map((candidate, index) => (index === turnIndex ? nextTurn : candidate))
    : [...turns, nextTurn]
  return { turns: nextTurns.slice(-AGENT_CONVERSATION_MAX_TURNS) }
}

export function restoreAgentConversationState(bridgeState) {
  let state = createAgentConversationState()
  if (bridgeState?.lastTask) {
    state = reduceAgentConversation(state, {
      type: 'task.restored',
      task: bridgeState.lastTask,
      at: bridgeState.lastTask.startedAt || bridgeState.lastTask.finishedAt || new Date().toISOString()
    })
  }
  if (bridgeState?.lastEvent) {
    state = reduceAgentConversation(state, bridgeState.lastEvent)
  }
  return state
}

export function conversationTurnParts(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : []
  const messageItems = items.filter((item) => item.kind === 'message' && item.text)
  const terminalResultItem = items
    .filter((item) => item.type === 'turn.completed' && item.text && !DEFAULT_TERMINAL_ACTIVITY_TEXT.has(item.text))
    .at(-1) || null
  const traceItems = items.filter((item) => ['plan', 'progress'].includes(item.kind))
  const changeItem = items.filter((item) => item.kind === 'diff' && item.text).at(-1) || null
  const errorItem = items.filter((item) => item.kind === 'error' && item.text).at(-1) || null
  return {
    assistantText: messageItems.length > 0
      ? messageItems.map((item) => item.text.trim()).filter(Boolean).join('\n\n')
      : terminalResultItem?.text || '',
    traceItems,
    changeText: changeItem?.text || '',
    errorText: errorItem?.text || ''
  }
}

function conversationStatusPresentation(status) {
  if (status === 'completed') return { label: '已完成', tone: 'success', Icon: CheckCircle2 }
  if (status === 'failed') return { label: '执行失败', tone: 'error', Icon: AlertCircle }
  if (status === 'cancelled') return { label: '已停止', tone: 'idle', Icon: Square }
  if (status === 'waiting_approval' || status === 'waiting_input') {
    return { label: '等待你的操作', tone: 'attention', Icon: AlertCircle }
  }
  if (status === 'submitting') return { label: '正在准备', tone: 'working', Icon: LoaderCircle }
  if (status === 'retrying') return { label: '正在重连', tone: 'working', Icon: LoaderCircle }
  return { label: '正在执行', tone: 'working', Icon: LoaderCircle }
}

function AgentExecutionTrace({ status, traceItems }) {
  const active = !isTerminalTurnStatus(status)
  const count = traceItems.length
  const summary = active
    ? count > 0 ? `正在执行 · ${count} 条进度` : '正在读取画布与任务上下文'
    : count > 0 ? `执行过程 · ${count} 条记录` : '执行过程'
  return (
    <details className="cowart-agent-trace" open={active || undefined}>
      <summary>
        {active ? (
          <LoaderCircle aria-hidden="true" className="cowart-spin" size={13} />
        ) : (
          <CheckCircle2 aria-hidden="true" size={13} />
        )}
        <span>{summary}</span>
        <ChevronRight aria-hidden="true" className="cowart-agent-trace-chevron" size={13} />
      </summary>
      <div className="cowart-agent-trace-list">
        {traceItems.length > 0 ? traceItems.map((item) => (
          <div className="cowart-agent-trace-item" key={item.id}>
            <span aria-hidden="true"><Workflow size={12} /></span>
            <p>{item.text}</p>
          </div>
        )) : (
          <p className="cowart-agent-trace-empty">Agent 正在分析当前画布，新的进度会显示在这里。</p>
        )}
      </div>
    </details>
  )
}

function AgentConversationTurn({ turn }) {
  const parts = conversationTurnParts(turn)
  const presentation = conversationStatusPresentation(turn.status)
  const StatusIcon = presentation.Icon
  const active = !isTerminalTurnStatus(turn.status)
  return (
    <article className="cowart-agent-turn" data-status={turn.status}>
      {(turn.userText || turn.invocation) && (
        <div className="cowart-agent-user-row">
          <div className="cowart-agent-user-bubble">
            {turn.invocation && (
              <span className="cowart-agent-invocation-chip">
                <Workflow aria-hidden="true" size={12} />
                {turn.invocation.label}
              </span>
            )}
            {turn.userText && <span>{turn.userText}</span>}
          </div>
        </div>
      )}
      <div className="cowart-agent-assistant-row">
        <span className="cowart-agent-assistant-avatar" aria-hidden="true"><Bot size={15} /></span>
        <div className="cowart-agent-assistant-body">
          <header>
            <strong>Codex Agent</strong>
            <small data-tone={presentation.tone}>
              <StatusIcon className={presentation.tone === 'working' ? 'cowart-spin' : undefined} size={11} />
              {presentation.label}
            </small>
          </header>
          {parts.assistantText ? (
            <div className="cowart-agent-message-content">{parts.assistantText}</div>
          ) : active ? (
            <div className="cowart-agent-message-pending">
              <span aria-hidden="true"><i /><i /><i /></span>
              Agent 正在处理这项任务
            </div>
          ) : null}
          <AgentExecutionTrace status={turn.status} traceItems={parts.traceItems} />
          {parts.changeText && (
            <details className="cowart-agent-change-set">
              <summary>
                <FileText aria-hidden="true" size={13} />
                <span>变更摘要</span>
                <ChevronRight aria-hidden="true" size={13} />
              </summary>
              <p>{parts.changeText}</p>
            </details>
          )}
          {parts.errorText && (
            <div className="cowart-agent-turn-error" role="alert">
              <AlertCircle aria-hidden="true" size={13} />
              <p>{parts.errorText}</p>
            </div>
          )}
          {turn.finishedAt && (
            <time dateTime={turn.finishedAt}>{formatTaskTime(turn.finishedAt)}</time>
          )}
        </div>
      </div>
    </article>
  )
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

export function approvalCanRespond(status) {
  return status === 'idle' || status === 'error'
}

export function buildAgentPanelTaskRequest(selectedQuickTask, instruction = '') {
  const userText = String(instruction || '').trim()
  if (!selectedQuickTask) {
    return {
      userText,
      prompt: userText,
      applicationTask: '',
      invocation: null
    }
  }

  const id = String(selectedQuickTask.id || '').trim()
  const label = String(selectedQuickTask.label || '').trim()
  const applicationTask = String(selectedQuickTask.prompt || '').trim()
  if (!id || !label || !applicationTask) {
    throw new TypeError('Quick task requires a stable id, public label, and application task.')
  }
  return {
    userText,
    prompt: userText || `执行“${label}”。`,
    applicationTask,
    invocation: { id, label }
  }
}

export function buildAgentPanelMessage(instruction, context = {}, options = {}) {
  const selectedCount = Number(context.selectedCount) || 0
  const scope = selectedCount > 0 ? `当前选中的 ${selectedCount} 个对象` : '当前画布'
  const selectedShapeIds = Array.isArray(context.selectedShapeIds)
    ? context.selectedShapeIds.slice(0, AGENT_CONTEXT_MAX_SHAPE_IDS)
    : []
  const exactShapeIds = Array.isArray(context.exactShapeIds)
    ? context.exactShapeIds.slice(0, AGENT_CONTEXT_MAX_SHAPE_IDS)
    : []
  const stableContext = {
    canvasId: context.canvasId || context.pageId || null,
    canvasName: context.canvasName || context.pageName || '未命名画布',
    parentCanvasId: context.parentCanvasId || null,
    canvasBreadcrumb: Array.isArray(context.canvasBreadcrumb) ? context.canvasBreadcrumb : [],
    projectRevision: context.projectRevision || null,
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
  const executionMode = normalizeAgentExecutionMode(context.executionMode)
  const applicationTask = String(options.applicationTask || '').trim()
  return {
    executionMode,
    prompt: String(instruction || '').trim(),
    runtimeContext: [
      '[@cowart-thinking-canvas](plugin://cowart-thinking-canvas@cowart-thinking-github) Yogurt AI Agent 任务',
      '',
      `项目：${context.projectName || 'Yogurt AI 画布'}`,
      `画布：${context.canvasName || context.pageName || '未命名画布'}`,
      `层级：${Array.isArray(context.canvasBreadcrumb) && context.canvasBreadcrumb.length > 0
        ? context.canvasBreadcrumb.join(' / ')
        : context.canvasName || context.pageName || '未命名画布'}`,
      `作用范围：${scope}`,
      '',
      '画布上下文（请使用这些稳定 ID，不要依赖截图坐标）：',
      '```json',
      JSON.stringify(stableContext, null, 2),
      '```',
      '',
      ...(applicationTask
        ? ['应用快捷任务规则（隐藏执行上下文，不是用户原话）：', applicationTask, '']
        : []),
      SEMANTIC_DIAGRAM_ROUTING_HINT,
      '',
      agentExecutionInstructions(executionMode),
      '',
      '请使用已保存的 Yogurt AI 画布与选区上下文完成用户当前任务。'
    ].join('\n')
  }
}

function createTaskId() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `cowart-agent-${Date.now()}-${suffix}`
}

export function claimAgentSubmission(lock) {
  if (!lock || lock.current) return false
  lock.current = true
  return true
}

export function releaseAgentSubmission(lock) {
  if (lock) lock.current = false
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
  isModal = false,
  isOpen,
  onAttentionChange,
  onOpenChange
}) {
  const [bridgeState, setBridgeState] = useState(() => bridge?.getState?.() ?? EMPTY_BRIDGE_STATE)
  const [conversation, dispatchConversation] = useReducer(
    reduceAgentConversation,
    bridge?.getState?.() ?? EMPTY_BRIDGE_STATE,
    restoreAgentConversationState
  )
  const [context, setContext] = useState(() => readContext(contextProvider))
  const [instruction, setInstruction] = useState('')
  const [selectedQuickTask, setSelectedQuickTask] = useState(null)
  const [executionMode, setExecutionMode] = useState(() => readAgentExecutionMode(
    undefined,
    agentExecutionModeScope(context)
  ))
  const [approvalResolution, setApprovalResolution] = useState({ requestId: null, status: 'idle' })
  const [elicitationResolution, setElicitationResolution] = useState({ requestId: null, status: 'idle' })
  const [isInterrupting, setIsInterrupting] = useState(false)
  const [isSelectingWorkspace, setIsSelectingWorkspace] = useState(false)
  const [isRefreshingCodex, setIsRefreshingCodex] = useState(false)
  const [isStartingCodexLogin, setIsStartingCodexLogin] = useState(false)
  const [setupNotice, setSetupNotice] = useState('')
  const [sendError, setSendError] = useState('')
  const [isPreparing, setIsPreparing] = useState(false)
  const [hasUnreadReply, setHasUnreadReply] = useState(() => (
    !isOpen && bridge?.getState?.()?.lastEvent?.type === 'agent.delta'
  ))
  const textAreaRef = useRef(null)
  const blockingInteractionRef = useRef(null)
  const panelRef = useRef(null)
  const panelBodyRef = useRef(null)
  const submissionLockRef = useRef(false)
  const shouldFollowConversationRef = useRef(true)
  const isOpenRef = useRef(isOpen)
  const autoOpenedInteractionRef = useRef(null)
  const executionProjectRef = useRef(agentExecutionModeScope(context))

  useEffect(() => {
    const nextProjectScope = agentExecutionModeScope(context)
    if (executionProjectRef.current !== nextProjectScope) {
      executionProjectRef.current = nextProjectScope
      setExecutionMode(readAgentExecutionMode(undefined, nextProjectScope))
      return
    }
    persistAgentExecutionMode(executionMode, undefined, nextProjectScope)
  }, [context?.projectName, context?.projectScopeId, executionMode])

  useEffect(() => {
    if (!isModal || !isOpen) return undefined

    const panel = panelRef.current
    if (!panel) return undefined
    const previouslyFocused = document.activeElement
    const focusableSelector = [
      'button:not([disabled])',
      'a[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',')
    const focusableElements = () => Array.from(panel.querySelectorAll(focusableSelector))

    ;(panel.querySelector('.cowart-agent-close') || focusableElements()[0])?.focus()

    function handleModalKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onOpenChange(false)
        return
      }
      if (event.key !== 'Tab') return

      const elements = focusableElements()
      if (!elements.length) {
        event.preventDefault()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    panel.addEventListener('keydown', handleModalKeyDown)
    return () => {
      panel.removeEventListener('keydown', handleModalKeyDown)
      const appToggle = document.querySelector('.yogurt-app-agent-toggle')
      if (appToggle instanceof HTMLElement) appToggle.focus()
      else if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  }, [isModal, isOpen, onOpenChange])

  useEffect(() => {
    isOpenRef.current = isOpen
    if (isOpen) setHasUnreadReply(false)
  }, [isOpen])

  useEffect(() => {
    if (!bridge) {
      setBridgeState(EMPTY_BRIDGE_STATE)
      dispatchConversation({ type: 'conversation.reset', bridgeState: EMPTY_BRIDGE_STATE })
      return undefined
    }

    function recordConversationEvent(event) {
      if (!isConversationEvent(event)) return
      if (event.type === 'agent.delta' && !isOpenRef.current) {
        setHasUnreadReply(true)
      }
      dispatchConversation(event)
    }

    const initialState = bridge.getState()
    setBridgeState(initialState)
    dispatchConversation({ type: 'conversation.reset', bridgeState: initialState })
    const unsubscribe = bridge.subscribe(
      (nextState, event) => {
        setBridgeState(nextState)
        recordConversationEvent(event ?? nextState.lastEvent)
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
  const hasPendingApproval = activityPhase === 'waiting_approval' && Boolean(bridgeState.activity?.approval)
  const hasBlockingInteraction = hasPendingApproval || Boolean(pendingElicitation)
  const followsAgentActivity = Boolean(
    bridgeState.capabilities?.streaming ||
    bridgeState.capabilities?.approvals ||
    bridgeState.capabilities?.elicitation
  )
  const isSending =
    isPreparing ||
    bridgeState.status === 'sending' ||
    bridgeState.pendingTaskIds?.length > 0 ||
    Boolean(pendingElicitation) ||
    (followsAgentActivity && ['submitting', 'running', 'waiting_approval', 'waiting_elicitation'].includes(activityPhase))
  const canInterrupt = Boolean(
    isSending &&
      bridgeState.capabilities?.interrupt &&
      typeof bridge?.interrupt === 'function' &&
      !hasBlockingInteraction
  )
  const conversationTurns = conversation.turns
  const hasConversation = conversationTurns.length > 0
  const selectedCount = Number(context?.selectedCount) || 0
  const pageShapeCount = Number(context?.pageShapeCount) || 0
  const scopeLabel = selectedCount > 0 ? `已选 ${selectedCount} 项` : `页面 ${pageShapeCount} 项`
  const launcherAttention = hasBlockingInteraction
    ? { kind: 'blocking', label: '待处理', accessibleLabel: '打开 Codex Agent 面板，有任务等待你的操作' }
    : hasUnreadReply
      ? { kind: 'reply', label: '新回复', accessibleLabel: '打开 Codex Agent 面板，有新回复' }
      : null
  const blockingInteractionKey = pendingElicitation
    ? `elicitation:${elicitationRequestId ?? 'pending'}`
    : hasPendingApproval
      ? `approval:${approvalRequestId ?? 'pending'}`
      : null

  useEffect(() => {
    onAttentionChange?.(launcherAttention)
  }, [launcherAttention?.accessibleLabel, launcherAttention?.kind, launcherAttention?.label, onAttentionChange])

  useEffect(() => {
    if (!blockingInteractionKey) {
      autoOpenedInteractionRef.current = null
      return
    }
    if (isOpen) {
      autoOpenedInteractionRef.current = blockingInteractionKey
      return
    }
    if (autoOpenedInteractionRef.current === blockingInteractionKey) return
    autoOpenedInteractionRef.current = blockingInteractionKey
    onOpenChange?.(true)
  }, [blockingInteractionKey, isOpen, onOpenChange])

  useEffect(() => {
    if (!isOpen || !hasBlockingInteraction) return undefined
    const frame = window.requestAnimationFrame(() => {
      blockingInteractionRef.current?.focus?.({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [approvalRequestId, elicitationRequestId, hasBlockingInteraction, isOpen])

  useEffect(() => {
    if (!isOpen || !shouldFollowConversationRef.current || conversation.turns.length === 0) return undefined
    const frame = window.requestAnimationFrame(() => {
      const body = panelBodyRef.current
      body?.scrollTo?.({ top: body.scrollHeight, behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [conversation, isOpen])

  const applyQuickTask = useCallback((task) => {
    setSelectedQuickTask({ id: task.id, label: task.label, prompt: task.prompt })
    setInstruction('')
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
    const taskRequest = buildAgentPanelTaskRequest(selectedQuickTask, instruction)
    if (!taskRequest.prompt || isSending || !isAvailable || !bridge || !claimAgentSubmission(submissionLockRef)) return

    setIsPreparing(true)
    shouldFollowConversationRef.current = true
    setSendError('')
    setApprovalResolution({ requestId: null, status: 'idle' })
    setElicitationResolution({ requestId: null, status: 'idle' })
    const taskId = createTaskId()
    let taskContext = readContext(contextProvider) ?? context ?? {}
    const startedAt = new Date().toISOString()
    const initialTask = {
      id: taskId,
      status: 'sending',
      startedAt,
      metadata: {
        source: 'cowart-agent-panel',
        userText: taskRequest.userText || null,
        invocation: taskRequest.invocation,
        visibility: 'user-authored',
        projectName: taskContext.projectName || null,
        canvasId: taskContext.canvasId || taskContext.pageId || null,
        canvasName: taskContext.canvasName || taskContext.pageName || null,
        pageId: taskContext.pageId || null,
        pageName: taskContext.pageName || null,
        selectedCount: Number(taskContext.selectedCount) || 0
      }
    }
    dispatchConversation({ type: 'task.started', task: initialTask, at: startedAt })

    try {
      const preparedContext = await beforeSend?.(taskContext)
      if (preparedContext) taskContext = preparedContext
      const taskExecutionMode = resolveAgentExecutionModeForTask({
        currentMode: executionMode,
        currentProjectScope: executionProjectRef.current,
        taskContext
      })
      await bridge.sendTask(buildAgentPanelMessage(taskRequest.prompt, {
        ...taskContext,
        executionMode: taskExecutionMode
      }, {
        applicationTask: taskRequest.applicationTask
      }), {
        taskId,
        metadata: {
          ...initialTask.metadata,
          projectName: taskContext.projectName || null,
          canvasId: taskContext.canvasId || taskContext.pageId || null,
          canvasName: taskContext.canvasName || taskContext.pageName || null,
          pageId: taskContext.pageId || null,
          pageName: taskContext.pageName || null,
          selectedCount: Number(taskContext.selectedCount) || 0,
          executionMode: taskExecutionMode
        },
        analyticsContext: {
          promptType: 'other',
          hasReference: Number(taskContext.selectedCount) > 0
        }
      })
      setInstruction('')
      setSelectedQuickTask(null)
    } catch (error) {
      console.error(error)
      const message = error?.message || '无法发送任务，请稍后重试。'
      const finishedAt = new Date().toISOString()
      dispatchConversation({
        type: 'task.failed',
        task: { ...initialTask, status: 'failed', finishedAt, error: { message } },
        error: { message },
        at: finishedAt
      })
      setSendError(message)
    } finally {
      releaseAgentSubmission(submissionLockRef)
      setIsPreparing(false)
    }
  }

  if (!isOpen) {
    return (
      <button
        aria-label={launcherAttention?.accessibleLabel || '打开 Codex Agent 面板'}
        className="cowart-agent-panel-launcher"
        data-attention={launcherAttention?.kind || 'none'}
        onClick={() => onOpenChange(true)}
        title={launcherAttention?.accessibleLabel || '打开 Codex Agent'}
        type="button"
      >
        <Bot aria-hidden="true" size={19} />
        <span className="cowart-agent-launcher-copy">
          <strong>Codex</strong>
          <small>
            {launcherAttention?.kind === 'blocking'
              ? '等待你的操作'
              : launcherAttention?.kind === 'reply'
                ? '有新的完整回复'
                : '就绪 · 处理当前画布'}
          </small>
        </span>
        {launcherAttention && (
          <span
            aria-hidden="true"
            className="cowart-agent-launcher-notice"
          >
            {launcherAttention.label}
          </span>
        )}
        <ChevronRight aria-hidden="true" size={15} />
      </button>
    )
  }

  return (
    <aside
      ref={panelRef}
      aria-label="Codex Agent 工作台"
      aria-modal={isModal ? 'true' : undefined}
      className="cowart-agent-panel"
      id="yogurt-codex-agent-panel"
      role={isModal ? 'dialog' : undefined}
    >
      <header className="cowart-agent-panel-header">
        <span className="cowart-agent-avatar" aria-hidden="true">
          <Bot size={19} />
        </span>
        <span className="cowart-agent-heading">
          <strong>Codex Agent</strong>
          <small>画布协作 Agent</small>
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

      <div
        ref={panelBodyRef}
        className="cowart-agent-panel-body"
        onScroll={(event) => {
          const element = event.currentTarget
          const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
          shouldFollowConversationRef.current = distanceFromBottom < 96
        }}
      >
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

        {!hasConversation && (
          <section className="cowart-agent-welcome" aria-labelledby="cowart-agent-welcome-title">
            <span className="cowart-agent-welcome-icon" aria-hidden="true"><Sparkles size={19} /></span>
            <h2 id="cowart-agent-welcome-title">描述结构，直接生成可编辑图</h2>
            <p>AI 会把需求组织成官方 Excalidraw 原生节点、文字和绑定箭头；每一项都能移动、改字和重新连接。</p>
            <div className="cowart-agent-welcome-context" aria-label="当前工作范围">
              <span><FileText aria-hidden="true" size={13} />{context?.pageName || '未命名页面'}</span>
              <span data-selection={selectedCount > 0 ? 'true' : 'false'}>{scopeLabel}</span>
            </div>
            {isAvailable && (
              <div className="cowart-agent-quick-grid" aria-label="快捷任务">
                {QUICK_TASKS.map((task) => {
                  const { icon: Icon, kind, label, description } = task
                  return (
                  <button data-kind={kind} key={label} onClick={() => applyQuickTask(task)} type="button">
                    <Icon aria-hidden="true" size={15} />
                    <span className="cowart-agent-quick-copy">
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </span>
                    <ChevronRight aria-hidden="true" size={13} />
                  </button>
                  )
                })}
              </div>
            )}
          </section>
        )}

        {hasConversation && (
          <section
            aria-label="Agent 对话"
            aria-live="polite"
            aria-relevant="additions text"
            className="cowart-agent-thread"
            role="log"
          >
            {conversationTurns.map((turn) => (
              <AgentConversationTurn key={turn.key} turn={turn} />
            ))}
          </section>
        )}
      </div>

      {hasBlockingInteraction && (
        <div className="cowart-agent-interaction-dock">
          <section
            ref={blockingInteractionRef}
            aria-labelledby="cowart-agent-blocking-title"
            className="cowart-agent-blocking"
            role="region"
            tabIndex={-1}
          >
            <header
              aria-atomic="true"
              aria-live="assertive"
              className="cowart-agent-blocking-header"
              role="alert"
            >
              <span aria-hidden="true"><AlertCircle size={17} /></span>
              <div>
                <strong id="cowart-agent-blocking-title">需要你的操作</strong>
                <p>任务已暂停，处理下面的问题后 Agent 才会继续。</p>
              </div>
            </header>
            {hasPendingApproval && (
              <div className="cowart-agent-approval">
                <strong>确认这次操作</strong>
                <p>
                  {activityText(bridgeState.activity.approval) ||
                    '这一步可能会修改画布或项目文件。'}
                </p>
                {typeof bridge?.respondApproval === 'function' && approvalCanRespond(approvalStatus) && (
                  <div>
                    <button onClick={() => handleApproval('decline')} type="button">
                      <X aria-hidden="true" size={13} />
                      拒绝
                    </button>
                    <button data-primary="true" onClick={() => handleApproval('accept')} type="button">
                      <CheckCircle2 aria-hidden="true" size={13} />
                      {approvalStatus === 'error' ? '重试并继续' : '允许并继续'}
                    </button>
                  </div>
                )}
                {approvalStatus !== 'idle' && (
                  <small aria-live="polite">
                    {approvalStatus === 'sending'
                      ? '正在提交…'
                      : approvalStatus === 'accept'
                        ? '已允许，Agent 将继续执行。'
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
        </div>
      )}

      <form className="cowart-agent-composer" onSubmit={handleSubmit}>
        <div className="cowart-agent-composer-context" aria-label="Agent 将使用的画布范围">
          <span title={context?.pageName || '未命名页面'}>
            <FileText aria-hidden="true" size={12} />
            {context?.pageName || '未命名页面'}
          </span>
          <span data-selection={selectedCount > 0 ? 'true' : 'false'}>{scopeLabel}</span>
          {workspaceSetup?.status === 'ready' && typeof bridge?.selectWorkspace === 'function' && (
            <button
              disabled={isSelectingWorkspace}
              onClick={handleSelectWorkspace}
              title="更换工作区并重新打开应用"
              type="button"
            >
              <FolderOpen aria-hidden="true" size={12} />
              工作区
            </button>
          )}
        </div>
        <div className="cowart-agent-execution-mode">
          <button
            aria-label={executionMode === 'autonomous' ? '关闭自动执行，改为分步确认' : '开启自动执行'}
            aria-pressed={executionMode === 'autonomous'}
            data-active={executionMode === 'autonomous' ? 'true' : 'false'}
            disabled={isSending || hasBlockingInteraction}
            onClick={() => setExecutionMode((current) => (
              current === 'autonomous' ? 'guided' : 'autonomous'
            ))}
            title="在当前工作区内连续执行；越权操作会自动停止"
            type="button"
          >
            <Zap aria-hidden="true" size={14} />
            <span>
              <strong>自动完成可编辑图</strong>
              <small>
                {executionMode === 'autonomous'
                  ? '工作区内不再逐项确认'
                  : '安全写入直接完成，语义歧义才询问'}
              </small>
            </span>
            <i aria-hidden="true" />
          </button>
          <small>自动模式不弹审批；超出工作区、外部授权或敏感操作会停止并说明。</small>
        </div>
        {selectedQuickTask && (
          <div className="cowart-agent-selected-invocation" role="status">
            <span><Workflow aria-hidden="true" size={13} />{selectedQuickTask.label}</span>
            <button
              aria-label={`取消${selectedQuickTask.label}`}
              disabled={isSending}
              onClick={() => setSelectedQuickTask(null)}
              type="button"
            >
              <X aria-hidden="true" size={13} />
            </button>
          </div>
        )}
        <label htmlFor="cowart-agent-instruction">告诉 Agent 你想完成什么</label>
        <textarea
          ref={textAreaRef}
          id="cowart-agent-instruction"
          aria-describedby={sendError ? 'cowart-agent-send-error' : undefined}
          disabled={!isAvailable || hasBlockingInteraction}
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
            hasBlockingInteraction
              ? '先完成上方需要你的操作…'
              : isAvailable
              ? isSending
                ? 'Agent 执行期间，你可以先写下一条消息…'
                : selectedQuickTask
                  ? `可补充${selectedQuickTask.label}的重点（选填）…`
                  : '例如：把登录、权限校验和失败回退画成一张可编辑流程图…'
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
          <span>
            {hasBlockingInteraction
              ? '完成上方操作后，Agent 会继续'
              : isSending
                ? '当前任务完成后可发送下一条'
                : 'Enter 发送 · Shift + Enter 换行'}
          </span>
          {isSending ? (
            <button
              aria-label={
                hasBlockingInteraction
                  ? '等待处理上方操作'
                  : canInterrupt
                    ? '停止当前 Agent 任务'
                    : 'Agent 正在执行'
              }
              data-mode={canInterrupt ? 'stop' : 'busy'}
              disabled={!canInterrupt || isInterrupting}
              onClick={canInterrupt ? handleInterrupt : undefined}
              type="button"
            >
              {isInterrupting ? (
                <LoaderCircle aria-hidden="true" className="cowart-spin" size={16} />
              ) : (
                <Square aria-hidden="true" size={12} />
              )}
              <span>
                {isInterrupting
                  ? '正在停止'
                  : hasBlockingInteraction
                    ? '等待操作'
                    : canInterrupt
                      ? '停止'
                      : '执行中'}
              </span>
            </button>
          ) : (
            <button
              aria-label="发送给 Codex Agent"
              disabled={(!instruction.trim() && !selectedQuickTask) || !isAvailable}
              type="submit"
            >
              <Send aria-hidden="true" size={16} />
              <span>发送</span>
            </button>
          )}
        </div>
      </form>
    </aside>
  )
}
