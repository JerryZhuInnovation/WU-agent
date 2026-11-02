/* WU ai · 控制中心 —— 发射台 Omni Command Bar：任务预估路由 / 模板 chips / 派发（依赖 dom, state, agent） */
import { $, api, confirmAsync, esc, toast } from "./dom.js";
import { state, usableModels } from "./state.js";
import { launch, showStage, syncStage } from "./agent.js";
import { startTask, stopTask } from "./pipeline.js";
import { refreshTasks } from "./sidebar.js";
import { openDrawer } from "./doctor.js";

const TASK_KINDS = [
  { cap: "coding", label: "代码任务", re: /代码|编程|重构|审查|bug|函数|脚本|code|refactor/i },
  { cap: "vision", label: "视觉任务", re: /图片|截图|看图|图像|视觉|ocr|识别图/i },
  { cap: "reasoning", label: "推理任务", re: /分析|推理|数学|逻辑|比较|方案|评估/i },
  { cap: "research", label: "调研任务", re: /调研|搜索|查|资料|论文|文献|research|survey/i },
  { cap: "writing", label: "写作任务", re: /写|文案|报告|翻译|总结|润色|writing/i },
];

function detectKind(text) {
  const t = String(text || "");
  return TASK_KINDS.find((k) => k.re.test(t)) || { cap: "general", label: "通用任务" };
}

/** 预估路由：只做「能力 → 候选模型」的静态估算，并明示最终由 Router Brain 决定。
 *  去偏见化（2026-11-01）：只有在模型**真声明**了该能力（≥0.5）时才点名执行者。
 *  没声明就是没声明——不能拿「数组第一个」冒充预测结果（那是把品牌锚定写进 UI）。 */
function predictRoute(text) {
  const el = $("#omniPredict");
  if (!String(text || "").trim()) {
    el.className = "omni-predict";
    el.textContent = "";
    return;
  }
  if (!usableModels().length) {
    el.className = "omni-predict warn";
    el.textContent = "无可用模型";
    return;
  }
  const kind = detectKind(text);
  const declared = usableModels().filter((m) => Number(m.capabilities?.[kind.cap] ?? 0) >= 0.5);
  const ranked = declared
    .map((m) => ({ m, s: Number(m.capabilities?.[kind.cap] ?? 0) }))
    .sort((a, b) => b.s - a.s);
  const best = ranked[0]?.m;
  // 未显式指定主脑 = 中立轮转，不得显示成某个固定模型名（品牌锚定）
  const explicitBrain = Boolean(state.analyzerModelId && state.models.some((m) => m.id === state.analyzerModelId));
  const brain = explicitBrain ? state.models.find((m) => m.id === state.analyzerModelId) : null;
  el.className = "omni-predict";
  el.innerHTML = `<b>${esc(kind.label)}</b> · 主脑 <b>${esc(brain ? brain.label || brain.id : "中立轮转")}</b>` +
    (best ? ` · 执行者 <b>${esc(best.label || best.id)}</b>` : ` · 执行者 <b>按能力与实测择优</b>`);
}

function renderOmniTemplates() {
  const root = $("#omniTpls");
  const chips = state.workflows.slice(0, 3).map((w) => ({ id: w.id, label: w.name, text: w.goal || w.name }));
  root.innerHTML = chips
    .map((c) => `<button type="button" class="chip" data-omni="${esc(c.text)}">${esc(c.label)}</button>`)
    .join("");
  root.insertAdjacentHTML(
    "beforeend",
    `<button type="button" class="chip ghost" id="chipNewWf">+ 新建流水线</button>`,
  );
}

/**
 * 派发 = 执行：投递后对话页自动填入并发送。
 * 前置三选择（工作区 / 权限 / 核验）在派发时一次性锁定，执行期只读回显在契约栏；
 * 模型选择完全交给 Router Brain（恒智能路由），发射台不再提供强制模型。
 */
async function dispatchTask(text) {
  let task = String(text || "").trim();
  if (!task) {
    toast("先写一句要做什么", "err");
    $("#omniInput").focus();
    return;
  }
  const permission = $("#omniPermission")?.value || "workspace-write";
  let verify = $("#omniVerify")?.value || "strict";
  // 快速通道：零副作用的轻量问答自动豁免快照与独立核验（大炮不打蚊子）
  const fastPath = detectFastPath(task);
  if (fastPath && verify === "strict") {
    verify = "fast";
    toast("⚡ 极速直通：检测到零副作用问答，已自动豁免沙箱与快照开销", "ok");
  }
  // 附件：截图 / @ 引用文件 → 以路径写进任务文本（视觉任务由能力路由分给多模态模型）
  if (attachments.length) {
    const refs = attachments.map((a) => `- ${a.path}`).join("\n");
    task += `\n\n【附件】请用视觉/文件能力查看以下文件：\n${refs}`;
  }
  const runningUrl = state.dsh?.url;
  // 完全自治 = 放开近全盘权限：先显式确认，再把 danger-full-access 写进托管策略
  if (permission === "full") {
    const ok = await confirmAsync({
      title: "允许完全自治",
      message:
        "本次任务将获得近全盘权限（终端 / 浏览器验证），写保护不再限制在沙箱工作区。\n确定放行？",
      ok: "放行",
      danger: true,
    });
    if (!ok) return;
    const base = state.sandboxPolicy || {};
    const modes = new Set(base.allowedModes || ["workspace-write"]);
    modes.add("danger-full-access");
    try {
      const d = await api("/api/sandbox-policy", {
        method: "POST",
        body: JSON.stringify({
          policy: {
            allowedModes: [...modes],
            budget: base.budget || { toolCalls: 200, wallClockMs: 7200000, reviewFails: 5 },
          },
        }),
      });
      if (!d?.ok) throw new Error(d?.message || "策略保存失败");
      state.sandboxPolicy = d.policy;
    } catch (e) {
      toast(e.message || "权限放行失败，任务未派发", "err");
      return;
    }
  }
  // 1) 立刻进入执行态：视态切换与流水线复位不等待任何网络往返，
  //    否则「派发了却还停在发射台」会让用户以为没生效
  showStage("frame");
  startTask(task, { permission, verify });
  syncStage(); // 本轮任务已建立：执行态立即从待命态切到引擎实况
  const btn = $("#omniGo");
  btn.disabled = true;
  btn.textContent = "派发中…";
  // 2) 任务边界打影子快照：失败不阻断派发（git 不可用时静默降级）。
  //    快速通道任务零文件副作用，跳过快照——不付无谓的 git 开销。
  if (!fastPath) {
    try {
      await api("/api/shadow/snapshot", {
        method: "POST",
        body: JSON.stringify({ label: task.slice(0, 60) }),
      });
    } catch {
      /* 快照失败不影响派发 */
    }
  }
  // 3) 投递到对话页投递箱（插件取走并自动发送；verifyMode 随任务下发）
  let dup = false;
  try {
    const d = await api("/api/pending-task", {
      method: "POST",
      body: JSON.stringify({ text: task, autoSend: true, verifyMode: verify, permission }),
    });
    dup = Boolean(d?.duplicate);
  } catch (e) {
    // 投递失败 = 这一轮根本没开始：退回发射态，别留一个空转的执行面板
    stopTask(true);
    showStage("launch");
    btn.disabled = false;
    btn.innerHTML = "派发 <kbd>↵</kbd>";
    toast(e.message || "任务投递失败", "err");
    return;
  }
  attachments.length = 0;
  renderAttachments();
  $("#omniInput").value = "";
  predictRoute("");
  const el = $("#omniPredict");
  el.className = "omni-predict";
  el.textContent = runningUrl ? "已派发 · 正在执行" : "已派发 · 引擎预热中，就绪后自动执行";
  // 左栏随之更新：任务历史多一条
  refreshTasks().catch(() => {});
  if (dup) {
    // 幂等合并：5 秒内的相同派发不再重复入箱（连按回车 / 重连的防抖）
    stopTask(true);
    showStage("launch");
    toast("5 秒内的相同任务已合并，正在执行中", "warn");
  } else if (runningUrl) {
    toast("已派发，正在执行", "ok");
  } else {
    // 引擎预热中（Warm Daemon 生命周期对用户不可见）：任务已排队，就绪即发
    toast("引擎预热中，任务已排队，就绪后自动执行", "warn");
    launch().catch(() => {});
  }
  btn.disabled = false;
  btn.innerHTML = "派发 <kbd>↵</kbd>";
}

/* ============================== 多模态附件（2026-11-02） ==============================
 * 「看一下这张截图里的报错」这类任务过去在发射台没地方传图。
 * 现在：Cmd+V 直接粘贴剪贴板截图 → 自动落盘沙箱工作区（/api/upload-image）→
 * 任务文本以相对路径引用它；带图任务会被能力路由自动分给多模态模型。
 * 输入 @ 唤出工作区文件选择器，快速引用既有文件。 */
const attachments = []; // { path, name, thumb }

function renderAttachments() {
  const strip = $("#attachStrip");
  if (!strip) return;
  strip.hidden = attachments.length === 0;
  strip.innerHTML = attachments
    .map(
      (a, i) =>
        `<span class="att-chip" title="${esc(a.path)}">` +
        (a.thumb ? `<img class="att-thumb" src="${esc(a.thumb)}" alt="">` : `<span class="att-ico">📄</span>`) +
        `<span class="att-name">${esc(a.name)}</span>` +
        `<button type="button" class="att-del" data-i="${i}" title="移除附件">✕</button></span>`,
    )
    .join("");
}

async function addPastedImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("读取剪贴板图片失败"));
    r.readAsDataURL(file);
  });
  try {
    const d = await api("/api/upload-image", {
      method: "POST",
      body: JSON.stringify({ data: dataUrl, name: file.name || "paste.png" }),
    });
    if (!d?.ok) throw new Error(d?.message || "上传失败");
    attachments.push({ path: d.path, name: file.name || "剪贴板截图", thumb: dataUrl });
    renderAttachments();
    toast("截图已挂载，派发时将自动路由至多模态模型", "ok");
  } catch (e) {
    toast(e.message || "截图上传失败", "err");
  }
}

/* @ 引用：唤出工作区文件选择器（扁平取两层，够快速引用） */
let atMenu = null;

function closeAtMenu() {
  atMenu?.remove();
  atMenu = null;
}

async function openAtMenu() {
  closeAtMenu();
  try {
    const d = await api("/api/files?depth=2");
    const files = (d?.entries || []).filter((e) => e.type !== "dir").slice(0, 12);
    if (!files.length) {
      toast("工作区还没有可引用的文件", "warn");
      return;
    }
    atMenu = document.createElement("div");
    atMenu.className = "at-menu";
    atMenu.innerHTML =
      `<div class="at-h">引用沙箱工作区文件</div>` +
      files
        .map((f) => `<button type="button" class="at-item" data-p="${esc(f.path)}">📄 ${esc(f.path)}</button>`)
        .join("");
    document.body.appendChild(atMenu);
    const box = $("#omniInput").getBoundingClientRect();
    atMenu.style.left = `${Math.round(box.left)}px`;
    atMenu.style.top = `${Math.round(box.bottom + 6)}px`;
    atMenu.addEventListener("click", (ev) => {
      const item = ev.target?.closest?.("[data-p]");
      if (!item) return;
      const input = $("#omniInput");
      input.value = input.value.replace(/@$/, "") + `@${item.getAttribute("data-p")} `;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      closeAtMenu();
      input.focus();
    });
  } catch {
    /* 工作区不可达：不弹菜单 */
  }
}

/* ============================== 快速通道（Fast-Path） ==============================
 * 「1+1=?」「解释 HTTP 404」这类零副作用轻量任务：跳过影子快照与独立核验
 * （verifyMode 自动降为 fast 直通），不再为大炮打蚊子付全套沙箱开销。
 * 涉及写代码/跑命令/动文件的措辞一律回退标准流水线。 */
const FAST_BLOCK_RE =
  /(写|创建|生成|修改|重构|删除|运行|执行|测试|脚本|函数|游戏|目录|文件|bash|py\b|html|csv|git|安装|爬虫|下载|上传|保存|导出)/i;

function detectFastPath(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 80) return false;
  return !FAST_BLOCK_RE.test(t);
}

/* ============================== 事件绑定 ============================== */

$("#omniForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  dispatchTask($("#omniInput").value);
});
$("#omniInput").addEventListener("input", (ev) => {
  const el = ev.target;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  predictRoute(el.value);
  // @ 引用：输入以 @ 结尾时唤出工作区文件选择器
  if (el.value.endsWith("@")) void openAtMenu();
  else if (atMenu && el.value.length) closeAtMenu();
});
$("#omniInput").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    dispatchTask(ev.target.value);
  }
});
// Cmd+V 粘贴截图：直接从剪贴板取图片文件
$("#omniInput").addEventListener("paste", (ev) => {
  const items = ev.clipboardData?.items || [];
  for (const item of items) {
    if (item.type?.startsWith("image/")) {
      ev.preventDefault();
      const file = item.getAsFile();
      if (file) void addPastedImage(file);
      return;
    }
  }
});
$("#attachStrip")?.addEventListener("click", (ev) => {
  const del = ev.target?.closest?.(".att-del");
  if (!del) return;
  attachments.splice(Number(del.getAttribute("data-i")), 1);
  renderAttachments();
});
document.addEventListener("click", (ev) => {
  if (atMenu && !ev.target.closest?.(".at-menu") && !ev.target.closest?.("#omniInput")) closeAtMenu();
});
$("#omniTpls").addEventListener("click", (ev) => {
  const newWf = ev.target.closest("#chipNewWf");
  if (newWf) {
    openDrawer("#wfForm");
    $("#wfForm").hidden = false;
    $("#wfName").focus();
    return;
  }
  const chip = ev.target.closest("[data-omni]");
  if (!chip) return;
  $("#omniInput").value = chip.dataset.omni || "";
  predictRoute($("#omniInput").value);
  $("#omniInput").focus();
});
export { renderOmniTemplates, predictRoute };
