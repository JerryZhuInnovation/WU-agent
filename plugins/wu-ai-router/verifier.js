/**
 * WU ai Verifier — 独立质检
 * Executor ≠ Verifier：用另一模型打分；FAIL 则注入修复提示（有限次）。
 * 流式收集与超时统一走 multi.js 的 runOne，本模块只负责拼 prompt 与解析结论。
 */

import { runOne } from './multi.js'
import { SYSTEMS } from './prompts.js'

/**
 * @typedef {{ score: number, pass: boolean, gaps: string, raw: string, usage: unknown }} VerifyResult
 */

/** 质检调用超时：provider 挂起时不得卡死 session/event（否则质检锁永不释放）。 */
const VERIFY_TIMEOUT_MS = 30_000

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   provider: string,
 *   model: string,
 *   taskText: string,
 *   answerText: string,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<VerifyResult>}
 */
export async function verifyAnswer(ctx, input) {
  const prompt = [
    SYSTEMS.verifier,
    '格式：{"score":0到1的数字,"pass":true或false,"gaps":"问题列表，可为空"}',
    '',
    `【任务】${input.taskText.slice(0, 1500)}`,
    '',
    `【待检回答】${input.answerText.slice(0, 3000)}`,
    '',
    '评分标准：是否完成任务、是否有明显错误、是否使用简体中文（若任务未要求其它语言）。',
    'score>=0.75 且无严重错误则 pass=true。',
  ].join('\n')

  /** @type {unknown} */
  let usage = null
  let raw = ''
  try {
    raw = await runOne(
      ctx,
      {
        provider: input.provider,
        model: input.model,
        prompt,
        maxTokens: 200,
        timeoutMs: VERIFY_TIMEOUT_MS,
        signal: input.signal,
      },
      (u) => {
        usage = u
      },
    )
  } catch {
    // 超时/网络失败：给中性结果（与 unparsed 同策略），绝不抛出卡住质检锁
    return { score: 0.5, pass: true, gaps: 'verify-error', raw: '', usage }
  }

  const parsed = parseVerifyJson(raw)
  if (!parsed) {
    return { score: 0.5, pass: true, gaps: 'unparsed', raw: raw.slice(0, 200), usage }
  }
  return { ...parsed, usage }
}

/** @param {string} raw */
function parseVerifyJson(raw) {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    const score = Number(o.score)
    if (!Number.isFinite(score)) return null
    return {
      score: Math.min(1, Math.max(0, score)),
      // 尊重质检员的显式否决（严重错误），且必须过分数线才算通过
      pass: o.pass !== false && score >= 0.75,
      gaps: String(o.gaps || ''),
      raw,
    }
  } catch {
    return null
  }
}

/**
 * @param {string} answer
 * @returns {string}
 */
/** 抽取助手可见文本（协议归一化，2026-11-01）。
 *
 * 背景：不同厂商把答案放在不同位置 —— DeepSeek 原生走 `reasoning_content` 字段，
 * 部分开源/国产模型把思维链内嵌在正文 `<think>…</think>` 里，还有把思考块单独
 * 作为一条 `reasoning` content block 下发的。质检层若只认 `type==='text'`，
 * 这些模型的回答会被判成「空答案」→ 记一次失败 → 表现账本里被永久扣分
 * （框架耦合导致的失败被错记成模型能力缺陷，这正是「非 DeepSeek 模型越用越差」的成因）。
 * 这里统一成可见正文：正文优先；无正文时退回思维链文本（至少能让核验看到内容）。 */
export function extractAssistantText(answer) {
  if (typeof answer === 'string') return stripThink(answer).text
  if (Array.isArray(answer)) {
    const text = answer
      .filter((b) => b && (b.type === 'text' || b.type === 'output_text') && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    if (text.trim()) return stripThink(text).text
    // 只有思考块：退回其内容，别把「只有推理、没写正文」当成空答案
    return answer
      .filter((b) => b && (b.type === 'reasoning' || b.type === 'thinking' || b.type === 'reasoning_content'))
      .map((b) => String(b.text || b.reasoning || b.thinking || ''))
      .join('\n')
      .trim()
  }
  if (answer && typeof answer === 'object') {
    const content = answer.content ?? answer.text
    if (typeof content === 'string' && content.trim()) return stripThink(content).text
    if (Array.isArray(content)) return extractAssistantText(content)
    const reasoning = answer.reasoning_content ?? answer.reasoning
    if (typeof reasoning === 'string') return reasoning.trim()
  }
  return ''
}

/** 剥掉正文里的 <think>…</think>：思维链不是答案，但正文为空时保留其内容。 */
function stripThink(raw) {
  const s = String(raw || '')
  const m = s.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i)
  if (!m) return { text: s, reasoning: '' }
  const body = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()
  return { text: body || m[1].trim(), reasoning: m[1].trim() }
}
