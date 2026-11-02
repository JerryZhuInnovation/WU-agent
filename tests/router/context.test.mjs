/**
 * Context Manager 单元测试（V0.1/V0.2）：
 * TaskState 更新与签名重置 / 预算裁剪顺序 / 产物登记与检索 / 质检上下文分层。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  estimateTokens,
  createTaskState,
  updateFromAnalysis,
  updateFromVerify,
  addArtifact,
  readArtifact,
  buildSubtaskContext,
  buildVerifyContext,
  SUBTASK_BUDGET_CHARS,
} from '../../plugins/wu-ai-router/context.js'

const HOME = mkdtempSync(join(tmpdir(), 'wu-context-'))

function analysis(text, requirements) {
  return {
    text,
    primary: 'coding',
    complexity: 'complex',
    needsImage: false,
    requirements,
  }
}

test('updateFromAnalysis 提炼约束；goal 签名变化时重置状态', () => {
  const st = createTaskState('session-abc12345', HOME)
  updateFromAnalysis(st, analysis('帮我做一个贪吃蛇游戏', [
    { capability: 'coding', importance: 0.9 },
    { capability: 'writing', importance: 0.4 },
  ]))
  assert.equal(st.goal, '帮我做一个贪吃蛇游戏')
  assert.deepEqual(st.constraints, ['coding(重要性 0.90)'])

  // 同一任务（签名相同）：追加不重复
  updateFromAnalysis(st, analysis('帮我做一个贪吃蛇游戏', [
    { capability: 'coding', importance: 0.9 },
    { capability: 'vision', importance: 0.8 },
  ]))
  assert.equal(st.constraints.length, 2)

  // 任务变了：重置（artifacts 保留）
  st.artifacts.push({ artifactId: 'x', type: 't' })
  updateFromAnalysis(st, analysis('写一首关于秋天的诗', [{ capability: 'writing', importance: 0.8 }]))
  assert.equal(st.goal, '写一首关于秋天的诗')
  assert.deepEqual(st.constraints, ['writing(重要性 0.80)'])
  assert.equal(st.artifacts.length, 1)
})

test('buildSubtaskContext：约束不裁、预算兜底、来源计数', () => {
  const st = createTaskState('session-abc12345', HOME)
  updateFromAnalysis(st, analysis('生成机械结构的 SolidWorks VBA，保留指定电机型号', [
    { capability: 'coding', importance: 0.9 },
  ]))
  st.confirmedFacts.push('轴承规格 6204 已确认')
  for (let i = 0; i < 3; i++) {
    st.artifacts.push({ artifactId: `art${i}`, type: 'subtask:research', summary: `上游结论 ${i}` })
  }
  const out = buildSubtaskContext(st, { capability: 'coding', importance: 0.9 })
  assert.ok(out.prompt.includes('【硬性约束】'))
  assert.ok(out.prompt.includes('6204 已确认')) // 约束事实永不裁剪
  assert.ok(out.prompt.includes('上游结论 2')) // 产物摘要（非全文）
  assert.ok(!out.prompt.includes('【前序结果】')) // 旧拼接格式已移除
  assert.equal(out.sourceCount, 4)
  assert.ok(estimateTokens(out.prompt) * 3 <= SUBTASK_BUDGET_CHARS + 600, '预算兜底生效')
})

test('addArtifact：全文落盘 store，state 只留摘要引用；readArtifact 可取回', () => {
  const st = createTaskState('session-store12', HOME)
  const art = addArtifact(st, {
    type: 'subtask:coding',
    summary: 'VBA 主流程摘要',
    text: 'Sub Main()\n  ...\nEnd Sub\n'.repeat(50),
    source: 'glm',
  })
  assert.equal(art.artifactId, 'task_session-store12_art1')
  assert.equal(st.artifacts.length, 1)
  const file = join(HOME, 'wu-ai-context', `${art.artifactId}.json`)
  assert.ok(existsSync(file))
  const back = readArtifact(st, art.artifactId)
  assert.equal(back.type, 'subtask:coding')
  assert.ok(back.text.includes('Sub Main()'))
})

test('updateFromVerify：gaps 去重入 openQuestions，pass 入 completedSteps', () => {
  const st = createTaskState('session-verify1', HOME)
  updateFromVerify(st, { pass: false, gaps: '缺少错误处理；缺少错误处理\n未保存文件' })
  assert.deepEqual(st.openQuestions, ['缺少错误处理', '未保存文件'])
  updateFromVerify(st, { pass: true, score: 0.9 })
  assert.equal(st.completedSteps.length, 1)
})

test('buildVerifyContext：带约束与未解决问题，不带上游全文', () => {
  const st = createTaskState('session-vctx12', HOME)
  updateFromAnalysis(st, analysis('修复游戏 bug', [{ capability: 'coding', importance: 0.85 }]))
  st.openQuestions.push('撞墙判定仍不生效')
  const ctxText = buildVerifyContext(st, '已修复的回答', '修复游戏 bug')
  assert.ok(ctxText.includes('【规格约束】'))
  assert.ok(ctxText.includes('撞墙判定仍不生效'))
  assert.ok(ctxText.includes('【任务】修复游戏 bug'))
})
