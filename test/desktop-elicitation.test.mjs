import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeMcpElicitationRequest,
  normalizeMcpElicitationUrl,
  validateMcpElicitationResponse
} from '../desktop/elicitation.mjs'

function standardFormRequest() {
  return normalizeMcpElicitationRequest('elicitation-form-1', {
    mode: 'form',
    message: 'Complete the interaction-game brief.',
    serverName: 'map-systems',
    threadId: 'thr_1',
    turnId: 'turn_1',
    requestedSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          title: 'Project title',
          minLength: 3,
          maxLength: 80
        },
        chapterCount: {
          type: 'integer',
          title: 'Chapters',
          minimum: 1,
          maximum: 12
        },
        replayable: {
          type: 'boolean',
          title: 'Replayable'
        },
        focus: {
          type: 'string',
          title: 'Core focus',
          oneOf: [
            { const: 'story', title: 'Story' },
            { const: 'battle', title: 'Battle' }
          ]
        },
        systems: {
          type: 'array',
          title: 'Systems',
          items: {
            anyOf: [
              { const: 'dialogue', title: 'Dialogue' },
              { const: 'combat', title: 'Combat' },
              { const: 'economy', title: 'Economy' }
            ]
          },
          minItems: 1,
          maxItems: 2
        }
      },
      required: ['title', 'chapterCount', 'focus', 'systems']
    }
  })
}

test('standard MCP form schemas are normalized into a closed renderer-safe shape', () => {
  const request = standardFormRequest()

  assert.equal(request.mode, 'form')
  assert.equal(request.externalUrl, null)
  assert.equal(request.requestedSchema.additionalProperties, false)
  assert.deepEqual(request.requestedSchema.required, [
    'title',
    'chapterCount',
    'focus',
    'systems'
  ])
  assert.deepEqual(request.requestedSchema.properties.focus.oneOf, [
    { const: 'story', title: 'Story' },
    { const: 'battle', title: 'Battle' }
  ])
  assert.deepEqual(request.requestedSchema.properties.systems.items.anyOf, [
    { const: 'dialogue', title: 'Dialogue' },
    { const: 'combat', title: 'Combat' },
    { const: 'economy', title: 'Economy' }
  ])
  assert.equal(Object.isFrozen(request.publicRequest), true)
  assert.equal(Object.isFrozen(request.requestedSchema.properties), true)
})

test('MCP form responses enforce types, required fields, enum values, and multi-select bounds', () => {
  const request = standardFormRequest()
  const accepted = validateMcpElicitationResponse(request, {
    action: 'accept',
    content: {
      title: 'Echo Labyrinth',
      chapterCount: 6,
      replayable: true,
      focus: 'story',
      systems: ['dialogue', 'combat']
    }
  })
  assert.deepEqual(accepted, {
    action: 'accept',
    content: {
      title: 'Echo Labyrinth',
      chapterCount: 6,
      replayable: true,
      focus: 'story',
      systems: ['dialogue', 'combat']
    }
  })

  assert.throws(
    () => validateMcpElicitationResponse(request, {
      action: 'accept',
      content: {
        title: 'Echo Labyrinth',
        chapterCount: '6',
        focus: 'story',
        systems: ['dialogue']
      }
    }),
    /chapterCount must be a finite number/
  )
  assert.throws(
    () => validateMcpElicitationResponse(request, {
      action: 'accept',
      content: {
        chapterCount: 6,
        focus: 'story',
        systems: ['dialogue']
      }
    }),
    /Missing required MCP elicitation field: title/
  )
  assert.throws(
    () => validateMcpElicitationResponse(request, {
      action: 'accept',
      content: {
        title: 'Echo Labyrinth',
        chapterCount: 6,
        focus: 'attacker-controlled',
        systems: ['dialogue']
      }
    }),
    /focus is not an allowed option/
  )
  assert.throws(
    () => validateMcpElicitationResponse(request, {
      action: 'accept',
      content: {
        title: 'Echo Labyrinth',
        chapterCount: 6,
        focus: 'story',
        systems: ['dialogue', 'dialogue']
      }
    }),
    /systems contains duplicates/
  )
  assert.throws(
    () => validateMcpElicitationResponse(request, {
      action: 'accept',
      content: {
        title: 'Echo Labyrinth',
        chapterCount: 6,
        focus: 'story',
        systems: ['dialogue', 'combat', 'economy']
      }
    }),
    /systems allows at most 2 selections/
  )
  assert.deepEqual(
    validateMcpElicitationResponse(request, { action: 'cancel', content: null }),
    { action: 'cancel', content: null }
  )
})

test('URL elicitations accept only credential-free HTTPS and openai/form stays opt-in only', () => {
  assert.equal(
    normalizeMcpElicitationUrl('https://accounts.example.com/authorize?state=opaque'),
    'https://accounts.example.com/authorize?state=opaque'
  )
  assert.throws(
    () => normalizeMcpElicitationUrl('http://accounts.example.com/authorize'),
    /credential-free HTTPS/
  )
  assert.throws(
    () => normalizeMcpElicitationUrl('https://user:secret@accounts.example.com/authorize'),
    /credential-free HTTPS/
  )
  assert.throws(
    () => normalizeMcpElicitationUrl('https://accounts.example.com:444/authorize'),
    /credential-free HTTPS/
  )
  assert.throws(
    () => normalizeMcpElicitationRequest('openai-form-1', {
      mode: 'openai/form',
      message: 'Use a host-specific form.',
      serverName: 'map-systems',
      threadId: 'thr_1',
      requestedSchema: { type: 'object', properties: {} }
    }),
    /has not opted in to openai\/form/
  )
})
