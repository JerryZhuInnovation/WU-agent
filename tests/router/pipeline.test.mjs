/**
 * 集成测试：用户任务 → Analyzer → Registry 打分 → 选模 → 执行结果质检 → perf 落盘
 * → intel 动态回写。全程不依赖 DSH 上下文（ctx），也不产生 API 消费。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// 隔离数据面：perf.jsonl / model-intelligence.json 全部落进临时 DSH_HOME
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wuai-pipe-'))

const { analyzeTask } = await import('../../plugins/wu-ai-router/analyzer.js')
const { buildRegistry, rankModels } = await import('../../plugins/wu-ai-router/registry.js')
const { logPerf, readPerf, summarize } = await import('../../plugins/wu-ai-router/perf.js')
const { extractAssistantText } = await import('../../plugins/wu-ai-router/verifier.js')
const { syncActualFromPerf, effectiveScore, upsertCapabilities } = await import('../../plugins/wu-ai-router/intel.js')

const REGISTRY = buildRegistry({
  models: [
    // 成本/延迟一致 → 排序只由能力分决定；zhipu 留 0.07 的明确优势，
    // 超出「分差 <0.02 = 噪声，随机洗牌去位置偏见」的阈值，断言仍然确定性。
    { key: 'deepseek', capabilities: { coding: 0.88, reasoning: 0.9, general: 0.85 }, enabled: true, costScore: 0.8, latencyScore: 0.7 },
    { key: 'zhipu', capabilities: { coding: 0.95, reasoning: 0.85, general: 0.8 }, enabled: true, costScore: 0.8, latencyScore: 0.7 },
    { key: 'vision', capabilities: { vision: 0.95, coding: 0.4 }, enabled: true, costScore: 0.8, latencyScore: 0.7 },
  ],
})

test('pipeline：Python 任务 → coding → 打分最高的模型胜出', () => {
  const analysis = analyzeTask('帮我写一个 Python 脚本批量处理数据')
  assert.equal(analysis.primary, 'coding')
  const rows = rankModels(REGISTRY, analysis.primary)
  assert.ok(rows.length >= 2)
  assert.equal(rows[0].model.key, 'zhipu') // coding 0.9 > 0.88
  assert.ok(rows[0].score > rows[1].score)
})

test('pipeline：vision 任务被 requireVision 过滤后只剩视觉模型', () => {
  const rows = rankModels(REGISTRY, 'vision', { requireVision: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model.key, 'vision')
})

test('pipeline：perf 落盘 → 读回 → 汇总', () => {
  logPerf({ kind: 'execute', model: 'zhipu', capability: 'coding', spentMs: 1234, latencyMs: 1200, success: true })
  logPerf({ kind: 'execute', model: 'zhipu', capability: 'coding', spentMs: 987, latencyMs: 800, success: false })
  const rows = readPerf(10)
  assert.ok(rows.length >= 2)
  const last = rows[rows.length - 1]
  assert.equal(last.model, 'zhipu')
  assert.equal(last.success, false)
  const sum = summarize(rows)
  assert.equal(sum.length, 1)
  assert.equal(sum[0].model, 'zhipu')
  assert.equal(sum[0].capability, 'coding')
  assert.equal(sum[0].n, 2)
  assert.equal(sum[0].successRate, 0.5)
})

test('pipeline：执行质检提取 + intel actual 回写闭环', () => {
  // Verifier 面：assistant 答案提取
  const text = extractAssistantText('这是一个可直接使用的字符串答案')
  assert.ok(text.length > 0)

  // declared 层写入 → effectiveScore 读回
  upsertCapabilities('zhipu', 'declared', { coding: 0.9 })
  const before = effectiveScore('zhipu', 'coding')
  assert.equal(before.layer, 'declared')
  assert.equal(before.score, 0.9)

  // actual 回写：n≥1 即落盘（n<2 标 lowConfidence 降权），actual 优先于 declared
  const changed = syncActualFromPerf([
    { model: 'zhipu', capability: 'coding', n: 5, successRate: 0.8, avgLatencyMs: 100 },
  ])
  assert.equal(changed, true)
  const after = effectiveScore('zhipu', 'coding')
  assert.equal(after.layer, 'actual')
  assert.ok(Math.abs(after.score - 0.9) < 1e-6) // 0.5 + 0.5×0.8
})

test('pipeline：单样本写入 actual 但标低置信（冷启动可见，权重降为 0.85）', () => {
  const changed = syncActualFromPerf([
    { model: 'deepseek', capability: 'reasoning', n: 1, successRate: 1.0, avgLatencyMs: 10 },
  ])
  assert.equal(changed, true)
  const eff = effectiveScore('deepseek', 'reasoning')
  assert.equal(eff.layer, 'actual')
  assert.ok(Math.abs(eff.score - 1.0) < 1e-6) // 0.5 + 0.5×1.0
  assert.equal(eff.weight, 0.85) // lowConfidence：单样本不足以压过 research 层级
})