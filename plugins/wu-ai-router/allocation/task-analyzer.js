/**
 * Task Analyzer（分配层）— 从既有 TaskAnalysis 提炼结构化 TaskSpec（证据 A）。
 *
 * 《可验证的任务分配决策机制》证据 A：任务本身的客观要求 —— 类型、复杂度、
 * 模态、是否需要沙箱执行 / 文件写入、风险等级。这些约束供评估器做
 * 「程序化硬约束过滤」，不依赖任何模型的主观判断。
 *
 * 不新增 LLM 调用：复杂度/能力在 analyzer.js（规则）+ brain.js（结构化）里
 * 已经产出，这里只做映射与风险升级，保持分配决策的额外开销可控。
 */

/** 能力 → 所需输入模态。vision 能力必须能看图，其余默认纯文本。 */
function modalitiesFor(capability, analysis) {
  const mods = ['text']
  if (capability === 'vision' || analysis?.needsImage) mods.push('image')
  return mods
}

/** 高风险措辞：涉及不可逆/外放动作的任务不得静默自动执行。 */
const HIGH_RISK = /(删除|格式化|部署上线|生产环境|支付|转账|发送邮件|对外发布|git push|--force)/i

/**
 * @param {import('../analyzer.js').TaskAnalysis} analysis
 * @param {{ registry?: import('../registry.js').RegistryModel[] }} [opts]
 * @returns {{
 *   taskType: string,
 *   complexity: 'simple'|'medium'|'complex',
 *   requiredModalities: string[],
 *   requiresSandboxExec: boolean,
 *   requiresFileWrite: boolean,
 *   riskLevel: 'low'|'medium'|'high',
 *   strongCapabilities: string[],
 *   estimatedInputTokens: number,
 * }}
 */
export function buildTaskSpec(analysis, opts = {}) {
  const strong = (analysis?.requirements || []).filter((r) => r.importance >= 0.75).map((r) => r.capability)
  const text = String(analysis?.text || '')
  const isCoding = strong.includes('coding')
  const multiStage = /(然后|接着|再|并且|同时|最后|阶段|step)/i.test(text)

  let riskLevel = 'low'
  if (analysis?.complexity === 'complex') riskLevel = 'medium'
  if (strong.length >= 3 || (isCoding && multiStage)) riskLevel = 'medium'
  if (HIGH_RISK.test(text)) riskLevel = 'high'

  return {
    taskType: analysis?.primary || 'general',
    complexity: analysis?.complexity || 'simple',
    requiredModalities: modalitiesFor(analysis?.primary, analysis),
    requiresSandboxExec: isCoding || /运行|执行|跑一下|验证|测试/i.test(text.slice(0, 600)),
    requiresFileWrite: isCoding,
    riskLevel,
    strongCapabilities: strong,
    estimatedInputTokens: Math.ceil(text.length * 0.6) + 800,
  }
}

/**
 * 证据 A 的可执行性检查素材：当前运行环境是否真的支持沙箱与受控写入。
 * 由调用方（index.js）从 DSH 侧事实注入，评估器不自行猜测。
 */
export function runtimeFacts(registry, opts = {}) {
  const sandboxOk = opts.sandboxEnforced !== false // 控制中心 sandbox_status 结论
  const writeOk = sandboxOk // workspace-write 下受控写可用；禁沙箱时写授权一并视为不可信
  return { sandboxAvailable: sandboxOk, authorizedFileWrite: writeOk }
}

/** 家族推断：盲态规划要求规划者来自不同模型家族，降低同源相关性偏差。 */
export function modelFamily(model) {
  const s = `${model?.provider || ''} ${model?.model || ''} ${model?.key || ''}`.toLowerCase()
  if (/deepseek/.test(s)) return 'deepseek'
  if (/zhipu|glm/.test(s)) return 'zhipu'
  if (/xiaomi|mimo/.test(s)) return 'xiaomi'
  if (/qwen|alibaba|tongyi/.test(s)) return 'qwen'
  if (/openai|gpt|o[1-9]\b/.test(s)) return 'openai'
  if (/anthropic|claude/.test(s)) return 'anthropic'
  if (/llama|meta/.test(s)) return 'meta'
  if (/local|llama\.cpp/.test(s)) return 'local'
  return model?.provider || 'unknown'
}

/** 该家族在注册表里的全部启用模型（用于红队/规划者的异构挑选）。 */
export function modelsOfOtherFamily(registry, family) {
  return registry.filter((m) => m.enabled !== false && modelFamily(m) !== family)
}
