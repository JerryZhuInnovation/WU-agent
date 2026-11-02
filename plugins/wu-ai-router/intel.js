/**
 * Model Intelligence — 三层能力档案
 * declared(官方/用户) + research(联网) + actual(perf 回写)
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

function home() {
  return process.env.DSH_HOME || join(process.env.HOME || '', '.wu-ai', 'dsh')
}

function dbPath() {
  return join(home(), 'model-intelligence.json')
}

function logLine(msg) {
  try {
    const f = join(home(), 'wu-ai-router.log')
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, `[${new Date().toISOString()}] [intel] ${msg}\n`)
  } catch { /* ignore */ }
}

/** @returns {Record<string, any>} */
export function loadIntel() {
  let db = null
  try {
    if (existsSync(dbPath())) db = JSON.parse(readFileSync(dbPath(), 'utf8'))
  } catch { /* ignore */ }
  // 结构兜底：畸形/半截档案文件不得让下游 db.models[x] 直接 TypeError
  if (!db || typeof db !== 'object' || !db.models || typeof db.models !== 'object') {
    return { models: {}, updated: null }
  }
  return db
}

export function saveIntel(db) {
  try {
    db.updated = new Date().toISOString()
    const file = dbPath()
    mkdirSync(dirname(file), { recursive: true })
    // 原子替换：直接覆写若中途崩溃会留下半截 JSON，loadIntel 的结构兜底只能整份丢弃档案
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    logLine(`save intel failed ${String(e)}`)
  }
}

/**
 * 合并一层能力分
 * @param {string} modelKey
 * @param {'declared'|'research'|'actual'} layer
 * @param {Record<string, number>} scores
 * @param {any} [meta]
 */
export function upsertCapabilities(modelKey, layer, scores, meta = {}) {
  const db = loadIntel()
  const m = db.models[modelKey] || { key: modelKey }
  m[layer] = {
    ...(m[layer] || {}),
    scores: { ...(m[layer]?.scores || {}), ...scores },
    meta: { ...(m[layer]?.meta || {}), ...meta },
    at: new Date().toISOString(),
  }
  db.models[modelKey] = m
  saveIntel(db)
  return m
}

/**
 * 最终路由用分：actual 优先，其次 research，再次 declared；带置信度衰减。
 * 单样本（lowConfidence）的 actual 降为 0.85（与 research 同级、高于 declared）：
 * 冷启动的一次实测不足以压过调研档案，但足以纠正明显错误的声明分。
 * @param {string} modelKey
 * @param {string} capability
 */
export function effectiveScore(modelKey, capability) {
  const db = loadIntel()
  const m = db.models[modelKey]
  if (!m) return null
  const layers = [
    { name: 'actual', weight: m.actual?.meta?.lowConfidence ? 0.85 : 1.0 },
    { name: 'research', weight: 0.85 },
    { name: 'declared', weight: 0.7 },
  ]
  for (const L of layers) {
    const s = m[L.name]?.scores?.[capability]
    if (typeof s === 'number' && s > 0) {
      return { score: s, layer: L.name, weight: L.weight }
    }
  }
  return null
}

/**
 * 动态路由闭环：把 perf.jsonl 的执行聚合回写进三层档案的 actual 层。
 * actual 分数 = 0.5 + 0.5×成功率（与 loadReliability 同一映射，0.5~1.0），
 * 语义是「事实上这模型干这类活有多可靠」。样本数 n≥1 即写（冷启动也让 smart 路由
 * 吃到实测），n<2 标记 lowConfidence —— effectiveScore 据此降权（0.85），而非丢弃。
 * 分数与样本数都无变化才跳过落盘（节流：每次请求都会走这条路，避免无谓写文件）。
 * @param {Array<{model:string, capability:string, n:number, successRate:number, avgLatencyMs:number}>} rows
 * @returns {boolean} 是否有档案被更新
 */
export function syncActualFromPerf(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false
  const db = loadIntel()
  let changed = false
  for (const r of rows) {
    if (!r.model || !r.capability) continue
    const n = Number(r.n) || 0
    if (n < 1) continue
    const score = Math.min(1, Math.max(0.5, 0.5 + Number(r.successRate || 0) * 0.5))
    const rounded = Math.round(score * 100) / 100
    const m = db.models[r.model] || (db.models[r.model] = { key: r.model })
    const cur = m.actual?.scores?.[r.capability]
    // 分数与样本数都无变化才跳过：n 增长要更新 meta（lowConfidence 随 n≥2 解除）
    if (typeof cur === 'number' && Math.abs(cur - rounded) < 0.02 && m.actual?.meta?.n === n) continue
    m.actual = {
      ...(m.actual || {}),
      scores: { ...(m.actual?.scores || {}), [r.capability]: rounded },
      meta: {
        ...(m.actual?.meta || {}),
        n,
        lowConfidence: n < 2,
        successRate: Math.round(Number(r.successRate || 0) * 100) / 100,
        avgLatencyMs: r.avgLatencyMs,
      },
      at: new Date().toISOString(),
    }
    changed = true
  }
  if (changed) {
    saveIntel(db)
    logLine(`actual sync ${rows.length} rows -> updated`)
  }
  return changed
}

/**
 * 简单 HTTP GET（Router Brain 工具：不直接给 LLM 联网，由 Runtime 执行）
 * @param {string} url
 * @param {number} timeoutMs
 */
export async function httpGet(url, timeoutMs = 12000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text: text.slice(0, 20000) }
  } finally {
    clearTimeout(t)
  }
}

/**
 * 生成研究用搜索 URL（Bing HTML / DuckDuckGo，可换）
 * @param {string} query
 */
export function searchUrls(query) {
  const q = encodeURIComponent(query)
  return [
    `https://html.duckduckgo.com/html/?q=${q}`,
    `https://www.bing.com/search?q=${q}`,
  ]
}

/**
 * 从 HTML 里抠出可见文本片段（粗糙，够 Router 读）
 * @param {string} html
 */
export function htmlToSnippets(html, limit = 12) {
  const stripped = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  const parts = stripped
    .split(/(?<=[.。!！?？])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 400)
  return parts.slice(0, limit)
}
