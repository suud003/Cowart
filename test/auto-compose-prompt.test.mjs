import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AUTO_COMPOSE_QUICK_PROMPT,
  AUTO_COMPOSE_ROUTING_HINT,
  AUTO_COMPOSE_SKILL_NAME
} from '../src/autoComposePrompt.js'

test('auto-compose quick prompt defines layout-blueprint-first routing and a hard review gate', () => {
  assert.equal(AUTO_COMPOSE_SKILL_NAME, '$cowart-auto-compose')
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /视觉图片/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /原生可编辑框线图/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /证据与约束卡片/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /结构化页面布局计划/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /整页画布布局蓝图/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /页面边界/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不能生成单张概念图、场景图或海报来代替/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /停下来等我确认/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /按已批准的布局槽位/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不能从蓝图像素推断/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不能栅格化/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不要创建 PRD/)
})

test('ordinary Agent tasks receive the mixed-output routing rule without forcing it on single tasks', () => {
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /至少两类/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /\$cowart-auto-compose/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /整页画布布局蓝图/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /布局蓝图不是概念图/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /不能从蓝图像素或 OCR 反推/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /语义必须来自用户需求和可追溯材料/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /单一明确任务继续使用最匹配的现有能力/)
})

test('auto-compose skill keeps the approved layout plan and original semantics separate', async () => {
  const [skill, contract, imageSkill] = await Promise.all([
    readFile('skills/cowart-auto-compose/SKILL.md', 'utf8'),
    readFile('skills/cowart-auto-compose/references/routing-contract.md', 'utf8'),
    readFile('skills/cowart-image-gen/SKILL.md', 'utf8')
  ])

  assert.match(skill, /layout-reference-review/)
  assert.match(skill, /Never fan out a newly inserted blueprint in the same turn/i)
  assert.match(skill, /assetFile/)
  assert.match(skill, /referenceShapeId/i)
  assert.match(skill, /layoutPlanDigest/)
  assert.match(skill, /structured plan rather than the blueprint pixels/i)
  assert.match(skill, /never overflow or silently rasterize it/i)
  assert.match(contract, /page-layout blueprint derived from `layoutPlan`/)
  assert.match(contract, /including diagram-plus-evidence tasks without a visual block/)
  assert.match(contract, /whole page boundary and every planned slot/)
  assert.match(contract, /one cinematic scene, character sheet, key art, poster, or moodboard/)
  assert.match(contract, /The structured plan, not the bitmap, controls final coordinates/)
  assert.match(contract, /Do not interpret silence/)
  assert.match(contract, /cowartAutoComposeVersion`: `"2"/)
  assert.match(contract, /legacy concept references/)
  assert.match(contract, /cowartAutoComposeSourceShapeIds/)
  assert.match(contract, /semanticDiagram\.diagramId/)
  assert.match(contract, /Source-only selection context does not include the later blueprint/)
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
  assert.match(imageSkill, /not copy page borders, placeholder boxes/)
  assert.match(imageSkill, /dry-run response's `baseRevision`/)
  assert.match(imageSkill, /caller must not call `insert_cowart_image` again/)
  assert.match(imageSkill, /layout-reference/)
})
