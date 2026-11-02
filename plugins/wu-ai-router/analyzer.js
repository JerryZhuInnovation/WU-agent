/**
 * WU ai Task Analyzer — 任务 → 能力需求（V0.2）
 * 先用规则；后续可换成小模型 Structured Output。
 */

/** @typedef {{ capability: string, importance: number }} CapabilityNeed */
/** @typedef {{
 *   primary: string,
 *   requirements: CapabilityNeed[],
 *   complexity: 'simple'|'medium'|'complex',
 *   needsImage: boolean,
 *   text: string,
 * }} TaskAnalysis */

const PATTERNS = {
  vision: /(图片|图像|视觉|看图|截图|照片|识别图|ocr|vision|image|picture|screenshot)/i,
  coding: /(代码|编程|写个函数|实现|重构|debug|调试|报错|typescript|javascript|python|java\b|golang|rust|sql|正则|code|coding|refactor|bug|compile|编译|脚本|npm|git\b|vba|solidworks)/i,
  reasoning: /(推理|证明|数学|方程|算法|逻辑|定理|推导|为什么|原理|深入分析|reasoning|proof|theorem|derive|博弈|最优解|结构|传动|力学)/i,
  research: /(调研|综述|论文|文献|对比.*方案|选型|research|survey|paper|文献综述|市场分析|竞品)/i,
  writing: /(写作|文案|翻译|润色|总结|报告|邮件|writing|translate|summary|essay)/i,
}

/**
 * @param {string} text
 * @param {boolean} hasImage
 * @returns {TaskAnalysis}
 */
export function analyzeTask(text, hasImage = false) {
  const t = (text || '').slice(0, 4000)
  /** @type {CapabilityNeed[]} */
  const reqs = []
  const seen = new Set()

  /** @param {string} cap @param {number} imp */
  const add = (cap, imp) => {
    if (seen.has(cap)) return
    seen.add(cap)
    reqs.push({ capability: cap, importance: imp })
  }

  if (hasImage || PATTERNS.vision.test(t)) add('vision', hasImage ? 1.0 : 0.85)
  if (PATTERNS.coding.test(t)) add('coding', 0.9)
  if (PATTERNS.reasoning.test(t)) add('reasoning', 0.85)
  if (PATTERNS.research.test(t)) add('research', 0.8)
  if (PATTERNS.writing.test(t)) add('writing', 0.75)
  if (reqs.length === 0) add('general', 0.6)

  // 带图时 vision 必须优先
  if (hasImage) {
    reqs.sort((a, b) => (a.capability === 'vision' ? -1 : b.capability === 'vision' ? 1 : b.importance - a.importance))
  } else {
    reqs.sort((a, b) => b.importance - a.importance)
  }

  const primary = reqs[0].capability
  const complexity = estimateComplexity(t, reqs)

  return {
    primary,
    requirements: reqs,
    complexity,
    // needsImage 只表示「消息里真的带了图」。文字里提到图片/OCR 只是「需要视觉能力」的
    // 软信号（已表达为上面的 requirements 权重），若也算 needsImage，会让下游
    // requireVision 硬过滤掉所有非视觉模型——「用 Python 压缩图片」会被误判成看图任务。
    needsImage: hasImage,
    text: t,
  }
}

/**
 * @param {string} text
 * @param {CapabilityNeed[]} reqs
 * @returns {'simple'|'medium'|'complex'}
 */
function estimateComplexity(text, reqs) {
  let score = 0
  if (text.length > 400) score += 1
  if (text.length > 1200) score += 1
  if (reqs.length >= 2) score += 1
  if (reqs.length >= 3) score += 1
  if (/(然后|接着|并且|同时|以及|step|phase|阶段|再)/i.test(text)) score += 1
  if (score <= 1) return 'simple'
  if (score <= 3) return 'medium'
  return 'complex'
}

/**
 * 从消息内容提取文本与是否有图。
 * @param {unknown} messages
 * @returns {{ text: string, hasImage: boolean }}
 */
export function extractContent(messages) {
  if (!Array.isArray(messages)) return { text: '', hasImage: false }
  const parts = []
  let hasImage = false
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const content = m.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'image') hasImage = true
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
    }
  }
  return { text: parts.join('\n').slice(0, 4000), hasImage }
}
