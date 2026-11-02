"""客户端 / Agent 页面活性跟踪（心跳时间戳）。

独立成模块的原因：app.py（HTTP 层）与 launcher.py（启动编排）都要读写
这些状态——留在任一侧都会形成 server 包内循环导入。
"""

from __future__ import annotations

import threading
import time

LAST_CLIENT_SEEN = 0.0
CLIENT_SEEN_LOCK = threading.Lock()
CLIENT_SEEN_STALE_SECONDS = 20.0

LAST_AGENT_SEEN = 0.0
AGENT_SEEN_STALE_SECONDS = 30.0


def mark_client_seen() -> None:
    """页面加载/心跳时调用：记录浏览器里控制中心页面仍然开着。"""
    global LAST_CLIENT_SEEN
    with CLIENT_SEEN_LOCK:
        LAST_CLIENT_SEEN = time.time()


def client_seen_ago() -> float:
    with CLIENT_SEEN_LOCK:
        if not LAST_CLIENT_SEEN:
            return -1.0
        return time.time() - LAST_CLIENT_SEEN


def mark_agent_seen() -> None:
    """Agent 页面（3080）插件心跳调用：记录页面还开着。"""
    global LAST_AGENT_SEEN
    with CLIENT_SEEN_LOCK:
        LAST_AGENT_SEEN = time.time()


def agent_seen_ago() -> float:
    with CLIENT_SEEN_LOCK:
        if not LAST_AGENT_SEEN:
            return -1.0
        return time.time() - LAST_AGENT_SEEN


def agent_page_recent() -> bool:
    ago = agent_seen_ago()
    return ago >= 0 and ago <= AGENT_SEEN_STALE_SECONDS
