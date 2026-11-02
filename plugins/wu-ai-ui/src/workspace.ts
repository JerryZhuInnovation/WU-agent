/**
 * WU ai 客户端插件 — 工作台（Workspace）
 * 拆分自原 client.ts（2026-10-24 模块化重构）。
 * 文档《把这一页定义为工作台》§七第一版：新建任务/对话/项目由原生侧栏承担
 * （新会话按钮、会话树、工作区），本插件补齐「工作能力」五项与「系统」区。
 * 数据来自控制中心 /api/workspace（perf.jsonl 事件流 + 产物仓库聚合）；
 * 空数据显示空状态——样本不足必须明示，绝不伪造（文档 §四.3）。
 */

import { WS_NAV_ID, WS_PANEL_ID, ccFetch, controlCenterBase } from './ids'
import { wsIcon } from './assets'
import { esc, showToast } from './dom'
import { capLabel, fmtMs, fmtTime, modelLabel, reasonText } from './dashboard'
import { insertText, sendEditor } from './status'

interface WsPayload {
  ok: boolean
  executes: Array<{ at: string | null; capability: string | null; model: string | null; success: boolean | null; verified: boolean | null; latencyMs: number | null }>
  verifies: Array<{ at: string | null; score: number | null; pass: boolean | null; round: number | null; gaps: string | null }>
  plans: Array<{ at: string | null; steps: number }>
  routes: Array<{ at: string | null; capability: string | null; model: string | null; reason: string | null }>
  usage: Array<{ model: string; calls: number; input: number; output: number; cacheRead: number; total: number }>
  artifacts: Array<{ file: string; size: number; updatedAt: string }>
  eventCount: number
}

let wsCache: { at: number; payload: WsPayload | null } = { at: 0, payload: null }
async function workspaceCached(ttlMs = 5000): Promise<WsPayload | null> {
  if (Date.now() - wsCache.at < ttlMs) return wsCache.payload
  try {
    const r = await ccFetch('/api/workspace', { cache: 'no-store' })
    wsCache = { at: Date.now(), payload: r.ok ? ((await r.json()) as WsPayload) : null }
  } catch {
    wsCache = { at: Date.now(), payload: null }
  }
  return wsCache.payload
}

const WS_TABS: Array<{ tab: string; label: string; icon: string }> = [
  { tab: 'tasks', label: '任务中心', icon: 'tasks' },
  { tab: 'flow', label: '协作流程', icon: 'flow' },
  { tab: 'quality', label: '质量与验证', icon: 'quality' },
  { tab: 'artifacts', label: '工作成果', icon: 'artifacts' },
  { tab: 'workflows', label: '工作流', icon: 'usage' },
]

interface WfTemplate {
  id: string
  name: string
  goal: string
  steps: string
  inputs: string
  gate: string
  output: string
  updatedAt: string
}

function wfPrompt(w: WfTemplate): string {
  const sec = (h: string, v: string) => (v.trim() ? `【${h}】\n${v.trim()}\n` : '')
  return (
    `请把以下内容当作一个完整任务执行。\n\n` +
    sec('任务目标', w.goal) +
    sec('执行步骤', w.steps) +
    sec('输入要求', w.inputs) +
    sec('质量门槛', w.gate || '按你自己的专业标准自检，未满足的部分必须修复后再交付。') +
    sec('输出格式', w.output) +
    `按步骤推进，每步给出结果；如需调整计划，先说明理由再执行。`
  )
}

/** 幂等注入侧栏「工作能力」与「系统」两区块（React 重渲染后由 observer 重挂）。 */
export function mountWorkspaceNav(): void {
  if (document.getElementById(WS_NAV_ID)) return
  const panelList = document.querySelector<HTMLElement>('nav[class*="_panelList"]')
  const footArea = document.querySelector<HTMLElement>('div[class*="_footArea"]')
  if (!panelList) return

  const nav = document.createElement('div')
  nav.id = WS_NAV_ID
  nav.className = 'wu-ws-block'
  nav.innerHTML = `<div class="wu-ws-h">工作能力</div>${WS_TABS.map(
    (t) => `<button type="button" class="wu-ws-row" data-ws-tab="${t.tab}">${wsIcon(t.icon)}<span>${t.label}</span></button>`,
  ).join('')}`
  panelList.parentElement?.insertBefore(nav, panelList.nextSibling)

  if (footArea) {
    const sys = document.createElement('div')
    sys.className = 'wu-ws-block wu-ws-sys'
    sys.innerHTML = `<div class="wu-ws-h">系统</div>
      <button type="button" class="wu-ws-row" data-ws-ext="models">${wsIcon('flow')}<span>模型与能力</span></button>
      <button type="button" class="wu-ws-row" data-ws-tab="usage">${wsIcon('usage')}<span>运行记录与用量</span></button>
      <button type="button" class="wu-ws-row" data-ws-ext="settings">${wsIcon('quality')}<span>设置与权限</span></button>`
    footArea.parentElement?.insertBefore(sys, footArea)

    sys.addEventListener('click', (ev) => {
      const tabBtn = (ev.target as HTMLElement).closest<HTMLElement>('[data-ws-tab]')
      if (tabBtn) {
        openWorkspacePanel(tabBtn.dataset.wsTab || 'usage')
        return
      }
      const ext = (ev.target as HTMLElement).closest<HTMLElement>('[data-ws-ext]')
      if (ext) {
        // 模型与能力 / 设置与权限：完整管理面在控制中心（工作台文档 §三.3）
        void controlCenterBase().then((base) => window.open(base, '_blank'))
      }
    })
  }
  nav.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-ws-tab]')
    if (b) openWorkspacePanel(b.dataset.wsTab || 'tasks')
  })
}

function wsEmpty(text: string): string {
  return `<div class="wu-ws-empty">${esc(text)}</div>`
}

function wsRow(dot: string, main: string, right: string, sub = ''): string {
  return `<div class="wu-ws-line"><span class="wu-ws-dot ${dot}"></span><span class="wu-ws-main">${main}${
    sub ? `<em>${sub}</em>` : ''
  }</span><span class="wu-ws-right">${right}</span></div>`
}

/** 工作流模板列表 / 新建表单（§四.2：保存目标步骤门槛格式，不写死模型）。 */
function wsWorkflowsBody(items: WfTemplate[]): string {
  const rows = items.length
    ? items
        .map(
          (w) =>
            `<div class="wu-ws-line"><span class="wu-ws-dot"></span><span class="wu-ws-main">${esc(w.name)}<em>${esc(
              (w.goal || '').slice(0, 50),
            )}</em></span>
            <button type="button" class="wu-ws-act primary" data-wf-act="exec" data-id="${esc(w.id)}">执行</button>
            <button type="button" class="wu-ws-act" data-wf-act="del" data-id="${esc(w.id)}">删除</button></div>`,
        )
        .join('')
    : wsEmpty('还没有模板。把反复执行的工作（如「分析论文」「生成审查报告」）存成模板：目标、步骤、质量门槛与输出格式都会带上，模型执行时动态选择。')
  return `${rows}<button type="button" class="wu-ws-act wide" data-wf-act="new">+ 新建模板</button>`
}

function wsWorkflowForm(): string {
  const f = (label: string, key: string, ph: string, ta = false) =>
    `<label class="wu-ws-f"><span>${label}</span>${
      ta
        ? `<textarea data-wf-k="${key}" rows="3" placeholder="${ph}"></textarea>`
        : `<input data-wf-k="${key}" placeholder="${ph}">`
    }</label>`
  return `<div class="wu-ws-form">
    ${f('名称 *', 'name', '如：分析论文')}
    ${f('任务目标 *', 'goal', '这个模板要完成什么', true)}
    ${f('执行步骤', 'steps', '1. … 2. …（留空则由 WU-ai 自行规划）', true)}
    ${f('输入要求', 'inputs', '需要用户提供什么材料')}
    ${f('质量门槛', 'gate', '达到什么标准才算完成', true)}
    ${f('输出格式', 'output', '交付物形态')}
    <div class="wu-ws-frow"><button type="button" class="wu-ws-act primary" data-wf-act="save">保存</button>
    <button type="button" class="wu-ws-act" data-wf-act="cancel">取消</button></div>
    <div class="wu-ws-note">模板不写死模型——执行时 WU-ai 按当前可用模型与能力档案动态分配。</div></div>`
}

/** 执行模板：新会话 → 结构化 prompt 填入 Lexical 输入区 → 自动发送；失败回退剪贴板。
 *  发送双路径：Enter keydown（Lexical 快捷路径）→ 发送按钮；以编辑器清空为准判定成败。 */
async function execWorkflow(w: WfTemplate): Promise<void> {
  const prompt = wfPrompt(w)
  const fail = (msg: string) => {
    navigator.clipboard
      .writeText(prompt)
      .then(() => showToast(`${msg}已复制完整任务指令，请到输入区粘贴发送`))
      .catch(() => showToast(msg))
  }
  const newBtn = document.querySelector<HTMLElement>('button[aria-label*="新建会话"]')
  if (!newBtn) return fail('找不到新建入口。')
  newBtn.click()
  await new Promise((r) => setTimeout(r, 700))
  const editor = document.querySelector<HTMLElement>('[data-lexicalEditor], div[contenteditable="true"]')
  if (!editor) return fail('找不到输入区。')
  if (!(await insertText(editor, prompt))) return fail('输入区填充失败。')
  if (!(await sendEditor(editor))) return fail('自动发送未完成。')
  showToast('模板任务已发送')
}

function wsTabBody(tab: string, d: WsPayload): string {
  if (tab === 'tasks') {
    const ok = d.executes.filter((e) => e.success).length
    const rate = d.executes.length ? Math.round((ok / d.executes.length) * 100) : null
    const head = `<div class="wu-ws-stat">执行 ${d.executes.length} 次${
      rate == null ? '' : ` · 成功率 ${rate}%`
    }${d.eventCount ? ` · 本机事件 ${d.eventCount} 条` : ''}</div>`
    return (
      head +
      (d.executes.length
        ? d.executes
            .slice()
            .reverse()
            .map((e) =>
              wsRow(
                e.success ? 'ok' : 'bad',
                `${esc(capLabel(e.capability))} → ${esc(modelLabel(e.model))}`,
                `${e.verified === true ? '已验证' : e.verified === false ? '未验证' : ''} ${esc(fmtMs(e.latencyMs))}`,
                esc(fmtTime(e.at)),
              ),
            )
            .join('')
        : wsEmpty('还没有任务执行记录。让 WU-ai 完成一个任务后，这里会汇总它的执行与验证状态。'))
    )
  }
  if (tab === 'flow') {
    const planHtml = d.plans.length
      ? d.plans
          .slice()
          .reverse()
          .map((p) => wsRow('ok', `任务规划：${p.steps} 个步骤`, esc(fmtTime(p.at))))
          .join('')
      : wsEmpty('还没有复杂任务的规划记录。简单问题直接回答；复杂任务 WU-ai 会先拆解为带依赖的步骤，再分配模型执行。')
    const routeHtml = d.routes.length
      ? `<div class="wu-ws-sub-h">最近调度</div>` +
        d.routes
          .slice()
          .reverse()
          .map((r) => {
            const why = reasonText(r.reason)
            return wsRow('ok', `${esc(capLabel(r.capability))} → ${esc(modelLabel(r.model))}`, esc(fmtTime(r.at)), why ? esc(why) : '')
          })
          .join('')
      : ''
    return planHtml + routeHtml
  }
  if (tab === 'quality') {
    return d.verifies.length
      ? d.verifies
          .slice()
          .reverse()
          .map((v) =>
            wsRow(
              v.pass ? 'ok' : 'bad',
              `质检 ${v.score == null ? '—' : v.score.toFixed(2)} 分${v.round && v.round > 1 ? ` · 第 ${v.round} 轮` : ''}`,
              esc(fmtTime(v.at)),
              v.gaps ? esc(String(v.gaps).slice(0, 60)) : '',
            ),
          )
          .join('')
      : wsEmpty('还没有验证记录。WU-ai 会在任务完成后自动质检：检查项、分数与未通过原因都会列在这里。')
  }
  if (tab === 'artifacts') {
    return d.artifacts.length
      ? d.artifacts
          .map((a) => {
            const f = esc(a.file)
            return `<div class="wu-ws-line"><span class="wu-ws-dot"></span><span class="wu-ws-main">${f}<em>${(a.size / 1024).toFixed(1)} KB · ${a.updatedAt}</em></span>
              <button type="button" class="wu-ws-act" data-art-act="reveal" data-file="${f}">Finder</button>
              <button type="button" class="wu-ws-act" data-art-act="copy" data-file="${f}">路径</button></div>`
          })
          .join('')
      : wsEmpty('还没有正式产物。多步任务产出的文档、代码与报告会按任务归档在这里，并标注来源与时间。')
  }
  if (tab === 'usage') {
    return d.usage.length
      ? d.usage
          .map((u) =>
            wsRow(
              'ok',
              esc(modelLabel(u.model)),
              `${u.calls} 次 · 输入 ${u.input} · 输出 ${u.output}${u.cacheRead ? ` · 缓存读 ${u.cacheRead}` : ''}`,
            ),
          )
          .join('')
      : wsEmpty('暂无调用记录（数据不足时不会估算）。发起对话并让 WU-ai 调度模型后，这里按模型汇总调用量与 Token。')
  }
  return wsEmpty('未知视图')
}

/** 工作台面板内的统一动作委托（行操作与表单都在这里分发）。 */
let wfItemsCache: WfTemplate[] = []

function wsHandleAction(ev: Event, body: HTMLElement): void {
  const el = ev.target as HTMLElement
  const art = el.closest<HTMLElement>('[data-art-act]')
  if (art) {
    const file = art.dataset.file || ''
    if (art.dataset.artAct === 'reveal') {
      void ccFetch('/api/artifacts/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      })
    } else {
      navigator.clipboard
        .writeText(file)
        .then(() => showToast('已复制文件名'))
        .catch(() => {})
    }
    return
  }
  const wf = el.closest<HTMLElement>('[data-wf-act]')
  if (!wf) return
  const act = wf.dataset.wfAct || ''
  if (act === 'new') {
    body.innerHTML = wsWorkflowForm()
    return
  }
  if (act === 'cancel') {
    body.innerHTML = wsWorkflowsBody(wfItemsCache)
    return
  }
  if (act === 'save') {
    const read = (k: string) => (body.querySelector(`[data-wf-k="${k}"]`) as HTMLInputElement | null)?.value || ''
    const rec = {
      name: read('name'),
      goal: read('goal'),
      steps: read('steps'),
      inputs: read('inputs'),
      gate: read('gate'),
      output: read('output'),
    }
    if (!rec.name || !rec.goal) {
      showToast('名称与目标为必填')
      return
    }
    void ccFetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', workflow: rec }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; workflow?: WfTemplate }) => {
        if (d.ok && d.workflow) {
          wfItemsCache.push(d.workflow)
          body.innerHTML = wsWorkflowsBody(wfItemsCache)
          showToast('模板已保存')
        } else showToast(String((d as { message?: string }).message || '保存失败'))
      })
      .catch(() => showToast('保存失败：控制中心不可达'))
    return
  }
  if (act === 'del') {
    const id = wf.dataset.id || ''
    void ccFetch('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    })
      .then(() => {
        wfItemsCache = wfItemsCache.filter((w) => w.id !== id)
        body.innerHTML = wsWorkflowsBody(wfItemsCache)
      })
      .catch(() => {})
    return
  }
  if (act === 'exec') {
    const w = wfItemsCache.find((x) => x.id === wf.dataset.id)
    if (w) void execWorkflow(w)
  }
}

function openWorkspacePanel(tab: string): void {
  let panel = document.getElementById(WS_PANEL_ID)
  if (!panel) {
    panel = document.createElement('div')
    panel.id = WS_PANEL_ID
    panel.className = 'wu-ws-panel'
    panel.innerHTML = `<div class="wu-ws-head"><span class="wu-ws-title">工作台</span><button type="button" class="wu-ws-close">关闭</button></div>
      <div class="wu-ws-tabs">${WS_TABS.map(
        (t) => `<button type="button" data-ws-tab="${t.tab}">${t.label}</button>`,
      ).join('')}<button type="button" data-ws-tab="usage">用量</button></div>
      <div class="wu-ws-body"></div>`
    document.body.appendChild(panel)
    panel.querySelector('.wu-ws-close')?.addEventListener('click', () => panel?.remove())
    panel.querySelector('.wu-ws-tabs')?.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-ws-tab]')
      if (b) openWorkspacePanel(b.dataset.wsTab || 'tasks')
    })
    const bodyEl = panel.querySelector<HTMLElement>('.wu-ws-body')
    bodyEl?.addEventListener('click', (ev) => {
      if (bodyEl) wsHandleAction(ev, bodyEl)
    })
  }
  panel.querySelectorAll('.wu-ws-tabs [data-ws-tab]').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.wsTab === tab)
  })
  const body = panel.querySelector('.wu-ws-body')
  if (!body) return
  if (tab === 'workflows') {
    body.innerHTML = '<div class="wu-ws-empty">正在读取模板…</div>'
    void ccFetch('/api/workflows', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { workflows?: WfTemplate[] }) => {
        wfItemsCache = Array.isArray(d.workflows) ? d.workflows : []
        if (body.isConnected) body.innerHTML = wsWorkflowsBody(wfItemsCache)
      })
      .catch(() => {
        if (body.isConnected) body.innerHTML = wsEmpty('控制中心不可达，读不到模板。')
      })
    return
  }
  body.innerHTML = '<div class="wu-ws-empty">正在读取本机档案…</div>'
  void workspaceCached().then((d) => {
    if (!panel?.isConnected) return
    body.innerHTML = d
      ? wsTabBody(tab, d)
      : wsEmpty('控制中心不可达（127.0.0.1:3780）。工作台数据在本机聚合，需要控制中心运行。')
  })
}
