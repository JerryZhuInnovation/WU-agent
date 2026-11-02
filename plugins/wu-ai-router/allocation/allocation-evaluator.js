/**
 * Allocation Evaluator — 三级决策引擎（§五）。
 *
 * 第一级：程序化硬约束过滤（机制 3）—— 模态/无环/执行者存在性/禁止自审，
 *         一票否决，绝不靠模型投票妥协。
 * 第二级：五维加权评分（机制 4 的账本证据接入）——
 *         能力匹配 30% + 历史验证 25% + 覆盖与依赖 20% + 成本 15% + 鲁棒性 10%；
 *         高风险任务压低成本权重、拉高历史与覆盖权重。
 * 第三级：证据充分性三态 —— EXECUTABLE / TRIAL_FIRST / HOLD_FOR_CONFIRMATION。
 *         不输出「置信度 92%」这类未经校准的伪数字。
 *
 * 模型选择在此完成（与任务分解分离）：按能力 rankModels + 账本证据分配，
 * Reviewer/Verifier 强制避开全部 Worker（禁止自审）。
 */

import { rankModels } from '../registry.js'
import { getEvidence } from './model-performance.js'
import { modelFamily } from './task-analyzer.js'

function hasCycle(steps) {
  const graph = new Map(steps.map((s) => [s.id, s.dependsOn || []]))
  const visited = new Set()
  const visiting = new Set()
  const dfs = (node) => {
    if (visiting.has(node)) return true
    if (visited.has(node)) return false
    visiting.add(node)
    for (const dep of graph.get(node) || []) if (dfs(dep)) return true
    visiting.delete(node)
    visited.add(node)
    return false
  }
  for (const s of steps) if (dfs(s.id)) return true
  return false
}

/**
 * 给方案里的每一步程序化分配模型。返回 assignments（stepId → 模型与依据）。
 * Reviewer/Verifier 尽量避开 Worker 集合；同族可选时优先异族（独立性更强）。
 */
export function assignModels(plan, opts) {
  const { registry, taskSpec, rankOpts = {} } = opts
  const workerKeys = new Set(
    plan.steps.filter((s) => s.role === 'Worker').map((s) => rankedFor(registry, s, rankOpts)[0]?.model?.key).filter(Boolean),
  )
  /** @type {Record<string, { key: string, provider: string, model: string, basis: string }>} */
  const assignments = {}
  for (const step of plan.steps) {
    const ranked = rankedFor(registry, step, rankOpts)
    const needsIndependent = step.role === 'Reviewer' || step.role === 'Verifier'
    let pick = null
    let basis = ''
    if (needsIndependent) {
      const independent = ranked.filter((r) => !workerKeys.has(r.model.key))
      const crossFamily = independent.filter((r) => ![...workerKeys].some((w) => familyOf(registry, w) === modelFamily(r.model)))
      const finalPool = crossFamily.length ? crossFamily : independent
      pick = finalPool[0] || null
      basis = pick ? (crossFamily.length ? '异族独立审查者' : '独立审查者（非执行者）') : ''
      if (!pick && (taskSpec.complexity === 'complex' || taskSpec.riskLevel === 'high')) {
        // 高风险/复杂任务：找不到独立审查者是硬伤（禁止自审），交给硬约束层否决
        assignments[step.id] = null
        continue
      }
      if (!pick) pick = ranked[0] || null // 低风险：退而求其次，但在依据里写明
      if (pick && !basis) basis = '无独立候选，临时由执行者兼任（低风险）'
    } else {
      pick = ranked[0] || null
      basis = pick ? `能力「${step.capability}」评分第一${pick.fallbackGeneral ? '（无该能力声明，按通用分）' : ''}` : ''
    }
    assignments[step.id] = pick
      ? { key: pick.model.key, provider: pick.model.provider, model: pick.model.model, basis }
      : null
  }
  return assignments
}

function rankedFor(registry, step, rankOpts) {
  return rankModels(registry, step.capability, {
    requireVision: step.capability === 'vision',
    fallbackGeneral: true, // 无声明能力 → 按通用分，评估照样进行（依据里注明）
    ...rankOpts,
  })
}

function familyOf(registry, key) {
  return modelFamily(registry.find((m) => m.key === key))
}

export class AllocationEvaluator {
  /**
   * @param {import('./model-performance.js').getEvidence} [ledgerGet] 便于测试注入
   */
  constructor(ledgerGet = getEvidence) {
    this.getEvidence = ledgerGet
  }

  /**
   * @param {{
   *   taskSpec: object,
   *   planningResult: object,
   *   registry: object[],
   *   runtimeEnv?: { sandboxAvailable?: boolean, authorizedFileWrite?: boolean },
   *   rankOpts?: object,
   * }} input
   */
  evaluate({ taskSpec, planningResult, registry, runtimeEnv = {}, rankOpts = {} }) {
    const allEvaluated = []
    for (const plan of planningResult.candidates) {
      const assignments = assignModels(plan, { registry, taskSpec, rankOpts })
      const hardViolations = this._checkHardConstraints(plan, taskSpec, assignments, runtimeEnv)
      const { dimensions, totalScore, uncertainties } = this._scorePlanDimensions(
        plan,
        taskSpec,
        assignments,
        planningResult.redTeamCritiques || [],
      )
      allEvaluated.push({ plan, assignments, passedHardConstraints: hardViolations.length === 0, hardViolations, dimensions, totalScore, uncertainties })
    }

    const valid = allEvaluated.filter((c) => c.passedHardConstraints).sort((a, b) => b.totalScore - a.totalScore)
    return this._decide(valid, allEvaluated, planningResult, taskSpec)
  }

  /** 第一级：规则引擎一票否决（机制 3）。 */
  _checkHardConstraints(plan, taskSpec, assignments, runtimeEnv) {
    const violations = []
    if (!plan.steps?.length) {
      violations.push('方案未包含任何可执行步骤')
      return violations
    }
    if (hasCycle(plan.steps)) violations.push('任务依赖图存在循环依赖')
    if (taskSpec.requiresSandboxExec && runtimeEnv.sandboxAvailable === false) {
      violations.push('任务要求运行代码验证，但当前沙箱执行环境不可用')
    }
    if (taskSpec.requiresFileWrite && runtimeEnv.authorizedFileWrite === false) {
      violations.push('任务涉及文件写入，但当前环境的受控写入不可用')
    }
    const workerKeys = new Set()
    for (const step of plan.steps) {
      const a = assignments[step.id]
      if (!a) {
        violations.push(`步骤 ${step.id}（${step.capability}）找不到合格模型`)
        continue
      }
      // 视觉步骤的模态资格已由 assignModels → rankModels(requireVision) 程序化过滤
      if (step.role === 'Worker') workerKeys.add(a.key)
    }
    // 机制 4 底线：复杂/高风险任务禁止「自己给自己打分」
    if (taskSpec.complexity === 'complex' || taskSpec.riskLevel === 'high') {
      for (const step of plan.steps) {
        const a = assignments[step.id]
        if (!a) continue
        if ((step.role === 'Reviewer' || step.role === 'Verifier') && workerKeys.has(a.key)) {
          violations.push(`违反独立验证原则：${a.key} 既执行又担任 ${step.role}`)
        }
      }
    }
    return violations
  }

  /** 第二级：五维加权评分。 */
  _scorePlanDimensions(plan, taskSpec, assignments, critiques) {
    const uncertainties = []
    const planCritiques = critiques.filter((c) => !c.targetPlanId || c.targetPlanId === plan.planId)

    let capSum = 0
    let histSum = 0
    for (const step of plan.steps) {
      const a = assignments[step.id]
      if (a) {
        // 能力匹配：本步在候选池排首位记 1.0（assignModels 已按序取首位）；
        // 被红队点名能力错配的方案整体降档。
        const mismatch = planCritiques.some((c) => c.issueType === 'CAPABILITY_MISMATCH')
        capSum += mismatch ? 0.55 : 0.95
        const ev = this.getEvidence(a.key, step.capability, step.role)
        if (ev.confidenceStatus === 'INSUFFICIENT_SAMPLES') {
          uncertainties.push(`模型 ${a.key} 在 [${step.capability}:${step.role}] 样本仅 ${ev.sampleSize} 次`)
        }
        histSum += ev.smoothedScore
      } else {
        capSum += 0
        histSum += 0.5
      }
    }
    const n = plan.steps.length || 1
    const capabilityMatch = capSum / n
    const historicalPerf = histSum / n

    const missing = planCritiques.filter((c) => c.issueType === 'MISSING_STEP').length
    const strong = taskSpec.strongCapabilities || []
    const covered = strong.filter((cap) => plan.steps.some((s) => s.capability === cap)).length
    const coverageBase = strong.length ? covered / strong.length : 0.8
    const coverageAndDag = Math.max(0, Math.min(1, coverageBase - missing * 0.3))
    if (missing > 0) uncertainties.push(`红队指出 ${missing} 处疑似关键步骤遗漏`)

    const overEng = planCritiques.some((c) => c.issueType === 'OVER_ENGINEERING')
    const costAndLatency = overEng ? 0.5 : Math.max(0.4, 1 - (plan.steps.length - 1) * 0.12)
    const robustness = String(plan.fallbackStrategy || '').length > 5 ? 0.9 : 0.4

    const weights =
      taskSpec.riskLevel === 'high'
        ? { cap: 0.3, hist: 0.35, cov: 0.25, cost: 0.02, rob: 0.08 }
        : { cap: 0.3, hist: 0.25, cov: 0.2, cost: 0.15, rob: 0.1 }
    const totalScore = Number(
      (
        capabilityMatch * weights.cap +
        historicalPerf * weights.hist +
        coverageAndDag * weights.cov +
        costAndLatency * weights.cost +
        robustness * weights.rob
      ).toFixed(3),
    )
    return {
      dimensions: {
        capabilityMatch: Number(capabilityMatch.toFixed(2)),
        historicalPerf: Number(historicalPerf.toFixed(2)),
        coverageAndDag: Number(coverageAndDag.toFixed(2)),
        costAndLatency: Number(costAndLatency.toFixed(2)),
        robustness: Number(robustness.toFixed(2)),
      },
      totalScore,
      uncertainties,
    }
  }

  /** 第三级：证据强度 → 三态决策（不产伪置信度数字）。 */
  _decide(valid, allEvaluated, planningResult, taskSpec) {
    if (!valid.length) {
      return {
        state: 'HOLD_FOR_CONFIRMATION',
        reason: '所有候选分工方案均违反硬约束（已拦截自动执行）',
        selected: null,
        allEvaluated,
      }
    }
    const best = valid[0]
    const divergence = planningResult.divergenceReport || { hasMajorConflict: false, conflicts: [] }
    const highRiskUncertain = taskSpec.riskLevel === 'high' && best.dimensions.historicalPerf < 0.75
    const needsTrial = best.uncertainties.length > 0 || divergence.hasMajorConflict || highRiskUncertain
    if (needsTrial) {
      const probeStepId =
        (best.plan.steps.find((s) => s.role === 'Worker') || best.plan.steps[0]).id
      return {
        state: 'TRIAL_FIRST',
        reason: divergence.hasMajorConflict
          ? `独立规划者存在分歧（${divergence.conflicts[0]}），先对关键步骤做低成本试运行`
          : `存在未证实假设（${best.uncertainties[0]}），先做低成本试运行`,
        selected: best,
        probeStepId,
        allEvaluated,
      }
    }
    return {
      state: 'EXECUTABLE',
      reason: '硬约束全部通过，证据充分且无重大分歧',
      selected: best,
      probeStepId: null,
      allEvaluated,
    }
  }
}

/** 评估结果 → executeDAG 兼容格式（能力级 DAG；模型选择仍留给调度器按证据执行）。 */
export function toDagPlan(selected) {
  if (!selected?.plan) return null
  return {
    steps: selected.plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      capability: s.capability,
      dependsOn: s.dependsOn,
      acceptance: s.acceptance,
    })),
    frozen: true,
    roleByStep: Object.fromEntries(selected.plan.steps.map((s) => [s.id, s.role])),
  }
}
