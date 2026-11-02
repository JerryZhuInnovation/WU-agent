"""凭据代理（P2-9）测试：渲染占位符 / 转发注入 / 认证 / 流式 / host 白名单。

隔离原则（2026-10-24 事故教训）：core/paths.DSH_HOME 写死不读环境变量，
所有测试用显式临时路径与临时端口，绝不碰真实 ~/.wu-ai/。
"""

from __future__ import annotations

import http.client
import http.server
import json
import socket
import threading
import unittest
from pathlib import Path

from dsh.adapter import credentials_yaml, settings_yaml
from server import credential_proxy as cp
from server.launcher import build_env

REAL_KEY = "sk-test-REALKEY-1234567890"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeUpstream:
    """假 OpenAI 兼容上游：记录收到的请求，按脚本回包。"""

    def __init__(self):
        self.received = {}
        self._srv = None

    def start(self):
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                outer.received = {
                    "path": self.path,
                    "auth": self.headers.get("Authorization"),
                    "token": self.headers.get(cp.TOKEN_HEADER),
                    "accept_encoding": self.headers.get("Accept-Encoding"),
                    "body": json.loads(body or b"{}"),
                }
                payload = json.dumps({"ok": True, "echo": outer.received["body"]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *a):
                pass

        self._srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self._srv.server_address[1]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        return self

    def stop(self):
        if self._srv:
            self._srv.shutdown()
            self._srv.server_close()


class StreamingUpstream(FakeUpstream):
    """SSE 式上游：分三块、块间延迟发送，用于验证代理不分片缓冲。"""

    def start(self):
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                outer.received = {"path": self.path, "auth": self.headers.get("Authorization")}
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for part in (b"data: first\n\n", b"data: second\n\n", b"data: [DONE]\n\n"):
                    import time

                    time.sleep(0.15)
                    self.wfile.write(b"%X\r\n" % len(part) + part + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")

            def log_message(self, *a):
                pass

        self._srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self._srv.server_address[1]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        return self


def make_cfg(key: str = REAL_KEY):
    return {
        "models": [
            {
                "id": "deepseek",
                "label": "DeepSeek",
                "access": "api",
                "baseURL": "https://api.deepseek.com/v1",
                "apiKey": key,
                "enabled": True,
            },
            {
                "id": "local-1",
                "label": "本地",
                "access": "local",
                "baseURL": "http://127.0.0.1:11434/v1",
                "apiKey": "",
                "enabled": True,
            },
        ]
    }


def request(port: int, method: str, path: str, body: dict | None = None, token: str | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {}
    payload = None
    if body is not None:
        payload = json.dumps(body)
        headers["Content-Type"] = "application/json"
    if token:
        headers[cp.TOKEN_HEADER] = token
    conn.request(method, path, body=payload, headers=headers)
    resp = conn.getresponse()
    data = resp.read()
    conn.close()
    return resp.status, data


class CredentialProxyTest(unittest.TestCase):
    def setUp(self):
        self.upstream = FakeUpstream().start()
        # 把假上游当作 provider 的 baseURL（host 白名单由它派生）
        self.cfg = make_cfg()
        self.cfg["models"][0]["baseURL"] = f"http://127.0.0.1:{self.upstream.port}/v1"

    def tearDown(self):
        cp.stop()
        self.upstream.stop()

    def _proxy(self) -> cp.CredentialProxy:
        proxy = cp.CredentialProxy(cp.providers_from_config(self.cfg))
        self.assertTrue(proxy.start(), "测试代理应能启动")
        return proxy

    # ------------------------------------------------------------ 渲染面

    def test_placeholder_render_no_real_key_in_dsh_files(self):
        """money test：代理模式下 DSH 侧文件不出现真 Key，出现占位符与代理 URL。"""
        proxy = self._proxy()
        settings = settings_yaml(self.cfg, None, proxy=proxy)
        creds = credentials_yaml(self.cfg, proxy=proxy)
        self.assertNotIn(REAL_KEY, settings)
        self.assertNotIn(REAL_KEY, creds)
        self.assertIn(cp.placeholder_for("deepseek"), creds)
        self.assertIn(f"baseURL: http://127.0.0.1:{proxy.port}/p/deepseek", settings)
        self.assertIn(cp.TOKEN_HEADER, settings)
        # 本地模型（无 Key）保持直连，不增加故障点
        self.assertIn("baseURL: http://127.0.0.1:11434/v1", settings)

    def test_direct_mode_keeps_real_key(self):
        """直连模式（proxy=None）行为不变：真 Key 仍写 credentials。"""
        creds = credentials_yaml(self.cfg, proxy=None)
        self.assertIn(REAL_KEY, creds)

    def test_build_env_placeholder(self):
        proxy = self._proxy()
        env = build_env(self.cfg, proxy=proxy)
        self.assertEqual(env["WUAI_DEEPSEEK_KEY"], cp.placeholder_for("deepseek"))
        env_direct = build_env(self.cfg, proxy=None)
        self.assertEqual(env_direct["WUAI_DEEPSEEK_KEY"], REAL_KEY)

    def test_providers_from_config_filters(self):
        providers = cp.providers_from_config(self.cfg)
        self.assertEqual(list(providers), ["deepseek"])  # 本地模型不入集合
        self.assertEqual(providers["deepseek"]["apiKey"], REAL_KEY)

    # ------------------------------------------------------------ 转发面

    def test_forward_injects_real_key(self):
        proxy = self._proxy()
        status, data = request(
            proxy.port, "POST", "/p/deepseek/chat/completions",
            body={"model": "x", "messages": []}, token=proxy.token,
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["ok"], True)
        # 上游看到的：真 Key 注入了；客户端发的假 Authorization/token 被剥掉
        self.assertEqual(self.upstream.received["auth"], f"Bearer {REAL_KEY}")
        self.assertIsNone(self.upstream.received["token"])
        self.assertEqual(self.upstream.received["path"], "/v1/chat/completions")

    def test_bad_token_rejected(self):
        proxy = self._proxy()
        status, _ = request(proxy.port, "POST", "/p/deepseek/chat/completions", body={}, token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(self.upstream.received, {})  # 没有到达上游

    def test_unknown_provider_rejected(self):
        proxy = self._proxy()
        status, _ = request(proxy.port, "POST", "/p/nope/x", body={}, token=proxy.token)
        self.assertEqual(status, 404)

    def test_host_allowlist(self):
        proxy = self._proxy()
        self.assertTrue(proxy.host_allowed(f"http://127.0.0.1:{self.upstream.port}/v1"))
        self.assertFalse(proxy.host_allowed("https://evil.example/v1"))

    def test_update_providers_hot_swap(self):
        proxy = self._proxy()
        self.assertIsNone(proxy.route_for("other"))
        proxy.update_providers({"other": {"baseURL": "https://api.other.com/v1", "apiKey": "k2"}})
        self.assertIsNotNone(proxy.route_for("other"))
        self.assertIsNone(proxy.route_for("deepseek"))  # 旧集合被替换，不是合并
        self.assertTrue(proxy.host_allowed("https://api.other.com/v1"))
        self.assertFalse(proxy.host_allowed(f"http://127.0.0.1:{self.upstream.port}/v1"))


class ShimIntegrationTest(unittest.TestCase):
    """协议垫片在代理边界生效：出站清洗 + 入站思考流归一化（DSH 零改动）。"""

    def test_outbound_sanitized_and_accept_encoding_forced(self):
        upstream = FakeUpstream().start()
        try:
            cfg = make_cfg()
            cfg["models"][0]["baseURL"] = f"http://127.0.0.1:{upstream.port}/v1"
            proxy = cp.CredentialProxy(cp.providers_from_config(cfg))
            self.assertTrue(proxy.start())
            try:
                request(
                    proxy.port, "POST", "/p/deepseek/chat/completions",
                    body={"model": "x", "thinking": {"type": "enabled"}, "logprobs": True,
                          "messages": [{"role": "assistant", "content": None}]},
                    token=proxy.token,
                )
                got = upstream.received["body"]
                self.assertNotIn("thinking", got)
                self.assertNotIn("logprobs", got)
                self.assertEqual(got["messages"][0]["content"], "")
                # 垫片要逐行读 SSE，上游必须不压缩
                self.assertEqual(upstream.received.get("accept_encoding"), "identity")
            finally:
                proxy.stop()
        finally:
            upstream.stop()

    def test_sse_think_normalized_at_boundary(self):
        upstream = ThinkSseUpstream().start()
        try:
            cfg = make_cfg()
            cfg["models"][0]["baseURL"] = f"http://127.0.0.1:{upstream.port}/v1"
            proxy = cp.CredentialProxy(cp.providers_from_config(cfg))
            self.assertTrue(proxy.start())
            try:
                conn = http.client.HTTPConnection("127.0.0.1", proxy.port, timeout=10)
                conn.request(
                    "POST", "/p/deepseek/chat/completions", body=json.dumps({"stream": True}),
                    headers={"Content-Type": "application/json", cp.TOKEN_HEADER: proxy.token},
                )
                resp = conn.getresponse()
                raw = resp.read().decode("utf-8")
                conn.close()
                # 思维链进了 reasoning_content，正文只剩答案 —— 内核不再把思考当正文
                self.assertIn("先算一下", raw)
                self.assertIn("reasoning_content", raw)
                self.assertIn("答案", raw)
                self.assertNotIn("<think>", raw)
            finally:
                proxy.stop()
        finally:
            upstream.stop()


class ThinkSseUpstream(StreamingUpstream):
    """把 <think> 拆到两个网络块里发 —— 真实模型输出的常见形态。"""

    def start(self):
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))

                def frame(delta: dict) -> bytes:
                    payload = json.dumps({"choices": [{"index": 0, "delta": delta}]}, ensure_ascii=False)
                    return b"data: " + payload.encode() + b"\n\n"

                parts = [
                    frame({"content": "答案<thi"}),
                    frame({"content": "nk>先算一下</thi"}),
                    frame({"content": "nk>是 2"}),
                    b"data: [DONE]\n\n",
                ]
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for part in parts:
                    import time

                    time.sleep(0.05)
                    self.wfile.write(b"%X\r\n" % len(part) + part + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")

            def log_message(self, *a):
                pass

        self._srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self._srv.server_address[1]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        return self


class StreamingTest(unittest.TestCase):
    def test_sse_streams_incrementally(self):
        upstream = StreamingUpstream().start()
        try:
            cfg = make_cfg()
            cfg["models"][0]["baseURL"] = f"http://127.0.0.1:{upstream.port}/v1"
            proxy = cp.CredentialProxy(cp.providers_from_config(cfg))
            self.assertTrue(proxy.start())
            try:
                conn = http.client.HTTPConnection("127.0.0.1", proxy.port, timeout=10)
                conn.request(
                    "POST", "/p/deepseek/chat/completions",
                    body=json.dumps({"stream": True}),
                    headers={"Content-Type": "application/json", cp.TOKEN_HEADER: proxy.token},
                )
                resp = conn.getresponse()
                self.assertEqual(resp.status, 200)
                first = resp.read1(1024)
                self.assertTrue(first.startswith(b"data: first"), f"首块应即时到达，得到 {first[:40]!r}")
                rest = resp.read()
                self.assertIn(b"[DONE]", rest)
                conn.close()
            finally:
                proxy.stop()
        finally:
            upstream.stop()


class SingletonTest(unittest.TestCase):
    def tearDown(self):
        cp.stop()

    def test_start_for_and_status(self):
        cfg = make_cfg()
        proxy = cp.start_for(cfg)
        self.assertIsNotNone(proxy)
        st = cp.status()
        self.assertTrue(st["active"])
        self.assertEqual(st["mode"], "proxy")
        self.assertIn("deepseek", st["providers"])
        self.assertIs(cp.active(), proxy)
        cp.stop()
        self.assertEqual(cp.status()["mode"], "direct")
        self.assertFalse(cp.status()["active"])

    def test_start_for_no_secrets_returns_none(self):
        """没有可保护的云端模型时不启动代理（直连模式，无秘密可泄）。"""
        cfg = {"models": [{"id": "local-1", "access": "local", "baseURL": "http://127.0.0.1:11434/v1", "apiKey": "", "enabled": True}]}
        self.assertIsNone(cp.start_for(cfg))
        self.assertEqual(cp.status()["mode"], "direct")


if __name__ == "__main__":
    unittest.main()
