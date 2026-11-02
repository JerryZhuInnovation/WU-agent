/**
 * WU ai 客户端插件 — 欢迎弹窗与品牌改写
 * 拆分自原 client.ts（2026-10-24 模块化重构）。
 * 硬约束：**只隐藏 + 注入，绝不删除 DSH 的节点**（React 持有这些节点的引用，
 * 删掉会让它在下次渲染时报错或丢引用）。文案改写只动文本节点的 data，
 * 不替换节点，保证 React 的引用仍然有效。
 * 只改「模板固定部分」，不碰用户产生的内容（例如会话标题里的 DeepSeek 字样不动）。
 */

import { BRAND_CLASS, HERO_MARK_CLASS, WELCOME_KEY } from './ids'
import { WU_SEAL_USE } from './assets'
import { hideNode } from './dom'
import { syncTurnUsage } from './dashboard'
import { serverStatus } from './status'

/* ── 欢迎弹窗（原「内测声明」）改写为 WU ai 声明 ────────────────────────── */

// DSH 换版会改这个弹窗的文案（0.1.x「内测声明」→ 0.2.0「预览版说明」），
// 只认一个旧标题会让改写失效、退回官方告示，所以把两版中英文都列为可识别标题。
const WELCOME_ORIGINAL_TITLES = ['内测声明', 'Internal Testing Notice', '预览版说明', 'Preview Notice']
const WELCOME_TITLE = '产品声明'
const WELCOME_PARAGRAPHS = [
  'WU ai 基于 DeepSeek Harness（DSH）改编而来。DSH 目前仍处在面向开发者的快速迭代阶段，核心插件与基础 API 可能随时发生破坏性的结构变化，因此本产品在后续更新中也可能出现不兼容的调整，敬请谅解。',
  '我们同样秉持开源与开放的精神：欢迎你在 WU ai 的基础上自行修改与扩展，组合出属于你自己的 Agent。',
]

/** 找到尚未处理过的欢迎弹窗（按原标题识别，改写后靠标记去重）。 */
function findWelcomeDialog(): HTMLElement | null {
  for (const dialog of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))) {
    if (dialog.dataset.wuaiWelcome) continue
    const heading = dialog.querySelector('h1, h2, h3, [role="heading"]')
    const title = heading ? heading.textContent || '' : ''
    if (WELCOME_ORIGINAL_TITLES.some((t) => title.includes(t))) return dialog
  }
  return null
}

/** 重写弹窗文案并加「不再弹出」；已选过「不再弹出」则替用户直接关掉。 */
export function handleWelcomeDialog(): void {
  const dialog = findWelcomeDialog()
  if (!dialog) return
  const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
  const continueBtn = buttons.find((b) => (b.textContent || '').trim() === '继续')
  // 找到「继续」才标记已处理：按钮晚一个渲染批次出现时还能再次生效
  if (!continueBtn) return
  dialog.dataset.wuaiWelcome = '1'

  let dismissed = false
  try {
    dismissed = localStorage.getItem(WELCOME_KEY) === '1'
  } catch {
    dismissed = false
  }
  if (dismissed) {
    continueBtn.click()
    return
  }

  const heading = dialog.querySelector('h1, h2, h3, [role="heading"]')
  if (heading) heading.textContent = WELCOME_TITLE
  const paragraphs = Array.from(dialog.querySelectorAll('p')).filter((p) => !p.hasAttribute('role'))
  if (paragraphs.length >= 2) {
    paragraphs[0].textContent = WELCOME_PARAGRAPHS[0]
    paragraphs[1].textContent = WELCOME_PARAGRAPHS[1]
    for (const extra of paragraphs.slice(2)) extra.remove()
  }

  // 「不再弹出」：克隆「继续」保持同一设计语言，弱化为描边样式
  const dismissBtn = continueBtn.cloneNode(true) as HTMLButtonElement
  dismissBtn.textContent = '不再弹出'
  dismissBtn.removeAttribute('id')
  dismissBtn.style.background = 'transparent'
  dismissBtn.style.border = '1px solid var(--dsw-alias-border, rgba(255, 255, 255, 0.16))'
  dismissBtn.addEventListener('click', () => {
    try {
      localStorage.setItem(WELCOME_KEY, '1')
    } catch {
      /* 隐私模式等场景忽略 */
    }
    continueBtn.click()
  })
  continueBtn.parentElement?.insertBefore(dismissBtn, continueBtn)
}

/* ── 品牌与内部名改写 ─────────────────────────────────────────────────────── */

/** 输入区「推理强度」触发器文案：DSH 只给英文值，这里换成中文（只映射已知值，不猜）。 */
const EFFORT_LABELS: Record<string, string> = {
  Default: '默认',
  High: '高',
  Medium: '中',
  Low: '低',
}

/** 新会话页抬头那个鲸鱼标：DSH 的 FISH_LOGO_PATH 是硬编码矢量，皮肤层改不到
 *  （同区块的标语文案已由运行时品牌补丁在源头换掉）。这里隐藏原生标 + 注入 WU 印。
 *  鲸鱼的悬停游动动画随之不再出现——纯装饰，不影响任何功能。 */
function rewriteHeroBrand(): void {
  const fish = document.querySelector<HTMLElement>('svg[class*="_fish"]')
  if (!fish) return
  const host = fish.parentElement
  if (!host) return
  hideNode(fish)
  if (!host.querySelector(`:scope > .${HERO_MARK_CLASS}`)) {
    const mark = document.createElement('span')
    mark.className = HERO_MARK_CLASS
    mark.setAttribute('aria-hidden', 'true')
    mark.innerHTML = WU_SEAL_USE
    host.insertBefore(mark, host.firstChild)
  }
}

/** 侧栏顶部品牌：logoRow 内只保留一个 WU 章（原生鲸鱼 SVG 一律隐藏；
 *  「新会话」按钮恢复原样，不再注入章——曾造成两章并排）。
 *  brandMark/brandName 容器（鲸鱼 + deepseek 字标 + HARNESS 徽章的组合）整体隐藏：
 *  宽窗口下 DSH 自己不渲染它们，窄窗口会显示——不能依赖其响应式。
 *  点击章 = 切换侧边栏（收起/展开），还原「点品牌图标折叠侧栏」的原生习惯。 */
function rewriteBrand(): void {
  const logoRow = document.querySelector<HTMLElement>('[class*="_logoRow"]')
  if (!logoRow) return
  for (const s of Array.from(logoRow.querySelectorAll('svg'))) {
    if (!s.classList.contains('wu-seal-svg')) hideNode(s as unknown as HTMLElement)
  }
  for (const el of Array.from(logoRow.querySelectorAll<HTMLElement>('[class*="_brandMark"],[class*="_brandName"]'))) {
    hideNode(el)
  }
  let mark = logoRow.querySelector<HTMLSpanElement>(`:scope > span.${BRAND_CLASS}`)
  if (!mark) {
    mark = document.createElement('span')
    mark.className = BRAND_CLASS
    mark.setAttribute('aria-hidden', 'true')
    mark.title = '收起 / 展开侧边栏'
    mark.innerHTML = WU_SEAL_USE
    mark.addEventListener('click', () => {
      document.querySelector<HTMLButtonElement>('button[aria-label*="侧边栏"]')?.click()
    })
    logoRow.insertBefore(mark, logoRow.firstChild)
  }
}

/** 把一段文本节点的 data 换成目标值。返回是否改写。
 *  用「改文本节点」而不是 textContent：React 的引用仍指向同一个节点，不会失联。 */
function rewriteTextNode(parent: Element | null, next: string): boolean {
  const node = parent?.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE) return false
  if ((node as Text).data === next) return false
  ;(node as Text).data = next
  return true
}

/** 把文案里的内部名换成显示名：模型 ID（deepseek-flash → DeepSeek）、英文推理强度值。
 *  只替换「用户自己配置出来的映射」与「已知英文枚举」，不做通用翻译。 */
function displayify(text: string): string {
  let out = text
  // 长 ID 先替换：避免 deepseek 规则先把 deepseek-flash 打成 DeepSeek-flash
  const models = [...(serverStatus?.models || [])].sort((a, b) => (b.model?.length || 0) - (a.model?.length || 0))
  for (const m of models) {
    if (m.model && m.label && m.model !== m.label) out = out.split(m.model).join(m.label)
    if (m.id && m.label && m.id !== m.label) out = out.split(m.id).join(m.label)
  }
  for (const [en, zh] of Object.entries(EFFORT_LABELS)) {
    out = out.replace(new RegExp(`\\b${en}\\b`, 'g'), zh)
  }
  return out
}

/** 输入区暴露的内部名 → 显示名。
 *  ⚠️ 定位必须用稳定的 `aria-label^="选择模型"`：`[class*="_triggerLabel"]` 这个后缀
 *  被别的组件复用（实测会先命中一个「设置」标签），按后缀取会改错元素。 */
function rewriteComposerLabels(): void {
  const card = document.querySelector('[data-composer-card]')
  if (!card) return
  const trigger = card.querySelector<HTMLElement>('button[aria-label^="选择模型"]')
  const scope: Element = trigger ?? card
  const label = scope.querySelector<HTMLElement>('[class*="_triggerLabel"]')
  const raw = (label?.textContent || '').trim()
  if (raw) rewriteTextNode(label, displayify(raw))
  const effort = scope.querySelector<HTMLElement>('[class*="_triggerEffort"]')
  const rawEffort = (effort?.textContent || '').trim()
  if (rawEffort) rewriteTextNode(effort, displayify(rawEffort))
  // 属性级泄漏：hover 提示与读屏都会读到，一并收口
  if (trigger) {
    for (const attr of ['aria-label', 'title'] as const) {
      const v = trigger.getAttribute(attr)
      if (!v) continue
      const next = displayify(v)
      if (next !== v) trigger.setAttribute(attr, next)
    }
  }
}

/** 浏览器 UI 主题色与皮肤对齐（DSH 默认 rgb(21,21,23)）。 */
function rewriteThemeColor(): void {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta && meta.getAttribute('content') !== '#0D0F12') meta.setAttribute('content', '#0D0F12')
}

/** 设置面板清扫（§五：用户配置里隐藏插件 ID 与底层描述）。
 *  「内置插件」分类列出 npm 包名与 Harness/DeepSeek 描述，对用户无意义：
 *  导航里的分类项（行级容器）与内容区的区块标题分别按文本命中隐藏。 */
function sweepSettingsPanel(): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const hits: HTMLElement[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.trim() !== '内置插件') continue
    const host = n.parentElement
    if (host instanceof HTMLElement && host.closest('[data-wu-clean]') === null) hits.push(host)
  }
  for (const el of hits) {
    if (el.closest('nav')) {
      for (let p: HTMLElement | null = el; p && p !== document.body; p = p.parentElement) {
        if (p.clientHeight >= 24 && p.clientHeight <= 72 && p.clientWidth > 120) {
          hideNode(p)
          break
        }
      }
    } else {
      for (let p: HTMLElement | null = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (p.getBoundingClientRect().height > 160) {
          hideNode(p)
          break
        }
      }
    }
  }
}

/** 「新会话/新建会话」→「新建任务」：工作台文档 §七 把主操作定义为任务而非会话。
 *  按钮有两种形态（源码 SidebarRoot）：窄侧栏 class=_newSession、宽侧栏 class=_brand _wide
 *  ——两个都要匹配（曾只匹配 _newSession 导致宽侧栏文案改写失效）。 */
export function rewriteNewSessionLabel(): void {
  for (const btn of Array.from(
    document.querySelectorAll<HTMLElement>(
      'button[class*="_newSession"], button[class*="_brand"], button[aria-label*="新会话"], button[aria-label*="新建会话"]',
    ),
  )) {
    const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n as Text).data
      const s = t.trim()
      if (s === '新会话' || s === '新建会话') (n as Text).data = '新建任务'
    }
  }
}

/** 一轮完整的品牌清扫（observer 每次回调都跑，全部幂等）。 */
export function applyBranding(): void {
  rewriteThemeColor()
  rewriteBrand()
  rewriteHeroBrand()
  rewriteComposerLabels()
  sweepSettingsPanel()
  syncTurnUsage()
}
