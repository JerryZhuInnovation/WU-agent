/** Task Analyzer 单元测试（规则分类：任务 → 能力需求）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeTask, extractContent } from '../../plugins/wu-ai-router/analyzer.js'

test('「帮我写Python」→ primary coding', () => {
  const a = analyzeTask('帮我写一个 Python 脚本处理数据')
  assert.equal(a.primary, 'coding')
  assert.ok(a.requirements.some((r) => r.capability === 'coding'))
})

test('带图消息 → vision 优先', () => {
  const a = analyzeTask('这个截图里的报错是什么原因？', true)
  assert.equal(a.primary, 'vision')
  assert.equal(a.needsImage, true)
})

test('只提到图片但没真带图 → 不算 needsImage，视觉只作软需求', () => {
  const a = analyzeTask('用 Python 压缩图片并批量重命名')
  assert.equal(a.needsImage, false)
  assert.equal(a.primary, 'coding')
  assert.ok(a.requirements.some((r) => r.capability === 'vision'))
})

test('数学推理 → reasoning', () => {
  const a = analyzeTask('证明这个定理并推导最优解')
  assert.equal(a.primary, 'reasoning')
})

test('调研任务 → research', () => {
  const a = analyzeTask('帮我调研一下竞品并做文献综述')
  assert.equal(a.primary, 'research')
})

test('翻译任务 → writing', () => {
  const a = analyzeTask('把这段话翻译成英文并润色')
  assert.equal(a.primary, 'writing')
})

test('空/闲聊 → general', () => {
  const a = analyzeTask('你好呀')
  assert.equal(a.primary, 'general')
})

test('多能力任务 requirements 有序且去重', () => {
  const a = analyzeTask('写代码报错了，帮我 debug 并且解释原理')
  assert.equal(a.primary, 'coding')
  const caps = a.requirements.map((r) => r.capability)
  assert.ok(caps.includes('reasoning'))
  assert.equal(new Set(caps).size, caps.length)
})

test('extractContent 提取文本与图片标记', () => {
  const r = extractContent([
    { content: '你好' },
    { content: [{ type: 'text', text: '第一段' }, { type: 'image', image: {} }] },
  ])
  assert.equal(r.hasImage, true)
  assert.ok(r.text.includes('你好'))
  assert.ok(r.text.includes('第一段'))
})