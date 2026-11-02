/**
 * 动态路由闭环回归：perf 聚合 → actual 回写 → rankByIntel 融合
 * 用法：node test-dynamic.mjs（用临时 DSH_HOME，不碰真实档案）
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'wuai-dyn-'))
process.env.DSH_HOME = tmpHome

const { logPerf, summarize, readPerf } = await import('./perf.js')
const { syncActualFromPerf, effectiveScore, loadIntel, upsertCapabilities } = await import('./intel.js')
const { rankByIntel } = await import('./brain.js')

let failed = 0
const check = (cond, msg) => {
  if (cond) console.log(`ok  ${msg}`)
  else {
    console.error(`FAIL ${msg}`)
    failed++
  }
}

// 1) 造样本：alpha/coding 2 成 1 败 + 1 条 route（应被忽略）+ beta 1 成（单样本，低置信）
logPerf({ kind: 'execute', model: 'alpha', capability: 'coding', success: true, latencyMs: 1000 })
logPerf({ kind: 'execute', model: 'alpha', capability: 'coding', success: true, latencyMs: 1200 })
logPerf({ kind: 'execute', model: 'alpha', capability: 'coding', success: false, latencyMs: 2000 })
logPerf({ kind: 'route', model: 'alpha', capability: 'coding' })
logPerf({ kind: 'execute', model: 'beta', capability: 'coding', success: true, latencyMs: 500 })

const rows = summarize(readPerf(100))
check(rows.length === 2, `summarize 行数=2（route 不计入），实得 ${rows.length}`)
const a = rows.find((r) => r.model === 'alpha')
check(a && a.n === 3 && a.ok === 2, `alpha n=3 ok=2，实得 n=${a?.n} ok=${a?.ok}`)
check(a && Math.abs(a.successRate - 2 / 3) < 1e-9, `alpha 成功率=2/3，实得 ${a?.successRate}`)

// 2) actual 回写 + 节流
const changed1 = syncActualFromPerf(rows)
check(changed1 === true, 'syncActualFromPerf 首次有更新')
const eff = effectiveScore('alpha', 'coding')
check(eff && eff.layer === 'actual' && Math.abs(eff.score - 0.83) < 0.011, `actual 层分数≈0.83，实得 ${eff?.layer}/${eff?.score}`)
check(eff && Math.abs(eff.weight - 1.0) < 1e-9, 'actual 权重=1.0')
const db = loadIntel()
check(db.models.beta?.actual?.meta?.lowConfidence === true, '单样本(n=1)的 beta 回写 actual 且标低置信')
const changed2 = syncActualFromPerf(rows)
check(changed2 === false, '分数未变化时不落盘（节流）')

// 3) rankByIntel：actual+rel 融合 / research 层级权重
const rel = new Map([['alpha|coding', 0.833]])
/** @type {any[]} */
const registry = [
  { key: 'alpha', provider: 'p', model: 'alpha', label: 'alpha', enabled: true, capabilities: { coding: 0.2 } },
  { key: 'gamma', provider: 'p', model: 'gamma', label: 'gamma', enabled: true, capabilities: { coding: 0.9 } },
]
upsertCapabilities('gamma', 'research', { coding: 1.0 })
const ranked = rankByIntel(registry, 'coding', { reliability: rel })
check(ranked.length === 2, `rankByIntel 输出 2 行，实得 ${ranked.length}`)
check(ranked[0].model.key === 'gamma', `research(1.0×0.85=0.85) 应压过 actual+rel(0.83×0.833≈0.69) 排第一，实得 ${ranked[0]?.model.key}`)
const alphaRow = ranked.find((r) => r.model.key === 'alpha')
check(alphaRow && alphaRow.source === 'actual+rel', `alpha source=actual+rel，实得 ${alphaRow?.source}`)
check(alphaRow && Math.abs(alphaRow.score - 0.83 * 0.833) < 1e-9, `alpha 融合分正确（直乘信誉因子）`)

// 无可靠性时 actual 压过 research
const ranked2 = rankByIntel(registry, 'coding')
check(ranked2[0].model.key === 'gamma', '无 rel 时 research 仍优先')
check(ranked2.find((r) => r.model.key === 'alpha').source === 'actual', '无 rel 时 source=actual')

rmSync(tmpHome, { recursive: true, force: true })
if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('all passed')