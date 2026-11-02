/* WU ai · 控制中心 —— 可审计任务分配（ALLOCATION）
   数据来自 /api/workspace 的 allocation 段（路由插件落盘的 ADR + 表现账本）。
   列表点一条 → 展开五维评分条、规划者分歧、红队质疑、角色责任契约。 */

import { $, esc } from "./dom.js";

let records = [];

const TONE = { ok: "var(--zen, #2ee59d)", warn: "var(--amber, #ffb020)", bad: "var(--red, #ff5c5c)", muted: "var(--text-dim, #888)" };
const DIM_LABELS = [
  ["capabilityMatch", "能力匹配 30%"],
  ["historicalPerf", "历史表现 25%"],
  ["coverageAndDag", "覆盖与依赖 20%"],
  ["costAndLatency", "成本延迟 15%"],
  ["robustness", "鲁棒性 10%"],
];

function hhmm(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);
}

function renderList() {
  const list = $("#allocList");
  $("#allocTag").textContent = records.length ? `最近 ${records.length} 次决策` : "暂无";
  if (!records.length) {
    list.innerHTML = `<div class="pulse-row"><span class="p-main dim">还没有分配决策 —— 复杂任务派发后，盲态双规划与三级评估的结论会落在这里。</span></div>`;
    return;
  }
  list.innerHTML = records
    .map(
      (r, i) => `<div class="pulse-row alloc-row" data-idx="${i}" role="button">
        <span class="p-dot ${r.tone === "ok" ? "ok" : r.tone === "bad" ? "bad" : r.tone === "warn" ? "warn" : ""}"></span>
        <span class="p-main">
          <span class="alloc-badge" style="color:${TONE[r.tone] || TONE.muted}">${esc(r.stateLabel)}</span>
          ${esc(r.taskType || "?")} · ${esc(r.riskLevel || "?")} 风险
          <em>${hhmm(r.at)} · 规划者 ${(r.planners || []).join(" + ") || "—"} · 评分 ${r.totalScore ?? "—"}${
            (r.critiques || []).length ? ` · 红队 ${r.critiques.length} 条` : ""
          }${(r.conflicts || []).length ? ` · 分歧 ${r.conflicts.length}` : ""}${
            r.audit ? (r.audit.finalSuccess ? " · ✓ 已归因" : " · ✗ 已归因") : ""
          }</em>
        </span>
      </div>`,
    )
    .join("");
}

function renderLedger(ledger) {
  const list = $("#ledgerList");
  if (!Array.isArray(ledger) || !ledger.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML =
    `<div class="ledger-h">表现账本（模型 × 任务 × 角色）</div>` +
    ledger
      .map(
        (l) => `<div class="pulse-row"><span class="p-dot ${l.confidence === "RELIABLE" ? "ok" : ""}"></span>
          <span class="p-main">${esc(l.model)} · ${esc(l.taskType)}/${esc(l.role)}
          <em>样本 ${l.sampleSize}（${esc(l.confidence)}）· 通过率 ${l.passRate ?? "—"} · 返工 ${l.reworkRate ?? "—"} · 平滑分 ${l.smoothedScore}</em></span></div>`,
      )
      .join("");
}

function showDetail(r) {
  const box = $("#allocDetail");
  const lines = [];
  lines.push(`决策：${r.stateLabel} — ${r.reason}`);
  if (r.planningMode) lines.push(`规划模式：${r.planningMode === "BLIND_DUAL_PLANNERS" ? "盲态双规划者" : "单规划者 + 规则"}`);
  const dims = r.dimensions || {};
  lines.push("");
  lines.push("五维评分");
  for (const [k, label] of DIM_LABELS) {
    const v = Number(dims[k]);
    lines.push(`  ${label.padEnd(14)} ${Number.isFinite(v) ? "█".repeat(Math.round(v * 10)).padEnd(10, "·") + ` ${v}` : "—"}`);
  }
  if ((r.conflicts || []).length) {
    lines.push("");
    lines.push("规划者分歧");
    r.conflicts.forEach((c) => lines.push(`  · ${c}`));
  }
  if ((r.uncertainties || []).length) {
    lines.push("");
    lines.push("不确定性（样本不足/推测）");
    r.uncertainties.forEach((u) => lines.push(`  · ${u}`));
  }
  if ((r.critiques || []).length) {
    lines.push("");
    lines.push("红队质疑");
    r.critiques.forEach((c) => lines.push(`  · [${c.severity}] ${c.issueType}：${c.evidence}`));
  }
  if ((r.steps || []).length) {
    lines.push("");
    lines.push("角色责任契约");
    r.steps.forEach((s) => {
      lines.push(`  ${s.stepId} [${s.role}] ${s.title} → ${s.model || "未分配"}`);
      if (s.mustDo) lines.push(`    负责：${s.mustDo}`);
      if (s.mustNotDo) lines.push(`    不负责：${s.mustNotDo}`);
      if (s.acceptance?.length) lines.push(`    验收：${s.acceptance.join("；")}`);
    });
  }
  if (r.audit) {
    lines.push("");
    lines.push(`事后归因：${r.audit.finalSuccess ? "成功" : "失败"}${r.audit.failureRootCause ? `（${r.audit.failureRootCause}）` : ""} · 返工 ${r.audit.reworkCount || 0} 次${r.audit.note ? ` · ${r.audit.note}` : ""}`);
  }
  box.textContent = lines.join("\n");
  box.hidden = false;
  box.scrollIntoView({ block: "nearest" });
}

async function refreshAllocation() {
  try {
    const r = await fetch("/api/workspace", { cache: "no-store" });
    const d = await r.json();
    records = Array.isArray(d?.allocation?.records) ? d.allocation.records : [];
    renderList();
    renderLedger(d?.allocation?.ledger);
  } catch {
    $("#allocTag").textContent = "读取失败";
  }
}

$("#btnAllocRefresh").onclick = () => refreshAllocation().catch(() => {});
$("#allocList").addEventListener("click", (ev) => {
  const target = ev.target;
  if (!target || typeof target.closest !== "function") return;
  const row = target.closest(".alloc-row");
  if (!row) return;
  const r = records[Number(row.getAttribute("data-idx"))];
  if (r) showDetail(r);
});

// 抽屉打开即刷新（低频卡，不做主屏轮询）
const drawer = $("#drawer");
if (typeof MutationObserver !== "undefined" && drawer) {
  new MutationObserver(() => {
    if (!drawer.hidden) refreshAllocation().catch(() => {});
  }).observe(drawer, { attributes: true, attributeFilter: ["hidden"] });
}

export { refreshAllocation };
