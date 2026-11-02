/**
 * WU ai 客户端插件 — 嵌入态「作业看板」清道夫（2026-10-27）
 *
 * 定位切换：Personal Agent Runtime。壳层 iframe 里的引擎实况不再是聊天气泡：
 * 复制 / 点赞 / 点踩 / 分支、Token 用量胶囊与 tok/s 统计、消息时间戳、
 * 对话/轨迹标签栏、DSH 顶栏（工作区选择 / WU 模式席位 / 全屏 / 分栏）全部清场。
 * 剩下的只有执行步骤流（用户目标 + 引擎逐步产出），像一份实时作业日志。
 *
 * DSH 的类名是构建期哈希（xzv4MW_actions 这类，跨版本必漂移），所以一律按
 * aria-label / 稳定语义后缀（_actions / _tabs / _seat）+ 文本模式匹配，
 * 配合 MutationObserver 常驻自愈，不做任何哈希耦合。
 * 约束沿用 client.ts：只隐藏，绝不删除（React 持有引用）；不触碰模型/思考下拉。
 */

/** aria-label 精确命中即藏（消息操作 + DSH 顶栏窗口件）。 */
const ARIA_HIDE = new Set([
  '复制',
  '好的回答',
  '有问题的回答',
  '在新对话中分支',
  '全屏',
  '分栏',
  '新标签页',
  '打开右侧边栏',
  '选择工作区',
])

/** aria-label 前缀命中即藏（用量随会话变化的动态标签）。 */
const ARIA_HIDE_PREFIX = ['用量', '上下文已用']

const TOK_RE = /tok\/s|缓存命中|\d(?:\.\d+)?\s*[KM]?\s*tok\b/

function hide(el: Element): void {
  ;(el as HTMLElement).style.setProperty('display', 'none', 'important')
}

/** 单轮清扫：全部规则幂等（已藏的直接跳过），可被 observer / 定时器随意重入。 */
export function sweepOnce(): void {
  // 1) 消息操作栏整条收掉（复制 + 时间戳都住在里面）：用户行与助手行共用 _actions 语义
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class*="_actions"]'))) {
    if (el.style.display !== 'none') hide(el)
  }
  // 2) aria 兜底：类名漂移时仍能按标签藏（点赞/点踩/复制/分支/窗口件）
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[aria-label]'))) {
    if (el.style.display === 'none') continue
    const label = el.getAttribute('aria-label') || ''
    if (ARIA_HIDE.has(label) || ARIA_HIDE_PREFIX.some((p) => label.startsWith(p))) hide(el)
  }
  // 3) Token 统计胶囊（tok/s / 缓存命中 / 用量 tok）：文本模式匹配，不认哈希
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class*="_pill"],[class*="_usage"]'))) {
    if (el.style.display === 'none') continue
    if (TOK_RE.test(el.textContent || '')) hide(el)
  }
  // 4) 对话/轨迹标签栏：有「轨迹」按钮的容器整条收掉（壳层有自己的轨迹入口）
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class*="_tabs"]'))) {
    if (el.style.display === 'none') continue
    if (Array.from(el.querySelectorAll('button')).some((b) => (b.textContent || '').trim() === '轨迹')) {
      hide(el)
    }
  }
  // 5) 顶栏 WU 模式席位（壳层有自己的品牌与模式语义）
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[class*="_seat"]'))) {
    if (el.style.display === 'none') continue
    if ((el.textContent || '').includes('WU 模式')) hide(el)
  }
  // 6) DSH 顶栏整条与标签条窗口件（2026-10-27 实测：<header> 语义标签直接命中，
  //    会话标题/模式席位/全屏分栏全在里面；壳层契约栏是唯一任务头）
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>('header,[class*="_tabStrip"],[class*="_stripChrome"]'),
  )) {
    if (el.style.display !== 'none') hide(el)
  }
}

/** 嵌入态启动：先扫一遍，再定时自愈（新消息渲染出的操作栏/统计即时清场）。 */
export function startChatlessCanvas(): void {
  sweepOnce()
  setInterval(sweepOnce, 2500)
}
