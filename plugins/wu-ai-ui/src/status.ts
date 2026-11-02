/**
 * WU ai 客户端插件 — 控制中心桥接与后台通道
 * 拆分自原 client.ts（2026-10-24 模块化重构）：
 *   状态拉取（路由/预设/模型清单）+ 心跳 + 运行期提示轮询 + 任务投递箱。
 * 不可达时全部静默降级——不假装知道状态（README：控制中心不可达时的对话页降级定义）。
 */

import { ccFetch } from './ids'
import { showToast } from './dom'

/** 恒智能（2026-10-14 手动路由移除）：mode 仅为状态契约保留。 */
export type RoutingMode = 'smart'

/** 控制中心返回的模型条目（用于把埋点里的 provider key 显示成模型名）。 */
export interface StatusModel {
  id: string
  label: string
  /** 真实模型 ID（如 deepseek-flash）——用于把对话页上暴露的内部 ID 换回显示名。 */
  model: string
  access: string
  apiKeyConfigured: boolean
}

export interface ServerStatus {
  mode: RoutingMode
  /** 控制中心记录的会话内预设：dshy 时 WU 路由层停用，控件应隐藏。 */
  preset: 'wu' | 'dshy'
  /** 控制中心是否可达。不可达时不要假装知道状态。 */
  reachable: boolean
  models: StatusModel[]
}

const OFFLINE: ServerStatus = { mode: 'smart', preset: 'wu', reachable: false, models: [] }

/** 控制中心最后一次返回的状态；不可达时为 OFFLINE（不假装知道）。 */
export let serverStatus: ServerStatus = OFFLINE

/** 写入新状态（编排层在拉到新状态后调用；各模块通过 import 的活绑定读取）。 */
export function setServerStatus(next: ServerStatus): void {
  serverStatus = next
}

/** 读控制中心的当前状态（路由模式 + 预设 + 模型清单）。不可达时 reachable=false。 */
export async function fetchStatus(): Promise<ServerStatus> {
  try {
    const r = await ccFetch('/api/catalog')
    if (!r.ok) return OFFLINE
    const d = await r.json()
    return {
      mode: 'smart',
      preset: 'wu',
      reachable: true,
      models: Array.isArray(d.models)
        ? d.models.map((m: Record<string, unknown>) => ({
            id: String(m.id ?? ''),
            label: String(m.label ?? m.id ?? ''),
            model: String(m.model ?? ''),
            access: String(m.access ?? 'api'),
            apiKeyConfigured: Boolean(m.apiKeyConfigured),
          }))
        : [],
    }
  } catch {
    return OFFLINE
  }
}

/** 心跳：告知控制中心本 Agent 页面还开着（已在运行时点「启动」由控制中心按需开页）。 */
export function heartbeatAgent(): void {
  void ccFetch('/api/heartbeat?kind=agent').catch(() => {})
}

/** 轮询同源 /wu-ai/notices；首次拉取只对齐游标，不回放历史提示。 */
const NOTICE_POLL_MS = 4000

export function startNoticePoll(): void {
  let lastSeq = -1
  let inflight = false
  const tick = async (): Promise<void> => {
    if (inflight) return
    inflight = true
    try {
      const r = await fetch(`/wu-ai/notices?since=${Math.max(0, lastSeq)}`, { cache: 'no-store' })
      if (!r.ok) return
      const d = (await r.json()) as { seq?: number; notices?: Array<{ id: number; text: string }> }
      const seq = Number(d?.seq ?? 0) || 0
      if (lastSeq < 0) {
        lastSeq = seq
        return
      }
      for (const n of Array.isArray(d?.notices) ? d.notices : []) {
        if (n && typeof n.text === 'string' && n.id > lastSeq) showToast(n.text)
      }
      if (seq > lastSeq) lastSeq = seq
    } catch {
      /* DSH web 未就绪 / 路由未注册时静默，下次轮询重试 */
    } finally {
      inflight = false
    }
  }
  void tick()
  setInterval(() => void tick(), NOTICE_POLL_MS)
}

/* ── 工作台发射台：接收控制中心下发的任务（单次消费） ──────────────────────
 * 「派发」就是要执行：取件后填入输入区并自动发送；只有自动发送失败才退化为
 * 复制到剪贴板 + 提示。取件前要求输入区为空，避免把用户正在写的草稿冲掉。 */

const TASK_INBOX_MS = 2500

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 嵌入态注入 ─────────────────────────────────────────────────────────────
 * 壳层 iframe 里输入区被 CSS 恒隐形（opacity:0，仍在渲染树——可聚焦、可收
 * paste，见 assets.ts）。注入因此全程无形：用户不会再看到「任务先打进
 * 对话框再发送」的两步动作，派发后直接进入会话实况。 */

/**
 * 填入文本：用 paste 事件而不是 execCommand。
 * Lexical 只把真正经过它输入管道的文本写进状态；execCommand 只改 DOM，
 * 发送按钮会一直保持 disabled（实测）。
 */
export async function insertText(editor: HTMLElement, text: string): Promise<boolean> {
  editor.focus()
  try {
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
  } catch {
    /* 老浏览器不支持 DataTransfer 构造：直接退回 execCommand */
  }
  // Lexical 处理 paste 是异步的：立刻读 DOM 会误判失败并二次插入（实测出现重复文本）
  await wait(220)
  if (!(editor.textContent || '').includes(text.slice(0, 12))) {
    try {
      document.execCommand('insertText', false, text)
      await wait(120)
    } catch {
      /* 两种方式都失败时由调用方走剪贴板兜底 */
    }
  }
  return (editor.textContent || '').includes(text.slice(0, 12))
}

/** 触发发送：优先点发送按钮（状态同步后才可点），再兜底 Enter。 */
export async function sendEditor(editor: HTMLElement): Promise<boolean> {
  editor.focus()
  await wait(700)
  const send = document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')
  if (send && !send.disabled) {
    send.click()
    await wait(800)
  }
  if ((editor.textContent || '').trim()) {
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
    )
    await wait(600)
  }
  return !(editor.textContent || '').trim()
}

/**
 * 首页/开始态没有输入区：只有当投递箱里确实有任务时，才把界面推进到一个会话里。
 * 用 peek 先看不取，避免「还没到会话就把任务消费掉」。
 */
async function nudgeIntoSession(): Promise<void> {
  try {
    const r = await ccFetch('/api/pending-task?peek=1', { cache: 'no-store' })
    if (!r.ok) return
    const d = (await r.json()) as { task?: { text?: string } | null }
    if (!d?.task?.text) return
    const btn = document.querySelector<HTMLElement>(
      'button[class*="_newSession"], button[aria-label*="新建会话"], button[aria-label*="新会话"]',
    )
    if (btn !== null && btn.dataset.wuNudged !== '1') {
      btn.dataset.wuNudged = '1'
      btn.click()
    }
  } catch {
    /* 控制中心不可达：静默 */
  }
}

export function startTaskInbox(): void {
  let inflight = false
  const tick = async (): Promise<void> => {
    if (inflight) return
    const editor = document.querySelector<HTMLElement>('[data-lexicalEditor], div[contenteditable="true"]')
    if (!editor) {
      await nudgeIntoSession()
      return
    }
    // 输入区已有内容时不取件：那是用户自己的草稿，任务排队等它发出去
    if ((editor.textContent || '').trim()) return
    inflight = true
    try {
      const r = await ccFetch('/api/pending-task', { cache: 'no-store' })
      if (!r.ok) return
      const d = (await r.json()) as { task?: { text?: string; autoSend?: boolean } | null }
      const text = String(d?.task?.text || '').trim()
      if (!text) return
      // 控制中心在取件时已把 verifyMode 写进 turn-config（服务端职责），这里只管送进对话
      const inserted = await insertText(editor, text)
      if (!inserted) {
        void navigator.clipboard.writeText(text).catch(() => {})
        showToast('任务已复制到剪贴板，请粘贴发送')
        return
      }
      if (d?.task?.autoSend === false) {
        showToast('已从工作台接收任务，确认后按 Enter 发送')
        return
      }
      const sent = await sendEditor(editor)
      if (sent) showToast('工作台任务已发送')
      else {
        void navigator.clipboard.writeText(text).catch(() => {})
        showToast('自动发送未完成，任务已复制，请手动发送')
      }
    } catch {
      /* 控制中心不可达：静默，下个周期重试 */
    } finally {
      inflight = false
    }
  }
  setInterval(() => void tick(), TASK_INBOX_MS)
}

/* ── 中途干预（壳层产物台「注入」按钮 → postMessage wu:steer） ─────────────
 * 把一句话接进当前会话末尾发送；对话面没就绪时明确告知，不静默吞掉。 */
export async function injectSteer(text: string): Promise<void> {
  const editor = document.querySelector<HTMLElement>('[data-lexicalEditor], div[contenteditable="true"]')
  if (!editor) {
    showToast('对话面还没就绪，无法注入')
    return
  }
  const inserted = await insertText(editor, text)
  if (!inserted) {
    void navigator.clipboard.writeText(text).catch(() => {})
    showToast('注入失败，内容已复制到剪贴板')
    return
  }
  const sent = await sendEditor(editor)
  showToast(sent ? '已注入当前任务' : '注入未完成，请手动发送')
}

/* ── 嵌入态：对话面永远落在会话实况视图（keepInSession） ───────────────────
 * DSH 的「新会话起始页」（大章 + 预览版 + hero 行）在嵌入态是又一层套娃：
 * 装饰已由 CSS 全部藏掉。任务派发后取件流程会把视图推进到会话（hero 视图
 * 自带编辑器，任务直接填入发送）；壳层在本轮无任务时根本不显示 iframe，
 * 因此不再后台自动建会话（避免堆积空会话）。 */
