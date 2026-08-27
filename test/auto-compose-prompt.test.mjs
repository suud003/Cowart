import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AUTO_COMPOSE_QUICK_PROMPT,
  AUTO_COMPOSE_ROUTING_HINT,
  AUTO_COMPOSE_SKILL_NAME
} from '../src/autoComposePrompt.js'

test('auto-compose quick prompt defines reference-first routing and a hard review gate', () => {
  assert.equal(AUTO_COMPOSE_SKILL_NAME, '$cowart-auto-compose')
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /视觉图片/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /原生可编辑框线图/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /证据与约束卡片/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /先生成一张低文字的整体参考图/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /停下来等我确认/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /以这张参考图为统一视觉锚点/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不能栅格化/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不要创建 PRD/)
})

test('ordinary Agent tasks receive the mixed-output routing rule without forcing it on single tasks', () => {
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /至少两类/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /\$cowart-auto-compose/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /参考图只负责视觉风格与构图/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /语义必须来自用户需求和可追溯材料/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /单一明确任务继续使用最匹配的现有能力/)
})

test('auto-compose skill keeps the approved asset path and original semantics separate', async () => {
  const [skill, contract, imageSkill] = await Promise.all([
    readFile('skills/cowart-auto-compose/SKILL.md', 'utf8'),
    readFile('skills/cowart-auto-compose/references/routing-contract.md', 'utf8'),
    readFile('skills/cowart-image-gen/SKILL.md', 'utf8')
  ])

  assert.match(skill, /reference-review/)
  assert.match(skill, /always stop after reporting the route preview and managed reference/i)
  assert.match(skill, /assetFile/)
  assert.match(skill, /referenceShapeId/i)
  assert.match(skill, /Never rasterize the diagram/)
  assert.match(contract, /visual anchor, not the final canvas and not a semantic source/)
  assert.match(contract, /Do not interpret silence/)
  assert.match(contract, /cowartAutoComposeSourceShapeIds/)
  assert.match(contract, /semanticDiagram\.diagramId/)
  assert.match(contract, /Source-only selection context does not include it/)
  assert.match(contract, /two exact selection reads/)
  assert.match(contract, /repeat both exact reads once/)
  assert.match(contract, /Unicode NFC/)
  assert.match(contract, /keys sorted lexicographically at every depth/)
  assert.match(contract, /UTF-8 without a byte-order mark/)
  assert.match(contract, /hashes only/)
  assert.match(contract, /ac-evidence:<compositionHash>:<blockHash>/)
  assert.match(contract, /source\.yogurtShapeIds/)
  assert.match(contract, /first 100 canvas IDs/)
  assert.match(contract, /first 50 external\/source identifiers/)
  assert.match(contract, /Provenance overflow:/)
  assert.doesNotMatch(contract, /cowartAutoComposeRole.*diagram.*evidence/)
  assert.match(imageSkill, /referenced_image_paths/)
  assert.match(imageSkill, /Do not silently substitute a stale generated image/)
  assert.match(imageSkill, /dry-run response's `baseRevision`/)
  assert.match(imageSkill, /caller must not call `insert_cowart_image` again/)
  assert.match(imageSkill, /insert a managed copy/)
})
