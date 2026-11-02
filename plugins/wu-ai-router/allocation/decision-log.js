/**
 * Decision Log — Allocation Decision Record（ADR）持久层（§三.2 / 实施步骤 4）。
 *
 * 每次任务分配生成一份结构化决策记录：任务需求契约、候选方案对比与淘汰原因、
 * 选定方案的角色责任边界、不确定性标记（区分有证据/仅推测）、红队质疑、回退预案。
 * 执行结束后回填事后归因 —— 后续失败才能区分是「拆分错了」「模型选错了」
 * 还是「验收标准不充分」。
 *
 * 落盘 $DSH_HOME/wu-ai-adr/adr_<ts>_<rand>.json；控制中心经 /api/workspace 只读展示。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function home() {
  return process.env.DSH_HOME || join(process.env.HOME || '', '.wu-ai', 'dsh')
}

function adrDir() {
  return join(home(), 'wu-ai-adr')
}

let seq = 0

/** @returns {string} adrId */
export function createADR({ sessionId, taskSpec, planningResult, evaluation }) {
  seq += 1
  const adrId = `adr_${Date.now()}_${seq}`
  const selected = evaluation?.selected || null
  const record = {
    adrId,
    timestamp: new Date().toISOString(),
    sessionId: String(sessionId || ''),
    decisionState: evaluation?.state || 'UNKNOWN',
    decisionReason: String(evaluation?.reason || ''),

    taskRequirements: {
      taskType: taskSpec?.taskType || 'general',
      complexity: taskSpec?.complexity || 'simple',
      riskLevel: taskSpec?.riskLevel || 'low',
      strongCapabilities: taskSpec?.strongCapabilities || [],
      requiredModalities: taskSpec?.requiredModalities || ['text'],
    },

    planning: {
      mode: planningResult?.planningMode || null,
      plannersUsed: planningResult?.plannersUsed || [],
      challengerKey: planningResult?.challengerKey || null,
    },

    candidateComparison: (evaluation?.allEvaluated || []).map((c) => ({
      planId: c.plan?.planId,
      summary: c.plan?.strategySummary,
      passedHardConstraints: c.passedHardConstraints,
      hardViolations: c.hardViolations,
      dimensions: c.dimensions,
      totalScore: c.totalScore,
    })),

    selectedAllocation: selected
      ? selected.plan.steps.map((s, i) => {
          const a = selected.assignments?.[s.id]
          return {
            stepId: s.id,
            title: s.title,
            capability: s.capability,
            role: s.role,
            model: a?.key || null,
            assignmentBasis: a?.basis || '',
            mustDo: s.responsibility,
            mustNotDo: s.nonResponsibility,
            verification: s.verificationMethod,
            acceptance: s.acceptance,
          }
        })
      : null,

    uncertaintiesAndCritiques: {
      uncertainties: selected?.uncertainties || [],
      plannerConflicts: planningResult?.divergenceReport?.conflicts || [],
      redTeamCritiques: planningResult?.redTeamCritiques || [],
    },

    fallbackPlan: selected?.plan?.fallbackStrategy || '回退既有单模型路由',
    dimensions: selected?.dimensions || null,
    totalScore: selected?.totalScore ?? null,
    probeStepId: evaluation?.probeStepId || null,

    postExecutionAudit: null,
  }

  try {
    mkdirSync(adrDir(), { recursive: true })
    writeFileSync(join(adrDir(), `${adrId}.json`), JSON.stringify(record, null, 2), 'utf8')
  } catch {
    /* ADR 写失败不影响执行；缺记录本身就是「决策不可追溯」的信号，由调用方决定是否告警 */
  }
  return record
}

/** 执行结束后回填归因。rootCause ∈ DECOMPOSITION_ERROR | MODEL_MISMATCH | EXEC_FAILURE | null */
export function appendExecutionAudit(adrId, audit) {
  if (!adrId) return
  const file = join(adrDir(), `${adrId}.json`)
  try {
    if (!existsSync(file)) return
    const record = JSON.parse(readFileSync(file, 'utf8'))
    record.postExecutionAudit = {
      completedAt: new Date().toISOString(),
      finalSuccess: Boolean(audit?.finalSuccess),
      failureRootCause: audit?.failureRootCause ?? null,
      reworkCount: Number(audit?.reworkCount) || 0,
      note: String(audit?.note || '').slice(0, 400),
    }
    writeFileSync(file, JSON.stringify(record, null, 2), 'utf8')
  } catch {
    /* 回填失败不影响主流程 */
  }
}

/** 控制中心展示用：最近的 ADR 摘要（新→旧）。 */
export function listADRs(limit = 8) {
  const dir = adrDir()
  let files = []
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith('adr_') && f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, Math.max(1, limit))
  } catch {
    return []
  }
  const rows = []
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      rows.push({
        adrId: r.adrId,
        at: r.timestamp,
        state: r.decisionState,
        reason: r.decisionReason,
        taskType: r.taskRequirements?.taskType,
        riskLevel: r.taskRequirements?.riskLevel,
        planningMode: r.planning?.mode,
        plannersUsed: r.planning?.plannersUsed || [],
        totalScore: r.totalScore,
        dimensions: r.dimensions,
        conflicts: r.uncertaintiesAndCritiques?.plannerConflicts || [],
        uncertainties: r.uncertaintiesAndCritiques?.uncertainties || [],
        critiques: (r.uncertaintiesAndCritiques?.redTeamCritiques || []).length,
        steps: (r.selectedAllocation || []).length,
        audit: r.postExecutionAudit || null,
      })
    } catch {
      /* 单份损坏跳过 */
    }
  }
  return rows
}
