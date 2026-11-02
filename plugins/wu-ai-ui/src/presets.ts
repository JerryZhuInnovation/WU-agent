/**
 * WU ai 客户端插件 — 原生预设 UI 退役
 * 拆分自原 client.ts（2026-10-24 模块化重构）。
 * 一级「模式」控件已随手动路由移除（2026-10-14，只保留 WU 预设），原生 chip 不再露面。
 * 处理方式：chip 与预设菜单整棵隐藏（DOM 保留），仅此而已——没有可切换的目标，
 * 原先那套「程序驱动切换预设」的机制（合成点击 / 菜单等待 / chip 文本确认）已删除。
 * 严格只作用于「含 WU 词条的原生预设菜单」，绝不触碰模型 / 思考强度下拉。
 */

import { ROW_SELECTOR } from './ids'
import { hideNode } from './dom'

/** 原生预设菜单识别：含 WU 词条的 Radix 菜单。
 *  模型下拉、思考强度下拉不含这些词条，因此不会被本模块改写（历史闪烁根因）。 */
function isPresetMenu(menu: HTMLElement): boolean {
  const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemradio"]')
  for (const el of Array.from(items)) {
    const t = (el.textContent || '').trim()
    if (t.includes('WU 模式')) return true
  }
  return false
}

/** 退役原生预设 chip：chip 自身 + 最近一层「有盒」的祖先容器。
 *  原生 DOM 形如 row > div(display:contents) > span.menuAnchor(有盒) > button.chip。
 *  只把 chip 设成 display:none 的话，那层 span 仍作为 hero 行的 flex item 占位
 *  ——实测会在「WU ai」与一级控件之间留下一段约 54px 的空档。 */
function retireNativeChip(row: HTMLElement): void {
  const chip = findNativeChip(row)
  if (!chip) return
  hideNode(chip)
  let el: HTMLElement | null = chip.parentElement
  while (el && el !== row) {
    // display:contents 的祖先不产生盒、不占位，继续向上找真正占位的那层
    if (getComputedStyle(el).display !== 'contents') {
      hideNode(el)
      return
    }
    el = el.parentElement
  }
}

/** 原生预设 UI（chip + 其容器 + 菜单）隐藏。
 *  菜单**不能**用 display:none——那会让菜单项失焦，Radix 可能随即收起菜单。
 *  改用「不可见但可聚焦、可派发事件」的 opacity/pointer-events。 */
export function hideNativePresetUi(): void {
  const row = document.querySelector<HTMLElement>(ROW_SELECTOR)
  if (row) retireNativeChip(row)
  for (const menu of Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))) {
    if (menu.classList.contains('wu-ai-routing-menu')) continue
    if (!isPresetMenu(menu)) continue
    if (menu.style.opacity !== '0') {
      menu.style.opacity = '0'
      menu.style.pointerEvents = 'none'
    }
  }
}

/** hero 行内原生预设 chip（class 含 seat；排除我们注入的全部控件）。
 *  用注入控件的公共类 `.wu-ai-routing-anchor` 排除，新增控件无需再改这里。 */
function findNativeChip(row: HTMLElement): HTMLButtonElement | null {
  for (const b of Array.from(row.querySelectorAll<HTMLButtonElement>('button'))) {
    if (!String(b.className).includes('seat')) continue
    if (b.closest('.wu-ai-routing-anchor')) continue
    return b
  }
  return null
}
