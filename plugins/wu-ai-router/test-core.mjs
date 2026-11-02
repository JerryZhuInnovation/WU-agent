import { analyzeTask } from './analyzer.js'
import { buildRegistry, rankModels } from './registry.js'

const cases = [
  ['帮我写一个 Python 快排', false, 'coding'],
  ['看一下这张截图里有什么', true, 'vision'],
  ['证明这个定理并推导公式', false, 'reasoning'],
  ['调研 LangGraph 和 PydanticAI 对比', false, 'research'],
  ['把这段话翻译成英文', false, 'writing'],
  ['今天天气怎么样', false, 'general'],
]

let failed = 0
for (const [text, hasImage, expected] of cases) {
  const a = analyzeTask(text, hasImage)
  if (a.primary !== expected) {
    console.error(`FAIL analyze: ${text} => ${a.primary}, expected ${expected}`)
    failed++
  } else {
    console.log(`ok analyze: ${text} => ${a.primary} (${a.complexity})`)
  }
}

const fixture = [
  { key: 'fix-vl', capabilities: { vision: 0.9, coding: 0.4, general: 0.5 }, enabled: true, costScore: 0.8, latencyScore: 0.7 },
  { key: 'fix-code', capabilities: { coding: 0.95, reasoning: 0.8, vision: 0 }, enabled: true, costScore: 0.6, latencyScore: 0.8 },
  { key: 'fix-off', capabilities: { coding: 0.99 }, enabled: false },
]
const reg = buildRegistry({ models: fixture })
const vision = rankModels(reg, 'vision', { requireVision: true })
console.log('vision rank', vision.map((r) => `${r.model.key}:${r.score.toFixed(2)}`).join(','))
if (!vision.length || vision[0].model.key !== 'fix-vl') {
  console.error('FAIL vision should rank fix-vl first')
  failed++
}

const coding = rankModels(reg, 'coding')
console.log('coding rank', coding.map((r) => `${r.model.key}:${r.score.toFixed(2)}`).join(','))
if (!coding.length || coding[0].model.key !== 'fix-code') {
  console.error('FAIL coding should rank fix-code first')
  failed++
}

const emptyReg = buildRegistry()
if (emptyReg.length !== 0) {
  console.error('FAIL default registry should be empty (no built-in presets)')
  failed++
}

if (failed) process.exit(1)
console.log('all passed')
