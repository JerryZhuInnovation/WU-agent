/**
 * Context Manager（上下文管理器）—— 多模型协作的上下文独立层。
 *
 * 设计来源：2026-10-12 外部方案《模型切换时不应传递完整对话历史》，落地其
 * V0.1（任务状态与上下文构建）+ V0.2（多模型上下文裁剪 + 产物交接）。
 *
 * 四层模型（本模块实现 L0/L1/L2；L3 完整历史留在 DSH 会话里不碰）：
 * - L0 全局规则：语言/输出规范（由调用方的系统段承担，不在此重复注入）
 * - L1 任务摘要：goal / constraints / confirmedFacts / openQuestions
 * - L2 子任务上下文：当前子步的能力要求 + 上游产物摘要（非全文）
 * - L3 完整历史与产物仓库：全文落盘 artifact store，按需引用
 *
 * 边界（为什么放在路由插件而不是 Python core/）：
 * 本模块只影响「路由器构造的调用」（multi 子模型 / verifier / brain），
 * 不触碰 DSH 的会话历史管理——那是宿主的地盘，也符合 V0.1 的
 * 「保留完整原始历史」原则。
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { SYSTEMS } from './prompts.js'
import { join } from 'node:path'

/** 子模型上下文预算（字符）。≈1000 tokens；约束事实永不裁剪。 */
export const SUBTASK_BUDGET_CHARS = 3000
/** 上游产物摘要的最大长度（全文进 store，子上下文只带摘要）。 */
export const ARTIFACT_SUMMARY_CHARS = 240
/** 同会话内判定「任务变了」的 goal 前缀比对长度。 */
const GOAL_SIGNATURE_CHARS = 80

/** 粗估 token（中文 ≈1.5 chars/token，英文 ≈4 chars/token，取 3 折中）。 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / 3)
}

/**
 * 创建/恢复任务状态。
 * @param {string} sessionId
 * @param {string} dshHome  DSH_HOME 绝对路径（artifact store 落盘根）
 */
export function createTaskState(sessionId, dshHome) {
  const sid = String(sessionId || 'session').slice(-16)
  return {
    sessionId,
    taskId: `task_${sid}`,
    goal: '',
    goalSignature: '',
    constraints: [],
    confirmedFacts: [],
    openQuestions: [],
    artifacts: [],
    completedSteps: [],
    dshHome: String(dshHome || ''),
  }
}

/** 从 Brain 分析结果提炼任务状态（V0.1：结构化，不调用额外模型）。 */
export function updateFromAnalysis(state, analysis) {
  if (!state || !analysis) return state
  const text = String(analysis.text || '')
  const signature = text.slice(0, GOAL_SIGNATURE_CHARS)
  // 任务变更检测：主能力或任务文本签名变了 → 新任务，重置（保留 artifacts 仓库不删）
  const changed = !state.goalSignature || state.goalSignature !== signature
  if (changed) {
    state.goal = text.slice(0, 400)
    state.goalSignature = signature
    state.constraints = []
    state.confirmedFacts = []
    state.openQuestions = []
    state.completedSteps = []
  }
  // requirements → 约束（importance≥0.75 的能力需求视为硬性要求）
  for (const r of analysis.requirements || []) {
    const line = `${r.capability}(重要性 ${Number(r.importance).toFixed(2)})`
    if (Number(r.importance) >= 0.75 && !state.constraints.includes(line)) {
      state.constraints.push(line)
    }
  }
  if (analysis.needsImage && !state.constraints.includes('包含图片输入')) {
    state.constraints.push('包含图片输入')
  }
  return state
}

/** 从质检结论更新任务状态：gaps → openQuestions，通过 → completedSteps。 */
export function updateFromVerify(state, report) {
  if (!state || !report) return state
  if (report.pass) {
    if (report.score !== undefined) {
      state.completedSteps.push(`质检通过 score=${Number(report.score).toFixed(2)}`)
    }
  } else if (report.gaps) {
    for (const g of String(report.gaps).split(/[；;\n]/).map((s) => s.trim()).filter(Boolean)) {
      if (!state.openQuestions.includes(g)) state.openQuestions.push(g)
    }
  }
  return state
}

/**
 * 产物登记：摘要进 state.artifacts，全文落盘 artifact store。
 * @returns {{artifactId: string, summary: string} | null}
 */
export function addArtifact(state, { type, summary, text, source }) {
  if (!state || !text) return null
  const n = state.artifacts.length + 1
  const artifactId = `${state.taskId}_art${n}`
  const one = { artifactId, type: String(type || 'result'), source: String(source || ''), version: 1 }
  state.artifacts.push(one)
  try {
    if (state.dshHome) {
      const dir = join(state.dshHome, 'wu-ai-context')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `${artifactId}.json`),
        JSON.stringify({ ...one, summary: String(summary || '').slice(0, ARTIFACT_SUMMARY_CHARS * 4), text: String(text) }, null, 2),
        { encoding: 'utf-8' },
      )
    }
  } catch {
    /* store 不可写不阻断路由（快照目录只读等），摘要仍在内存可用 */
  }
  return one
}

/** 读取产物全文（L3 → L2 的显式升级路径；当前由测试覆盖，预留给按需检索）。 */
export function readArtifact(state, artifactId) {
  if (!state?.dshHome) return null
  try {
    const raw = readFileSync(join(state.dshHome, 'wu-ai-context', `${artifactId}.json`), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 构建子任务上下文（multi 子模型用）。每次调用按需重建（文档 §四 关键实现细节）。
 *
 * 预算选择顺序（§四）：
 *   1. 本步直接输入（能力要求 + 指令）
 *   2. 硬约束 / 已确认事实 —— 永不裁剪
 *   3. 上游产物摘要
 *   4. 任务目标全文（预算不足时截断，而非丢约束）
 */
export function buildSubtaskContext(state, need, { budget = SUBTASK_BUDGET_CHARS } = {}) {
  const head = [
    SYSTEMS.subtaskWorker,
    `【本步能力】${need.capability}（importance=${need.importance}）`,
    `【本步要求】针对总任务，只完成与「${need.capability}」相关的部分，给出可交接的结论/要点/伪代码。`,
  ]
  const fixed = head.join('\n\n')
  let remaining = Math.max(budget - estimateTokens(fixed) * 3, 400)

  // L2：上游产物摘要（只带 summary，全文留在 store；来源计数供 perf 用）
  const upstream = (state?.artifacts || [])
    .slice(-3)
    .map((a) => ({ ...a }))
  const upstreamLines = upstream.map((a) => `- [${a.type}] ${a.artifactId}：${a.summary || ''}`)

  // L1：任务摘要。约束与事实优先且不裁；goal 在预算吃紧时先截断
  const constraints = (state?.constraints || []).slice(0, 6)
  const facts = (state?.confirmedFacts || []).slice(0, 4)
  const open = (state?.openQuestions || []).slice(0, 3)
  const l1 = [
    `【任务目标】${goalWithinBudget(state?.goal || '', remaining, constraints, facts)}`,
    constraints.length ? `【硬性约束】\n${constraints.map((c) => `- ${c}`).join('\n')}` : '',
    facts.length ? `【已确认事实】\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
    open.length ? `【待解决问题】\n${open.map((q) => `- ${q}`).join('\n')}` : '',
  ].filter(Boolean)

  let body = [...l1, upstreamLines.length ? `【上游结论（摘要）】\n${upstreamLines.join('\n')}` : '']
    .filter(Boolean)
    .join('\n\n')
  // 兜底：整体仍超预算 → 截断 goal 段以外的中段，保留首尾结构
  if (estimateTokens(body) * 3 > remaining) {
    body = body.slice(0, remaining)
  }
  return { prompt: `${fixed}\n\n${body}`, sourceCount: 1 + upstream.length }
}

/** goal 的可用长度：总预算扣掉约束与事实占用后，夹在 [300, 1200] 之间。 */
function goalWithinBudget(goal, remaining, constraints, facts) {
  const usedByFixed = estimateTokens(constraints.join('')) * 3 + estimateTokens(facts.join('')) * 3
  const limit = Math.min(1200, Math.max(300, remaining - usedByFixed))
  return goal.slice(0, limit)
}

/**
 * 构建质检上下文（verifier 用）：待检文本 + 规格约束 + 验收标准。
 * 不带 Brain 分析全文与上游思考过程（文档表格第四行）。
 */
export function buildVerifyContext(state, answerText, taskText) {
  const constraints = (state?.constraints || []).slice(0, 6)
  const open = (state?.openQuestions || []).slice(0, 3)
  return [
    constraints.length ? `【规格约束】\n${constraints.map((c) => `- ${c}`).join('\n')}` : '',
    open.length ? `【此前未解决】\n${open.map((q) => `- ${q}`).join('\n')}` : '',
    `【任务】${(taskText || '').slice(0, 800)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
