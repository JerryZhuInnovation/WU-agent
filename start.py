#!/usr/bin/env python3
"""WU ai 控制中心入口（薄壳）。

分层布局：
- core/    控制面核心：paths（路径单一真源）/ log / config / keystore / model_health / migration
- dsh/     DSH 集成层（唯一允许知道 DSH 的 Python 代码）：adapter / manager / upgrade / modes / profile_patch
- server/  控制中心服务：app（HTTP API）/ launcher（进程编排）/ presence（心跳活性）
- local_ai/ 本地 AI：硬件检测 + llama.cpp
- ui/      控制中心前端
- plugins/ Node 侧插件（数据面；pnpm 硬链接，勿移动）
- data/    运行时数据（勿移动）

双击 start.command 或 `python3 start.py` 的入口行为一致。
"""

from __future__ import annotations

import sys
from pathlib import Path

if sys.version_info < (3, 10):
    sys.exit(f"WU ai 需要 Python 3.10+（当前 {sys.version_info.major}.{sys.version_info.minor}）")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.app import main  # noqa: E402

if __name__ == "__main__":
    main()
