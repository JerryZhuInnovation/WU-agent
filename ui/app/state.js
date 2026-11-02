/* WU ai · 控制中心 —— 全局状态、徽章与标签（依赖 dom）
   本模块是唯一持有 state 的地方；数据刷新通过事件总线通知各渲染域，
   避免模块间互相 import 成环。
*/
import { $, api, toast } from "./dom.js";

export const state = {
  models: [],
  capabilities: [],
  prefer: {},
  workflows: [],
  defaultModelId: "",
  analyzerModelId: "",
  dsh: null,
  node: null,
  workspace: "",
  sandbox: null,
  sandboxPolicy: null,
  credentialProxy: null,
  hardware: null,
};

let badgeOverride = null; // 运行控制期间的临时状态，结束后回到自动推导

/* 用途（能力）标签，与后端 CAPABILITIES 保持一致 */
export const USES = [
  { id: "coding", label: "写代码" },
  { id: "vision", label: "看图" },
  { id: "reasoning", label: "推理" },
  { id: "research", label: "调研" },
  { id: "writing", label: "写作" },
  { id: "general", label: "通用" },
];

/* ============================== 事件总线 ============================== */

/** 跨模块事件：目前只有 'catalog'（/api/catalog 数据刷新）一种。 */
const listeners = new Map();

/** @param {string} evt @param {(payload: unknown) => void} fn */
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}

/** @param {string} evt @param {unknown} [payload] */
function emit(evt, payload) {
  for (const fn of listeners.get(evt) || []) {
    try {
      fn(payload);
    } catch {
      /* 单个订阅者故障不影响其他域渲染 */
    }
  }
}

/* ============================== 状态徽章（唯一状态源） ============================== */

function setBadge(kind, text, override = false) {
  if (override) badgeOverride = { kind, text };
  // 顶栏已删除：状态文字收进设置抽屉的 ENVIRONMENT 卡（元素缺失时静默跳过）
  const tx = $("#stateText");
  if (tx) tx.textContent = text;
}

/* 模型核验状态 → 界面文案。state 来自控制中心只读探测（GET {baseURL}/models）：
   ok/auth/error/unknown/missing/local/pending。宁可说「未核验」，绝不假报就绪。 */
const KEY_STATE_UI = {
  ok: { label: "可用", dot: "就绪", tone: "ok" },
  auth: { label: "密钥失效", dot: "失效", tone: "err" },
  error: { label: "连接异常", dot: "异常", tone: "bad" },
  unknown: { label: "未核验", dot: "未核验", tone: "muted" },
  pending: { label: "核验中", dot: "核验中", tone: "muted" },
  missing: { label: "缺 Key", dot: "不可用", tone: "bad" },
  local: { label: "本地", dot: "就绪", tone: "ok" },
};

export function keyState(m) {
  const s = m.keyStatus?.state;
  return KEY_STATE_UI[s] || KEY_STATE_UI.unknown;
}

/** 确定不可用（密钥失效）的模型数——这是要点名给用户看的那一类。 */
export function deadModels() {
  return state.models.filter((m) => m.keyStatus?.state === "auth");
}

/** 可实际派活的执行者：启用，且不是「密钥失效 / 缺 Key」。
 *  选模下拉（Router Brain / 强制模型）只列这一组——避免把已失效的旧模型
 *  继续摆在选项里，看起来像还能用。 */
export function usableModels() {
  return state.models.filter((m) => {
    if (m.enabled === false) return false;
    const s = m.keyStatus?.state;
    return s !== "auth" && s !== "missing";
  });
}

export function refreshBadge() {
  if (badgeOverride) {
    setBadge(badgeOverride.kind, badgeOverride.text);
    return;
  }
  const total = state.models.length;
  const missing = state.models.filter((m) => !m.apiKeyConfigured).length;
  const dead = deadModels().length;
  if (state.dsh?.url) {
    setBadge(dead ? "warn" : "ok",
      dead ? `Agent 运行中 · ${dead} 个模型密钥失效` : `Agent 运行中 · ${total} 模型在线`);
  } else if (dead > 0) {
    setBadge("warn", `⚠ ${dead} 个模型密钥失效`);
  } else if (missing > 0) {
    setBadge("warn", `⚠ ${missing} 个模型缺 Key`);
  } else if (total > 0) {
    setBadge("idle", `就绪 · ${total} 模型在线`);
  } else {
    setBadge("warn", "⚠ 尚未添加模型");
  }
}

export function clearBadgeOverride() {
  badgeOverride = null;
  refreshBadge();
}

export { setBadge };

/* ============================== 共享标签与派生值 ============================== */

/** 用途文本 → 能力声明。
 *  去偏见化（2026-11-01）：**空文本不再默认声明 general 0.85**。
 *  过去每个模型都被标成「通用 85%」，导致任何任务都只能按 general 排序、
 *  三家并列同分，最终由历史样本量决胜 → 所有任务塌缩到先跑过的那个模型
 *  （general 黑洞）。现在不声明就是「不声明」，路由层用品牌中立的性状先验兜底，
 *  用户/控制中心真填了用途才产生显式能力声明。 */
export function parsePrefText(text) {
  const caps = {};
  for (const u of USES) caps[u.id] = 0;
  const t = String(text || "").trim();
  if (!t) return caps;
  const PATS = [
    [/写代码|编程|代码|coding|code|vba/i, "coding"],
    [/看图|视觉|图片|图像|vision|image|ocr|识别/i, "vision"],
    [/推理|数学|逻辑|reasoning|证明/i, "reasoning"],
    [/调研|论文|文献|research|综述/i, "research"],
    [/写作|翻译|文案|writing|translate|报告/i, "writing"],
    [/通用|聊天|对话|general|chat/i, "general"],
  ];
  for (const [re, id] of PATS) {
    if (re.test(t)) caps[id] = 0.9;
  }
  return caps;
}

/** 显式偏好表：只有用户真声明了能力（≥0.5）的模型才进入 prefer。
 *  去偏见化（2026-11-01）：不再把 defaultModelId 注入 prefer.general——
 *  那是「默认模型 = 事实上的点名」，会让评估器绕开客观排序。 */
export function derivePrefer() {
  const prefer = {};
  for (const m of state.models) {
    if (m.enabled === false) continue;
    const caps = m.capabilities || {};
    for (const u of USES) {
      if ((caps[u.id] || 0) >= 0.5) prefer[u.id] = m.id;
    }
  }
  return prefer;
}

export function capLabel(id) {
  const c = state.capabilities.find((x) => x.id === id);
  if (c) return c.label;
  const u = USES.find((x) => x.id === id);
  return u ? u.label : id;
}

/** 选模下拉：只列可用模型；一个都没有时给一条明确的占位，
 *  而不是把已失效的旧模型继续伪装成可选项。 */
export function fillSelect(sel, current) {
  const list = usableModels();
  if (!list.length) {
    sel.innerHTML = `<option value="" disabled selected>无可用模型</option>`;
    return;
  }
  sel.innerHTML =
    list
      .map((m) => `<option value="${escAttr(m.id)}">${escAttr(m.label || m.id)}</option>`)
      .join("") || "";
  sel.value = list.some((m) => m.id === current) ? current : list[0].id;
}

/** 极简转义：下拉里的 id/名称是用户可控文本 */
function escAttr(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 生效的 Router Brain：显式指定优先，否则回退默认模型。
 *  只认可用模型——失效的密钥不该继续当主脑。 */
export function effectiveBrainId() {
  const usable = usableModels();
  if (state.analyzerModelId && usable.some((m) => m.id === state.analyzerModelId)) {
    return state.analyzerModelId;
  }
  if (state.defaultModelId && usable.some((m) => m.id === state.defaultModelId)) {
    return state.defaultModelId;
  }
  return usable[0]?.id || "";
}

/* ============================== 数据刷新 ============================== */

/** 拉取 /api/catalog 并更新 state，然后广播 'catalog' 事件。
 *  各渲染域订阅该事件完成自己的重绘（见 models/doctor/agent 模块）。 */
export async function fetchCatalog() {
  const data = await api("/api/catalog");
  state.models = data.models || [];
  state.capabilities = data.capabilities || [];
  state.prefer = data.prefer || {};
  state.defaultModelId = data.defaultModelId || state.models[0]?.id || "";
  state.analyzerModelId = data.analyzerModelId || "";
  state.node = data.node || null;
  state.sandbox = data.sandbox || null;
  state.sandboxPolicy = data.sandboxPolicy || null;
  state.credentialProxy = data.credentialProxy || null;
  state.workspace = data.workspace || "";
  emit("catalog", data);
  return data;
}

export async function savePrefs(notify = true) {
  // 未显式指定 Brain 时沿用已保存值：下拉为了不留空项会把「回退默认模型」
  // 显示成具体模型名，用户没主动选过时这个值只是展示，不能写进配置。
  let analyzerModelId = state.analyzerModelId;
  const picked = $("#analyzerModelId").value || "";
  if (picked && picked !== effectiveBrainId()) {
    analyzerModelId = picked;
    state.analyzerModelId = picked;
  }
  await api("/api/config", {
    method: "POST",
    body: JSON.stringify({
      prefer: derivePrefer(),
      defaultModelId: state.defaultModelId,
      analyzerModelId,
    }),
  });
  if (notify) toast("已保存", "ok");
}

/** 轻量刷新：只更新模型列表并广播 'models'（pollDsh 就绪前用）。
 *  不走完整 catalog 广播——DSH 尚未就绪时 data.dsh 为 null，会让运行态 UI 复位。
 *  @returns {Promise<object | null>} 成功时返回原始数据（调用方可能需要 dsh 字段） */
export async function refreshModelsOnly() {
  try {
    const data = await api("/api/catalog");
    if (data.models) state.models = data.models;
    emit("models", null);
    return data;
  } catch {
    return null;
  }
}

export async function loadHardware() {
  try {
    const r = await api("/api/hardware");
    state.hardware = r.hardware || null;
  } catch {
    state.hardware = null;
  }
  emit("hardware", null);
}
