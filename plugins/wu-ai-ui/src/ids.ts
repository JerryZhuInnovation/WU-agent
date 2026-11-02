/**
 * WU ai 客户端插件 — 共享常量（ID / 选择器 / 类名）
 * 拆分自原 client.ts（2026-10-24 模块化重构）：所有魔法字符串的唯一真源。
 * 改 DOM 契约（data-slot / aria / 类名）只动这一处。
 */

/** 控制中心主端口（本机 HTTP，对话页与它跨端口，靠 CORS 放行）。 */
export const CONTROL_CENTER = 'http://127.0.0.1:3780'
/** 控制中心端口真的被其它应用占用时会顺延到 3781–3795（见 server/app.py），这里同步候选。 */
export const CONTROL_CENTER_PORTS = Array.from({ length: 16 }, (_, i) => 3780 + i)

let resolvedBase: string | null = null
let probeFailedAt = 0
const PROBE_RETRY_MS = 10_000

/** 探测当前控制中心基址并缓存：先试主端口，失败再顺延，避免端口漂移后整页功能静默失效。 */
export async function controlCenterBase(): Promise<string> {
  if (resolvedBase) return resolvedBase
  if (Date.now() - probeFailedAt < PROBE_RETRY_MS) return CONTROL_CENTER
  for (const port of CONTROL_CENTER_PORTS) {
    const base = `http://127.0.0.1:${port}`
    try {
      const r = await fetch(`${base}/api/status`, { cache: 'no-store' })
      const d = (await r.json().catch(() => null)) as Record<string, unknown> | null
      if (r.ok && d && 'dsh' in d) {
        resolvedBase = base
        return base
      }
    } catch {
      /* 该端口未监听：试下一个 */
    }
  }
  probeFailedAt = Date.now()
  return CONTROL_CENTER
}

/** 控制中心 API 的统一入口（自动解析当前端口）。 */
export async function ccFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${await controlCenterBase()}${path}`, init)
}
/** 插件模块 ID（style 标签归属、loader 注册名）。 */
export const MODULE_ID = 'dsh-wu-ai-ui'

/* style 标签标识：删掉对应标签即可整体还原某一层（皮肤 / 章尺寸）。 */
export const STYLE_ID = 'wu-ai-routing-style'
export const SKIN_ID = 'wu-ai-skin'

/** hero 行（仅「新会话」视图存在）——原生预设 chip 的挂载容器。 */
export const ROW_SELECTOR = 'div[class*="heroWorkspaceRow"]'

/* 注入控件的根节点 ID（按 ID 幂等，React 重渲染后由 observer 重挂）。 */
export const DASHBOARD_ROOT_ID = 'wu-ai-dashboard-root'
export const WS_NAV_ID = 'wu-ai-workspace-nav'
export const WS_PANEL_ID = 'wu-ai-ws-panel'
export const TOAST_ROOT_ID = 'wu-ai-toast-root'

/* 欢迎弹窗「不再弹出」的 localStorage 键。 */
export const WELCOME_KEY = 'wuai-welcome-dismissed'

/* 注入章的类名（侧栏 brand / hero mark 共用 WU_SEAL_USE）。 */
export const BRAND_CLASS = 'wu-ai-brand'
export const HERO_MARK_CLASS = 'wu-ai-hero-mark'
