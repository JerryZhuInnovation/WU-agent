"""WU ai 凭据代理（P2-9）——让沙箱与 DSH 进程「看不见」真 Key。

背景：P0 批次把明文 Key 的两处落点（DSH 进程 env / .credentials.yaml）从
「随手可读」压到「应用层拦截」，但只要 Key 还在 DSH 进程环境里，沙箱内
`env` 一条命令仍能取走——应用层是缓解，不是根治。

本模块把根治好：模型 baseURL 指向本机代理，DSH 与沙箱只见**占位符**；
真 Key 只活在本进程内存，代理按「目标 host 白名单 + 每启动随机 token」
注入后转发。拿到占位符的人无法向真实 provider 冒用（provider 认的是真
Key），也无法把代理当开放中继（host 白名单 + token 双闸）。

与 DSH 的对接（0.2.0-rc.x 实测）：
- settings.yaml provider.baseURL → http://127.0.0.1:<port>/p/<model_id>
- settings.yaml provider.headers → X-WU-Proxy-Token（pi-ai 适配器会把
  provider 声明的 headers 合并进每个请求，见 dsh-llm-pi-ai requestHeaders）
- .credentials.yaml / 进程 env → 占位符（assertUsableApiKey 只要求
  header 安全字符，占位符满足）
- 本地模型（无 Key）不走代理：没有可保护的东西，不增加故障点

失败降级：代理起不来（端口冲突等）时调用方回退直连模式（真 Key 进 env），
并大声记日志——功能故障必须可见，不能静默失效。
"""

from __future__ import annotations

import http.client
import http.server
import json
import secrets
import threading
import urllib.parse

from core.log import log
from core.paths import DATA, HOST
from server.shim import SseTransformer, normalize_full_response, sanitize_outbound

# 占位符前缀：出现在 env / credentials / 日志里都可一眼认出「这不是真 Key」
PLACEHOLDER_PREFIX = "wuai-proxy-placeholder-"
# 代理认证头名（settings.yaml provider.headers 注入，值 = 每启动随机 token）
TOKEN_HEADER = "X-WU-Proxy-Token"
# 固定端口：DSH 可比控制中心长寿。代理若每次启动换随机端口，控制中心一旦重启
# （DSH 不重启），旧 DSH 的所有模型请求都会 Connection error（2026-10-26 实测：
# 18:48 启动的 DSH 在 19:41 控制中心重启后全断连）。固定端口 + 持久 token 让
# 重启对运行中的 DSH 透明。3801 避开控制中心的备用端口区间（3781–3795）。
PROXY_PORT = 3801
# token 持久化：重启后沿用同一 token，旧 DSH 的 settings/profile patch 继续有效。
# 落盘保护级别与既有落点（DSH 侧 profile patch）一致——token 本就写在那里。
TOKEN_FILE = DATA / "cred-proxy.json"
# 上游连接超时：连接 10s；单次收发 600s（长任务生成可能很久）
_CONNECT_TIMEOUT = 10.0
_IO_TIMEOUT = 600.0
# 不透传的逐跳头
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length",
}


def placeholder_for(model_id: str) -> str:
    """生成占位符（header 安全字符：provider 的 key 校验只拒控制字符）。"""
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in str(model_id))
    return f"{PLACEHOLDER_PREFIX}{safe}"


def _load_persisted_token() -> str | None:
    try:
        data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        token = str(data.get("token") or "")
        return token or None
    except (OSError, ValueError):
        return None


def _persist_token(token: str) -> None:
    """token 落盘（0600，临时文件 + rename 原子替换）；失败只降级为每次随机。"""
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = TOKEN_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"token": token}), encoding="utf-8")
        tmp.chmod(0o600)
        tmp.replace(TOKEN_FILE)
    except OSError as e:
        log(f"凭据代理 token 落盘失败（{e}），重启后 DSH 需重新对齐配置")


class _Handler(http.server.BaseHTTPRequestHandler):
    """代理请求处理器：/p/<model_id>/<upstream...> → 注入真 Key 转发。"""

    server_version = "WU-CredentialProxy/1"
    protocol_version = "HTTP/1.1"

    # ---------------------------------------------------------------- 工具

    def _deny(self, code: int, reason: str) -> None:
        body = json.dumps({"ok": False, "reason": reason}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    def _proxy(self) -> "CredentialProxy":
        return self.server.proxy  # type: ignore[attr-defined]

    # ---------------------------------------------------------------- 转发

    def do_GET(self) -> None:
        self._forward()

    def do_POST(self) -> None:
        self._forward()

    def _forward(self) -> None:
        proxy = self._proxy()
        parts = self.path.split("/", 3)  # ['', 'p', '<id>', '<rest...>']
        if len(parts) < 3 or parts[1] != "p":
            self._deny(404, "not found")
            return
        model_id = urllib.parse.unquote(parts[2])
        rest = parts[3] if len(parts) > 3 else ""

        route = proxy.route_for(model_id)
        if route is None:
            # 与 token 错误同一形态：不泄露「哪个 id 存在」
            self._deny(404, "not found")
            return
        if self.headers.get(TOKEN_HEADER) != proxy.token:
            log(f"凭据代理：token 校验失败（model={model_id}）")
            self._deny(401, "unauthorized")
            return
        if not proxy.host_allowed(route["baseURL"]):
            log(f"凭据代理：目标 host 不在白名单（model={model_id}）")
            self._deny(403, "forbidden host")
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        # 协议垫片（出站）：剥掉第三方网关不认的 DeepSeek 专属字段、修 null content
        body = sanitize_outbound(body)
        self._relay(route, rest, body)

    def _relay(self, route: dict, rest: str, body: bytes | None) -> None:
        base = route["baseURL"].rstrip("/")
        target = f"{base}/{rest.lstrip('/')}"
        parsed = urllib.parse.urlparse(target)
        conn_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(parsed.hostname, parsed.port, timeout=_CONNECT_TIMEOUT)
        try:
            conn.connect()
            # 连接建立后切换到长超时：SSE/长生成两个 token 之间可能远超 10s
            if conn.sock is not None:
                conn.sock.settimeout(_IO_TIMEOUT)
        except Exception:
            pass  # connect 阶段的失败由下方 conn.request 统一兜底成 502

        # 逐跳头 + 客户端自带的 Authorization/token 全部剥掉，注入真 Key
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in _HOP_BY_HOP
            and k.lower() not in ("authorization", "host", "content-length", TOKEN_HEADER.lower())
        }
        headers["Authorization"] = f"Bearer {route['apiKey']}"
        headers["Host"] = parsed.netloc
        # 垫片要逐行解析 SSE：上游压缩会让整条流不可读（gzip 一旦启用，
        # 这里就只能原样透传，思考流归一化静默失效）——固定要求 identity
        headers["Accept-Encoding"] = "identity"

        # origin-form 请求行（path?query）：绝对 URL 形态虽有标准允许，
        # 但部分 provider 网关只认 origin-form——按最保守的来。
        origin = parsed.path or "/"
        if parsed.query:
            origin = f"{origin}?{parsed.query}"

        try:
            conn.request(self.command, origin, body=body, headers=headers)
            resp = conn.getresponse()
            raw = resp.read1  # 流式读：SSE 不分片缓冲
        except Exception as e:  # 上游不可达：502，不带任何上游细节
            conn.close()
            self._deny(502, f"upstream error: {type(e).__name__}")
            return

        ctype = (resp.getheader("Content-Type") or "").lower()
        # 垫片（入站）：SSE 逐行归一化思考流/工具调用；JSON 整包归一化。
        # 其它内容类型（二进制、错误页）一律原样透传。
        sse = "text/event-stream" in ctype
        as_json = "application/json" in ctype
        transformer = SseTransformer() if sse else None

        if as_json and not sse:
            # 非流式：本就要读完才知道怎么改，直接缓冲后用新长度回写
            try:
                buffered = resp.read()
            except Exception:
                buffered = b""
            normalized = normalize_full_response(buffered)
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() in _HOP_BY_HOP or k.lower() in ("server", "content-length"):
                    continue
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(normalized)))
            self.end_headers()
            try:
                self.wfile.write(normalized)
            except OSError:
                pass
            conn.close()
            return

        try:
            self.send_response(resp.status)
            passthrough = {
                k: v for k, v in resp.getheaders()
                if k.lower() not in _HOP_BY_HOP and k.lower() != "server"
            }
            declared_len = None
            for k, v in passthrough.items():
                if k.lower() == "content-length":
                    # SSE 会被改写字节长度，绝不能沿用上游长度（否则客户端一直等剩余字节）
                    if sse:
                        continue
                    declared_len = int(v)
                self.send_header(k, v)
            chunked = declared_len is None
            if chunked:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            while True:
                try:
                    chunk = raw(65536)
                except Exception:
                    break
                if not chunk:
                    break
                if transformer is not None:
                    chunk = transformer.feed(chunk)
                    if not chunk:
                        continue
                if chunked:
                    self.wfile.write(b"%X\r\n" % len(chunk) + chunk + b"\r\n")
                else:
                    self.wfile.write(chunk)
                self.wfile.flush()
            if transformer is not None:
                tail = transformer.flush()
                if tail:
                    if chunked:
                        self.wfile.write(b"%X\r\n" % len(tail) + tail + b"\r\n")
                    else:
                        self.wfile.write(tail)
                    self.wfile.flush()
            if chunked:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
        except OSError:
            pass  # 客户端中途断开：安静结束，不刷错误日志
        finally:
            conn.close()

    def log_message(self, fmt, *args) -> None:  # 静默默认访问日志
        pass


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, proxy: "CredentialProxy"):
        self.proxy = proxy
        super().__init__(addr, handler)


class CredentialProxy:
    """本机凭据代理。providers: {model_id: {"baseURL": str, "apiKey": str}}"""

    def __init__(self, providers: dict):
        self._lock = threading.Lock()
        self._providers = dict(providers)
        self._hosts = {urllib.parse.urlparse(p["baseURL"]).hostname for p in providers.values() if p.get("baseURL")}
        self._hosts.discard(None)
        # token 跨重启复用：旧 DSH 的 settings/profile patch 在控制中心重启后继续有效
        self.token = _load_persisted_token() or secrets.token_hex(16)
        _persist_token(self.token)
        self._httpd: _Server | None = None
        self.port = 0

    # ------------------------------------------------------------ 查询面

    def placeholder_for(self, model_id: str) -> str:
        """占位符（写进 DSH env/credentials；真 Key 不在任何 DSH 侧文件）。"""
        return placeholder_for(model_id)

    def route_for(self, model_id: str) -> dict | None:
        with self._lock:
            r = self._providers.get(model_id)
            return dict(r) if r else None

    def host_allowed(self, base_url: str) -> bool:
        host = urllib.parse.urlparse(base_url).hostname
        return host in self._hosts

    def base_url_for(self, model_id: str) -> str:
        """写进 settings.yaml 的 baseURL（model_id 做 URL 编码防路径注入）。"""
        quoted = urllib.parse.quote(str(model_id), safe="")
        return f"http://{HOST}:{self.port}/p/{quoted}"

    def token_headers(self) -> dict:
        return {TOKEN_HEADER: self.token}

    def status(self) -> dict:
        return {
            "active": self._httpd is not None,
            "mode": "proxy",
            "port": self.port,
            "providers": sorted(self._providers.keys()),
        }

    # ------------------------------------------------------------ 生命周期

    def start(self) -> bool:
        if self._httpd is not None:
            return True
        # 优先固定端口（对运行中的 DSH 透明）；被占则退回随机端口（功能可用，
        # 但旧 DSH 指向固定端口的配置需要重新对齐——大声记日志）
        for port in (PROXY_PORT, 0):
            try:
                self._httpd = _Server((HOST, port), _Handler, self)
                break
            except OSError:
                continue
        if self._httpd is None:
            log(f"凭据代理启动失败（端口 {PROXY_PORT} 及随机端口均不可用），本次回退直连模式：DSH 进程将持有明文 Key")
            return False
        self.port = self._httpd.server_address[1]
        if self.port != PROXY_PORT:
            log(f"凭据代理固定端口 {PROXY_PORT} 被占，退回随机端口 {self.port}——旧 DSH 需重新对齐配置")
        threading.Thread(target=self._httpd.serve_forever, name="wuai-cred-proxy", daemon=True).start()
        log(f"凭据代理就绪: 127.0.0.1:{self.port}（{len(self._providers)} 个云端模型走占位符）")
        return True

    def stop(self) -> None:
        if self._httpd is None:
            return
        try:
            self._httpd.shutdown()
            self._httpd.server_close()
        except OSError:
            pass
        self._httpd = None
        log("凭据代理已停止")

    def update_providers(self, providers: dict) -> None:
        """配置变更热更（DSH 侧下一请求即读新 profile，无需重启）。"""
        with self._lock:
            self._providers = dict(providers)
            self._hosts = {urllib.parse.urlparse(p["baseURL"]).hostname for p in providers.values() if p.get("baseURL")}
            self._hosts.discard(None)


# ---------------------------------------------------------------- 模块级单例

_active: CredentialProxy | None = None


def active() -> CredentialProxy | None:
    return _active


def providers_from_config(cfg: dict) -> dict:
    """从 WU 配置提取「需要代理的云端模型」（有 Key 才有可保护的东西）。"""
    out = {}
    for m in cfg.get("models") or []:
        if not m.get("enabled"):
            continue
        key = (m.get("apiKey") or "").strip()
        base = (m.get("baseURL") or "").strip()
        if not key or not base:
            continue
        if m.get("access") == "local":
            continue
        out[str(m["id"])] = {"baseURL": base, "apiKey": key}
    return out


def start_for(cfg: dict) -> CredentialProxy | None:
    """为 DSH 准备代理。幂等：代理随控制中心常驻（生命周期 = 控制中心进程），
    已在跑就只热更 provider 集合；无可保护模型 → None（直连模式，无秘密可泄）。"""
    global _active
    providers = providers_from_config(cfg)
    if _active is not None:
        _active.update_providers(providers)
        return _active
    if not providers:
        return None
    proxy = CredentialProxy(providers)
    if not proxy.start():
        return None
    _active = proxy
    return proxy


def stop() -> None:
    global _active
    if _active is not None:
        _active.stop()
        _active = None


def status() -> dict:
    if _active is None:
        return {"active": False, "mode": "direct", "port": 0, "providers": []}
    return _active.status()
