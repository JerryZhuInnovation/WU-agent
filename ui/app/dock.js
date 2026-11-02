/* WU ai · 控制中心 —— 执行态产物柜（自适应）+ 内联干预栏（依赖 dom, doctor, shadow, pipeline）

   产物柜 = 沙箱影子快照的常驻视图（数据源与抽屉 TASK DIFF 同一条 /api/shadow/status）：
     · 文件清单 + 增删行数，点行 = 打开抽屉看该文件 diff；可预览类型给「实时预览」；
   干预栏 = 把一句话注入正在跑的对话面（postMessage 跨源投递，client.ts 监听后填入并发送）。
   版本演进：干预是同一任务的 v2/v3——契约栏原地演进 + 修订前现场打快照留档。
*/
import { $, api, esc, toast } from "./dom.js";
import { openDrawer } from "./doctor.js";
import { showFileDiff } from "./shadow.js";
import { noteRevision } from "./pipeline.js";

const PREVIEWABLE_RE = /\.(html?|svg|png|jpe?g|webp|gif|md|txt)$/i;

function renderDock(data) {
  const list = $("#dockList");
  if (!list) return;
  const files = Array.isArray(data?.files) ? data.files : [];
  // Zero-Empty-State：产物柜只在真有文件改动时出现，其余时候整栏退场
  document.body.classList.toggle("has-artifacts", files.length > 0);
  const tag = $("#dockTag");
  if (tag) {
    tag.textContent = files.length ? `${files.length} 文件 · +${data.insertions ?? 0} −${data.deletions ?? 0}` : "—";
  }
  if (!files.length) {
    list.innerHTML = `<div class="rail-empty">还没有产物改动。Agent 写文件后这里实时更新。</div>`;
    return;
  }
  list.innerHTML = files
    .map(
      (f) =>
        `<button class="dock-row" data-path="${esc(f.path)}" title="${esc(f.path)}">` +
        `<span class="dk-path">${esc(f.path)}</span>` +
        (PREVIEWABLE_RE.test(f.path) ? `<span class="dk-preview" data-preview="${esc(f.path)}" title="原地实时预览">👁</span>` : "") +
        `<span class="dk-num"><i>+${f.insertions ?? 0}</i><b>−${f.deletions ?? 0}</b></span></button>`,
    )
    .join("");
}

export async function refreshDock() {
  try {
    renderDock(await api("/api/shadow/status"));
  } catch {
    /* 控制中心不可达：保持现状，不假装有产物 */
  }
}

/* 中途干预：壳层（3780）与对话面（3080）跨源，只能走 postMessage；
   对话面没起来时明确告知，而不是把话吞掉。
   版本演进：干预记为当前任务的 vN（契约栏原地演进），修订前现场打快照留档。 */
async function steer() {
  const input = $("#steerInput");
  const text = String(input?.value || "").trim();
  if (!text) return;
  const win = $("#agentFrame")?.contentWindow;
  if (!win) {
    toast("对话面还没就绪，稍等再注入", "err");
    return;
  }
  win.postMessage({ type: "wu:steer", text }, "*");
  input.value = "";
  const rev = noteRevision(text);
  try {
    await api("/api/shadow/snapshot", {
      method: "POST",
      body: JSON.stringify({ label: `修订 v${rev}：${text.slice(0, 40)}` }),
    });
  } catch {
    /* 修订快照失败不影响注入 */
  }
  toast(`已注入当前任务（v${rev} 演进已留档）`, "ok");
}

/* 产物原地预览：html/svg 进沙箱 iframe（allow-scripts），图片直出 <img>。 */
let previewBox = null;

function closePreview() {
  previewBox?.remove();
  previewBox = null;
}

function openPreview(path) {
  closePreview();
  const isImg = /\.(svg|png|jpe?g|webp|gif)$/i.test(path);
  previewBox = document.createElement("div");
  previewBox.className = "preview-modal";
  previewBox.innerHTML =
    `<div class="preview-card">` +
    `<div class="preview-hdr"><span>👁 ${esc(path)}</span>` +
    `<span class="preview-acts"><button class="btn sm" data-open>新标签打开</button>` +
    `<button class="btn ghost sm" data-close>关闭</button></span></div>` +
    (isImg
      ? `<img class="preview-body" src="/api/sandbox/raw?path=${encodeURIComponent(path)}" alt="">`
      : `<iframe class="preview-body" src="/api/sandbox/raw?path=${encodeURIComponent(path)}" sandbox="allow-scripts" title="产物预览"></iframe>`) +
    `</div>`;
  document.body.appendChild(previewBox);
  previewBox.addEventListener("click", (ev) => {
    if (ev.target === previewBox || ev.target.closest?.("[data-close]")) closePreview();
    if (ev.target.closest?.("[data-open]")) {
      window.open(`/api/sandbox/raw?path=${encodeURIComponent(path)}`, "wu-preview");
    }
  });
}

$("#dockList").addEventListener("click", (ev) => {
  const prev = ev.target?.closest?.("[data-preview]");
  if (prev) {
    ev.stopPropagation();
    openPreview(prev.getAttribute("data-preview") || "");
    return;
  }
  const row = ev.target?.closest?.("[data-path]");
  if (!row) return;
  openDrawer("#shadowCard");
  showFileDiff(row.getAttribute("data-path")).catch(() => {});
});
$("#btnDockRefresh").onclick = () => refreshDock();
$("#btnSteer").onclick = steer;
$("#steerInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.isComposing) steer();
});

// 执行态轻轮询：只刷产物清单（流水线进度归 pipeline 的 SSE 通道，不重复建通道）。
// 启动时也刷一次：has-artifacts 状态要尽早确定（产物柜显示与否）。
refreshDock();
setInterval(() => {
  if (document.body.classList.contains("view-active")) refreshDock();
}, 4000);
