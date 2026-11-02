/**
 * WU ai 客户端插件 — 静态资产与样式注入
 * 拆分自原 client.ts（2026-10-24 模块化重构）：
 *   WU 章 sprite（<defs> 单例）/ 章尺寸 CSS / 对话页皮肤 / 线性图标。
 * 所有 SVG 与 CSS 常量集中在此——改视觉只动这一处。
 */

import { MODULE_ID, SKIN_ID, STYLE_ID } from './ids'

/** WU 章矢量：页面级 sprite 单例，多章实例共享 defs。
 *  挂在 body 直下（React 不会回收），自身不可见——避免「首实例被隐藏容器
 *  隐藏后，后续实例渐变/滤镜全部失效」。 */
export const WU_SEAL_SPRITE = `<svg id="wu-seal-defs" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">
  <defs>
    <linearGradient id="wuSealBase" x1="0" y1="0" x2="0.55" y2="1"><stop offset="0" stop-color="#16241f"/><stop offset="1" stop-color="#0a0f12"/></linearGradient>
    <linearGradient id="wuSealTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2EE59D" stop-opacity=".16"/><stop offset=".62" stop-color="#2EE59D" stop-opacity="0"/></linearGradient>
    <linearGradient id="wuSealStroke" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2EE59D" stop-opacity=".55"/><stop offset="1" stop-color="#2EE59D" stop-opacity=".28"/></linearGradient>
    <filter id="wuSealSoft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.6"/></filter>
  </defs>
  <g id="wuSealArt">
    <rect x="2" y="2" width="116" height="116" rx="26" fill="url(#wuSealBase)" stroke="url(#wuSealStroke)" stroke-width="2"/>
    <rect x="2" y="2" width="116" height="116" rx="26" fill="url(#wuSealTop)"/>
    <rect x="7" y="7" width="106" height="106" rx="22" fill="none" stroke="#2EE59D" stroke-opacity=".10" stroke-width="1.5"/>
    <g stroke="#2EE59D" stroke-width="11" stroke-linecap="round" opacity=".55" filter="url(#wuSealSoft)">
      <path d="M56.4 41.8L29.2 29.1"/><path d="M77.6 66L102.2 48.8"/><path d="M46 72.3L48.6 102.1"/>
    </g>
    <g stroke="#2EE59D" stroke-width="11" stroke-linecap="round" fill="none">
      <path d="M56.4 41.8L29.2 29.1"/><path d="M77.6 66L102.2 48.8"/><path d="M46 72.3L48.6 102.1"/>
    </g>
    <circle cx="60" cy="60" r="5" fill="#2EE59D"/>
  </g>
</svg>`

/** 章实例：宿主 span 定宽高（见 SEAL_CSS），内层 SVG 铺满。 */
export const WU_SEAL_USE =
  '<svg class="wu-seal-svg" viewBox="0 0 120 120" aria-hidden="true" focusable="false"><use href="#wuSealArt"/></svg>'

/** 章实例的尺寸样式：宿主 span 定宽高，内层 SVG 铺满（圆角由章面自身 rx 承担）。
 *  侧栏章可点击（切换侧边栏），给 pointer 态。 */
const SEAL_CSS = `.wu-ai-brand,.wu-ai-hero-mark{display:inline-block;flex:none;width:28px;height:28px}
.wu-ai-brand{cursor:pointer}
.wu-ai-hero-mark{width:40px;height:40px}
.wu-seal-svg{display:block;width:100%;height:100%}`

/** 注入章尺寸样式（独立 style 标签，幂等）。 */
export function ensureStyle(): void {
  ensureSkinStyle()
  ensureSealDefs()
  if (document.querySelector(`style[data-wu-ai-css="${STYLE_ID}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = MODULE_ID
  tag.dataset.wuAiCss = STYLE_ID
  // 章尺寸：SVG 无显式宽高时按容器 100% 渲染，而宿主 span 是 inline 无高度 → 实测 0×0。
  // 显式给宿主定宽高（侧栏 28px、hero 40px），SVG 铺满并锁圆角。
  tag.textContent = SEAL_CSS
  document.head.appendChild(tag)
}

function ensureSealDefs(): void {
  if (document.getElementById('wu-seal-defs')) return
  document.body?.insertAdjacentHTML('afterbegin', WU_SEAL_SPRITE)
}

/** 注入对话页皮肤。独立 style 标签：删掉它即可整体还原 DSH 原配色。 */
export function ensureSkinStyle(): void {
  if (document.querySelector(`style[data-wu-ai-css="${SKIN_ID}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = MODULE_ID
  tag.dataset.wuAiCss = SKIN_ID
  tag.textContent = SKIN_CSS
  document.head.appendChild(tag)
}

// WU 设计 token（皮肤内部使用，也供注入控件引用）
const ZEN = '#2EE59D'
const SKIN_CSS = `body[data-ds-dark-theme][data-ds-dark-theme]{
/* WU 设计 token（皮肤内部使用，也供注入控件引用） */
--wu-zen:${ZEN};--wu-zen-soft:rgba(46,229,157,.10);--wu-zen-glow:rgba(46,229,157,.22);
--wu-bg-deep:#08090B;--wu-bg-base:#0D0F12;--wu-bg-panel:#13161C;--wu-bg-element:#1B2028;
--wu-border:#242B35;--wu-border-light:#2D3643;
--wu-text:#E2E8F0;--wu-text-muted:#8A99AD;--wu-text-dim:#56637A;
--wu-amber:#FFB020;--wu-red:#FF7B72;
--wu-mono:'JetBrains Mono','SF Mono',Menlo,monospace;
--wu-sans:'Inter',-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;

/* 界面主字体换成等宽（design-system §3：等宽是界面主字体，sans 只用于用户气泡与长段正文）。
 * DSH 的所有字号令牌都引用 --dsw-font-family，改这一处即可覆盖整个界面。 */
--dsw-font-family:var(--wu-mono);

/* DSH 用 bluish-750 同时当「次级表面」和「暗色文字」，逐个别名收口，避免整档改掉后文字不可见 */
--dsw-alias-button-elevated-fill:var(--wu-bg-element);
--dsw-alias-button-ghost-active-fill:var(--wu-bg-element);
--dsw-alias-toast-bg:var(--wu-bg-element);
--dsw-alias-tooltip-bg:var(--wu-bg-element);
--dsw-alias-label-dimmed:var(--wu-text-dim);

/* 背景：深墨四层（暗色主题下 DSH 用 950/875/850/800 表示页面与容器层级） */
--dsw-static-neutral-bluish-950:var(--wu-bg-base);
--dsw-static-neutral-bluish-900:var(--wu-bg-deep);
--dsw-static-neutral-bluish-875:var(--wu-bg-panel);
--dsw-static-neutral-bluish-850:var(--wu-bg-panel);
--dsw-static-neutral-bluish-800:var(--wu-bg-element);
/* 代码块与滚动条（暗色专用档位） */
--dsw-static-neutral-800:var(--wu-bg-element);
--dsw-static-neutral-700:var(--wu-border-light);
--dsw-static-neutral-850:var(--wu-bg-panel); /* 产物卡片等次级表面 */

/* 文字：三级 + 更深一档（暗色主题下 bluish-50 是正文近白色） */
--dsw-static-neutral-bluish-50:var(--wu-text);
--dsw-static-neutral-bluish-300:var(--wu-text-muted);
--dsw-static-neutral-bluish-400:var(--wu-text-muted);
--dsw-static-neutral-bluish-600:var(--wu-text-dim);

/* 强调：品牌蓝 → 单一悟绿（DSH 未定义 --dsw-alias-accent，这里补上并收口品牌色） */
--dsw-alias-accent:var(--wu-zen);
--dsw-static-deepseek-300:var(--wu-zen);
--dsw-static-deepseek-400:var(--wu-zen);
--dsw-static-deepseek-450:var(--wu-zen);
--dsw-static-deepseek-500:var(--wu-zen);
--dsw-static-deepseek-600:var(--wu-zen);
/* 蓝色「业务/信息」族的浅底（如「预览版」徽章）：收敛成中性深底，不引入第二强调色 */
--dsw-static-deepseek-800:var(--wu-bg-element);
--dsw-static-deepseek-900:var(--wu-bg-element);

/* 语义色：成功=悟绿，警告=琥珀，危险=红（仅状态，不做装饰） */
--dsw-static-green-400:var(--wu-zen);
--dsw-static-green-500:var(--wu-zen);
--dsw-static-amber-400:var(--wu-amber);
--dsw-static-amber-500:var(--wu-amber);
--dsw-static-red-400:var(--wu-red);
--dsw-static-red-500:var(--wu-red);
--dsw-static-red-600:var(--wu-red);
}
/* ── 形状与细节对齐设计系统 ────────────────────────────────────────────────
 * 这些只能落在具体组件上（DSH 没有把圆角/滚动条做成主题变量）。
 * 选择器一律用语义属性（data-*）或类名后缀（CSS Modules 保留本地名，hash 前缀会变），
 * 不用整串 hash 类名：DSH 升级后最坏情况是这条覆盖失效（优雅降级），不会破坏布局。 */
/* 用户气泡：非对称圆角，右下收尖指示发出方向（design-system §5 硬规则） */
body[data-ds-dark-theme] [data-chat-flow-kind="user"] [class*="_bubble"]{border-radius:12px 12px 3px 12px}
/* 回退到 sans 的两处（design-system §3：只有用户气泡正文、长段中文说明用 sans）：
 * 代码块自带 --ds-font-family-code，直接命中子元素，不会被继承覆盖。 */
body[data-ds-dark-theme] [data-chat-flow-kind="user"] [class*="_bubble"]{font-family:var(--wu-sans)}
body[data-ds-dark-theme] [class*="_markdown_"]{font-family:var(--wu-sans)}
/* 代码块容器圆角（DSH 默认 12px） */
body[data-ds-dark-theme] .md-code-block{border-radius:8px}
/* 输入卡片：圆角收敛到 ≤8px（DSH 默认 22px 大圆角） */
body[data-ds-dark-theme] [data-composer-card]{border-radius:8px}
/* 代码块：圆角 8px、正文回到 12.5px（design-system §3 / §5） */
body[data-ds-dark-theme] [data-code-block-content] pre{border-radius:0 0 8px 8px;font-size:12.5px}
/* 滚动条 6px（design-system §7） */
body[data-ds-dark-theme] ::-webkit-scrollbar{width:6px;height:6px}
body[data-ds-dark-theme] ::-webkit-scrollbar-thumb{background:var(--wu-border-light);border-radius:3px}
body[data-ds-dark-theme] ::-webkit-scrollbar-track{background:transparent}
/* 选区 */
body[data-ds-dark-theme] ::selection{background:rgba(46,229,157,.28)}
/* ── 品牌插槽净化（官方品牌包经 slot 渲染，DOM 必带 data-slot 语义属性）──
 * 侧栏拉宽后 React 渲染 official wordmark（鲸鱼标 + deepseek + HARNESS 徽章），
 * hash class 会变，data-slot 不会——按槽位整体退役，章由我们自己的 span 承担。
 * 双保险：wide 形态的容器类名（brandMark/brandName 语义后缀）一并按 class 隐藏——
 * 用户实测（Safari 宽窗口点章收起再展开）出现过 data-slot 未命中的形态。 */
body[data-ds-dark-theme] [data-slot="sidebar.brand.mark"],
body[data-ds-dark-theme] [data-slot="sidebar.brand.name"],
body[data-ds-dark-theme] [class*="_brandMark"],
body[data-ds-dark-theme] [class*="_brandName"],
body[data-ds-dark-theme] [class*="_wordmark"]{display:none}
/* ── 思考态鲸鱼尾退役（RunningWhaleTail）──
 * 生成中的状态行是 div[data-chat-running] > span._runningContent > span._runningIcon
 * （内含 APNG 遮罩 + 静帧 SVG）。按语义后缀隐藏整个图标位，文字与计时保留。 */
body[data-ds-dark-theme] [data-chat-running] [class*="_runningIcon"]{display:none}
/* ── 行内流水线（四步进度 / 完成后折叠胶囊） ── */
body[data-ds-dark-theme] .wu-stepper{margin:6px 0 2px;display:flex;flex-direction:column;gap:4px;font-family:var(--wu-mono)}
body[data-ds-dark-theme] .wu-stepbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
body[data-ds-dark-theme] .wu-step{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border:1px solid var(--wu-border);border-radius:10px;font-size:11px;color:var(--wu-text-dim)}
body[data-ds-dark-theme] .wu-step b{font-weight:400}
body[data-ds-dark-theme] .wu-step.done{color:var(--wu-zen);border-color:rgba(46,229,157,.35)}
body[data-ds-dark-theme] .wu-step.run{color:var(--wu-amber);border-color:rgba(255,176,32,.4)}
body[data-ds-dark-theme] .wu-stepreason{font-size:10px;color:var(--wu-text-dim)}
body[data-ds-dark-theme] .wu-stepper.collapsed .wu-stepbar,body[data-ds-dark-theme] .wu-stepper.collapsed .wu-stepreason{display:none}
body[data-ds-dark-theme] .wu-capsule{display:inline-flex;align-items:center;gap:8px;padding:3px 10px;border:1px dashed var(--wu-border-light);border-radius:12px;font-size:11px;color:var(--wu-text-muted)}
body[data-ds-dark-theme] .wu-trace{background:transparent;border:none;color:var(--wu-zen);font-family:var(--wu-mono);font-size:11px;padding:0 2px;cursor:pointer}
body[data-ds-dark-theme] .wu-trace:hover{text-decoration:underline}
/* 可审计任务分配：决策状态徽章（🟢 可执行 / 🟡 先试运行 / 🔴 待确认） */
body[data-ds-dark-theme] .wu-alloc{font-family:var(--wu-mono);font-size:11px;letter-spacing:.02em}
/* ── 单页壳层：侧栏恢复 DSH 原生的会话/工作区列表（左栏任务历史），
 *    WU 自己注入的工作能力导航退役，避免与壳层抽屉重复。 ── */
body[data-ds-dark-theme] .wu-ws-block{display:none}
/* 侧栏「插件」是底层概念（DSH 插件管理），单页壳层里不需要入口 */
body[data-ds-dark-theme] [class*="_panelRow"]{display:none}
/* ── 工作台导航（侧栏「工作能力/系统」区块）── */
body[data-ds-dark-theme] .wu-ws-block{margin:2px 0 6px}
body[data-ds-dark-theme] .wu-ws-h{font-family:var(--wu-mono);font-size:10px;letter-spacing:.12em;color:var(--wu-text-dim);padding:10px 14px 4px}
body[data-ds-dark-theme] .wu-ws-row{display:flex;align-items:center;gap:10px;width:calc(100% - 16px);margin:0 8px;padding:6px 10px;border:none;border-radius:6px;background:transparent;color:var(--wu-text-muted);font-family:var(--wu-mono);font-size:12px;text-align:left;cursor:pointer;transition:background .12s,color .12s}
body[data-ds-dark-theme] .wu-ws-row:hover{background:var(--wu-bg-element);color:var(--wu-text)}
body[data-ds-dark-theme] .wu-ws-row svg{flex:none;opacity:.75}
/* 收起态（窄条）：标题文字会竖排挤压——藏标题、行只留图标并居中（与原生 iconButton 一致） */
body[data-ds-dark-theme] [class*="_collapsed"] .wu-ws-h{display:none}
body[data-ds-dark-theme] [class*="_collapsed"] .wu-ws-row span{display:none}
body[data-ds-dark-theme] [class*="_collapsed"] .wu-ws-row{justify-content:center;padding:8px 0}
/* 收起态：原生 toggle 的 chevron 实际位于 x≈63.5px，而窄条仅 56px 宽 →
 * 被裁成半个弧，看起来像「原 logo 的残片」。切换功能已由 WU 章承担，
 * 收起态直接藏掉 chevron 与 railMark，并让章在窄条里居中。 */
body[data-ds-dark-theme] [class*="_collapsed"] button[class*="_toggle"],
body[data-ds-dark-theme] [class*="_collapsed"] [class*="_railMark"]{display:none}
/* 收起态还留着宽形态的「新建任务」按钮（字标已隐藏但盒子仍占宽），
   与章一起参与 flex 居中导致章被推出窄条左缘 → 收起态一并隐藏。 */
body[data-ds-dark-theme] [class*="_collapsed"] button[class*="_brand"]{display:none}
body[data-ds-dark-theme] [class*="_collapsed"] [class*="_logoRow"]{justify-content:center;padding:0}
/* ── 工作台面板（右侧浮层，复用皮肤 token）── */
body[data-ds-dark-theme] .wu-ws-panel{position:fixed;top:16px;right:76px;bottom:16px;width:min(420px,calc(100vw - 120px));z-index:2147483000;display:flex;flex-direction:column;background:var(--wu-bg-panel);border:1px solid var(--wu-border);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-family:var(--wu-mono)}
body[data-ds-dark-theme] .wu-ws-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--wu-border)}
body[data-ds-dark-theme] .wu-ws-title{font-size:12px;letter-spacing:.14em;color:var(--wu-zen)}
body[data-ds-dark-theme] .wu-ws-close{background:transparent;border:1px solid var(--wu-border);border-radius:6px;color:var(--wu-text-muted);font-family:var(--wu-mono);font-size:11px;padding:3px 10px;cursor:pointer}
body[data-ds-dark-theme] .wu-ws-close:hover{color:var(--wu-text);background:var(--wu-bg-element)}
body[data-ds-dark-theme] .wu-ws-tabs{display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid var(--wu-border);flex-wrap:wrap}
body[data-ds-dark-theme] .wu-ws-tabs button{background:transparent;border:none;border-radius:5px;color:var(--wu-text-muted);font-family:var(--wu-mono);font-size:11px;padding:4px 9px;cursor:pointer}
body[data-ds-dark-theme] .wu-ws-tabs button:hover{color:var(--wu-text);background:var(--wu-bg-element)}
body[data-ds-dark-theme] .wu-ws-tabs button.active{color:var(--wu-zen);background:var(--wu-zen-soft)}
body[data-ds-dark-theme] .wu-ws-body{flex:1;overflow-y:auto;padding:8px 14px 14px}
body[data-ds-dark-theme] .wu-ws-stat{font-size:11px;color:var(--wu-text-dim);padding:6px 0 8px;border-bottom:1px solid var(--wu-border)}
body[data-ds-dark-theme] .wu-ws-sub-h{font-size:10px;letter-spacing:.12em;color:var(--wu-text-dim);padding:10px 0 4px}
body[data-ds-dark-theme] .wu-ws-line{display:flex;align-items:baseline;gap:8px;padding:7px 0;border-bottom:1px solid var(--wu-border-light)}
body[data-ds-dark-theme] .wu-ws-line:last-child{border-bottom:none}
body[data-ds-dark-theme] .wu-ws-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--wu-zen);align-self:center}
body[data-ds-dark-theme] .wu-ws-dot.bad{background:var(--wu-red)}
body[data-ds-dark-theme] .wu-ws-main{flex:1;min-width:0;font-size:12px;color:var(--wu-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
body[data-ds-dark-theme] .wu-ws-main em{display:block;font-style:normal;font-size:11px;color:var(--wu-text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
body[data-ds-dark-theme] .wu-ws-right{flex:none;font-size:11px;color:var(--wu-text-dim)}
body[data-ds-dark-theme] .wu-ws-empty{font-size:12px;line-height:1.8;color:var(--wu-text-muted);padding:18px 2px}
/* 行操作按钮 + 工作流表单 */
body[data-ds-dark-theme] .wu-ws-act{flex:none;background:transparent;border:1px solid var(--wu-border);border-radius:5px;color:var(--wu-text-muted);font-family:var(--wu-mono);font-size:11px;padding:3px 8px;cursor:pointer}
body[data-ds-dark-theme] .wu-ws-act:hover{color:var(--wu-text);background:var(--wu-bg-element)}
body[data-ds-dark-theme] .wu-ws-act.primary{color:var(--wu-zen);border-color:var(--wu-zen-glow)}
body[data-ds-dark-theme] .wu-ws-act.primary:hover{background:var(--wu-zen-soft)}
body[data-ds-dark-theme] .wu-ws-act.wide{width:100%;margin-top:10px;padding:7px 0}
body[data-ds-dark-theme] .wu-ws-form{display:flex;flex-direction:column;gap:8px;padding:6px 0}
body[data-ds-dark-theme] .wu-ws-f{display:flex;flex-direction:column;gap:4px}
body[data-ds-dark-theme] .wu-ws-f span{font-size:10px;letter-spacing:.1em;color:var(--wu-text-dim)}
body[data-ds-dark-theme] .wu-ws-f input,body[data-ds-dark-theme] .wu-ws-f textarea{background:var(--wu-bg-base);border:1px solid var(--wu-border);border-radius:6px;color:var(--wu-text);font-family:var(--wu-mono);font-size:12px;padding:6px 9px;outline:none;resize:vertical}
body[data-ds-dark-theme] .wu-ws-f input:focus,body[data-ds-dark-theme] .wu-ws-f textarea:focus{border-color:var(--wu-zen-glow)}
body[data-ds-dark-theme] .wu-ws-frow{display:flex;gap:8px;margin-top:4px}
body[data-ds-dark-theme] .wu-ws-note{font-size:11px;line-height:1.7;color:var(--wu-text-dim)}

/* ── 嵌入态（控制中心 iframe 内）：壳层已有唯一导航 / 发射器 / 流水线 / 产物台，
   对话面降级为「引擎实况流」——隐藏 DSH 侧栏与底部大输入区，终结 UI 俄罗斯套娃。
   注意布局契约：DSH 主 frame 是 grid（56px 1fr 0px），直接 display:none 侧栏列
   会让中央栏掉进 56px 轨道（整页竖排）。必须同时重写 frame 的列模板。 */
body.wu-embedded nav[class*="_panelList"],
body.wu-embedded div[class*="_footArea"],
body.wu-embedded [class*="regionArea"]{display:none!important}
body.wu-embedded [class*="_frame"]:has(>[class*="sidebarCol"]){grid-template-columns:1fr 0!important}
body.wu-embedded [class*="sidebarCol"]{display:none!important}
/* 新会话起始页（hero：大章 + 预览版 + WU ai/WU 模式行）在嵌入态是又一层套娃——
   壳层发射器才是唯一入口，这里把装饰全部藏掉；status.ts 的 keepInSession 会把
   视图自动推进到会话实况，对话面永远不停在起始页。 */
body.wu-embedded div[class*="heroWorkspaceRow"],
body.wu-embedded div[class*="_root"]:has(span[class*="previewBadge"]),
body.wu-embedded .wu-ai-hero-mark{display:none!important}
/* 输入区恒隐形（opacity 而非 visibility/display）：元素留在渲染树里才可聚焦、
   可接收 paste——Lexical 注入不需要它可见。此前用「注入窗口临时还原」的方案
   会让用户看见任务先打进对话框再发送（多此一举）；现在注入全程无形，
   派发后直接进入会话实况。 */
body.wu-embedded [data-composer-card]{opacity:0!important;height:0!important;min-height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;pointer-events:none!important}
/* 作业看板化（2026-10-27）：用户消息气泡压平为步骤行（操作栏/时间戳由 canvas.ts
   清道夫收掉）——引擎实况读起来是一份执行日志，不是聊天记录。 */
body.wu-embedded [class*="_userStack"],
body.wu-embedded [class*="_userRow"]{background:transparent!important;border:0!important;box-shadow:none!important;padding:0!important}`

/* ── 线性图标（16×16 / 14×14 / 10×10，currentColor）────────────────────── */

/** 调度台入口图标（挂在输入区左侧工具组）。 */
export const DASH_ICON =
  '<svg class="wu-ai-routing-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 13.5h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M4.6 11V7.6M8 11V4.2M11.4 11V9.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
/** 调度台展开箭头。 */
export const DASH_CARET =
  '<svg class="wu-ai-dash-caret" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** 侧栏导航行图标（zen 线条风，与插件按钮视觉同级）。 */
export function wsIcon(kind: string): string {
  const p: Record<string, string> = {
    tasks: '<path d="M3.5 4.5h9M3.5 8h9M3.5 11.5h5.5" stroke-linecap="round"/>',
    flow: '<path d="M3 4h4v3H3zM9 9h4v3H9zM5 7v3.5a1 1 0 0 0 1 1h3" stroke-linecap="round" stroke-linejoin="round"/>',
    quality: '<path d="M8 2.5 13 4.5v3.2c0 3-2 5.4-5 6.3-3-.9-5-3.3-5-6.3V4.5z" stroke-linejoin="round"/><path d="m5.8 8 1.6 1.6 3-3.2" stroke-linecap="round" stroke-linejoin="round"/>',
    artifacts: '<path d="M3 5.5c0-.8.7-1.5 1.5-1.5h2l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5h-8A1.5 1.5 0 0 1 3 11.5z" stroke-linejoin="round"/>',
    usage: '<path d="M3 13V8M8 13V3M13 13v-3.5" stroke-linecap="round"/>',
  }
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">${p[kind] || ''}</svg>`
}
