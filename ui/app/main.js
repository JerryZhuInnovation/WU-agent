/* WU ai · 控制中心 —— 入口：加载各域模块（模块加载即完成事件绑定），然后启动

   单页双态（shell.js）：发射态是默认视图，派发后原地切到执行态；
   左栏（sidebar.js）放任务历史，抽屉放低频配置与只读诊断。
*/

// 各模块 import 即完成自己的 DOM 事件绑定与事件订阅；本文件只做启动编排。
import "./models.js";
import "./workspace.js";
import "./omni.js";
import "./runtime.js";
import "./doctor.js";
import "./trace.js";
import "./shadow.js";
import "./allocation.js";
import "./sidebar.js";
import "./pipeline.js";
import "./dock.js";
import "./agent.js";

import { clearBadgeOverride, fetchCatalog, loadHardware, setBadge } from "./state.js";
import { toast } from "./dom.js";
import { refreshWorkspaceCards } from "./workspace.js";
import { refreshTasks } from "./sidebar.js";
import { resumeTask } from "./pipeline.js";
import { showStage } from "./agent.js";
import { loadRuntimes } from "./runtime.js";
import { updateAccessMode } from "./models.js";

/* ============================== 启动 ============================== */

updateAccessMode();
setBadge("working", "◌ 正在检测环境");
fetchCatalog()
  .then(async () => {
    clearBadgeOverride();
    loadHardware();
    // 刷新页面时如果上一轮任务还没收尾，恢复执行态（四步来自真实埋点补算）
    if (await resumeTask()) showStage("frame");
  })
  .catch((e) => {
    toast(e.message || "无法连接控制中心", "err");
    setBadge("warn", "⚠ 未连接");
  });
loadRuntimes().catch(() => {});
refreshWorkspaceCards().catch(() => {});
refreshTasks().catch(() => {});
// 左栏是「导航」：低频刷新即可；执行态的四步条另有 SSE 实时通道
setInterval(() => refreshTasks().catch(() => {}), 30_000);
setInterval(() => refreshWorkspaceCards().catch(() => {}), 60_000);

/* 心跳：让控制中心知道本页面还开着（再点 start.command 时不重复开页） */
function heartbeat() {
  fetch("/api/heartbeat").catch(() => {});
}
heartbeat();
setInterval(heartbeat, 10000);
