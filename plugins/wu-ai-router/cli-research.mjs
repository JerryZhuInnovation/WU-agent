#!/usr/bin/env node
/**
 * CLI：用已配置的 Router Brain 研究一个模型的能力，写入 model-intelligence.json
 * 不下载模型权重；只做「联网摘录 + 结构化归纳」。
 *
 * 用法（由控制中心 spawn）：
 * node cli-research.mjs --brain-provider x --brain-model y --model-key glm --model-id glm-4.6v --hint 写代码
 */

import { researchModelProfile } from './brain.js'
import { loadIntel } from './intel.js'

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

/** 最小 stub ctx：只提供 llm.stream（OpenAI 兼容 / 本地 llama-server） */
function makeCtx() {
  // 通过环境变量里 DSH 的 key + 从 settings 读 baseURL 较复杂；
  // 这里要求控制中心注入 WUA_BRAIN_BASE_URL / WUA_BRAIN_KEY
  const baseURL = process.env.WUA_BRAIN_BASE_URL || ''
  const apiKey = process.env.WUA_BRAIN_KEY || process.env.OPENAI_API_KEY || ''
  return {
    llm: {
      async *stream(opts) {
        const url = (baseURL || 'http://127.0.0.1:8080/v1').replace(/\/$/, '') + '/chat/completions'
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: opts.model,
            messages: (opts.messages || []).map((m) => ({
              role: m.role,
              content: Array.isArray(m.content)
                ? m.content.map((c) => c.text || '').join('')
                : m.content,
            })),
            max_tokens: opts.maxTokens || 200,
            stream: true,
          }),
          signal: opts.signal,
        })
        if (!res.ok) {
          const t = await res.text()
          throw new Error(`brain http ${res.status}: ${t.slice(0, 200)}`)
        }
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          for (const line of lines) {
            const s = line.replace(/^data:\s*/, '').trim()
            if (!s || s === '[DONE]') continue
            try {
              const j = JSON.parse(s)
              const delta = j.choices?.[0]?.delta?.content
              if (delta) yield { type: 'text-delta', text: delta }
            } catch { /* ignore */ }
          }
        }
      },
    },
  }
}

const provider = arg('brain-provider')
const model = arg('brain-model')
const modelKey = arg('model-key')
const modelId = arg('model-id', modelKey)
const hint = arg('hint', '')

const ctx = makeCtx()
console.error(`[research] brain=${provider}/${model} target=${modelKey} (${modelId})`)

const scores = await researchModelProfile(ctx, {
  provider,
  model,
  modelKey,
  modelId,
  capabilitiesHint: hint,
})

const intel = loadIntel()
console.log(JSON.stringify({ ok: true, modelKey, scores, intel: intel.models[modelKey] || null }, null, 2))
