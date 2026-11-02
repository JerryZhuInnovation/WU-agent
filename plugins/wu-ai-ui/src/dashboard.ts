/**
 * WU ai 客户端插件 — 调度台（Dashboard）
 * 拆分自原 client.ts（2026-10-24 模块化重构）。
 * 数据来自路由器埋点（本机 $DSH_HOME/perf.jsonl）经同源 /wu-ai/dashboard 暴露：
 *   analyze / route / multi / verify / retry / execute，即本轮流水线的四步。
 * 渐进式披露三层：第 1 层一行摘要 → 第 2 层展开四步 → 第 3 层为原始数值（模型 ID、
 * 耗时、分数、依据）。任何拿不到的字段一律不显示，绝不补默认文案。
 */

import { DASHBOARD_ROOT_ID } from './ids'
import { DASH_CARET, DASH_ICON } from './assets'
import { esc, openMenu, closeMenu, placeMenu, emptySlotIn } from './dom'
import { serverStatus } from './status'

const CAP_LABELS: Record<string, string> = {
  coding: '写代码',
  vision: '看图 / 视觉',
  reasoning: '深度推理',
  research: '调研资料',
  writing: '写作 / 翻译',
  general: '通用对话',
}
const COMPLEXITY_LABELS: Record<string, string> = {
  trivial: '极简',
  simple: '简单',
  medium: '中等',
  complex: '复杂',
}
const ROLE_LABELS: Record<string, string> = {
  execute: '执行',
  analyze: '分析',
  verify: '质检',
  multi: '多步',
}

interface DashModel {
  key: string
  n: number
  ok: number
  successRate: number
  avgLatencyMs: number
  lastAt: string | null
}
interface DashRoute {
  at: string | null
  capability: string | null
  model: string | null
  modelId: string | null
  mode: string | null
  reason: string | null
}
interface DashLlmCall {
  at: string | null
  role: string | null
  model: string | null
  provider: string | null
  modelId: string | null
  usage: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
    total?: number
  } | null
}
interface DashTurn {
  sessionId: string
  analyze: { at: string | null; primary: string | null; complexity: string | null; needsImage: boolean; snippet: string } | null
  route: { at: string | null; mode: string | null; capability: string | null; model: string | null; modelId: string | null; reason: string | null; } | null
  multi: { at: string | null; steps: Array<{ capability?: string; model?: string }>; success: boolean } | null
  execute: { at: string | null; capability: string | null; model: string | null; success: boolean; verified: boolean; latencyMs: number } | null
  verify: { at: string | null; verifier: string | null; executor: string | null; score: number | null; pass: boolean; latencyMs: number; round: number | null; gaps: string } | null
  idle: { at: string | null; latencyMs: number } | null
  /** 本轮每次模型调用的开销（按时间正序）。老版本埋点没有这个字段。 */
  llms?: DashLlmCall[]
  retries: Array<{ at: string | null; round: number | null; reason: string | null }>
  pending: boolean
}
interface DashPayload {
  ok: boolean
  rows: number
  lastAt: string | null
  totals: { executions: number; ok: number; successRate: number | null; avgLatencyMs: number | null }
  models: DashModel[]
  routes: DashRoute[]
  turn: DashTurn | null
  intel: { file: string; models: number; updatedAt: string | null } | null
}

export function fmtMs(ms?: number | null): string {
  const n = Number(ms || 0)
  if (!n) return ''
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function capLabel(id?: string | null): string {
  if (!id) return '未知'
  return CAP_LABELS[id] || id
}

export function modelLabel(key?: string | null): string {
  if (!key) return '未知'
  const m = serverStatus?.models?.find((x) => x.id === key)
  return m?.label || key
}

/** 选模依据 → 人类语言。未知前缀不猜，返回 null（宁可不显示）。 */
export function reasonText(reason?: string | null): string | null {
  if (!reason) return null
  const [head, ...rest] = reason.split(':')
  const arg = rest.join(':')
  if (head === 'cap') return '能力匹配：按能力分排序（手动模式）'
  if (head === 'smart-cap') return 'Router Brain 分析任务后按能力分排序'
  if (head === 'smart-intel') {
    const src = arg.split(':')[1] || ''
    const srcText =
      src === 'actual' ? '实际使用表现' : src === 'research' ? '调研档案' : src === 'declared' ? '声明能力' : '能力档案'
    return `Router Brain 分析任务后按${srcText}排序`
  }
  return null
}

function currentSessionId(): string {
  try {
    const raw = localStorage.getItem('dsh.sessions.current')
    if (!raw) return ''
    const v = JSON.parse(raw) as { sessionId?: string }
    return typeof v?.sessionId === 'string' ? v.sessionId : ''
  } catch {
    return ''
  }
}

async function fetchDashboard(): Promise<DashPayload | null> {
  const sid = currentSessionId()
  const q = sid ? `?session=${encodeURIComponent(sid)}` : ''
  try {
    const r = await fetch(`/wu-ai/dashboard${q}`, { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as DashPayload
  } catch {
    return null
  }
}

/** 本轮调度结果短缓存：用量改写与调度台共用一次请求（本地文件读，仍不宜每帧打）。 */
let dashCache: { at: number; payload: DashPayload | null } = { at: 0, payload: null }
async function dashboardCached(ttlMs = 4000): Promise<DashPayload | null> {
  if (Date.now() - dashCache.at < ttlMs) return dashCache.payload
  const payload = await fetchDashboard()
  dashCache = { at: Date.now(), payload }
  return payload
}

/* ── 本轮用量：按「哪家模型」分段 ─────────────────────────────────────────────
 * 需求：WU 模式下每次对话后，把「消耗了多少」换成人能读的形态 ——
 * 先某家模型及其用量，再下一家（例如先 DeepSeek、后智谱 GLM）。
 * 数据来自路由器埋点 kind='llm'（每次模型调用一行，含 executor/分析/质检/多步），
 * 数值原样取自适配器上报，缺字段就不显示 —— 绝不替用户估算。 */

/** 紧凑 token 数（与 DSH 同风格）：517 / 12.3K / 1.2M。 */
function fmtTokens(n?: number | null): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v < 0) return ''
  if (v < 1000) return String(Math.round(v))
  if (v < 1e6) return `${(v / 1000).toFixed(v < 1e4 ? 1 : 0)}K`
  return `${(v / 1e6).toFixed(1)}M`
}

interface UsageLine {
  /** 控制中心里的模型显示名（「DeepSeek」「智谱 GLM」）——即用户说的「哪家」。 */
  vendor: string
  roles: string[]
  tokens: string
  /** 明细（输入/输出/缓存），供悬浮提示。 */
  detail: string
}

/** 把本轮的逐次调用按模型归并成展示行（保持首次出现的顺序）。 */
function usageLines(turn: DashTurn | null | undefined): UsageLine[] {
  const calls = turn?.llms
  if (!Array.isArray(calls) || !calls.length) return []
  const order: string[] = []
  const map = new Map<string, { vendor: string; roles: Set<string>; total: number; input: number; output: number; cacheRead: number; calls: number }>()
  for (const c of calls) {
    if (!c?.usage) continue
    const key = c.model || c.modelId || '未知'
    let row = map.get(key)
    if (!row) {
      row = { vendor: modelLabel(key), roles: new Set(), total: 0, input: 0, output: 0, cacheRead: 0, calls: 0 }
      map.set(key, row)
      order.push(key)
    }
    row.calls += 1
    if (c.role) row.roles.add(ROLE_LABELS[c.role] || c.role)
    row.total += Number(c.usage.total) || (Number(c.usage.input) || 0) + (Number(c.usage.output) || 0)
    row.input += Number(c.usage.input) || 0
    row.output += Number(c.usage.output) || 0
    row.cacheRead += Number(c.usage.cacheRead) || 0
  }
  const out: UsageLine[] = []
  for (const key of order) {
    const row = map.get(key)
    if (!row || !row.total) continue
    const bits = [`输入 ${fmtTokens(row.input) || '0'}`, `输出 ${fmtTokens(row.output) || '0'}`]
    if (row.cacheRead) bits.push(`缓存读取 ${fmtTokens(row.cacheRead)}`)
    if (row.calls > 1) bits.push(`${row.calls} 次调用`)
    out.push({
      vendor: row.vendor,
      roles: [...row.roles],
      tokens: fmtTokens(row.total),
      detail: bits.join(' · '),
    })
  }
  return out
}

/** 本轮用量的一句话（把「用了哪家模型、多少用量、做什么用」串起来）。 */
function usageLineText(l: UsageLine): string {
  const role = l.roles.length ? `${l.roles.join('/')} ` : ''
  return `${l.vendor} ${role}${l.tokens}`
}

/** 拉一次调度数据并重写本轮用量。
 *  轮次结束后一个轮询周期内，「用量 X」就会变成逐模型的「哪家 + 多少」。 */
export async function refreshTurnUsage(): Promise<void> {
  if (document.hidden) return
  await dashboardCached(4000)
  syncTurnUsage()
}

/** DSH 的「用量 X」按钮：正常情况下本轮尾部只有一个（最新一轮）。 */
function turnUsagePills(): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const btn of Array.from(document.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]'))) {
    const t = (btn.textContent || '').trim()
    if (t.startsWith('用量') || t.startsWith('Usage')) out.push(btn)
  }
  return out
}

/** 从元素的 hash 类名里提取语义后缀对应的 DSH 前缀（如 abc123_trigger → abc123）。 */
function modulePrefixOf(el: HTMLElement, suffix: string): string | null {
  for (const c of Array.from(el.classList)) {
    if (c.endsWith('_' + suffix)) return c.slice(0, c.length - suffix.length - 1)
  }
  return null
}

/** 把最新一轮的「用量 X」改写成逐模型用量。
 *  历史轮次拿不到逐次调用记录（埋点只有本轮），保持原文不改 —— 宁可不显示也不编。 */
export function syncTurnUsage(): void {
  const pills = turnUsagePills()
  const pill = pills[pills.length - 1]
  if (!pill) return
  const prefix = modulePrefixOf(pill, 'trigger')
  const label = prefix ? pill.querySelector<HTMLElement>(`[class*="${prefix}label"]`) : null
  if (!label) return
  if (label.dataset.wuaiUsageOrigin === undefined) {
    label.dataset.wuaiUsageOrigin = label.textContent || ''
  }
  const origin = label.dataset.wuaiUsageOrigin || ''
  const isWu = (serverStatus?.preset ?? 'wu') === 'wu'
  const lines = isWu ? usageLines(dashCache.payload?.turn) : []
  if (!lines.length) {
    if (label.textContent !== origin) label.textContent = origin
    pill.removeAttribute('title')
    return
  }
  label.textContent = lines.map(usageLineText).join(' · ')
  pill.title = lines.map((l) => `${usageLineText(l)}\n${l.detail}`).join('\n\n')
}

function dashStep(n: string, title: string, meta: string, detail: string): string {
  return `<div class="wu-ai-dash-step"><span class="n">${esc(n)}</span><span class="b">
    <span class="t"><span>${esc(title)}</span>${meta ? `<span class="ms">${esc(meta)}</span>` : ''}</span>
    <span class="d">${detail}</span></span></div>`
}

/** 第 1 层：一行摘要（默认只显示这个）。 */
function dashSummary(t: DashTurn): string {
  const models = t.multi?.steps?.length || (t.route ? 1 : 0)
  const verified = t.verify
    ? t.verify.pass
      ? '已核验'
      : '核验未通过'
      : t.execute?.verified
        ? '已核验'
        : '未核验'
  const total = (t.execute?.latencyMs || 0) + (t.verify?.latencyMs || 0)
  const state = t.pending ? '进行中' : '已完成'
  return `<button type="button" class="wu-ai-dash-sum" data-open="false">${DASH_CARET}<span>${state} · 已调度 ${models} 个模型 · ${verified}${total ? ` · ${esc(fmtMs(total))}` : ''}</span></button>`
}

/** 第 2 层：展开四步（分解自真实埋点）。 */
function dashSteps(t: DashTurn): string {
  const out: string[] = []
  if (t.analyze) {
    const bits = [capLabel(t.analyze.primary)]
    const cpx = t.analyze.complexity ? COMPLEXITY_LABELS[t.analyze.complexity] || t.analyze.complexity : ''
    if (cpx) bits.push(cpx)
    if (t.analyze.needsImage) bits.push('含图片输入')
    out.push(
      dashStep('1', '分析任务', '', `识别需求：${esc(bits.join(' · '))}${t.analyze.snippet ? `<br><em>${esc(t.analyze.snippet)}</em>` : ''}`),
    )
  }
  if (t.route) {
    // 老版本埋点没有 mode 字段：拿不到就不显示，不能默认成「手动」
    const mode = t.route.mode === 'smart' ? '✦ 自动' : t.route.mode === 'manual' ? '○ 手动' : ''
    const reason = reasonText(t.route.reason)
    const lines = [`→ <em>${esc(modelLabel(t.route.model))}</em>${t.route.modelId ? `（${esc(t.route.modelId)}）` : ''}`]
    if (reason) lines.push(`依据：${esc(reason)}`)
      if (t.multi?.steps?.length) {
      lines.push(`多路并行：${t.multi.steps.map((s) => `${esc(capLabel(s.capability))} → ${esc(modelLabel(s.model))}`).join(' ／ ')}`)
    }
    out.push(dashStep('2', '选择模型', mode, lines.join('<br>')))
  }
  if (t.execute) {
    out.push(
      dashStep('3', '执行', fmtMs(t.execute.latencyMs), `${t.execute.success ? '✓' : '✗'} ${esc(modelLabel(t.execute.model))}${t.execute.success ? ' 已返回' : ' 未完成'} · ${esc(capLabel(t.execute.capability))}`),
    )
  }
  if (t.verify) {
    const detail = t.verify.pass
      ? `✓ 质量通过${t.verify.score != null ? `（${esc(t.verify.score)}）` : ''}`
      : `⚠ 未通过${t.verify.round ? ` · 第 ${esc(t.verify.round)} 轮` : ''}${t.verify.gaps ? `<br>${esc(t.verify.gaps)}` : ''}`
    out.push(dashStep('4', '核验结果', fmtMs(t.verify.latencyMs), detail))
  }
  for (const r of t.retries || []) {
    out.push(dashStep('↻', '重试', r.round ? `第 ${esc(r.round)} 轮` : '', esc((r.reason || '').slice(0, 80))))
  }
  return out.join('')
}

function renderDashBody(p: DashPayload | null): string {
  if (!p) {
    return `<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">数据不可用</div>
      <div class="wu-ai-dash-row">读不到本机性能档案（需要 DSH 已启动本插件的新版本）</div></div>`
  }
  const t = p.turn
  const sec: string[] = []
  sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">本轮流水线</div>
    ${t ? dashSummary(t) : '<div class="wu-ai-dash-row">本会话还没有调度记录</div>'}
    ${t ? `<div class="wu-ai-dash-steps" hidden>${dashSteps(t)}</div>` : ''}</div>`)

  // 本轮用量：逐模型（哪家模型 · 做什么用 · 多少 token）。拿不到就不显示这一节。
  const usage = usageLines(t)
  if (usage.length) {
    sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">本轮用量</div>
      ${usage
        .map(
          (l) =>
            `<div class="wu-ai-dash-row"><span class="wu-ai-dash-dot"></span><span>${esc(
              l.vendor,
            )}${l.roles.length ? ` · ${esc(l.roles.join('/'))}` : ''}</span><span class="v" title="${esc(
              l.detail,
            )}">${esc(l.tokens)}</span></div>`,
        )
        .join('')}</div>`)
  }

  const models = serverStatus?.models || []
  sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">模型</div>
    ${
      models.length
        ? models
            .map((m) => {
              const rel = p.models.find((x) => x.key === m.id)
              const right = rel
                ? `${Math.round(rel.successRate * 100)}% · ${fmtMs(rel.avgLatencyMs)} · ${rel.n} 次`
                : '暂无执行记录'
              return `<div class="wu-ai-dash-row"><span class="wu-ai-dash-dot${m.apiKeyConfigured ? '' : ' warn'}"></span><span>${esc(m.label)}</span><span class="v">${esc(right)}</span></div>`
            })
            .join('')
        : '<div class="wu-ai-dash-row">控制中心不可达，读不到模型清单</div>'
    }</div>`)

  sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">近期调度</div>
    ${
      p.routes.length
        ? p.routes
            .slice(0, 5)
            .map(
              (r) =>
                `<div class="wu-ai-dash-row"><span>${esc(capLabel(r.capability))}</span><span class="v">→ ${esc(modelLabel(r.model))}${r.mode ? ` · ${r.mode === 'smart' ? '自动' : '手动'}` : ''}</span></div>`,
            )
            .join('')
        : '<div class="wu-ai-dash-row">暂无调度记录</div>'
    }</div>`)

  const rate = p.totals.successRate
  sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">可靠性</div>
    <div class="wu-ai-dash-row"><span>执行次数</span><span class="v">${esc(p.totals.executions)}</span></div>
    <div class="wu-ai-dash-row"><span>成功率</span><span class="v">${rate == null ? '暂无数据' : `${Math.round(rate * 100)}%`}</span></div>
    <div class="wu-ai-dash-row"><span>平均耗时</span><span class="v">${fmtMs(p.totals.avgLatencyMs) || '暂无数据'}</span></div>
    ${p.intel ? `<div class="wu-ai-dash-row"><span>能力档案</span><span class="v">${esc(p.intel.models)} 个模型</span></div>` : ''}</div>`)

  sec.push(
    `<div class="wu-ai-dash-foot">数据来源：本机性能档案 perf.jsonl（${p.rows} 条，最近 ${esc(fmtTime(p.lastAt))}）· 不出本机</div>`,
  )
  return sec.join('')
}

interface DashboardChip {
  root: HTMLElement
  close: () => void
}

function createDashboardChip(): DashboardChip {
  const root = document.createElement('div')
  root.id = DASHBOARD_ROOT_ID
  root.className = 'wu-ai-routing-anchor'

  const seat = document.createElement('button')
  seat.type = 'button'
  seat.className = 'wu-ai-routing-seat'
  seat.setAttribute('aria-haspopup', 'true')
  seat.setAttribute('aria-expanded', 'false')
  seat.title = '调度台：本轮调度与近期决策（真实数据）'
  seat.innerHTML = `${DASH_ICON}<span class="wu-ai-routing-label">调度台</span>`

  const panel = document.createElement('div')
  // 必须同时带 wu-ai-routing-menu：浮层底座（fixed / 描边 / 底色 / 阴影 / z-index）在那里
  panel.className = 'wu-ai-routing-menu wu-ai-dash-menu'
  panel.setAttribute('aria-label', '调度台')
  panel.hidden = true

  const headHtml = `<div class="wu-ai-dash-head"><span class="wu-ai-dash-title">调度台</span><button type="button" class="wu-ai-dash-close">关闭</button></div>`

  const wirePanel = () => {
    panel.querySelector('.wu-ai-dash-close')?.addEventListener('click', () => setOpen(false))
    const sum = panel.querySelector<HTMLElement>('.wu-ai-dash-sum')
    sum?.addEventListener('click', () => {
      const steps = panel.querySelector<HTMLElement>('.wu-ai-dash-steps')
      if (!steps) return
      const open = sum.dataset.open === 'true'
      sum.dataset.open = open ? 'false' : 'true'
      steps.hidden = open
      placeMenu(panel, seat) // 展开后高度变化，重新夹紧视口
    })
  }

  const setOpen = (open: boolean) => {
    if (open) {
      panel.innerHTML = `${headHtml}<div class="wu-ai-dash-sec"><div class="wu-ai-dash-row">正在读取本机档案…</div></div>`
      wirePanel()
      openMenu(panel, seat)
      seat.setAttribute('aria-expanded', 'true')
      void fetchDashboard().then((p) => {
        if (panel.hidden) return // 期间已被关掉
        panel.innerHTML = `${headHtml}${renderDashBody(p)}`
        wirePanel()
        placeMenu(panel, seat)
      })
      return
    }
    closeMenu(panel)
    seat.setAttribute('aria-expanded', 'false')
  }

  seat.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    setOpen(panel.hidden)
  })
  document.addEventListener('click', (e) => {
    const t = e.target as Node
    if (!root.contains(t) && !panel.contains(t)) setOpen(false)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false)
  })

  root.append(seat)
  return { root, close: () => setOpen(false) }
}

let dashboardChip: DashboardChip | undefined

/** 输入区左侧工具组的空扩展槽（`+` / `@` / 访问模式 那一组）。 */
function findToolsSlot(): HTMLElement | null {
  const card = document.querySelector<HTMLElement>('[data-composer-card]')
  if (!card) return null
  const addBtn = card.querySelector('button[aria-label^="指令"]')
  return emptySlotIn(addBtn?.parentElement, null)
}

function syncDashboardVisibility(): void {
  if (!dashboardChip) return
  dashboardChip.root.hidden = (serverStatus?.preset ?? 'wu') !== 'wu'
}

export function mountDashboardChip(): void {
  if (!dashboardChip) dashboardChip = createDashboardChip()
  const slot = findToolsSlot()
  if (slot && dashboardChip.root.parentElement !== slot) slot.appendChild(dashboardChip.root)
  syncDashboardVisibility()
}
