/**
 * Model Performance Ledger — 按「模型 × 任务类型 × 角色」的真实表现账本（证据 B）。
 *
 * 《可验证的任务分配决策机制》(2026-10-26) 机制 4：不能相信模型注册信息里的
 * 「擅长代码」自述，也不能相信其他模型的评价 —— 要逐步建立自己的能力记录。
 * 拒绝笼统的「综合能力分」，按 taskType:role 粒度记录任务级数据：
 *   验收通过率 / 返工率 / 平均耗时 / 样本量（+ 置信状态），供分配评估引用。
 *
 * 存储与 perf.jsonl 同级（$DSH_HOME/wu-ai-model-ledger.json）：
 * perf 是流水埋点，这里是聚合账本 —— 各自独立损坏互不拖垮。
 * 小样本用拉普拉斯平滑防极端值（1 次成功 ≠ 100% 可靠）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 少于该样本数一律标记「样本不足」，评估层据此把方案压向 TRIAL_FIRST。 */
export const MIN_RELIABLE_SAMPLES = 10

function home() {
  return process.env.DSH_HOME || join(process.env.HOME || '', '.wu-ai', 'dsh')
}

function ledgerPath() {
  return join(home(), 'wu-ai-model-ledger.json')
}

/** @returns {Record<string, any>} */
function load() {
  try {
    const raw = readFileSync(ledgerPath(), 'utf8')
    const db = JSON.parse(raw)
    if (db && typeof db === 'object' && db.records && typeof db.records === 'object') return db
  } catch {
    /* 缺失/损坏都按空账本起 —— 账本故障不得影响路由主流程 */
  }
  return { version: 1, updated: null, records: {} }
}

function save(db) {
  try {
    db.updated = new Date().toISOString()
    const file = ledgerPath()
    mkdirSync(dirname(file), { recursive: true })
    // 原子替换：半截 JSON 会让整份账本被兜底逻辑丢弃
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(db), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 账本写失败只丢一次统计，不抛错 */
  }
}

const keyOf = (modelKey, taskType, role) => `${modelKey}::${taskType}::${role}`

function blankRecord() {
  return {
    totalRuns: 0,
    passedCount: 0,
    reworkCount: 0,
    truePositives: 0, // Reviewer：发现的真实缺陷
    falsePositives: 0, // Reviewer：误报
    totalLatencyMs: 0,
    totalTokens: 0, // 有 usage 记 token；没有可靠单价，不伪造成本数字
  }
}

/**
 * 证据 B：某模型在某类任务的某角色下的历史表现（带平滑与置信状态）。
 */
export function getEvidence(modelKey, taskType, role, db = null) {
  const store = db || load()
  const rec = store.records[keyOf(modelKey, taskType, role)] || blankRecord()
  const n = rec.totalRuns
  const smoothedPassRate = (rec.passedCount + 1) / (n + 2)
  const reworkRate = n > 0 ? rec.reworkCount / n : 0
  return {
    modelKey,
    taskType,
    role,
    sampleSize: n,
    confidenceStatus: n >= MIN_RELIABLE_SAMPLES ? 'RELIABLE' : 'INSUFFICIENT_SAMPLES',
    passRate: n > 0 ? Number((rec.passedCount / n).toFixed(3)) : null,
    // 平滑通过率 × 返工折损：返工越多，历史分越低（上限折损 50%）
    smoothedScore: Number((smoothedPassRate * (1 - reworkRate * 0.5)).toFixed(3)),
    reworkRate: Number(reworkRate.toFixed(3)),
    avgLatencyMs: n > 0 ? Math.round(rec.totalLatencyMs / n) : null,
    avgTokens: n > 0 ? Math.round(rec.totalTokens / n) : null,
  }
}

/**
 * 任务终局（验收完成 / 用户回滚）后回写客观结果。
 * @param {{
 *   modelKey: string, taskType: string, role: string,
 *   passed?: boolean, reworked?: boolean, latencyMs?: number, totalTokens?: number,
 *   reviewStats?: { truePositives?: number, falsePositives?: number },
 * }} input
 */
export function recordOutcome(input) {
  if (!input?.modelKey || !input?.taskType || !input?.role) return
  const db = load()
  const k = keyOf(input.modelKey, input.taskType, input.role)
  if (!db.records[k]) db.records[k] = blankRecord()
  const rec = db.records[k]
  rec.totalRuns += 1
  if (input.passed) rec.passedCount += 1
  if (input.reworked) rec.reworkCount += 1
  rec.totalLatencyMs += Math.max(0, Number(input.latencyMs) || 0)
  rec.totalTokens += Math.max(0, Number(input.totalTokens) || 0)
  if (input.role === 'Reviewer' && input.reviewStats) {
    rec.truePositives += Number(input.reviewStats.truePositives) || 0
    rec.falsePositives += Number(input.reviewStats.falsePositives) || 0
  }
  save(db)
}

/** 供控制中心展示：每个 model::taskType::role 一行摘要（按样本量倒序）。 */
export function summarizeLedger(limit = 20) {
  const db = load()
  const rows = []
  for (const [k, rec] of Object.entries(db.records || {})) {
    const [modelKey, taskType, role] = k.split('::')
    const ev = getEvidence(modelKey, taskType, role, db)
    rows.push({
      modelKey,
      taskType,
      role,
      sampleSize: ev.sampleSize,
      confidence: ev.confidenceStatus,
      passRate: ev.passRate,
      smoothedScore: ev.smoothedScore,
      reworkRate: ev.reworkRate,
      avgLatencyMs: ev.avgLatencyMs,
    })
  }
  rows.sort((a, b) => b.sampleSize - a.sampleSize)
  return rows.slice(0, limit)
}
