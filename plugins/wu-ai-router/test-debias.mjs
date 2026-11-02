/**
 * 去偏见化回归（2026-11-01）
 *
 * 目标：把「DeepSeek 引力场」的四个机制点钉成可回归的断言：
 *  1) general 黑洞：只声明 general 的模型不再让所有任务塌缩到同一家
 *  2) UCB 探索：冷启动模型获得奖励，样本垄断者被追平
 *  3) 显式偏好：只有用户点名才加分；默认不存在任何锚点
 *  4) 同分洗牌：数组固定顺序不再等于第一顺位
 */

import { buildRegistry, rankModels, explorationBonus, familyOfModel } from './registry.js'
import { rankByIntel } from './brain.js'
import { getEvidence } from './allocation/model-performance.js'
import { assignModels } from './allocation/allocation-evaluator.js'
import { extractAssistantText } from './verifier.js'
import { summarize } from './perf.js'

let failed = 0
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!ok) failed++
}

/* ── 1) general 黑洞：控制中心默认「只有 general 0.85」的旧配置 ─────────── */
const legacyCfg = {
  models: [
    { id: 'deepseek-flash', provider: 'deepseek-flash', model: 'deepseek-flash', label: 'deepseek-flash', capabilities: { coding: 0, vision: 0, reasoning: 0, research: 0, writing: 0, general: 0.85 }, enabled: true },
    { id: 'glm-4.6v', provider: 'glm-4.6v', model: 'glm-4.6v', label: 'glm-4.6v', capabilities: { coding: 0, vision: 0, reasoning: 0, research: 0, writing: 0, general: 0.85 }, enabled: true },
    { id: 'mimo', provider: 'mimo', model: 'mimo-v2.6-flash', label: 'mimo', capabilities: { coding: 0, vision: 0, reasoning: 0, research: 0, writing: 0, general: 0.85 }, enabled: true },
  ],
}
const reg = buildRegistry(legacyCfg)
check(reg.every((m) => m.capsSource === 'prior'), '旧配置（只声明 general）触发性状先验兜底')
check(reg.every((m) => m.capabilities.coding > 0), '先验给了具体能力分，不再只剩 general')

// 视觉任务：只有多模态模型有资格（deepseek 纯文本被硬过滤）
const visionRows = rankModels(reg, 'vision', { requireVision: true })
check(visionRows.length === 1 && visionRows[0].model.key === 'glm-4.6v', `视觉任务只路由给多模态模型，实得 ${visionRows.map((r) => r.model.key)}`)

// 编码任务：不再塌缩到 general —— 排序里必须有 coding 分参与
const codingRows = rankModels(reg, 'coding')
check(codingRows.length >= 2, `编码任务至少 2 个候选（而非全部挤在 general），实得 ${codingRows.length}`)
check(codingRows.every((r) => r.cap >= 0.7), '编码候选能力分来自具体维度（≥0.7），不是 general 的 0.85 冒充')

/* ── 2) UCB 探索奖励 ───────────────────────────────────────────────────── */
check(explorationBonus(0, 50, 0.15) > explorationBonus(20, 50, 0.15), '冷启动模型的探索奖励高于样本垄断者')
check(explorationBonus(0, 50, 0.15) - explorationBonus(20, 50, 0.15) > 0.05, '探索分差足以翻转 actual 历史优势')

// 模拟实际污染：deepseek actual=1（册封），glm/mimo 无样本 → UCB 后 glm/mimo 应能追近
const stats = new Map([['deepseek-flash', 20], ['glm-4.6v', 0], ['mimo', 0]])
const generalRows = rankByIntel(reg, 'general', { runStats: stats })
check(generalRows.length === 3, '三家模型都进入通用任务候选池')
const ds = generalRows.find((r) => r.model.key === 'deepseek-flash')
const other = generalRows.find((r) => r.model.key !== 'deepseek-flash')
check(ds.exploration === 0 || ds.exploration < other.exploration, '样本垄断者的探索奖励低于冷启动者')

/* ── 3) 显式偏好：点名才加分 ───────────────────────────────────────────── */
const explicit = rankModels(reg, 'coding', { prefer: { coding: 'mimo' } })
check(explicit[0].preferred === true && explicit[0].model.key === 'mimo', '用户显式点名的模型被加分并置顶')
const implicit = rankModels(reg, 'coding', {})
check(implicit.every((r) => r.preferred === false), '未点名时不存在任何隐式偏好')

/* ── 4) 同分洗牌：固定顺序不再决定胜负 ─────────────────────────────────── */
const twin = buildRegistry({
  models: [
    { id: 'a', model: 'a', capabilities: { coding: 0.8 }, enabled: true },
    { id: 'b', model: 'b', capabilities: { coding: 0.8 }, enabled: true },
  ],
})
const winners = new Set()
for (let i = 0; i < 40; i++) winners.add(rankModels(twin, 'coding')[0].model.key)
check(winners.size >= 2, `同分时首位会随机化（实得 ${[...winners].join('/')}）`)

/* ── 5) Worker ≠ Verifier：复杂任务禁止自审 ───────────────────────────── */
const plan = {
  steps: [
    { id: 's1', title: '写代码', capability: 'coding', role: 'Worker', dependsOn: [], acceptance: [] },
    { id: 's2', title: '独立核验', capability: 'coding', role: 'Verifier', dependsOn: ['s1'], acceptance: [] },
  ],
}
const assignments = assignModels(plan, { registry: reg, taskSpec: { complexity: 'complex', riskLevel: 'medium' } })
check(assignments.s1 && assignments.s2, '两步都拿到了模型')
check(assignments.s1.key !== assignments.s2.key, `核验者与执行者不同模型（${assignments.s1?.key} vs ${assignments.s2?.key}）`)

/* ── 6) 家族识别与跨族规划者 ───────────────────────────────────────────── */
check(familyOfModel(reg[0]) === 'deepseek' && familyOfModel(reg[1]) === 'zhipu', '家族识别正确（deepseek / zhipu）')

/* ── 7) 账本冷启动：无样本不得给出满分 ─────────────────────────────────── */
const ev = getEvidence('never-used-model', 'coding', 'Worker')
check(ev.smoothedScore === 0.5 && ev.confidenceStatus === 'INSUFFICIENT_SAMPLES', '冷启动账本分 0.5（不虚高、不垫底）')

/* ── 8) 协议归一化：非 DeepSeek 的输出形态不得被判成空答案 ──────────────── */
check(extractAssistantText('<think>先算一下</think>答案是 2') === '答案是 2', '正文内嵌 <think> 时剥掉思维链取正文')
check(extractAssistantText('<think>只有思考</think>') === '只有思考', '只有思维链时退回其内容，不当空答案')
check(
  extractAssistantText([{ type: 'reasoning', text: '推理过程' }]) === '推理过程',
  '只有 reasoning 块时退回其内容（reasoning-only 响应不再记失败）',
)
check(extractAssistantText({ reasoning_content: '原生推理字段' }) === '原生推理字段', '兼容 DeepSeek 原生 reasoning_content 字段')
check(extractAssistantText('普通字符串') === '普通字符串', '纯文本直通不受影响')

/* ── 9) 协议摩擦免责：框架格式问题不得扣模型能力分 ─────────────────────── */
const rows = summarize([
  { kind: 'execute', model: 'glm', capability: 'coding', success: false, protocolFriction: true },
  { kind: 'execute', model: 'glm', capability: 'coding', success: true },
  { kind: 'execute', model: 'glm', capability: 'coding', success: false },
])
const glm = rows.find((r) => r.model === 'glm')
check(glm && glm.n === 2, `协议摩擦样本不入统计（应有 2 次真实样本，实得 ${glm?.n}）`)
check(glm && Math.abs(glm.successRate - 0.5) < 1e-9, `成功率只由真实样本决定（实得 ${glm?.successRate}）`)

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n去偏见化回归全部通过')
