/**
 * Allocation Orchestrator — 把六个分配模块串成一次可审计决策。
 *
 * 数据流（方案 §一）：
 *   TaskSpec(证据A) → 盲态双规划+红队(证据C) → 三级评估(证据B账本) → 三态
 *     EXECUTABLE           → 直接产出 DAG 交既有 executeDAG 执行
 *     TRIAL_FIRST          → 先跑低成本 Probe(证据D)，失败则换该步次优模型
 *     HOLD_FOR_CONFIRMATION → 不产出 DAG（调用方回落既有路径），ADR 留痕 + 前端通知
 *
 * 任何异常都返回 null 让调用方回落单规划/线性 multi —— 分配层故障不得阻断任务。
 * 复杂度自适应：simple 任务不进分配层（避免过度设计）。
 */

import { buildTaskSpec, runtimeFacts } from './task-analyzer.js'
import { generateAuditablePlans } from './plan-generator.js'
import { AllocationEvaluator, toDagPlan } from './allocation-evaluator.js'
import { createADR } from './decision-log.js'
import { rankModels } from '../registry.js'
import { runOne } from '../multi.js'

const PROBE_TIMEOUT_MS = 30_000

export const STATE_LABEL = {
  EXECUTABLE: '🟢 可执行',
  TRIAL_FIRST: '🟡 先试运行',
  HOLD_FOR_CONFIRMATION: '🔴 待确认',
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   sessionId: string,
 *   analysis: object,
 *   registry: object[],
 *   engine: object,
 *   reliability?: Map<string, number>,
 *   prefer?: Record<string, string>,
 *   costWeight?: number,
 *   latencyWeight?: number,
 *   sandboxEnforced?: boolean,
 *   callModel?: (input: object) => Promise<string>,
 *   logLine?: (s: string) => void,
 *   onUsage?: (usage: unknown, meta: object) => void,
 *   pushNotice?: (s: string) => void,
 * }} opts
 * @returns {Promise<null | { plan: object, adr: object, state: string, reason: string, probed: boolean }>}
 */
export async function runAllocation(ctx, opts) {
  const log = opts.logLine || (() => {})
  try {
    const taskSpec = buildTaskSpec(opts.analysis)
    // 简单任务直通：一个模型 + 规则校验就够，双盲规划纯属浪费（方案 §机制1 注意项）
    if (taskSpec.complexity === 'simple') return null

    const planning = await generateAuditablePlans(ctx, {
      taskSpec,
      analysis: opts.analysis,
      registry: opts.registry,
      engine: opts.engine,
      callModel: opts.callModel,
      onUsage: opts.onUsage,
      logLine: log,
    })
    if (!planning) return null

    const evaluator = new AllocationEvaluator()
    const evaluation = evaluator.evaluate({
      taskSpec,
      planningResult: planning,
      registry: opts.registry,
      runtimeEnv: runtimeFacts(opts.registry, { sandboxEnforced: opts.sandboxEnforced }),
      rankOpts: {
        reliability: opts.reliability,
        prefer: opts.prefer,
        costWeight: opts.costWeight,
        latencyWeight: opts.latencyWeight,
      },
    })
    const adr = createADR({ sessionId: opts.sessionId, taskSpec, planningResult: planning, evaluation })
    log(`alloc ${adr.adrId} state=${evaluation.state} score=${evaluation.selected?.totalScore ?? '-'} conflicts=${planning.divergenceReport.conflicts.length} critiques=${planning.redTeamCritiques.length}`)
    opts.pushNotice?.(`任务分配决策 ${STATE_LABEL[evaluation.state] || evaluation.state}：${evaluation.reason}`)

    if (evaluation.state === 'HOLD_FOR_CONFIRMATION' || !evaluation.selected) {
      return null // 回落既有路径；ADR 已留痕，通知已推送
    }

    let selected = evaluation.selected
    let probed = false

    // 证据 D：TRIAL_FIRST → 用第一个 Worker 步做低成本探针，不合格就换次优模型
    if (evaluation.state === 'TRIAL_FIRST' && evaluation.probeStepId) {
      const step = selected.plan.steps.find((s) => s.id === evaluation.probeStepId)
      const assignment = selected.assignments?.[step?.id]
      if (step && assignment) {
        probed = true
        const probeText = await runProbe(ctx, {
          step,
          assignment,
          analysis: opts.analysis,
          callModel: opts.callModel,
          onUsage: opts.onUsage,
        })
        if (!probeText) {
          const alt = nextModelFor(opts.registry, step, assignment.key, {
            reliability: opts.reliability,
            prefer: opts.prefer,
            costWeight: opts.costWeight,
            latencyWeight: opts.latencyWeight,
          })
          if (alt) {
            selected = {
              ...selected,
              assignments: { ...selected.assignments, [step.id]: { ...alt, basis: `探针未通过，回退换模型（原 ${assignment.key}）` } },
            }
            log(`alloc probe failed step=${step.id} ${assignment.key} -> fallback ${alt.key}`)
            opts.pushNotice?.(`试运行未达标（${step.title}），已切换备用模型 ${alt.key}`)
          } else {
            log(`alloc probe failed step=${step.id}, no alternative model`)
          }
        } else {
          log(`alloc probe ok step=${step.id} model=${assignment.key}`)
        }
      }
    }

    const plan = toDagPlan(selected)
    if (!plan) return null
    return { plan, adr, state: evaluation.state, reason: evaluation.reason, probed }
  } catch (e) {
    log(`alloc error ${String(e)}`)
    return null
  }
}

/** 低成本探针：让候选模型完成该步的浓缩版任务，产出非空即视为通过（证据 D）。 */
async function runProbe(ctx, { step, assignment, analysis, callModel = (input) => runOne(ctx, input), onUsage }) {
  const prompt = [
    '你是 WU ai 的试运行探针。请完成下面这个小任务，输出简洁但完整的核心结果。',
    `【所属总任务】${String(analysis?.text || '').slice(0, 600)}`,
    `【本步】${step.title}（能力 ${step.capability}）`,
    step.acceptance.length ? `【验收标准】\n${step.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const text = await callModel({
      provider: assignment.provider,
      model: assignment.model,
      prompt,
      maxTokens: 400,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    return text && text.length >= 2 ? text : null
  } catch {
    return null
  }
}

/** 探针失败后的次优模型：跳过刚失败的 key，**优先换不同家族**（异构回退）。
 *  同族模型共用同一套协议/训练谱系，失败模式高度相关——原地换个同族兄弟
 *  等于没换（2026-11-01 去偏见化）。 */
function nextModelFor(registry, step, failedKey, rankOpts) {
  const ranked = rankModels(registry, step.capability, {
    requireVision: step.capability === 'vision',
    fallbackGeneral: true,
    ...rankOpts,
  })
  const pool = ranked.map((r) => r.model).filter((m) => m.key !== failedKey)
  if (!pool.length) return null
  const failedFamily = familyOf(registry, failedKey)
  return pool.find((m) => modelFamily(m) !== failedFamily) || pool[0]
}
