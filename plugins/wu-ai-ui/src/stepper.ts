/**
 * WU ai 客户端插件 —— 行内流水线（Inline Pipeline Stepper）
 * 数据来源：控制中心 /api/workspace（本机 perf.jsonl 聚合）。不用 /wu-ai/dashboard：
 * 该路由在当前 DSH 版本里 404（已实测），直接读控制中心更可靠。
 *
 * 生成中：在状态行下方显示四步实时进度 + 选模理由；
 * 结束后：折叠成一行胶囊，挂在本轮消息末尾（每轮只挂一次）。
 * 约束：节点只挂在列表容器边缘，绝不改动 React 拥有的消息节点内部。
 */

import { ccFetch } from './ids'

const STEP_ID = 'wu-ai-stepper'
const POLL_MS = 2000

interface Evt {
  at?: string | null
  capability?: string | null
  model?: string | null
  reason?: string | null
  latencyMs?: number | null
  verified?: boolean | null
  pass?: boolean | null
  score?: number | null
}
interface WsData {
  routes?: Evt[]
  executes?: Evt[]
  verifies?: Evt[]
}

const CAP: Record<string, string> = {
  coding: '写代码',
  vision: '视觉',
  reasoning: '推理',
  research: '调研',
  writing: '写作',
  general: '通用',
}

async function fetchWs(): Promise<WsData | null> {
  try {
    const r = await ccFetch('/api/workspace', { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as WsData
  } catch {
    return null
  }
}

const lastAt = (rows?: Evt[]): string => (rows && rows.length ? String(rows[rows.length - 1]?.at || '') : '')
const newest = (rows?: Evt[], baseAt = ''): Evt | null => {
  if (!rows || !rows.length) return null
  const last = rows[rows.length - 1]
  return String(last?.at || '') > baseAt ? last : null
}

function stage(done: boolean, run: boolean, label: string): string {
  const mark = done ? '✓' : run ? '↻' : '○'
  const cls = done ? 'done' : run ? 'run' : ''
  return `<span class="wu-step ${cls}"><b>${mark}</b>${label}</span>`
}

/** 分配决策状态徽章：路由 reason 以 allocation: 开头时展示（可审计任务分配）。 */
function allocBadge(reason: string): string {
  if (!reason.startsWith('allocation:')) return ''
  const state = reason.slice('allocation:'.length)
  const map: Record<string, string> = {
    EXECUTABLE: '🟢 可执行',
    TRIAL_FIRST: '🟡 先试运行',
    HOLD_FOR_CONFIRMATION: '🔴 待确认',
  }
  return map[state] ? ` <span class="wu-alloc">${map[state]}</span>` : ''
}

function liveHtml(s: { a: boolean; r: boolean; e: boolean; v: boolean }, route: Evt | null): string {
  const cur = !s.a ? 1 : !s.r ? 2 : !s.e ? 3 : !s.v ? 4 : 0
  const label = route?.model ? `${CAP[String(route.capability || 'general')] || '任务'} · ${route.model}` : ''
  const reason = (route?.reason || '').replace(/^allocation:\w+\s*/, '')
  const badge = allocBadge(route?.reason || '')
  return `
    <div class="wu-stepbar">
      ${stage(s.a, cur === 1, '意图分流')}
      ${stage(s.r, cur === 2, `模型分派${label ? `：${label}` : ''}${badge}`)}
      ${stage(s.e, cur === 3, '执行')}
      ${stage(s.v, cur === 4, '沙箱核验')}
    </div>
    ${reason ? `<div class="wu-stepreason">${reason}</div>` : ''}
  `
}

function capsuleHtml(s: { r: boolean; e: boolean; v: boolean }, route: Evt | null, exec: Evt | null, ver: Evt | null): string {
  const ms = Number(exec?.latencyMs || 0)
  const time = ms ? ` · ${(ms / 1000).toFixed(1)}s` : ''
  const who = route?.model ? ` · ${route.model} 执行` : ''
  const verdict = ver ? (ver.pass ? '✅ 核验通过' : '⚠ 核验未完全通过') : s.v ? '✅ 已核验' : '—'
  const badge = allocBadge(route?.reason || '')
  return `<span class="wu-capsule">⚡ 4 步流水线${time}${who} · ${verdict}${badge}<button type="button" class="wu-trace">查看轨迹 ▸</button></span>`
}

export function startStepper(): void {
  let node: HTMLElement | null = null
  let lastParent: HTMLElement | null = null
  let capsuleSig = ''
  /** 本轮基线：运行开始时各事件的最后时间戳；之后出现更新的才视为该步完成。 */
  let base = { r: '', e: '', v: '' }
  let beganAt = 0
  let runningPrev = false

  const tick = async (): Promise<void> => {
    const runningRow = document.querySelector<HTMLElement>('[data-chat-running]')
    const parent = (runningRow?.parentElement ?? null) as HTMLElement | null
    if (parent) lastParent = parent
    const data = await fetchWs()

    if (!runningRow || !parent) {
      runningPrev = false
      // React 未必移除注入节点；在原来那一个上就地折叠，避免重复插入。
      // 若节点已被列表重建移除，就在原来的父容器末尾重新挂一次——否则
      // 「查看轨迹」入口会连同节点一起消失（实测运行结束后偶发）。
      if (data && (!node || !node.isConnected)) {
        if (!lastParent?.isConnected) return
        node = document.createElement('div')
        node.id = STEP_ID
        node.className = 'wu-stepper'
        lastParent.appendChild(node)
      }
      if (node && data && !node.classList.contains('collapsed')) {
        node.classList.add('collapsed')
        node.innerHTML = capsuleHtml(
          { r: true, e: true, v: true },
          latest(data.routes),
          latest(data.executes),
          latest(data.verifies),
        )
        capsuleSig = lastAt(data.verifies) || lastAt(data.executes)
      }
      return
    }

    if (!runningPrev) {
      runningPrev = true
      beganAt = Date.now()
      base = { r: lastAt(data?.routes), e: lastAt(data?.executes), v: lastAt(data?.verifies) }
    }
    const route = newest(data?.routes, base.r)
    const exec = newest(data?.executes, base.e)
    const ver = newest(data?.verifies, base.v)
    const states = {
      a: Date.now() - beganAt > 800,
      r: Boolean(route),
      e: Boolean(exec),
      v: Boolean(ver),
    }
    if (!node || !node.isConnected) {
      node = document.createElement('div')
      node.id = STEP_ID
      node.className = 'wu-stepper'
      runningRow.insertAdjacentElement('afterend', node)
    }
    node.innerHTML = liveHtml(states, route)
    node.classList.remove('collapsed')
  }

  const latest = (rows?: Evt[]): Evt | null => (rows && rows.length ? rows[rows.length - 1] : null)

  document.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement | null
    if (!el?.closest?.('.wu-trace')) return
    try {
      window.parent?.postMessage({ type: 'wu:open-trace' }, '*')
    } catch {
      /* 独立打开（非内嵌）时没有父窗口，忽略 */
    }
  })

  setInterval(() => void tick(), POLL_MS)
}
