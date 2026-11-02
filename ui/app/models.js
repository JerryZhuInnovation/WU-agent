/* WU ai · 控制中心 —— 模型舰队 / 模型弹窗 / Router Brain 设置（依赖 dom, state） */
import { $, api, confirmAsync, esc, shortPath, toast } from "./dom.js";
import { renderFirstRun } from "./doctor.js";
import {
  capLabel,
  effectiveBrainId,
  fetchCatalog,
  fillSelect,
  keyState,
  on,
  parsePrefText,
  refreshModelsOnly,
  savePrefs,
  state,
  usableModels,
} from "./state.js";

let editingId = null;

/* 本地模型（llama.cpp / Ollama 等兼容网关）的默认地址：表单占位与空值兜底共用 */
const LOCAL_BASE_URL = "http://127.0.0.1:8080/v1";

/* ============================== 模型列表 ============================== */

function renderModels() {
  const root = $("#modelList");
  root.innerHTML = "";
  $("#modelCount").textContent = `${state.models.length} 个模型`;
  $("#fleetTag").textContent = `${state.models.length} 模型`;
  if (!state.models.length) {
    root.innerHTML = `<p class="hint">还没有模型，点「+ 添加」</p>`;
    return;
  }
  for (const m of state.models) {
    const ks = keyState(m);
    const caps = Object.entries(m.capabilities || {})
      .filter(([, v]) => v >= 0.5)
      .map(([k]) => capLabel(k))
      .slice(0, 3);
    const row = document.createElement("div");
    row.className = "mrow";
    row.innerHTML = `
      <div class="mrow-main">
        <span class="mnm">${esc(m.label || m.id)}</span>
        <span class="st-dot ${ks.tone === "ok" ? "" : "warn"}" title="${esc(m.keyStatus?.message || "")}">${esc(ks.dot)}</span>
        ${ks.tone === "ok" ? "" : `<span class="badge warn">${esc(ks.label)}</span>`}
        <span class="badge">${m.access === "local" ? "本地" : "API"}</span>
        ${caps.map((c) => `<span class="badge cap">${esc(c)}</span>`).join("")}
        <span class="mmd">${esc(m.model || m.id)}</span>
      </div>
      <div class="mrow-acts">
        <button class="mbtn" data-act="edit">编辑</button>
        <button class="mbtn danger" data-act="del">删除</button>
      </div>
    `;
    row.querySelector('[data-act="edit"]').onclick = () => openModal(m);
    row.querySelector('[data-act="del"]').onclick = () => deleteModel(m);
    root.appendChild(row);
  }
  renderLocalCta();
}

/** 检测到 Metal 却没有任何本地模型时，给出「把硬件用起来」的入口（不虚构能力）。 */
function renderLocalCta() {
  const hw = state.hardware || {};
  const hasLocal = state.models.some((m) => m.access === "local");
  const metal = String(hw.gpu?.vendor || "").toLowerCase().includes("apple") || hw.recommendedBackend === "metal";
  const el = $("#localCta");
  if (!el) return;
  if (!metal || hasLocal) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  $("#localCtaText").textContent = `检测到 ${hw.ramGb || "?"}GB 内存 / ${hw.recommendedBackend || "metal"} 后端${
    hw.recommendedQuant ? ` / ${hw.recommendedQuant}` : ""
  }，可承载 3B~7B 量化模型。`;
}

/* ============================== Router Brain ============================== */

function renderSettings() {
  fillSelect($("#defaultModelId"), state.defaultModelId);
  // Router Brain 下拉首项是「中立轮转」（= 不指定）：未显式指定时不得把某个模型
  // 显示成已选中——那会让用户以为裁判员被钉死在某一家（品牌锚定）。
  const brainSel = $("#analyzerModelId");
  const explicit = Boolean(state.analyzerModelId && state.models.some((m) => m.id === state.analyzerModelId));
  fillSelect(brainSel, explicit ? state.analyzerModelId : "");
  brainSel.insertAdjacentHTML("afterbegin", `<option value="">中立轮转（各模型轮值）</option>`);
  if (!explicit) brainSel.value = "";
}

function renderBrain() {
  const explicit = Boolean(state.analyzerModelId && state.models.some((m) => m.id === state.analyzerModelId));
  const brain = state.models.find((m) => m.id === effectiveBrainId() && m.enabled !== false);
  const isLocal = brain?.access === "local";

  if (!explicit) {
    // 未显式指定 = 中立轮转（路由内核按「累计执行最少 + 裁判次数最少」轮换）。
    // 过去这里写「● 回退默认模型」，让人误以为有个固定裁判员（品牌锚定的来源之一）。
    $("#brainTag").textContent = "中立轮转";
    $("#brainState").innerHTML = `<span class="zen">● 未指定 · 各模型轮值</span>`;
    $("#brainModel").textContent = "轮转择优";
    $("#brainLoc").textContent = "按累计执行最少的模型轮值";
    $("#brainData").textContent = "本轮示例：" + (brain ? brain.label || brain.id : "—");
    return;
  }
  if (brain) {
    $("#brainTag").textContent = isLocal ? "本地调度" : "云端调度";
    $("#brainState").innerHTML = `<span class="zen">● 已指定</span>`;
    $("#brainModel").textContent = brain.label || brain.id;
    $("#brainLoc").textContent = isLocal ? "本地 · llama.cpp" : "云端 API";
    $("#brainData").textContent = isLocal ? "不离开本机" : "经云端服务";
  } else {
    $("#brainTag").textContent = "未指定";
    $("#brainState").innerHTML = `<span class="amber">○ 未指定</span>`;
    $("#brainModel").textContent = "—";
    $("#brainLoc").textContent = "将回退默认模型";
    $("#brainData").textContent = "—";
  }
}

async function testBrain() {
  const btn = $("#btnTestBrain");
  const out = $("#brainTestOut");
  const target = state.defaultModelId || state.models[0]?.id;
  if (!target) {
    toast("先添加并启用一个模型", "err");
    return;
  }
  btn.disabled = true;
  btn.textContent = "测试中…";
  out.hidden = false;
  out.textContent = "正在用 Router Brain 跑一次连通性自检，最长 90 秒…";
  try {
    const r = await api("/api/intel/research", {
      method: "POST",
      body: JSON.stringify({
        modelKey: target,
        brainModelId: state.analyzerModelId,
        hint: "连通性自检",
      }),
    });
    const text = String(r.output || "").trim().split("\n").filter(Boolean).slice(0, 3).join(" ");
    out.textContent = `✓ 已返回：${text.slice(0, 180)}`;
    toast("Router Brain 已响应", "ok");
  } catch (e) {
    out.textContent = `⚠ 测试失败：${e.message || e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "测试 Router Brain";
  }
}

/* ============================== 模型弹窗 ============================== */

function updateAccessMode() {
  const access = $("#fAccess").value;
  const isLocal = access === "local";
  $("#localPick").hidden = !isLocal;
  $("#cloudFields").hidden = isLocal;
  const localMode = isLocal ? $("#fLocalMode").value : "";
  $("#localNew").hidden = !(isLocal && localMode === "new");
  $("#localExisting").hidden = !(isLocal && localMode === "existing");
}

function openModal(model) {
  editingId = model?.id || null;
  $("#modalTitle").textContent = model ? "编辑模型" : "添加模型";
  $("#fLabel").value = model?.label || "";
  $("#fAccess").value = model?.access || "api";
  $("#fModel").value = model?.model || "";
  $("#fBaseURL").value = model?.baseURL || "";
  $("#fApiKey").value = "";
  $("#fApiKey").placeholder = model?.apiKeyMasked ? `已保存（${model.apiKeyMasked}）` : "";
  $("#fModelPath").value = model?.modelPath || "";
  $("#fLocalModelId").value = model?.model || "";
  $("#fLocalBaseURL").value = model?.baseURL || LOCAL_BASE_URL;
  $("#fLocalExistingModel").value = model?.model || "";
  $("#fLocalExistingURL").value = model?.baseURL || LOCAL_BASE_URL;
  $("#fLocalMode").value = "existing";
  $("#hwResult").textContent = "";
  $("#llamaResult").textContent = "";
  $("#pickResult").textContent = "";
  updateAccessMode();
  $("#modal").hidden = false;
}

function closeModal() {
  $("#modal").hidden = true;
  editingId = null;
}

async function detectHwInModal() {
  $("#hwResult").textContent = "检测中…";
  try {
    const r = await api("/api/hardware");
    const h = r.hardware || {};
    $("#hwResult").textContent =
      [
        `${h.system || "?"}/${h.arch || "?"}`,
        `${h.ramGb || "?"}GB RAM`,
        h.gpu?.vendor ? `GPU:${h.gpu.vendor}` : "无独立GPU",
        h.recommendedBackend ? `后端:${h.recommendedBackend}` : "",
        h.recommendedQuant ? `量化:${h.recommendedQuant}` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "未取得硬件信息";
  } catch (e) {
    $("#hwResult").textContent = "失败：" + (e.message || "");
  }
}

async function installLlamaInModal() {
  $("#llamaResult").textContent = "下载中…";
  try {
    const r = await api("/api/llama/install", { method: "POST", body: "{}" });
    $("#llamaResult").innerHTML = `<span class="ok">✓ 就绪</span> ${esc(shortPath(r.path))}`;
  } catch (e) {
    $("#llamaResult").innerHTML = `<span class="err">✗ 失败</span> ${esc(e.message || "")}`;
  }
}

async function saveModel() {
  const label = $("#fLabel").value.trim();
  const access = $("#fAccess").value;
  // 弹窗不收集用途文本 → 不声明任何能力（全 0）。路由层会按模型家族的技术
  // 性状先验兜底；过去这里写死 general 0.85 会让所有模型在通用标签上并列，
  // 最终谁先跑过谁通吃（general 黑洞，2026-11-01 去偏见化）。
  const caps = parsePrefText("");

  let payload;
  if (access === "local") {
    const localMode = $("#fLocalMode").value;
    const modelId =
      (localMode === "existing" ? $("#fLocalExistingModel").value : $("#fLocalModelId").value).trim() ||
      "local-model";
    const baseURL =
      (localMode === "existing" ? $("#fLocalExistingURL").value : $("#fLocalBaseURL").value).trim() ||
      LOCAL_BASE_URL;
    const id = editingId || modelId.replace(/\s+/g, "-").toLowerCase().slice(0, 28);
    payload = {
      id,
      label: label || modelId,
      access: "local",
      provider: id,
      model: modelId,
      apiKey: "",
      baseURL,
      api: "openai-completions",
      costScore: 1.0,
      latencyScore: 0.6,
      enabled: true,
      capabilities: caps,
      modelPath: localMode === "new" ? $("#fModelPath").value.trim() : "",
    };
  } else {
    const modelId = $("#fModel").value.trim();
    const baseURL = $("#fBaseURL").value.trim();
    if (!label && !modelId) {
      toast("请填写名称或模型 ID", "err");
      return;
    }
    if (!baseURL) {
      toast("请填写 Base URL", "err");
      return;
    }
    const id = editingId || (label || modelId).replace(/\s+/g, "-").toLowerCase().slice(0, 28);
    payload = {
      id,
      label: label || modelId,
      access: "api",
      provider: id,
      model: modelId || id,
      apiKey: $("#fApiKey").value.trim(),
      baseURL,
      api: "openai-completions",
      costScore: 0.85,
      latencyScore: 0.7,
      enabled: true,
      capabilities: caps,
    };
  }
  await api("/api/models", { method: "POST", body: JSON.stringify(payload) });
  toast("已保存", "ok");
  closeModal();
  await fetchCatalog();
  await savePrefs(false);
}

async function deleteModel(model) {
  const ok = await confirmAsync({
    title: "删除模型",
    message: `删除「${model.label || model.id}」？密钥会一并从密库移除，此操作不可撤销。`,
    ok: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await api("/api/models/delete", { method: "POST", body: JSON.stringify({ id: model.id }) });
    toast("已删除", "ok");
    await fetchCatalog();
  } catch (e) {
    toast(e.message, "err");
  }
}

/* ============================== 订阅与事件绑定 ============================== */

on("catalog", () => {
  renderModels();
  renderSettings();
  renderBrain();
});
// 健康核验是异步的：拿到新状态后连选模下拉一起重绘，避免下拉里继续挂着失效模型
on("models", () => {
  renderModels();
  renderSettings();
  renderBrain();
});
on("hardware", renderLocalCta);

// 顶栏已删除：FLEET 通过左栏「⚙ 设置」抽屉进入；先把健康状态拉新再展示
$("#btnDoctor").addEventListener("click", () => {
  fetchCatalog().catch(() => {});
});
// 轻量轮询：模型增减 / 密钥核验结果变化后，选模下拉自动跟上（不整套重绘页面）
setInterval(() => void refreshModelsOnly(), 30_000);

$("#btnAddModel").onclick = () => openModal(null);
$("#btnCloseModal").onclick = closeModal;
$("#btnCancelModel").onclick = closeModal;
$("#btnSaveModel").onclick = () => saveModel().catch((e) => toast(e.message, "err"));
$("#btnTestBrain").onclick = () => testBrain();
$("#btnLocalCta").onclick = () => {
  openModal(null);
  $("#fAccess").value = "local";
  updateAccessMode();
};
$("#defaultModelId").addEventListener("change", () => {
  state.defaultModelId = $("#defaultModelId").value;
});
$("#analyzerModelId").addEventListener("change", () => {
  state.analyzerModelId = $("#analyzerModelId").value;
  renderBrain();
  renderFirstRun();
});
$("#fAccess").addEventListener("change", updateAccessMode);
$("#fLocalMode").addEventListener("change", updateAccessMode);
$("#btnHwDetect").onclick = detectHwInModal;
$("#btnLlamaInstall").onclick = installLlamaInModal;
$("#btnPickModel").onclick = () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".gguf,.bin,.safetensors,.pt,.pth";
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    $("#fModelPath").value = file.name;
    $("#pickResult").textContent = `已选择：${file.name}`;
  };
  input.click();
};

/* 供启动入口与本地 CTA 复用 */
export { updateAccessMode, openModal };
