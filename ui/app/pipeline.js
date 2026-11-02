/* WU ai · 控制中心 —— 执行态顶部的行内流水线（Inline Pipeline）

   数据来源：路由插件写进 perf.jsonl 的真实埋点。控制中心不伪造进度：
     · 主通道 GET /api/task-stream（SSE，服务端按文件偏移增量推送）；
     · 回退 GET /api/task-events?offset=（EventSource 不可用/被掐断时每 2.5s 拉一次）。
   「任务开始/结束」以真实事件为准（route/execute/verify/idle），不做定时假动画；
   只有「已用时长」是本地秒表。

   右侧两个入口复用抽屉：改动 → TASK DIFF，轨迹 → RUN TRACE。
*/
import { $, api, esc } from "./dom.js";
import { openDrawer } from "./doctor.js";
import { refreshTrace } from "./trace.js";
import { refreshShadow } from "./shadow.js";
import { stopAgent } from "./agent.js";

const STEPS = [
  { id: "intent", label: "意图分流" },
  { id: "route", label: "模型分派" },
  { id: "execute", label: "执行" },
  { id: "verify", label: "沙箱核验" },
];

/** 刷新页面后还能接着显示本轮（sessionStorage 只在当前标签页有效） */
const KEY = "wu-task";

let task = null;

function blankSteps() {
  return { intent: "run", route: "pending", execute: "pending", verify: "pending" };
}

const PERM_UI = { full: "🛡️ 完全自治", "workspace-write": "🛡️ 沙箱读写" };
const VERIFY_UI = { fast: "⚖️ 快速直通", strict: "⚖️ 严格" };

function mark(status) {
  return status === "done" ? "✓" : status === "run" ? "↻" : status === "warn" ? "!" : status === "skip" ? "–" : "○";
}

function fmt(ms) {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/* 路由决策徽章（2026-11-02）：内部签名（smart-intel:reasoning:registry+ucb 这类）
   是给日志看的，不是给用户看的。这里翻译成策略短语；原文放 title 供排查。 */
const CAP_ZH = {
  coding: "代码", vision: "视觉", reasoning: "推理",
  research: "调研", writing: "写作", general: "通用",
};

function translateReason(raw) {
  const s = String(raw || "");
  if (!s) return "";
  let strat = "能力匹配";
  if (s.includes("registry+ucb")) strat = "档案匹配 + UCB 探索";
  else if (s.includes("actual")) strat = "实测账本优先";
  else if (s.includes("research")) strat = "调研档案";
  else if (s.includes("declared")) strat = "声明档案";
  else if (s.startsWith("allocation")) strat = "可审计分配";
  const cap = CAP_ZH[s.split(":")[1]] || "";
  return cap ? `${cap} · ${strat}` : strat;
}

function render() {
  const strip = $("#pipeStrip");
  if (!strip) return;
  const dot = $("#contractDot");
  const goal = $("#contractGoal");
  if (!task) {
    strip.innerHTML = `<span class="pipe-empty">派发任务后这里显示四步进度</span>`;
    if (dot) dot.className = "task-dot";
    if (goal) goal.textContent = "—";
    return;
  }
  // 契约栏：目标原文 + 状态点 + 派发时锁定的权限/核验回显；干预过则在旁标 vN
  if (goal) {
    const rev = Array.isArray(task.revisions) && task.revisions.length
      ? ` <span class="rev-pill" title="${esc(task.revisions.join("；"))}">v${task.revisions.length + 1} 已演进</span>`
      : "";
    goal.innerHTML = `${esc(task.label || "—")}${rev}`;
  }
  if (dot) {
    const anyWarn = Object.values(task.steps).some((s) => s === "warn");
    dot.className = `task-dot ${task.endedAt ? (anyWarn ? "warn" : "done") : "run"}`;
  }
  const perm = $("#contractPerm");
  if (perm) perm.textContent = PERM_UI[task.permission] || PERM_UI["workspace-write"];
  const vf = $("#contractVerify");
  if (vf) vf.textContent = VERIFY_UI[task.verify] || VERIFY_UI.strict;
  const chips = STEPS.map((step, i) => {
    const status = task.steps[step.id];
    // 分派完成后把执行模型写进标签：用户关心的「是谁在干」当场可见
    const extra = step.id === "route" && task.model ? ` · ${task.model}` : "";
    const sep = i ? '<span class="step-sep">›</span>' : "";
    return `${sep}<span class="step-chip ${status}"><b>${mark(status)}</b>${step.label}${esc(extra)}</span>`;
  }).join("");
  const elapsed = (task.endedAt || Date.now()) - task.startedAt;
  // 内部路由签名不再裸露（截屏 11 事故）：翻译成策略徽章，原文只在 hover title 里
  const routePill = task.reason
    ? `<span class="route-pill" title="${esc(task.reason)}">⚡ ${esc(translateReason(task.reason))}</span>`
    : "";
  strip.innerHTML = `${chips}<span class="pipe-reason">${fmt(elapsed)}</span>${routePill}`;
}

/* ============================== 事件 → 四步状态 ============================== */

function onEvent(ev) {
  if (!task || !ev || typeof ev !== "object") return;
  const kind = String(ev.kind || "");
  if (kind === "analyze") task.steps.intent = "done";
  if (kind === "plan" || kind === "multi") {
    task.steps.intent = "done";
    if (task.steps.route === "pending") task.steps.route = "run";
  }
  if (kind === "route") {
    task.steps.intent = "done";
    task.steps.route = "done";
    if (ev.model) task.model = String(ev.model);
    if (ev.reason) task.reason = String(ev.reason);
    if (task.steps.execute === "pending") task.steps.execute = "run";
  }
  if (kind === "execute") {
    task.steps.route = "done";
    task.steps.execute = ev.success === false ? "warn" : "done";
    if (ev.model) task.model = String(ev.model);
    // verified 是路由插件的质检结论：false 明确表示「没通过/没验」，不能画成通过
    if (ev.verified === true) task.steps.verify = "done";
    else if (ev.verified === false) task.steps.verify = task.steps.verify === "done" ? "done" : "skip";
    if (task.steps.verify === "pending") task.steps.verify = "run";
  }
  if (kind === "verify") task.steps.verify = ev.pass ? "done" : "warn";
  if (kind === "retry") {
    task.steps.execute = "run";
    task.steps.verify = "pending";
  }
  if (kind === "request-error") {
    if (task.steps.execute === "run") task.steps.execute = "warn";
  }
  if (kind === "idle") {
    finish();
    return;
  }
  render();
  refreshDiff();
}

function finish() {
  if (!task || task.endedAt) return;
  task.endedAt = Date.now();
  for (const step of STEPS) {
    const status = task.steps[step.id];
    if (status === "run") task.steps[step.id] = "done";
    if (status === "pending") task.steps[step.id] = "skip";
  }
  closeChannels();
  clearInterval(task.ticker);
  task.ticker = null;
  render();
  refreshDiff(true);
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* 隐私模式：不影响本轮展示 */
  }
}

/* ============================== 通道：SSE → 轮询回退 ============================== */

function closeChannels() {
  if (!task) return;
  try {
    task.stream?.close?.();
  } catch {
    /* 已关闭 */
  }
  task.stream = null;
  if (task.poll) clearInterval(task.poll);
  task.poll = null;
}

function startPoll() {
  if (!task || task.poll) return;
  let offset = ""; // 空：服务端从当前文件末尾起读，不回放历史
  const tick = async () => {
    if (!task) return;
    try {
      const query = offset ? `?offset=${encodeURIComponent(offset)}` : "";
      const data = await api(`/api/task-events${query}`);
      if (typeof data.offset === "number") offset = data.offset;
      for (const ev of data.events || []) onEvent(ev);
    } catch {
      /* 控制中心不可达：下个周期重试（不假装有进度） */
    }
  };
  task.poll = setInterval(tick, 2500);
}

function openStream() {
  if (typeof EventSource !== "function") {
    startPoll();
    return;
  }
  try {
    const es = new EventSource("/api/task-stream");
    task.stream = es;
    es.addEventListener("perf", (msg) => {
      try {
        onEvent(JSON.parse(msg.data));
      } catch {
        /* 坏行忽略 */
      }
    });
    // EventSource 自带重连，但重连会从文件末尾续读、丢掉断线窗口；这里直接切成轮询，
    // 保证「断线期间的事件也能补上」，代价只是 2.5s 粒度。
    es.addEventListener("error", () => {
      try {
        es.close();
      } catch {
        /* ignore */
      }
      if (task && task.stream === es) task.stream = null;
      if (task && !task.endedAt) startPoll();
    });
  } catch {
    startPoll();
  }
}

/* ============================== 本轮改动（TASK DIFF） ============================== */

async function refreshDiff(force = false) {
  if (!task) return;
  const now = Date.now();
  if (!force && now - (task.diffAt || 0) < 3000) return;
  task.diffAt = now;
  const btn = $("#btnTaskDiff");
  try {
    const snap = await api("/api/shadow/status");
    const files = Array.isArray(snap.files) ? snap.files : [];
    if (!files.length) {
      if (btn) btn.hidden = true;
      return;
    }
    if (btn) {
      btn.hidden = false;
      btn.innerHTML = `改动 ${files.length} · <i>+${snap.insertions}</i> <b>−${snap.deletions}</b>`;
      btn.title = files.map((f) => f.path).join("\n");
    }
  } catch {
    if (btn) btn.hidden = true;
  }
}

/* ============================== 生命周期 ============================== */

function save() {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ label: task.label, at: task.startedAt, permission: task.permission, verify: task.verify }),
    );
  } catch {
    /* 隐私模式：跳过持久化 */
  }
}

/** 派发即开始：清掉上一轮、重置四步、打开通道并起秒表。
 *  meta 携带发射器前置选择（permission / verify），整个执行期只读回显。 */
export function startTask(label, meta = {}) {
  stopTask();
  task = {
    label: String(label || ""),
    startedAt: Date.now(),
    endedAt: 0,
    steps: blankSteps(),
    model: "",
    reason: "",
    permission: String(meta.permission || "workspace-write"),
    verify: String(meta.verify || "strict"),
    revisions: [], // 版本演进（v2/v3…）：中途干预不新建任务，在契约栏原地演进
    stream: null,
    poll: null,
    ticker: null,
    diffAt: 0,
  };
  save();
  render();
  openStream();
  task.ticker = setInterval(render, 500);
  refreshDiff(true);
}

/** 版本演进（2026-11-02）：中途微调/追问是同一任务的 v2、v3——不新建左栏任务、
 *  不冲掉原结果。契约栏目标旁出现修订徽章，修订前的现场已由影子快照留档。 */
export function noteRevision(text) {
  if (!task) return 0;
  task.revisions.push(String(text || "").slice(0, 80));
  save();
  render();
  return task.revisions.length + 1;
}

/** 本轮是否存在任务（跑着或已收尾都算）：agent.syncStage 依据它决定
 *  执行态显示引擎实况 iframe 还是壳层自己的待命态——本轮没任务时
 *  DSH 里只会是空会话/起始页，不值得展示。 */
export function isTaskActive() {
  return Boolean(task);
}

/** 结束/离开执行态：关通道、停秒表（不清空已渲染的胶囊，便于回看结论）。 */
export function stopTask(clear = false) {
  if (!task) return;
  closeChannels();
  clearInterval(task.ticker);
  task.ticker = null;
  if (clear) {
    task = null;
    const strip = $("#pipeStrip");
    if (strip) strip.innerHTML = "";
    const dot = $("#contractDot");
    if (dot) dot.className = "task-dot";
    const goal = $("#contractGoal");
    if (goal) goal.textContent = "—";
    const btn = $("#btnTaskDiff");
    if (btn) btn.hidden = true;
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}

/** 刷新页面后恢复：把本轮开始之后已经发生的埋点补进四步状态，再接上实时通道。 */
export async function resumeTask() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
  } catch {
    saved = null;
  }
  if (!saved || !saved.at || Date.now() - saved.at > 2 * 60 * 60 * 1000) return false;
  task = {
    label: String(saved.label || ""),
    startedAt: Number(saved.at) || Date.now(),
    endedAt: 0,
    steps: blankSteps(),
    model: "",
    reason: "",
    permission: String(saved.permission || "workspace-write"),
    verify: String(saved.verify || "strict"),
    stream: null,
    poll: null,
    ticker: null,
    diffAt: 0,
  };
  let lastAt = 0;
  try {
    const data = await api("/api/workspace");
    const after = task.startedAt;
    const fresh = (row) => row && row.at && Date.parse(row.at) >= after;
    const replay = (rows, kind) => {
      for (const row of rows || []) {
        if (!fresh(row)) continue;
        lastAt = Math.max(lastAt, Date.parse(row.at) || 0);
        onEvent({ ...row, kind });
      }
    };
    replay(data.routes, "route");
    replay(data.executes, "execute");
    replay(data.verifies, "verify");
  } catch {
    /* 控制中心不可达：只显示秒表，不编造步骤 */
  }
  // 已经写过 execute 就说明上一轮结束了（路由插件每轮末尾必落一条终局 execute）：
  // 按最后一帧收尾，不开通道也不留一个永远在走的秒表。
  if (task.steps.execute === "done" || task.steps.execute === "warn") {
    task.endedAt = lastAt || Date.now();
    render();
    return true;
  }
  if (task && !task.endedAt) {
    task.ticker = setInterval(render, 500);
    openStream();
    refreshDiff(true);
  }
  render();
  return true;
}

/* ============================== 事件绑定 ============================== */

$("#btnTrace").onclick = () => {
  openDrawer("#traceCard");
  refreshTrace().catch(() => {});
};
$("#btnTaskDiff").onclick = () => {
  openDrawer("#shadowCard");
  refreshShadow().catch(() => {});
};
// 契约栏「■ 中止」：与左栏「停止 Agent」同一条路（确认弹窗在 agent.js）
$("#btnAbortTask").onclick = () => stopAgent();

// 首帧：执行态里还没派发过任务时，给一条说明而不是空白任务栏
render();
