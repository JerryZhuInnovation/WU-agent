/**
 * WU ai Core — Analyzer → Capability Router → Verifier → Performance Log
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { buildRegistry, familyOfModel as modelFamily, rankModels } from './registry.js'
import { analyzeTask, extractContent } from './analyzer.js'
import { logPerf, readPerf, summarize } from './perf.js'
import { verifyAnswer, extractAssistantText } from './verifier.js'
import { shouldMultiExecute, multiExecute } from './multi.js'
import {
  createTaskState,
  updateFromAnalysis,
  updateFromVerify,
  buildVerifyContext,
  addArtifact,
} from './context.js'
import { runOne } from './multi.js'
import {
  evaluatePolicy,
  buildPacket,
  reviewWithModel,
  audit as riskAudit,
  markTainted,
  taintOf,
  clearTaint,
  onAuditFailure,
} from './risk-review.js'
import { analyzeTaskByBrain, rankByIntel } from './brain.js'
import { syncActualFromPerf } from './intel.js'
import { planTasks, executeDAG } from './planner.js'
import { runAllocation } from './allocation/orchestrator.js'
import { recordOutcome } from './allocation/model-performance.js'
import { appendExecutionAudit } from './allocation/decision-log.js'

export const name = 'wu-ai-core'
// agents 必须声明：cordis 里没 inject 就取 ctx.agents 会当场抛错（0.2.0 起实测），
// 曾导致质检在每一次 assistant 消息上都崩掉、从未真正执行。DSH 自己的插件同样声明它。
export const inject = ['llm', 'agents']

const ZH_LANG_SECTION = {
  name: 'wu-ai-language',
  text:
    '【语言要求】始终使用简体中文回答。除非用户明确要求使用其它语言，' +
    '否则不要使用英文输出。代码、标识符、路径可保持原文。',
}

/** 一次性诊断日志：同类只记首条。质检/用量链路曾静默失效多月（verify error
 *  53 条 + verify start 0 条），静默 return 点必须留下可见痕迹，否则无法根治。
 *  另见 agent/request-error 的全量失败留痕（401 静默截断回答的教训）。 */
const SEEN_DIAG = new Set()

/** @param {string} tag @param {string} msg */
function seenOnce(tag, msg) {
  if (SEEN_DIAG.has(tag)) return
  SEEN_DIAG.add(tag)
  logLine(`[diag:${tag}] ${msg}`)
}

function logLine(msg) {
  try {
    const home = process.env.DSH_HOME || join(process.env.HOME || '', '.wu-ai', 'dsh')
    const file = join(home, 'wu-ai-router.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* ignore */
  }
}

/** 本轮核验强度（发射器前置选择）：strict = 完整流水线；fast = 跳过分配内核与独立核验。
 *  控制中心在对话页取件时写入 $DSH_HOME/wu-ai-turn-config.json，30 分钟内有效；
 *  读不到 / 过期一律按 strict 处理——宁可多验，不可漏验。 */
function readTurnVerify() {
  try {
    const home = process.env.DSH_HOME || join(process.env.HOME || '', '.wu-ai', 'dsh')
    const data = JSON.parse(readFileSync(join(home, 'wu-ai-turn-config.json'), 'utf8'))
    const at = Number(data?.at || 0)
    if (!at || Date.now() - at > 30 * 60 * 1000) return 'strict'
    return data.verifyMode === 'fast' ? 'fast' : 'strict'
  } catch {
    return 'strict'
  }
}

function agentKey(agent) {
  try {
    return agent?.session?.id || agent?.sessionId || String(agent?.id ?? 'agent')
  } catch {
    return 'agent'
  }
}

/** 单次模型调用的用量埋点（kind='llm'）。
 *  与 execute 分开记：execute 是终局成败（被 summarize 拿去算成功率），
 *  用量是每次调用的开销 —— 混在一起会污染成功率统计。
 *  字段拿不到就不写，不补零充数（界面据此决定显不显示）。 */
function logLlm(sessionId, role, model, usage) {
  if (!usage) return
  /** @param {unknown} v */
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined)
  logPerf({
    kind: 'llm',
    sessionId: sessionId || '',
    role,
    model: model?.key || null,
    provider: model?.provider || null,
    modelId: model?.model || null,
    usage: {
      input: num(usage.inputTokens),
      output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadTokens),
      cacheWrite: num(usage.cacheWriteTokens),
      reasoning: num(usage.reasoningTokens),
      total: num(usage.totalTokens),
    },
  })
}

/** session/event 事件载荷解包。
 *  0.2.0 起实测：广播的是日志信封 { type, seq, time, data, surfaceOp }，
 *  裸载荷（message/stream/usage）在 `.data` 里。直接读顶层全是 undefined——
 *  质检与用量两条链路因此静默失效多月（verify error ×53、verify start ×0）。
 *  信封必带 data；裸 payload（waterfall/测试直发）没有 data 字段，原样返回。 */
function eventPayload(env) {
  if (env && typeof env === 'object' && 'data' in env && env.data && typeof env.data === 'object') {
    return env.data
  }
  return env
}

/** 从会话事件里取本次调用的用量。
 *  传入的应是 eventPayload(event) 解包后的裸载荷：usage 通常在顶层
 *  （与 assistant/message 事件同行携带）；旧格式挂在流记录末尾，
 *  这里两种都认。这正是 DSH 自己读用量的方式。 */
export function eventUsage(event) {
  if (event?.usage) return event.usage
  const stream = event?.stream
  if (!Array.isArray(stream)) return null
  for (let i = stream.length - 1; i >= 0; i--) {
    const rec = stream[i]
    if (rec?.type === 'usage' && rec.usage) return rec.usage
    if (rec?.chunk?.type === 'usage' && rec.chunk.usage) return rec.chunk.usage
  }
  return null
}

/** 取 agents 服务：cordis 里直接 `ctx.agents` 需要先 inject，未 inject 会当场抛错
 *  （0.2.0 起实测如此，曾让质检 100% 失效且每轮刷一条错误日志）。
 *  这里两种取法都容错，取不到就返回 undefined，由调用方安静跳过。 */
function getAgents(ctx) {
  try {
    const a = ctx.agents
    if (a) return a
  } catch {
    /* 未 inject：走下面的 ctx.get */
  }
  try {
    return ctx.get?.('agents') || undefined
  } catch {
    return undefined
  }
}

function home() {
  return process.env.DSH_HOME || join(process.env.HOME || '', '.wu-ai', 'dsh')
}

/* ── 运行期提示：前端轮询 /wu-ai/notices，弹「不遮挡工作区」的非阻塞提示 ─────── */

/** @type {Array<{ id: number, text: string, at: number }>} */
const NOTICES = []
let noticeSeq = 0

/**
 * 记一条提示供前端取走展示。保留最近 20 条，避免常驻内存无界增长。
 * @param {string} text
 * @returns {number} 该提示的序号
 */
function pushNotice(text) {
  const id = ++noticeSeq
  NOTICES.push({ id, text, at: Date.now() })
  if (NOTICES.length > 20) NOTICES.splice(0, NOTICES.length - 20)
  return id
}

/* ── 思考强度降级：第三方模型不认 reasoning_effort 时静默回落默认强度 ──────────
 * DSH 的强度校验（dsh-llm resolveCallWithInfo）只认「不支持的 id」抛错；
 * 真正的拒绝发生在 wire 层——provider 回 400。因此这里用「错误兜底 + 重试」：
 *   1) agent/request 记录本次**确实下发过**的强度（无强度则不记录，避免臆测）；
 *   2) 该 provider 回「请求被拒」时，标记其不支持强度并返回 {kind:'retry'}；
 *   3) 重试时 agent/request 剥离 reasoningEffort → 落到 provider 自身默认强度；
 *   4) 若剥离后**仍然**失败，说明与强度无关，撤销标记，避免误伤后续请求。 */

/** 已确认「不支持 reasoning_effort」的 provider（命中即长期生效）。 */
const EFFORT_SUPPRESSED = new Set()
/** provider → 最近一次真正下发的强度；无值代表本次没有发 reasoning_effort。 */
const LAST_EFFORT = new Map()

/**
 * 请求被拒类错误码。pi-ai 的 classifyPiAiError 把 `\b400\b|invalid.?request` 归为
 * INVALID_REQUEST——强度不被接受通常正是 400，故只认这一类，避免误伤网络等临时错误。
 */
function isInvalidRequestFailure(code) {
  const c = String(code || '').toUpperCase()
  return c === 'INVALID_REQUEST' || c === 'BAD_REQUEST'
}

/** 剥离思考强度（返回新对象，绝不改写原配置）。 */
function withoutEffort(cfg) {
  if (!cfg || typeof cfg !== 'object' || cfg.reasoningEffort === undefined) return cfg
  const { reasoningEffort: _drop, ...rest } = cfg
  return rest
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   mode?: 'auto' | 'off',
 *   routingMode?: 'manual' | 'smart',
 *   analyzerModelId?: string,
 *   budget?: { costWeight?: number, latencyWeight?: number },
 *   verify?: { enabled?: boolean, maxRounds?: number, minScore?: number, preferDifferent?: boolean },
 *   models?: unknown[],
 *   prefer?: Record<string, string>,
 *   router?: Record<string, string>,
 * }} [config]
 */
export function apply(ctx, config = {}) {
  const mode = config.mode === 'off' ? 'off' : 'auto'
  // 恒智能路由（2026-10-14 起手动模式移除）：Brain 不可用时自动回退规则分类
  const analyzerModelId = String(config.analyzerModelId || '')
  /** 畸形配置（字符串/NaN）不得把打分或质检次数搞成 NaN */
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const budget = config.budget || {}
  const costWeight = num(budget.costWeight, 0.25)
  const latencyWeight = num(budget.latencyWeight, 0.15)
  const prefer = { ...(config.router || {}), ...(config.prefer || {}) }
  const verifyCfg = {
    enabled: config.verify?.enabled !== false,
    maxRounds: Math.max(0, Math.min(3, num(config.verify?.maxRounds, 1))),
    minScore: num(config.verify?.minScore, 0.75),
    preferDifferent: config.verify?.preferDifferent !== false,
  }
  const baseRegistry = buildRegistry(config)
  let registry = baseRegistry

  /** 控制中心核验出的「密钥失效」模型 id（共享快照，每次进入路由前重读）。
   *  读不到就当空集：绝不因为我们自己的记账文件缺失，把用户的路由搞成无模型可用。 */
  function readUnhealthy() {
    try {
      const p = join(home(), 'wu-ai-model-health.json')
      if (!existsSync(p)) return new Set()
      const db = JSON.parse(readFileSync(p, 'utf8'))
      return new Set(Array.isArray(db?.unhealthy) ? db.unhealthy.map(String) : [])
    } catch {
      return new Set()
    }
  }

  /** 把密钥失效的模型从候选池里摘掉（文件一改即刻生效，不必重启 DSH）。
   *  只影响路由候选，不动用户的 enabled 设定 —— 密钥修好后自动回到池子里。 */
  function refreshRegistry() {
    const bad = readUnhealthy()
    registry = bad.size ? baseRegistry.filter((m) => !bad.has(m.key)) : baseRegistry
  }
  refreshRegistry()

  /** 生成一个用量上报回调：把 (provider, model) 反查回 registry 的 key 后记一条埋点。
   *  反查不到就用 provider/model 原样落盘——宁可显示得生硬，也不丢这笔开销。 */
  function reportUsage(sessionId, role) {
    return (usage, meta) => {
      if (!usage) return
      const hit = baseRegistry.find(
        (m) => m.provider === meta?.provider && m.model === meta?.model,
      )
      logLlm(
        sessionId,
        role,
        hit
          ? { key: hit.key, provider: hit.provider, model: hit.model }
          : { key: `${meta?.provider || '?'}/${meta?.model || '?'}`, provider: meta?.provider, model: meta?.model },
        usage,
      )
    }
  }

  /** 解析用于语义匹配的模型（Router Brain）。
   *  去偏见化（2026-11-01）：显式 analyzerModelId → 用户 prefer.general →
   *  **中立轮转**（累计执行次数最少，且本进程内当裁判员次数最少，并列时随机）。
   *  过去这里回落到「第一个启用的模型」，等于把裁判员永久钉在同一家：
   *  裁判员与分析器同源是自我偏好偏置的温床，也让冷门模型永远拿不到分析样本。
   *  同一会话内固定（engineByAgent 缓存）：中途换裁判员会让能力判定前后不一致。 */
  const engineByAgent = new Map()
  const engineUseCount = new Map()

  function matchEngine(key) {
    if (analyzerModelId) {
      const m = registry.find((x) => x.key === analyzerModelId && x.enabled)
      if (m) return m
    }
    const g = prefer.general
    if (g) {
      const m = registry.find((x) => x.key === g && x.enabled)
      if (m) return m
    }
    if (key && engineByAgent.has(key)) {
      const m = registry.find((x) => x.key === engineByAgent.get(key) && x.enabled)
      if (m) return m
    }
    const enabled = registry.filter((m) => m.enabled)
    if (!enabled.length) return null
    const stats = loadRunStats()
    const minRuns = Math.min(...enabled.map((m) => stats.get(m.key) || 0))
    const pool = enabled.filter((m) => (stats.get(m.key) || 0) === minRuns)
    const minUsed = Math.min(...pool.map((m) => engineUseCount.get(m.key) || 0))
    const finalists = pool.filter((m) => (engineUseCount.get(m.key) || 0) === minUsed)
    const pick = finalists[Math.floor(Math.random() * finalists.length)]
    if (key) {
      engineByAgent.set(key, pick.key)
      engineUseCount.set(pick.key, (engineUseCount.get(pick.key) || 0) + 1)
    }
    return pick
  }

  logLine(
    `core loaded mode=${mode} routing=smart verify=${verifyCfg.enabled}/${verifyCfg.maxRounds} ` +
      `engine=${matchEngine()?.key || '-'} models=${registry
        .filter((m) => m.enabled)
        .map((m) => `${m.key}{${m.preference || '—'}}`)
        .join(',')}`,
  )

  // —— 强制中文：拼进 system prompt ——
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    if (!assembled || !Array.isArray(assembled.sections)) return assembled
    if (assembled.sections.some((s) => s?.name === ZH_LANG_SECTION.name)) return assembled
    return {
      ...assembled,
      sections: [ZH_LANG_SECTION, ...assembled.sections],
    }
  })

  // —— 图片 admission 放行（Router 随后再改路由）——
  if (mode === 'auto') {
    const visionReady = rankModels(registry, 'vision', { requireVision: true }).length > 0
    const llm = ctx.llm ?? ctx.get?.('llm')
    if (visionReady && llm && typeof llm.resolveModelInfo === 'function') {
      if (!(/** @type {any} */ (llm).__wuAiPatched)) {
        const orig = llm.resolveModelInfo.bind(llm)
        llm.resolveModelInfo = async (provider, model, signal) => {
          const info = await orig(provider, model, signal)
          if (!info || typeof info !== 'object') return info
          const mods = info.inputModalities
          if (Array.isArray(mods) && !mods.includes('image')) {
            logLine(`admission-patch ${provider}/${model} allow image`)
            return { ...info, inputModalities: [...mods, 'image'] }
          }
          if (mods === undefined) {
            return { ...info, inputModalities: ['text', 'image'] }
          }
          return info
        }
        /** @type {any} */ (llm).__wuAiPatched = true
        logLine('patched llm.resolveModelInfo for image admission')
      }
    }
  }

  /** @type {Map<string, import('./analyzer.js').TaskAnalysis>} */
  const analysisByAgent = new Map()
  /** Context Manager：会话 → TaskState（跨轮存活；goal 签名变化时自动重置）。 */
  const taskStateByAgent = new Map()
  const dshHomePath = process.env.DSH_HOME || ''
  /** @type {Map<string, { model: import('./registry.js').RegistryModel, capability: string, score: number, at: number }>} */
  const routeByAgent = new Map()
  /** @type {Map<string, number>} */
  const verifyRoundByAgent = new Map()
  /** @type {Set<string>} */
  const verifying = new Set()
  /** @type {Set<string>} */
  const multiRunning = new Set()
  /** 本轮（用户消息 → idle）昂贵的 LLM 决策各自只做一次。
   *  为什么挂在独立 Map 而不是 analysis 上：mid-loop 的 inject（multi 摘要 / 质检
   *  followup）会进 inbox，下一个 step 的 pre-step 拿到新文本就重建 analysis（DSH
   *  agent.ts 每个 step 都 claim 一次 inbox），挂上去的标记会被一起冲掉——实测
   *  multi 因此重复触发。以下缓存按 agent key 存活到 idle 统一清理。 */
  /** @type {Map<string, string | null>} key → Brain 的 primary 结论（null=本轮失败不重试） */
  const brainByAgent = new Map()
  /** @type {Set<string>} 本轮已尝试过 multi-execute 的会话（防 inject 引发重复触发） */
  const multiDone = new Set()
  /* ── 可审计任务分配（allocation/，方案《可验证的任务分配决策机制》）────────── */
  /** @type {Map<string, { adrId: string, state: string, at: number, probed: boolean }>} 本轮分配决策 */
  const allocationByAgent = new Map()
  /** @type {Set<string>} 本轮已尝试过分配流程的会话（防 inject 重复触发；HOLD 也只试一次） */
  const allocationDone = new Set()
  /** @type {Set<string>} 本轮已按「步」回写过表现账本的会话（有步级记录就不再补路由级，防双计） */
  const stepOutcomeByAgent = new Set()

  /* ── 会话预算与熔断（P1-7）──────────────────────────────────────────────
   * 失控循环（agent 反复调同一个工具）在沙箱里同样烧钱又吵。per-session 计数：
   * 工具调用数 / 墙钟 / 审查连续失败。触限 → ask 提示新开会话；审查连续失败
   * 达阈值 → 熔断：本会话后续 P2 全部转人工（审查服务可能整体不可用，
   * 继续让每个命令等 12s 超时只是浪费用户时间）。
   *
   * 限额来自托管策略文件 wu-ai-policy.json（P2-10）：控制中心改、Agent 侧
   * mtime 变化即重读；文件缺失/损坏用内置默认（fail-safe 与文档一致）。 */
  const POLICY_DEFAULTS = {
    toolCalls: 200,
    wallClockMs: 2 * 60 * 60 * 1000,
    reviewFails: 5,
    // 默认白名单只放行 workspace-write：danger-full-access 必须用户显式加入
    allowedModes: ['workspace-write'],
  }
  /** @type {{ mtimeMs: number, value: typeof POLICY_DEFAULTS }} */
  let policyCache = { mtimeMs: -1, value: { ...POLICY_DEFAULTS } }

  /** 读托管策略（mtime 缓存）：文件被控制中心改写后下一请求即生效。
   *  读不到 → 默认预算 + 默认白名单（只放行 workspace-write）。 */
  function readPolicy() {
    try {
      const st = statSync(join(home(), 'wu-ai-policy.json'))
      if (st.mtimeMs === policyCache.mtimeMs) return policyCache.value
      const data = JSON.parse(readFileSync(join(home(), 'wu-ai-policy.json'), 'utf-8'))
      const b = (data && data.budget) || {}
      const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
      const modes = Array.isArray(data?.allowedModes)
        ? data.allowedModes.filter((m) => typeof m === 'string')
        : []
      policyCache = {
        mtimeMs: st.mtimeMs,
        value: {
          toolCalls: num(b.toolCalls, POLICY_DEFAULTS.toolCalls),
          wallClockMs: num(b.wallClockMs, POLICY_DEFAULTS.wallClockMs),
          reviewFails: num(b.reviewFails, POLICY_DEFAULTS.reviewFails),
          allowedModes: modes.length ? modes : [...POLICY_DEFAULTS.allowedModes],
        },
      }
    } catch {
      /* 文件不存在/读不动：沿用缓存（首次即默认值） */
    }
    return policyCache.value
  }

  function budgetLimits() {
    const p = readPolicy()
    return { toolCalls: p.toolCalls, wallClockMs: p.wallClockMs, reviewFails: p.reviewFails }
  }

  /** 允许的沙箱模式白名单（P2-10）。 */
  function policyModes() {
    return readPolicy().allowedModes
  }

  /** @type {Map<string, { calls: number, startedAt: number, reviewFails: number, tripped: Set<string> }>} */
  const budgetByAgent = new Map()

  /** @param {string} key */
  function budgetOf(key) {
    let b = budgetByAgent.get(key)
    if (!b) {
      b = { calls: 0, startedAt: Date.now(), reviewFails: 0, tripped: new Set() }
      budgetByAgent.set(key, b)
    }
    return b
  }

  /** 预算快照落共享文件（控制中心工作台 tail 读；原子写防读到半行）。 */
  function flushBudget() {
    if (!dshHomePath) return
    const rows = [...budgetByAgent.entries()].map(([key, b]) => ({
      session: key,
      calls: b.calls,
      elapsedMs: Date.now() - b.startedAt,
      reviewFails: b.reviewFails,
      tripped: [...b.tripped],
    }))
    try {
      const file = join(dshHomePath, 'wu-ai-budget.json')
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), limits: budgetLimits(), sessions: rows }))
      renameSync(tmp, file)
    } catch {
      /* 快照写失败不影响主流程 */
    }
  }

  // P1-6：审计写失败不再静默——用户必须知道「这次判定没留下记录」
  onAuditFailure((e) => {
    logLine(`audit write failed: ${String(e)}`)
    pushNotice('风险审计日志写入失败（磁盘权限或空间？）。本次判定未留痕，请尽快处理。')
  })

  /** 从 perf.jsonl 聚合历史可靠性，供动态路由；同时把聚合回写进 intel 档案 actual 层 */
  function loadReliability() {
    /** @type {Map<string, number>} */
    const rel = new Map()
    try {
      const rows = summarize(readPerf(400))
      syncActualFromPerf(rows)
      for (const r of rows) {
        if (!r.model || !r.capability || r.n < 2) continue
        // 成功率映射到 0.5~1.0，避免样本少时过度惩罚
        const s = Math.min(1, Math.max(0.5, 0.5 + r.successRate * 0.5))
        rel.set(`${r.model}|${r.capability}`, s)
      }
    } catch {
      /* ignore */
    }
    return rel
  }

  /** 每个模型的累计执行次数（不区分能力）：UCB 探索奖励的样本量基准。
   *  没有它，先跑起来的模型会一直领先——「越用越高分、越低分越不用」的死锁。 */
  function loadRunStats() {
    /** @type {Map<string, number>} */
    const stats = new Map()
    try {
      for (const r of summarize(readPerf(400))) {
        if (!r.model) continue
        stats.set(r.model, (stats.get(r.model) || 0) + (Number(r.n) || 0))
      }
    } catch {
      /* ignore */
    }
    return stats
  }

  /* ── 协议摩擦免责（2026-11-01）──────────────────────────────────────────
   * 「模型被框架的格式要求卡住」不是模型能力问题：JSON.parse 崩溃、
   * 扩展字段触发的 invalid_request_error、tool_call_id 映射不兼容等，
   * 都会让内核把整轮判失败。若照常记进表现账本，非 DeepSeek 模型会被
   * 「越用越差 → 越差越不用」的死锁慢慢淘汰（方案 §三 的免责保护）。
   * 这里只**免除扣分**，不制造加分；协议摩擦仍照常留痕，便于排查。 */
  let lastFrictionAt = 0
  const FRICTION_WINDOW_MS = 90_000

  function isProtocolFriction(code, message) {
    const m = String(message || '')
    if (/unexpected token|json\.parse|not valid json/i.test(m)) return true
    if (/tool_call_id|invalid tool call/i.test(m)) return true
    if (/invalid_request_error|unknown field|unrecognized/i.test(m)) return true
    if (/reasoning_content|reasoning_effort|thinking/i.test(m) && /400|invalid/i.test(m)) return true
    return false
  }

  function frictionRecent() {
    return Date.now() - lastFrictionAt < FRICTION_WINDOW_MS
  }

  /* ── 可审计任务分配：结果回写（证据 B 闭环负反馈，方案 §实施步骤 5）────────
   * 任务终局（验收完成/中断兜底）时：① 按「步」回写表现账本已在执行回调里做；
   * ② 没有步级记录时补一条路由级 Worker 记录；③ ADR 回填事后归因。 */
  function finishAllocation(key, { success, reworked = false, latencyMs = 0, note = '' }) {
    const alloc = allocationByAgent.get(key)
    if (!alloc) return
    allocationByAgent.delete(key)
    try {
      const route = routeByAgent.get(key)
      const analysis = analysisByAgent.get(key)
      const friction = !success && frictionRecent()
      // 步级账本已由 DAG/multi 执行回调覆盖：不再补路由级，避免同轮双计
      if (!stepOutcomeByAgent.has(key) && !friction) {
        recordOutcome({
          modelKey: route?.model?.key || 'unknown',
          taskType: route?.capability || analysis?.primary || 'general',
          role: 'Worker',
          passed: success,
          reworked,
          latencyMs,
        })
      }
      appendExecutionAudit(alloc.adrId, {
        finalSuccess: success,
        failureRootCause: success
          ? null
          : friction
            ? 'PROTOCOL_FRICTION'
            : alloc.state === 'TRIAL_FIRST'
              ? 'MODEL_MISMATCH'
              : 'EXEC_FAILURE',
        reworkCount: reworked ? 1 : 0,
        note: friction ? `${note}（协议摩擦，不记模型能力负分）` : note,
      })
    } catch {
      /* 账本/归因失败不影响会话清理 */
    }
  }

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      try {
        // 每轮重读核验快照：密钥失效的模型当场退出候选（不必重启 DSH）
        refreshRegistry()
        if (mode === 'auto') {
          const { text, hasImage } = extractContent(payload?.messages)
          const key = agentKey(payload.agent)
          if (text || hasImage) {
            verifyRoundByAgent.delete(key)
            const analysis = analyzeTask(text, hasImage)
            analysisByAgent.set(key, analysis)
            // Context Manager：任务状态随分析更新（goal 签名变化自动重置；跨轮存活）
            const ts = taskStateByAgent.get(key) || createTaskState(key, dshHomePath)
            taskStateByAgent.set(key, updateFromAnalysis(ts, analysis))
            logLine(
              `analyze key=${key} primary=${analysis.primary} complexity=${analysis.complexity} image=${hasImage} multi=${shouldMultiExecute(analysis)}`,
            )
            logPerf({
              kind: 'analyze',
              sessionId: key,
              primary: analysis.primary,
              complexity: analysis.complexity,
              needsImage: analysis.needsImage,
              snippet: text.slice(0, 120),
            })

            // V0.4：复杂多能力 → 子模型串联；同步等待（带超时），避免与主模型抢跑卡死。
            // multiDone：本轮只尝试一次 —— mid-loop 的 inject（multi 摘要 / 质检 followup）
            // 会让下一个 step 的 pre-step 重新拿到文本并重建 analysis，fresh 标记挡不住重复。
            const wantMulti =
              shouldMultiExecute(analysis) && !multiRunning.has(key) && !multiDone.has(key)
            if (wantMulti && payload.agent?.inject) {
              multiRunning.add(key)
              multiDone.add(key)
              const reliability = loadReliability()
              // 线性 multi 的统一入口（无引擎 / 分配层放弃时共用同一份参数）
              const runMulti = () => multiExecute(ctx, {
                analysis,
                registry,
                sessionId: key,
                taskState: taskStateByAgent.get(key),
                costWeight,
                latencyWeight,
                reliability,
                prefer,
                logLine,
                onUsage: reportUsage(key, 'multi'),
              })
              let multiTimer = null
              try {
                const out = await Promise.race([
                  // 自主编排 + 可审计分配（方案 §五）：
                  //   非简单任务先走分配内核：盲态双规划 → 红队 → 三级评估 → 三态。
                  //   EXECUTABLE/TRIAL_FIRST → 产出 DAG（TRIAL_FIRST 先跑低成本探针）；
                  //   HOLD_FOR_CONFIRMATION / 失败 / 超时 → 回落单规划/线性 multi，
                  //   分配层任何故障都不得阻断任务。
                  (async () => {
                    const engine = matchEngine(key)
                    if (!engine) {
                      return runMulti()
                    }

                    // ① 分配内核（每轮一次；盲态规划 60s + 红队 30s + 探针 30s，硬 deadline 130s）
                    //    发射器选「快速直通」时整段跳过：单模型直接干，速度优先
                    const turnVerify = readTurnVerify()
                    if (turnVerify === 'fast') logLine(`turn verify=fast key=${key}：跳过分配内核`)
                    let dagPlan = null
                    if (analysis.complexity !== 'simple' && !allocationDone.has(key) && turnVerify !== 'fast') {
                      allocationDone.add(key)
                      let allocTimer = null
                      try {
                        const alloc = await Promise.race([
                          runAllocation(ctx, {
                            sessionId: key,
                            analysis,
                            registry,
                            engine,
                            reliability,
                            prefer,
                            costWeight,
                            latencyWeight,
                            callModel: (input) => runOne(ctx, input),
                            logLine,
                            onUsage: reportUsage(key, 'alloc'),
                            pushNotice,
                          }),
                          new Promise((resolve) => {
                            allocTimer = setTimeout(() => resolve(null), 130_000)
                          }),
                        ])
                        if (alloc?.plan) {
                          allocationByAgent.set(key, {
                            adrId: alloc.adr.adrId,
                            state: alloc.state,
                            at: Date.now(),
                            probed: Boolean(alloc.probed),
                          })
                          logPerf({
                            kind: 'allocation',
                            sessionId: key,
                            adrId: alloc.adr.adrId,
                            state: alloc.state,
                            planners: alloc.adr.planning?.plannersUsed?.map((p) => p.key) || [],
                            conflicts: alloc.adr.uncertaintiesAndCritiques?.plannerConflicts?.length || 0,
                            critiques: alloc.adr.uncertaintiesAndCritiques?.redTeamCritiques?.length || 0,
                            score: alloc.adr.totalScore,
                            probed: Boolean(alloc.probed),
                          })
                          // 决策完成即落一条带 allocation 理由的路由行：multi inject 的摘要要
                          // 等下一轮才被主模型消费（idle 已清 alloc 标记）， onRequest 里的
                          // 注入永远赶不上 —— 前端胶囊徽章只能从这里来。
                          const worker = (alloc.adr.selectedAllocation || []).find((s) => s.role === 'Worker') || (alloc.adr.selectedAllocation || [])[0]
                          const rm = worker?.model ? registry.find((m) => m.key === worker.model) : null
                          if (worker?.model) {
                            logPerf({
                              kind: 'route',
                              sessionId: key,
                              mode: 'smart',
                              capability: analysis.primary,
                              model: worker.model,
                              provider: rm?.provider || worker.model,
                              modelId: rm?.model || worker.model,
                              reason: `allocation:${alloc.state}`,
                              preference: '',
                            })
                          }
                          dagPlan = alloc.plan
                        }
                      } catch (e) {
                        logLine(`alloc pipeline error ${e} -> fallback planner`)
                      } finally {
                        if (allocTimer) clearTimeout(allocTimer)
                      }
                    }

                    // ② 既有单规划器（分配层未产出时）
                    if (!dagPlan) {
                      try {
                        const plan = await planTasks(ctx, {
                          engine,
                          analysis,
                          taskState: taskStateByAgent.get(key),
                          logLine,
                        })
                        if (plan) {
                          logLine(`plan frozen steps=${plan.steps.length} [${plan.steps.map((s) => s.capability).join('->')}]`)
                          logPerf({
                            kind: 'plan',
                            sessionId: key,
                            steps: plan.steps.map((s) => ({ id: s.id, capability: s.capability, dependsOn: s.dependsOn })),
                            acceptanceFrozen: plan.frozen === true,
                          })
                          dagPlan = plan
                        }
                      } catch (e) {
                        logLine(`plan error ${e} -> fallback linear multi`)
                      }
                    }

                    // ③ 程序化调度执行
                    if (dagPlan) {
                      const dag = await executeDAG(ctx, dagPlan, {
                        registry,
                        taskState: taskStateByAgent.get(key),
                        sessionId: key,
                        reliability,
                        prefer,
                        costWeight,
                        latencyWeight,
                        logLine,
                        onUsage: reportUsage(key, 'multi'),
                        // 表现账本（证据 B）：每步终局即回写，供下次分配评估引用
                        onStepOutcome: (step, model, res) => {
                          try {
                            stepOutcomeByAgent.add(key)
                            recordOutcome({
                              modelKey: model.key,
                              taskType: step.capability,
                              role: 'Worker',
                              passed: res.ok,
                              latencyMs: res.latencyMs,
                            })
                          } catch {
                            /* 账本失败不影响执行 */
                          }
                        },
                      })
                      if (dag?.steps?.length) return dag
                    }
                    return runMulti()
                  })(),
                  new Promise((resolve) => {
                    // 分配内核 130s + DAG 自身 90s deadline + 余量
                    multiTimer = setTimeout(() => resolve({ steps: [], summary: '', timeout: true }), 240_000)
                  }),
                ])
                const steps = out?.steps || []
                // 超时/空结果也必须落盘可观测（不能藏在注入条件里）
                logPerf({
                  kind: 'multi',
                  sessionId: key,
                  steps: steps.map((s) => ({ capability: s.capability, model: s.model })),
                  success: !out.timeout && steps.length > 0,
                  timeout: Boolean(out.timeout),
                })
                if (out?.summary && steps.length && payload.agent?.inject) {
                  // multi 摘要登记为产物：全文进 store，摘要供质检/后续子步引用
                  try {
                    addArtifact(taskStateByAgent.get(key), {
                      type: 'multi-summary',
                      summary: out.summary.slice(0, 240),
                      text: out.summary,
                      source: 'multi-executor',
                    })
                  } catch {
                    /* artifact 失败不影响注入 */
                  }
                  payload.agent.inject({
                    id: `wu-ai-multi-${Date.now()}`,
                    role: 'user',
                    content: [{ type: 'text', text: String(out.summary).slice(0, 6000) }],
                    source: {
                      kind: 'plugin',
                      plugin: 'wu-ai-core',
                      form: 'context',
                      summary: `multi-execute ${steps.length} steps`,
                    },
                  })
                  logLine(`multi inject key=${key} steps=${steps.length} timeout=${Boolean(out.timeout)}`)
                }
              } catch (e) {
                logLine(`multi error ${String(e)}`)
              } finally {
                if (multiTimer) clearTimeout(multiTimer)
                multiRunning.delete(key)
              }
            }
          }
        }
      } catch (e) {
        logLine(`analyze error ${String(e)}`)
      }
      return next()
    },
    { prepend: true },
  )

  // 路由主体见 onRequest：任何异常都不得打断用户请求（与 agent/pre-step 同标准兜底）
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      return await onRequest(payload, resolved)
    } catch (e) {
      logLine(`request route error ${String(e)}`)
      return resolved
    }
  })

  /** agent/request 路由主体（抛错由外层 hook 兜底并原样放行）。 */
  async function onRequest(payload, resolved) {
    /**
     * 思考强度收尾（与路由模式无关，恒生效）：
     *  - 已确认不支持 reasoning_effort 的 provider：剥离强度 → 回落其自身默认强度；
     *  - 否则登记本次**真正下发**的强度，供 agent/request-error 判断失败是否与强度相关。
     */
    const finalizeEffort = (cfg) => {
      if (!cfg || typeof cfg !== 'object') return cfg
      const provider = String(cfg.provider ?? '')
      if (!provider) return cfg
      const out = EFFORT_SUPPRESSED.has(provider) ? withoutEffort(cfg) : cfg
      const eff = out.reasoningEffort
      if (eff === undefined || eff === null) LAST_EFFORT.delete(provider)
      else LAST_EFFORT.set(provider, eff)
      return out
    }

    // 失效路由兜底：会话缓存里记着已删除/改名的 provider（例如模型改名后
    // 旧会话仍指 zhipu），DSH 会在适配器层直接抛 NO_ADAPTER，把整轮打成失败——
    // 连标题生成这种不走路由的调用也会中招。这里在发出前换成当前注册的
    // 第一个启用模型；有分析结果时后面的路由逻辑仍会照常覆盖。
    const known = registry.filter((m) => m.enabled !== false)
    if (resolved && resolved.provider && known.length) {
      const hit = known.some(
        (m) =>
          m.provider === resolved.provider &&
          (!resolved.model || m.model === resolved.model),
      )
      if (!hit) {
        const fb = known[0]
        logLine(`stale route ${resolved.provider}/${resolved.model || '?'} -> ${fb.provider}/${fb.model}`)
        resolved = { ...resolved, provider: fb.provider, model: fb.model }
      }
    }

    if (mode !== 'auto') return finalizeEffort(resolved)

    const key = agentKey(payload.agent)
    const analysis = analysisByAgent.get(key)
    if (!analysis) {
      logLine(`req skip key=${key}: no analysis (alloc=${allocationByAgent.has(key)})`)
      return finalizeEffort(resolved)
    }

    /** @type {import('./registry.js').RegistryModel | null} */
    let best = null
    let reason = ''

    {
      // 智能路由：Router Brain 分析任务 + intel 档案排序（actual > research > declared）
      let primary = analysis.primary
      const engine = matchEngine(key)
      // 每个 step 都会走这里（工具调用循环里 step 很多），但一次用户轮次只需要分析一次：
      // 否则「有 bug，修改」这种多步任务会把分析模型连打十几次，白花钱还拖慢每一轮。
      if (engine && !brainByAgent.has(key)) {
        // 失败也占位（null）：本轮不重试，inject 引发的后续 step 不会反复打 Brain
        brainByAgent.set(key, null)
        try {
          const brain = await analyzeTaskByBrain(ctx, {
            provider: engine.provider,
            model: engine.model,
            task: analysis.text || analysis.primary,
          }, reportUsage(key, 'analyze'))
          if (brain?.primary) {
            brainByAgent.set(key, brain.primary)
            logLine(`brain task -> ${brain.primary} complexity=${brain.complexity || '?'}`)
          }
        } catch (e) {
          logLine(`brain error ${e}`)
        }
      }
      const brainPrimary = brainByAgent.get(key)
      if (brainPrimary) primary = brainPrimary
      if (analysis.needsImage) primary = 'vision'
      // 去偏见化（2026-11-01）：档案排序同样接入 UCB 探索奖励与显式偏好，
      // 否则「先跑过的模型 actual 分拉满」会永远压住冷启动模型。
      const reliability = loadReliability()
      const runStats = loadRunStats()
      // 异构回退黑名单：刚因传输故障失败的模型短期跳过（全部被黑时回退完整池）
      const avoidPool = registry.filter((m) => !avoidActive(m.key))
      const pool = avoidPool.length ? avoidPool : registry
      const rankedIntel = rankByIntel(pool, primary, { reliability, runStats, prefer })
      if (rankedIntel[0]) {
        best = rankedIntel[0].model
        reason = `smart-intel:${primary}:${rankedIntel[0].source}`
      } else {
        const ranked = rankModels(pool, primary, {
          costWeight,
          latencyWeight,
          requireVision: analysis.needsImage,
          reliability,
          runStats,
          prefer,
        })
        if (ranked[0]) {
          best = ranked[0].model
          reason = `smart-cap:${best.key}`
        }
      }
    }

    if (!best) return finalizeEffort(resolved)

    // 分配内核在本轮产出过决策：路由理由带上决策状态（前端胶囊据此显示徽章）
    const alloc = allocationByAgent.get(key)
    if (alloc) reason = `allocation:${alloc.state}`

    const prev = routeByAgent.get(key)
    // 分配决策本身是新信息：即使模型没变也要落一条带 allocation 理由的路由行，
    // 否则前端胶囊永远看不到决策徽章（实测：同模型续轮会整轮跳过路由行）
    if (!prev || prev.model.key !== best.key || (alloc && !alloc.routeLogged)) {
      if (alloc) alloc.routeLogged = true
      routeByAgent.set(key, {
        model: best,
        capability: analysis.primary,
        score: 1,
        at: Date.now(),
      })
      logLine(
        `route key=${key} ${analysis.primary}/smart -> ${best.provider}/${best.model} (${reason}) pref="${best.preference || ''}"`,
      )
      logPerf({
        kind: 'route',
        sessionId: key,
        mode: 'smart',
        capability: analysis.primary,
        model: best.key,
        provider: best.provider,
        modelId: best.model,
        reason,
        preference: best.preference || '',
      })
    }

    if (resolved?.provider === best.provider && resolved?.model === best.model) {
      return finalizeEffort(resolved)
    }
    return finalizeEffort({ ...resolved, provider: best.provider, model: best.model })
  }

  /** 异构回退（2026-11-01 去偏见化）：基础设施类失败（网络/超时）不是能力问题，
   *  下一次请求应换**不同家族**的模型，而不是原地退给同一个模型。
   *  只对可重试的传输类错误生效，并设短时黑名单与重试预算，绝不进入重试死循环。 */
  const AVOID_MODELS = new Map() // modelKey -> 失效时间戳（ms）
  const HETERO_RETRY = new Map() // provider -> 本轮已跨界重试次数

  function avoidActive(key) {
    const until = AVOID_MODELS.get(key)
    if (!until) return false
    if (Date.now() > until) {
      AVOID_MODELS.delete(key)
      return false
    }
    return true
  }

  /** 返回一个与当前 provider 不同家族的启用模型；没有则 null。 */
  function heterogeneousAlt(provider) {
    const cur = registry.find((m) => m.provider === provider || m.key === provider)
    if (!cur) return null
    const curFamily = modelFamily(cur)
    return (
      registry.find((m) => m.enabled && m.key !== cur.key && modelFamily(m) !== curFamily && !avoidActive(m.key)) || null
    )
  }

  /** 可交给异构回退处理的失败：传输层/超时/未知上游错误（能力缺陷不在此列）。 */
  function isInfrastructureFailure(code, message) {
    const c = String(code || '').toUpperCase()
    if (c === 'TRANSPORT' || c === 'NETWORK' || c === 'TIMEOUT' || c === 'ECONNRESET' || c === 'ETIMEDOUT') return true
    return /connection error|fetch failed|socket hang up|timed? out|econnreset|etimedout/i.test(message)
  }

  /**
   * 请求失败的全量可见性 + reasoning_effort 自动降级 + 异构回退。
   *
   * 可见性（2026-10-11 实测教训）：DSH 对失败的 attempt 只落一条空 stream 结算，
   * UI 静默截断回答——zhipu 连续多轮 401 Invalid API Key 被吞，用户只看到
   * 「回答停在一半」却查不到原因。此处对所有失败记日志 + perf；
   * 401 类额外推 notice 指引用户检查密钥。
   *
   * 异构回退（2026-11-01）：传输类失败即换**不同家族**的模型重试一次，
   * 杜绝「回退模型与主模型同源 → 原地重试同一个模型」的假回退。
   *
   * 强度降级：第三方模型可能不认 reasoning_effort——provider 回「请求被拒」时
   * 标记该 provider 不支持强度并请求重试。重试重新走 agent/request，
   * finalizeEffort 剥离强度 → 回落 provider 默认强度：不报错、自动继续。
   */
  ctx.on('agent/request-error', (payload, next) => {
    try {
      const provider = String(payload?.provider ?? '')
      const code = payload?.failure?.code
      const message = String(payload?.failure?.message ?? payload?.failure ?? '')
      if (payload?.signal?.aborted) return next()

      if (provider) {
        // 失败可见性：任何请求失败都留痕（此前只认 400，其余全部静默）
        const friction = isProtocolFriction(code, message)
        if (friction) lastFrictionAt = Date.now()
        logLine(
          `request-error provider=${provider} code=${code ?? '?'}${friction ? ' [PROTOCOL_FRICTION]' : ''} msg=${message.slice(0, 160)}`,
        )
        logPerf({
          kind: 'request-error',
          provider,
          code: String(code || ''),
          message: message.slice(0, 200),
          protocolFriction: friction,
        })
        // 401 类：密钥被拒。核验 /models 是通的、chat 中途被拒（限流/配额/Key 异常）
        // 也会长这样——必须让用户看见，而不是静默截断回答。
        if (code === 'UNAUTHORIZED' || code === 'AUTH_ERROR' || /401|invalid api key/i.test(message)) {
          pushNotice('模型服务拒绝了请求（密钥无效或受限），本轮回答已中断。请在控制中心检查该模型的 API Key，或稍后重试。')
        }

        // 异构回退：传输类失败 = 基础设施问题，不是模型能力问题。
        // 换一个不同家族的模型重试（不让同一模型原地重试），最多 2 次，
        // 避免网络长时间不可用时把整轮请求打成重试死循环。
        if (isInfrastructureFailure(code, message)) {
          const attempts = (HETERO_RETRY.get(provider) || 0) + 1
          const alt = attempts <= 2 ? heterogeneousAlt(provider) : null
          if (alt) {
            HETERO_RETRY.set(provider, attempts)
            // 失败模型进入 60s 黑名单：下一次 onRequest 排序时跳过它，才会真的换家族
            const failed = registry.find((m) => m.provider === provider || m.key === provider)
            if (failed) AVOID_MODELS.set(failed.key, Date.now() + 60_000)
            logLine(`hetero-fallback ${failed?.key || provider}(${modelFamily(failed || {})}) -> ${alt.key}(${modelFamily(alt)}) reason=${code || message.slice(0, 40)}`)
            pushNotice(`模型 ${failed?.key || provider} 连接中断，已切换到异构模型 ${alt.key} 继续执行。`)
            return { kind: 'retry' }
          }
          if (attempts > 2) {
            HETERO_RETRY.delete(provider)
            AVOID_MODELS.clear()
          }
        }
      }

      if (!provider || !isInvalidRequestFailure(code)) return next()

      if (EFFORT_SUPPRESSED.has(provider)) {
        // 第 4 条防线：已剥离强度仍被拒 → 与强度无关，撤销标记避免误伤后续请求
        EFFORT_SUPPRESSED.delete(provider)
        LAST_EFFORT.delete(provider)
        logLine(`effort-unsuppress provider=${provider} code=${code} (rejected even without effort)`)
        return next()
      }

      if (!LAST_EFFORT.has(provider)) return next() // 本次未下发强度，与强度无关
      const sent = LAST_EFFORT.get(provider)
      EFFORT_SUPPRESSED.add(provider)
      LAST_EFFORT.delete(provider)
      logLine(`effort-unsupported provider=${provider} code=${code} sent=${sent} -> retry without reasoning_effort`)
      pushNotice('当前模型不支持设置思考强度，已改用默认强度继续。')
      return { kind: 'retry' }
    } catch (e) {
      logLine(`request-error hook error ${String(e)}`)
      return next()
    }
  })

  /**
   * Risk Review Layer（tools/pre-execute，执行前瀑布）。
   * 三层：硬性规则（代码）→ AI 审查（仅 P2）→ 策略引擎决策 allow/ask/deny。
   * AI 的 ALLOW 不直接等于放行——决策始终出自本层规则；审查不可用时 P2 保守
   * 回退 ask（DSH 原生人工确认），绝不因审查故障自动放行。全部判定落审计。
   */
  ctx.on('tools/pre-execute', async (exec, next) => {
    const t0 = Date.now()
    const toolName = String(exec?.name || '')
    const args = (exec?.arguments ?? {}) || {}
    try {
      const key = agentKey(exec?.agent)
      const workspace = exec?.agent?.session?.cwd || exec?.agent?.cwd || ''
      const budget = budgetOf(key)
      budget.calls += 1

      const policy = evaluatePolicy(toolName, args, { workspace })

      // P1-5 污点：敏感读取即打标（执行前标记——尝试过读密钥本身就是信号，
      // 即便本次被拒也留下痕迹）。标记随会话 idle 清除。
      const tainted = taintOf(key)
      if (policy.riskTags.includes('sensitive-source')) markTainted(key, policy.reason)

      const auditBase = {
        tool: toolName,
        policyLevel: policy.level,
        riskTags: policy.riskTags,
        tainted: Boolean(tainted),
        target: String(args?.command ?? args?.file_path ?? args?.path ?? '').slice(0, 200),
      }

      // P2-10 托管策略：escalation 目标 mode 不在白名单 → 直接 deny。
      // DSH 的 escalation 形态是 bash 参数 sandbox_permissions（workspace-write /
      // danger-full-access）+ justification；这里在 DSH 弹原生审批**之前**拦下，
      // 管理员基线（wu-ai-policy.json）Agent 侧无法覆盖。
      const wantMode = args?.sandbox_permissions
      if (typeof wantMode === 'string' && wantMode) {
        const allowed = policyModes()
        if (!allowed.includes(wantMode)) {
          const why = `沙箱模式「${wantMode}」不在托管策略白名单内（已允许：${allowed.join(' / ')}）`
          logLine(`risk deny tool=${toolName} why=托管策略(${wantMode})`)
          pushNotice(`已按沙箱策略拦截提权：${why}。需要时请在控制中心调整策略。`)
          riskAudit(dshHomePath, { ...auditBase, decision: 'DENY', by: 'policy', reason: why, riskTags: ['escalation'] })
          flushBudget()
          return { kind: 'deny', reason: `WU 沙箱策略：${why}` }
        }
      }

      // P1-5 污点外传：本会话读过敏感内容 → 出网一律人工（跳过审查：
      // 这是链路推断，不是单命令风险，审查模型看不到会话历史）。
      if (tainted && policy.riskTags.includes('network')) {
        const why = `本会话读取过敏感内容（${tainted.reasons[0]}），外传需人工确认`
        logLine(`risk ask tool=${toolName} why=污点外传`)
        pushNotice(`该操作需要你确认：${why}。`)
        riskAudit(dshHomePath, { ...auditBase, decision: 'ASK', by: 'taint', reason: why })
        flushBudget()
        return { kind: 'ask', reason: `WU 风险审查：${why}` }
      }

      // P1-7 预算：触限 → ask 提示新开会话（不 deny：误触限时用户应能自救）
      const limit = budgetLimits()
      const overCalls = budget.calls > limit.toolCalls
      const overClock = Date.now() - budget.startedAt > limit.wallClockMs
      if (overCalls || overClock) {
        const which = overCalls ? `工具调用已达 ${limit.toolCalls} 次上限` : `会话已持续 ${Math.round(limit.wallClockMs / 3600000)} 小时上限`
        logLine(`risk ask tool=${toolName} why=预算触限(${which})`)
        pushNotice(`${which}，请新开会话继续。`)
        riskAudit(dshHomePath, { ...auditBase, decision: 'ASK', by: 'budget', reason: which })
        flushBudget()
        return { kind: 'ask', reason: `WU 会话预算：${which}，请新开会话继续` }
      }

      if (policy.action === 'allow') {
        // P0 只读静默放行；P1 放行并审计（不打断任务）
        if (policy.level === 'P1') {
          riskAudit(dshHomePath, { ...auditBase, decision: 'ALLOW', by: 'policy', reason: policy.reason })
        }
        flushBudget()
        return next()
      }
      if (policy.action === 'deny') {
        logLine(`risk deny tool=${toolName} reason=${policy.reason}`)
        pushNotice(`已拦截高风险操作：${policy.reason}。如确有需要，请手动执行或调整方案。`)
        riskAudit(dshHomePath, { ...auditBase, decision: 'DENY', by: 'policy', reason: policy.reason })
        flushBudget()
        return { kind: 'deny', reason: `WU 风险审查：${policy.reason}` }
      }

      // P1-7 熔断：审查连续失败达阈值 → 本会话后续全部转人工
      if (budget.tripped.has('review')) {
        const why = '风险审查服务连续失败，已熔断（本次及后续操作均需人工确认）'
        logLine(`risk ask tool=${toolName} why=审查熔断`)
        riskAudit(dshHomePath, { ...auditBase, decision: 'ASK', by: 'circuit-breaker', reason: why })
        flushBudget()
        return { kind: 'ask', reason: `WU 风险审查：${why}` }
      }

      // P2：AI 风险审查（独立模型，优先与执行者不同）
      const route = routeByAgent.get(key)
      const execKey = route?.model?.key
      const reasoners = rankModels(registry, 'reasoning', { costWeight: 0.4, latencyWeight: 0.1 })
      let reviewer = reasoners.find((r) => r.model.key !== execKey)?.model
      if (!reviewer) reviewer = reasoners[0]?.model

      let review = null
      if (reviewer) {
        const packet = buildPacket({ toolName, args, workspace, taskState: taskStateByAgent.get(key) })
        // multi.runOne 的签名是 (ctx, input, onUsage)——适配成单参数调用
        const callModel = (input) => runOne(ctx, input)
        review = await reviewWithModel(callModel, packet, {
          provider: reviewer.provider,
          model: reviewer.model,
        })
        riskAudit(dshHomePath, {
          ...auditBase,
          reviewer: reviewer.key,
          review,
          reviewMs: Date.now() - t0,
        })
      } else {
        riskAudit(dshHomePath, { ...auditBase, review: null, note: '无可用审查模型' })
      }

      // P1-7 熔断计数：审查不可用累计，成功即归零（单次失败不该熔断）
      if (review) {
        budget.reviewFails = 0
      } else {
        budget.reviewFails += 1
        if (budget.reviewFails >= limit.reviewFails && !budget.tripped.has('review')) {
          budget.tripped.add('review')
          pushNotice(`风险审查连续 ${budget.reviewFails} 次失败，本会话后续操作将全部转人工确认。`)
          logLine(`circuit-breaker tripped session=${key}`)
        }
      }
      flushBudget()

      // 策略引擎终判：审查只是输入，决策出自本层
      if (review) {
        if (review.decision === 'REJECT') {
          logLine(`risk reject tool=${toolName} reason=${review.reason}`)
          pushNotice(`风险审查建议拒绝：${review.reason}${review.safer_alternative ? `。更安全的做法：${review.safer_alternative}` : ''}`)
          return { kind: 'deny', reason: `WU 风险审查：${review.reason || '审查模型建议拒绝'}` }
        }
        if (review.decision === 'ALLOW' && review.risk_level === 'LOW' && policy.riskTags.length === 0) {
          // 仅低风险且无越权标签才自动放行；越权类（工作区外/网络）一律人工
          riskAudit(dshHomePath, { ...auditBase, decision: 'ALLOW', by: 'review' })
          logLine(`risk allow tool=${toolName} review=ALLOW/LOW`)
          return next()
        }
        // REQUIRE_APPROVAL / HIGH / 越权标签 → 人工确认（DSH 原生审批）
        const why = review.reason || `风险等级 ${review.risk_level}`
        logLine(`risk ask tool=${toolName} why=${why}`)
        pushNotice(`该操作需要你确认：${why}${review.safer_alternative ? `。更安全的做法：${review.safer_alternative}` : ''}`)
        return { kind: 'ask', reason: `WU 风险审查：${why}` }
      }

      // 审查不可用（超时/格式错/无模型）：P2 默认人工确认，绝不自动放行（方案 §六）
      logLine(`risk ask tool=${toolName} why=审查不可用，保守暂停`)
      return { kind: 'ask', reason: 'WU 风险审查：审查服务不可用，请人工确认' }
    } catch (e) {
      logLine(`risk-review error tool=${toolName} ${String(e)}`)
      // 安全层自身故障：保守走人工确认（P2 级），只读类不至于——但无法区分时宁可打断
      return { kind: 'ask', reason: 'WU 风险审查内部错误，请人工确认' }
    }
  })

  // —— 用量埋点：每次模型调用单独记一行 kind='llm' ——
  // 不并入 execute：execute 是「终局成败」，被 summarize 拿去算成功率；
  // 用量是「每次调用的开销」，两者粒度不同，混在一起会污染成功率统计。
  ctx.on('session/event', async (session, event) => {
    try {
      // 事件类型首见登记：质检/用量失效时，靠它区分「事件没来」还是「来了但取不到」
      const evType = event?.type || '?'
      if (!SEEN_DIAG.has(`ev:${evType}`)) {
        SEEN_DIAG.add(`ev:${evType}`)
        logLine(`[diag] session/event 首见类型: ${evType}`)
      }
      if (!event || event.type !== 'assistant/message') return
      const data = eventPayload(event)
      const usage = eventUsage(data)
      if (!usage) {
        seenOnce('usage-no-usage', 'assistant/message 到达但 eventUsage 取不到用量（流记录缺 usage 记录？）')
        return
      }
      const agent = getAgents(ctx)?.get?.(session.id)
      const key = agent ? agentKey(agent) : String(session?.id || '')
      const route = routeByAgent.get(key)
      logLlm(key, 'execute', route?.model ? { key: route.model.key, provider: route.model.provider, model: route.model.model } : null, usage)
    } catch (e) {
      logLine(`usage hook error ${String(e)}`)
    }
  })

  // —— Verifier：assistant 结束后独立质检 ——
  ctx.on('session/event', async (session, event) => {
    /** 锁的归属 key：仅在真正拿到锁后记录，finally 只删自己持有的锁 */
    let lockKey = null
    try {
      if (mode !== 'auto') return
      if (!verifyCfg.enabled || verifyCfg.maxRounds <= 0) return
      // 发射器「快速直通」：本轮不做独立核验（与跳过分配内核同一条 turn-config）
      if (readTurnVerify() === 'fast') {
        seenOnce('verify-fast', 'verify skip：发射器快速直通，本轮不做独立核验')
        return
      }
      if (!event || event.type !== 'assistant/message') return
      const data = eventPayload(event) // 信封 → 裸载荷（message/usage 在 .data 里）
      const agentsSvc = getAgents(ctx)
      const agent = agentsSvc?.get?.(session.id)
      if (!agent) {
        seenOnce(
          'verify-no-agent',
          `verify skip：agents 服务${agentsSvc ? '存在但查无此会话' : '不可用'} sid=${session?.id}`,
        )
        return
      }
      const key = agentKey(agent)
      if (verifying.has(key)) return
      refreshRegistry() // 质检选型同样跳过密钥失效的模型

      const analysis = analysisByAgent.get(key)
      const route = routeByAgent.get(key)
      // 中间步骤守卫：带工具调用的 assistant/message 是工具循环的**中间产物**
      // （模型边分析边调工具），不是终态回答。拿「任务完成度」标准去打分会误判
      // （实测：coding 任务的分析步被打 0.3 分并注入修正，凭空插入用户气泡、
      // 打断正常工作流）。只质检无工具调用的终态回答；整轮全为中间步骤时
      // 无 execute 样本，由 agent/status idle 兜底补记，闭环不缺。
      const msgContent = data.message?.content
      if (Array.isArray(msgContent) && msgContent.some((b) => b?.type === 'tool-call')) return
      // 信封解包：内容契约在 event.data.message.content（0.2.0 起广播的是日志信封）
      const answerText = extractAssistantText(data.message?.content ?? data.content ?? data)
      const taskText = analysis?.text || ''
      if (!answerText || answerText.length < 8) {
        seenOnce('verify-short-answer', `verify skip：回答文本过短（len=${answerText?.length ?? 0}）`)
        return
      }

      const rounds = verifyRoundByAgent.get(key) || 0
      if (rounds >= verifyCfg.maxRounds) {
        logLine(`verify skip rounds=${rounds} key=${key}`)
        return
      }

      // 选 Verifier：优先与 Executor 不同
      let verifier = null
      const execKey = route?.model?.key
      const reasoners = rankModels(registry, 'reasoning', { costWeight: 0.4, latencyWeight: 0.1, fallbackGeneral: true })
      if (verifyCfg.preferDifferent && execKey) {
        verifier = reasoners.find((r) => r.model.key !== execKey)?.model
      }
      if (!verifier) verifier = reasoners[0]?.model
      if (!verifier) return

      verifying.add(key)
      lockKey = key
      logLine(`verify start key=${key} verifier=${verifier.key} exec=${execKey} round=${rounds + 1}`)
      const started = Date.now()
      // 质检上下文：规格约束 + 此前未解决问题 + 任务（不带完整分析/思考过程）
      const verifyContext = buildVerifyContext(taskStateByAgent.get(key), answerText, taskText)
      const result = await verifyAnswer(ctx, {
        provider: verifier.provider,
        model: verifier.model,
        taskText: verifyContext,
        answerText,
      })
      const latencyMs = Date.now() - started
      // 质检结论回写任务状态：gaps → 待解决问题（下一轮上下文带上）；通过 → completedSteps
      try {
        updateFromVerify(taskStateByAgent.get(key), result)
      } catch {
        /* 状态回写失败不影响质检结论 */
      }
      logLine(
        `verify done key=${key} score=${result.score} pass=${result.pass} gaps=${result.gaps.slice(0, 120)}`,
      )
      logPerf({
        kind: 'verify',
        sessionId: key,
        verifier: verifier.key,
        executor: execKey || null,
        score: result.score,
        pass: result.pass,
        latencyMs,
        gaps: (result.gaps || '').slice(0, 300),
        round: rounds + 1,
      })
      // 质检那次调用的开销单记（与 execute 分开：那行算成功率）
      logLlm(key, 'verify', { key: verifier.key, provider: verifier.provider, model: verifier.model }, result.usage)
      // 表现账本（证据 B）：Verifier 独立记录 —— 执行者不得给自己打分
      try {
        recordOutcome({
          modelKey: verifier.key,
          taskType: route?.capability || analysis?.primary || 'general',
          role: 'Verifier',
          passed: Boolean(result.pass),
          latencyMs,
        })
      } catch {
        /* 账本失败不影响质检 */
      }

      if (!result.pass && result.score < verifyCfg.minScore) {
        verifyRoundByAgent.set(key, rounds + 1)
        const fix = createUserFix(result.gaps, result.score)
        try {
          agent.followup(fix)
          logLine(`verify inject-fix key=${key}`)
          logPerf({ kind: 'retry', sessionId: key, round: rounds + 1, reason: result.gaps.slice(0, 200) })
        } catch (e) {
          logLine(`verify followup error ${String(e)}`)
        }
        // 终局记录：本轮质检失败 → 计入失败样本（成功率的「失败」来源）
        logPerf({
          kind: 'execute',
          sessionId: key,
          capability: route?.capability || analysis?.primary || 'general',
          model: execKey || 'unknown',
          latencyMs: Date.now() - (route?.at || Date.now()),
          success: false,
          verified: true,
          round: rounds + 1,
          // 协议摩擦造成的失败不计入能力统计（见 isProtocolFriction 注释）
          protocolFriction: frictionRecent(),
        })
      } else {
        verifyRoundByAgent.set(key, verifyCfg.maxRounds) // 通过则不再验
        logPerf({
          kind: 'execute',
          sessionId: key,
          capability: route?.capability || analysis?.primary || 'general',
          model: execKey || 'unknown',
          latencyMs: Date.now() - (route?.at || Date.now()),
          success: true,
          verified: true,
        })
      }
      // 终局样本已由质检路径落盘：给本轮路由打标记，idle 兜底不再重复补记
      if (route) route.executeLogged = true
      // 分配闭环：验收终局 → 表现账本补记 + ADR 归因回填
      finishAllocation(key, {
        success: Boolean(result.pass),
        reworked: !result.pass,
        latencyMs,
        note: `verify score=${result.score} gaps=${String(result.gaps || '').slice(0, 160)}`,
      })
    } catch (e) {
      logLine(`verify error ${String(e)}`)
    } finally {
      if (lockKey) verifying.delete(lockKey)
    }
  })

  ctx.on('agent/status', (payload) => {
    try {
      if (mode !== 'auto') return
      const key = agentKey(payload?.agent)
      if (!key || payload?.status !== 'idle') return
      // 会话空闲即清理本轮缓存，避免各 Map 只增不删
      analysisByAgent.delete(key)
      brainByAgent.delete(key)
      multiDone.delete(key)
      allocationDone.delete(key)
      stepOutcomeByAgent.delete(key)
      // 质检没跑（关闭/短回答/异常）也要闭环：归因如实写「未验收」
      finishAllocation(key, { success: true, note: '质检未跑（idle 兜底）' })
      clearTaint(key)
      budgetByAgent.delete(key)
      flushBudget()
      const route = routeByAgent.get(key)
      if (!route) return
      // 终局样本兜底：质检没跑（关闭/中断/短回答）时补一条 execute（verified:false），
      // 否则该模型该能力在 loadReliability 里永远是盲区，路由打分拿不到真实成功率。
      // 质检在跑（verifying）时不能补：它完成会自己写终局行，补了会同轮双计（实测过）。
      if (!route.executeLogged && !verifying.has(key)) {
        logPerf({
          kind: 'execute',
          sessionId: key,
          capability: route.capability || 'general',
          model: route.model.key,
          latencyMs: Date.now() - route.at,
          success: true,
          verified: false,
        })
      }
      logPerf({
        kind: 'idle',
        sessionId: key,
        capability: route.capability,
        model: route.model.key,
        latencyMs: Date.now() - route.at,
      })
      routeByAgent.delete(key)
    } catch {
      /* ignore */
    }
  })


  /**
   * 提示通道：把运行期提示暴露给前端（与 DSH web 同源，不依赖控制中心）。
   * GET /wu-ai/notices?since=<seq> → { seq, notices: [{ id, text, at }] }
   */
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer?.register) {
    registerNoticeRoute(ctx, webServer)
    registerDashboardRoute(ctx, webServer)
  } else {
    ctx.inject(['webServer'], (webCtx) => {
      registerNoticeRoute(webCtx, webCtx.webServer)
      registerDashboardRoute(webCtx, webCtx.webServer)
    })
  }

  logLine('wu-ai-core ready')
}

/**
 * 注册 /wu-ai/notices（幂等：重复注册会抛错，故用 effect 托管生命周期）。
 * @param {{ effect: (fn: () => unknown, label?: string) => unknown }} ctx
 * @param {import('@deepseek-ai/dsh-host-webserver').WebServer} webServer
 */
function registerNoticeRoute(ctx, webServer) {
  const route = {
    kind: 'exact',
    path: '/wu-ai/notices',
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    handler: (req, res) => {
      let since = 0
      try {
        const u = new URL(String(req.url || ''), 'http://localhost')
        since = Number(u.searchParams.get('since') || 0) || 0
      } catch {
        /* ignore */
      }
      const notices = NOTICES.filter((n) => n.id > since)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify({ seq: noticeSeq, notices }))
    },
  }
  ctx.effect(() => webServer.register(route), 'wu-ai: /wu-ai/notices')
  logLine('registered web route /wu-ai/notices')
}

/**
 * 调度台数据通道：把本机性能档案（perf.jsonl）里的**真实决策**暴露给对话页。
 * 与 DSH web 同源，不依赖控制中心；只读，不写任何文件。
 * GET /wu-ai/dashboard?session=<sessionId>&limit=<n>
 *
 * 返回的每个字段都直接来自埋点，拿不到的一律为 null（前端据此不显示，而不是编造）。
 */
function registerDashboardRoute(ctx, webServer) {
  const route = {
    kind: 'exact',
    path: '/wu-ai/dashboard',
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    handler: (req, res) => {
      let session = ''
      let limit = 300
      try {
        const u = new URL(String(req.url || ''), 'http://localhost')
        session = String(u.searchParams.get('session') || '')
        const n = Number(u.searchParams.get('limit') || 300) || 300
        limit = Math.min(1000, Math.max(20, n))
      } catch {
        /* ignore */
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(buildDashboard(session, limit)))
    },
  }
  ctx.effect(() => webServer.register(route), 'wu-ai: /wu-ai/dashboard')
  logLine('registered web route /wu-ai/dashboard')
}

/** 按 kind 取最近一行（rows 已按时间升序）。 */
function lastOf(rows, kind, sessionId) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.kind === kind && (!sessionId || r.sessionId === sessionId)) return r
  }
  return null
}

/**
 * 从埋点聚合调度台数据。sessionId 给定时额外返回该会话「最近一轮」的四步。
 * @param {string} sessionId
 * @param {number} limit
 */
function buildDashboard(sessionId, limit) {
  const rows = readPerf(limit)
  const executes = rows.filter((r) => r.kind === 'execute')
  const okRows = executes.filter((r) => r.success !== false)

  const byModel = new Map()
  for (const r of executes) {
    const key = String(r.model || '')
    if (!key) continue
    const cur = byModel.get(key) || { key, n: 0, ok: 0, ms: 0, lastAt: null }
    cur.n += 1
    if (r.success !== false) cur.ok += 1
    cur.ms += Number(r.latencyMs || 0)
    if (r.ts) cur.lastAt = r.ts
    byModel.set(key, cur)
  }
  const models = [...byModel.values()]
    .map((m) => ({
      key: m.key,
      n: m.n,
      ok: m.ok,
      successRate: m.n ? m.ok / m.n : 0,
      avgLatencyMs: m.n ? Math.round(m.ms / m.n) : 0,
      lastAt: m.lastAt,
    }))
    .sort((a, b) => b.n - a.n)

  const routes = rows
    .filter((r) => r.kind === 'route')
    .slice(-8)
    .reverse()
    .map((r) => ({
      at: r.ts || null,
      capability: r.capability || null,
      model: r.model || null,
      modelId: r.modelId || null,
      mode: r.mode || null,
      reason: r.reason || null,
    }))

  let turn = null
  if (sessionId) {
    const analyze = lastOf(rows, 'analyze', sessionId)
    const routeRow = lastOf(rows, 'route', sessionId)
    const multi = lastOf(rows, 'multi', sessionId)
    const execute = lastOf(rows, 'execute', sessionId)
    const verify = lastOf(rows, 'verify', sessionId)
    const idle = lastOf(rows, 'idle', sessionId)
    // 本轮每次模型调用的开销，按调用时间正序 —— 界面据此按「用了几家模型」分段展示。
    // 只有 execute 之后（本轮开始）的记录才算，避免把上一轮的用量算进来。
    const turnStart = Date.parse(routeRow?.ts || analyze?.ts || '') || 0
    const llms = rows
      .filter((r) => r.kind === 'llm' && r.sessionId === sessionId)
      .filter((r) => (Date.parse(r.ts || '') || 0) >= turnStart - 1000)
      .slice(-8)
      .map((r) => ({
        at: r.ts || null,
        role: r.role || null,
        model: r.model || null,
        provider: r.provider || null,
        modelId: r.modelId || null,
        usage: r.usage && typeof r.usage === 'object' ? r.usage : null,
      }))
    const retries = rows
      .filter((r) => r.kind === 'retry' && r.sessionId === sessionId)
      .slice(-3)
      .map((r) => ({ at: r.ts || null, round: r.round || null, reason: r.reason || null }))
    if (analyze || routeRow || execute || verify) {
      const execAt = Date.parse(execute?.ts || '') || 0
      const analyzeAt = Date.parse(analyze?.ts || '') || 0
      turn = {
        sessionId,
        analyze: analyze
          ? {
              at: analyze.ts || null,
              primary: analyze.primary || null,
              complexity: analyze.complexity || null,
              needsImage: Boolean(analyze.needsImage),
              snippet: (analyze.snippet || '').slice(0, 120),
            }
          : null,
        route: routeRow
          ? {
              at: routeRow.ts || null,
              mode: routeRow.mode || null,
              capability: routeRow.capability || null,
              model: routeRow.model || null,
              modelId: routeRow.modelId || null,
              reason: routeRow.reason || null,
              preference: routeRow.preference || null,
            }
          : null,
        multi: multi
          ? {
              at: multi.ts || null,
              steps: Array.isArray(multi.steps) ? multi.steps.slice(0, 6) : [],
              success: multi.success !== false,
            }
          : null,
        execute: execute
          ? {
              at: execute.ts || null,
              capability: execute.capability || null,
              model: execute.model || null,
              success: execute.success !== false,
              verified: Boolean(execute.verified),
              latencyMs: Number(execute.latencyMs || 0),
            }
          : null,
        verify: verify
          ? {
              at: verify.ts || null,
              verifier: verify.verifier || null,
              executor: verify.executor || null,
              score: typeof verify.score === 'number' ? verify.score : null,
              pass: verify.pass !== false,
              latencyMs: Number(verify.latencyMs || 0),
              round: verify.round || null,
              gaps: (verify.gaps || '').slice(0, 200),
            }
          : null,
        idle: idle ? { at: idle.ts || null, latencyMs: Number(idle.latencyMs || 0) } : null,
        llms,
        retries,
        // 进行中：已分析但还没有更新的执行记录
        pending: Boolean(analyzeAt) && execAt <= analyzeAt,
      }
    }
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    rows: rows.length,
    lastAt: rows.length ? rows[rows.length - 1].ts || null : null,
    totals: {
      executions: executes.length,
      ok: okRows.length,
      successRate: executes.length ? okRows.length / executes.length : null,
      avgLatencyMs: executes.length
        ? Math.round(executes.reduce((s, r) => s + Number(r.latencyMs || 0), 0) / executes.length)
        : null,
    },
    models,
    routes,
    turn,
    // 档案聚合（三层融合：declared / research / actual），失败时为 null
    intel: readIntelSummary(),
  }
}

/** 模型能力档案摘要（declared / research / actual 三层来源 + 更新时间）。 */
function readIntelSummary() {
  try {
    const p = join(home(), 'model-intelligence.json')
    if (!existsSync(p)) return null
    const db = JSON.parse(readFileSync(p, 'utf8'))
    const models = db?.models && typeof db.models === 'object' ? Object.keys(db.models) : []
    return { file: 'model-intelligence.json', models: models.length, updatedAt: db?.updated ?? db?.updatedAt ?? null }
  } catch {
    return null
  }
}

/**
 * @param {string} gaps
 * @param {number} score
 */
function createUserFix(gaps, score) {
  const gapText = (gaps || '回答不完整或质量不足').slice(0, 500)
  return {
    id: `wu-ai-fix-${Date.now()}`,
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `【自动质检未通过 score=${Number(score).toFixed(2)}】\n` +
          `请针对以下问题用简体中文修正上一轮回答，直接给出修正后的完整结果，不要解释过程：\n` +
          gapText,
      },
    ],
    source: {
      kind: 'plugin',
      plugin: 'wu-ai-core',
      form: 'notice',
      summary: `verify-fail score=${Number(score).toFixed(2)}`,
    },
  }
}
