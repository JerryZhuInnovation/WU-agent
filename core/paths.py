"""WU ai 路径常量 —— 单一真源。

分层重构前，路径常量散布在 start.py / runtime_manager.py / keystore.py 各自为政；
分层后任何模块需要路径都从这里 import，换机器 / 换平台只改这一处。
（交接文档 §17.2「迁移后必须更新的硬编码路径」的收敛点。）
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # wu-ai/
UI_DIR = ROOT / "ui"                            # 控制中心前端（原 www/）
DATA = ROOT / "data"                            # 运行时数据（config/secrets/日志，0600）
RUNTIME = ROOT / "runtime"                      # 便携 Node + DSH 版本目录（数据，勿与 dsh/ 包混淆）

# DSH 活动配置目录与模型工作区（避开 Desktop 的 macOS TCC 权限，见踩坑 #4）
DSH_HOME = Path.home() / ".wu-ai" / "dsh"
DEFAULT_WORKSPACE = Path.home() / "WU-ai-Work"

CONFIG_JSON = DATA / "config.json"
LAUNCHER_LOG = DATA / "launcher.log"
DSH_LOG = DATA / "dsh.log"
PID_FILE = DATA / "dsh.pid"
DSH_URL_FILE = DATA / "dsh.url"
HEALTH_JSON = DATA / "model-health.json"
# 跨进程快照：路由器（跑在 DSH 里）读它来跳过密钥失效的模型
HEALTH_SHARED = DSH_HOME / "wu-ai-model-health.json"
# 用户级配置（与 DSH_HOME 同级，不随仓库搬移）
WU_HOME = Path.home() / ".wu-ai"
WORKFLOWS_JSON = WU_HOME / "workflows.json"
KEYSTORE_SECRET = WU_HOME / ".secret"

HOST = "127.0.0.1"
DSH_PORT = 3080
NODE_VERSION = "22.19.0"
# 控制中心端口不在此定义：PORT 会被备用端口逻辑改写（全局可变），归 server/app 持有


def ensure_dirs() -> None:
    """启动前置：确保所有受管目录存在。"""
    DATA.mkdir(parents=True, exist_ok=True)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    DSH_HOME.mkdir(parents=True, exist_ok=True)
    DEFAULT_WORKSPACE.mkdir(parents=True, exist_ok=True)
