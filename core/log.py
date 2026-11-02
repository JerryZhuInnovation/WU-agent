"""统一日志：stdout + data/launcher.log（超过上限自动轮转一代）。"""

from __future__ import annotations

import time

from core.paths import DATA, LAUNCHER_LOG

# 日志轮转：单文件上限 5MB，只保留一代 .log.1；每 500 条检查一次，避免每条都 stat
_MAX_BYTES = 5 * 1024 * 1024
_CHECK_EVERY = 500
_writes = 0


def log(msg: str) -> None:
    global _writes
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        _writes += 1
        if _writes % _CHECK_EVERY == 1 and LAUNCHER_LOG.exists():
            if LAUNCHER_LOG.stat().st_size > _MAX_BYTES:
                LAUNCHER_LOG.replace(LAUNCHER_LOG.with_suffix(".log.1"))
        with LAUNCHER_LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass  # 日志落盘失败（只读沙箱等）不阻断主流程：stdout 已输出
