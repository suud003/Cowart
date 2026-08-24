import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COWART_INTERACTIVE_HTML_SANDBOX,
  COWART_SEMANTIC_DIAGRAM_SANDBOX,
  getCowartHtmlDraftSandbox
} from '../src/htmlDraftSecurity.js'

test('semantic diagrams keep same-origin DOM editing but cannot execute scripts', () => {
  const sandbox = getCowartHtmlDraftSandbox({ cowartSemanticDiagram: { version: '1' } })
  assert.equal(sandbox, COWART_SEMANTIC_DIAGRAM_SANDBOX)
  assert.match(sandbox, /allow-same-origin/)
  assert.doesNotMatch(sandbox, /allow-scripts/)
  assert.doesNotMatch(sandbox, /allow-forms|allow-popups/)
})

test('ordinary interactive HTML drafts retain their existing capabilities', () => {
  assert.equal(getCowartHtmlDraftSandbox({}), COWART_INTERACTIVE_HTML_SANDBOX)
  assert.match(COWART_INTERACTIVE_HTML_SANDBOX, /allow-scripts/)
})
