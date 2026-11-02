/**
 * WU ai Model Registry — 模型能力表。
 * score 0~1；costScore 越高表示越便宜。
 */

/** @typedef {{
 *   key: string,
 *   provider: string,
 *   model: string,
 *   capabilities: Record<string, number>,
 *   costScore: number,
 *   latencyScore: number,
 *   enabled: boolean,
 * }} RegistryModel */

/** 内置厂商预设已移除（2026-10）：模型一律由控制中心配置（cordis config.models）。 */
const DEFAULT_MODELS = []

/** 具体能力维度（general 除外）。配置里这些全为 0 = 用户没填，需要先验兜底。 */
const SPECIFIC_CAPS = ['coding', 'vision', 'reasoning', 'research', 'writing']

/**
 * 冷启动能力先验（2026-11-01 去偏见化）。
 *
 * 背景：控制中心默认只把每个模型标成 general 0.85，具体能力全 0。于是
 * rankModels 对任何任务都只能按 general 排——三家模型并列同分，最终由 actual
 * 历史分决胜，而 actual 里只有先跑过的 deepseek-flash 有样本 → 「无论什么任务
 * 都流向 deepseek-flash」的假路由（general 黑洞）。
 *
 * 这里按**技术性状**（是否多模态、是否代码专长）给先验，不是品牌偏好：
 * 先验只在用户完全没填具体能力时生效，一旦填了任何一项，声明值全权优先。
 */
const FAMILY_PRIORS = {
  deepseek: { coding: 0.86, reasoning: 0.86, research: 0.72, writing: 0.78, vision: 0 },
  zhipu: { coding: 0.80, reasoning: 0.82, research: 0.74, writing: 0.76, vision: 0 },
  xiaomi: { coding: 0.76, reasoning: 0.76, research: 0.70, writing: 0.72, vision: 0 },
  qwen: { coding: 0.80, reasoning: 0.82, research: 0.78, writing: 0.78, vision: 0 },
  openai: { coding: 0.86, reasoning: 0.88, research: 0.80, writing: 0.84, vision: 0 },
  anthropic: { coding: 0.88, reasoning: 0.86, research: 0.82, writing: 0.88, vision: 0 },
  meta: { coding: 0.74, reasoning: 0.72, research: 0.66, writing: 0.70, vision: 0 },
  local: { coding: 0.70, reasoning: 0.68, research: 0.60, writing: 0.68, vision: 0 },
  unknown: { coding: 0.70, reasoning: 0.70, research: 0.64, writing: 0.68, vision: 0 },
}

/** 与 task-analyzer 的 modelFamily 同源判定（registry 不能反向依赖 allocation 层）。 */
export function familyOfModel(m) {
  const s = `${m?.provider || ''} ${m?.model || ''} ${m?.key || ''} ${m?.label || ''}`.toLowerCase()
  if (/deepseek/.test(s)) return 'deepseek'
  if (/zhipu|glm/.test(s)) return 'zhipu'
  if (/xiaomi|mimo/.test(s)) return 'xiaomi'
  if (/qwen|alibaba|tongyi/.test(s)) return 'qwen'
  if (/openai|gpt|o[1-9]\b/.test(s)) return 'openai'
  if (/anthropic|claude/.test(s)) return 'anthropic'
  if (/llama|meta/.test(s)) return 'meta'
  if (/local|llama\.cpp/.test(s)) return 'local'
  return 'unknown'
}

/** 模型是不是多模态：名称/模型 ID 里有 vl / vision / omni，或 glm-4.6v 这类
 *  「数字+v」视觉版本后缀。纯文本型号（deepseek-flash / mimo-v2.6-flash）不命中。 */
function looksMultimodal(m) {
  const s = `${m?.model || ''} ${m?.key || ''} ${m?.label || ''}`.toLowerCase()
  if (/(^|[^a-z])(vl|vision|omni|multimodal)([^a-z]|$)/.test(s)) return true
  return /(^|[^a-z])[\d.]+v($|[^a-z])/.test(s)
}

/**
 * UCB1 探索奖励：样本越少的模型，奖励越高，打破「先发样本垄断」。
 * @param {number} runs 该模型累计执行次数
 * @param {number} totalRuns 全系统累计执行次数
 * @param {number} [weight] 奖励强度（默认 0.15，与方案一致）
 */
export function explorationBonus(runs, totalRuns, weight = 0.15) {
  const n = Math.max(0, Number(runs) || 0)
  const N = Math.max(1, Number(totalRuns) || 0)
  return Math.sqrt((2 * Math.log(N + 1)) / (n + 1)) * weight
}

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {RegistryModel[]}
 */
export function buildRegistry(overrides = {}) {
  const list = Array.isArray(overrides.models) ? overrides.models : DEFAULT_MODELS
  /** @type {RegistryModel[]} */
  const out = []
  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    const key = String(m.key || m.id || '')
    if (!key) continue
    const identity = {
      provider: String(m.provider || key),
      model: String(m.model || m.id || key),
      key,
      label: String(m.label || m.name || key),
    }
    const { caps, source } = normalizeCaps(m.capabilities, identity)
    out.push({
      key,
      provider: identity.provider,
      model: identity.model,
      label: identity.label,
      /** 用户自由文本偏好，原样保留，由语义匹配理解 */
      preference: String(m.preference || m.prefText || ''),
      capabilities: caps,
      costScore: clamp01(Number(m.costScore ?? 0.7)),
      latencyScore: clamp01(Number(m.latencyScore ?? 0.7)),
      enabled: m.enabled !== false,
      /** 能力分来源：declared=用户/控制中心声明，prior=性状先验兜底（依据里要注明） */
      capsSource: source,
    })
  }
  return out
}

/**
 * 能力归一 + 先验兜底。
 * - 用户/控制中心填了任何具体能力 → 原样采用（declared）
 * - 具体能力全为 0（常见于只跑了下拉、没手工填分） → 用家族性状先验，
 *   并按模型名补视觉分（多模态标记），避免一切任务塌缩到 general 黑洞
 * @param {unknown} caps
 * @param {{ provider?: string, model?: string, key?: string, label?: string }} [identity]
 */
function normalizeCaps(caps, identity = {}) {
  /** @type {Record<string, number>} */
  const out = {
    coding: 0,
    vision: 0,
    reasoning: 0,
    research: 0,
    writing: 0,
    general: 0.5,
  }
  if (caps && typeof caps === 'object') {
    for (const [k, v] of Object.entries(caps)) {
      out[k] = clamp01(Number(v))
    }
  }
  const declaredSpecific = SPECIFIC_CAPS.some((k) => out[k] > 0)
  if (declaredSpecific) return { caps: out, source: 'declared' }

  const prior = FAMILY_PRIORS[familyOfModel(identity)] || FAMILY_PRIORS.unknown
  const seeded = { ...prior }
  if (!seeded.vision && looksMultimodal(identity)) seeded.vision = 0.84
  const avg = SPECIFIC_CAPS.reduce((s, k) => s + (seeded[k] || 0), 0) / SPECIFIC_CAPS.length
  // 先验兜底时一并重算 general：遗留的「所有模型 general 0.85」常量必须清掉，
  // 否则通用任务依旧三家并列，UCB 之外又回到样本量通吃。
  return {
    caps: { ...out, ...seeded, general: clamp01(avg) },
    source: 'prior',
  }
}

/** @param {number} n */
function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * 历史可靠性 → 信誉因子（rankModels 与 rankByIntel 共用，避免 smart/manual 两路结论漂移）。
 * rel ∈ [0.5,1]（loadReliability 的映射：0.5=全败、1=全成）；无样本返回 1.0 ——
 * 缺数据不惩罚也不加分，有实测按实测直乘（0% 成功率 ×0.5，100% ×1.0）。
 * @param {number | undefined} rel
 * @returns {number}
 */
export function reliabilityFactor(rel) {
  if (typeof rel !== 'number' || !Number.isFinite(rel)) return 1
  return Math.min(1, Math.max(0.5, rel))
}

/** 相邻同分（< 0.02）项随机交换，消除固定数组顺序带来的第一顺位偏见。 */
export function jitterTies(rows, epsilon = 0.02) {
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]
    const b = rows[i + 1]
    if (a.preferred === b.preferred && Math.abs(a.score - b.score) < epsilon) {
      if (Math.random() < 0.5) {
        rows[i] = b
        rows[i + 1] = a
      }
    }
  }
  return rows
}

/**
 * 按主能力给候选模型打分。
 * 用户显式 prefer（capability → model key/provider）优先：命中则强加分，
 * 避免成本分把 DeepSeek 顶到 coding 上而覆盖控制中心设定。
 * score = cap * reliabilityFactor(rel) * (1-wc-wl) + cap*cost*wc + cap*latency*wl [+ prefer bonus]
 * 信誉因子统一走 reliabilityFactor()（有实测按实测，无样本不调整），与 rankByIntel 同源。
 * @param {RegistryModel[]} models
 * @param {string} capability
 * @param {{
 *   costWeight?: number,
 *   latencyWeight?: number,
 *   requireVision?: boolean,
 *   reliability?: Map<string, number>,
 *   prefer?: Record<string, string>,
 * }} [opts]
 */
export function rankModels(models, capability, opts = {}) {
  const costWeight = opts.costWeight ?? 0.25
  const latencyWeight = opts.latencyWeight ?? 0.15
  const preferred = opts.prefer?.[capability]
  const explore = opts.explore ?? 0.12
  const runStats = opts.runStats
  const totalRuns = runStats ? [...runStats.values()].reduce((s, n) => s + (Number(n) || 0), 0) : 0
  const rows = []
  for (const m of models) {
    if (!m.enabled) continue
    if (opts.requireVision && (m.capabilities.vision || 0) < 0.3) continue
    const cap = m.capabilities[capability] ?? 0
    if (cap <= 0) continue
    const rel = opts.reliability?.get?.(`${m.key}|${capability}`)
    const factor = reliabilityFactor(rel)
    let score =
      cap * factor * (1 - costWeight - latencyWeight) +
      cap * m.costScore * costWeight +
      cap * m.latencyScore * latencyWeight
    // UCB 探索补偿：历史样本少的模型获得加分，避免「越用越高分、越低分越不用」死锁
    const bonus = runStats ? explorationBonus(runStats.get(m.key) || 0, totalRuns, explore) : 0
    score += bonus
    const isPreferred =
      Boolean(preferred) &&
      (m.key === preferred || m.provider === preferred)
    if (isPreferred && cap >= 0.4) {
      // 用户在控制中心点名的模型：优先于成本/延迟权衡
      score += 0.4
    }
    rows.push({ model: m, capability, score, cap, reliability: rel, preferred: isPreferred, exploration: bonus })
  }
  rows.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
    return b.score - a.score
  })
  // 分差极小的相邻项随机交换：消除「数组固定顺序 = 第一顺位偏见」。
  // 必须在排序之后做（比较器里随机化不满足传递性，会产出不可复现的乱序）。
  jitterTies(rows)
  // 执行/评估路径的兜底：控制中心配置的模型常只有 general 分（用途不手工填），
  // 严格按能力过滤会让 reasoning/research 等步骤永远「找不到合格模型」。
  // 开启 fallbackGeneral 时，该能力无人可用 → 按通用分重排，并在 basis 里如实标注。
  if (!rows.length && opts.fallbackGeneral && capability !== 'general') {
    const fb = rankModels(models, 'general', { ...opts, fallbackGeneral: false })
    return fb.map((r) => ({ ...r, capability, fallbackGeneral: true }))
  }
  return rows
}
