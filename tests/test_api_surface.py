"""控制中心 HTTP 面：新增的 任务历史 / 文件树 / 流水线事件 三个端点。

起一个真实的 ReusableHTTPServer（端口 0 随机），走真实 HTTP：
验证状态码、字段形状，以及「路径越界必须 403」这条安全边界——接口层漏了
guard，单测再全也白搭。
"""

import json
import threading
import unittest
import urllib.error
import urllib.request

from server.app import Handler, ReusableHTTPServer


class ApiSurfaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ReusableHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def get(self, path, timeout=5):
        with urllib.request.urlopen(self._url(path), timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def post(self, path, payload, timeout=5):
        req = urllib.request.Request(
            self._url(path),
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_tasks_payload_shape(self):
        status, body = self.get("/api/tasks")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIn("workspace", body)
        self.assertIsInstance(body["snapshots"], list)
        for snap in body["snapshots"][:3]:
            for key in ("commit", "at", "label", "fileCount", "insertions", "deletions"):
                self.assertIn(key, snap)
            # 历史回看要能取区间 diff：最新一档 until 为 None（比到工作区）
            self.assertIn("until", snap)

    def test_files_root(self):
        status, body = self.get("/api/files?depth=1")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["path"], "")
        # 影子仓库自身永远不出现在文件树里
        names = [e["name"] for e in body["entries"]]
        self.assertNotIn(".wu-shadow-git", names)
        for entry in body["entries"]:
            self.assertIn(entry["type"], ("file", "dir", "link"))

    def test_files_escape_is_403(self):
        for path in ("/api/files?path=../../etc", "/api/files?path=/etc", "/api/files?path=..%2F..%2Fetc"):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self.get(path)
            self.assertEqual(ctx.exception.code, 403, path)
            body = json.loads(ctx.exception.read().decode("utf-8"))
            self.assertFalse(body["ok"])
            self.assertIn("越权", body["message"])

    def test_task_events_token_roundtrip(self):
        status, body = self.get("/api/task-events")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["events"], [])
        token = body["offset"]
        self.assertIsInstance(token, str)
        # 令牌带回家：位置不后退，也不报错
        status, again = self.get(f"/api/task-events?offset={urllib.request.quote(token)}")
        self.assertEqual(status, 200)
        self.assertTrue(again["ok"])

    def test_task_stream_is_event_stream(self):
        req = urllib.request.Request(self._url("/api/task-stream"), headers={"Accept": "text/event-stream"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            self.assertIn("text/event-stream", resp.headers.get("Content-Type", ""))
            first = resp.readline().decode("utf-8")
            self.assertIn("retry:", first)

    def test_shadow_diff_rejects_bad_commit(self):
        status, body = self.post("/api/shadow/diff", {"path": "a.py", "commit": "--upload-pack=evil"})
        self.assertEqual(status, 200)
        self.assertFalse(body["ok"])
        self.assertIn("无效", body["message"])


if __name__ == "__main__":
    unittest.main()


class TaskStreamIntegrationTest(unittest.TestCase):
    """SSE 端到端：连上之后追加的埋点必须被实时推出来。

    在**进程内**把 workspace.DSH_HOME 指到临时目录——绝不写用户真实的 perf.jsonl。
    """

    @classmethod
    def setUpClass(cls):
        cls.httpd = ReusableHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self):
        import tempfile
        from pathlib import Path
        from server import workspace

        self.tmp = Path(tempfile.mkdtemp(prefix="wu-sse-"))
        self._old_home = workspace.DSH_HOME
        workspace.DSH_HOME = self.tmp
        self.perf = self.tmp / "perf.jsonl"
        self.perf.write_text("", encoding="utf-8")

    def tearDown(self):
        import shutil
        from server import workspace

        workspace.DSH_HOME = self._old_home
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_sse_pushes_appended_event(self):
        import time

        got = {}
        ready = threading.Event()

        def reader():
            req = urllib.request.Request(
                f"http://127.0.0.1:{self.port}/api/task-stream",
                headers={"Accept": "text/event-stream", "Origin": f"http://127.0.0.1:{self.port}"},
            )
            try:
                with urllib.request.urlopen(req, timeout=12) as resp:
                    while True:
                        line = resp.readline()
                        if not line:
                            return
                        text = line.decode("utf-8").strip()
                        if text.startswith("data:") and '"offset"' in text:
                            ready.set()
                        elif text.startswith("data:") and '"kind"' in text:
                            got["event"] = json.loads(text[len("data:") :].strip())
                            return
            except Exception as e:  # pragma: no cover - 失败信息给断言用
                got["error"] = repr(e)

        worker = threading.Thread(target=reader, daemon=True)
        worker.start()
        self.assertTrue(ready.wait(6), "SSE 未在 6 秒内就绪")

        with self.perf.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"kind": "route", "ts": "2026-10-26T05:00:00Z", "model": "glm-4.6v"}) + "\n")

        worker.join(8)
        self.assertNotIn("error", got)
        self.assertEqual(got.get("event", {}).get("kind"), "route")
        self.assertEqual(got["event"].get("model"), "glm-4.6v")
