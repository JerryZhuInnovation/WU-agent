/**
 * Router Brain 适配 — 本地 llama.cpp / 云端模型均可作为分析器
 * 联网由 Runtime 执行（httpGet），LLM 只产出查询词与结构化结论。
 */

import { runOne } from './multi.js'
import { SYSTEMS } from './prompts.js'
import { explorationBonus, jitterTies, reliabilityFactor } from './registry.js'
import {
  upsertCapabilities,
  httpGet,
  searchUrls,
  htmlToSnippets,
  effectiveScore,
} from './intel.js'

/**
 * 任务 → 结构化能力需求（供 smart 路由）
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ provider: string, model: string, task: string }} input
 * @param {(usage: unknown, meta: { provider: string, model: string }) => void} [onUsage]
 */
export async function analyzeTaskByBrain(ctx, input, onUsage) {
  const prompt = [
    SYSTEMS.taskAnalyzer,
    '格式：{"primary":"coding|vision|reasoning|research|writing|general","requirements":[{"capability":"...","importance":0到1}],"complexity":"simple|medium|complex"}',
    '',
    `【任务】${input.task.slice(0, 2000)}`,
  ].join('\n')
  const text = await runOne(
    ctx,
    {
      provider: input.provider,
      model: input.model,
      prompt,
      maxTokens: 200,
      timeoutMs: 20000,
    },
    onUsage,
  )
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    if (!o.primary) return null
    return o
  } catch {
    return null
  }
}

/**
 * 研究一个模型擅长什么：Runtime 联网搜，再交给 Brain 归纳 JSON 能力分
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   provider: string,
 *   model: string,
 *   modelKey: string,
 *   modelId: string,
 *   capabilitiesHint?: string,
 * }} input
 */
export async function researchModelProfile(ctx, input) {
  const queries = [
    `${input.modelId} model card capabilities`,
    `${input.modelId} benchmark coding reasoning`,
    `${input.modelId} vision multimodal`,
  ]
  /** @type {string[]} */
  const snippets = []
  for (const q of queries) {
    const urls = searchUrls(q)
    for (const url of urls) {
      try {
        const r = await httpGet(url, 8000)
        if (r.ok && r.text) {
          snippets.push(...htmlToSnippets(r.text, 6))
          break
        }
      } catch {
        /* next url */
      }
    }
    if (snippets.length >= 8) break
  }

  const evidence = snippets.slice(0, 10).join('\n---\n')
  const prompt = [
    SYSTEMS.modelResearcher,
    '格式：{"coding":0到1,"vision":0到1,"reasoning":0到1,"research":0到1,"writing":0到1,"general":0到1,"note":"一句话"}',
    '',
    `【模型】${input.modelId}`,
    input.capabilitiesHint ? `【用户声明偏好】${input.capabilitiesHint}` : '',
    evidence ? `【网页摘录】\n${evidence.slice(0, 4000)}` : '【网页摘录】无（按声明或通用分）',
  ]
    .filter(Boolean)
    .join('\n')

  const text = await runOne(ctx, {
    provider: input.provider,
    model: input.model,
    prompt,
    maxTokens: 250,
    timeoutMs: 30000,
  })
  const m = String(text || '').match(/\{[\s\S]*\}/)
  let scores = null
  if (m) {
    try {
      const o = JSON.parse(m[0])
      scores = {}
      for (const k of ['coding', 'vision', 'reasoning', 'research', 'writing', 'general']) {
        const v = Number(o[k])
        if (Number.isFinite(v)) scores[k] = Math.min(1, Math.max(0, v))
      }
    } catch {
      scores = null
    }
  }
  if (!scores || !Object.keys(scores).length) {
    // 回退：声明偏好文本
    scores = {}
    const hint = (input.capabilitiesHint || '').toLowerCase()
    if (/视觉|图|vision|image/.test(hint)) scores.vision = 0.85
    if (/代码|编程|coding|code/.test(hint)) scores.coding = 0.85
    if (/推理|reasoning/.test(hint)) scores.reasoning = 0.8
    if (/调研|research/.test(hint)) scores.research = 0.8
    if (/写作|writing|翻译/.test(hint)) scores.writing = 0.8
    if (!Object.keys(scores).length) scores.general = 0.75
  }

  upsertCapabilities(input.modelKey, 'research', scores, {
    snippetCount: snippets.length,
    modelId: input.modelId,
  })
  return scores
}

/**
 * 用 effectiveScore 对候选模型按 primary 排序。
 * 分数 = 档案分 × 层级权重（actual 1.0 > research 0.85 > declared 0.7；单样本 actual 降为 0.85）；
 * 有历史可靠性时再乘 reliabilityFactor（0.5~1.0 直乘，无样本不调整；与 rankModels 同源）。
 * 2026-11-01 去偏见化：
 * - UCB 探索奖励（runStats）—— 历史样本少的模型获得补偿，打破先发样本垄断；
 * - 用户显式 prefer（控制中心点名）才加分，默认不存在任何「默认模型」锚点；
 * - 视野过滤：本能力下没有可评估模型时直接弃权（返回空），交由 rankModels 的先验兜底，
 *   避免「档案里没有这条 → 一律 0 分 → 全靠数组顺序」。
 * @param {import('./registry.js').RegistryModel[]} registry
 * @param {string} capability
 * @param {{ reliability?: Map<string, number>, runStats?: Map<string, number>, prefer?: Record<string, string>, explore?: number }} [options]
 */
export function rankByIntel(registry, capability, options = {}) {
  const reliability = options.reliability
  const runStats = options.runStats
  const explore = options.explore ?? 0.12
  const preferred = options.prefer?.[capability]
  const totalRuns = runStats ? [...runStats.values()].reduce((s, n) => s + (Number(n) || 0), 0) : 0
  const rows = []
  for (const m of registry) {
    if (!m.enabled) continue
    const eff = effectiveScore(m.key, capability)
    const fallback = m.capabilities?.[capability] ?? 0
    const factor = reliabilityFactor(reliability?.get(`${m.key}|${capability}`))
    let score = (eff?.score ?? fallback) * (eff?.weight ?? 1) * factor
    if (score <= 0) continue
    const bonus = runStats ? explorationBonus(runStats.get(m.key) || 0, totalRuns, explore) : 0
    score += bonus
    const isPreferred = Boolean(preferred) && (m.key === preferred || m.provider === preferred)
    if (isPreferred) score += 0.4
    const source = `${eff?.layer || 'registry'}${factor < 1 ? '+rel' : ''}${bonus ? '+ucb' : ''}`
    rows.push({ model: m, score, source, preferred: isPreferred, exploration: bonus })
  }
  rows.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
    return b.score - a.score
  })
  jitterTies(rows)
  return rows
}
