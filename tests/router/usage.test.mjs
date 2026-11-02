/**
 * 用量埋点的取值逻辑：路由器的「本轮用量」全靠它拿到数字。
 *
 * 实测 DSH 0.2.0：`assistant/message` 事件的 `usage` 字段常为空，用量挂在
 * `stream` 里最后一条 `{type:'usage'}` 记录上。只读 `event.usage` 的结果是
 * 一条执行用量都记不到 —— 界面上只剩分析模型，且完全不报错（静默缺失）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { eventUsage } from '../../plugins/wu-ai-router/index.js'

const USAGE = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 }

test('直接挂在事件上的 usage 优先', () => {
  assert.deepEqual(eventUsage({ usage: USAGE }), USAGE)
})

test('事件上没有 usage 时，从 stream 末尾取', () => {
  const event = {
    type: 'assistant/message',
    stream: [
      { type: 'text-delta', text: 'hi' },
      { type: 'usage', usage: USAGE },
    ],
  }
  assert.deepEqual(eventUsage(event), USAGE)
})

test('多次 usage 取最后一条（这才是本轮结算值）', () => {
  const last = { inputTokens: 9, outputTokens: 1, totalTokens: 10 }
  const event = { stream: [{ type: 'usage', usage: USAGE }, { type: 'usage', usage: last }] }
  assert.deepEqual(eventUsage(event), last)
})

test('兼容包在 chunk 里的形状', () => {
  const event = { stream: [{ chunk: { type: 'usage', usage: USAGE } }] }
  assert.deepEqual(eventUsage(event), USAGE)
})

test('拿不到就返回 null，绝不编一个 0 出来', () => {
  assert.equal(eventUsage(undefined), null)
  assert.equal(eventUsage({}), null)
  assert.equal(eventUsage({ stream: [] }), null)
  assert.equal(eventUsage({ stream: [{ type: 'text-delta', text: 'x' }] }), null)
  // 形状不对（usage 不是对象）也要当作没有
  assert.equal(eventUsage({ usage: null, stream: [{ type: 'usage' }] }), null)
})
