/* WU ai · 控制中心 —— 环境自检 / 状态胶囊 / 诊断抽屉 / 首次运行（依赖 dom, state） */
import { $, esc, shortPath, toast } from "./dom.js";
import { deadModels, effectiveBrainId, on, savePrefs, state, usableModels } from "./state.js";

/* ============================== 首次运行引导 ============================== */

export function renderFirstRun() {
  const steps = [
    { label: "环境检测", done: true },
    { label: "配置模型", done: usableModels().length > 0 },
    { label: "Router Brain", done: true },
    { label: "启动 Agent", done: Boolean(state.dsh?.url) },
  ];
  const root = $("#frSteps");
  root.innerHTML = "";
  for (const s of steps) {
    const el = document.createElement("span");
    el.className = `step${s.done ? " done" : ""}`;
    el.textContent = s.label;
    root.appendChild(el);
  }
  const done = steps.filter((s) => s.done).length;
  $("#frTag").textContent = done === steps.length ? "已完成" : `${done}/${steps.length} 步骤`;
}

/* ============================== 环境信息 ============================== */

function renderEnv() {
  $("#envWs").textContent = shortPath(state.workspace) || "~/WU-ai-Work";
  const url = state.dsh?.url || "";
  $("#envDsh").textContent = url ? `运行中 · ${url.split("?")[0]}` : "未运行";
  $("#envNode").textContent = state.node?.path
    ? `${shortPath(state.node.path)}（v${state.node.version || "?"}）`
    : "未安装";
  // P2-9 凭据代理状态：代理模式 = DSH/沙箱只见占位符；直连 = 真 Key 在进程内
  const cp = state.credentialProxy;
  $("#envCred").textContent = cp?.active
    ? `代理保护中 · ${cp.providers?.length || 0} 个模型（占位符）`
    : cp
      ? "直连模式（Agent 启动后自动启用代理）"
      : "检测中";
}

/* ============================== 环境自检（wu doctor） ============================== */

function renderDoctor() {
  const lines = [];
  const hw = state.hardware || {};
  if (hw.system) {
    const gpu = hw.gpu?.vendor ? `GPU ${hw.gpu.vendor}` : "无独立 GPU";
    const backend = hw.recommendedBackend ? `后端 ${hw.recommendedBackend}` : "";
    const quant = hw.recommendedQuant ? `量化 ${hw.recommendedQuant}` : "";
    lines.push(`<span class="ok">✓</span> ${esc(hw.system)}/${esc(hw.arch || "?")} · ${esc(hw.ramGb || "?")}GB RAM · ${esc(gpu)} <span class="dim">${esc([backend, quant].filter(Boolean).join(" · "))}</span>`);
  } else {
    lines.push(`<span class="bad">△</span> 硬件信息不可用 <span class="dim">不影响云端模型</span>`);
  }

  const node = state.node;
  lines.push(
    node
      ? `<span class="ok">✓</span> node v${esc(node.version || "?")} <span class="dim">${esc(shortPath(node.path))}</span>`
      : `<span class="bad">△</span> node 未安装 <span class="dim">点下方「安装 Node」</span>`,
  );

  const cloud = state.models.filter((m) => m.access !== "local").length;
  const local = state.models.length - cloud;
  const dead = deadModels();
  const missing = state.models.filter((m) => !m.apiKeyConfigured).length;
  const healthNote = dead.length
    ? `${dead.map((m) => esc(m.label || m.id)).join("、")} 密钥失效，已跳过路由`
    : missing
      ? `${missing} 个缺 Key`
      : "凭证已加密存储";
  lines.push(
    state.models.length
      ? `<span class="${dead.length ? "bad" : "ok"}">${dead.length ? "△" : "✓"}</span> ${state.models.length} 个模型 · ${cloud} 云端 + ${local} 本地 <span class="dim">${healthNote}</span>`
      : `<span class="bad">△</span> 尚未配置模型 <span class="dim">点「+ 添加」</span>`,
  );

  const explicitBrain = state.analyzerModelId && state.models.some((m) => m.id === state.analyzerModelId);
  const brain = state.models.find((m) => m.id === effectiveBrainId());
  // 去偏见化（2026-11-01）：未显式指定 = 中立轮转，不得声称「回退默认模型」，
  // 那等于告诉用户裁判员被永久钉在某一家（品牌锚定）。
  lines.push(
    explicitBrain && brain
      ? `<span class="ok">✓</span> Router Brain · ${esc(brain.label || brain.id)} <span class="dim">${brain.access === "local" ? "本地 · 不联网" : "云端 API"}</span>`
      : `<span class="ok">✓</span> Router Brain <span class="dim">中立轮转 · 各模型轮值（按累计执行最少 + 裁判次数最少）</span>`,
  );

  lines.push(
    `<span class="ok">✓</span> 工作区 ${esc(shortPath(state.workspace) || "~/WU-ai-Work")} <span class="dim">沙箱 workspace-write</span>`,
  );
  // 命令是否真被沙箱约束：以激活版本的 base bundle 为准，不靠文案承诺
  const sb = state.sandbox;
  lines.push(
    sb?.enforced
      ? `<span class="ok">✓</span> 命令执行 · ${esc(sb.provider || "沙箱")} <span class="dim">写限工作区与临时目录 · 读与网络不限制</span>`
      : `<span class="bad">△</span> 命令执行未确认受限 <span class="dim">${esc(sb?.reason || "读取失败")}</span>`,
  );

  // P2-9 凭据代理：Agent 运行中且代理活跃 = DSH 与沙箱只见占位符
  const cp = state.credentialProxy;
  if (cp?.active) {
    lines.push(
      `<span class="ok">✓</span> 凭据代理 · ${cp.providers?.length || 0} 个云端模型 <span class="dim">DSH 与沙箱只见占位符，真 Key 不出控制中心</span>`,
    );
  } else if (state.dsh?.url && cp && !cp.active) {
    lines.push(
      `<span class="bad">△</span> 凭据代理未生效 <span class="dim">DSH 以直连模式启动（真 Key 在 Agent 进程内）；重启 Agent 尝试恢复</span>`,
    );
  }

  const card = $("#doctorCard");
  card.innerHTML = `<div class="boot-title">$ wu doctor</div>`;
  lines.forEach((html, i) => {
    const div = document.createElement("div");
    div.className = "boot-line";
    div.innerHTML = html;
    card.appendChild(div);
    setTimeout(() => div.classList.add("show"), 120 + i * 220);
  });
  renderCapsule();
}

/* ============================== 状态胶囊 + 诊断抽屉 ============================== */

/** 把整段 doctor 压成一行胶囊：只放「硬件 / Node / 沙箱」三件常看的事。
 *  顶栏胶囊已随套娃重构删除，这里只维护 SYSTEM 卡的状态 tag。 */
function renderCapsule() {
  const dead = deadModels().length;
  const missing = state.models.filter((m) => !m.apiKeyConfigured).length;
  $("#sysTag").textContent = state.dsh?.url ? "Agent 运行中" : dead || missing ? "需处理" : "就绪";
}

/** 打开右侧抽屉。传 anchor 时滚到对应卡片（如 "#modelCard" / "#runtimeCard"），
 *  不传则回到顶部——否则上次看轨迹留下的滚动位置会让「模型」「运行时」看起来消失了。 */
export function openDrawer(anchor) {
  $("#drawer").hidden = false;
  $("#scrim").hidden = false;
  document.body.classList.add("drawer-open");
  const body = $("#drawer .drawer-body");
  requestAnimationFrame(() => {
    if (anchor) {
      $(anchor)?.scrollIntoView({ block: "start" });
    } else if (body) {
      body.scrollTop = 0;
    }
  });
}
export function closeDrawer() {
  $("#drawer").hidden = true;
  $("#scrim").hidden = true;
  document.body.classList.remove("drawer-open");
}

/* ============================== 托管沙箱策略（P2-10） ============================== */

function renderPolicy() {
  const p = state.sandboxPolicy;
  if (!p) return;
  const modes = p.allowedModes || [];
  $("#polModeDanger").checked = modes.includes("danger-full-access");
  $("#policyTag").textContent = modes.includes("danger-full-access") ? "danger-full-access 已放行" : "托管基线";
  const b = p.budget || {};
  $("#polCalls").value = b.toolCalls ?? 200;
  $("#polHours").value = Math.round((b.wallClockMs ?? 7200000) / 360000) / 10;
  $("#polFails").value = b.reviewFails ?? 5;
}

async function savePolicy() {
  const policy = {
    allowedModes: ["workspace-write", ...($("#polModeDanger").checked ? ["danger-full-access"] : [])],
    budget: {
      toolCalls: Number($("#polCalls").value) || 200,
      wallClockMs: Math.round((Number($("#polHours").value) || 2) * 3600000),
      reviewFails: Number($("#polFails").value) || 5,
    },
  };
  try {
    const r = await fetch("/api/sandbox-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy }),
    });
    const d = await r.json();
    if (d.ok) {
      state.sandboxPolicy = d.policy;
      renderPolicy();
      toast("策略已保存，即时生效");
    } else {
      toast(d.message || "保存失败", "err");
    }
  } catch (e) {
    toast(e.message, "err");
  }
}

/* ============================== 订阅与事件绑定 ============================== */

on("catalog", () => {
  renderDoctor();
  renderEnv();
  renderFirstRun();
  renderPolicy();
});
on("hardware", renderDoctor);

$("#btnDoctor").onclick = () => openDrawer();
$("#btnDoctor2").onclick = () => openDrawer();
$("#btnSave").onclick = () => savePrefs().catch((e) => toast(e.message, "err"));
$("#btnPolicySave").onclick = () => savePolicy().catch((e) => toast(e.message, "err"));
$("#btnDrawerClose").onclick = closeDrawer;
$("#scrim").onclick = closeDrawer;
if (location.hash === "#doctor") openDrawer();
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("#drawer").hidden) closeDrawer();
});

export { renderEnv, renderCapsule };
