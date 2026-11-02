/**
 * WU ai 客户端插件 — DOM 工具层
 * 拆分自原 client.ts（2026-10-24 模块化重构）：
 *   转义 / 幂等隐藏 / toast / 浮层定位（portal + 视口翻转）/ 家目录脱敏 / 空槽查找。
 * 本模块是被其他模块共用的地基，不 import 它们（避免循环）。
 */

import { TOAST_ROOT_ID } from './ids'

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 幂等隐藏（不改 display 值不写 style，避免每帧触发无谓变更）。 */
export function hideNode(el: HTMLElement): void {
  if (el.style.display !== 'none') el.style.display = 'none'
}

/* ── 运行期提示 toast ──────────────────────────────────────────────────────
 * 路由器在「第三方模型不支持 reasoning_effort」等情况下会记一条提示并自动降级，
 * 前端轮询**同源** /wu-ai/notices 取回后，在右下角弹非阻塞 toast——不遮挡
 * hero 芯片与输入区，也不拦截任何点击（容器 pointer-events:none）。
 */

const TOAST_TTL = 6000

export function showToast(text: string): void {
  if (!document.body) return
  let root = document.getElementById(TOAST_ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = TOAST_ROOT_ID
    root.className = 'wu-ai-toast-root'
    document.body.appendChild(root)
  }
  const el = document.createElement('div')
  el.className = 'wu-ai-toast'
  el.textContent = text
  root.appendChild(el)
  requestAnimationFrame(() => el.setAttribute('data-show', 'true'))
  setTimeout(() => {
    el.removeAttribute('data-show')
    setTimeout(() => el.remove(), 220)
  }, TOAST_TTL)
}

/* ── §菜单定位：portal 到 body + 视口内翻转，绝不参与 hero 行布局 ───────────
 * 历史问题：菜单曾作为 hero 行内子节点渲染并靠 getBoundingClientRect().bottom 定位。
 * hero 行位于视口底部 → 菜单被放到首屏以下；祖先若带 transform，fixed 还会失效。
 * 现在统一：菜单挂到 <body>，用 fixed 定位，空间不足时向上翻转，并夹紧在视口内。
 * 滚动 / 缩放时不关闭菜单，只做重新对齐——流式输出会持续滚动，关闭会表现为
 * 「点不开 / 一点就没了」。 */

const VIEWPORT_PAD = 8
const MENU_GAP = 6

/** 已打开菜单 → 触发钮（滚动 / 缩放时据此重新对齐）。 */
const OPEN_MENUS = new Map<HTMLElement, HTMLElement>()

export function placeMenu(menu: HTMLElement, seat: HTMLElement): void {
  const r = seat.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return
  const w = menu.offsetWidth
  const h = menu.offsetHeight
  const roomBelow = window.innerHeight - r.bottom
  let top = r.bottom + MENU_GAP
  // 下方放不下且上方放得下 → 翻转向上（hero 行贴底时的关键路径）
  if (roomBelow < h + MENU_GAP + VIEWPORT_PAD && r.top - MENU_GAP - h >= VIEWPORT_PAD) {
    top = r.top - MENU_GAP - h
  }
  top = Math.max(VIEWPORT_PAD, Math.min(top, Math.max(VIEWPORT_PAD, window.innerHeight - h - VIEWPORT_PAD)))
  const maxLeft = Math.max(VIEWPORT_PAD, window.innerWidth - w - VIEWPORT_PAD)
  const left = Math.max(VIEWPORT_PAD, Math.min(r.left, maxLeft))
  menu.style.position = 'fixed'
  menu.style.top = `${Math.round(top)}px`
  menu.style.left = `${Math.round(left)}px`
}

export function openMenu(menu: HTMLElement, seat: HTMLElement): void {
  menu.hidden = false
  if (menu.parentElement !== document.body) document.body.appendChild(menu)
  placeMenu(menu, seat)
  OPEN_MENUS.set(menu, seat)
}

export function closeMenu(menu: HTMLElement): void {
  menu.hidden = true
  OPEN_MENUS.delete(menu)
}

let realignScheduled = false

function realignOpenMenus(): void {
  if (realignScheduled) return
  realignScheduled = true
  requestAnimationFrame(() => {
    realignScheduled = false
    for (const [menu, seat] of Array.from(OPEN_MENUS)) {
      if (!seat.isConnected) {
        closeMenu(menu)
        continue
      }
      placeMenu(menu, seat)
    }
  })
}

if (typeof window !== 'undefined') {
  // capture 阶段：任何滚动容器的滚动都会重新对齐（不关闭）
  window.addEventListener('scroll', realignOpenMenus, true)
  window.addEventListener('resize', realignOpenMenus)
}

/* ── 界面脱敏：家目录 + 用户名一律显示为 ~ ───────────────────────────────── */
// 跳过可编辑区、输入框与代码块：那里可能是用户自己的内容，不能改。

const HOME_TEST = /\/Users\//
const HOME_PATH_RE = /\/Users\/[^/\s"'<>]+/g

export function scrubHomePaths(): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text
    if (!HOME_TEST.test(t.data)) continue
    if (t.parentElement?.closest('[contenteditable="true"], textarea, input, pre, code')) continue
    const clean = t.data.replace(HOME_PATH_RE, '~')
    if (clean !== t.data) t.data = clean
  }
}

/** 行内空扩展槽：在同一父容器里找「除占位槽本身外」的空 [data-slot]。 */
export function emptySlotIn(host: Element | null | undefined, except: Element | null): HTMLElement | null {
  if (!host) return null
  return (
    Array.from(host.children).find(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        el.matches('[data-slot]') &&
        el !== except &&
        el.childElementCount === 0,
    ) ?? null
  )
}
