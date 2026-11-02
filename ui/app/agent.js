/* WU ai · 控制中心 —— 顶栏运行控制：启动 / 就绪轮询 / 停止 / 重登 / 退出（依赖 dom, state） */
import { $, api, confirmAsync, shortPath, toast } from "./dom.js";
import { clearBadgeOverride, fetchCatalog, on, refreshModelsOnly, refreshBadge, savePrefs, setBadge, state } from "./state.js";
import { currentView, onView, setView } from "./shell.js";
import { isTaskActive } from "./pipeline.js";

/* 视态切换：launch=发射台，active=任务对话。永远不开新标签页。
   真正的「哪一态可见」由 shell.js 负责；本模块只管对话面的装载与空状态。
   执行态里 iframe 的显示还要求「本轮有任务」：没任务时 DSH 里只会是
   空会话或新会话起始页（对用户而言是又一层套娃），此时显示壳层待命态。 */
function syncStage() {
  const frame = $("#agentFrame");
  if (!frame) return;
  const active = currentView() === "active";
  const ready = Boolean(state.dsh?.url);
  const busy = isTaskActive();
  frame.hidden = !(active && ready && busy);
  // 兜底装载：正常路径 applyDsh 已在拿到地址时预载（隐藏）；这里只在
  // src 缺失/不一致时补写（启动竞态、URL 轮换），派发路径永不等待加载。
  if (active && ready && busy && frame.dataset.src && frame.getAttribute("src") !== frame.dataset.src) {
    frame.setAttribute("src", frame.dataset.src);
  }
  const empty = $("#stageEmpty");
  empty.hidden = !(active && !(ready && busy));
  empty.classList.toggle("warming", active && !ready);
  // 空态两种：引擎预热中（Warm Daemon 拉起中，任务就绪即发）/ 待命（引擎就绪、本轮无任务）
  // 「Agent 未运行」这类暴露后台生命周期的文案被Warm Daemon 机制取代。
  const title = empty.querySelector("[data-empty-title]");
  const sub = empty.querySelector("[data-empty-sub]");
  if (title) title.textContent = ready ? "● 待命" : "◌ 引擎预热中";
  if (sub) sub.textContent = ready
    ? "从左上「＋ 新任务」派发；执行中的任务实况会显示在这里"
    : "正在拉起执行引擎，任务已排队，就绪后自动发送";
  document.body.classList.toggle("stage-frame", active);
  updateDaemonIndicator();
}

/** 常驻热备指示灯：引擎生命周期不再以按钮形式暴露给用户（2026-11-02）。
 *  就绪 = 绿色稳态「引擎热备就绪 · N 模型在线」；未就绪 = 琥珀呼吸「引擎预热中」。 */
function updateDaemonIndicator() {
  const box = $("#daemonIndicator");
  const dot = $("#daemonDot");
  const text = $("#daemonText");
  if (!box || !text) return;
  const ready = Boolean(state.dsh?.url);
  box.classList.toggle("online", ready);
  if (dot) dot.className = "pulse-dot";
  const models = Array.isArray(state.models) ? state.models.filter((m) => m.enabled !== false).length : 0;
  text.textContent = ready
    ? `引擎热备就绪 · ${models || "多"}模型在线`
    : "引擎预热中…";
}

function showStage(view) {
  setView(view === "frame" ? "active" : "launch");
  syncStage();
}

// shell 的视态变化（含其它模块发起的切换）都要带着对话面一起走
onView(syncStage);

/* 预载零白屏（2026-10-27）：DSH 是重型 SPA，过去派发瞬间才设 src，引擎页要
   白屏数秒——用户看到的就是「整页白屏重载」。改为壳层一拿到 Agent 地址就立刻
   装载 iframe（隐藏预载），派发时原地显形；未 load 完成前保持透明（CSS 淡入）。 */
const frameEl = $("#agentFrame");
frameEl?.addEventListener("load", () => {
  const src = frameEl.getAttribute("src");
  if (src && src !== "about:blank") frameEl.classList.add("wu-loaded");
});

function applyDsh(dsh) {
  state.dsh = dsh || null;
  const openBtn = $("#btnOpenAgent");
  const frame = $("#agentFrame");
  if (dsh?.url) {
    openBtn.disabled = false;
    openBtn.dataset.url = dsh.url;
    // 内嵌执行态：同一窗口内渲染 DSH 页面（令牌随 URL 带一次，之后走 cookie）。
    // 预载：拿到地址立刻装载（隐藏），不在派发时才加载。
    if (frame.dataset.src !== dsh.url) {
      frame.classList.remove("wu-loaded");
      frame.setAttribute("src", dsh.url);
    }
    frame.dataset.src = dsh.url;
  } else {
    openBtn.disabled = true;
    delete openBtn.dataset.url;
    if (frame.dataset.src) {
      frame.dataset.src = "";
      frame.classList.remove("wu-loaded");
      frame.src = "about:blank";
    }
  }
  syncStage();
  // 运行中不再显示「启动 Agent」：主按钮改为「停止运行」（危险色——
  // 绿色实底块曾在截屏里呈现为低对比的「无字绿块」，停止是中断动作，用危险色更对）
  const launchBtn = $("#btnLaunch");
  const stopBtn = $("#btnStop");
  if (dsh?.url) {
    document.body.classList.add("agent-running");
    launchBtn.hidden = true;
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    stopBtn.classList.remove("primary");
    stopBtn.textContent = "停止运行";
  } else {
    document.body.classList.remove("agent-running");
    launchBtn.hidden = false;
    launchBtn.disabled = false;
    launchBtn.textContent = "启动 Agent";
    stopBtn.hidden = true;
    stopBtn.disabled = true;
    stopBtn.textContent = "停止";
  }
}

async function launch() {
  const btn = $("#btnLaunch");
  setBadge("working", "◌ 正在启动 Agent", true);
  refreshBadge();
  btn.disabled = true;
  btn.textContent = "启动中…";
  try {
    await savePrefs(false);
    const r = await api("/api/launch", {
      method: "POST",
      body: JSON.stringify({ defaultModelId: state.defaultModelId }),
    });
    applyDsh({ url: r.url });
    toast(r.message || "已启动", "ok");
    // 单页内嵌：启动后直接进执行态（DSH 以 --no-open 启动，不再自己弹标签页）
    showStage("frame");
    pollDsh();
  } catch (e) {
    toast(e.message || String(e), "err");
    clearBadgeOverride();
  } finally {
    btn.disabled = Boolean(state.dsh?.url);
    btn.textContent = "启动 Agent";
  }
}

function pollDsh() {
  if (pollDsh._timer) clearTimeout(pollDsh._timer);
  const started = Date.now();
  const tick = async () => {
    pollDsh._timer = null;
    // 就绪前只轻量刷模型列表：不走完整 catalog 广播，避免 dsh 尚为 null 时
    // 把运行态 UI 复位（launch 已置过运行按钮）
    const data = await refreshModelsOnly();
    const dsh = data?.dsh;
    if (dsh?.url && dsh.url.includes("token=")) {
      clearBadgeOverride();
      applyDsh({ url: dsh.url });
      toast("Agent 已就绪", "ok");
      return;
    }
    if (Date.now() - started > 45000) {
      setBadge("warn", "⚠ 启动超时", true);
      refreshBadge();
      toast("启动超时，请重试或点「重新登录」", "err");
      return;
    }
    if (!dsh && Date.now() - started > 30000) {
      setBadge("working", "◌ 正在启动 Agent");
    }
    pollDsh._timer = setTimeout(tick, 1000);
  };
  tick();
}

async function stopAgent() {
  const ok = await confirmAsync({
    title: "停止 Agent",
    message: "停止当前会话？正在执行的任务会被中断，对话历史会保留。",
    ok: "停止",
  });
  if (!ok) return;
  try {
    const r = await api("/api/stop", { method: "POST", body: "{}" });
    setBadge("warn", "■ 已停止", true);
    refreshBadge();
    applyDsh(null);
    showStage("launch");
    toast(r.message || "已停止", "ok");
    setTimeout(() => {
      if ($("#stateText")?.textContent === "■ 已停止") clearBadgeOverride();
    }, 3000);
  } catch (e) {
    toast(e.message, "err");
  }
}

async function reauth() {
  const btn = $("#btnReauth");
  setBadge("working", "⇄ 正在刷新凭据", true);
  refreshBadge();
  btn.disabled = true;
  try {
    const r = await api("/api/reauth", { method: "POST", body: "{}" });
    if (r.url) {
      applyDsh({ url: r.url });
      showStage("frame");
    }
    toast(r.message || "完成", "ok");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
    clearBadgeOverride();
    fetchCatalog().catch(() => {});
  }
}

async function exitApp() {
  const ok = await confirmAsync({
    title: "退出 WU ai",
    message: "退出将停止 Agent 并关闭控制中心。下次双击 start.command 可重新启动。",
    ok: "退出",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api("/api/exit", { method: "POST", body: "{}" });
    toast(r.message || "已退出控制中心", "ok");
    setBadge("warn", "■ 已退出", true);
    refreshBadge();
    setTimeout(() => {
      window.close();
      document.body.innerHTML =
        '<div class="lp-inner"><div class="card"><h3>WU ai</h3><p class="hint">控制中心已退出。关闭本页，下次双击 start.command 重新启动。</p></div></div>';
    }, 1200);
  } catch (e) {
    toast(e.message, "err");
  }
}

/* ============================== 订阅与事件绑定 ============================== */

on("catalog", (data) => applyDsh(data.dsh));

$("#btnLaunch").onclick = () => launch();
$("#btnStop").onclick = () => stopAgent();
$("#btnReauth").onclick = () => reauth();
$("#btnExit").onclick = () => exitApp();
$("#btnOpenAgent").onclick = () => showStage("frame");
// 逃生口：内嵌被浏览器拦下、或想要一个整窗对话面时，用户仍能开到新标签
$("#btnOpenTab").onclick = () => {
  const url = state.dsh?.url;
  if (!url) {
    toast("Agent 未运行", "err");
    return;
  }
  window.open(url, "wu-agent");
};
$("#navLaunch").onclick = () => showStage("launch");
// 深链：刷新/直接打开时保留当前视图（#task 进入执行态）
if (location.hash === "#task") showStage("frame");
$("#btnInstallNode").onclick = async () => {
  const btn = $("#btnInstallNode");
  btn.disabled = true;
  btn.textContent = "安装中…";
  try {
    const r = await api("/api/install-node", { method: "POST", body: "{}" });
    toast(`Node 已就绪：${shortPath(r.path)}`, "ok");
    await fetchCatalog();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "安装 Node";
  }
};

export { applyDsh, launch, pollDsh, showStage, stopAgent, syncStage };
