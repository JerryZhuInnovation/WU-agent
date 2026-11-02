/**
 * allocation 内核自测（方案《可验证的任务分配决策机制》）
 * 覆盖：表现账本平滑与回写 / TaskSpec 风险升级 / 方案解析与差异比对 /
 *       硬约束（环、禁止自审、无模型）/ 五维评分 / 三态门禁 / ADR 读写。
 * 运行环境由 run_all.py 提供隔离 DSH_HOME。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wuai-alloc-'))

const { getEvidence, recordOutcome, summarizeLedger, MIN_RELIABLE_SAMPLES } = await import(
  './allocation/model-performance.js'
)
const { buildTaskSpec, modelFamily, modelsOfOtherFamily } = await import('./allocation/task-analyzer.js')
const { parseAllocPlan, compareIndependentPlans, ROLE_CONTRACTS, buildRuleFallbackPlans } = await import(
  './allocation/plan-generator.js'
)
const { AllocationEvaluator, toDagPlan } = await import('./allocation/allocation-evaluator.js')
const { createADR, appendExecutionAudit, listADRs } = await import('./allocation/decision-log.js')

const REGISTRY = [
  { key: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', enabled: true, capabilities: { coding: 0.9, general: 0.8, reasoning: 0.7 } },
  { key: 'zhipu', provider: 'zhipu', model: 'glm-4.6v', enabled: true, capabilities: { vision: 0.9, coding: 0.6, general: 0.75, reasoning: 0.8 } },
]

test('账本：拉普拉斯平滑 + 样本不足标记 + 回写', () => {
  const ev0 = getEvidence('deepseek', 'coding', 'Worker')
  assert.equal(ev0.sampleSize, 0)
  assert.equal(ev0.confidenceStatus, 'INSUFFICIENT_SAMPLES')
  assert.equal(ev0.smoothedScore, 0.5) // (0+1)/(0+2)

  recordOutcome({ modelKey: 'deepseek', taskType: 'coding', role: 'Worker', passed: true, latencyMs: 100 })
  const ev1 = getEvidence('deepseek', 'coding', 'Worker')
  assert.equal(ev1.sampleSize, 1)
  assert.equal(ev1.smoothedScore, Number((2 / 3).toFixed(3))) // (1+1)/(1+2)

  // 1 次成功不得给出 100% 通过率
  assert.equal(ev1.passRate, 1)
  assert.ok(ev1.smoothedScore < 1)

  // MIN_RELIABLE_SAMPLES 阈值：不足即 INSUFFICIENT
  assert.ok(MIN_RELIABLE_SAMPLES >= 5)

  const rows = summarizeLedger(5)
  assert.ok(rows.length >= 1)
  assert.equal(rows[0].role, 'Worker')
})

test('TaskSpec：风险升级与模态识别', () => {
  const spec = buildTaskSpec({
    primary: 'coding',
    complexity: 'complex',
    needsImage: false,
    requirements: [
      { capability: 'coding', importance: 0.9 },
      { capability: 'research', importance: 0.8 },
      { capability: 'reasoning', importance: 0.85 },
    ],
    text: '重构这个模块，然后部署上线到生产环境',
  })
  assert.equal(spec.riskLevel, 'high')
  assert.equal(spec.requiresSandboxExec, true)
  assert.equal(spec.requiresFileWrite, true)
  assert.deepEqual(spec.requiredModalities, ['text'])
  assert.equal(spec.strongCapabilities.length, 3)

  const vis = buildTaskSpec({ primary: 'vision', complexity: 'medium', needsImage: true, requirements: [{ capability: 'vision', importance: 1 }], text: '看这张图' })
  assert.ok(vis.requiredModalities.includes('image'))
})

test('家族推断与异构挑选', () => {
  assert.equal(modelFamily(REGISTRY[0]), 'deepseek')
  assert.equal(modelFamily(REGISTRY[1]), 'zhipu')
  const others = modelsOfOtherFamily(REGISTRY, 'deepseek')
  assert.equal(others.length, 1)
  assert.equal(others[0].key, 'zhipu')
})

test('方案解析：白名单 / 依赖过滤 / 环拒绝', () => {
  const good = parseAllocPlan(
    JSON.stringify({
      planId: 'plan_a',
      strategySummary: '两步',
      steps: [
        { id: 's1', title: '写代码', capability: 'coding', role: 'Worker', dependsOn: [], acceptance: ['可运行'] },
        { id: 's2', title: '审查', capability: 'reasoning', role: 'Verifier', dependsOn: ['s1'] },
      ],
      fallbackStrategy: '换模型重试',
    }),
    'deepseek',
  )
  assert.ok(good)
  assert.equal(good.steps.length, 2)
  assert.deepEqual(good.steps[1].dependsOn, ['s1'])

  // 未知能力 → 拒绝
  assert.equal(
    parseAllocPlan(JSON.stringify({ steps: [{ id: 's1', title: 'x', capability: 'hacking', role: 'Worker' }] }), 'k'),
    null,
  )
  // 环 → 拒绝
  assert.equal(
    parseAllocPlan(
      JSON.stringify({
        steps: [
          { id: 's1', title: 'a', capability: 'coding', role: 'Worker', dependsOn: ['s2'] },
          { id: 's2', title: 'b', capability: 'writing', role: 'Worker', dependsOn: ['s1'] },
        ],
      }),
      'k',
    ),
    null,
  )
  // 依赖指向不存在的步 → 被过滤
  const loose = parseAllocPlan(
    JSON.stringify({ steps: [{ id: 's1', title: 'a', capability: 'coding', role: 'Worker', dependsOn: ['ghost'] }] }),
    'k',
  )
  assert.deepEqual(loose.steps[0].dependsOn, [])
})

test('差异比对：粒度分歧 / 能力遗漏 / 审查分歧', () => {
  const spec = { strongCapabilities: ['coding', 'research'] }
  const a = { steps: [{ capability: 'coding' }, { capability: 'research' }], plannerKey: 'x' }
  const b = {
    steps: [
      { capability: 'coding' },
      { capability: 'writing' },
      { capability: 'general' },
      { capability: 'reasoning' },
    ],
    plannerKey: 'y',
  }
  const d = compareIndependentPlans([a, b], spec)
  assert.ok(d.hasMajorConflict)
  assert.ok(d.conflicts.some((c) => c.includes('粒度')))
  assert.ok(d.conflicts.some((c) => c.includes('research')))

  assert.deepEqual(compareIndependentPlans([a], spec), { hasMajorConflict: false, conflicts: [] })
})

const taskSpec = {
  taskType: 'coding',
  complexity: 'complex',
  requiredModalities: ['text'],
  requiresSandboxExec: true,
  requiresFileWrite: true,
  riskLevel: 'medium',
  strongCapabilities: ['coding', 'reasoning'],
  estimatedInputTokens: 2000,
}

const plans = {
  planningMode: 'BLIND_DUAL_PLANNERS',
  plannersUsed: [{ key: 'deepseek', family: 'deepseek' }, { key: 'zhipu', family: 'zhipu' }],
  challengerKey: 'zhipu',
  divergenceReport: { hasMajorConflict: false, conflicts: [] },
  redTeamCritiques: [],
  candidates: [
    {
      planId: 'plan_a',
      strategySummary: '两步',
      fallbackStrategy: '换次优模型重试一次',
      plannerKey: 'deepseek',
      steps: [
        { id: 's1', title: '实现', capability: 'coding', role: 'Worker', dependsOn: [], acceptance: ['可运行'], responsibility: '写代码', nonResponsibility: '不审查', verificationMethod: '沙箱运行' },
        { id: 's2', title: '核验', capability: 'reasoning', role: 'Verifier', dependsOn: ['s1'], acceptance: ['逻辑一致'], responsibility: '独立核验', nonResponsibility: '不重写', verificationMethod: '规则检查' },
      ],
    },
    {
      planId: 'plan_b',
      strategySummary: '一步',
      fallbackStrategy: '',
      plannerKey: 'zhipu',
      steps: [{ id: 's1', title: '全包', capability: 'coding', role: 'Worker', dependsOn: [], acceptance: ['完成'], responsibility: '全做', nonResponsibility: '-', verificationMethod: '自查' }],
    },
  ],
}

test('评估：模型分配 + 禁止自审 + 三态 EXECUTABLE', () => {
  const ev = new AllocationEvaluator(() => ({
    confidenceStatus: 'RELIABLE',
    sampleSize: 20,
    smoothedScore: 0.9,
    passRate: 0.9,
    reworkRate: 0,
  }))
  const result = ev.evaluate({ taskSpec, planningResult: plans, registry: REGISTRY, runtimeEnv: { sandboxAvailable: true, authorizedFileWrite: true } })
  assert.equal(result.state, 'EXECUTABLE')
  assert.equal(result.selected.plan.planId, 'plan_a')
  const [s1, s2] = result.selected.plan.steps
  assert.equal(result.selected.assignments[s1.id].key, 'deepseek')
  // Verifier 不得与 Worker 同模型
  assert.notEqual(result.selected.assignments[s2.id].key, result.selected.assignments[s1.id].key)
  assert.deepEqual(result.selected.uncertainties, [])
  const dag = toDagPlan(result.selected)
  assert.equal(dag.steps.length, 2)
  assert.equal(dag.frozen, true)
  assert.ok(dag.roleByStep)
})

test('评估：HOLD_FOR_CONFIRMATION（全部违反硬约束）', () => {
  const ev = new AllocationEvaluator(() => ({ confidenceStatus: 'RELIABLE', sampleSize: 20, smoothedScore: 0.9, reworkRate: 0 }))
  const broken = {
    ...plans,
    candidates: [
      {
        ...plans.candidates[0],
        steps: [
          { id: 's1', title: 'x', capability: 'coding', role: 'Worker', dependsOn: ['s1'] }, // 自环
        ],
      },
    ],
  }
  const result = ev.evaluate({ taskSpec, planningResult: broken, registry: REGISTRY, runtimeEnv: {} })
  assert.equal(result.state, 'HOLD_FOR_CONFIRMATION')
  assert.ok(result.reason.includes('硬约束'))
  assert.equal(result.selected, null)
})

test('评估：TRIAL_FIRST（样本不足）与探针步挑选', () => {
  const ev = new AllocationEvaluator(() => ({ confidenceStatus: 'INSUFFICIENT_SAMPLES', sampleSize: 2, smoothedScore: 0.6, reworkRate: 0 }))
  const result = ev.evaluate({ taskSpec, planningResult: plans, registry: REGISTRY, runtimeEnv: {} })
  assert.equal(result.state, 'TRIAL_FIRST')
  assert.ok(result.selected.uncertainties.length > 0)
  assert.equal(result.probeStepId, 's1') // 第一个 Worker 步
  // 低风险任务下缺独立 Verifier 候选不否决，但即使如此单模型 REGISTRY 也能给出方案
  const lowRisk = { ...taskSpec, riskLevel: 'low' }
  const r2 = ev.evaluate({ taskSpec: lowRisk, planningResult: plans, registry: REGISTRY, runtimeEnv: {} })
  assert.ok(['TRIAL_FIRST', 'EXECUTABLE'].includes(r2.state))
})

test('评估：高风险任务禁止执行者兼任审查（硬否决）', () => {
  const ev = new AllocationEvaluator(() => ({ confidenceStatus: 'RELIABLE', sampleSize: 20, smoothedScore: 0.9, reworkRate: 0 }))
  // 只有 deepseek 一个模型可用：Verifier 必然与 Worker 同模型 → 高风险必须 HOLD
  const result = ev.evaluate(
    { taskSpec: { ...taskSpec, riskLevel: 'high' }, planningResult: { ...plans, candidates: [plans.candidates[0]] }, registry: [REGISTRY[0]], runtimeEnv: {} },
  )
  assert.equal(result.state, 'HOLD_FOR_CONFIRMATION')
  // 单模型下「找不到独立审查者」直接拦在分配层；「违反独立验证原则」是同一条
  // 硬法则的第二道防线（防绕过 assignModels 的路径）——两者任一出现都算拦住
  assert.ok(
    result.allEvaluated.some((c) =>
      c.hardViolations.some((v) => v.includes('独立') || v.includes('找不到合格模型')),
    ),
  )
})

test('评估：红队质疑进入不确定性与降分', () => {
  const ev = new AllocationEvaluator(() => ({ confidenceStatus: 'RELIABLE', sampleSize: 20, smoothedScore: 0.9, reworkRate: 0 }))
  const critiqued = {
    ...plans,
    redTeamCritiques: [
      { targetPlanId: 'plan_a', issueType: 'MISSING_STEP', evidence: '缺少依赖安装步', severity: 'HIGH' },
    ],
  }
  const result = ev.evaluate({ taskSpec, planningResult: critiqued, registry: REGISTRY, runtimeEnv: {} })
  assert.ok(result.selected.uncertainties.some((u) => u.includes('遗漏')))
  const base = new AllocationEvaluator(() => ({ confidenceStatus: 'RELIABLE', sampleSize: 20, smoothedScore: 0.9, reworkRate: 0 })).evaluate({
    taskSpec,
    planningResult: plans,
    registry: REGISTRY,
    runtimeEnv: {},
  })
  assert.ok(result.selected.totalScore <= base.selected.totalScore)
})

test('ADR：创建 / 归因回填 / 列表', () => {
  const ev = new AllocationEvaluator(() => ({ confidenceStatus: 'RELIABLE', sampleSize: 20, smoothedScore: 0.9, reworkRate: 0 })).evaluate({
    taskSpec,
    planningResult: plans,
    registry: REGISTRY,
    runtimeEnv: {},
  })
  const adr = createADR({ sessionId: 'sess-test', taskSpec, planningResult: plans, evaluation: ev })
  assert.ok(adr.adrId.startsWith('adr_'))
  assert.equal(adr.decisionState, ev.state)
  assert.equal(adr.selectedAllocation.length, 2)
  assert.ok(adr.selectedAllocation.every((s) => s.mustDo && s.verification))

  appendExecutionAudit(adr.adrId, { finalSuccess: false, failureRootCause: 'MODEL_MISMATCH', reworkCount: 1, note: '探针未过' })
  const rows = listADRs(10)
  assert.ok(rows.length >= 1)
  const mine = rows.find((r) => r.adrId === adr.adrId)
  assert.equal(mine.audit.failureRootCause, 'MODEL_MISMATCH')
  assert.equal(mine.audit.finalSuccess, false)
})

test('规则回退候选：LLM 全失败时的确定性拆解', () => {
  const spec = { strongCapabilities: ['coding', 'reasoning'], complexity: 'complex', riskLevel: 'medium', taskType: 'coding' }
  const plans = buildRuleFallbackPlans(spec, { primary: 'coding' })
  assert.equal(plans.length, 2)
  assert.equal(plans[0].planId, 'plan_rule_single')
  assert.equal(plans[1].planId, 'plan_rule_multi')
  // 每个候选都要能过评估器：硬约束 + 禁止自审（Verifier 独立于 Worker）
  const ev = new AllocationEvaluator(() => ({ confidenceStatus: 'RELIABLE', sampleSize: 20, smoothedScore: 0.9, reworkRate: 0 }))
  const result = ev.evaluate({
    taskSpec: spec,
    planningResult: { candidates: plans, divergenceReport: compareIndependentPlans(plans, spec), redTeamCritiques: [] },
    registry: REGISTRY,
    runtimeEnv: {},
  })
  assert.ok(['EXECUTABLE', 'TRIAL_FIRST'].includes(result.state), `state=${result.state} violations=${JSON.stringify(result.allEvaluated.map((c) => c.hardViolations))}`)
  assert.ok(result.selected)
  // 规划者失效不产生 ADR 盲区：模式必须如实标记
  assert.equal(plans[0].plannerKey, 'rule')
})

test('角色契约：职责与验收一一对应', () => {
  for (const [role, c] of Object.entries(ROLE_CONTRACTS)) {
    assert.ok(c.duty.length > 4, `${role} 缺职责`)
    assert.ok(c.acceptance.length > 4, `${role} 缺验收依据`)
  }
})

test.after?.(() => {
  try {
    rmSync(process.env.DSH_HOME, { recursive: true, force: true })
  } catch {}
})
