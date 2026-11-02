import { analyzeTask } from './analyzer.js'

const cases = [
  ['帮我写一个 Python 函数解析 JSON', 'coding'],
  ['这段 TypeScript 报错了，帮我 debug', 'coding'],
  ['看一下这张图片里有什么', 'vision'],
  ['请证明这个数学定理', 'reasoning'],
  ['帮我调研一下 LangGraph 和 PydanticAI', 'research'],
  ['今天天气怎么样', 'general'],
  ['', 'general'],
]

let failed = 0
for (const [text, expected] of cases) {
  const got = analyzeTask(text).primary
  if (got !== expected) {
    console.error(`FAIL: ${JSON.stringify(text)} => ${got}, expected ${expected}`)
    failed++
  } else {
    console.log(`ok: ${JSON.stringify(text)} => ${got}`)
  }
}
if (failed) {
  process.exit(1)
}
console.log('all passed')
