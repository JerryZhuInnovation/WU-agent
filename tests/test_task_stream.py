"""执行态流水线事件流：按字节偏移增量读取 perf.jsonl（SSE 与轮询共用）。

覆盖三个真实坑：① 连上时不回放历史；② 追加写只写了一半的行不能被解析；
③ 文件被截断/轮转后要能从头续读，而不是永远卡住。
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from server import workspace


class TaskStreamTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wu-stream-"))
        self._old_home = workspace.DSH_HOME
        workspace.DSH_HOME = self.tmp
        self.perf = self.tmp / "perf.jsonl"

    def tearDown(self):
        workspace.DSH_HOME = self._old_home
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _append(self, *rows):
        with self.perf.open("a", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def test_starts_at_tail_without_backfill(self):
        self._append({"kind": "route", "ts": "2026-01-01T00:00:00Z"})
        token = workspace.perf_offset()
        # 令牌是「首字节签名:偏移」的不透明字符串
        self.assertRegex(token, r"^\d+\.[0-9a-f]+:\d+$")
        self.assertTrue(token.endswith(f":{self.perf.stat().st_size}"))
        new_token, events = workspace.read_perf_since(token)
        self.assertEqual(events, [])
        self.assertEqual(new_token, token)

    def test_partial_line_is_not_parsed(self):
        self._append({"kind": "route", "ts": "2026-01-01T00:00:00Z"})
        token = workspace.perf_offset()
        with self.perf.open("a", encoding="utf-8") as f:
            f.write('{"kind":"execute","model":"glm-4.6v"')  # 半行
        new_token, events = workspace.read_perf_since(token)
        self.assertEqual(events, [])
        self.assertEqual(new_token, token, "半行不能被消费，否则会丢事件")

        with self.perf.open("a", encoding="utf-8") as f:
            f.write('}\n')
        new_token, events = workspace.read_perf_since(token)
        self.assertEqual([e["kind"] for e in events], ["execute"])
        self.assertEqual(events[0]["model"], "glm-4.6v")
        self.assertTrue(new_token.endswith(f":{self.perf.stat().st_size}"))

    def test_filters_non_pipeline_kinds_and_normalizes_ts(self):
        token = workspace.perf_offset()
        self._append(
            {"kind": "llm", "model": "x", "usage": {"total": 1}},
            {"kind": "route", "ts": "2026-01-01T00:00:00Z", "capability": "coding", "model": "glm-4.6v", "reason": "需要长上下文"},
            {"kind": "multi", "steps": [{"capability": "coding"}, {"capability": "vision"}]},
            {"kind": "idle", "model": "glm-4.6v"},
        )
        _, events = workspace.read_perf_since(token)
        self.assertEqual([e["kind"] for e in events], ["route", "multi", "idle"])
        # 路由插件写 ts，前端统一认 at
        self.assertEqual(events[0]["at"], "2026-01-01T00:00:00Z")
        self.assertEqual(events[0]["reason"], "需要长上下文")
        # steps 只留长度，避免把整份计划推给前端
        self.assertEqual(events[1]["steps"], 2)

    def test_truncation_restarts_from_zero(self):
        self._append({"kind": "route", "ts": "2026-01-01T00:00:00Z"})
        token = workspace.perf_offset()
        self.perf.write_text("", encoding="utf-8")  # 截断
        self._append({"kind": "verify", "ts": "2026-01-01T00:00:01Z", "pass": True})
        _, events = workspace.read_perf_since(token)
        self.assertEqual([e["kind"] for e in events], ["verify"])

    def test_rotation_restarts_from_zero(self):
        self._append({"kind": "route", "ts": "2026-01-01T00:00:00Z"})
        token = workspace.perf_offset()
        # 轮转：旧文件改名，新文件从 0 开始（新文件可能比旧偏移更长）
        self.perf.rename(self.tmp / "perf.jsonl.1")
        self._append(
            {"kind": "execute", "ts": "2026-01-01T00:00:01Z", "model": "glm-4.6v", "success": True},
            {"kind": "idle", "ts": "2026-01-01T00:00:02Z"},
        )
        _, events = workspace.read_perf_since(token)
        self.assertEqual([e["kind"] for e in events], ["execute", "idle"])

    def test_task_events_default_offset_has_no_backfill(self):
        self._append({"kind": "execute", "model": "old"})
        payload = workspace.task_events()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["events"], [])
        self.assertEqual(payload["offset"], workspace.perf_offset())

    def test_missing_file_is_not_an_error(self):
        self.perf.unlink(missing_ok=True)
        payload = workspace.task_events(-1)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["events"], [])


if __name__ == "__main__":
    unittest.main()
