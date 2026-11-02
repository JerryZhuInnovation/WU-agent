/* WU ai · 控制中心 —— 右栏运行轨迹（RUN TRACE）
   对话页胶囊上的「查看轨迹」经 postMessage 打开本抽屉，并把最近四步原始记录列出来。
   数据来源：/api/workspace（perf.jsonl 聚合，不伪造）。 */

import { $, api, esc } from "./dom.js";
import { openDrawer } from "./doctor.js";

const STAGE = { route: "模型分派", execute: "执行", verify: "沙箱核验", plan: "规划", retry: "重试" };

function hhmm(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function rowsOf(d) {
  const rows = [];
  for (const r of d.routes || []) {
    rows.push({
      at: r.at,
      stage: "route",
      who: [r.capability, r.model].filter(Boolean).join(" → ") || "—",
      detail: r.reason || "",
      result: "",
    });
  }
  for (const e of d.executes || []) {
    rows.push({
      at: e.at,
      stage: "execute",
      who: e.model || e.capability || "—",
      detail: e.capability || "",
      result: `${e.success ? "成功" : "失败"} · ${e.latencyMs ?? "?"}ms${e.verified ? " · 已验证" : ""}`,
    });
  }
  for (const v of d.verifies || []) {
    rows.push({
      at: v.at,
      stage: "verify",
      who: v.score == null ? "质检" : `评分 ${v.score}`,
      detail: v.gaps || "",
      result: v.pass ? "通过" : "未通过",
    });
  }
  return rows
    .filter((r) => r.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 12);
}

function renderTrace(d) {
  const rows = rowsOf(d || {});
  const list = $("#traceList");
  $("#traceTag").textContent = rows.length ? `最近 ${rows.length} 条` : "暂无";
  if (!rows.length) {
    list.innerHTML = `<div class="pulse-row"><span class="p-main dim">还没有执行埋点——运行一个任务后这里会出现四步原始记录。</span></div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (r) => `<div class="trace-row">
        <span class="tr-time">${hhmm(r.at)}</span>
        <span class="tr-stage">${STAGE[r.stage] || r.stage}</span>
        <span class="tr-who">${esc(r.who)}</span>
        <span class="tr-result">${esc(r.result)}</span>
        <span class="tr-detail">${esc(r.detail)}</span>
      </div>`,
    )
    .join("");
}

async function refreshTrace() {
  try {
    const d = await api("/api/workspace");
    renderTrace(d);
  } catch (e) {
    $("#traceTag").textContent = "读取失败";
    $("#traceList").innerHTML = `<div class="pulse-row"><span class="p-main dim">${esc(e.message || "")}</span></div>`;
  }
}

$("#btnTraceRefresh").onclick = () => refreshTrace().catch(() => {});

// 对话页胶囊 → 壳层：打开抽屉并滚到轨迹卡
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("message", (ev) => {
    const type = ev?.data?.type;
    if (type !== "wu:open-trace") return;
    openDrawer();
    refreshTrace()
      .then(() => $("#traceCard")?.scrollIntoView({ behavior: "smooth", block: "start" }))
      .catch(() => {});
  });
}

export { refreshTrace, renderTrace };
