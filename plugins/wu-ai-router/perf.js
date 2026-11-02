/**
 * WU ai Performance Log — V0.6 埋点（贯穿 Analyzer/Router/执行）
 * JSONL：$DSH_HOME/perf.jsonl
 */

import { appendFileSync, mkdirSync, existsSync, openSync, readSync, fstatSync, closeSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 单文件上限：超过即轮转（perf.jsonl → perf.jsonl.1），避免埋点随时间无限增长。
 *  读取只取尾部 MAX_TAIL_BYTES 字节——聚合窗口只有几百行，没必要全量载入。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TAIL_BYTES = 2 * 1024 * 1024

function home() {
  return process.env.DSH_HOME || join(process.env.HOME || '', '.wu-ai', 'dsh')
}

function perfPath() {
  return join(home(), 'perf.jsonl')
}

/** 到上限就把当前文件改名成 .1（覆盖上一份备份，只留一个）。 */
function rotateIfNeeded(file) {
  try {
    if (existsSync(file) && statSync(file).size >= MAX_FILE_BYTES) {
      renameSync(file, `${file}.1`)
    }
  } catch {
    /* 轮转失败不影响本次写入 */
  }
}

/**
 * 从文件尾部读最多 maxBytes 字节，返回完整行数组。
 * @param {string} file
 * @param {number} maxBytes
 * @returns {string[]}
 */
function tailLines(file, maxBytes) {
  if (!existsSync(file)) return []
  let fd = null
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size <= 0) return []
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.allocUnsafe(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    // 从中间截断时首行是半行，丢弃（少了它 200 行窗口也不会变短）
    if (start > 0 && lines.length) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} entry
 */
export function logPerf(entry) {
  try {
    const file = perfPath()
    mkdirSync(dirname(file), { recursive: true })
    rotateIfNeeded(file)
    const row = {
      ts: new Date().toISOString(),
      ...entry,
    }
    appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

/** @returns {Record<string, unknown>[]} */
export function readPerf(limit = 200) {
  const file = perfPath()
  // 轮转后的上一份一起读：新文件刚建时样本太少，会把可靠性窗口打成空窗
  const lines = [...tailLines(`${file}.1`, MAX_TAIL_BYTES), ...tailLines(file, MAX_TAIL_BYTES)]
  const out = []
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip */
    }
  }
  return out
}

/**
 * 简单聚合：按 model+capability 统计成功率与平均延迟。
 * 只统计 kind==='execute' 的终局行（route 只是选择动作，不算成败；
 * 质检失败补记 success:false，质检没跑时由 agent/status idle 兜底补记
 * verified:false 的行 —— 保证「路由过就有终局样本」，成功率不留盲区）。
 * @param {Record<string, unknown>[]} rows
 */
export function summarize(rows) {
  /** @type {Map<string, { model: string, capability: string, n: number, ok: number, latency: number }>} */
  const map = new Map()
  for (const r of rows) {
    if (r.kind !== 'execute') continue
    // 协议摩擦（框架格式不合导致的失败）不是模型能力问题：不计入成功率，
    // 否则非原生模型会被「越用越差 → 越差越不用」的死锁慢慢淘汰
    if (r.protocolFriction === true) continue
    const model = String(r.model || '')
    const capability = String(r.capability || '')
    if (!model || !capability) continue
    const key = `${model}|${capability}`
    let row = map.get(key)
    if (!row) {
      row = { model, capability, n: 0, ok: 0, latency: 0 }
      map.set(key, row)
    }
    row.n += 1
    if (r.success !== false) row.ok += 1
    row.latency += Number(r.latencyMs || 0)
  }
  return [...map.values()].map((r) => ({
    ...r,
    successRate: r.n ? r.ok / r.n : 0,
    avgLatencyMs: r.n ? Math.round(r.latency / r.n) : 0,
  }))
}
