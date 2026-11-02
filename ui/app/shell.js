/* WU ai · 控制中心 —— 单页双态：发射态（launch）↔ 执行态（active）

   一个页面只有两个「视态」，没有路由跳转、不开新标签：
     · launch：中央是大输入框，唯一动作是派活；
     · active：同一块主舞台换成对话面 + 顶部行内流水线。
   切换只改 hidden / data-view，动画交给 CSS（styles.css「单页工作台」段）。

   本模块不持有业务状态（DSH 运行态在 agent.js，任务/文件在各自模块），
   只负责「现在该看哪一态」以及通知订阅者，避免模块互相 import 成环。
*/
import { $ } from "./dom.js";

let view = "launch";
const listeners = new Set();

export function currentView() {
  return view;
}

/** @param {(view: "launch" | "active") => void} fn */
export function onView(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 切换视态（幂等）。返回最终视态，便于调用方串行编排。 */
export function setView(next) {
  const want = next === "active" ? "active" : "launch";
  if (want === view) {
    sync();
    return view;
  }
  view = want;
  sync();
  for (const fn of listeners) {
    try {
      fn(view);
    } catch {
      /* 单个订阅者故障不影响其他域 */
    }
  }
  return view;
}

function sync() {
  const stage = $("#stage");
  if (stage) stage.dataset.view = view;
  const launch = $("#launchView");
  if (launch) launch.hidden = view !== "launch";
  const active = $("#activeView");
  if (active) active.hidden = view !== "active";
  document.body.classList.toggle("view-active", view === "active");
  $("#navLaunch")?.classList.toggle("active", view === "launch");
  $("#btnOpenAgent")?.classList.toggle("active", view === "active");
  // 回到发射态就把焦点放回输入框：打开软件后第一件事就是敲字
  if (view === "launch") setTimeout(() => $("#omniInput")?.focus?.(), 60);
}
