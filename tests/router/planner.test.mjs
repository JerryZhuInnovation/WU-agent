/**
 * Planner + Scheduler 单元测试（V1）：
 * 计划解析校验（白名单/依赖存在/环检测）/ DAG 波次执行（依赖顺序、同波并行、
 * 失败换模重分配）/ 验收标准冻结进入 prompt / 规划超时回退。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planTasks, parsePlan, executeDAG } from '../../plugins/wu-ai-router/planner.js'

const HOME = mkdtempSync(join(tmpdir(), 'wu-plan-'))

/** 最小可用 registry（rankModels 真跑，验证资格过滤 + 排序真实生效）。 */
function makeRegistry() {
  return [
    {
      key: 'coder', provider: 'p-coder', model: 'coder-x', enabled: true,
      capabilities: { coding: 0.95, reasoning: 0.8, general: 0.7, research: 0.4, writing: 0.4, vision: 0 },
      costScore: 0.7, latencyScore: 0.7,
    },
    {
      key: 'writer', provider: 'p-writer', model: 'writer-x', enabled: true,
      capabilities: { coding: 0.3, reasoning: 0.7, general: 0.8, research: 0.6, writing: 0.95, vision: 0 },
      costScore: 0.8, latencyScore: 0.8,
    },
    {
      key: 'researcher', provider: 'p-res', model: 'res-x', enabled: true,
      capabilities: { coding: 0.4, reasoning: 0.8, general: 0.7, research: 0.95, writing: 0.7, vision: 0 },
      costScore: 0.6, latencyScore: 0.6,
    },
  ]
}

const OPTS = (over = {}) => ({
  registry: makeRegistry(),
  taskState: {
    taskId: 'task_sess-plan01',
    goal: '制作科研 Poster',
    constraints: ['英文输出'],
    confirmedFacts: [],
    openQuestions: [],
    artifacts: [],
    completedSteps: [],
    dshHome: HOME,
  },
  sessionId: 'sess-plan01',
  reliability: null,
  prefer: {},
  logLine: () => {},
  ...over,
})

test('parsePlan：合法计划通过；能力越界/依赖环/空步/无 JSON 全部拒绝', () => {
  const good = parsePlan(`前置 {"steps":[
    {"id":"s1","title":"资料分析","capability":"research","dependsOn":[],"acceptance":["提取 3 条结论"]},
    {"id":"s2","title":"撰写正文","capability":"writing","dependsOn":["s1"],"acceptance":["覆盖全部结论"]}
  ]} 后缀`)
  assert.equal(good.length, 2)
  assert.deepEqual(good[1].dependsOn, ['s1'])

  assert.equal(parsePlan('{"steps":[{"id":"s1","title":"x","capability":"magic","dependsOn":[]}]}'), null)
  assert.equal(
    parsePlan(`{"steps":[
      {"id":"s1","title":"a","capability":"coding","dependsOn":["s2"]},
      {"id":"s2","title":"b","capability":"writing","dependsOn":["s1"]}
    ]}`),
    null,
  )
  assert.equal(parsePlan('{"steps":[]}'), null)
  assert.equal(parsePlan('模型应该是 coder'), null)
})

test('planTasks：callModel 正常解析；超时/异常/非法输出都返回 null（回退信号）', async () => {
  const plan = await planTasks(null, {
    engine: { provider: 'p', model: 'm' },
    analysis: { text: '做 Poster', requirements: [{ capability: 'writing', importance: 0.9 }] },
    taskState: { goal: '做 Poster', constraints: [] },
    logLine: () => {},
    callModel: async () =>
      '规划如下 {"steps":[{"id":"s1","title":"撰写","capability":"writing","dependsOn":[],"acceptance":["八行以内"]}]}',
  })
  assert.equal(plan.frozen, true)
  assert.equal(plan.steps[0].capability, 'writing')

  assert.equal(
    await planTasks(null, { engine: { provider: 'p', model: 'm' }, analysis: {}, taskState: {}, callModel: async () => '我没有 JSON' }),
    null,
  )
  assert.equal(
    await planTasks(null, {
      engine: { provider: 'p', model: 'm' },
      analysis: {},
      taskState: {},
      callModel: async () => {
        throw new Error('network down')
      },
    }),
    null,
  )
  assert.equal(await planTasks(null, { engine: null, analysis: {}, taskState: {} }), null)
})

test('executeDAG：依赖顺序（s2 等 s1）+ 每步按能力选模 + 产物登记 + 冻结验收进 prompt', async () => {
  const seq = []
  const prompts = []
  const plan = {
    frozen: true,
    steps: [
      { id: 's1', title: '资料分析', capability: 'research', dependsOn: [], acceptance: ['提取 3 条结论'] },
      { id: 's2', title: '撰写正文', capability: 'writing', dependsOn: ['s1'], acceptance: ['覆盖全部结论'] },
    ],
  }
  const res = await executeDAG(null, plan, OPTS({
    execFn: async (input) => {
      seq.push(`${input.model}@${String(input.prompt).includes('【本步子任务】资料分析') ? 's1' : 's2'}`)
      prompts.push(input.prompt)
      await new Promise((r) => setTimeout(r, 5))
      return `结果 of ${input.model}`
    },
  }))
  assert.equal(res.planUsed, true)
  assert.deepEqual(res.steps.map((s) => s.id), ['s1', 's2'])
  // 依赖顺序：researcher 先（s1），writer 后（s2）。execFn 收到的是 model id（非 key）
  assert.match(seq[0], /^res-x@s1$/)
  assert.match(seq[1], /^writer-x@s2$/)
  // 验收标准冻结：进入执行 prompt 且标注「不得自行降低」
  const p1 = prompts.find((p) => p.includes('资料分析'))
  assert.ok(p1.includes('【验收标准（执行前已冻结，不得自行降低）】'))
  assert.ok(p1.includes('提取 3 条结论'))
  // 产物仓库落盘
  assert.ok(existsSync(join(HOME, 'wu-ai-context', 'task_sess-plan01_art1.json')))
})

test('executeDAG：同波并行（无依赖的两步并发执行）', async () => {
  let active = 0
  let maxActive = 0
  const plan = {
    frozen: true,
    steps: [
      { id: 'a', title: '调研', capability: 'research', dependsOn: [], acceptance: [] },
      { id: 'b', title: '写作', capability: 'writing', dependsOn: [], acceptance: [] },
    ],
  }
  const res = await executeDAG(null, plan, OPTS({
    execFn: async (input) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 15))
      active--
      return `done ${input.model}`
    },
  }))
  assert.equal(res.steps.length, 2)
  assert.ok(maxActive >= 2, `同波应并行执行（maxActive=${maxActive}）`)
})

test('executeDAG：失败换模重分配（首选模型抛错 → 次优顶上，只重分配失败步）', async () => {
  const tries = []
  const plan = { frozen: true, steps: [{ id: 's1', title: '写代码', capability: 'coding', dependsOn: [], acceptance: [] }] }
  const res = await executeDAG(null, plan, OPTS({
    execFn: async (input) => {
      tries.push(input.model)
      if (input.model === 'coder-x') throw new Error('provider 503')
      return 'fallback ok'
    },
  }))
  assert.equal(res.steps.length, 1)
  assert.equal(res.steps[0].model, 'researcher') // coder 失败 → 次优（coding 排序第二）
  assert.deepEqual(tries, ['coder-x', 'res-x'])
})

test('executeDAG：全部步失败不抛异常、summary 为空（编排层故障不阻断）', async () => {
  const plan = { frozen: true, steps: [{ id: 's1', title: 'x', capability: 'coding', dependsOn: [], acceptance: [] }] }
  const res = await executeDAG(null, plan, OPTS({ execFn: async () => { throw new Error('all down') } }))
  assert.equal(res.steps.length, 0)
  assert.equal(res.summary, '')
})
