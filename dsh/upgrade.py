"""WU ai Runtime API —— Runtime 层的升级编排与运行时契约冒烟测试。

分层（与质量门禁对应）：
- A 层（离线兼容）：runtime_manager.compat_check —— 入口 / 版本 / --dump-config
  配置树可组装 / 运行时补丁，全部不产生 API 消费。
- C 层（契约冒烟）：本模块 contract_smoke —— 对着**已启动**的 web 实例做只读
  HTTP 检查：token 存活（Start）、会话/预设/模型目录 API（Session / Tool /
  Model-switch 表面）、/plugins 合并 bundle 同时包含原版 DSH 插件与我们的
  客户端半体（「兼容原版 DSH 所有插件」的契约）。
- B 层（真实调用，opt-in）：tests/test_runtime_compat.py 里 WUAI_LIVE_TEST=1 时
  直连 provider 做最小 chat + SSE 流式请求，验证 wire 层 Streaming/Model 切换
  真实可用（会产生少量 API 消费，默认关闭）。

升级编排（upgrade_runtime）完全复用 Install → Test → Switch → Rollback：
  查最新 → 并排安装 → A 层兼容门控 → 切激活 → 启动 → C 层冒烟
  → 任一环节失败自动回滚上一版本（应急通道，不回测）。
"""

from __future__ import annotations

import http.cookiejar
import json
import re
import time
import urllib.error
import urllib.request
from typing import Callable
from urllib.parse import urljoin, urlparse

from dsh import manager as runtime_manager  # noqa: F401 — 别名保持调用点零改动


# ---------------------------------------------------------------- HTTP 助手

def _opener() -> urllib.request.OpenerDirector:
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def _post_json(opener, url: str, payload: dict, timeout: float) -> tuple[int, str]:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with opener.open(req, timeout=timeout) as resp:
            body = resp.read(4096).decode("utf-8", "replace")
            return resp.status, body
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read(2048).decode("utf-8", "replace")
        except Exception:
            pass
        return e.code, body
    except Exception as e:
        return 0, str(e)


def _get(opener, url: str, timeout: float) -> tuple[int, str]:
    try:
        with opener.open(url, timeout=timeout) as resp:
            return resp.status, resp.read(200000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)


def _get_head(opener, url: str, timeout: float) -> tuple[int, str, int]:
    """只读响应头部内容：大 bundle（>10MB）不做全量读取，契约只验可达性。"""
    try:
        with opener.open(url, timeout=timeout) as resp:
            size = resp.headers.get("Content-Length")
            head = resp.read(4096).decode("utf-8", "replace")
            return resp.status, head, int(size) if size and str(size).isdigit() else -1
    except urllib.error.HTTPError as e:
        return e.code, "", -1
    except Exception as e:
        return 0, str(e), -1


def _check(name: str, ok: bool, detail: str) -> dict:
    return {"name": name, "status": "ok" if ok else "fail", "detail": detail[:300]}


def _rpc(opener, base: str, key: str, method: str, args: dict, timeout: float) -> dict | None:
    """调用 DSH 的 RPC 端点，返回 `result.value`；任何形态不符都返回 None。

    DSH 的 wire 格式是 `{type: client-request, rpcId, method, payload: {args}}`，
    响应 `result.value`。0.1.x 不认这个 envelope（会返回 gateway/bad-request），
    所以调用方必须把 None 当作「无法判定」而不是「失败」。
    """
    envelope = {"type": "client-request", "rpcId": f"wu-smoke-{key}-{method}",
                "method": f"{key}/{method}", "payload": {"args": args}}
    code, body = _post_json(opener, f"{base}/api/{key}/{method}", envelope, timeout)
    if code != 200:
        return None
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        return None
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(result, dict) or not result.get("ok"):
        return None
    value = result.get("value")
    return value if isinstance(value, dict) else None


# ---------------------------------------------------------------- C 层契约冒烟

# DSH 内置的 DeepSeek 官方提供商 id：WU ai 只用用户添加的模型，这两个必须不在册
OFFICIAL_PROVIDERS = ("deepseek-official", "deepseek-account")


def contract_smoke(base: str, token_url: str, timeout: float = 8,
                   expect_preset: str | None = None) -> list:
    """对运行中的 DSH web 做只读契约检查（C 层）。不产生任何 API 消费。

    expect_preset：升级/切换后应当可解析的预设 id（wu / dshy）。0.2.0 起预设改为
    bundle patch 声明，若声明没写对，`agentPresets/list` 里就查无此人 —— 会话
    resume 会报 `Unknown agent preset`。这里显式核对，避免同类问题再漏过门控。
    """
    base = (base or "").rstrip("/")
    checks: list = []

    opener = _opener()
    # Start：token URL 可访问（带 cookie）
    code, body = _get(opener, token_url, timeout)
    checks.append(_check("Start（token 存活）", code == 200 or (300 <= code < 500), f"HTTP {code}"))

    # Session：会话列表 API
    code, body = _post_json(opener, f"{base}/api/session/list", {}, timeout)
    checks.append(_check("Session（session/list）", code == 200, f"HTTP {code}"))

    # Preset：预设列表 API —— 并核对默认预设真的可解析。
    # 只验 HTTP 200 是空转：底层注册断裂时 DSH 照样回 200（返回 gateway/bad-request
    # 的错误体内包）。所以这里解析 RPC 结果，确认 expect_preset 出现在花名册里。
    value = _rpc(opener, base, "agentPresets", "list", {}, timeout)
    if value is None:
        # 老版本不认这个 envelope → 无法判定，不制造假失败
        code, _ = _post_json(opener, f"{base}/api/agentPresets/list", {}, timeout)
        checks.append({"name": "Preset（默认预设可解析）", "status": "warn",
                       "detail": f"无法解析 agentPresets/list（HTTP {code}，可能是旧版 DSH）"})
    else:
        presets = value.get("presets")
        presets = presets if isinstance(presets, list) else []
        ids = [str(p.get("id")) for p in presets if isinstance(p, dict)]
        default_id = next((str(p.get("id")) for p in presets
                           if isinstance(p, dict) and p.get("isDefault")), "?")
        if expect_preset and expect_preset not in ids:
            checks.append({"name": "Preset（默认预设可解析）", "status": "fail",
                           "detail": f"期望预设 {expect_preset!r} 不在花名册 {ids}；"
                                     f"DSH 当前默认 {default_id!r}，会话将报 Unknown agent preset"})
        else:
            checks.append(_check(
                "Preset（默认预设可解析）", True,
                f"默认 {default_id}；花名册 {ids}" + (f"；期望 {expect_preset} ✅" if expect_preset else "")))

    # Tool：指令清单 API（工具面存在性）
    code, body = _post_json(opener, f"{base}/api/commands/list", {}, timeout)
    checks.append(_check("Tool（commands/list）", code == 200, f"HTTP {code}"))

    # Model switch：模型目录 API（含 reasoningEfforts 面）
    code, body = _post_json(opener, f"{base}/api/session/modelCatalog", {}, timeout)
    checks.append(_check("Model switch（session/modelCatalog）", code == 200, f"HTTP {code}"))

    # 内置提供商契约：WU ai 只用用户添加的模型，DSH 内置的 DeepSeek 官方提供商必须
    # 被停用。0.2.0 把它从 dsh-llm-deepseek 拆成独立插件，早先的文件补丁因此失效，
    # 官方模型重新混进模型选择器 —— 只验 HTTP 200 拦不住，这里按 provider id 核对。
    catalog = _rpc(opener, base, "session", "modelCatalog", {}, timeout)
    if catalog is None:
        checks.append({"name": "内置提供商（已停用）", "status": "warn",
                       "detail": "无法解析 session/modelCatalog，跳过"})
    else:
        groups = [str(g.get("id")) for g in (catalog.get("groups") or [])
                  if isinstance(g, dict) and g.get("id")]
        leaked = [p for p in OFFICIAL_PROVIDERS if p in groups]
        if leaked:
            checks.append({"name": "内置提供商（已停用）", "status": "fail",
                           "detail": f"内置官方提供商仍在册：{leaked}；"
                                     f"模型选择器会出现官方模型（分组 {groups}）"})
        else:
            checks.append(_check("内置提供商（已停用）", True, f"模型分组 {groups}"))

    # 插件契约：合并 bundle 同时含原版 DSH 插件 + 我们的客户端半体。
    # bundle 路由要求「服务端已登记的 id 清单 + 对应 rev」，需从入口页 HTML 里
    # 解析真实 URL（其中必须出现 dsh-wu-ai-ui/client.js 与一眾 @deepseek-ai 插件）。
    #
    # 兼容两种引用形态：
    #  - 0.1.x：路由带前导斜杠（"/plugins/??…"），可直接拼到 origin 后；
    #  - 0.2.0 起：改成**文档相对路径**（"plugins/??…"，去掉前导斜杠），
    #    一律用 urljoin 归一成绝对 URL，避免把旧格式当唯一正确格式。
    # 同一页会出现多条 combo，且 0.2.0 连单插件条目也用 "??"；因此把整页引用
    # 合起来判定「两族插件都被下发」，再挑一条含我们的插件做可达性探测。
    page_code, page = _get(opener, f"{base}/", timeout + 5)
    refs = [r.replace("&amp;", "&") for r in re.findall(
        r"""["'](/?plugins/\?\?[^"']+?rev=[A-Za-z0-9_\-]+)["']""", page or "")]
    all_refs = " ".join(refs)
    has_ours_in_manifest = "dsh-wu-ai-ui/client.js" in all_refs
    has_original_in_manifest = "@deepseek-ai/" in all_refs
    detail = f"入口页 HTTP {page_code}"
    if not refs:
        checks.append(_check("插件契约（原版插件 + wu-ai-ui 并存）", False,
                             f"{detail}，未找到 bundle 清单"))
    else:
        # 探测目标优先选「含我们的插件」的 combo（这才是要证明可下发的东西）
        probe = next((r for r in refs if "dsh-wu-ai-ui/client.js" in r), None) \
            or next((r for r in refs if "," in r and "@deepseek-ai/" in r), None) \
            or refs[0]
        code, head, size = _get_head(opener, urljoin(f"{base}/", probe), timeout + 10)
        checks.append(_check(
            "插件契约（原版插件 + wu-ai-ui 并存）",
            bool(code == 200 and has_ours_in_manifest and has_original_in_manifest
                 and len(head) > 0),
            f"{detail}，bundle HTTP {code}，Content-Length={size}，"
            f"manifest 含两族插件={has_ours_in_manifest and has_original_in_manifest}",
        ))
    return checks


def wait_web(token_url: str, timeout: float = 60, interval: float = 2) -> bool:
    """轮询等待 web 就绪（token URL 可访问）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _token_alive(token_url):
            return True
        time.sleep(interval)
    return False


def _token_alive(token_url: str, timeout: float = 3) -> bool:
    opener = _opener()
    try:
        code, _ = _get(opener, token_url, timeout)
        return code == 200 or (300 <= code < 500)
    except Exception:
        return False


# ---------------------------------------------------------------- 升级编排

def upgrade_runtime(
    node: str,
    stop_fn: Callable[[], None],
    start_fn: Callable[[], dict],
    progress: Callable[[str], None] = None,
    http_timeout: float = 8,
    version: str | None = None,
    expect_preset: str | None = None,
) -> dict:
    """Install → Test → Switch → Smoke → 失败自动 Rollback 的一键升级。

    start_fn 需返回 {"ok": bool, "url": str|None, ...}；stop_fn 幂等。
    version 由控制中心在「检查更新」确认后传入；为空或非法时回退 npm 最新版
    （省掉的这次联网查询若失败，会让用户已经确认过的升级凭空夭折）。
    返回完整报告（stage 序列 + 结果），供控制中心展示与日志归档。
    """
    log = progress or (lambda s: None)
    report: dict = {"ok": False, "latest": None, "key": None,
                    "rolledBack": False, "stages": []}

    # 1. 定版本：优先用控制中心确认过的版本，否则查 npm 最新版
    latest = str(version or "").strip()
    if not latest or not runtime_manager._SAFE_VERSION.match(latest):
        latest = runtime_manager.npm_latest(node)
    report["latest"] = latest
    if not latest:
        report["stages"].append({"stage": "check-update", "ok": False, "detail": "npm 查不到最新版"})
        return report
    report["stages"].append({"stage": "check-update", "ok": True, "detail": f"latest={latest}"})

    active = runtime_manager.active_key()
    cur = runtime_manager.find(active)
    if cur and cur.version == latest:
        report.update(ok=True, key=active)
        report["stages"].append({"stage": "already-latest", "ok": True, "detail": active})
        return report

    # 2. 并排安装（已装则跳过）
    key = f"dsh-{latest}"
    info = runtime_manager.find(key)
    if info is None:
        log(f"安装 DSH {latest} …")
        result = runtime_manager.install_runtime(latest, node, progress=log)
        if not result.get("ok"):
            report["stages"].append({"stage": "install", "ok": False, "detail": result.get("message")})
            return report
        info = runtime_manager.find(key)
        report["stages"].append({"stage": "install", "ok": True, "detail": str(info.dir)})
    else:
        report["stages"].append({"stage": "install", "ok": True, "detail": "已安装"})

    # 3. A 层兼容门控
    compat = runtime_manager.compat_check(node, info, refresh=True)
    report["compat"] = compat.as_dict()
    if not compat.passed:
        report["stages"].append({"stage": "compat", "ok": False, "detail": "A 层兼容测试未通过"})
        return report
    report["stages"].append({"stage": "compat", "ok": True, "detail": "A 层通过"})

    # 4. 切换 + 启动
    prev = active
    log(f"切换运行时 {active} → {key} …")
    try:
        stop_fn()
    except Exception as e:
        report["stages"].append({"stage": "stop-old", "ok": False, "detail": str(e)})
        return report
    report["stages"].append({"stage": "stop-old", "ok": True, "detail": active})
    runtime_manager.mark_active(key)
    report["key"] = key
    try:
        started = start_fn()
    except Exception as e:
        started = {"ok": False, "url": None, "error": str(e)}
    url = started.get("url") if isinstance(started, dict) else None
    if not isinstance(started, dict) or not started.get("ok") or not url:
        report["stages"].append({"stage": "start-new", "ok": False, "detail": str(started)})
    else:
        report["stages"].append({"stage": "start-new", "ok": True, "detail": url})
        # 5. 等就绪 + C 层冒烟
        ready = wait_web(url)
        report["stages"].append({"stage": "web-ready", "ok": ready, "detail": url if ready else "等待超时"})
        if ready:
            smoke = contract_smoke(_base_of(url), url, http_timeout, expect_preset=expect_preset)
            failed = [c for c in smoke if c["status"] == "fail"]
            report["smoke"] = smoke
            report["stages"].append({"stage": "smoke", "ok": not failed,
                                     "detail": f"{len(smoke) - len(failed)}/{len(smoke)} 通过"})

    # 6. 成败定案
    last = report["stages"][-1]
    if last.get("ok"):
        report["ok"] = True
        # 升级成功：只保留「最新版 + 上一版」，清掉更早的运行时，避免目录无限堆积
        # （回滚能力不受影响：上一版一定保留，仍可随时用「回滚上一版本」切回）
        try:
            pruned = runtime_manager.prune_runtimes([report.get("key"), prev], progress=log)
        except Exception as e:
            pruned = {"removed": [], "error": str(e)}
        report["pruned"] = pruned
        if pruned.get("removed"):
            report["stages"].append({
                "stage": "prune",
                "ok": True,
                "detail": "已清理 " + "、".join(pruned["removed"]),
            })
        return report

    # 启动失败 / 冒烟失败 → 自动回滚上一版本（应急通道）
    log(f"升级失败，回滚到 {prev} …")
    report["rolledBack"] = True
    runtime_manager.mark_active(prev)
    try:
        stop_fn()
        rolled = start_fn()
    except Exception as e:
        rolled = {"ok": False, "url": None, "error": str(e)}
    report["stages"].append({
        "stage": "rollback",
        "ok": bool(rolled.get("ok")),
        "detail": f"{prev}: {rolled.get('message') or rolled.get('error') or rolled.get('url')}",
    })
    return report


def _base_of(url: str) -> str:
    """token URL → origin（http://host:port）。"""
    p = urlparse(url)
    return f"{p.scheme}://{p.netloc}"