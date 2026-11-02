/* WU ai · 控制中心 —— 影子快照（Task Diff）：本次任务改了哪些文件 / 看 diff / 一键撤销
   后端 server/shadow.py：工作区内隐藏 Git（.wu-shadow-git），派发任务前自动快照。 */

import { $, api, confirmAsync, esc, toast } from "./dom.js";

let snap = { snapshot: null, files: [], insertions: 0, deletions: 0 };
/** 只读的历史任务（左栏「近期任务」点开）：非空时卡片切到回看模式，禁止回滚。 */
let historyTask = null;

function renderShadow() {
  const tag = $("#shadowTag");
  const stat = $("#shadowStat");
  const list = $("#shadowList");
  const rollbackBtn = $("#btnShadowRollback");

  if (historyTask) {
    const files = Array.isArray(historyTask.files) ? historyTask.files : [];
    const when = historyTask.at ? String(historyTask.at).slice(5, 16).replace("T", " ") : "";
    tag.textContent = `历史 ${String(historyTask.commit || "").slice(0, 7)}`;
    stat.innerHTML = `只读回看：${esc(historyTask.label || "未命名任务")} · ${esc(when)}${
      files.length ? ` · ${files.length} 个文件` : " · 无文件改动"
    } <button class="mbtn" id="btnShadowBack">回到当前改动</button>`;
    list.innerHTML = files.length
      ? files
          .map(
            (f) => `<div class="shadow-row">
        <button class="shadow-file" data-path="${esc(f.path)}" data-commit="${esc(historyTask.commit || "")}" data-until="${esc(historyTask.until || "")}" title="查看 Diff">
          <span class="sf-path">${esc(f.path)}</span>
          <span class="sf-num"><i>+${f.insertions}</i><b>−${f.deletions}</b></span>
        </button>
      </div>`,
          )
          .join("")
      : `<div class="pulse-row"><span class="p-main dim">这次任务没有留下文件改动</span></div>`;
    rollbackBtn.disabled = true;
    $("#btnShadowBack")?.addEventListener("click", () => {
      historyTask = null;
      refreshShadow().catch(() => {});
    });
    return;
  }

  const files = Array.isArray(snap.files) ? snap.files : [];
  tag.textContent = snap.snapshot ? `快照 ${String(snap.snapshot).slice(0, 7)}` : "—";
  stat.textContent = !snap.snapshot
    ? "还没有任务快照：派发第一个任务时会自动打点"
    : files.length
      ? `本次任务改动 ${files.length} 个文件 · +${snap.insertions} −${snap.deletions}`
      : "与上次快照一致，没有文件改动";
  list.innerHTML = files
    .map(
      (f) => `<div class="shadow-row">
        <button class="shadow-file" data-path="${esc(f.path)}" title="查看 Diff">
          <span class="sf-path">${esc(f.path)}</span>
          <span class="sf-num"><i>+${f.insertions}</i><b>−${f.deletions}</b></span>
        </button>
        <span class="shadow-acts">
          <button class="mbtn" data-keep="${esc(f.path)}">保留</button>
          <button class="mbtn danger" data-undo="${esc(f.path)}">撤销</button>
        </span>
      </div>`,
    )
    .join("");
  rollbackBtn.disabled = files.length === 0;
}

async function showDiff(path, commit, until) {
  const box = $("#shadowDiff");
  try {
    const r = await api("/api/shadow/diff", {
      method: "POST",
      body: JSON.stringify({ path, commit: commit || "", to: until || "" }),
    });
    if (!r.ok) {
      toast(r.message || "读不到 diff", "err");
      return;
    }
    box.hidden = false;
    box.textContent = r.diff || "（无文本差异，可能是二进制文件）";
    box.scrollIntoView({ block: "nearest" });
  } catch (e) {
    toast(e.message || "读不到 diff", "err");
  }
}

/** 单个文件撤销：只回退这一个路径。 */
async function rollbackOne(path) {
  const ok = await confirmAsync({
    title: "撤销该文件改动",
    message: `将把 ${path} 还原到本次任务开始前。\n回滚前的现场会自动备份，万一误删可从备份找回。`,
    ok: "撤销",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api("/api/shadow/rollback", { method: "POST", body: JSON.stringify({ files: [path] }) });
    toast(r.ok ? `已撤销 ${path}` : r.message || "撤销失败", r.ok ? "ok" : "err");
    await refreshShadow();
  } catch (e) {
    toast(e.message || "撤销失败", "err");
  }
}

/** 单个文件确认保留：并入快照链，不再列为待处理。 */
async function keepOne(path) {
  try {
    const r = await api("/api/shadow/accept", { method: "POST", body: JSON.stringify({ files: [path] }) });
    toast(r.ok ? `已保留 ${path}` : r.message || "保留失败", r.ok ? "ok" : "err");
    await refreshShadow();
  } catch (e) {
    toast(e.message || "保留失败", "err");
  }
}

async function refreshShadow() {
  if (historyTask) return; // 回看历史任务期间不要被抽屉的自动刷新顶掉
  try {
    snap = await api("/api/shadow/status");
    renderShadow();
  } catch (e) {
    $("#shadowStat").textContent = `读不到快照：${e.message || ""}`;
  }
}

/** 左栏「近期任务」→ 只读回看某一次任务改了什么（不回滚，避免误伤当前工作区）。 */
export function showSnapshot(task) {
  historyTask = task && task.commit ? task : null;
  $("#shadowDiff").hidden = true;
  renderShadow();
}

/** 左栏文件树点文件：先回到「当前改动」，再展示该文件相对快照的 diff。 */
export async function showFileDiff(path) {
  historyTask = null;
  await refreshShadow();
  await showDiff(path);
}

async function rollbackShadow() {
  const n = (snap.files || []).length;
  if (!n) return;
  const ok = await confirmAsync({
    title: "撤销本次任务改动",
    message: `将把 ${n} 个文件还原到派发任务前的状态，本次新建的文件会被删除。\n撤销前会自动备份当前现场（含你在工作区的手动修改），误删可找回。确认继续？`,
    ok: "撤销",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api("/api/shadow/rollback", { method: "POST", body: "{}" });
    if (!r.ok) {
      toast(r.message || "撤销失败", "err");
      return;
    }
    toast(`已撤销：还原 ${r.restored.length} 个 · 删除 ${r.removed.length} 个${r.backup ? "（现场已备份）" : ""}`, "ok");
    $("#shadowDiff").hidden = true;
    await refreshShadow();
  } catch (e) {
    toast(e.message || "撤销失败", "err");
  }
}

$("#btnShadowRefresh").onclick = () => refreshShadow().catch(() => {});
$("#btnShadowRollback").onclick = () => rollbackShadow().catch(() => {});
$("#shadowList").addEventListener("click", (ev) => {
  const target = ev.target;
  if (!target || typeof target.closest !== "function") return;
  const undo = target.closest("[data-undo]");
  if (undo) {
    rollbackOne(undo.getAttribute("data-undo") || "").catch(() => {});
    return;
  }
  const keep = target.closest("[data-keep]");
  if (keep) {
    keepOne(keep.getAttribute("data-keep") || "").catch(() => {});
    return;
  }
  const file = target.closest("[data-path]");
  if (file) {
    showDiff(
      file.getAttribute("data-path") || "",
      file.getAttribute("data-commit") || "",
      file.getAttribute("data-until") || "",
    ).catch(() => {});
  }
});

// 抽屉打开即刷新（低频操作，不在主屏轮询）
const drawer = $("#drawer");
if (typeof MutationObserver !== "undefined") {
  new MutationObserver(() => {
    if (!drawer.hidden) refreshShadow().catch(() => {});
  }).observe(drawer, { attributes: true, attributeFilter: ["hidden"] });
}

export { refreshShadow, renderShadow };
