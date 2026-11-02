#!/usr/bin/env python3
"""WU ai 模型健康核验 —— 密钥有效性（只读探测）。

控制中心的「就绪 / 可用」原先只看「有没有填 Key」：填错、过期、被撤销的 Key
一样显示就绪，直到智能模式把对话路由过去才暴露。

这里对每个云端模型做一次**只读**探测：`GET {baseURL}/models`（OpenAI 兼容面，
不触发推理、不消耗 token），把结果分类成：

    ok       鉴权通过
    auth     密钥失效（401/403）
    error    端点在，但请求失败
    unknown  判断不了（网络不通 / 端点未提供 /models）—— 绝不当作失败
    missing  压根没填 Key
    local    本地模型，不核验（进程可能没起，核验会误报）

结果带「指纹」（baseURL + Key 的短哈希）缓存到磁盘：改了 Key 或地址，指纹变了
即视为过期，自动重测。绝不落盘明文 Key。
"""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROBE_TIMEOUT = 8
# 缓存有效期：密钥失效是低频事件，10 分钟内复用结果，避免每次开页面都打一轮网络
CACHE_TTL = 600

# 这些状态算「确定不可用」，路由器应跳过；unknown/error 不算（可能只是网络抖动）
DEAD_STATES = ("auth",)

# python.org 发行版的 Python 不带系统信任库（openssl_cafile 指向不存在的路径），
# 直接 https 会 CERTIFICATE_VERIFY_FAILED —— 那样每个云端模型都会被判成「未核验」，
# 等于白测。这里显式挑一个可用的 CA 包，但**始终开启校验**，绝不为了跑通而关验证。
_CA_CANDIDATES = (
    "/etc/ssl/cert.pem",  # macOS 自带
    "/usr/local/etc/openssl@3/cert.pem",
    "/opt/homebrew/etc/openssl@3/cert.pem",
)


def ssl_context() -> ssl.SSLContext:
    """挑一个能用的 CA 包建上下文（certifi 优先，其次系统包，最后用默认）。"""
    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    ctx = ssl.create_default_context()
    if ctx.cert_store_stats().get("x509_ca"):
        return ctx
    for cand in _CA_CANDIDATES:
        if os.path.isfile(cand):
            try:
                return ssl.create_default_context(cafile=cand)
            except Exception:
                continue
    return ctx


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _key_hash(api_key: str) -> str:
    """Key 的短指纹：只用于判断「Key 换了没」，不可逆推原文。"""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:12]


def fingerprint(model: dict) -> str:
    """模型的核验条件指纹：地址或 Key 一变，缓存即失效。"""
    return _key_hash(f"{model.get('baseURL') or ''}\n{model.get('apiKey') or ''}")


def probe_url(base_url: str) -> str:
    return (base_url or "").rstrip("/") + "/models"


def classify(code: int, body: str = "") -> tuple[str, str]:
    """HTTP 结果 → (state, message)。纯函数，便于单测。"""
    if code == 200:
        return "ok", "鉴权通过"
    if code in (401, 403):
        return "auth", "密钥无效或已过期"
    if code in (404, 405, 501):
        # 端点不提供 /models：判断不了，不是失败
        return "unknown", "该端点未提供 /models，无法核验"
    if code == 429:
        return "error", "请求被限流（密钥本身可能有效）"
    if code >= 500:
        return "error", f"服务端错误 HTTP {code}"
    if code:
        return "error", f"HTTP {code}"
    return "unknown", (body or "网络不可达")[:120]


def probe(model: dict, timeout: float = PROBE_TIMEOUT) -> dict:
    """对单个模型做一次只读探测（不发推理请求）。"""
    checked = _now()
    if model.get("access") == "local":
        return {"state": "local", "http": 0, "message": "本地模型，不核验", "checkedAt": checked}
    api_key = str(model.get("apiKey") or "").strip()
    base = str(model.get("baseURL") or "").strip()
    if not api_key:
        return {"state": "missing", "http": 0, "message": "未填写密钥", "checkedAt": checked}
    if not base.startswith("http"):
        return {"state": "unknown", "http": 0, "message": "API 地址无效", "checkedAt": checked}

    req = urllib.request.Request(
        probe_url(base),
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context()) as resp:
            state, message = classify(resp.status, "")
            return {"state": state, "http": resp.status, "message": message, "checkedAt": checked}
    except urllib.error.HTTPError as e:
        state, message = classify(e.code)
        return {"state": state, "http": e.code, "message": message, "checkedAt": checked}
    except Exception as e:
        state, message = classify(0, f"{type(e).__name__}: {e}")
        return {"state": state, "http": 0, "message": message, "checkedAt": checked}


# ---------------------------------------------------------------- 缓存读写

def load_cache(path: Path) -> dict:
    if not path.is_file():
        return {"version": 1, "updatedAt": None, "models": {}}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": 1, "updatedAt": None, "models": {}}
    if not isinstance(raw, dict) or not isinstance(raw.get("models"), dict):
        return {"version": 1, "updatedAt": None, "models": {}}
    return raw


def save_cache(path: Path, cache: dict) -> None:
    """原子落盘（tmp + rename）：崩溃也不会留下半截 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.chmod(0o600)
    os.replace(tmp, path)


def _fresh(entry: dict, model: dict, ttl: float) -> bool:
    if not isinstance(entry, dict):
        return False
    if entry.get("fingerprint") != fingerprint(model):
        return False
    stamp = entry.get("checkedAt") or ""
    try:
        checked = time.mktime(time.strptime(stamp, "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return False
    return (time.time() - checked) < ttl


def states_for(cache: dict, models: list) -> dict:
    """从缓存取每个模型的核验状态（纯读，不联网）。没缓存的报「未核验」。"""
    out = {}
    entries = cache.get("models") or {}
    for m in models or []:
        mid = str(m.get("id") or "")
        if not mid:
            continue
        if m.get("access") == "local":
            out[mid] = {"state": "local", "http": 0, "message": "本地模型，不核验",
                        "checkedAt": None, "verified": False}
            continue
        if not str(m.get("apiKey") or "").strip():
            out[mid] = {"state": "missing", "http": 0, "message": "未填写密钥",
                        "checkedAt": None, "verified": False}
            continue
        entry = entries.get(mid)
        if _fresh(entry, m, CACHE_TTL):
            out[mid] = {
                "state": entry.get("state") or "unknown",
                "http": int(entry.get("http") or 0),
                "message": entry.get("message") or "",
                "checkedAt": entry.get("checkedAt") or None,
                "verified": True,
            }
        else:
            out[mid] = {"state": "pending", "http": 0, "message": "尚未核验或核验已过期",
                        "checkedAt": entry.get("checkedAt") if isinstance(entry, dict) else None,
                        "verified": False}
    return out


def refresh(cache: dict, models: list, ttl: float = CACHE_TTL,
            timeout: float = PROBE_TIMEOUT, force: bool = False) -> dict:
    """探测所有过期/缺失的模型，返回更新后的缓存（原地不改传入对象）。

    并发探测（线程池）：探测是纯 IO 等待，串行会让 N 个慢端点的耗时叠加成
    N×timeout（实测 3 个黑洞端点 + 1 个正常端点：串行 12.1s vs 并发 4.1s），
    拖住后台刷新线程、让「核验中」久挂。单条结果与串行版完全一致
    （分类是纯函数 classify，2026-10-10 实测两版 states 逐项相同）。
    """
    out = {
        "version": 1,
        "updatedAt": cache.get("updatedAt"),
        "models": dict(cache.get("models") or {}),
    }
    changed = False
    todo: list = []
    for m in models or []:
        mid = str(m.get("id") or "")
        if not mid or m.get("access") == "local":
            continue
        entry = out["models"].get(mid)
        if not force and _fresh(entry, m, ttl):
            continue
        if not str(m.get("apiKey") or "").strip():
            out["models"].pop(mid, None)
            changed = True
            continue
        todo.append(m)
    if todo:
        workers = min(8, len(todo))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for m, result in zip(todo, ex.map(lambda mm: probe(mm, timeout), todo)):
                result["fingerprint"] = fingerprint(m)
                out["models"][str(m["id"])] = result
        changed = True
    if changed:
        out["updatedAt"] = _now()
    return out


def drop(cache: dict, model_id: str) -> dict:
    """模型被改过或删除：丢掉它的核验结果，下次自动重测。"""
    out = {
        "version": 1,
        "updatedAt": cache.get("updatedAt"),
        "models": dict(cache.get("models") or {}),
    }
    out["models"].pop(str(model_id), None)
    return out


def dead_ids(cache: dict, models: list) -> list:
    """确定不可用的模型 id（供路由器跳过）。只认缓存的、确定性的失败。"""
    states = states_for(cache, models)
    return sorted(
        mid for mid, st in states.items()
        if st.get("verified") and st.get("state") in DEAD_STATES
    )


def shared_payload(cache: dict, models: list) -> dict:
    """给路由器读的精简快照（跨进程通道：$DSH_HOME/wu-ai-model-health.json）。"""
    states = states_for(cache, models)
    return {
        "version": 1,
        "updatedAt": cache.get("updatedAt"),
        "unhealthy": dead_ids(cache, models),
        "states": {mid: st.get("state") for mid, st in states.items()},
    }


def write_shared(path: Path, payload: dict) -> bool:
    """原子写共享快照（DSH 与路由器实时读，避免各自维护一份）。

    返回是否写成功：沙箱环境会拒绝写 `~/.wu-ai`（EPERM），调用方据此提示用户改用
    双击 start.command 启动 —— 静默失败会让「路由器跳过失效模型」无声失效。
    """
    try:
        save_cache(path, payload)
        return True
    except OSError:
        return False
