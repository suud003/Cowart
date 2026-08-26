const ELICITATION_ACTIONS = new Set(['accept', 'decline', 'cancel'])
const ELICITATION_MODES = new Set(['form', 'openai/form', 'url'])
const RESERVED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

const MAX_MESSAGE_LENGTH = 4_000
const MAX_SCHEMA_FIELDS = 32
const MAX_FIELD_NAME_LENGTH = 160
const MAX_LABEL_LENGTH = 512
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_ENUM_OPTIONS = 64
const MAX_ENUM_VALUE_LENGTH = 512
const MAX_TEXT_INPUT_LENGTH = 20_000
const MAX_URL_LENGTH = 8_192

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`)
  const text = value.trim()
  if (!text) throw new TypeError(`${label} is required.`)
  if (text.length > maxLength) throw new TypeError(`${label} exceeds ${maxLength} characters.`)
  return text
}

function optionalText(value, label, maxLength) {
  if (value == null) return null
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`)
  const text = value
  if (text.length > maxLength) throw new TypeError(`${label} exceeds ${maxLength} characters.`)
  return text
}

function finiteConstraint(value, label) {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`)
  }
  return value
}

function integerConstraint(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 0 and ${maximum}.`)
  }
  return value
}

function normalizeEnumValues(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ENUM_OPTIONS) {
    throw new TypeError(`${label} must contain 1-${MAX_ENUM_OPTIONS} options.`)
  }
  const normalized = values.map((value, index) =>
    requiredText(value, `${label}[${index}]`, MAX_ENUM_VALUE_LENGTH)
  )
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} contains duplicate options.`)
  }
  return Object.freeze(normalized)
}

function normalizeTitledOptions(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ENUM_OPTIONS) {
    throw new TypeError(`${label} must contain 1-${MAX_ENUM_OPTIONS} options.`)
  }
  const normalized = values.map((value, index) => {
    if (!isRecord(value)) throw new TypeError(`${label}[${index}] must be an object.`)
    return Object.freeze({
      const: requiredText(value.const, `${label}[${index}].const`, MAX_ENUM_VALUE_LENGTH),
      title: requiredText(value.title, `${label}[${index}].title`, MAX_LABEL_LENGTH)
    })
  })
  const optionValues = normalized.map((option) => option.const)
  if (new Set(optionValues).size !== optionValues.length) {
    throw new TypeError(`${label} contains duplicate option values.`)
  }
  return Object.freeze(normalized)
}

function sharedFieldMetadata(schema, fieldName) {
  return {
    title: optionalText(schema.title, `${fieldName}.title`, MAX_LABEL_LENGTH),
    description: optionalText(
      schema.description,
      `${fieldName}.description`,
      MAX_DESCRIPTION_LENGTH
    )
  }
}

function normalizeStringField(schema, fieldName) {
  const result = {
    type: 'string',
    ...sharedFieldMetadata(schema, fieldName)
  }
  if (schema.default != null) {
    result.default = optionalText(schema.default, `${fieldName}.default`, MAX_TEXT_INPUT_LENGTH)
  }
  if (schema.format != null) {
    const format = String(schema.format)
    if (!['email', 'uri', 'date', 'date-time'].includes(format)) {
      throw new TypeError(`${fieldName}.format is unsupported.`)
    }
    result.format = format
  }
  const minLength = integerConstraint(schema.minLength, `${fieldName}.minLength`, MAX_TEXT_INPUT_LENGTH)
  const maxLength = integerConstraint(schema.maxLength, `${fieldName}.maxLength`, MAX_TEXT_INPUT_LENGTH)
  if (minLength != null) result.minLength = minLength
  if (maxLength != null) result.maxLength = maxLength
  if (minLength != null && maxLength != null && minLength > maxLength) {
    throw new TypeError(`${fieldName}.minLength cannot exceed maxLength.`)
  }

  if (schema.enum !== undefined) {
    result.enum = normalizeEnumValues(schema.enum, `${fieldName}.enum`)
    if (Array.isArray(schema.enumNames)) {
      if (schema.enumNames.length !== result.enum.length) {
        throw new TypeError(`${fieldName}.enumNames must match enum length.`)
      }
      result.enumNames = Object.freeze(schema.enumNames.map((value, index) =>
        requiredText(value, `${fieldName}.enumNames[${index}]`, MAX_LABEL_LENGTH)
      ))
    }
  } else if (schema.oneOf !== undefined) {
    result.oneOf = normalizeTitledOptions(schema.oneOf, `${fieldName}.oneOf`)
  }

  return Object.freeze(result)
}

function normalizeNumberField(schema, fieldName) {
  const result = {
    type: schema.type,
    ...sharedFieldMetadata(schema, fieldName)
  }
  const defaultValue = finiteConstraint(schema.default, `${fieldName}.default`)
  const minimum = finiteConstraint(schema.minimum, `${fieldName}.minimum`)
  const maximum = finiteConstraint(schema.maximum, `${fieldName}.maximum`)
  if (schema.type === 'integer') {
    for (const [label, value] of [['default', defaultValue], ['minimum', minimum], ['maximum', maximum]]) {
      if (value != null && !Number.isInteger(value)) {
        throw new TypeError(`${fieldName}.${label} must be an integer.`)
      }
    }
  }
  if (defaultValue != null) result.default = defaultValue
  if (minimum != null) result.minimum = minimum
  if (maximum != null) result.maximum = maximum
  if (minimum != null && maximum != null && minimum > maximum) {
    throw new TypeError(`${fieldName}.minimum cannot exceed maximum.`)
  }
  return Object.freeze(result)
}

function normalizeBooleanField(schema, fieldName) {
  const result = {
    type: 'boolean',
    ...sharedFieldMetadata(schema, fieldName)
  }
  if (schema.default != null) {
    if (typeof schema.default !== 'boolean') {
      throw new TypeError(`${fieldName}.default must be boolean.`)
    }
    result.default = schema.default
  }
  return Object.freeze(result)
}

function normalizeArrayField(schema, fieldName) {
  if (!isRecord(schema.items)) {
    throw new TypeError(`${fieldName}.items must describe string choices.`)
  }
  const hasEnum = schema.items.type === 'string' && schema.items.enum !== undefined
  const hasTitledOptions = (
    (schema.items.type === undefined || schema.items.type === 'string') &&
    schema.items.anyOf !== undefined
  )
  if (!hasEnum && !hasTitledOptions) {
    throw new TypeError(`${fieldName}.items must describe string choices.`)
  }
  const items = hasEnum
    ? Object.freeze({
        type: 'string',
        enum: normalizeEnumValues(schema.items.enum, `${fieldName}.items.enum`)
      })
    : Object.freeze({
        anyOf: normalizeTitledOptions(schema.items.anyOf, `${fieldName}.items.anyOf`)
      })
  const result = {
    type: 'array',
    ...sharedFieldMetadata(schema, fieldName),
    items
  }
  const minItems = integerConstraint(schema.minItems, `${fieldName}.minItems`, MAX_ENUM_OPTIONS)
  const maxItems = integerConstraint(schema.maxItems, `${fieldName}.maxItems`, MAX_ENUM_OPTIONS)
  if (minItems != null) result.minItems = minItems
  if (maxItems != null) result.maxItems = maxItems
  if (minItems != null && maxItems != null && minItems > maxItems) {
    throw new TypeError(`${fieldName}.minItems cannot exceed maxItems.`)
  }
  if (schema.default != null) {
    if (!Array.isArray(schema.default)) throw new TypeError(`${fieldName}.default must be an array.`)
    result.default = Object.freeze(schema.default.map((value, index) =>
      requiredText(value, `${fieldName}.default[${index}]`, MAX_ENUM_VALUE_LENGTH)
    ))
  }
  return Object.freeze(result)
}

function normalizeFieldSchema(schema, fieldName) {
  if (!isRecord(schema)) throw new TypeError(`${fieldName} schema must be an object.`)
  if (schema.type === 'string') return normalizeStringField(schema, fieldName)
  if (schema.type === 'number' || schema.type === 'integer') {
    return normalizeNumberField(schema, fieldName)
  }
  if (schema.type === 'boolean') return normalizeBooleanField(schema, fieldName)
  if (schema.type === 'array') return normalizeArrayField(schema, fieldName)
  throw new TypeError(`${fieldName}.type is unsupported.`)
}

export function normalizeMcpElicitationSchema(schema) {
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) {
    throw new TypeError('MCP elicitation requestedSchema must be an object schema.')
  }
  const entries = Object.entries(schema.properties)
  if (entries.length > MAX_SCHEMA_FIELDS) {
    throw new TypeError(`MCP elicitation has more than ${MAX_SCHEMA_FIELDS} fields.`)
  }
  const properties = {}
  for (const [rawName, fieldSchema] of entries) {
    const name = requiredText(rawName, 'MCP elicitation field name', MAX_FIELD_NAME_LENGTH)
    if (RESERVED_FIELD_NAMES.has(name)) {
      throw new TypeError(`MCP elicitation field name is reserved: ${name}`)
    }
    properties[name] = normalizeFieldSchema(fieldSchema, name)
  }
  const required = schema.required == null ? [] : schema.required
  if (!Array.isArray(required) || required.length > entries.length) {
    throw new TypeError('MCP elicitation required fields are invalid.')
  }
  const normalizedRequired = required.map((value, index) =>
    requiredText(value, `requestedSchema.required[${index}]`, MAX_FIELD_NAME_LENGTH)
  )
  if (new Set(normalizedRequired).size !== normalizedRequired.length) {
    throw new TypeError('MCP elicitation required fields contain duplicates.')
  }
  for (const name of normalizedRequired) {
    if (!Object.prototype.hasOwnProperty.call(properties, name)) {
      throw new TypeError(`MCP elicitation required field is missing from properties: ${name}`)
    }
  }
  return Object.freeze({
    type: 'object',
    properties: Object.freeze(properties),
    required: Object.freeze(normalizedRequired),
    additionalProperties: false
  })
}

export function normalizeMcpElicitationUrl(value) {
  const text = requiredText(value, 'MCP elicitation URL', MAX_URL_LENGTH)
  let url
  try {
    url = new URL(text)
  } catch (_error) {
    throw new TypeError('MCP elicitation URL is invalid.')
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new TypeError('Yogurt AI only opens credential-free HTTPS elicitation URLs.')
  }
  return url.toString()
}

export function normalizeMcpElicitationRequest(requestId, params) {
  if (!isRecord(params)) throw new TypeError('MCP elicitation params must be an object.')
  const requestIdValue = typeof requestId === 'string'
    ? requestId
    : Number.isSafeInteger(requestId) ? String(requestId) : null
  const normalizedRequestId = requiredText(requestIdValue, 'MCP elicitation requestId', 512)
  const mode = requiredText(params.mode, 'MCP elicitation mode', 32)
  if (!ELICITATION_MODES.has(mode)) throw new TypeError(`Unsupported MCP elicitation mode: ${mode}`)
  if (mode === 'openai/form') {
    throw new TypeError('Yogurt AI has not opted in to openai/form elicitations.')
  }
  const common = {
    requestId: normalizedRequestId,
    mode,
    message: requiredText(params.message, 'MCP elicitation message', MAX_MESSAGE_LENGTH),
    serverName: requiredText(params.serverName, 'MCP elicitation serverName', 160),
    threadId: requiredText(params.threadId, 'MCP elicitation threadId', 512),
    turnId: params.turnId == null
      ? null
      : requiredText(params.turnId, 'MCP elicitation turnId', 512)
  }

  if (mode === 'url') {
    const url = normalizeMcpElicitationUrl(params.url)
    const parsedUrl = new URL(url)
    const elicitationId = requiredText(params.elicitationId, 'MCP elicitationId', 512)
    return Object.freeze({
      ...common,
      elicitationId,
      externalUrl: url,
      publicRequest: Object.freeze({
        ...common,
        elicitationId,
        urlHost: parsedUrl.hostname
      })
    })
  }

  const requestedSchema = normalizeMcpElicitationSchema(params.requestedSchema)
  return Object.freeze({
    ...common,
    requestedSchema,
    externalUrl: null,
    publicRequest: Object.freeze({ ...common, requestedSchema })
  })
}

function enumValuesForField(schema) {
  if (Array.isArray(schema.enum)) return schema.enum
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((option) => option.const)
  if (Array.isArray(schema.items?.enum)) return schema.items.enum
  if (Array.isArray(schema.items?.anyOf)) return schema.items.anyOf.map((option) => option.const)
  return null
}

function validateStringFormat(value, format, fieldName) {
  if (!format) return
  if (format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new TypeError(`${fieldName} must be a valid email address.`)
  }
  if (format === 'uri') {
    try {
      new URL(value)
    } catch (_error) {
      throw new TypeError(`${fieldName} must be a valid URI.`)
    }
  }
  if (format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${fieldName} must use YYYY-MM-DD.`)
  }
  if (format === 'date-time' && Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${fieldName} must be a valid date-time.`)
  }
}

function validateFieldValue(fieldName, schema, value) {
  const options = enumValuesForField(schema)
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new TypeError(`${fieldName} must be text.`)
    if (value.length > MAX_TEXT_INPUT_LENGTH) {
      throw new TypeError(`${fieldName} exceeds ${MAX_TEXT_INPUT_LENGTH} characters.`)
    }
    if (schema.minLength != null && value.length < schema.minLength) {
      throw new TypeError(`${fieldName} is shorter than ${schema.minLength} characters.`)
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      throw new TypeError(`${fieldName} is longer than ${schema.maxLength} characters.`)
    }
    if (options && !options.includes(value)) throw new TypeError(`${fieldName} is not an allowed option.`)
    validateStringFormat(value, schema.format, fieldName)
    return value
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`${fieldName} must be a finite number.`)
    }
    if (schema.type === 'integer' && !Number.isInteger(value)) {
      throw new TypeError(`${fieldName} must be an integer.`)
    }
    if (schema.minimum != null && value < schema.minimum) {
      throw new TypeError(`${fieldName} must be at least ${schema.minimum}.`)
    }
    if (schema.maximum != null && value > schema.maximum) {
      throw new TypeError(`${fieldName} must be at most ${schema.maximum}.`)
    }
    return value
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new TypeError(`${fieldName} must be true or false.`)
    return value
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new TypeError(`${fieldName} must be a list.`)
    if (schema.minItems != null && value.length < schema.minItems) {
      throw new TypeError(`${fieldName} needs at least ${schema.minItems} selections.`)
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      throw new TypeError(`${fieldName} allows at most ${schema.maxItems} selections.`)
    }
    if (new Set(value).size !== value.length) throw new TypeError(`${fieldName} contains duplicates.`)
    for (const option of value) {
      if (typeof option !== 'string' || !options?.includes(option)) {
        throw new TypeError(`${fieldName} contains an unsupported option.`)
      }
    }
    return Object.freeze(value.slice())
  }
  throw new TypeError(`${fieldName} has an unsupported schema.`)
}

export function validateMcpElicitationResponse(request, response) {
  if (!request || !isRecord(response)) throw new TypeError('MCP elicitation response is required.')
  const action = requiredText(response.action, 'MCP elicitation action', 16)
  if (!ELICITATION_ACTIONS.has(action)) {
    throw new TypeError('MCP elicitation action must be accept, decline, or cancel.')
  }
  if (action !== 'accept') {
    if (response.content !== undefined && response.content !== null) {
      throw new TypeError('Declined or cancelled MCP elicitations cannot include content.')
    }
    return Object.freeze({ action, content: null })
  }
  if (request.mode === 'url') {
    if (response.content !== undefined && response.content !== null) {
      throw new TypeError('URL MCP elicitations do not accept form content.')
    }
    return Object.freeze({ action, content: null })
  }
  if (!isRecord(response.content)) {
    throw new TypeError('Accepted MCP form elicitations require structured content.')
  }

  const schema = request.requestedSchema
  const suppliedKeys = Object.keys(response.content)
  for (const key of suppliedKeys) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
      throw new TypeError(`Unexpected MCP elicitation field: ${key}`)
    }
  }
  for (const key of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(response.content, key)) {
      throw new TypeError(`Missing required MCP elicitation field: ${key}`)
    }
  }
  const content = {}
  for (const key of suppliedKeys) {
    content[key] = validateFieldValue(key, schema.properties[key], response.content[key])
  }
  return Object.freeze({ action, content: Object.freeze(content) })
}

export const MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request'
export const MCP_ELICITATION_ACTIONS = Object.freeze(Array.from(ELICITATION_ACTIONS))
