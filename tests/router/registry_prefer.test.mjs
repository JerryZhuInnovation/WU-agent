/** Registry + Verifier 单元测试（选模打分 / 答案提取）。
 *  prefer 部分已随手动路由移除（2026-10-14，恒智能）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRegistry, rankModels } from '../../plugins/wu-ai-router/registry.js'
import { extractAssistantText } from '../../plugins/wu-ai-router/verifier.js'

test('buildRegistry 无内置厂商预设（默认空表）', () => {
  assert.deepEqual(buildRegistry(), [])
  assert.deepEqual(buildRegistry({ models: [] }), [])
})

test('buildRegistry 接受用户覆盖表', () => {
  const reg = buildRegistry({
    models: [
      { key: 'codex', capabilities: { coding: 0.95 }, enabled: true },
      { key: 'gen', capabilities: { coding: 0.2 }, enabled: false },
    ],
  })
  assert.equal(reg.length, 2)
  assert.equal(reg[0].key, 'codex')
  assert.equal(reg[1].enabled, false)
})

test('rankModels：coding 能力最高的排第一', () => {
  const reg = buildRegistry({
    models: [
      { key: 'strong', capabilities: { coding: 0.95 }, enabled: true, costScore: 0.5 },
      { key: 'weak', capabilities: { coding: 0.3 }, enabled: true, costScore: 1 },
    ],
  })
  const rows = rankModels(reg, 'coding')
  assert.equal(rows[0].model.key, 'strong')
})

test('rankModels：用户点名 prefer 覆盖成本劣势', () => {
  const reg = buildRegistry({
    models: [
      { key: 'cheap', capabilities: { coding: 0.9 }, enabled: true, costScore: 1, latencyScore: 1 },
      { key: 'named', capabilities: { coding: 0.5 }, enabled: true, costScore: 0.1, latencyScore: 0.1 },
    ],
  })
  const rows = rankModels(reg, 'coding', { prefer: { coding: 'named' } })
  assert.equal(rows[0].model.key, 'named')
  assert.equal(rows[0].preferred, true)
})

test('rankModels：requireVision 过滤无图模型', () => {
  const reg = buildRegistry({
    models: [
      { key: 'text-only', capabilities: { coding: 0.9, vision: 0 }, enabled: true },
      { key: 'vl', capabilities: { coding: 0.4, vision: 0.9 }, enabled: true },
    ],
  })
  const rows = rankModels(reg, 'coding', { requireVision: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model.key, 'vl')
})

test('extractAssistantText 字符串直通', () => {
  assert.equal(extractAssistantText('直接回答'), '直接回答')
})

test('extractAssistantText 拼接文本块', () => {
  assert.equal(
    extractAssistantText([
      { type: 'text', text: '第一行' },
      { type: 'tool', text: '忽略' },
      { type: 'text', text: '第二行' },
    ]),
    '第一行\n第二行',
  )
  assert.equal(extractAssistantText([{ type: 'tool' }]), '')
})