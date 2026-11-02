(function() {
	//#region src/ids.ts
	/**
	* WU ai 客户端插件 — 共享常量（ID / 选择器 / 类名）
	* 拆分自原 client.ts（2026-10-24 模块化重构）：所有魔法字符串的唯一真源。
	* 改 DOM 契约（data-slot / aria / 类名）只动这一处。
	*/
	/** 控制中心主端口（本机 HTTP，对话页与它跨端口，靠 CORS 放行）。 */
	const CONTROL_CENTER = "http://127.0.0.1:3780";
	/** 控制中心端口真的被其它应用占用时会顺延到 3781–3795（见 server/app.py），这里同步候选。 */
	const CONTROL_CENTER_PORTS = Array.from({ length: 16 }, (_, i) => 3780 + i);
	let resolvedBase = null;
	let probeFailedAt = 0;
	const PROBE_RETRY_MS = 1e4;
	/** 探测当前控制中心基址并缓存：先试主端口，失败再顺延，避免端口漂移后整页功能静默失效。 */
	async function controlCenterBase() {
		if (resolvedBase) return resolvedBase;
		if (Date.now() - probeFailedAt < PROBE_RETRY_MS) return CONTROL_CENTER;
		for (const port of CONTROL_CENTER_PORTS) {
			const base = `http://127.0.0.1:${port}`;
			try {
				const r = await fetch(`${base}/api/status`, { cache: "no-store" });
				const d = await r.json().catch(() => null);
				if (r.ok && d && "dsh" in d) {
					resolvedBase = base;
					return base;
				}
			} catch {}
		}
		probeFailedAt = Date.now();
		return CONTROL_CENTER;
	}
	/** 控制中心 API 的统一入口（自动解析当前端口）。 */
	async function ccFetch(path, init) {
		return fetch(`${await controlCenterBase()}${path}`, init);
	}
	/** 插件模块 ID（style 标签归属、loader 注册名）。 */
	const MODULE_ID = "dsh-wu-ai-ui";
	const STYLE_ID = "wu-ai-routing-style";
	const SKIN_ID = "wu-ai-skin";
	/** hero 行（仅「新会话」视图存在）——原生预设 chip 的挂载容器。 */
	const ROW_SELECTOR = "div[class*=\"heroWorkspaceRow\"]";
	const DASHBOARD_ROOT_ID = "wu-ai-dashboard-root";
	const WS_NAV_ID = "wu-ai-workspace-nav";
	const WS_PANEL_ID = "wu-ai-ws-panel";
	const TOAST_ROOT_ID = "wu-ai-toast-root";
	const WELCOME_KEY = "wuai-welcome-dismissed";
	const BRAND_CLASS = "wu-ai-brand";
	const HERO_MARK_CLASS = "wu-ai-hero-mark";
	//#endregion
	//#region src/assets.ts
	/**
	* WU ai 客户端插件 — 静态资产与样式注入
	* 拆分自原 client.ts（2026-10-24 模块化重构）：
	*   WU 章 sprite（<defs> 单例）/ 章尺寸 CSS / 对话页皮肤 / 线性图标。
	* 所有 SVG 与 CSS 常量集中在此——改视觉只动这一处。
	*/
	/** WU 章矢量：页面级 sprite 单例，多章实例共享 defs。
	*  挂在 body 直下（React 不会回收），自身不可见——避免「首实例被隐藏容器
	*  隐藏后，后续实例渐变/滤镜全部失效」。 */
	const WU_SEAL_SPRITE = `<svg id="wu-seal-defs" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden">
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
</svg>`;
	/** 章实例：宿主 span 定宽高（见 SEAL_CSS），内层 SVG 铺满。 */
	const WU_SEAL_USE = "<svg class=\"wu-seal-svg\" viewBox=\"0 0 120 120\" aria-hidden=\"true\" focusable=\"false\"><use href=\"#wuSealArt\"/></svg>";
	/** 章实例的尺寸样式：宿主 span 定宽高，内层 SVG 铺满（圆角由章面自身 rx 承担）。
	*  侧栏章可点击（切换侧边栏），给 pointer 态。 */
	const SEAL_CSS = `.wu-ai-brand,.wu-ai-hero-mark{display:inline-block;flex:none;width:28px;height:28px}
.wu-ai-brand{cursor:pointer}
.wu-ai-hero-mark{width:40px;height:40px}
.wu-seal-svg{display:block;width:100%;height:100%}`;
	/** 注入章尺寸样式（独立 style 标签，幂等）。 */
	function ensureStyle() {
		ensureSkinStyle();
		ensureSealDefs();
		if (document.querySelector(`style[data-wu-ai-css="wu-ai-routing-style"]`)) return;
		const tag = document.createElement("style");
		tag.dataset.plugin = MODULE_ID;
		tag.dataset.wuAiCss = STYLE_ID;
		tag.textContent = SEAL_CSS;
		document.head.appendChild(tag);
	}
	function ensureSealDefs() {
		if (document.getElementById("wu-seal-defs")) return;
		document.body?.insertAdjacentHTML("afterbegin", WU_SEAL_SPRITE);
	}
	/** 注入对话页皮肤。独立 style 标签：删掉它即可整体还原 DSH 原配色。 */
	function ensureSkinStyle() {
		if (document.querySelector(`style[data-wu-ai-css="wu-ai-skin"]`)) return;
		const tag = document.createElement("style");
		tag.dataset.plugin = MODULE_ID;
		tag.dataset.wuAiCss = SKIN_ID;
		tag.textContent = SKIN_CSS;
		document.head.appendChild(tag);
	}
	const SKIN_CSS = `body[data-ds-dark-theme][data-ds-dark-theme]{
/* WU 设计 token（皮肤内部使用，也供注入控件引用） */
--wu-zen:#2EE59D;--wu-zen-soft:rgba(46,229,157,.10);--wu-zen-glow:rgba(46,229,157,.22);
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
body.wu-embedded [class*="_userRow"]{background:transparent!important;border:0!important;box-shadow:none!important;padding:0!important}`;
	/** 调度台入口图标（挂在输入区左侧工具组）。 */
	const DASH_ICON = "<svg class=\"wu-ai-routing-icon\" width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\"><path d=\"M2.5 13.5h11\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\"/><path d=\"M4.6 11V7.6M8 11V4.2M11.4 11V9.4\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\"/></svg>";
	/** 调度台展开箭头。 */
	const DASH_CARET = "<svg class=\"wu-ai-dash-caret\" width=\"10\" height=\"10\" viewBox=\"0 0 16 16\" fill=\"none\" aria-hidden=\"true\"><path d=\"M6 3.5 10.5 8 6 12.5\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>";
	/** 侧栏导航行图标（zen 线条风，与插件按钮视觉同级）。 */
	function wsIcon(kind) {
		return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">${{
			tasks: "<path d=\"M3.5 4.5h9M3.5 8h9M3.5 11.5h5.5\" stroke-linecap=\"round\"/>",
			flow: "<path d=\"M3 4h4v3H3zM9 9h4v3H9zM5 7v3.5a1 1 0 0 0 1 1h3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
			quality: "<path d=\"M8 2.5 13 4.5v3.2c0 3-2 5.4-5 6.3-3-.9-5-3.3-5-6.3V4.5z\" stroke-linejoin=\"round\"/><path d=\"m5.8 8 1.6 1.6 3-3.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
			artifacts: "<path d=\"M3 5.5c0-.8.7-1.5 1.5-1.5h2l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v4.5c0 .8-.7 1.5-1.5 1.5h-8A1.5 1.5 0 0 1 3 11.5z\" stroke-linejoin=\"round\"/>",
			usage: "<path d=\"M3 13V8M8 13V3M13 13v-3.5\" stroke-linecap=\"round\"/>"
		}[kind] || ""}</svg>`;
	}
	//#endregion
	//#region src/dom.ts
	/**
	* WU ai 客户端插件 — DOM 工具层
	* 拆分自原 client.ts（2026-10-24 模块化重构）：
	*   转义 / 幂等隐藏 / toast / 浮层定位（portal + 视口翻转）/ 家目录脱敏 / 空槽查找。
	* 本模块是被其他模块共用的地基，不 import 它们（避免循环）。
	*/
	function esc(s) {
		return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}
	/** 幂等隐藏（不改 display 值不写 style，避免每帧触发无谓变更）。 */
	function hideNode(el) {
		if (el.style.display !== "none") el.style.display = "none";
	}
	const TOAST_TTL = 6e3;
	function showToast(text) {
		if (!document.body) return;
		let root = document.getElementById(TOAST_ROOT_ID);
		if (!root) {
			root = document.createElement("div");
			root.id = TOAST_ROOT_ID;
			root.className = "wu-ai-toast-root";
			document.body.appendChild(root);
		}
		const el = document.createElement("div");
		el.className = "wu-ai-toast";
		el.textContent = text;
		root.appendChild(el);
		requestAnimationFrame(() => el.setAttribute("data-show", "true"));
		setTimeout(() => {
			el.removeAttribute("data-show");
			setTimeout(() => el.remove(), 220);
		}, TOAST_TTL);
	}
	const VIEWPORT_PAD = 8;
	const MENU_GAP = 6;
	/** 已打开菜单 → 触发钮（滚动 / 缩放时据此重新对齐）。 */
	const OPEN_MENUS = /* @__PURE__ */ new Map();
	function placeMenu(menu, seat) {
		const r = seat.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return;
		const w = menu.offsetWidth;
		const h = menu.offsetHeight;
		const roomBelow = window.innerHeight - r.bottom;
		let top = r.bottom + MENU_GAP;
		if (roomBelow < h + MENU_GAP + VIEWPORT_PAD && r.top - MENU_GAP - h >= VIEWPORT_PAD) top = r.top - MENU_GAP - h;
		top = Math.max(VIEWPORT_PAD, Math.min(top, Math.max(VIEWPORT_PAD, window.innerHeight - h - VIEWPORT_PAD)));
		const maxLeft = Math.max(VIEWPORT_PAD, window.innerWidth - w - VIEWPORT_PAD);
		const left = Math.max(VIEWPORT_PAD, Math.min(r.left, maxLeft));
		menu.style.position = "fixed";
		menu.style.top = `${Math.round(top)}px`;
		menu.style.left = `${Math.round(left)}px`;
	}
	function openMenu(menu, seat) {
		menu.hidden = false;
		if (menu.parentElement !== document.body) document.body.appendChild(menu);
		placeMenu(menu, seat);
		OPEN_MENUS.set(menu, seat);
	}
	function closeMenu(menu) {
		menu.hidden = true;
		OPEN_MENUS.delete(menu);
	}
	let realignScheduled = false;
	function realignOpenMenus() {
		if (realignScheduled) return;
		realignScheduled = true;
		requestAnimationFrame(() => {
			realignScheduled = false;
			for (const [menu, seat] of Array.from(OPEN_MENUS)) {
				if (!seat.isConnected) {
					closeMenu(menu);
					continue;
				}
				placeMenu(menu, seat);
			}
		});
	}
	if (typeof window !== "undefined") {
		window.addEventListener("scroll", realignOpenMenus, true);
		window.addEventListener("resize", realignOpenMenus);
	}
	const HOME_TEST = /\/Users\//;
	const HOME_PATH_RE = /\/Users\/[^/\s"'<>]+/g;
	function scrubHomePaths() {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const t = n;
			if (!HOME_TEST.test(t.data)) continue;
			if (t.parentElement?.closest("[contenteditable=\"true\"], textarea, input, pre, code")) continue;
			const clean = t.data.replace(HOME_PATH_RE, "~");
			if (clean !== t.data) t.data = clean;
		}
	}
	/** 行内空扩展槽：在同一父容器里找「除占位槽本身外」的空 [data-slot]。 */
	function emptySlotIn(host, except) {
		if (!host) return null;
		return Array.from(host.children).find((el) => el instanceof HTMLElement && el.matches("[data-slot]") && el !== except && el.childElementCount === 0) ?? null;
	}
	//#endregion
	//#region src/status.ts
	/**
	* WU ai 客户端插件 — 控制中心桥接与后台通道
	* 拆分自原 client.ts（2026-10-24 模块化重构）：
	*   状态拉取（路由/预设/模型清单）+ 心跳 + 运行期提示轮询 + 任务投递箱。
	* 不可达时全部静默降级——不假装知道状态（README：控制中心不可达时的对话页降级定义）。
	*/
	const OFFLINE = {
		mode: "smart",
		preset: "wu",
		reachable: false,
		models: []
	};
	/** 控制中心最后一次返回的状态；不可达时为 OFFLINE（不假装知道）。 */
	let serverStatus = OFFLINE;
	/** 写入新状态（编排层在拉到新状态后调用；各模块通过 import 的活绑定读取）。 */
	function setServerStatus(next) {
		serverStatus = next;
	}
	/** 读控制中心的当前状态（路由模式 + 预设 + 模型清单）。不可达时 reachable=false。 */
	async function fetchStatus() {
		try {
			const r = await ccFetch("/api/catalog");
			if (!r.ok) return OFFLINE;
			const d = await r.json();
			return {
				mode: "smart",
				preset: "wu",
				reachable: true,
				models: Array.isArray(d.models) ? d.models.map((m) => ({
					id: String(m.id ?? ""),
					label: String(m.label ?? m.id ?? ""),
					model: String(m.model ?? ""),
					access: String(m.access ?? "api"),
					apiKeyConfigured: Boolean(m.apiKeyConfigured)
				})) : []
			};
		} catch {
			return OFFLINE;
		}
	}
	/** 心跳：告知控制中心本 Agent 页面还开着（已在运行时点「启动」由控制中心按需开页）。 */
	function heartbeatAgent() {
		ccFetch("/api/heartbeat?kind=agent").catch(() => {});
	}
	/** 轮询同源 /wu-ai/notices；首次拉取只对齐游标，不回放历史提示。 */
	const NOTICE_POLL_MS = 4e3;
	function startNoticePoll() {
		let lastSeq = -1;
		let inflight = false;
		const tick = async () => {
			if (inflight) return;
			inflight = true;
			try {
				const r = await fetch(`/wu-ai/notices?since=${Math.max(0, lastSeq)}`, { cache: "no-store" });
				if (!r.ok) return;
				const d = await r.json();
				const seq = Number(d?.seq ?? 0) || 0;
				if (lastSeq < 0) {
					lastSeq = seq;
					return;
				}
				for (const n of Array.isArray(d?.notices) ? d.notices : []) if (n && typeof n.text === "string" && n.id > lastSeq) showToast(n.text);
				if (seq > lastSeq) lastSeq = seq;
			} catch {} finally {
				inflight = false;
			}
		};
		tick();
		setInterval(() => void tick(), NOTICE_POLL_MS);
	}
	const TASK_INBOX_MS = 2500;
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	/**
	* 填入文本：用 paste 事件而不是 execCommand。
	* Lexical 只把真正经过它输入管道的文本写进状态；execCommand 只改 DOM，
	* 发送按钮会一直保持 disabled（实测）。
	*/
	async function insertText(editor, text) {
		editor.focus();
		try {
			const dt = new DataTransfer();
			dt.setData("text/plain", text);
			editor.dispatchEvent(new ClipboardEvent("paste", {
				bubbles: true,
				cancelable: true,
				clipboardData: dt
			}));
		} catch {}
		await wait(220);
		if (!(editor.textContent || "").includes(text.slice(0, 12))) try {
			document.execCommand("insertText", false, text);
			await wait(120);
		} catch {}
		return (editor.textContent || "").includes(text.slice(0, 12));
	}
	/** 触发发送：优先点发送按钮（状态同步后才可点），再兜底 Enter。 */
	async function sendEditor(editor) {
		editor.focus();
		await wait(700);
		const send = document.querySelector("button[aria-label=\"发送消息\"]");
		if (send && !send.disabled) {
			send.click();
			await wait(800);
		}
		if ((editor.textContent || "").trim()) {
			editor.dispatchEvent(new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				bubbles: true,
				cancelable: true
			}));
			await wait(600);
		}
		return !(editor.textContent || "").trim();
	}
	/**
	* 首页/开始态没有输入区：只有当投递箱里确实有任务时，才把界面推进到一个会话里。
	* 用 peek 先看不取，避免「还没到会话就把任务消费掉」。
	*/
	async function nudgeIntoSession() {
		try {
			const r = await ccFetch("/api/pending-task?peek=1", { cache: "no-store" });
			if (!r.ok) return;
			if (!(await r.json())?.task?.text) return;
			const btn = document.querySelector("button[class*=\"_newSession\"], button[aria-label*=\"新建会话\"], button[aria-label*=\"新会话\"]");
			if (btn !== null && btn.dataset.wuNudged !== "1") {
				btn.dataset.wuNudged = "1";
				btn.click();
			}
		} catch {}
	}
	function startTaskInbox() {
		let inflight = false;
		const tick = async () => {
			if (inflight) return;
			const editor = document.querySelector("[data-lexicalEditor], div[contenteditable=\"true\"]");
			if (!editor) {
				await nudgeIntoSession();
				return;
			}
			if ((editor.textContent || "").trim()) return;
			inflight = true;
			try {
				const r = await ccFetch("/api/pending-task", { cache: "no-store" });
				if (!r.ok) return;
				const d = await r.json();
				const text = String(d?.task?.text || "").trim();
				if (!text) return;
				if (!await insertText(editor, text)) {
					navigator.clipboard.writeText(text).catch(() => {});
					showToast("任务已复制到剪贴板，请粘贴发送");
					return;
				}
				if (d?.task?.autoSend === false) {
					showToast("已从工作台接收任务，确认后按 Enter 发送");
					return;
				}
				if (await sendEditor(editor)) showToast("工作台任务已发送");
				else {
					navigator.clipboard.writeText(text).catch(() => {});
					showToast("自动发送未完成，任务已复制，请手动发送");
				}
			} catch {} finally {
				inflight = false;
			}
		};
		setInterval(() => void tick(), TASK_INBOX_MS);
	}
	async function injectSteer(text) {
		const editor = document.querySelector("[data-lexicalEditor], div[contenteditable=\"true\"]");
		if (!editor) {
			showToast("对话面还没就绪，无法注入");
			return;
		}
		if (!await insertText(editor, text)) {
			navigator.clipboard.writeText(text).catch(() => {});
			showToast("注入失败，内容已复制到剪贴板");
			return;
		}
		showToast(await sendEditor(editor) ? "已注入当前任务" : "注入未完成，请手动发送");
	}
	//#endregion
	//#region src/dashboard.ts
	/**
	* WU ai 客户端插件 — 调度台（Dashboard）
	* 拆分自原 client.ts（2026-10-24 模块化重构）。
	* 数据来自路由器埋点（本机 $DSH_HOME/perf.jsonl）经同源 /wu-ai/dashboard 暴露：
	*   analyze / route / multi / verify / retry / execute，即本轮流水线的四步。
	* 渐进式披露三层：第 1 层一行摘要 → 第 2 层展开四步 → 第 3 层为原始数值（模型 ID、
	* 耗时、分数、依据）。任何拿不到的字段一律不显示，绝不补默认文案。
	*/
	const CAP_LABELS = {
		coding: "写代码",
		vision: "看图 / 视觉",
		reasoning: "深度推理",
		research: "调研资料",
		writing: "写作 / 翻译",
		general: "通用对话"
	};
	const COMPLEXITY_LABELS = {
		trivial: "极简",
		simple: "简单",
		medium: "中等",
		complex: "复杂"
	};
	const ROLE_LABELS = {
		execute: "执行",
		analyze: "分析",
		verify: "质检",
		multi: "多步"
	};
	function fmtMs(ms) {
		const n = Number(ms || 0);
		if (!n) return "";
		return n < 1e3 ? `${n}ms` : `${(n / 1e3).toFixed(1)}s`;
	}
	function fmtTime(iso) {
		if (!iso) return "—";
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "—";
		const p = (n) => String(n).padStart(2, "0");
		return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}
	function capLabel(id) {
		if (!id) return "未知";
		return CAP_LABELS[id] || id;
	}
	function modelLabel(key) {
		if (!key) return "未知";
		return (serverStatus?.models?.find((x) => x.id === key))?.label || key;
	}
	/** 选模依据 → 人类语言。未知前缀不猜，返回 null（宁可不显示）。 */
	function reasonText(reason) {
		if (!reason) return null;
		const [head, ...rest] = reason.split(":");
		const arg = rest.join(":");
		if (head === "cap") return "能力匹配：按能力分排序（手动模式）";
		if (head === "smart-cap") return "Router Brain 分析任务后按能力分排序";
		if (head === "smart-intel") {
			const src = arg.split(":")[1] || "";
			return `Router Brain 分析任务后按${src === "actual" ? "实际使用表现" : src === "research" ? "调研档案" : src === "declared" ? "声明能力" : "能力档案"}排序`;
		}
		return null;
	}
	function currentSessionId() {
		try {
			const raw = localStorage.getItem("dsh.sessions.current");
			if (!raw) return "";
			const v = JSON.parse(raw);
			return typeof v?.sessionId === "string" ? v.sessionId : "";
		} catch {
			return "";
		}
	}
	async function fetchDashboard() {
		const sid = currentSessionId();
		const q = sid ? `?session=${encodeURIComponent(sid)}` : "";
		try {
			const r = await fetch(`/wu-ai/dashboard${q}`, { cache: "no-store" });
			if (!r.ok) return null;
			return await r.json();
		} catch {
			return null;
		}
	}
	/** 本轮调度结果短缓存：用量改写与调度台共用一次请求（本地文件读，仍不宜每帧打）。 */
	let dashCache = {
		at: 0,
		payload: null
	};
	async function dashboardCached(ttlMs = 4e3) {
		if (Date.now() - dashCache.at < ttlMs) return dashCache.payload;
		const payload = await fetchDashboard();
		dashCache = {
			at: Date.now(),
			payload
		};
		return payload;
	}
	/** 紧凑 token 数（与 DSH 同风格）：517 / 12.3K / 1.2M。 */
	function fmtTokens(n) {
		const v = Number(n);
		if (!Number.isFinite(v) || v < 0) return "";
		if (v < 1e3) return String(Math.round(v));
		if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}K`;
		return `${(v / 1e6).toFixed(1)}M`;
	}
	/** 把本轮的逐次调用按模型归并成展示行（保持首次出现的顺序）。 */
	function usageLines(turn) {
		const calls = turn?.llms;
		if (!Array.isArray(calls) || !calls.length) return [];
		const order = [];
		const map = /* @__PURE__ */ new Map();
		for (const c of calls) {
			if (!c?.usage) continue;
			const key = c.model || c.modelId || "未知";
			let row = map.get(key);
			if (!row) {
				row = {
					vendor: modelLabel(key),
					roles: /* @__PURE__ */ new Set(),
					total: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					calls: 0
				};
				map.set(key, row);
				order.push(key);
			}
			row.calls += 1;
			if (c.role) row.roles.add(ROLE_LABELS[c.role] || c.role);
			row.total += Number(c.usage.total) || (Number(c.usage.input) || 0) + (Number(c.usage.output) || 0);
			row.input += Number(c.usage.input) || 0;
			row.output += Number(c.usage.output) || 0;
			row.cacheRead += Number(c.usage.cacheRead) || 0;
		}
		const out = [];
		for (const key of order) {
			const row = map.get(key);
			if (!row || !row.total) continue;
			const bits = [`输入 ${fmtTokens(row.input) || "0"}`, `输出 ${fmtTokens(row.output) || "0"}`];
			if (row.cacheRead) bits.push(`缓存读取 ${fmtTokens(row.cacheRead)}`);
			if (row.calls > 1) bits.push(`${row.calls} 次调用`);
			out.push({
				vendor: row.vendor,
				roles: [...row.roles],
				tokens: fmtTokens(row.total),
				detail: bits.join(" · ")
			});
		}
		return out;
	}
	/** 本轮用量的一句话（把「用了哪家模型、多少用量、做什么用」串起来）。 */
	function usageLineText(l) {
		const role = l.roles.length ? `${l.roles.join("/")} ` : "";
		return `${l.vendor} ${role}${l.tokens}`;
	}
	/** 拉一次调度数据并重写本轮用量。
	*  轮次结束后一个轮询周期内，「用量 X」就会变成逐模型的「哪家 + 多少」。 */
	async function refreshTurnUsage() {
		if (document.hidden) return;
		await dashboardCached(4e3);
		syncTurnUsage();
	}
	/** DSH 的「用量 X」按钮：正常情况下本轮尾部只有一个（最新一轮）。 */
	function turnUsagePills() {
		const out = [];
		for (const btn of Array.from(document.querySelectorAll("button[aria-haspopup=\"dialog\"]"))) {
			const t = (btn.textContent || "").trim();
			if (t.startsWith("用量") || t.startsWith("Usage")) out.push(btn);
		}
		return out;
	}
	/** 从元素的 hash 类名里提取语义后缀对应的 DSH 前缀（如 abc123_trigger → abc123）。 */
	function modulePrefixOf(el, suffix) {
		for (const c of Array.from(el.classList)) if (c.endsWith("_" + suffix)) return c.slice(0, c.length - suffix.length - 1);
		return null;
	}
	/** 把最新一轮的「用量 X」改写成逐模型用量。
	*  历史轮次拿不到逐次调用记录（埋点只有本轮），保持原文不改 —— 宁可不显示也不编。 */
	function syncTurnUsage() {
		const pills = turnUsagePills();
		const pill = pills[pills.length - 1];
		if (!pill) return;
		const prefix = modulePrefixOf(pill, "trigger");
		const label = prefix ? pill.querySelector(`[class*="${prefix}label"]`) : null;
		if (!label) return;
		if (label.dataset.wuaiUsageOrigin === void 0) label.dataset.wuaiUsageOrigin = label.textContent || "";
		const origin = label.dataset.wuaiUsageOrigin || "";
		const lines = (serverStatus?.preset ?? "wu") === "wu" ? usageLines(dashCache.payload?.turn) : [];
		if (!lines.length) {
			if (label.textContent !== origin) label.textContent = origin;
			pill.removeAttribute("title");
			return;
		}
		label.textContent = lines.map(usageLineText).join(" · ");
		pill.title = lines.map((l) => `${usageLineText(l)}\n${l.detail}`).join("\n\n");
	}
	function dashStep(n, title, meta, detail) {
		return `<div class="wu-ai-dash-step"><span class="n">${esc(n)}</span><span class="b">
    <span class="t"><span>${esc(title)}</span>${meta ? `<span class="ms">${esc(meta)}</span>` : ""}</span>
    <span class="d">${detail}</span></span></div>`;
	}
	/** 第 1 层：一行摘要（默认只显示这个）。 */
	function dashSummary(t) {
		const models = t.multi?.steps?.length || (t.route ? 1 : 0);
		const verified = t.verify ? t.verify.pass ? "已核验" : "核验未通过" : t.execute?.verified ? "已核验" : "未核验";
		const total = (t.execute?.latencyMs || 0) + (t.verify?.latencyMs || 0);
		const state = t.pending ? "进行中" : "已完成";
		return `<button type="button" class="wu-ai-dash-sum" data-open="false">${DASH_CARET}<span>${state} · 已调度 ${models} 个模型 · ${verified}${total ? ` · ${esc(fmtMs(total))}` : ""}</span></button>`;
	}
	/** 第 2 层：展开四步（分解自真实埋点）。 */
	function dashSteps(t) {
		const out = [];
		if (t.analyze) {
			const bits = [capLabel(t.analyze.primary)];
			const cpx = t.analyze.complexity ? COMPLEXITY_LABELS[t.analyze.complexity] || t.analyze.complexity : "";
			if (cpx) bits.push(cpx);
			if (t.analyze.needsImage) bits.push("含图片输入");
			out.push(dashStep("1", "分析任务", "", `识别需求：${esc(bits.join(" · "))}${t.analyze.snippet ? `<br><em>${esc(t.analyze.snippet)}</em>` : ""}`));
		}
		if (t.route) {
			const mode = t.route.mode === "smart" ? "✦ 自动" : t.route.mode === "manual" ? "○ 手动" : "";
			const reason = reasonText(t.route.reason);
			const lines = [`→ <em>${esc(modelLabel(t.route.model))}</em>${t.route.modelId ? `（${esc(t.route.modelId)}）` : ""}`];
			if (reason) lines.push(`依据：${esc(reason)}`);
			if (t.multi?.steps?.length) lines.push(`多路并行：${t.multi.steps.map((s) => `${esc(capLabel(s.capability))} → ${esc(modelLabel(s.model))}`).join(" ／ ")}`);
			out.push(dashStep("2", "选择模型", mode, lines.join("<br>")));
		}
		if (t.execute) out.push(dashStep("3", "执行", fmtMs(t.execute.latencyMs), `${t.execute.success ? "✓" : "✗"} ${esc(modelLabel(t.execute.model))}${t.execute.success ? " 已返回" : " 未完成"} · ${esc(capLabel(t.execute.capability))}`));
		if (t.verify) {
			const detail = t.verify.pass ? `✓ 质量通过${t.verify.score != null ? `（${esc(t.verify.score)}）` : ""}` : `⚠ 未通过${t.verify.round ? ` · 第 ${esc(t.verify.round)} 轮` : ""}${t.verify.gaps ? `<br>${esc(t.verify.gaps)}` : ""}`;
			out.push(dashStep("4", "核验结果", fmtMs(t.verify.latencyMs), detail));
		}
		for (const r of t.retries || []) out.push(dashStep("↻", "重试", r.round ? `第 ${esc(r.round)} 轮` : "", esc((r.reason || "").slice(0, 80))));
		return out.join("");
	}
	function renderDashBody(p) {
		if (!p) return `<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">数据不可用</div>
      <div class="wu-ai-dash-row">读不到本机性能档案（需要 DSH 已启动本插件的新版本）</div></div>`;
		const t = p.turn;
		const sec = [];
		sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">本轮流水线</div>
    ${t ? dashSummary(t) : "<div class=\"wu-ai-dash-row\">本会话还没有调度记录</div>"}
    ${t ? `<div class="wu-ai-dash-steps" hidden>${dashSteps(t)}</div>` : ""}</div>`);
		const usage = usageLines(t);
		if (usage.length) sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">本轮用量</div>
      ${usage.map((l) => `<div class="wu-ai-dash-row"><span class="wu-ai-dash-dot"></span><span>${esc(l.vendor)}${l.roles.length ? ` · ${esc(l.roles.join("/"))}` : ""}</span><span class="v" title="${esc(l.detail)}">${esc(l.tokens)}</span></div>`).join("")}</div>`);
		const models = serverStatus?.models || [];
		sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">模型</div>
    ${models.length ? models.map((m) => {
			const rel = p.models.find((x) => x.key === m.id);
			const right = rel ? `${Math.round(rel.successRate * 100)}% · ${fmtMs(rel.avgLatencyMs)} · ${rel.n} 次` : "暂无执行记录";
			return `<div class="wu-ai-dash-row"><span class="wu-ai-dash-dot${m.apiKeyConfigured ? "" : " warn"}"></span><span>${esc(m.label)}</span><span class="v">${esc(right)}</span></div>`;
		}).join("") : "<div class=\"wu-ai-dash-row\">控制中心不可达，读不到模型清单</div>"}</div>`);
		sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">近期调度</div>
    ${p.routes.length ? p.routes.slice(0, 5).map((r) => `<div class="wu-ai-dash-row"><span>${esc(capLabel(r.capability))}</span><span class="v">→ ${esc(modelLabel(r.model))}${r.mode ? ` · ${r.mode === "smart" ? "自动" : "手动"}` : ""}</span></div>`).join("") : "<div class=\"wu-ai-dash-row\">暂无调度记录</div>"}</div>`);
		const rate = p.totals.successRate;
		sec.push(`<div class="wu-ai-dash-sec"><div class="wu-ai-dash-h">可靠性</div>
    <div class="wu-ai-dash-row"><span>执行次数</span><span class="v">${esc(p.totals.executions)}</span></div>
    <div class="wu-ai-dash-row"><span>成功率</span><span class="v">${rate == null ? "暂无数据" : `${Math.round(rate * 100)}%`}</span></div>
    <div class="wu-ai-dash-row"><span>平均耗时</span><span class="v">${fmtMs(p.totals.avgLatencyMs) || "暂无数据"}</span></div>
    ${p.intel ? `<div class="wu-ai-dash-row"><span>能力档案</span><span class="v">${esc(p.intel.models)} 个模型</span></div>` : ""}</div>`);
		sec.push(`<div class="wu-ai-dash-foot">数据来源：本机性能档案 perf.jsonl（${p.rows} 条，最近 ${esc(fmtTime(p.lastAt))}）· 不出本机</div>`);
		return sec.join("");
	}
	function createDashboardChip() {
		const root = document.createElement("div");
		root.id = DASHBOARD_ROOT_ID;
		root.className = "wu-ai-routing-anchor";
		const seat = document.createElement("button");
		seat.type = "button";
		seat.className = "wu-ai-routing-seat";
		seat.setAttribute("aria-haspopup", "true");
		seat.setAttribute("aria-expanded", "false");
		seat.title = "调度台：本轮调度与近期决策（真实数据）";
		seat.innerHTML = `${DASH_ICON}<span class="wu-ai-routing-label">调度台</span>`;
		const panel = document.createElement("div");
		panel.className = "wu-ai-routing-menu wu-ai-dash-menu";
		panel.setAttribute("aria-label", "调度台");
		panel.hidden = true;
		const headHtml = `<div class="wu-ai-dash-head"><span class="wu-ai-dash-title">调度台</span><button type="button" class="wu-ai-dash-close">关闭</button></div>`;
		const wirePanel = () => {
			panel.querySelector(".wu-ai-dash-close")?.addEventListener("click", () => setOpen(false));
			const sum = panel.querySelector(".wu-ai-dash-sum");
			sum?.addEventListener("click", () => {
				const steps = panel.querySelector(".wu-ai-dash-steps");
				if (!steps) return;
				const open = sum.dataset.open === "true";
				sum.dataset.open = open ? "false" : "true";
				steps.hidden = open;
				placeMenu(panel, seat);
			});
		};
		const setOpen = (open) => {
			if (open) {
				panel.innerHTML = `${headHtml}<div class="wu-ai-dash-sec"><div class="wu-ai-dash-row">正在读取本机档案…</div></div>`;
				wirePanel();
				openMenu(panel, seat);
				seat.setAttribute("aria-expanded", "true");
				fetchDashboard().then((p) => {
					if (panel.hidden) return;
					panel.innerHTML = `${headHtml}${renderDashBody(p)}`;
					wirePanel();
					placeMenu(panel, seat);
				});
				return;
			}
			closeMenu(panel);
			seat.setAttribute("aria-expanded", "false");
		};
		seat.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			setOpen(panel.hidden);
		});
		document.addEventListener("click", (e) => {
			const t = e.target;
			if (!root.contains(t) && !panel.contains(t)) setOpen(false);
		});
		document.addEventListener("keydown", (e) => {
			if (e.key === "Escape") setOpen(false);
		});
		root.append(seat);
		return {
			root,
			close: () => setOpen(false)
		};
	}
	let dashboardChip;
	/** 输入区左侧工具组的空扩展槽（`+` / `@` / 访问模式 那一组）。 */
	function findToolsSlot() {
		const card = document.querySelector("[data-composer-card]");
		if (!card) return null;
		return emptySlotIn(card.querySelector("button[aria-label^=\"指令\"]")?.parentElement, null);
	}
	function syncDashboardVisibility() {
		if (!dashboardChip) return;
		dashboardChip.root.hidden = (serverStatus?.preset ?? "wu") !== "wu";
	}
	function mountDashboardChip() {
		if (!dashboardChip) dashboardChip = createDashboardChip();
		const slot = findToolsSlot();
		if (slot && dashboardChip.root.parentElement !== slot) slot.appendChild(dashboardChip.root);
		syncDashboardVisibility();
	}
	//#endregion
	//#region src/brand.ts
	/**
	* WU ai 客户端插件 — 欢迎弹窗与品牌改写
	* 拆分自原 client.ts（2026-10-24 模块化重构）。
	* 硬约束：**只隐藏 + 注入，绝不删除 DSH 的节点**（React 持有这些节点的引用，
	* 删掉会让它在下次渲染时报错或丢引用）。文案改写只动文本节点的 data，
	* 不替换节点，保证 React 的引用仍然有效。
	* 只改「模板固定部分」，不碰用户产生的内容（例如会话标题里的 DeepSeek 字样不动）。
	*/
	const WELCOME_ORIGINAL_TITLES = [
		"内测声明",
		"Internal Testing Notice",
		"预览版说明",
		"Preview Notice"
	];
	const WELCOME_TITLE = "产品声明";
	const WELCOME_PARAGRAPHS = ["WU ai 基于 DeepSeek Harness（DSH）改编而来。DSH 目前仍处在面向开发者的快速迭代阶段，核心插件与基础 API 可能随时发生破坏性的结构变化，因此本产品在后续更新中也可能出现不兼容的调整，敬请谅解。", "我们同样秉持开源与开放的精神：欢迎你在 WU ai 的基础上自行修改与扩展，组合出属于你自己的 Agent。"];
	/** 找到尚未处理过的欢迎弹窗（按原标题识别，改写后靠标记去重）。 */
	function findWelcomeDialog() {
		for (const dialog of Array.from(document.querySelectorAll("[role=\"dialog\"]"))) {
			if (dialog.dataset.wuaiWelcome) continue;
			const heading = dialog.querySelector("h1, h2, h3, [role=\"heading\"]");
			const title = heading ? heading.textContent || "" : "";
			if (WELCOME_ORIGINAL_TITLES.some((t) => title.includes(t))) return dialog;
		}
		return null;
	}
	/** 重写弹窗文案并加「不再弹出」；已选过「不再弹出」则替用户直接关掉。 */
	function handleWelcomeDialog() {
		const dialog = findWelcomeDialog();
		if (!dialog) return;
		const continueBtn = Array.from(dialog.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "继续");
		if (!continueBtn) return;
		dialog.dataset.wuaiWelcome = "1";
		let dismissed = false;
		try {
			dismissed = localStorage.getItem(WELCOME_KEY) === "1";
		} catch {
			dismissed = false;
		}
		if (dismissed) {
			continueBtn.click();
			return;
		}
		const heading = dialog.querySelector("h1, h2, h3, [role=\"heading\"]");
		if (heading) heading.textContent = WELCOME_TITLE;
		const paragraphs = Array.from(dialog.querySelectorAll("p")).filter((p) => !p.hasAttribute("role"));
		if (paragraphs.length >= 2) {
			paragraphs[0].textContent = WELCOME_PARAGRAPHS[0];
			paragraphs[1].textContent = WELCOME_PARAGRAPHS[1];
			for (const extra of paragraphs.slice(2)) extra.remove();
		}
		const dismissBtn = continueBtn.cloneNode(true);
		dismissBtn.textContent = "不再弹出";
		dismissBtn.removeAttribute("id");
		dismissBtn.style.background = "transparent";
		dismissBtn.style.border = "1px solid var(--dsw-alias-border, rgba(255, 255, 255, 0.16))";
		dismissBtn.addEventListener("click", () => {
			try {
				localStorage.setItem(WELCOME_KEY, "1");
			} catch {}
			continueBtn.click();
		});
		continueBtn.parentElement?.insertBefore(dismissBtn, continueBtn);
	}
	/** 输入区「推理强度」触发器文案：DSH 只给英文值，这里换成中文（只映射已知值，不猜）。 */
	const EFFORT_LABELS = {
		Default: "默认",
		High: "高",
		Medium: "中",
		Low: "低"
	};
	/** 新会话页抬头那个鲸鱼标：DSH 的 FISH_LOGO_PATH 是硬编码矢量，皮肤层改不到
	*  （同区块的标语文案已由运行时品牌补丁在源头换掉）。这里隐藏原生标 + 注入 WU 印。
	*  鲸鱼的悬停游动动画随之不再出现——纯装饰，不影响任何功能。 */
	function rewriteHeroBrand() {
		const fish = document.querySelector("svg[class*=\"_fish\"]");
		if (!fish) return;
		const host = fish.parentElement;
		if (!host) return;
		hideNode(fish);
		if (!host.querySelector(`:scope > .wu-ai-hero-mark`)) {
			const mark = document.createElement("span");
			mark.className = HERO_MARK_CLASS;
			mark.setAttribute("aria-hidden", "true");
			mark.innerHTML = WU_SEAL_USE;
			host.insertBefore(mark, host.firstChild);
		}
	}
	/** 侧栏顶部品牌：logoRow 内只保留一个 WU 章（原生鲸鱼 SVG 一律隐藏；
	*  「新会话」按钮恢复原样，不再注入章——曾造成两章并排）。
	*  brandMark/brandName 容器（鲸鱼 + deepseek 字标 + HARNESS 徽章的组合）整体隐藏：
	*  宽窗口下 DSH 自己不渲染它们，窄窗口会显示——不能依赖其响应式。
	*  点击章 = 切换侧边栏（收起/展开），还原「点品牌图标折叠侧栏」的原生习惯。 */
	function rewriteBrand() {
		const logoRow = document.querySelector("[class*=\"_logoRow\"]");
		if (!logoRow) return;
		for (const s of Array.from(logoRow.querySelectorAll("svg"))) if (!s.classList.contains("wu-seal-svg")) hideNode(s);
		for (const el of Array.from(logoRow.querySelectorAll("[class*=\"_brandMark\"],[class*=\"_brandName\"]"))) hideNode(el);
		let mark = logoRow.querySelector(`:scope > span.${BRAND_CLASS}`);
		if (!mark) {
			mark = document.createElement("span");
			mark.className = BRAND_CLASS;
			mark.setAttribute("aria-hidden", "true");
			mark.title = "收起 / 展开侧边栏";
			mark.innerHTML = WU_SEAL_USE;
			mark.addEventListener("click", () => {
				document.querySelector("button[aria-label*=\"侧边栏\"]")?.click();
			});
			logoRow.insertBefore(mark, logoRow.firstChild);
		}
	}
	/** 把一段文本节点的 data 换成目标值。返回是否改写。
	*  用「改文本节点」而不是 textContent：React 的引用仍指向同一个节点，不会失联。 */
	function rewriteTextNode(parent, next) {
		const node = parent?.firstChild;
		if (!node || node.nodeType !== Node.TEXT_NODE) return false;
		if (node.data === next) return false;
		node.data = next;
		return true;
	}
	/** 把文案里的内部名换成显示名：模型 ID（deepseek-flash → DeepSeek）、英文推理强度值。
	*  只替换「用户自己配置出来的映射」与「已知英文枚举」，不做通用翻译。 */
	function displayify(text) {
		let out = text;
		const models = [...serverStatus?.models || []].sort((a, b) => (b.model?.length || 0) - (a.model?.length || 0));
		for (const m of models) {
			if (m.model && m.label && m.model !== m.label) out = out.split(m.model).join(m.label);
			if (m.id && m.label && m.id !== m.label) out = out.split(m.id).join(m.label);
		}
		for (const [en, zh] of Object.entries(EFFORT_LABELS)) out = out.replace(new RegExp(`\\b${en}\\b`, "g"), zh);
		return out;
	}
	/** 输入区暴露的内部名 → 显示名。
	*  ⚠️ 定位必须用稳定的 `aria-label^="选择模型"`：`[class*="_triggerLabel"]` 这个后缀
	*  被别的组件复用（实测会先命中一个「设置」标签），按后缀取会改错元素。 */
	function rewriteComposerLabels() {
		const card = document.querySelector("[data-composer-card]");
		if (!card) return;
		const trigger = card.querySelector("button[aria-label^=\"选择模型\"]");
		const scope = trigger ?? card;
		const label = scope.querySelector("[class*=\"_triggerLabel\"]");
		const raw = (label?.textContent || "").trim();
		if (raw) rewriteTextNode(label, displayify(raw));
		const effort = scope.querySelector("[class*=\"_triggerEffort\"]");
		const rawEffort = (effort?.textContent || "").trim();
		if (rawEffort) rewriteTextNode(effort, displayify(rawEffort));
		if (trigger) for (const attr of ["aria-label", "title"]) {
			const v = trigger.getAttribute(attr);
			if (!v) continue;
			const next = displayify(v);
			if (next !== v) trigger.setAttribute(attr, next);
		}
	}
	/** 浏览器 UI 主题色与皮肤对齐（DSH 默认 rgb(21,21,23)）。 */
	function rewriteThemeColor() {
		const meta = document.querySelector("meta[name=\"theme-color\"]");
		if (meta && meta.getAttribute("content") !== "#0D0F12") meta.setAttribute("content", "#0D0F12");
	}
	/** 设置面板清扫（§五：用户配置里隐藏插件 ID 与底层描述）。
	*  「内置插件」分类列出 npm 包名与 Harness/DeepSeek 描述，对用户无意义：
	*  导航里的分类项（行级容器）与内容区的区块标题分别按文本命中隐藏。 */
	function sweepSettingsPanel() {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		const hits = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n.data.trim() !== "内置插件") continue;
			const host = n.parentElement;
			if (host instanceof HTMLElement && host.closest("[data-wu-clean]") === null) hits.push(host);
		}
		for (const el of hits) if (el.closest("nav")) {
			for (let p = el; p && p !== document.body; p = p.parentElement) if (p.clientHeight >= 24 && p.clientHeight <= 72 && p.clientWidth > 120) {
				hideNode(p);
				break;
			}
		} else for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (p.getBoundingClientRect().height > 160) {
			hideNode(p);
			break;
		}
	}
	/** 「新会话/新建会话」→「新建任务」：工作台文档 §七 把主操作定义为任务而非会话。
	*  按钮有两种形态（源码 SidebarRoot）：窄侧栏 class=_newSession、宽侧栏 class=_brand _wide
	*  ——两个都要匹配（曾只匹配 _newSession 导致宽侧栏文案改写失效）。 */
	function rewriteNewSessionLabel() {
		for (const btn of Array.from(document.querySelectorAll("button[class*=\"_newSession\"], button[class*=\"_brand\"], button[aria-label*=\"新会话\"], button[aria-label*=\"新建会话\"]"))) {
			const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const s = n.data.trim();
				if (s === "新会话" || s === "新建会话") n.data = "新建任务";
			}
		}
	}
	/** 一轮完整的品牌清扫（observer 每次回调都跑，全部幂等）。 */
	function applyBranding() {
		rewriteThemeColor();
		rewriteBrand();
		rewriteHeroBrand();
		rewriteComposerLabels();
		sweepSettingsPanel();
		syncTurnUsage();
	}
	//#endregion
	//#region src/workspace.ts
	/**
	* WU ai 客户端插件 — 工作台（Workspace）
	* 拆分自原 client.ts（2026-10-24 模块化重构）。
	* 文档《把这一页定义为工作台》§七第一版：新建任务/对话/项目由原生侧栏承担
	* （新会话按钮、会话树、工作区），本插件补齐「工作能力」五项与「系统」区。
	* 数据来自控制中心 /api/workspace（perf.jsonl 事件流 + 产物仓库聚合）；
	* 空数据显示空状态——样本不足必须明示，绝不伪造（文档 §四.3）。
	*/
	let wsCache = {
		at: 0,
		payload: null
	};
	async function workspaceCached(ttlMs = 5e3) {
		if (Date.now() - wsCache.at < ttlMs) return wsCache.payload;
		try {
			const r = await ccFetch("/api/workspace", { cache: "no-store" });
			wsCache = {
				at: Date.now(),
				payload: r.ok ? await r.json() : null
			};
		} catch {
			wsCache = {
				at: Date.now(),
				payload: null
			};
		}
		return wsCache.payload;
	}
	const WS_TABS = [
		{
			tab: "tasks",
			label: "任务中心",
			icon: "tasks"
		},
		{
			tab: "flow",
			label: "协作流程",
			icon: "flow"
		},
		{
			tab: "quality",
			label: "质量与验证",
			icon: "quality"
		},
		{
			tab: "artifacts",
			label: "工作成果",
			icon: "artifacts"
		},
		{
			tab: "workflows",
			label: "工作流",
			icon: "usage"
		}
	];
	function wfPrompt(w) {
		const sec = (h, v) => v.trim() ? `【${h}】\n${v.trim()}\n` : "";
		return `请把以下内容当作一个完整任务执行。\n\n` + sec("任务目标", w.goal) + sec("执行步骤", w.steps) + sec("输入要求", w.inputs) + sec("质量门槛", w.gate || "按你自己的专业标准自检，未满足的部分必须修复后再交付。") + sec("输出格式", w.output) + `按步骤推进，每步给出结果；如需调整计划，先说明理由再执行。`;
	}
	/** 幂等注入侧栏「工作能力」与「系统」两区块（React 重渲染后由 observer 重挂）。 */
	function mountWorkspaceNav() {
		if (document.getElementById("wu-ai-workspace-nav")) return;
		const panelList = document.querySelector("nav[class*=\"_panelList\"]");
		const footArea = document.querySelector("div[class*=\"_footArea\"]");
		if (!panelList) return;
		const nav = document.createElement("div");
		nav.id = WS_NAV_ID;
		nav.className = "wu-ws-block";
		nav.innerHTML = `<div class="wu-ws-h">工作能力</div>${WS_TABS.map((t) => `<button type="button" class="wu-ws-row" data-ws-tab="${t.tab}">${wsIcon(t.icon)}<span>${t.label}</span></button>`).join("")}`;
		panelList.parentElement?.insertBefore(nav, panelList.nextSibling);
		if (footArea) {
			const sys = document.createElement("div");
			sys.className = "wu-ws-block wu-ws-sys";
			sys.innerHTML = `<div class="wu-ws-h">系统</div>
      <button type="button" class="wu-ws-row" data-ws-ext="models">${wsIcon("flow")}<span>模型与能力</span></button>
      <button type="button" class="wu-ws-row" data-ws-tab="usage">${wsIcon("usage")}<span>运行记录与用量</span></button>
      <button type="button" class="wu-ws-row" data-ws-ext="settings">${wsIcon("quality")}<span>设置与权限</span></button>`;
			footArea.parentElement?.insertBefore(sys, footArea);
			sys.addEventListener("click", (ev) => {
				const tabBtn = ev.target.closest("[data-ws-tab]");
				if (tabBtn) {
					openWorkspacePanel(tabBtn.dataset.wsTab || "usage");
					return;
				}
				if (ev.target.closest("[data-ws-ext]")) controlCenterBase().then((base) => window.open(base, "_blank"));
			});
		}
		nav.addEventListener("click", (ev) => {
			const b = ev.target.closest("[data-ws-tab]");
			if (b) openWorkspacePanel(b.dataset.wsTab || "tasks");
		});
	}
	function wsEmpty(text) {
		return `<div class="wu-ws-empty">${esc(text)}</div>`;
	}
	function wsRow(dot, main, right, sub = "") {
		return `<div class="wu-ws-line"><span class="wu-ws-dot ${dot}"></span><span class="wu-ws-main">${main}${sub ? `<em>${sub}</em>` : ""}</span><span class="wu-ws-right">${right}</span></div>`;
	}
	/** 工作流模板列表 / 新建表单（§四.2：保存目标步骤门槛格式，不写死模型）。 */
	function wsWorkflowsBody(items) {
		return `${items.length ? items.map((w) => `<div class="wu-ws-line"><span class="wu-ws-dot"></span><span class="wu-ws-main">${esc(w.name)}<em>${esc((w.goal || "").slice(0, 50))}</em></span>
            <button type="button" class="wu-ws-act primary" data-wf-act="exec" data-id="${esc(w.id)}">执行</button>
            <button type="button" class="wu-ws-act" data-wf-act="del" data-id="${esc(w.id)}">删除</button></div>`).join("") : wsEmpty("还没有模板。把反复执行的工作（如「分析论文」「生成审查报告」）存成模板：目标、步骤、质量门槛与输出格式都会带上，模型执行时动态选择。")}<button type="button" class="wu-ws-act wide" data-wf-act="new">+ 新建模板</button>`;
	}
	function wsWorkflowForm() {
		const f = (label, key, ph, ta = false) => `<label class="wu-ws-f"><span>${label}</span>${ta ? `<textarea data-wf-k="${key}" rows="3" placeholder="${ph}"></textarea>` : `<input data-wf-k="${key}" placeholder="${ph}">`}</label>`;
		return `<div class="wu-ws-form">
    ${f("名称 *", "name", "如：分析论文")}
    ${f("任务目标 *", "goal", "这个模板要完成什么", true)}
    ${f("执行步骤", "steps", "1. … 2. …（留空则由 WU-ai 自行规划）", true)}
    ${f("输入要求", "inputs", "需要用户提供什么材料")}
    ${f("质量门槛", "gate", "达到什么标准才算完成", true)}
    ${f("输出格式", "output", "交付物形态")}
    <div class="wu-ws-frow"><button type="button" class="wu-ws-act primary" data-wf-act="save">保存</button>
    <button type="button" class="wu-ws-act" data-wf-act="cancel">取消</button></div>
    <div class="wu-ws-note">模板不写死模型——执行时 WU-ai 按当前可用模型与能力档案动态分配。</div></div>`;
	}
	/** 执行模板：新会话 → 结构化 prompt 填入 Lexical 输入区 → 自动发送；失败回退剪贴板。
	*  发送双路径：Enter keydown（Lexical 快捷路径）→ 发送按钮；以编辑器清空为准判定成败。 */
	async function execWorkflow(w) {
		const prompt = wfPrompt(w);
		const fail = (msg) => {
			navigator.clipboard.writeText(prompt).then(() => showToast(`${msg}已复制完整任务指令，请到输入区粘贴发送`)).catch(() => showToast(msg));
		};
		const newBtn = document.querySelector("button[aria-label*=\"新建会话\"]");
		if (!newBtn) return fail("找不到新建入口。");
		newBtn.click();
		await new Promise((r) => setTimeout(r, 700));
		const editor = document.querySelector("[data-lexicalEditor], div[contenteditable=\"true\"]");
		if (!editor) return fail("找不到输入区。");
		if (!await insertText(editor, prompt)) return fail("输入区填充失败。");
		if (!await sendEditor(editor)) return fail("自动发送未完成。");
		showToast("模板任务已发送");
	}
	function wsTabBody(tab, d) {
		if (tab === "tasks") {
			const ok = d.executes.filter((e) => e.success).length;
			const rate = d.executes.length ? Math.round(ok / d.executes.length * 100) : null;
			return `<div class="wu-ws-stat">执行 ${d.executes.length} 次${rate == null ? "" : ` · 成功率 ${rate}%`}${d.eventCount ? ` · 本机事件 ${d.eventCount} 条` : ""}</div>` + (d.executes.length ? d.executes.slice().reverse().map((e) => wsRow(e.success ? "ok" : "bad", `${esc(capLabel(e.capability))} → ${esc(modelLabel(e.model))}`, `${e.verified === true ? "已验证" : e.verified === false ? "未验证" : ""} ${esc(fmtMs(e.latencyMs))}`, esc(fmtTime(e.at)))).join("") : wsEmpty("还没有任务执行记录。让 WU-ai 完成一个任务后，这里会汇总它的执行与验证状态。"));
		}
		if (tab === "flow") return (d.plans.length ? d.plans.slice().reverse().map((p) => wsRow("ok", `任务规划：${p.steps} 个步骤`, esc(fmtTime(p.at)))).join("") : wsEmpty("还没有复杂任务的规划记录。简单问题直接回答；复杂任务 WU-ai 会先拆解为带依赖的步骤，再分配模型执行。")) + (d.routes.length ? `<div class="wu-ws-sub-h">最近调度</div>` + d.routes.slice().reverse().map((r) => {
			const why = reasonText(r.reason);
			return wsRow("ok", `${esc(capLabel(r.capability))} → ${esc(modelLabel(r.model))}`, esc(fmtTime(r.at)), why ? esc(why) : "");
		}).join("") : "");
		if (tab === "quality") return d.verifies.length ? d.verifies.slice().reverse().map((v) => wsRow(v.pass ? "ok" : "bad", `质检 ${v.score == null ? "—" : v.score.toFixed(2)} 分${v.round && v.round > 1 ? ` · 第 ${v.round} 轮` : ""}`, esc(fmtTime(v.at)), v.gaps ? esc(String(v.gaps).slice(0, 60)) : "")).join("") : wsEmpty("还没有验证记录。WU-ai 会在任务完成后自动质检：检查项、分数与未通过原因都会列在这里。");
		if (tab === "artifacts") return d.artifacts.length ? d.artifacts.map((a) => {
			const f = esc(a.file);
			return `<div class="wu-ws-line"><span class="wu-ws-dot"></span><span class="wu-ws-main">${f}<em>${(a.size / 1024).toFixed(1)} KB · ${a.updatedAt}</em></span>
              <button type="button" class="wu-ws-act" data-art-act="reveal" data-file="${f}">Finder</button>
              <button type="button" class="wu-ws-act" data-art-act="copy" data-file="${f}">路径</button></div>`;
		}).join("") : wsEmpty("还没有正式产物。多步任务产出的文档、代码与报告会按任务归档在这里，并标注来源与时间。");
		if (tab === "usage") return d.usage.length ? d.usage.map((u) => wsRow("ok", esc(modelLabel(u.model)), `${u.calls} 次 · 输入 ${u.input} · 输出 ${u.output}${u.cacheRead ? ` · 缓存读 ${u.cacheRead}` : ""}`)).join("") : wsEmpty("暂无调用记录（数据不足时不会估算）。发起对话并让 WU-ai 调度模型后，这里按模型汇总调用量与 Token。");
		return wsEmpty("未知视图");
	}
	/** 工作台面板内的统一动作委托（行操作与表单都在这里分发）。 */
	let wfItemsCache = [];
	function wsHandleAction(ev, body) {
		const el = ev.target;
		const art = el.closest("[data-art-act]");
		if (art) {
			const file = art.dataset.file || "";
			if (art.dataset.artAct === "reveal") ccFetch("/api/artifacts/reveal", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ file })
			});
			else navigator.clipboard.writeText(file).then(() => showToast("已复制文件名")).catch(() => {});
			return;
		}
		const wf = el.closest("[data-wf-act]");
		if (!wf) return;
		const act = wf.dataset.wfAct || "";
		if (act === "new") {
			body.innerHTML = wsWorkflowForm();
			return;
		}
		if (act === "cancel") {
			body.innerHTML = wsWorkflowsBody(wfItemsCache);
			return;
		}
		if (act === "save") {
			const read = (k) => body.querySelector(`[data-wf-k="${k}"]`)?.value || "";
			const rec = {
				name: read("name"),
				goal: read("goal"),
				steps: read("steps"),
				inputs: read("inputs"),
				gate: read("gate"),
				output: read("output")
			};
			if (!rec.name || !rec.goal) {
				showToast("名称与目标为必填");
				return;
			}
			ccFetch("/api/workflows", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "save",
					workflow: rec
				})
			}).then((r) => r.json()).then((d) => {
				if (d.ok && d.workflow) {
					wfItemsCache.push(d.workflow);
					body.innerHTML = wsWorkflowsBody(wfItemsCache);
					showToast("模板已保存");
				} else showToast(String(d.message || "保存失败"));
			}).catch(() => showToast("保存失败：控制中心不可达"));
			return;
		}
		if (act === "del") {
			const id = wf.dataset.id || "";
			ccFetch("/api/workflows", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "delete",
					id
				})
			}).then(() => {
				wfItemsCache = wfItemsCache.filter((w) => w.id !== id);
				body.innerHTML = wsWorkflowsBody(wfItemsCache);
			}).catch(() => {});
			return;
		}
		if (act === "exec") {
			const w = wfItemsCache.find((x) => x.id === wf.dataset.id);
			if (w) execWorkflow(w);
		}
	}
	function openWorkspacePanel(tab) {
		let panel = document.getElementById(WS_PANEL_ID);
		if (!panel) {
			panel = document.createElement("div");
			panel.id = WS_PANEL_ID;
			panel.className = "wu-ws-panel";
			panel.innerHTML = `<div class="wu-ws-head"><span class="wu-ws-title">工作台</span><button type="button" class="wu-ws-close">关闭</button></div>
      <div class="wu-ws-tabs">${WS_TABS.map((t) => `<button type="button" data-ws-tab="${t.tab}">${t.label}</button>`).join("")}<button type="button" data-ws-tab="usage">用量</button></div>
      <div class="wu-ws-body"></div>`;
			document.body.appendChild(panel);
			panel.querySelector(".wu-ws-close")?.addEventListener("click", () => panel?.remove());
			panel.querySelector(".wu-ws-tabs")?.addEventListener("click", (ev) => {
				const b = ev.target.closest("[data-ws-tab]");
				if (b) openWorkspacePanel(b.dataset.wsTab || "tasks");
			});
			const bodyEl = panel.querySelector(".wu-ws-body");
			bodyEl?.addEventListener("click", (ev) => {
				if (bodyEl) wsHandleAction(ev, bodyEl);
			});
		}
		panel.querySelectorAll(".wu-ws-tabs [data-ws-tab]").forEach((b) => {
			b.classList.toggle("active", b.dataset.wsTab === tab);
		});
		const body = panel.querySelector(".wu-ws-body");
		if (!body) return;
		if (tab === "workflows") {
			body.innerHTML = "<div class=\"wu-ws-empty\">正在读取模板…</div>";
			ccFetch("/api/workflows", { cache: "no-store" }).then((r) => r.json()).then((d) => {
				wfItemsCache = Array.isArray(d.workflows) ? d.workflows : [];
				if (body.isConnected) body.innerHTML = wsWorkflowsBody(wfItemsCache);
			}).catch(() => {
				if (body.isConnected) body.innerHTML = wsEmpty("控制中心不可达，读不到模板。");
			});
			return;
		}
		body.innerHTML = "<div class=\"wu-ws-empty\">正在读取本机档案…</div>";
		workspaceCached().then((d) => {
			if (!panel?.isConnected) return;
			body.innerHTML = d ? wsTabBody(tab, d) : wsEmpty("控制中心不可达（127.0.0.1:3780）。工作台数据在本机聚合，需要控制中心运行。");
		});
	}
	//#endregion
	//#region src/presets.ts
	/**
	* WU ai 客户端插件 — 原生预设 UI 退役
	* 拆分自原 client.ts（2026-10-24 模块化重构）。
	* 一级「模式」控件已随手动路由移除（2026-10-14，只保留 WU 预设），原生 chip 不再露面。
	* 处理方式：chip 与预设菜单整棵隐藏（DOM 保留），仅此而已——没有可切换的目标，
	* 原先那套「程序驱动切换预设」的机制（合成点击 / 菜单等待 / chip 文本确认）已删除。
	* 严格只作用于「含 WU 词条的原生预设菜单」，绝不触碰模型 / 思考强度下拉。
	*/
	/** 原生预设菜单识别：含 WU 词条的 Radix 菜单。
	*  模型下拉、思考强度下拉不含这些词条，因此不会被本模块改写（历史闪烁根因）。 */
	function isPresetMenu(menu) {
		const items = menu.querySelectorAll("[role=\"menuitem\"],[role=\"menuitemradio\"]");
		for (const el of Array.from(items)) if ((el.textContent || "").trim().includes("WU 模式")) return true;
		return false;
	}
	/** 退役原生预设 chip：chip 自身 + 最近一层「有盒」的祖先容器。
	*  原生 DOM 形如 row > div(display:contents) > span.menuAnchor(有盒) > button.chip。
	*  只把 chip 设成 display:none 的话，那层 span 仍作为 hero 行的 flex item 占位
	*  ——实测会在「WU ai」与一级控件之间留下一段约 54px 的空档。 */
	function retireNativeChip(row) {
		const chip = findNativeChip(row);
		if (!chip) return;
		hideNode(chip);
		let el = chip.parentElement;
		while (el && el !== row) {
			if (getComputedStyle(el).display !== "contents") {
				hideNode(el);
				return;
			}
			el = el.parentElement;
		}
	}
	/** 原生预设 UI（chip + 其容器 + 菜单）隐藏。
	*  菜单**不能**用 display:none——那会让菜单项失焦，Radix 可能随即收起菜单。
	*  改用「不可见但可聚焦、可派发事件」的 opacity/pointer-events。 */
	function hideNativePresetUi() {
		const row = document.querySelector(ROW_SELECTOR);
		if (row) retireNativeChip(row);
		for (const menu of Array.from(document.querySelectorAll("[role=\"menu\"]"))) {
			if (menu.classList.contains("wu-ai-routing-menu")) continue;
			if (!isPresetMenu(menu)) continue;
			if (menu.style.opacity !== "0") {
				menu.style.opacity = "0";
				menu.style.pointerEvents = "none";
			}
		}
	}
	/** hero 行内原生预设 chip（class 含 seat；排除我们注入的全部控件）。
	*  用注入控件的公共类 `.wu-ai-routing-anchor` 排除，新增控件无需再改这里。 */
	function findNativeChip(row) {
		for (const b of Array.from(row.querySelectorAll("button"))) {
			if (!String(b.className).includes("seat")) continue;
			if (b.closest(".wu-ai-routing-anchor")) continue;
			return b;
		}
		return null;
	}
	//#endregion
	//#region src/stepper.ts
	/**
	* WU ai 客户端插件 —— 行内流水线（Inline Pipeline Stepper）
	* 数据来源：控制中心 /api/workspace（本机 perf.jsonl 聚合）。不用 /wu-ai/dashboard：
	* 该路由在当前 DSH 版本里 404（已实测），直接读控制中心更可靠。
	*
	* 生成中：在状态行下方显示四步实时进度 + 选模理由；
	* 结束后：折叠成一行胶囊，挂在本轮消息末尾（每轮只挂一次）。
	* 约束：节点只挂在列表容器边缘，绝不改动 React 拥有的消息节点内部。
	*/
	const STEP_ID = "wu-ai-stepper";
	const POLL_MS = 2e3;
	const CAP = {
		coding: "写代码",
		vision: "视觉",
		reasoning: "推理",
		research: "调研",
		writing: "写作",
		general: "通用"
	};
	async function fetchWs() {
		try {
			const r = await ccFetch("/api/workspace", { cache: "no-store" });
			if (!r.ok) return null;
			return await r.json();
		} catch {
			return null;
		}
	}
	const lastAt = (rows) => rows && rows.length ? String(rows[rows.length - 1]?.at || "") : "";
	const newest = (rows, baseAt = "") => {
		if (!rows || !rows.length) return null;
		const last = rows[rows.length - 1];
		return String(last?.at || "") > baseAt ? last : null;
	};
	function stage(done, run, label) {
		return `<span class="wu-step ${done ? "done" : run ? "run" : ""}"><b>${done ? "✓" : run ? "↻" : "○"}</b>${label}</span>`;
	}
	/** 分配决策状态徽章：路由 reason 以 allocation: 开头时展示（可审计任务分配）。 */
	function allocBadge(reason) {
		if (!reason.startsWith("allocation:")) return "";
		const state = reason.slice(11);
		const map = {
			EXECUTABLE: "🟢 可执行",
			TRIAL_FIRST: "🟡 先试运行",
			HOLD_FOR_CONFIRMATION: "🔴 待确认"
		};
		return map[state] ? ` <span class="wu-alloc">${map[state]}</span>` : "";
	}
	function liveHtml(s, route) {
		const cur = !s.a ? 1 : !s.r ? 2 : !s.e ? 3 : !s.v ? 4 : 0;
		const label = route?.model ? `${CAP[String(route.capability || "general")] || "任务"} · ${route.model}` : "";
		const reason = (route?.reason || "").replace(/^allocation:\w+\s*/, "");
		const badge = allocBadge(route?.reason || "");
		return `
    <div class="wu-stepbar">
      ${stage(s.a, cur === 1, "意图分流")}
      ${stage(s.r, cur === 2, `模型分派${label ? `：${label}` : ""}${badge}`)}
      ${stage(s.e, cur === 3, "执行")}
      ${stage(s.v, cur === 4, "沙箱核验")}
    </div>
    ${reason ? `<div class="wu-stepreason">${reason}</div>` : ""}
  `;
	}
	function capsuleHtml(s, route, exec, ver) {
		const ms = Number(exec?.latencyMs || 0);
		return `<span class="wu-capsule">⚡ 4 步流水线${ms ? ` · ${(ms / 1e3).toFixed(1)}s` : ""}${route?.model ? ` · ${route.model} 执行` : ""} · ${ver ? ver.pass ? "✅ 核验通过" : "⚠ 核验未完全通过" : s.v ? "✅ 已核验" : "—"}${allocBadge(route?.reason || "")}<button type="button" class="wu-trace">查看轨迹 ▸</button></span>`;
	}
	function startStepper() {
		let node = null;
		let lastParent = null;
		/** 本轮基线：运行开始时各事件的最后时间戳；之后出现更新的才视为该步完成。 */
		let base = {
			r: "",
			e: "",
			v: ""
		};
		let beganAt = 0;
		let runningPrev = false;
		const tick = async () => {
			const runningRow = document.querySelector("[data-chat-running]");
			const parent = runningRow?.parentElement ?? null;
			if (parent) lastParent = parent;
			const data = await fetchWs();
			if (!runningRow || !parent) {
				runningPrev = false;
				if (data && (!node || !node.isConnected)) {
					if (!lastParent?.isConnected) return;
					node = document.createElement("div");
					node.id = STEP_ID;
					node.className = "wu-stepper";
					lastParent.appendChild(node);
				}
				if (node && data && !node.classList.contains("collapsed")) {
					node.classList.add("collapsed");
					node.innerHTML = capsuleHtml({
						r: true,
						e: true,
						v: true
					}, latest(data.routes), latest(data.executes), latest(data.verifies));
					lastAt(data.verifies) || lastAt(data.executes);
				}
				return;
			}
			if (!runningPrev) {
				runningPrev = true;
				beganAt = Date.now();
				base = {
					r: lastAt(data?.routes),
					e: lastAt(data?.executes),
					v: lastAt(data?.verifies)
				};
			}
			const route = newest(data?.routes, base.r);
			const exec = newest(data?.executes, base.e);
			const ver = newest(data?.verifies, base.v);
			const states = {
				a: Date.now() - beganAt > 800,
				r: Boolean(route),
				e: Boolean(exec),
				v: Boolean(ver)
			};
			if (!node || !node.isConnected) {
				node = document.createElement("div");
				node.id = STEP_ID;
				node.className = "wu-stepper";
				runningRow.insertAdjacentElement("afterend", node);
			}
			node.innerHTML = liveHtml(states, route);
			node.classList.remove("collapsed");
		};
		const latest = (rows) => rows && rows.length ? rows[rows.length - 1] : null;
		document.addEventListener("click", (ev) => {
			if (!ev.target?.closest?.(".wu-trace")) return;
			try {
				window.parent?.postMessage({ type: "wu:open-trace" }, "*");
			} catch {}
		});
		setInterval(() => void tick(), POLL_MS);
	}
	//#endregion
	//#region src/canvas.ts
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
	const ARIA_HIDE = /* @__PURE__ */ new Set([
		"复制",
		"好的回答",
		"有问题的回答",
		"在新对话中分支",
		"全屏",
		"分栏",
		"新标签页",
		"打开右侧边栏",
		"选择工作区"
	]);
	/** aria-label 前缀命中即藏（用量随会话变化的动态标签）。 */
	const ARIA_HIDE_PREFIX = ["用量", "上下文已用"];
	const TOK_RE = /tok\/s|缓存命中|\d(?:\.\d+)?\s*[KM]?\s*tok\b/;
	function hide(el) {
		el.style.setProperty("display", "none", "important");
	}
	/** 单轮清扫：全部规则幂等（已藏的直接跳过），可被 observer / 定时器随意重入。 */
	function sweepOnce() {
		for (const el of Array.from(document.querySelectorAll("[class*=\"_actions\"]"))) if (el.style.display !== "none") hide(el);
		for (const el of Array.from(document.querySelectorAll("[aria-label]"))) {
			if (el.style.display === "none") continue;
			const label = el.getAttribute("aria-label") || "";
			if (ARIA_HIDE.has(label) || ARIA_HIDE_PREFIX.some((p) => label.startsWith(p))) hide(el);
		}
		for (const el of Array.from(document.querySelectorAll("[class*=\"_pill\"],[class*=\"_usage\"]"))) {
			if (el.style.display === "none") continue;
			if (TOK_RE.test(el.textContent || "")) hide(el);
		}
		for (const el of Array.from(document.querySelectorAll("[class*=\"_tabs\"]"))) {
			if (el.style.display === "none") continue;
			if (Array.from(el.querySelectorAll("button")).some((b) => (b.textContent || "").trim() === "轨迹")) hide(el);
		}
		for (const el of Array.from(document.querySelectorAll("[class*=\"_seat\"]"))) {
			if (el.style.display === "none") continue;
			if ((el.textContent || "").includes("WU 模式")) hide(el);
		}
		for (const el of Array.from(document.querySelectorAll("header,[class*=\"_tabStrip\"],[class*=\"_stripChrome\"]"))) if (el.style.display !== "none") hide(el);
	}
	/** 嵌入态启动：先扫一遍，再定时自愈（新消息渲染出的操作栏/统计即时清场）。 */
	function startChatlessCanvas() {
		sweepOnce();
		setInterval(sweepOnce, 2500);
	}
	//#endregion
	//#region src/client.ts
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
	/** 嵌入态：本页运行在控制中心的 iframe 里（window.top 访问被跨源拦截也算嵌入）。
	*  壳层已有唯一导航 / 发射器 / 流水线 / 产物台，对话面降级为引擎实况流。 */
	function isEmbedded() {
		try {
			return window.self !== window.top;
		} catch {
			return true;
		}
	}
	/** 壳层干预栏 → postMessage wu:steer：只接受父窗口的指令帧，其余一律忽略。 */
	function startSteerListener() {
		window.addEventListener("message", (ev) => {
			if (ev.source !== window.parent) return;
			const d = ev.data;
			if (!d || d.type !== "wu:steer" || typeof d.text !== "string") return;
			const text = d.text.trim();
			if (text) injectSteer(text);
		});
	}
	function mount() {
		ensureStyle();
		for (const step of [
			applyBranding,
			mountDashboardChip,
			mountWorkspaceNav,
			rewriteNewSessionLabel,
			hideNativePresetUi
		]) try {
			step();
		} catch (e) {
			console.warn("[wu-ai] mount step failed:", e);
		}
	}
	/** 拉一次控制中心状态并分发给各控件；顺带重算输入区落位（幂等、兼作自愈）。 */
	async function refreshStatus() {
		setServerStatus(await fetchStatus());
		mountDashboardChip();
		applyBranding();
		return serverStatus;
	}
	/** Boot the injected control: mount now, refresh the mode, and re-mount after React re-renders. */
	let applied = false;
	/** 构建期注入（build.sh 替换）：用于检测浏览器缓存的旧 client.js 并强制自愈一次。 */
	const WU_BUILD = "20261102180331";
	/** 构建版本自检（两级）：
	*  1) localStorage 戳与当前脚本不一致 → 有人见过更新版本，reload 拉新；
	*  2) 每会话一次向控制中心 /api/build 探测最新构建戳——浏览器强缓存旧 JS、
	*     而旧 JS 戳又与 localStorage 一致时（长期驻留），这是唯一能发现新版的路径。
	*  sessionStorage 双标记防 reload 循环。 */
	function checkBuildFresh() {
		try {
			if (localStorage.getItem("wu-ui-build") !== WU_BUILD) localStorage.setItem("wu-ui-build", WU_BUILD);
			return;
		} catch {}
	}
	function apply() {
		if (typeof document === "undefined") return;
		if (applied) return;
		applied = true;
		checkBuildFresh();
		ensureStyle();
		const start = () => {
			const embedded = isEmbedded();
			if (embedded) document.body?.classList.add("wu-embedded");
			mount();
			refreshStatus();
			handleWelcomeDialog();
			if (!document.body) return;
			let scheduled = false;
			const observer = new MutationObserver(() => {
				if (scheduled) return;
				scheduled = true;
				mount();
				mountDashboardChip();
				applyBranding();
				handleWelcomeDialog();
				hideNativePresetUi();
				if (embedded) sweepOnce();
				observer.takeRecords();
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			heartbeatAgent();
			setInterval(() => {
				heartbeatAgent();
				refreshStatus();
			}, 15e3);
			setInterval(() => void refreshTurnUsage(), 5e3);
			startNoticePoll();
			startTaskInbox();
			if (embedded) startChatlessCanvas();
			if (!embedded) startStepper();
			startSteerListener();
			scrubHomePaths();
			setInterval(scrubHomePaths, 3e3);
		};
		start();
	}
	const loader = globalThis.__ModuleLoader__;
	if (loader !== void 0) loader.load({
		id: MODULE_ID,
		factory: () => ({ apply })
	});
	else apply();
	//#endregion
})();
