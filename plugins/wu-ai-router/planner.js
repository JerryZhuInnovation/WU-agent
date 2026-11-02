/**
 * Planner + Scheduler（自主任务编排 V1）
 *
 * 来源：外部方案《自主任务编排系统》(2026-10-13)，落地其阶段 02（任务规划器）
 * 与阶段 04（Scheduler/Artifact）。对应方案的混合架构分工：
 *   强模型按需规划（planTasks）→ 程序化调度（executeDAG）→ 独立验收（既有 verifier）。
 *
 * 关键设计（方案 §四）：
 * - 验收标准在执行前冻结：Planner 输出的 acceptance 随计划固定，调度期不改、
 *   不由执行模型自行降低标准。
 * - 模型选择与任务分解是两个独立决策：Planner 只产出能力级 DAG，模型选择交给
 *   既有 rankModels（资格过滤 + 评分排序）在每步执行时按需进行。
 * - 计划失效回退：规划失败/超时/结构非法 → 返回 null，调用方回落线性 multi
 *   执行器——编排层故障不得阻断任务。
 * - 步失败只重分配失败步（换次优模型一次），不重跑整个 DAG（方案 §二.5）。
 */

import { runOne } from './multi.js'
import { SYSTEMS } from './prompts.js'
import { rankModels } from './registry.js'
import { logPerf } from './perf.js'
import { buildSubtaskContext, addArtifact } from './context.js'

/** 规划超时（ms）：对话内联，强模型一次调用。 */
export const PLAN_TIMEOUT_MS = 20_000
/** DAG 整体执行 deadline（与 multi 的 90s 总预算对齐）。 */
export const DAG_DEADLINE_MS = 90_000
/** 每个 DAG 步允许的重分配次数（换次优模型）。 */
const MAX_REASSIGN = 1

const PLANNER_SYSTEM = SYSTEMS.planner

/**
 * 强模型规划：自然语言目标 → 结构化任务 DAG。
 * @returns {Promise<null | { steps: Array<{id,title,capability,dependsOn,acceptance}>, frozen: boolean }>}
 *   null = 规划不可用（超时/格式错/结构非法），调用方应回退线性执行。
 */
export async function planTasks(ctx, opts) {
  const { engine, analysis, taskState, logLine } = opts
  if (!engine?.provider || !engine?.model) return null
  const constraints = (taskState?.constraints || []).slice(0, 6).map((c) => `- ${c}`).join('\n')
  const prompt = [
    PLANNER_SYSTEM,
    '【任务目标】' + String(taskState?.goal || analysis?.text || '').slice(0, 600),
    constraints ? '【硬性约束（必须遵守）】\n' + constraints : '',
    '【能力线索】' + (analysis?.requirements || []).map((r) => `${r.capability}@${Number(r.importance).toFixed(2)}`).join(', '),
  ]
    .filter(Boolean)
    .join('\n\n')

  let timer
  let raw = null
  const callModel = opts.callModel || ((input) => runOne(ctx, input))
  try {
    raw = await Promise.race([
      callModel({ provider: engine.provider, model: engine.model, prompt }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), PLAN_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
  } catch {
    return null
  }
  if (!raw) return null
  const plan = parsePlan(raw)
  if (!plan) {
    logLine?.(`plan invalid -> fallback linear`)
    return null
  }
  return { steps: plan, frozen: true }
}

/** 解析并校验计划：能力白名单、依赖存在、无环、步数 1-3。非法返回 null。 */
export function parsePlan(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  let parsed
  try {
    parsed = JSON.parse(m[0])
  } catch {
    return null
  }
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : null
  if (!steps || steps.length < 1 || steps.length > 3) return null
  const CAPS = new Set(['coding', 'research', 'vision', 'writing', 'reasoning', 'general'])
  const ids = new Set()
  const clean = []
  for (const s of steps) {
    const id = String(s?.id || '').trim()
    const capability = String(s?.capability || '').trim().toLowerCase()
    const title = String(s?.title || '').trim()
    if (!id || ids.has(id) || !CAPS.has(capability) || !title) return null
    ids.add(id)
    clean.push({
      id,
      title,
      capability,
      dependsOn: (Array.isArray(s?.dependsOn) ? s.dependsOn : []).map(String).filter((d) => d !== id),
      acceptance: (Array.isArray(s?.acceptance) ? s.acceptance : []).map(String).filter(Boolean).slice(0, 3),
    })
  }
  // 依赖必须引用已存在的步，且无环（拓扑排序消元）
  const pending = new Set(clean.map((s) => s.id))
  let progress = true
  while (pending.size && progress) {
    progress = false
    for (const s of clean) {
      if (!pending.has(s.id)) continue
      if (s.dependsOn.every((d) => !pending.has(d))) {
        pending.delete(s.id)
        progress = true
      }
    }
  }
  if (pending.size) return null // 有环
  return clean
}

/**
 * 程序化调度：按 DAG 波次执行（同波并行、跨波等待），每步执行时才选模型。
 * @returns {Promise<{ steps: Array<{id,title,capability,model,text}>, summary: string, planUsed: boolean }>}
 */
export async function executeDAG(ctx, plan, opts) {
  const {
    registry,
    taskState,
    sessionId,
    reliability,
    prefer,
    costWeight = 0.25,
    latencyWeight = 0.15,
    logLine = () => {},
    onUsage,
    signal,
  } = opts
  const steps = plan.steps
  const callModel = opts.execFn || ((input) => runOne(ctx, input))
  const done = new Map() // id -> { text, artifactId }
  const attempted = new Set() // 已尝试过的步（失败也计入）——否则失败步每轮重进 wave，直到 90s deadline
  const out = []
  const deadline = Date.now() + DAG_DEADLINE_MS

  while (done.size < steps.length) {
    if (signal?.aborted) break
    if (Date.now() > deadline) {
      logLine?.(`dag deadline hit (${done.size}/${steps.length} done)`)
      break
    }
    // 当前波：依赖全部**完成**的未尝试步（同波并行）。
    // 失败步记入 attempted 不再重进；其下游步因依赖未完成被自然跳过（缺输入不硬跑）。
    const wave = steps.filter(
      (s) => !done.has(s.id) && !attempted.has(s.id) && s.dependsOn.every((d) => done.has(d)),
    )
    if (!wave.length) break
    await Promise.all(
      wave.map(async (step) => {
        attempted.add(step.id)
        const ranked = rankModels(registry, step.capability, {
          costWeight,
          latencyWeight,
          requireVision: step.capability === 'vision',
          reliability,
          prefer,
          fallbackGeneral: true, // 无声明能力 → 按通用分执行（分配层依据里同步标注）
        })
        if (!ranked.length) {
          logLine?.(`dag skip ${step.id} (${step.capability}): no eligible model`)
          return
        }
        const upper = buildSubtaskContext(taskState, {
          capability: step.capability,
          importance: 0.9,
        })
        const prompt = [
          upper.prompt,
          `【本步子任务】${step.title}`,
          step.acceptance.length
            ? `【验收标准（执行前已冻结，不得自行降低）】\n${step.acceptance.map((a) => `- ${a}`).join('\n')}`
            : '',
          '完成后只输出本步结果本身（可交接、简洁），不要复述计划。',
        ]
          .filter(Boolean)
          .join('\n\n')

        let text = ''
        let model = null
        for (let attempt = 0; attempt <= MAX_REASSIGN && attempt < ranked.length; attempt++) {
          const pick = ranked[attempt].model
          const t0 = Date.now()
          try {
            text = await callModel({
              provider: pick.provider,
              model: pick.model,
              prompt,
              signal,
            })
            model = pick
            if (text) {
              // 表现账本（证据 B）：步级终局即回写；换模型重试各自记各自的
              opts.onStepOutcome?.(step, pick, { ok: true, latencyMs: Date.now() - t0 })
              break
            }
          } catch (e) {
            logLine?.(`dag step ${step.id} model=${pick.key} failed: ${String(e).slice(0, 80)}`)
          }
          logPerf({
            kind: 'dag-step',
            sessionId,
            step: step.id,
            capability: step.capability,
            model: pick.key,
            attempt,
            success: Boolean(text),
            latencyMs: Date.now() - t0,
            reassigned: attempt > 0,
          })
          if (!text) {
            // 失败的尝试也如实入账：账本只记「产出非空」，成败由调用方口径统一
            opts.onStepOutcome?.(step, pick, { ok: false, latencyMs: Date.now() - t0 })
          }
        }
        if (!model) return
        let artifactId
        try {
          const art = addArtifact(taskState, {
            type: `dag:${step.capability}`,
            summary: String(text).slice(0, 240),
            text: String(text),
            source: model.key,
          })
          artifactId = art?.artifactId
        } catch {
          /* artifact 失败不影响编排 */
        }
        done.set(step.id, { text, artifactId })
        out.push({ id: step.id, title: step.title, capability: step.capability, model: model.key, text })
        logLine?.(`dag step ${step.id} [${step.capability}] -> ${model.key} (deps: ${step.dependsOn.join(',') || '-'})`)
      }),
    )
  }

  const summary = out.length
    ? [
        '【多模型协作结果（按任务计划执行）— 请综合后给出最终完整回答】',
        ...out.map(
          (s) =>
            `#### ${s.title}（能力 ${s.capability}，模型 ${s.model}）\n${String(s.text).slice(0, 1800)}`,
        ),
      ].join('\n\n')
    : ''
  return { steps: out, summary, planUsed: out.length > 0 }
}
