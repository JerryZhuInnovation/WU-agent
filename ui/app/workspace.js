/* WU ai · 控制中心 —— 抽屉数据面：工作流模板 / 风险审计（依赖 dom, state）
   发射台的快捷模板来自这里；执行态的四步流水线在 pipeline.js（走 SSE，不走本模块）。 */
import { $, esc, toast } from "./dom.js";
import { state } from "./state.js";
import { renderOmniTemplates } from "./omni.js";

/* 工作流模板：列表 + 内联新建/删除（执行入口在对话页工作台面板）。 */
function renderWorkflows(items) {
  state.workflows = Array.isArray(items) ? items : [];
  $("#wfCount").textContent = `${state.workflows.length} 个模板`;
  const list = $("#wfList");
  list.innerHTML = state.workflows.length
    ? state.workflows
        .map(
          (w) =>
            `<div class="pulse-row"><span class="p-dot"></span><span class="p-main">${esc(w.name)}<em>${esc(
              (w.goal || "").slice(0, 60),
            )}</em></span><button class="btn ghost sm" data-wf-del="${esc(w.id)}">删除</button></div>`,
        )
        .join("")
    : `<div class="pulse-row"><span class="p-main dim">还没有模板</span></div>`;
  renderOmniTemplates();
}

/* 风险审查与预算（P1-5/6/7）：/api/workspace 的 risk/budget 段。
 * 审计链断裂必须显眼——它是「审计是否可信」的唯一信号；污点会话的
 * 外传拦截也在这里留痕。 */
function renderRisk(d) {
  const tag = $("#riskTag");
  const stat = $("#riskStat");
  const list = $("#riskList");
  const foot = $("#riskFoot");
  const risk = d && d.risk;
  const budget = d && d.budget;
  if (!risk || !risk.available) {
    tag.textContent = "待命";
    stat.textContent = "还没有风险审查记录";
    list.innerHTML = "";
    foot.textContent = "";
    return;
  }
  const c = risk.counts || {};
  const chainOk = risk.chain && risk.chain.ok;
  tag.textContent = `审计 ${risk.total} 条`;
  stat.innerHTML =
    `拦截 ${c.DENY || 0} · 待确认 ${c.ASK || 0} · 放行 ${c.ALLOW || 0} · ` +
    (chainOk
      ? `<span class="dim">审计链完好（尾部 ${risk.chain.checked} 条已验证）</span>`
      : `<span class="risk-bad">审计链在第 ${(risk.chain ? risk.chain.brokenAt : 0) + 1} 行断裂，疑似被篡改</span>`);
  list.innerHTML = risk.recent
    .map((r) => {
      const when = (r.at || "").slice(11, 16);
      const badge = r.decision === "DENY" ? "deny" : r.decision === "ASK" ? "ask" : r.decision === "ALLOW" ? "allow" : "";
      const dot = r.decision === "DENY" ? "bad" : r.decision === "ALLOW" ? "ok" : "warn";
      return `<div class="pulse-row"><span class="p-dot ${dot}"></span>
        <span class="p-main"><span class="risk-badge ${badge}">${esc(r.decision || "?")}</span>${esc(r.tool || "")}<em>${when} · ${esc(
        r.by || "",
      )}${r.tainted ? " · 污点会话" : ""}${r.reason ? ` · ${esc(r.reason)}` : ""}</em></span></div>`;
    })
    .join("");
  // 会话预算：只有活跃会话才显示（没有会话时摆一行 0 不如空着）
  if (budget && budget.available && budget.sessions && budget.sessions.length) {
    foot.textContent = `会话预算 · ${budget.sessions
      .map(
        (s) =>
          `${String(s.session).slice(0, 8)}… ${s.calls}/${budget.limits && budget.limits.toolCalls != null ? budget.limits.toolCalls : "?"} 次调用` +
          (s.tripped && s.tripped.length ? ` · 已熔断(${s.tripped.join("/")})` : ""),
      )
      .join("；")}`;
  } else {
    foot.textContent = "";
  }
}

export async function refreshWorkspaceCards() {
  try {
    const r = await fetch("/api/workspace", { cache: "no-store" });
    const d = r.ok ? await r.json() : null;
    renderRisk(d);
  } catch {
    renderRisk(null);
  }
  try {
    const r = await fetch("/api/workflows", { cache: "no-store" });
    renderWorkflows((await r.json()).workflows);
  } catch {
    renderWorkflows([]);
  }
}

/* ============================== 事件绑定 ============================== */

$("#btnWfNew").onclick = () => {
  $("#wfForm").hidden = false;
  $("#wfName").focus();
};
$("#btnWfCancel").onclick = () => {
  $("#wfForm").hidden = true;
};
$("#btnWfSave").onclick = async () => {
  const workflow = {
    name: $("#wfName").value.trim(),
    goal: $("#wfGoal").value.trim(),
    steps: $("#wfSteps").value.trim(),
    gate: $("#wfGate").value.trim(),
    output: $("#wfOutput").value.trim(),
  };
  if (!workflow.name || !workflow.goal) {
    toast("名称与目标为必填", "err");
    return;
  }
  try {
    const r = await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", workflow }),
    });
    const d = await r.json();
    if (d.ok) {
      $("#wfForm").hidden = true;
      ["wfName", "wfGoal", "wfSteps", "wfGate", "wfOutput"].forEach((id) => ($(`#${id}`).value = ""));
      await refreshWorkspaceCards();
      toast("模板已保存");
    } else toast(d.message || "保存失败", "err");
  } catch (e) {
    toast(e.message, "err");
  }
};
$("#wfList").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-wf-del]");
  if (!btn) return;
  try {
    await fetch("/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id: btn.dataset.wfDel }),
    });
    await refreshWorkspaceCards();
  } catch (e) {
    toast(e.message, "err");
  }
});

export { renderWorkflows };
