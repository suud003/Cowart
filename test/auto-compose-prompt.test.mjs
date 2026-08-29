import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AUTO_COMPOSE_QUICK_PROMPT,
  AUTO_COMPOSE_ROUTING_HINT,
  AUTO_COMPOSE_SKILL_NAME
} from '../src/autoComposePrompt.js'

test('auto-compose quick prompt requests a near-final whole-page preview before native reconstruction', () => {
  assert.equal(AUTO_COMPOSE_SKILL_NAME, '$cowart-auto-compose')
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /视觉图片/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /原生可编辑框线图/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /证据与约束卡片/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /接近成品的整页视觉预演/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /场景图、流程图、卡片、标题层级、留白与阅读顺序/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不能只画空白占位框、抽象框线蓝图/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /严格按同一组槽位/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不能从预演图片或 OCR 猜测/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /整页预演最多尝试两次/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /只把视觉槽标记为待重试/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /html-line-svg 原生可编辑线框图/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不要让预演失败阻塞原生结构/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /自动执行时连续完成/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /分步确认时在整页预演后暂停一次/)
  assert.match(AUTO_COMPOSE_QUICK_PROMPT, /不要创建 PRD/)
})

test('ordinary Agent tasks receive preview-first routing without forcing mixed composition on a single task', () => {
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /至少两类/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /\$cowart-auto-compose/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /接近成品的整页视觉预演/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /流程区要有可辨认的节点与连线/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /不要只生成空白框线布局/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /结构化计划控制最终坐标和防碰撞/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /不能作为语义来源/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /仅降级视觉槽/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /不得因此发起确认或把整个任务判失败/)
  assert.match(AUTO_COMPOSE_ROUTING_HINT, /单一明确任务继续使用最匹配的现有能力/)
})

test('auto-compose v3 binds preview and final parts to one validated source-grounded page plan', async () => {
  const [skill, contract, imageSkill, diagramSkill, thinkingTools] = await Promise.all([
    readFile('skills/cowart-auto-compose/SKILL.md', 'utf8'),
    readFile('skills/cowart-auto-compose/references/routing-contract.md', 'utf8'),
    readFile('skills/cowart-image-gen/SKILL.md', 'utf8'),
    readFile('skills/cowart-semantic-diagram/SKILL.md', 'utf8'),
    readFile('mcp/lib/thinking-tools.mjs', 'utf8')
  ])

  assert.match(skill, /validate_cowart_auto_compose_plan/)
  assert.match(skill, /composition-reference-review/)
  assert.match(skill, /autonomous-executing/)
  assert.match(skill, /same turn without an elicitation or confirmation click/i)
  assert.match(skill, /pagePlanDigest/)
  assert.match(skill, /version 3 `composition-reference` lineage/)
  assert.match(skill, /repack once/i)
  assert.match(skill, /never apply tangled or clipped geometry/i)
  assert.match(skill, /degraded-executing/)
  assert.match(skill, /must never block source-grounded native diagrams or evidence cards/i)
  assert.match(skill, /The initial call plus that retry are the complete attempt budget/i)
  assert.match(skill, /Build every `diagram` block.*whether or not the bitmap preview exists/i)
  assert.match(skill, /layoutEngine: "html-line-svg"/)
  assert.match(contract, /near-final visual projection of the complete page plan/i)
  assert.match(contract, /Every executable slot has exactly one bounded `contentSpec`/)
  assert.match(contract, /Slot rectangles may not overlap for any reason/)
  assert.match(contract, /up to 8 semantic objects/)
  assert.match(contract, /1–4 cards/)
  assert.match(contract, /Version 1 concept references and version 2 layout references are legacy/)
  assert.match(contract, /never auto-accepts an external website or network request/)
  assert.match(contract, /Diagram and evidence slots continue independently/i)
  assert.match(contract, /preview-service failure must not create an elicitation or confirmation/i)
  assert.match(contract, /visual slots stay pending\/retryable/i)
  assert.match(contract, /real returned shape, label, port, and relation bounds/)
  assert.match(imageSkill, /near-final full-page composition/)
  assert.match(imageSkill, /composition-reference/)
  assert.match(imageSkill, /cowartAutoComposeVersion: "3"/)
  assert.match(imageSkill, /cowartAutoComposeSlotId/)
  assert.match(imageSkill, /referenced_image_paths/)
  assert.match(imageSkill, /The initial call plus this retry are the full attempt budget/i)
  assert.match(imageSkill, /this image failure is not a whole-page task failure/i)
  assert.match(diagramSkill, /at most 8 nodes and 10 relations/)
  assert.match(diagramSkill, /real node\/edge bounds/)
  assert.match(diagramSkill, /layoutEngine: "html-line-svg"/)
  assert.match(diagramSkill, /layoutReport\.valid/)
  assert.match(skill, /apply_cowart_safe_thinking_operations/)
  assert.match(thinkingTools, /validate_cowart_auto_compose_plan/)
  assert.match(thinkingTools, /Rejects unsupported content specs, over-capacity diagrams\/cards/)
})
