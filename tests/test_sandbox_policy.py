"""托管沙箱策略（P2-10）测试：默认值 / 校验 / 持久化。

隔离：workspace.DSH_HOME 是 core.paths 的模块级常量（写死真实 home），
测试必须 monkeypatch 成临时路径——2026-10-24 曾因忽略这点把测试数据
写进真实 ~/.wu-ai/。
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from server import workspace


class SandboxPolicyTest(unittest.TestCase):
    def setUp(self):
        self._orig = workspace.DSH_HOME
        self.tmp = Path(tempfile.mkdtemp(prefix="wuai-policy-"))
        workspace.DSH_HOME = self.tmp

    def tearDown(self):
        workspace.DSH_HOME = self._orig

    def test_default_when_missing(self):
        p = workspace.sandbox_policy_load()
        self.assertEqual(p["allowedModes"], ["workspace-write"])
        self.assertEqual(p["budget"]["toolCalls"], 200)

    def test_default_when_corrupt(self):
        (self.tmp / "wu-ai-policy.json").write_text("{ broken", encoding="utf-8")
        p = workspace.sandbox_policy_load()
        self.assertEqual(p["allowedModes"], ["workspace-write"])

    def test_save_and_load_roundtrip(self):
        rec = workspace.sandbox_policy_save({
            "allowedModes": ["workspace-write", "danger-full-access"],
            "budget": {"toolCalls": 50, "wallClockMs": 3600000, "reviewFails": 3},
        })
        self.assertIn("danger-full-access", rec["allowedModes"])
        self.assertEqual(rec["budget"]["toolCalls"], 50)
        loaded = workspace.sandbox_policy_load()
        self.assertEqual(loaded["allowedModes"], rec["allowedModes"])
        self.assertEqual(loaded["budget"], rec["budget"])

    def test_save_rejects_empty_whitelist(self):
        with self.assertRaises(ValueError):
            workspace.sandbox_policy_save({"allowedModes": []})

    def test_save_filters_unknown_modes(self):
        rec = workspace.sandbox_policy_save({"allowedModes": ["workspace-write", "bogus-mode"]})
        self.assertEqual(rec["allowedModes"], ["workspace-write"])

    def test_save_clamps_budget_range(self):
        rec = workspace.sandbox_policy_save({
            "allowedModes": ["workspace-write"],
            "budget": {"toolCalls": 999999, "reviewFails": 0, "wallClockMs": 1},
        })
        self.assertEqual(rec["budget"]["toolCalls"], 10000)  # 上限
        self.assertEqual(rec["budget"]["reviewFails"], 1)     # 下限
        self.assertEqual(rec["budget"]["wallClockMs"], 60000)  # 下限

    def test_file_permissions_0600(self):
        workspace.sandbox_policy_save({"allowedModes": ["workspace-write"]})
        mode = (self.tmp / "wu-ai-policy.json").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)


if __name__ == "__main__":
    unittest.main()
