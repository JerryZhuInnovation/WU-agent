/**
 * 控制中心 ES modules 运行时冒烟（2026-10-24 模块化重构 / 2026-10-26 单页工作台）。
 * mock 最小 DOM + fetch + EventSource，驱动 main.js 完整启动链，验证：
 *   - 模块 import 图可解析（无环、无缺失导出）
 *   - 顶层事件绑定执行（各域按钮挂上 handler）
 *   - fetchCatalog → 'catalog' 事件总线 → 各渲染域产出 DOM
 *   - 单页工作台：左栏任务/文件树渲染、行内流水线的事件状态机
 *   - 工作台 risk 段（P1-6）渲染审计链状态
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/* ── 最小 DOM mock ─────────────────────────────────────────────────────── */
function mockEl() {
  const el = {
    innerHTML: '', textContent: '', _value: '', className: '', hidden: false, disabled: false,
    style: {}, dataset: {}, files: null, offsetWidth: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    children: [],
    appendChild(c) { this.children.push(c); this.innerHTML += c.innerHTML || ''; return c },
    insertAdjacentHTML(_pos, html) { this.innerHTML += html },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return mockEl() }, querySelectorAll() { return [] },
    focus() {}, scrollIntoView() {}, click() {}, remove() {},
    // 真实 DOM 的 value 恒为字符串（赋数字也会被强制）——mock 必须一致
    set value(v) { this._value = String(v) },
    get value() { return this._value },
    set onclick(fn) { this._onclick = fn }, get onclick() { return this._onclick },
  }
  return el
}
const els = new Map()
const document = {
  querySelector(sel) {
    if (!els.has(sel)) els.set(sel, mockEl())
    return els.get(sel)
  },
  querySelectorAll() { return [] },
  createElement() { return mockEl() },
  addEventListener() {}, removeEventListener() {},
  body: { classList: { add() {}, remove() {}, toggle() {}, contains() { return false } }, innerHTML: '' },
}
globalThis.document = document
globalThis.window = { open() {}, close() {}, scrollTo() {}, addEventListener() {}, parent: null }
globalThis.location = { hash: '' }
globalThis.addEventListener = () => {}
// main.js 的轮询/心跳定时器：冒烟里屏蔽，否则进程永不退出
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

/* ── EventSource mock：捕获实例，便于手动喂事件 ────────────────────────── */
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.listeners = Object.create(null)
    this.closed = false
    FakeEventSource.last = this
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  close() { this.closed = true }
  emit(type, data) {
    for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) })
  }
}
globalThis.EventSource = FakeEventSource

/* ── fetch mock：按路径返回控制中心各端点 ───────────────────────────────── */
const catalog = {
  ok: true,
  models: [
    { id: 'deepseek', label: 'DeepSeek', access: 'api', keyStatus: { state: 'ok' }, capabilities: { coding: 0.9, general: 0.8 } },
    { id: 'zhipu', label: '智谱', access: 'api', keyStatus: { state: 'auth' }, capabilities: { general: 0.85 } },
  ],
  capabilities: [{ id: 'coding', label: '写代码' }],
  prefer: {}, defaultModelId: 'deepseek', analyzerModelId: '', node: null,
  sandbox: { enforced: true, provider: 'dsh-bash-sandbox' }, workspace: '~/WU-ai-Work',
  sandboxPolicy: {
    allowedModes: ['workspace-write'],
    budget: { toolCalls: 200, wallClockMs: 7200000, reviewFails: 5 },
  },
  credentialProxy: { active: true, mode: 'proxy', port: 4519, providers: ['deepseek'] },
  dsh: null,
}
const workspace = {
  ok: true,
  executes: [{ at: '2026-10-24T10:00:00.000Z', capability: 'coding', model: 'deepseek', success: true, verified: true, latencyMs: 800 }],
  verifies: [], plans: [], routes: [], usage: [], artifacts: [], eventCount: 3,
  risk: {
    available: true, total: 12,
    counts: { DENY: 2, ASK: 3, ALLOW: 7 },
    chain: { ok: true, checked: 12, brokenAt: null },
    recent: [{ at: '2026-10-24T10:01:00.000Z', tool: 'shell', decision: 'DENY', by: 'policy', reason: '测试理由', tainted: true }],
  },
  budget: { available: true, at: '2026-10-24T10:01:00.000Z', limits: { toolCalls: 200 }, sessions: [{ session: 's-abcdef123', calls: 12, elapsedMs: 60000, reviewFails: 0, tripped: [] }] },
}
const taskHistory = {
  ok: true, workspace: '~/WU-ai-Work', pending: null,
  snapshots: [{
    commit: 'abc1234def', at: '2026-10-26T10:00:00.000Z', label: '审查 demo.py',
    files: [{ path: 'demo.py', insertions: 3, deletions: 1 }], fileCount: 1, insertions: 3, deletions: 1,
  }],
}
const fileTree = {
  ok: true, workspace: '~/WU-ai-Work', path: '',
  entries: [
    { name: 'demo.py', path: 'demo.py', type: 'file', depth: 1, size: 12, mtime: '10-26 10:00' },
    { name: 'src', path: 'src', type: 'dir', depth: 1, size: 0, mtime: '10-26 09:00' },
  ],
  truncated: false,
}
const fetchCalls = []
globalThis.fetch = async (path) => {
  fetchCalls.push(String(path))
  const body = String(path).startsWith('/api/catalog') ? catalog
    : String(path).startsWith('/api/workspace') ? workspace
    : String(path).startsWith('/api/tasks') ? taskHistory
    : String(path).startsWith('/api/files') ? fileTree
    : String(path).startsWith('/api/shadow/status') ? { ok: true, snapshot: 'abc1234', files: [{ path: 'demo.py', insertions: 3, deletions: 1 }], insertions: 3, deletions: 1 }
      : String(path).startsWith('/api/task-events') ? { ok: true, offset: 100, events: [] }
        : String(path).startsWith('/api/workflows') ? { ok: true, workflows: [{ id: 'w1', name: '模板A', goal: '目标' }] }
          : String(path).startsWith('/api/runtimes') ? { ok: true, runtimes: [], upgrade: null }
            : String(path).startsWith('/api/hardware') ? { ok: true, hardware: { system: 'macOS', arch: 'arm64', ramGb: 32, gpu: { vendor: 'Apple' }, recommendedBackend: 'metal', recommendedQuant: 'Q4_K_M' } }
              : { ok: true }
  return { ok: true, status: 200, json: async () => body }
}

test('main.js 启动链：import 解析 + 事件绑定 + catalog 广播渲染', async () => {
  await import('../ui/app/main.js')
  await new Promise((r) => setTimeout(r, 80)) // 等 fetchCatalog/loadHardware 微任务链

  // 1) 启动即拉取 catalog / hardware / 左栏数据
  assert.ok(fetchCalls.some((p) => p.startsWith('/api/catalog')), '应请求 /api/catalog')
  assert.ok(fetchCalls.some((p) => p.startsWith('/api/hardware')), '应请求 /api/hardware')
  assert.ok(fetchCalls.some((p) => p.startsWith('/api/tasks')), '应请求 /api/tasks')
  // 工作区文件树已并入产物柜（Zero-Empty-State）：/api/files 改由产物柜按需拉取
  assert.ok(fetchCalls.some((p) => p.startsWith('/api/shadow/status')), '应请求 /api/shadow/status')

  // 2) 事件总线：模型列表渲染出两个模型 + fleet 计数
  assert.match(els.get('#modelList').innerHTML, /DeepSeek/)
  assert.match(els.get('#modelList').innerHTML, /智谱/)
  assert.equal(els.get('#modelCount').textContent, '2 个模型')

  // 3) 徽章：1 个 auth 失效 → 警告文案
  assert.match(els.get('#stateText').textContent, /1 个模型密钥失效/)

  // 4) Brain：未显式指定 → 中立轮转（去偏见化：不得把某个模型显示成固定裁判员）
  assert.equal(els.get('#brainTag').textContent, '中立轮转')

  // 5) 顶栏运行控制：dsh=null → 启动按钮可见
  assert.equal(els.get('#btnLaunch').hidden, false)

  // 6) 首运行步骤：环境/模型/Brain 就绪，Agent 未启动 → 3/4
  assert.equal(els.get('#frTag').textContent, '3/4 步骤')

  // 7) 凭据代理状态：代理模式 → 占位符文案（P2-9）
  assert.match(els.get('#envCred').textContent, /代理保护中 · 1 个模型（占位符）/)

  // 8) 托管策略表单：默认白名单 + 预算回填（P2-10）
  assert.equal(els.get('#polModeDanger').checked, false)
  assert.equal(els.get('#polCalls').value, '200')
  assert.equal(els.get('#polHours').value, '2')
  assert.equal(els.get('#polFails').value, '5')
  assert.equal(els.get('#policyTag').textContent, '托管基线')
})

test('单页工作台：左栏任务历史渲染真实数据', async () => {
  const { refreshTasks } = await import('../ui/app/sidebar.js')
  await refreshTasks()

  // 任务历史：标题 + 改动统计（+3 −1）
  assert.match(els.get('#taskList').innerHTML, /审查 demo\.py/)
  assert.match(els.get('#taskList').innerHTML, /\+3/)
  assert.match(els.get('#taskList').innerHTML, /−1/)
})

test('行内流水线：派发即复位四步，真实埋点驱动状态与折叠', async () => {
  const { startTask } = await import('../ui/app/pipeline.js')
  startTask('审查 demo.py')

  // 1) 初始只有「意图分流」在跑，其余待命
  const first = els.get('#pipeStrip').innerHTML
  assert.match(first, /意图分流/)
  assert.match(first, /模型分派/)
  assert.match(first, /step-chip run/)

  // 2) SSE 推来 route：分派完成 + 模型名与选型理由可见
  const es = FakeEventSource.last
  assert.ok(es, '应建立 SSE 连接')
  es.emit('perf', { kind: 'route', model: 'glm-4.6v', capability: 'coding', reason: '此任务需要代码审阅能力' })
  const routed = els.get('#pipeStrip').innerHTML
  assert.match(routed, /glm-4\.6v/)
  assert.match(routed, /此任务需要代码审阅能力/)
  assert.match(routed, /step-chip done/)

  // 3) execute(verified=true) → 执行完成 + 核验通过
  es.emit('perf', { kind: 'execute', model: 'glm-4.6v', success: true, verified: true, latencyMs: 3200 })
  assert.match(els.get('#pipeStrip').innerHTML, /✓/)

  // 4) idle → 本轮结束，通道关闭（不留长连接）
  es.emit('perf', { kind: 'idle' })
  assert.equal(es.closed, true)
})

test('工作台 risk 段：审计计数 + 链完好 + 预算摘要', async () => {
  const { refreshWorkspaceCards } = await import('../ui/app/workspace.js')
  await refreshWorkspaceCards()
  assert.equal(els.get('#riskTag').textContent, '审计 12 条')
  assert.match(els.get('#riskStat').innerHTML, /拦截 2 · 待确认 3 · 放行 7/)
  assert.match(els.get('#riskStat').innerHTML, /审计链完好（尾部 12 条已验证）/)
  assert.match(els.get('#riskList').innerHTML, /DENY/)
  assert.match(els.get('#riskList').innerHTML, /污点会话/)
  assert.match(els.get('#riskFoot').textContent, /12\/200 次调用/)

  // 工作流模板（抽屉里）同样渲染，并回灌到发射台快捷胶囊
  assert.match(els.get('#wfList').innerHTML, /模板A/)
  assert.match(els.get('#omniTpls').innerHTML, /模板A/)
})

test('审计链断裂 → 红色警示（不静默）', async () => {
  workspace.risk.chain = { ok: false, checked: 12, brokenAt: 5 }
  const { refreshWorkspaceCards } = await import('../ui/app/workspace.js')
  await refreshWorkspaceCards()
  assert.match(els.get('#riskStat').innerHTML, /审计链在第 6 行断裂，疑似被篡改/)
  workspace.risk.chain = { ok: true, checked: 12, brokenAt: null }
})

test('左栏点任务 → TASK DIFF 切到只读回看（禁止回滚）', async () => {
  const { showSnapshot } = await import('../ui/app/shadow.js')
  showSnapshot(taskHistory.snapshots[0])
  assert.match(els.get('#shadowStat').innerHTML, /只读回看/)
  assert.match(els.get('#shadowStat').innerHTML, /审查 demo\.py/)
  assert.match(els.get('#shadowList').innerHTML, /demo\.py/)
  assert.equal(els.get('#btnShadowRollback').disabled, true)
})
