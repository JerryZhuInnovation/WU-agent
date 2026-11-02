/* WU ai · 控制中心 —— Runtime：版本并存 / 升级 / 回滚（依赖 dom, state, agent） */
import { $, api, confirmAsync, esc, scrubPaths, toast } from "./dom.js";
import { applyDsh, pollDsh } from "./agent.js";
import { fetchCatalog, refreshBadge, setBadge, state } from "./state.js";

/* 升级阶段 → 人类语言 */
const STAGE_LABEL = {
  "check-update": "检查更新",
  "already-latest": "已是最新",
  install: "下载并安装",
  compat: "兼容测试",
  "stop-old": "停止旧版",
  "start-new": "启动新版",
  "web-ready": "健康检查",
  smoke: "契约冒烟",
  prune: "清理旧版本",
  rollback: "回滚上一版本",
};

let runtimesState = { runtimes: [], active: "", activeVersion: null, previous: null, upgrade: null };
let upgradeTimer = null;

function rtChecksText(compat) {
  return (compat?.checks || [])
    .map((c) => `${c.status === "fail" ? "✗" : c.status === "warn" ? "△" : "✓"} ${c.name}${c.detail ? "：" + c.detail : ""}`)
    .join("\n");
}

function renderRuntimeSummary() {
  const active = runtimesState.runtimes.find((r) => r.active);
  const total = runtimesState.runtimes.length;
  const main = $("#rtMain");
  const tag = $("#rtTag");

  if (!total) {
    tag.textContent = "未发现";
    main.innerHTML = `未发现已安装的运行时。<br>点「检查更新」下载并安装第一个版本。`;
    return;
  }
  const checks = active?.compat?.checks || [];
  const passed = checks.filter((c) => c.status !== "fail").length;
  tag.textContent = active?.compat?.passed === false ? "兼容未通过" : "已激活";
  main.innerHTML = `
    <b>dsh ${esc(active?.version || "?")}</b> 已激活<br>
    兼容测试 <span class="zen">${passed}/${checks.length} 通过</span> · 原版插件全部兼容<br>
    ${runtimesState.previous ? `上一版本 ${esc(runtimesState.previous)} 并存 · 可回滚` : "无可回滚的上一版本"}
    ${total > 2 ? ` · 现有 ${total} 个版本，下次升级成功后会清理更早的` : ""}
  `;
}

function renderRuntimes() {
  const root = $("#runtimeList");
  const list = runtimesState.runtimes || [];
  root.innerHTML = "";
  for (const rt of list) {
    const compat = rt.compat || {};
    const checksText = rtChecksText(compat);
    const row = document.createElement("div");
    row.className = "mrow";
    row.innerHTML = `
      <div class="mrow-main">
        <span class="mnm">dsh ${esc(rt.version || rt.key)}</span>
        ${rt.active ? `<span class="badge on">当前</span>` : ""}
        <span class="badge">${rt.kind === "legacy" ? "单安装" : "并排"}</span>
        <span class="badge ${compat.passed ? "on" : "warn"}" title="${esc(checksText)}">${compat.passed ? "兼容通过" : "兼容未通过"}</span>
        <span class="st-dot ${compat.passed ? "" : "warn"}">${compat.passed ? "可用" : "不可用"}</span>
      </div>
      <div class="mrow-acts">
        ${!rt.active ? `<button class="mbtn" data-switch="${esc(rt.key)}">切换</button>` : ""}
      </div>
    `;
    row.querySelector("[data-switch]")?.addEventListener("click", () => switchRuntime(rt.key));
    root.appendChild(row);
  }
  $("#btnRtRollback").disabled = !runtimesState.previous;
  renderRuntimeSummary();
}

function renderUpgrade(snap) {
  const box = $("#rtUpgrade");
  const report = snap?.report;
  const running = snap?.running;
  const stages = report?.stages || [];
  if (!running && !stages.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = "";

  const doneCount = stages.filter((s) => s.ok).length;
  stages.forEach((s, i) => {
    const isLast = i === stages.length - 1;
    const pending = running && isLast && s.ok;
    const mark = s.ok ? "✓" : "✗";
    const cls = s.ok ? (pending ? "run" : "ok") : "bad";
    const el = document.createElement("div");
    el.className = "rt-stage";
    el.innerHTML = `<span class="mark ${cls}">${s.ok ? (pending ? "◌" : "✓") : mark}</span>
      <span>${esc(STAGE_LABEL[s.stage] || s.stage)}</span>
      <span class="dim" style="margin-left:auto;color:var(--text-dim)">${esc(String(s.detail ?? "").slice(0, 60))}</span>`;
    box.appendChild(el);
  });
  if (running) {
    const note = document.createElement("div");
    note.className = "rt-stage";
    note.innerHTML = `<span class="mark run">◌</span><span>${stages.length ? `正在执行…（已完成 ${doneCount} 个阶段）` : "正在准备升级…"}</span>`;
    box.appendChild(note);
    const tail = (snap.log || []).slice(-3);
    if (tail.length) {
      const logBox = document.createElement("div");
      logBox.className = "mfoot";
      logBox.style.whiteSpace = "pre-wrap";
      logBox.textContent = scrubPaths(tail.join("\n"));
      box.appendChild(logBox);
    }
  }

  const warn = $("#rtWarn");
  if (report && !running) {
    if (report.ok) {
      warn.hidden = false;
      warn.innerHTML = `<span>升级完成：dsh ${esc(report.latest || "")}</span><span class="result">✓ 已激活</span>`;
    } else {
      const failed = stages.find((s) => !s.ok);
      warn.hidden = false;
      warn.innerHTML = `<span>⚠ 升级在「${esc(STAGE_LABEL[failed?.stage] || "某个阶段")}」失败：${esc(String(failed?.detail || "").slice(0, 80))}</span>
        <span class="result">${report.rolledBack ? "✓ 已自动回滚到上一版本" : "请查看运行日志"}</span>`;
    }
  } else {
    warn.hidden = true;
  }
}

async function loadRuntimes() {
  try {
    runtimesState = await api("/api/runtimes");
    renderRuntimes();
    renderUpgrade(runtimesState.upgrade);
    if (runtimesState.upgrade?.running) startUpgradePolling();
  } catch (e) {
    $("#rtMain").innerHTML = `运行时信息不可用：${esc(e.message || "")}`;
    $("#rtTag").textContent = "不可用";
  }
}

function startUpgradePolling() {
  if (upgradeTimer) return;
  const tick = async () => {
    upgradeTimer = null;
    try {
      const snap = await api("/api/runtimes");
      runtimesState = snap;
      renderRuntimes();
      renderUpgrade(snap.upgrade);
      if (snap.upgrade?.running) {
        const last = (snap.upgrade.report?.stages || []).slice(-1)[0];
        setBadge("working", `⇄ ${STAGE_LABEL[last?.stage] || "正在升级运行时"}`, true);
        upgradeTimer = setTimeout(tick, 1500);
        return;
      }
      // 收尾
      const report = snap.upgrade?.report;
      refreshBadge();
      $("#btnRtCheck").disabled = false;
      $("#btnRtCheck").textContent = "检查更新";
      if (report?.ok) toast(`升级完成：dsh ${report.latest || ""}`, "ok");
      else if (report) toast("升级未完成，已自动回滚到上一版本", "err");
      try {
        const data = await api("/api/catalog");
        state.models = data.models || state.models;
        applyDsh(data.dsh);
      } catch {
        /* 忽略瞬时错误 */
      }
    } catch (e) {
      upgradeTimer = setTimeout(tick, 2000);
    }
  };
  upgradeTimer = setTimeout(tick, 1500);
}

async function checkRuntimeUpdate() {
  const btn = $("#btnRtCheck");
  btn.disabled = true;
  btn.textContent = "查询中…";
  setBadge("working", "⇄ 检查运行时更新", true);
  let handedOffToPolling = false;
  try {
    const r = await api("/api/runtimes/check", { method: "POST", body: "{}" });
    if (r.newer) {
      const ok = await confirmAsync({
        title: "一键升级",
        message: `发现新版 dsh ${r.latest}（当前 ${r.activeVersion || "?"}）。\n升级会依次执行：下载 → 兼容测试 → 切换 → 健康检查；任一步失败会自动回滚到上一版本。`,
        ok: `升级到 ${r.latest}`,
      });
      if (!ok) return;
      btn.textContent = "升级中…";
      await api("/api/runtimes/upgrade", { method: "POST", body: JSON.stringify({ version: r.latest }) });
      startUpgradePolling();
      handedOffToPolling = true;
      return; // 由轮询负责恢复按钮
    }
    if (r.latest) {
      toast(`已是最新：dsh ${r.latest}`, "ok");
    } else {
      toast("未查到最新版本（网络不可达？）", "err");
    }
  } catch (e) {
    toast(e.message, "err");
  } finally {
    refreshBadge();
    // 只有已移交给轮询才不恢复；请求失败（含 409 重复升级）必须复位，否则按钮永久卡死
    if (!handedOffToPolling) {
      btn.disabled = false;
      btn.textContent = "检查更新";
      loadRuntimes().catch(() => {});
    }
  }
}

/** 切换 / 回滚共用编排：确认 → 调接口 → 恢复对话面 → 刷新版本与目录。 */
async function restartRuntime(endpoint, payload, confirmOpts, fallbackMsg) {
  if (!(await confirmAsync(confirmOpts))) return;
  try {
    const r = await api(endpoint, { method: "POST", body: JSON.stringify(payload) });
    toast(r.message || fallbackMsg, "ok");
    applyDsh({ url: r.url });
    pollDsh();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    loadRuntimes().catch(() => {});
    fetchCatalog().catch(() => {});
  }
}

async function switchRuntime(key) {
  await restartRuntime(
    "/api/runtimes/switch",
    { key },
    {
      title: "切换运行时",
      message: `切换到 dsh ${key}？\n切换前会自动运行兼容测试，不通过则拒绝；切换后会重启 Agent。`,
      ok: "切换",
    },
    "已切换",
  );
}

async function rollbackRuntime() {
  await restartRuntime(
    "/api/runtimes/rollback",
    {},
    {
      title: "回滚运行时",
      message: "回滚到上一版本？\n应急通道：不经过兼容测试，直接切回并重启 Agent。",
      ok: "回滚",
      danger: true,
    },
    "已回滚",
  );
}

/* ============================== 事件绑定 ============================== */

$("#btnRtCheck").onclick = () => checkRuntimeUpdate().catch((e) => toast(e.message, "err"));
$("#btnRtRollback").onclick = () => rollbackRuntime().catch((e) => toast(e.message, "err"));

export { loadRuntimes };
