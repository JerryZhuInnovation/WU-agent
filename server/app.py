"""WU ai 控制中心 HTTP 服务：全部 API + 静态前端 + 启动编排（main）。

API 全表与语义见 README「控制中心」。本模块只做请求编排；
配置在 core/config，DSH 交互在 dsh/，进程起停在 server/launcher，
工作台数据在 server/workspace，密钥核验编排在 server/health。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from core.config import (
    CAPABILITIES,
    cfg_default_brain,
    load_config,
    normalize_models,
    save_config,
)
from core.keystore import mask_key
from core.log import log
from core.paths import (
    DSH_HOME,
    HOST,
    UI_DIR,
    ensure_dirs,
)
from dsh import manager
from dsh.upgrade import upgrade_runtime
from server import credential_proxy, guard, launcher, shadow, workspace
from server.health import (
    invalidate_model_health,
    model_health_states,
    start_health_refresh,
)
from server.presence import (
    agent_seen_ago,
    client_seen_ago,
    mark_agent_seen,
    mark_client_seen,
)

# 控制中心端口：WUAI_PORT 可指定；端口占用时顺延（main 内改写）
PORT = int(os.environ.get("WUAI_PORT", "3780"))

# 本地模型（llama.cpp 等 OpenAI 兼容网关）的兜底地址：只在模型没填 baseURL 时用
LOCAL_GATEWAY_URL = "http://127.0.0.1:8080/v1"


def port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((HOST, port)) == 0

# 升级编排状态（/api/runtimes/upgrade 后台线程；/api/runtimes 轮询展示）
UPGRADE_STATE: dict = {"running": False, "log": [], "report": None}
UPGRADE_LOCK = threading.Lock()

CLIENT_SEEN_STALE_SECONDS = 20.0


def _status_probe(timeout: float = 1.5) -> dict | None:
    """向本机控制中心实例取 /api/status；不可达或非 JSON 返回 None。"""
    try:
        req = urllib.request.Request(f"http://{HOST}:{PORT}/api/status", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def control_center_client_recent() -> bool:
    """页面是否还开着（心跳未超时）。"""
    data = _status_probe()
    ago = (data or {}).get("clientSeenAgo")
    return isinstance(ago, (int, float)) and ago <= CLIENT_SEEN_STALE_SECONDS


def control_center_alive() -> bool:
    data = _status_probe()
    return data is not None and "dsh" in data


def _pid_command(pid: int) -> str:
    """取进程命令行（取不到返回空串）。"""
    ps = shutil.which("ps")
    if not ps:
        return ""
    try:
        return subprocess.check_output(
            [ps, "-o", "command=", "-p", str(pid)], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def _kill_stale_control_center(port: int) -> None:
    """端口被同工程的旧实例占用时结束它。

    只认命令行里带 start.py 的进程——绝不误杀占用同一端口的其它应用。
    """
    lsof = shutil.which("lsof")
    if not lsof:
        return
    try:
        pids = [
            int(s) for s in subprocess.check_output(
                [lsof, "-ti", f"tcp:{port}"], text=True, stderr=subprocess.DEVNULL
            ).split() if s.isdigit()
        ]
    except (OSError, subprocess.SubprocessError):
        return
    killed = False
    for pid in pids:
        if pid == os.getpid() or "start.py" not in _pid_command(pid):
            continue
        try:
            os.kill(pid, 15)
            killed = True
        except OSError:
            continue
    if killed:
        time.sleep(0.4)


def _pick_port(start: int) -> int:
    """start 端口被非本工程进程占用时，向后顺延找空闲端口；全占则退出。"""
    for alt in range(start + 1, start + 16):
        if not port_in_use(alt):
            return alt
    print("端口占用，请设 WUAI_PORT=3900")
    sys.exit(1)


# ---------------------------------------------------------------- 工作台数据面
# workspace_payload / workflows / pending-task / sandbox_status 已移至 server/workspace.py；
# 模型密钥核验编排已移至 server/health.py。HTTP 接线见下方 do_GET/_handle_post。

def _write_dsh_config_live(cfg: dict) -> None:
    """配置变更 → 重写 DSH 侧配置；代理活跃时同步热更 provider 集合。

    DSH 的 pi-ai 适配器每个请求都重读 profile（0.2.0 实测），所以改模型/密钥
    不必重启 Agent 即生效；代理侧必须同步换 provider 集合，否则新模型会漏掉
    占位符重写、被删模型的 host 会留在白名单里。
    """
    from dsh.profile_patch import write_dsh_config

    proxy = credential_proxy.active()
    if proxy is not None:
        proxy.update_providers(credential_proxy.providers_from_config(cfg))
    write_dsh_config(cfg, proxy=proxy)
    _reconcile_sessions(cfg)


def _reconcile_sessions(cfg: dict) -> None:
    """模型改名/删除后立刻修正会话缓存里的旧 provider/model。

    否则旧会话下一次请求会撞 DSH 的 `no adapter registered for provider`，
    整轮直接失败（标题生成这类不走路由的调用同样中招）。
    """
    try:
        n = launcher.reconcile_session_models(cfg)
        if n:
            log(f"已修正 {n} 个会话的失效选模记录")
    except Exception as e:
        log(f"修正会话选模记录失败: {e}")


_WU_BUILD_RE = re.compile(r'WU_BUILD\s*=\s*"([0-9]+)"')


def _wu_ui_build() -> str | None:
    """从已构建的插件产物里读注入的构建戳（启动后缓存一次）。"""
    global _WU_BUILD_CACHED
    if "_WU_BUILD_CACHED" in globals():
        return _WU_BUILD_CACHED
    stamp = None
    try:
        dist = Path(__file__).resolve().parent.parent / "plugins" / "wu-ai-ui" / "dist" / "client.js"
        m = _WU_BUILD_RE.search(dist.read_text(encoding="utf-8", errors="replace")[:200_000])
        stamp = m.group(1) if m else None
    except OSError:
        pass
    _WU_BUILD_CACHED = stamp
    return stamp


def runtime_summary() -> dict:
    """轻量摘要（不跑兼容测试）：控制中心 /api/catalog 每次都带。"""
    key = manager.active_key()
    info = manager.find(key)
    return {
        "key": key,
        "version": info.version if info else None,
        "activeDir": info.dir if info else None,
        "previous": manager.previous_key(),
    }


class ReusableHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def log_message(self, fmt, *args):
        log(f"HTTP {self.address_string()} {fmt % args}")

    def _origin_ok(self) -> bool:
        """CSRF/跨域收紧：只信任本机页面（对话页 3080 / 控制中心 3780）与同源请求。

        浏览器跨站请求必带 Origin：非本机 Origin 一律拒绝，堵住「任意网页驱动
        控制中心」的攻击面；curl 等无 Origin 的本机工具不受影响。"""
        origin = (self.headers.get("Origin") or "").strip()
        if not origin or origin == "null":
            return not origin
        try:
            p = urlparse(origin)
        except ValueError:
            return False
        host = (p.hostname or "").lower()
        if host in ("127.0.0.1", "localhost", "::1"):
            return True
        # 同源访问（如经局域网 IP 打开控制中心）：Origin 与 Host 一致即信任
        return (self.headers.get("Host") or "").strip().lower() == (p.netloc or "").lower()

    def end_headers(self):
        # 避免浏览器缓存旧版控制中心 JS/CSS；跨域仅放行本机页面（对话页 3080 → 控制中心 3780）
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            origin = (self.headers.get("Origin") or "").strip()
            if self._origin_ok():
                self.send_header("Access-Control-Allow-Origin", origin or "*")
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, X-Requested-With",
            )
        if path.endswith((".html", ".js", ".css")) or path == "/":
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        # CORS 预检（POST + application/json 会触发）；非本机来源拒绝
        if not self._origin_ok():
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _stream_task_events(self) -> None:
        """SSE：把 perf.jsonl 里新增的流水线事件实时推给执行态的四步条。

        约束：只推路由插件的真实埋点（没有埋点就没有动画）；最长 15 分钟或客户端
        断开即结束，浏览器 EventSource 自动重连——重连带 offset 续读，不重复回放。
        """
        if not self._origin_ok():
            self._json(403, {"ok": False, "message": "禁止的请求来源"})
            return
        query = parse_qs(urlparse(self.path).query)
        # 令牌是不透明字符串（首字节签名:偏移），只做透传，不解析成数字
        offset = (query.get("offset") or [""])[0]
        if not offset:
            offset = workspace.perf_offset()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        seq = 0
        last_ping = time.time()
        deadline = time.time() + 15 * 60
        try:
            ready = json.dumps({"offset": offset})
            self.wfile.write(f"retry: 1500\nevent: ready\ndata: {ready}\n\n".encode("utf-8"))
            self.wfile.flush()
            while time.time() < deadline:
                offset, events = workspace.read_perf_since(offset)
                for ev in events:
                    seq += 1
                    payload = json.dumps(ev, ensure_ascii=False)
                    self.wfile.write(f"id: {seq}\nevent: perf\ndata: {payload}\n\n".encode("utf-8"))
                if events:
                    self.wfile.flush()
                elif time.time() - last_ping > 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.time()
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError):
            # 页面切走/刷新：静默结束，不影响其他请求
            pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            mark_client_seen()
        if path == "/api/heartbeat":
            # kind=agent 来自 Agent 页面插件的心跳；默认视为控制中心页面心跳
            query = parse_qs(urlparse(self.path).query)
            if (query.get("kind") or [""])[0] == "agent":
                mark_agent_seen()
            else:
                mark_client_seen()
            self._json(200, {"ok": True})
            return
        if path == "/api/catalog":
            cfg = load_config()
            health, health_meta = model_health_states(cfg)
            public_models = []
            for m in cfg["models"]:
                public_models.append(
                    {
                        **{k: v for k, v in m.items() if k != "apiKey"},
                        "apiKeyMasked": mask_key(m.get("apiKey") or ""),
                        "apiKeyConfigured": bool(m.get("apiKey")) or m.get("access") == "local",
                        "keyStatus": health.get(str(m.get("id") or ""), {"state": "pending"}),
                    }
                )
            self._json(
                200,
                {
                    "capabilities": [{"id": k, "label": v} for k, v in CAPABILITIES],
                    "models": public_models,
                    "health": health_meta,
                    "prefer": cfg["prefer"],
                    "routingMode": "smart",
                    "preset": cfg.get("preset") or "wu",
                    "analyzerModelId": cfg["analyzerModelId"],
                    "defaultModelId": cfg["defaultModelId"],
                    "node": {"path": launcher.find_node(), "version": launcher.NODE_VERSION},
                    "dsh": launcher.dsh_running(),
                    "runtime": runtime_summary(),
                    "sandbox": workspace.sandbox_status(),
                    "sandboxPolicy": workspace.sandbox_policy_load(),
                    "credentialProxy": credential_proxy.status(),
                    "workspace": str(launcher.DEFAULT_WORKSPACE),
                },
            )
            return
        if path == "/api/runtimes":
            # Runtime Manager：已安装版本清单 + 各自的 A 层兼容测试（结果缓存，不每次都跑 dump-config）
            node = launcher.find_node()
            items = []
            for info in manager.discover():
                item = {
                    "key": info.key,
                    "kind": info.kind,
                    "version": info.version or "未知",
                    "active": info.active,
                }
                if node:
                    item["compat"] = manager.compat_check(node, info, refresh=False).as_dict()
                else:
                    item["compat"] = {
                        "passed": False,
                        "checks": [{"name": "Node", "status": "fail", "detail": "Node 未安装"}],
                    }
                items.append(item)
            active = manager.active_key()
            active_item = next((i for i in items if i["key"] == active), None)
            with UPGRADE_LOCK:
                upgrade_snap = {
                    "running": UPGRADE_STATE["running"],
                    "log": list(UPGRADE_STATE["log"])[-20:],
                    "report": UPGRADE_STATE["report"],
                }
            self._json(
                200,
                {
                    "ok": True,
                    "runtimes": items,
                    "active": active,
                    "activeVersion": active_item["version"] if active_item else None,
                    "previous": manager.previous_key(),
                    "upgrade": upgrade_snap,
                },
            )
            return
        if path == "/api/status":
            ago = client_seen_ago()
            aago = agent_seen_ago()
            self._json(
                200,
                {
                    "dsh": launcher.dsh_running(),
                    "node": launcher.find_node(),
                    "home": str(DSH_HOME),
                    "clientSeenAgo": None if ago < 0 else round(ago, 1),
                    "agentSeenAgo": None if aago < 0 else round(aago, 1),
                },
            )
            return
        if path == "/api/hardware":
            # local_ai 可选：模块缺失/损坏时降级为空硬件信息，不拖垮控制面
            try:
                from local_ai.runtime import detect_hardware, find_llama_server

                hw = detect_hardware() if detect_hardware else {}
                llama = find_llama_server() if find_llama_server else None
            except Exception as e:
                log(f"local_ai 不可用: {e}")
                hw, llama = {}, None
            self._json(200, {"ok": True, "hardware": hw, "llamaServer": llama})
            return
        if path == "/api/workspace":
            self._json(200, workspace.workspace_payload())
            return
        if path == "/api/workflows":
            self._json(200, {"ok": True, "workflows": workspace.workflows_load()})
            return
        if path == "/api/shadow/status":
            try:
                self._json(200, {"ok": True, **shadow.status()})
            except Exception as e:  # 工作区不可用时不阻断页面
                self._json(200, {"ok": False, "message": str(e)})
            return
        if path == "/api/pending-task":
            # peek=1：只看不取，用于「对话页还没有输入区时先切到会话」的前置判断
            peek = "peek=1" in (urlparse(self.path).query or "")
            task = workspace.pending_task_peek() if peek else workspace.pending_task_take()
            self._json(200, {"ok": True, "task": task})
            return
        if path == "/api/sandbox/raw":
            # 产物原地预览（2026-11-02）：把沙箱工作区里的单个文件按原样回给
            # 甲板内嵌 iframe（html/svg）或 <img>（png/jpg）。路径必须落在
            # 工作区内（guard.resolve 越界即拒），类型白名单外的文件 415。
            q = urlparse(self.path).query
            rel = parse_qs(q).get("path", [""])[0]
            try:
                dest = guard.resolve(rel)
                if not dest.is_file():
                    self._json(404, {"ok": False, "message": "文件不存在"})
                    return
                ext = dest.suffix.lower()
                mime = {
                    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
                    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
                    ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
                }.get(ext)
                if not mime:
                    self._json(415, {"ok": False, "message": "该类型不支持预览"})
                    return
                blob = dest.read_bytes()
            except guard.SandboxEscape as e:
                self._json(403, {"ok": False, "message": str(e)})
                return
            except OSError as e:
                self._json(500, {"ok": False, "message": f"读取失败: {e}"})
                return
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(blob)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(blob)
            except OSError:
                pass
            return
        if path == "/api/tasks":
            # 近期任务 = 影子快照链（每个快照就是一次派发前的现场）
            try:
                snapshots = shadow.history(limit=12)
            except Exception as e:  # 工作区/git 不可用时不阻断左栏
                log(f"任务历史读取失败: {e}")
                snapshots = []
            self._json(
                200,
                {
                    "ok": True,
                    "workspace": guard.display(guard.workspace_root()),
                    "pending": workspace.pending_task_peek(),
                    "snapshots": snapshots,
                },
            )
            return
        if path == "/api/files":
            # 沙箱文件树（左栏导航）。路径一律走 guard，越界直接拒绝
            query = parse_qs(urlparse(self.path).query)
            rel = (query.get("path") or [""])[0]
            try:
                depth = int((query.get("depth") or ["2"])[0])
            except ValueError:
                depth = 2
            try:
                payload = guard.tree(rel, depth)
                self._json(
                    200,
                    {"ok": True, "workspace": guard.display(guard.workspace_root()), **payload},
                )
            except guard.SandboxEscape as e:
                self._json(403, {"ok": False, "message": str(e)})
            except OSError as e:
                self._json(200, {"ok": False, "message": f"读不到工作区：{e}"})
            return
        if path == "/api/task-events":
            query = parse_qs(urlparse(self.path).query)
            offset = (query.get("offset") or ["-1"])[0]
            self._json(200, workspace.task_events(offset))
            return
        if path == "/api/task-stream":
            self._stream_task_events()
            return
        if path == "/api/build":
            # 客户端插件的构建自检锚点：浏览器强缓存旧 client.js 时，
            # 旧脚本每会话来这里比对一次，不一致则 reload 拉新（见 client.ts checkBuildFresh）
            self._json(200, {"wuUiBuild": _wu_ui_build()})
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if not self._origin_ok():
            # 跨站写操作一律拒绝（CSRF）：本机页面与 curl 不受影响
            self._json(403, {"ok": False, "message": "禁止的请求来源"})
            return
        try:
            body = self._read_json()
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "message": "无效 JSON"})
            return
        try:
            self._handle_post(path, body)
        except Exception as e:
            log(f"POST {path} 异常: {e}")
            try:
                self._json(500, {"ok": False, "message": f"服务错误：{e}"})
            except Exception:
                pass

    def _handle_post(self, path: str, body: dict) -> None:
        if path == "/api/shadow/snapshot":
            snap = shadow.snapshot(str(body.get("label") or ""))
            self._json(200, {"ok": bool(snap), "snapshot": snap})
            return
        if path == "/api/shadow/diff":
            # commit 可选：左栏「近期任务」点开的是历史快照，默认对比最近一次
            self._json(
                200,
                shadow.diff(
                    str(body.get("path") or ""),
                    commit=(str(body.get("commit") or "") or None),
                    to=(str(body.get("to") or "") or None),
                ),
            )
            return
        if path == "/api/shadow/accept":
            files = body.get("files")
            if not isinstance(files, list) or not files:
                self._json(400, {"ok": False, "message": "没有指定文件"})
                return
            self._json(200, shadow.accept([str(f) for f in files]))
            return
        if path == "/api/shadow/rollback":
            files = body.get("files")
            self._json(200, shadow.rollback(files=files if isinstance(files, list) else None))
            return
        if path == "/api/pending-task":
            # 工作台发射台下发：控制中心写入，对话页插件 GET 取走（单次）。
            # verifyMode（strict/fast）随任务存投递箱，取件时由 workspace 落 turn-config；
            # 幂等防抖：5 秒内相同派发合并（duplicate=true），不再入箱。
            text = str(body.get("text") or "").strip()
            if not text:
                self._json(400, {"ok": False, "message": "任务内容为空"})
                return
            result = workspace.pending_task_put(
                text, bool(body.get("autoSend", True)), str(body.get("verifyMode") or "strict")
            )
            self._json(200, {"ok": True, **result})
            return
        if path == "/api/upload-image":
            # 多模态派发（2026-11-02）：发射台 Cmd+V 粘贴的截图落进沙箱工作区，
            # 任务文本以相对路径引用它。只收图片；大小上限 20MB。
            import base64 as _b64
            import time as _time

            raw = str(body.get("data") or "")
            name = str(body.get("name") or "paste.png")
            declared = raw.split(",", 1)[0].lower() if "," in raw else ""
            if "," in raw:  # dataURL 前缀
                raw = raw.split(",", 1)[1]
            try:
                blob = _b64.b64decode(raw, validate=True)
            except Exception:
                self._json(400, {"ok": False, "message": "图片数据无效"})
                return
            if not blob:
                self._json(400, {"ok": False, "message": "图片数据为空"})
                return
            if len(blob) > 20 * 1024 * 1024:
                self._json(413, {"ok": False, "message": "图片超过 20MB 上限"})
                return
            # 类型判定：文件名后缀 → dataURL 声明 → 文件头魔数（base64 已解码，直接看字节）
            if name.lower().endswith(".jpg") or name.lower().endswith(".jpeg") or "image/jpeg" in declared:
                ext = ".jpg"
            elif blob[:8] == b"\x89PNG\r\n\x1a\n":
                ext = ".png"
            elif blob[:3] == b"\xff\xd8\xff":
                ext = ".jpg"
            else:
                ext = ".png"
            rel = f".wu-uploads/paste-{_time.strftime('%Y%m%d-%H%M%S')}{ext}"
            try:
                dest = guard.resolve(rel)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(blob)
            except Exception as e:
                self._json(500, {"ok": False, "message": f"保存失败: {e}"})
                return
            log(f"已接收派发截图: {guard.display(dest)} ({len(blob)} 字节)")
            self._json(200, {"ok": True, "path": rel})
            return
        if path == "/api/workflows":
            # 可复用工作流模板（文档 §四.2）：保存目标/步骤/输入要求/质量门槛/输出格式，
            # 不写死模型——执行时由路由器按当前可用模型动态选择
            action = str(body.get("action") or "")
            if action == "save":
                rec, err = workspace.workflow_upsert(body)
                if err:
                    self._json(400, {"ok": False, "message": err})
                    return
                self._json(200, {"ok": True, "workflow": rec})
                return
            if action == "delete":
                workspace.workflow_delete(str(body.get("id") or ""))
                self._json(200, {"ok": True})
                return
            self._json(400, {"ok": False, "message": "未知操作"})
            return
        if path == "/api/artifacts/reveal":
            # 在 Finder 中定位产物文件（工作台文档 §二「工作成果：定位本地存储位置」）
            name = str(body.get("file") or "")
            safe = Path(name).name  # 只允许文件名，拒绝路径穿越
            target = DSH_HOME / "wu-ai-context" / safe
            if not name or not target.exists():
                self._json(404, {"ok": False, "message": "产物不存在"})
                return
            subprocess.run(["open", "-R", str(target)], check=False)
            self._json(200, {"ok": True})
            return
        if path == "/api/config":
            cfg = load_config()
            if "models" in body:
                if not isinstance(body["models"], list):
                    # 防呆：畸形入参（str/dict）会把 models 清空并连带清理密钥，直接拒绝
                    self._json(400, {"ok": False, "message": "models 须为数组"})
                    return
                new_models = normalize_models(body["models"])
                old_by_id = {m["id"]: m for m in cfg.get("models") or []}
                for m in new_models:
                    # 整表保存时若未带明文 Key，保留磁盘上的旧 Key
                    if not m.get("apiKey") and m["id"] in old_by_id:
                        m["apiKey"] = old_by_id[m["id"]].get("apiKey") or ""
                cfg["models"] = new_models
            if "prefer" in body and isinstance(body["prefer"], dict):
                cfg["prefer"] = {str(k): str(v) for k, v in body["prefer"].items() if v}
            # 手动路由已移除：routingMode 恒 smart（仅保留字段兼容）
            cfg["routingMode"] = "smart"
            if "preset" in body:
                # 只保留 WU 模式（DSHY 已移除）：该字段仅为配置兼容保留
                cfg["preset"] = "wu"
            if "analyzerModelId" in body:
                cfg["analyzerModelId"] = str(body["analyzerModelId"] or "")
            if "defaultModelId" in body:
                cfg["defaultModelId"] = str(body["defaultModelId"] or "")
            save_config(cfg)
            _write_dsh_config_live(cfg)
            if "models" in body:
                invalidate_model_health([m["id"] for m in cfg["models"]], cfg)
            self._json(200, {"ok": True, "message": "配置已保存"})
            return

        if path == "/api/preset":
            # 会话内预设切换已随 DSHY 模式移除（只保留 WU）：保留端点做兼容应答
            self._json(200, {"ok": True, "message": "已固定为 WU 模式", "preset": "wu"})
            return

        if path == "/api/models":
            # 增量：添加或更新单个模型
            cfg = load_config()
            model = normalize_models([body])[0] if body.get("id") or body.get("model") else None
            if not model:
                self._json(400, {"ok": False, "message": "缺少模型信息"})
                return
            models = cfg["models"]
            idx = next((i for i, m in enumerate(models) if m["id"] == model["id"]), None)
            if idx is None:
                models.append(model)
            else:
                # 保留未提交的 key
                if not model["apiKey"] and models[idx].get("apiKey"):
                    model["apiKey"] = models[idx]["apiKey"]
                models[idx] = model
            cfg["models"] = models
            if not cfg.get("defaultModelId"):
                cfg["defaultModelId"] = model["id"]
            save_config(cfg)
            _write_dsh_config_live(cfg)
            invalidate_model_health([model["id"]], cfg)
            # 出站响应绝不带明文 Key（传输层只给脱敏形态），见 keystore 安全约定
            resp_model = {**model, "apiKeyMasked": mask_key(model["apiKey"])}
            resp_model.pop("apiKey", None)
            self._json(200, {"ok": True, "message": f"已保存模型 {model['label']}", "model": resp_model})
            return

        if path == "/api/models/delete":
            mid = str(body.get("id") or "")
            cfg = load_config()
            cfg["models"] = [m for m in cfg["models"] if m["id"] != mid]
            if cfg.get("defaultModelId") == mid:
                cfg["defaultModelId"] = cfg["models"][0]["id"] if cfg["models"] else ""
            cfg["prefer"] = {k: v for k, v in (cfg.get("prefer") or {}).items() if v != mid}
            save_config(cfg)
            _write_dsh_config_live(cfg)
            invalidate_model_health([mid], cfg)
            self._json(200, {"ok": True, "message": "已删除"})
            return

        if path == "/api/launch":
            cfg = load_config()
            if body.get("defaultModelId"):
                cfg["defaultModelId"] = body["defaultModelId"]
            save_config(cfg)
            try:
                result = launcher.start_dsh(cfg)
            except Exception as e:
                log(f"启动失败: {e}")
                self._json(500, {"ok": False, "message": f"启动失败：{e}", "url": None})
                return
            self._json(200 if result.get("ok") else 500, result)
            return

        if path == "/api/reauth":
            try:
                launcher.stop_dsh()
                time.sleep(0.8)
                result = launcher.start_dsh(load_config())
            except Exception as e:
                self._json(500, {"ok": False, "message": f"重新登录失败：{e}", "url": None})
                return
            self._json(200 if result.get("ok") else 500, result)
            return

        if path == "/api/stop":
            self._json(200, launcher.stop_dsh())
            return

        if path == "/api/sandbox-policy":
            # P2-10 托管沙箱策略：mode 白名单 + 预算。Agent 侧 escalation 与
            # 会话预算以此为基线（wu-ai-policy.json，0600），用户改后即时生效。
            try:
                rec = workspace.sandbox_policy_save(body.get("policy") or {})
            except ValueError as e:
                self._json(400, {"ok": False, "message": str(e)})
                return
            self._json(200, {"ok": True, "policy": rec})
            return

        if path == "/api/exit":
            # 退出控制中心：先停 Agent，再关闭 HTTP 服务（响应先回，避免连接被掐断）
            result = launcher.stop_dsh()

            def _shutdown_later():
                time.sleep(0.4)
                try:
                    self.server.shutdown()
                except Exception:
                    pass

            threading.Thread(target=_shutdown_later, daemon=True).start()
            self._json(200, {"ok": True, "message": "已退出控制中心", "stop": result})
            return

        if path == "/api/runtimes/check":
            # npm registry 查最新版（network，30-60s 兜底）
            node = launcher.find_node() or launcher.ensure_node()
            try:
                latest = manager.npm_latest(node)
            except Exception as e:
                self._json(500, {"ok": False, "message": f"查询失败：{e}"})
                return
            active = manager.active_key()
            info = manager.find(active)
            cur = info.version if info else None
            self._json(200, {
                "ok": True,
                "latest": latest,
                "activeVersion": cur,
                "newer": bool(latest and cur and latest != cur),
            })
            return

        if path == "/api/runtimes/install":
            # 并排安装新版本到 runtime/dsh/dsh-<版本>/，绝不覆盖旧版；装完跑兼容测试（不自动切换）
            node = launcher.find_node() or launcher.ensure_node()
            version = str(body.get("version") or "").strip()
            if not version:
                try:
                    version = manager.npm_latest(node) or ""
                except Exception:
                    version = ""
            if not version:
                self._json(400, {"ok": False, "message": "未取得版本号（npm 查询失败？）"})
                return
            result = manager.install_runtime(version, node, progress=lambda s: log(s))
            if not result.get("ok"):
                self._json(500, {"ok": False, "message": result.get("message") or "安装失败"})
                return
            info = result["info"]
            compat = manager.compat_check(node, manager.find(info["key"]), refresh=True).as_dict()
            self._json(200, {"ok": True, "message": result.get("message"), "runtime": info, "compat": compat})
            return

        if path == "/api/runtimes/switch":
            # Install → Test → Switch：兼容测试门控，只有 A 层全过才允许切换，切换后自动重启 Agent
            key = str(body.get("key") or "")
            info = manager.find(key)
            if not info:
                self._json(400, {"ok": False, "message": f"未知运行时：{key}"})
                return
            node = launcher.find_node() or launcher.ensure_node()
            report = manager.compat_check(node, info, refresh=True)
            if not report.passed:
                self._json(400, {"ok": False, "message": "兼容测试未通过，已拒绝切换", "compat": report.as_dict()})
                return
            if launcher.dsh_running():
                launcher.stop_dsh()
                time.sleep(0.8)
            manager.mark_active(key)
            log(f"已切换激活运行时 → {key}（{info.version}）")
            try:
                result = launcher.start_dsh(load_config())
            except Exception as e:
                log(f"切换后启动失败: {e}")
                self._json(500, {"ok": False, "message": f"已指向 {key}，但启动失败：{e}（可点「回滚上一版本」）"})
                return
            self._json(200, {
                "ok": True,
                "message": f"已切换到 {info.version or key}，正在启动 Agent",
                "runtime": runtime_summary(),
                **result,
            })
            return

        if path == "/api/runtimes/rollback":
            # 应急通道：不回测、直接切回上一版本并启动
            prev = manager.previous_key()
            if not prev:
                self._json(400, {"ok": False, "message": "没有可回滚的上一版本"})
                return
            info = manager.find(prev)
            if not info:
                self._json(400, {"ok": False, "message": f"上一版本 {prev} 已不存在（可能已被卸载）"})
                return
            if launcher.dsh_running():
                launcher.stop_dsh()
                time.sleep(0.8)
            manager.mark_active(prev)
            log(f"回滚激活运行时 → {prev}（{info.version}）")
            try:
                result = launcher.start_dsh(load_config())
            except Exception as e:
                self._json(500, {"ok": False, "message": f"已回滚到 {prev}，但启动失败：{e}"})
                return
            self._json(200, {
                "ok": True,
                "message": f"已回滚到 {info.version or prev}，正在启动 Agent",
                "runtime": runtime_summary(),
                **result,
            })
            return

        if path == "/api/runtimes/upgrade":
            # 一键升级编排（Install → Test → Switch → Smoke → 失败自动 Rollback），后台线程单飞
            version = str(body.get("version") or "").strip()
            with UPGRADE_LOCK:
                if UPGRADE_STATE["running"]:
                    self._json(409, {"ok": False, "message": "升级已在运行中"})
                    return
                UPGRADE_STATE.update(running=True, log=[], report=None)
            node = launcher.find_node() or launcher.ensure_node()

            def progress(s: str) -> None:
                log(s)
                with UPGRADE_LOCK:
                    UPGRADE_STATE["log"].append(s)

            def _upgrade_worker(n: str) -> None:
                try:
                    report = upgrade_runtime(
                        n,
                        stop_fn=lambda: launcher.stop_dsh(),
                        # 升级编排需要就绪 URL 才能做健康检查 + 契约冒烟；非阻塞启动会被误判为失败
                        start_fn=lambda: launcher.start_dsh(load_config(), wait_ready=90),
                        progress=progress,
                        # 用户在弹窗里确认过的版本，避免升级时再查一次 npm
                        version=version,
                        # WU 模式是唯一预设；新版本起来后必须仍能解析出 wu
                        expect_preset="wu",
                    )
                except Exception as e:
                    log(f"升级编排异常: {e}")
                    report = {"ok": False, "stages": [
                        {"stage": "exception", "ok": False, "detail": f"{type(e).__name__}: {e}"}]}
                finally:
                    with UPGRADE_LOCK:
                        UPGRADE_STATE["report"] = report
                        UPGRADE_STATE["running"] = False

            threading.Thread(target=_upgrade_worker, args=(node,), daemon=True).start()
            self._json(202, {"ok": True, "message": "升级已开始（后台执行）"})
            return

        if path == "/api/llama/install":
            try:
                from local_ai.runtime import ensure_llama_cpp
            except Exception as e:
                self._json(500, {"ok": False, "message": f"local_ai 模块不可用: {e}"})
                return
            try:
                result = ensure_llama_cpp(progress=lambda s: log(s))
                self._json(200, {"ok": True, **result})
            except Exception as e:
                self._json(500, {"ok": False, "message": str(e)})
            return

        if path == "/api/intel/research":
            # 用已配置的 Router Brain（云端或本地）研究一个模型能力
            mid = str(body.get("modelKey") or "")
            model_id = str(body.get("modelId") or mid)
            hint = str(body.get("preference") or body.get("hint") or "")
            brain_id = str(body.get("brainModelId") or cfg_default_brain())
            cfg = load_config()
            brain = next((m for m in cfg["models"] if m["id"] == brain_id and m.get("enabled")), None)
            if not brain:
                brain = next((m for m in cfg["models"] if m.get("enabled")), None)
            if not mid or not brain:
                self._json(400, {"ok": False, "message": "缺少模型或 Router Brain"})
                return
            node = launcher.find_node() or launcher.ensure_node()
            script = Path(__file__).resolve().parent.parent / "plugins" / "wu-ai-router" / "cli-research.mjs"
            env = launcher.build_env(cfg)
            env["PATH"] = f"{Path(node).parent}:{env.get('PATH', '')}"
            env["DSH_HOME"] = str(DSH_HOME)
            env["WUA_BRAIN_BASE_URL"] = brain.get("baseURL") or LOCAL_GATEWAY_URL
            env["WUA_BRAIN_KEY"] = brain.get("apiKey") or ""
            try:
                out = subprocess.check_output(
                    [
                        node,
                        str(script),
                        "--brain-provider",
                        brain["id"],
                        "--brain-model",
                        brain.get("model") or brain["id"],
                        "--model-key",
                        mid,
                        "--model-id",
                        model_id,
                        "--hint",
                        hint,
                    ],
                    env=env,
                    cwd=str(Path(__file__).resolve().parent.parent),
                    text=True,
                    timeout=90,
                )
                self._json(200, {"ok": True, "output": out[-2000:]})
            except subprocess.CalledProcessError as e:
                self._json(500, {"ok": False, "message": e.output[-800:] or str(e)})
            except Exception as e:
                self._json(500, {"ok": False, "message": str(e)})
            return

        if path == "/api/install-node":
            try:
                path_node = launcher.download_portable_node()
                self._json(200, {"ok": True, "path": path_node})
            except Exception as e:
                self._json(500, {"ok": False, "message": str(e)})
            return

        self._json(404, {"ok": False, "message": "未知接口"})


def open_browser() -> None:
    threading.Timer(0.6, lambda: webbrowser.open(f"http://{HOST}:{PORT}")).start()


def main() -> None:
    global PORT
    ensure_dirs()
    try:
        launcher.ensure_wu_preset()
        launcher.ensure_runtime_patches()
    except Exception as e:
        log(f"ensure_mode_presets: {e}")
    log("WU ai 控制中心启动")

    # 模型密钥核验：后台跑，结果同时写共享快照给路由器（失败不影响启动）
    start_health_refresh()

    # 旧版本收敛：只保留「当前版 + 上一版」。后台跑，避免删目录拖慢开页。
    threading.Thread(target=launcher.prune_stale_runtimes, daemon=True).start()

    if port_in_use(PORT) and control_center_alive():
        # 已在运行：页面还开着（心跳新鲜）就不重复开页；
        # 页面没开/已关闭时，帮用户把控制中心页面打开
        if control_center_client_recent():
            print(f"控制中心已在运行且页面已打开：http://{HOST}:{PORT}（未重复开页）")
        else:
            webbrowser.open(f"http://{HOST}:{PORT}")
            print(f"控制中心已在运行：http://{HOST}:{PORT}（已为你打开页面）")
        return
    if port_in_use(PORT):
        _kill_stale_control_center(PORT)
        if port_in_use(PORT):
            PORT = _pick_port(PORT)
            log(f"改用备用端口 {PORT}")

    try:
        server = ReusableHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        print(f"无法启动控制中心：{e}")
        sys.exit(1)

    # 凭据代理随控制中心常驻（P2-9 生命周期修正，2026-10-26）：DSH 可比控制中心
    # 长寿，代理若只在启动 DSH 时拉起，控制中心重启后旧 DSH 仍指向已死的旧端口，
    # 所有模型请求 Connection error（当天实测）。固定端口 + 持久 token + 启动即拉起
    # → 重启对运行中的 DSH 透明；DSH 每请求重读 profile，配置对齐即刻生效。
    try:
        boot_cfg = load_config()
        boot_proxy = credential_proxy.start_for(boot_cfg)
        if boot_proxy is not None and launcher.dsh_running():
            from dsh.profile_patch import write_dsh_config

            write_dsh_config(boot_cfg, proxy=boot_proxy)
            log(f"凭据代理随启就绪（:{boot_proxy.port}），已对齐运行中 DSH 的模型配置")
    except Exception as e:
        log(f"凭据代理随启失败（下次启动 DSH 时会再拉起）: {e}")

    # Warm Daemon（2026-11-02）：引擎常驻热备。控制中心一起来就后台拉起 DSH，
    # 用户派发时引擎已就绪——「Agent 未运行」黑屏等待与手动「启动 Agent」按钮
    # 全部退场，引擎生命周期不再暴露给用户。失败不阻塞启动（派发时仍会自动拉起）。
    def _warm_daemon() -> None:
        try:
            if launcher.dsh_running():
                log("Warm Daemon: 引擎已在运行，无需预热")
                return
            log("Warm Daemon: 后台预热执行引擎…")
            launcher.start_dsh(load_config())
        except Exception as e:
            log(f"Warm Daemon 预热失败（派发时仍会自动拉起）: {e}")

    threading.Thread(target=_warm_daemon, daemon=True).start()

    log(f"控制中心: http://{HOST}:{PORT}")
    print(f"控制中心: http://{HOST}:{PORT}")
    open_browser()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("收到退出信号")
    finally:
        server.server_close()
