/* WU ai · 控制中心 —— 基础 DOM/网络工具（零内部依赖层）
   视觉遵循 README §7 设计规范（单一悟绿 · 圆角 ≤8px · 状态先行 · 等宽为主字体）：
   - 顶栏状态徽章是唯一状态源
   - 破坏性操作一律自绘确认框（不使用原生 confirm）
   - 文案不暴露内部术语
*/
export const $ = (s) => document.querySelector(s);

/* ============================== 基础工具 ============================== */

/** 任何用户可见文本里的家目录/用户名都统一收敛为 ~，避免截图外泄。 */
export function scrubPaths(s) {
  return String(s ?? "").replace(/\/Users\/[^/\s"'<>]+/g, "~");
}

export function toast(msg, kind = "") {
  const el = $("#toast");
  el.hidden = false;
  el.textContent = scrubPaths(msg);
  el.className = `toast ${kind}`;
  // 重新触发进入动画
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

export async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.ok !== true) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** 界面不展示家目录与用户名，也不展示带 token 的 Agent 链接（截图外泄风险）。 */
export function shortPath(p, depth = 2) {
  const s = String(p || "");
  if (!s) return "";
  const m = s.match(/^\/Users\/[^/]+\/?(.*)$/);
  if (!m) return s;
  const rest = m[1].split("/").filter(Boolean);
  if (!rest.length) return "~";
  return rest.length <= depth ? `~/${rest.join("/")}` : `~/…/${rest.slice(-depth).join("/")}`;
}

/* ============================== 自绘确认框 ============================== */

export function confirmAsync({ title = "请确认", message = "", ok = "继续", danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $("#confirmModal");
    const okBtn = $("#confirmOk");
    $("#confirmTitle").textContent = title;
    $("#confirmText").textContent = message;
    okBtn.textContent = ok;
    okBtn.classList.toggle("primary", !danger);
    modal.hidden = false;
    const close = (val) => {
      modal.hidden = true;
      okBtn.onclick = null;
      $("#confirmCancel").onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
    };
    okBtn.onclick = () => close(true);
    $("#confirmCancel").onclick = () => close(false);
    document.addEventListener("keydown", onKey);
  });
}
