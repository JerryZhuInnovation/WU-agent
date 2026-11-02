"""控制中心的模型密钥核验编排：后台线程刷新 + 跨进程共享快照。

从 server/app.py 拆出（2026-10-24 模块化重构）。核验算法在 core/model_health
（纯函数、可单测）；本模块只管「何时刷、刷完同步给谁」的编排与线程安全。
改核验行为改 core/model_health.py，改刷新策略改本模块。
"""

from __future__ import annotations

import threading

from core import model_health
from core.config import load_config
from core.log import log
from core.paths import HEALTH_JSON, HEALTH_SHARED

# 同一时刻只允许一个刷新线程：开页/改模型都可能触发，并发只会重复打网络
HEALTH_LOCK = threading.Lock()
HEALTH_STATE: dict = {"running": False, "checkedAt": None}


def model_health_states(cfg: dict | None = None) -> tuple:
    """取每个模型的密钥核验状态；发现过期就在后台刷新（本函数不联网、不阻塞）。

    返回 (states, meta)。states 为空字典表示还没有任何核验结果。
    """
    cfg = cfg or load_config()
    models = cfg.get("models") or []
    cache = model_health.load_cache(HEALTH_JSON)
    states = model_health.states_for(cache, models)
    stale = any(st.get("state") == "pending" for st in states.values())
    if stale:
        start_health_refresh(cfg)
    meta = {"checkedAt": cache.get("updatedAt"),
            "refreshing": bool(HEALTH_STATE.get("running"))}
    return states, meta


def start_health_refresh(cfg: dict | None = None) -> None:
    """后台跑一次核验（同一时刻只允许一个线程），结果落盘并同步给路由器。"""
    with HEALTH_LOCK:
        if HEALTH_STATE.get("running"):
            return
        HEALTH_STATE["running"] = True

    def worker() -> None:
        try:
            models = (cfg or load_config()).get("models") or []
            cache = model_health.load_cache(HEALTH_JSON)
            fresh = model_health.refresh(cache, models)
            model_health.save_cache(HEALTH_JSON, fresh)
            shared_ok = model_health.write_shared(
                HEALTH_SHARED, model_health.shared_payload(fresh, models))
            HEALTH_STATE["checkedAt"] = fresh.get("updatedAt")
            dead = model_health.dead_ids(fresh, models)
            if dead:
                log(f"模型核验：{len(dead)} 个模型密钥失效，已从路由候选中排除 -> {', '.join(dead)}")
            if not shared_ok:
                # 路由器靠这个快照跳过失效模型；写不进去必须让用户看见，不能静默失效
                log(f"模型核验结果无法写入 {HEALTH_SHARED}（多为沙箱限制）。"
                    "请退出当前控制中心，改用 Finder 双击 start.command 启动。")
        except Exception as e:
            log(f"模型核验失败: {e}")
        finally:
            with HEALTH_LOCK:
                HEALTH_STATE["running"] = False

    threading.Thread(target=worker, daemon=True).start()


def invalidate_model_health(model_ids: list, cfg: dict) -> None:
    """模型被改动或删除：丢掉旧核验结果并立刻重测（响应不等网络）。"""
    cache = model_health.load_cache(HEALTH_JSON)
    for mid in model_ids:
        cache = model_health.drop(cache, mid)
    try:
        model_health.save_cache(HEALTH_JSON, cache)
    except OSError:
        pass
    start_health_refresh(cfg)
