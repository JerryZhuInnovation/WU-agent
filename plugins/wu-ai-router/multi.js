/**
 * WU ai Multi-Model Executor — V0.4
 * 复杂多能力任务：按 requirements 顺序调用不同模型，结果串联后注入主请求。
 */

import { rankModels } from './registry.js'
import { SYSTEMS } from './prompts.js'
import { logPerf } from './perf.js'
import { buildSubtaskContext, addArtifact } from './context.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   provider: string,
 *   model: string,
 *   prompt: string,
 *   signal?: AbortSignal,
 *   maxTokens?: number,
 * }} input
 * @param {(usage: unknown, meta: { provider: string, model: string }) => void} [onUsage]
 * @returns {Promise<string>}
 */
export async function runOne(ctx, input, onUsage) {
  const llm = ctx.llm
  const timeoutMs = input.timeoutMs ?? 45000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('multi-step timeout')), timeoutMs)
  const signal = input.signal ? AbortSignal.any([input.signal, ac.signal]) : ac.signal
  /** @type {string[]} */
  const chunks = []
  /** @type {unknown} */
  let usage = null
  try {
    const stream = llm.stream({
      provider: input.provider,
      model: input.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
      maxTokens: input.maxTokens ?? 800,
      signal,
    })
    for await (const chunk of stream) {
      if (!chunk) continue
      // 适配器在流末尾单独发一条 usage 记录
      if (chunk.type === 'usage' && chunk.usage) {
        usage = chunk.usage
        continue
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') chunks.push(chunk.text)
      else if (chunk.chunk?.type === 'text-delta' && typeof chunk.chunk.text === 'string') {
        chunks.push(chunk.chunk.text)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  if (onUsage) {
    try {
      onUsage(usage, { provider: input.provider, model: input.model })
    } catch {
      /* 埋点失败不影响主流程 */
    }
  }
  return chunks.join('').trim()
}

/**
 * 是否值得拆成多模型：≥2 个高重要性能力，且复杂度 medium+ 或多阶段措辞。
 * 带图任务不拆：主模型已能看图，再拆会抢跑、卡住。
 * @param {import('./analyzer.js').TaskAnalysis} analysis
 */
export function shouldMultiExecute(analysis) {
  if (!analysis) return false
  if (analysis.needsImage) return false
  const strong = analysis.requirements.filter((r) => r.importance >= 0.75)
  if (strong.length < 2) return false
  if (analysis.complexity === 'complex') return true
  if (analysis.complexity === 'medium' && analysis.text.length >= 60) return true
  if (/(然后|接着|再|以及|同时|最后|并检查|然后写|设计.*写)/i.test(analysis.text)) return true
  return false
}

/**
 * 按能力顺序跑子任务，返回可注入主上下文的摘要。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   analysis: import('./analyzer.js').TaskAnalysis,
 *   registry: import('./registry.js').RegistryModel[],
 *   sessionId: string,
 *   costWeight?: number,
 *   latencyWeight?: number,
 *   reliability?: Map<string, number>,
 *   prefer?: Record<string, string>,
 *   signal?: AbortSignal,
 *   logLine?: (s: string) => void,
 *   onUsage?: (usage: unknown, model: {key: string, provider: string, model: string}, role: string) => void,
 * }} input
 * @returns {Promise<{ steps: { capability: string, model: string, text: string }[], summary: string }>}
 */
export async function multiExecute(ctx, input) {
  const log = input.logLine || (() => {})
  const costWeight = input.costWeight ?? 0.25
  const latencyWeight = input.latencyWeight ?? 0.15
  const strong = input.analysis.requirements.filter((r) => r.importance >= 0.75)
  // 带图时不做 vision 子步（主模型已能看图）；最多 2 步，避免拖死
  const ordered = [...strong]
    .filter((r) => !(input.analysis.needsImage && r.capability === 'vision'))
    .sort((a, b) => b.importance - a.importance)

  /** @type {{ capability: string, model: string, text: string }[]} */
  const steps = []
  let context = ''

  for (const need of ordered.slice(0, 2)) {
    if (input.signal?.aborted) break
    const ranked = rankModels(input.registry, need.capability, {
      costWeight,
      latencyWeight,
      requireVision: need.capability === 'vision',
      reliability: input.reliability,
      prefer: input.prefer,
      fallbackGeneral: true,
    })
    const pick = ranked[0]?.model
    if (!pick) continue

    // Context Manager：按需重建子任务上下文（L1 任务摘要 + L2 上游产物摘要），
    // 取代原先的整段截断拼接——子模型不再接收无关历史，约束事实永不裁剪。
    let sub
    const tBuild0 = Date.now()
    try {
      sub = buildSubtaskContext(input.taskState, { capability: need.capability, importance: need.importance })
    } catch {
      sub = null // 上下文层异常不阻断执行：回落到手工拼接
    }
    const contextBuildMs = Date.now() - tBuild0
    const prompt = sub
      ? sub.prompt
      : [
          SYSTEMS.subtaskWorker,
          `【用户总任务】${input.analysis.text.slice(0, 2000)}`,
          context ? `【前序结果】\n${context.slice(0, 2500)}` : '',
          `【本步能力】${need.capability}（importance=${need.importance}）`,
          `【本步要求】针对总任务，只完成与「${need.capability}」相关的部分，给出可交接的结论/要点/伪代码。`,
        ]
        .filter(Boolean)
        .join('\n\n')

    const t0 = Date.now()
    log(
      `multi-step ${need.capability} -> ${pick.provider}/${pick.model}`,
    )
    const text = await runOne(
      ctx,
      {
        provider: pick.provider,
        model: pick.model,
        prompt,
        signal: input.signal,
      },
      input.onUsage
        ? (u) => input.onUsage(u, { key: pick.key, provider: pick.provider, model: pick.model }, 'multi')
        : undefined,
    )
    const latencyMs = Date.now() - t0
    steps.push({ capability: need.capability, model: pick.key, text })
    // 子步结果登记为产物：全文落 store，摘要进入后续子步/质检上下文
    let art = null
    try {
      art = addArtifact(input.taskState, {
        type: `subtask:${need.capability}`,
        summary: String(text || '').slice(0, 240),
        text: String(text || ''),
        source: pick.key,
      })
    } catch {
      /* artifact 失败不影响执行 */
    }
    logPerf({
      kind: 'multi-step',
      sessionId: input.sessionId,
      capability: need.capability,
      model: pick.key,
      provider: pick.provider,
      modelId: pick.model,
      latencyMs,
      success: Boolean(text),
      chars: text.length,
      contextBuildMs,
      contextSourceCount: sub ? sub.sourceCount : undefined,
      artifactId: art?.artifactId,
    })
    if (text) {
      context += `\n\n### ${need.capability}（${pick.key}）\n${text.slice(0, 2000)}`
    }
  }

  // 无任何子步结果（如 registry 为空/无可用模型）时不产出摘要，避免注入空内容误导主模型
  const summary = steps.length
    ? [
        '【多模型子任务结果 — 请综合后给出最终完整回答】',
        ...steps.map((s) => `#### ${s.capability}（模型 ${s.model}）\n${s.text.slice(0, 1800)}`),
      ].join('\n\n')
    : ''

  return { steps, summary }
}
