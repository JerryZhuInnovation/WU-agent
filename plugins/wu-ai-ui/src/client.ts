/**
 * WU ai 客户端插件 — 浏览器端入口（编排层）
 *
 * 模块化拆分（2026-10-24，原单文件 2009 行 → 9 个模块）：
 *   ids.ts       共享常量（ID / 选择器 / 类名）——改 DOM 契约只动这里
 *   assets.ts    WU 章 sprite / 皮肤 CSS / 线性图标 / 样式注入
 *   dom.ts       DOM 工具（转义 / 隐藏 / toast / 浮层定位 / 脱敏 / 空槽）
 *   status.ts    控制中心桥接（状态拉取 / 心跳 / 提示轮询 / 任务投递箱）
 *   dashboard.ts 调度台（埋点数据 / 本轮用量 / 浮层 / 挂载）
 *   workspace.ts 工作台（侧栏导航 / 功能面板 / 工作流模板）
 *   brand.ts     欢迎弹窗 / 品牌与内部名改写
 *   presets.ts   原生预设 UI 退役
 * 本文件只做编排：mount（幂等挂载各步）+ apply（启动 / observer / 轮询）。
 *
 * 对 DOM 干预的硬约束（详见各模块注释）：
 *   1) 注入浮层一律 portal 到 <body> 并 fixed 定位，绝不作为 hero 行子节点参与布局；
 *   2) 只隐藏 + 注入，绝不删除 DSH 的节点（React 持有引用）；
 *   3) 任何「原生 UI 修正」只作用于预设菜单，绝不触碰模型 / 思考强度下拉。
 */

import { MODULE_ID, ccFetch } from './ids'
import { ensureStyle } from './assets'
import { scrubHomePaths } from './dom'
import {
  fetchStatus,
  heartbeatAgent,
  injectSteer,
  serverStatus,
  setServerStatus,
  startNoticePoll,
  startTaskInbox,
  type ServerStatus,
} from './status'
import { mountDashboardChip, refreshTurnUsage } from './dashboard'
import { applyBranding, handleWelcomeDialog, rewriteNewSessionLabel } from './brand'
import { mountWorkspaceNav } from './workspace'
import { hideNativePresetUi } from './presets'
import { startStepper } from './stepper'
import { startChatlessCanvas, sweepOnce } from './canvas'

/** 嵌入态：本页运行在控制中心的 iframe 里（window.top 访问被跨源拦截也算嵌入）。
 *  壳层已有唯一导航 / 发射器 / 流水线 / 产物台，对话面降级为引擎实况流。 */
function isEmbedded(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

/** 壳层干预栏 → postMessage wu:steer：只接受父窗口的指令帧，其余一律忽略。 */
function startSteerListener(): void {
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window.parent) return
    const d = ev.data as { type?: string; text?: unknown } | null
    if (!d || d.type !== 'wu:steer' || typeof d.text !== 'string') return
    const text = d.text.trim()
    if (text) void injectSteer(text)
  })
}

function mount(): void {
  ensureStyle()
  // 每步独立兜底：一步抛错不得中断后续清扫（收起/展开切换曾致「新建任务」回退）
  for (const step of [applyBranding, mountDashboardChip, mountWorkspaceNav, rewriteNewSessionLabel, hideNativePresetUi]) {
    try {
      step()
    } catch (e) {
      console.warn('[wu-ai] mount step failed:', e)
    }
  }
}

/** 拉一次控制中心状态并分发给各控件；顺带重算输入区落位（幂等、兼作自愈）。 */
async function refreshStatus(): Promise<ServerStatus> {
  setServerStatus(await fetchStatus())
  mountDashboardChip()
  // 拿到模型清单后要再跑一次改写（模型 ID → 显示名依赖它）。
  // 放在这里兜底而不是只靠观察器：标签页在后台时 requestAnimationFrame 被暂停，
  // 观察器回调根本不执行（实测后台标签页能一直显示内部 ID）。
  applyBranding()
  return serverStatus
}

/** Boot the injected control: mount now, refresh the mode, and re-mount after React re-renders. */
let applied = false

/** 构建期注入（build.sh 替换）：用于检测浏览器缓存的旧 client.js 并强制自愈一次。 */
const WU_BUILD = '__WU_BUILD__'

/** 构建版本自检（两级）：
 *  1) localStorage 戳与当前脚本不一致 → 有人见过更新版本，reload 拉新；
 *  2) 每会话一次向控制中心 /api/build 探测最新构建戳——浏览器强缓存旧 JS、
 *     而旧 JS 戳又与 localStorage 一致时（长期驻留），这是唯一能发现新版的路径。
 *  sessionStorage 双标记防 reload 循环。 */
function checkBuildFresh(): void {
  try {
    const prev = localStorage.getItem('wu-ui-build')
    if (prev !== WU_BUILD) {
      localStorage.setItem('wu-ui-build', WU_BUILD)
      if (WU_BUILD !== '__WU_BUILD__' && prev && !sessionStorage.getItem('wu-ui-reload')) {
        sessionStorage.setItem('wu-ui-reload', '1')
        location.reload()
        return
      }
    }
    if (WU_BUILD === '__WU_BUILD__' || sessionStorage.getItem('wu-ui-probe')) return
    sessionStorage.setItem('wu-ui-probe', '1')
    void ccFetch('/api/build', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { wuUiBuild?: string | null } | null) => {
        const latest = d?.wuUiBuild
        if (!latest || latest === WU_BUILD) return
        localStorage.setItem('wu-ui-build', latest)
        if (!sessionStorage.getItem('wu-ui-reload')) {
          sessionStorage.setItem('wu-ui-reload', '1')
          location.reload()
        }
      })
      .catch(() => {})
  } catch {
    /* 隐私模式等 storage 不可用：放弃自愈，不影响正常启动 */
  }
}

function apply(): void {
  if (typeof document === 'undefined') return
  // 幂等：同模块实例重复 apply 会双开 Observer/心跳/轮询
  if (applied) return
  applied = true
  checkBuildFresh()
  ensureStyle()

  const start = () => {
    // 嵌入态先于一切挂载：CSS 按 body.wu-embedded 收起 DSH 侧栏与输入区
    const embedded = isEmbedded()
    if (embedded) document.body?.classList.add('wu-embedded')
    mount()
    void refreshStatus()
    handleWelcomeDialog()
    if (!document.body) return

    let scheduled = false
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      mount()
      mountDashboardChip()
      applyBranding()
      handleWelcomeDialog()
      hideNativePresetUi()
      // 嵌入态作业看板：新消息的操作栏/统计一渲染出来立刻清场（幂等）
      if (embedded) sweepOnce()
      // 丢弃本次回调内的自产变更记录，避免自反馈循环（闪烁根因之一）
      observer.takeRecords()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    heartbeatAgent()
    setInterval(() => {
      heartbeatAgent()
      // 顺带对齐状态：用户在控制中心改了模式，对话页这边也要跟上
      void refreshStatus()
    }, 15000)
    // 本轮用量：轮次结束后要尽快把「哪家模型 + 多少用量」呈现出来，不能等 15s
    setInterval(() => void refreshTurnUsage(), 5000)
    startNoticePoll()
    startTaskInbox()
    // 嵌入态 = 作业看板（去聊天化）：定时自愈兜底（observer 不触发的重绘/悬停显隐）
    if (embedded) startChatlessCanvas()
    // 行内流水线只在独立打开的对话页挂：内嵌时壳层画的是同一条（避免双份流水线）
    if (!embedded) startStepper()
    startSteerListener()
    scrubHomePaths()
    setInterval(scrubHomePaths, 3000)
  }

  start()
}

interface ModuleLoaderFacade {
  load: (registration: { id: string; factory: () => unknown }) => void
}

const loader = (globalThis as { __ModuleLoader__?: ModuleLoaderFacade }).__ModuleLoader__

if (loader !== undefined) {
  loader.load({
    id: MODULE_ID,
    factory: () => ({ apply }),
  })
} else {
  apply()
}
