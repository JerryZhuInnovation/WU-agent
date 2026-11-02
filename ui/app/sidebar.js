/* WU ai · 控制中心 —— 左栏：近期任务（影子快照链）

   数据源是本机真实状态，没有数据就显示空状态：
     · GET /api/tasks  → 快照链（每次派发前一个），附带该次任务的改动统计。

   交互：点任务 = 在抽屉 TASK DIFF 里只读回看那一次任务改了什么。
*/
import { $, api, esc } from "./dom.js";
import { refreshShadow, showSnapshot } from "./shadow.js";

let activeCommit = "";
let tasks = [];

function hhmm(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ============================== 近期任务 ============================== */

function renderTasks(data) {
  const list = $("#taskList");
  if (!list) return;
  const snaps = Array.isArray(data?.snapshots) ? data.snapshots : [];
  tasks = snaps;
  const rows = [];

  // 投递箱里还没被对话页取走的任务：显示为「排队中」，不冒充历史。
  // 状态同步：若同名任务已有完成快照，说明投递箱里是陈旧残留——不再卡「排队中」。
  const doneLabels = new Set(snaps.map((s) => String(s.label || "")));
  const pending = data?.pending;
  if (pending?.text && !doneLabels.has(String(pending.text).slice(0, 60))) {
    rows.push(
      `<div class="task-item"><span class="ti-name">${esc(pending.text)}</span>` +
        `<span class="ti-meta"><span>排队中 · 等对话页取走</span></span></div>`,
    );
  }
  for (const snap of snaps) {
    const diff = snap.fileCount
      ? `<i>+${snap.insertions}</i><b>−${snap.deletions}</b>`
      : `<span>无改动</span>`;
    rows.push(
      `<button class="task-item${activeCommit === snap.commit ? " active" : ""}" data-commit="${esc(snap.commit)}" title="${esc(snap.label || "")}">` +
        `<span class="ti-name">${esc(snap.label || "未命名任务")}</span>` +
        `<span class="ti-meta"><span>${hhmm(snap.at)}</span>${diff}</span></button>`,
    );
  }
  list.innerHTML = rows.length
    ? rows.join("")
    : `<div class="rail-empty">还没有任务。派发第一个任务时会自动打影子快照。</div>`;
}

export async function refreshTasks() {
  try {
    renderTasks(await api("/api/tasks"));
  } catch (e) {
    const list = $("#taskList");
    if (list) list.innerHTML = `<div class="rail-empty">读不到任务历史：${esc(e.message || "")}</div>`;
  }
}

/* ============================== 事件绑定 ============================== */

function setActiveTask(commit) {
  activeCommit = commit;
  for (const el of document.querySelectorAll(".task-item[data-commit]")) {
    el.classList.toggle("active", el.getAttribute("data-commit") === commit);
  }
}

$("#btnTasksRefresh").onclick = () => refreshTasks().catch(() => {});

$("#taskList").addEventListener("click", (ev) => {
  const btn = ev.target?.closest?.("[data-commit]");
  if (!btn) return;
  const commit = btn.getAttribute("data-commit") || "";
  const snap = tasks.find((s) => s.commit === commit);
  setActiveTask(commit);
  showSnapshot(snap || { commit });
  refreshShadow().catch(() => {});
});

