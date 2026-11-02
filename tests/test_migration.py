"""migration 单元测试：版本链 / 幂等 / 失败不丢数据。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.keystore import Keystore  # noqa: E402
from core.migration import LATEST_SCHEMA, migrate_data, current_version  # noqa: E402


def _v1_cfg():
    return {
        "schemaVersion": 1,
        "models": [
            {
                "id": "deepseek",
                "label": "DeepSeek",
                "apiKey": "sk-plain-111",
                "baseURL": "https://api.deepseek.com",
                "capabilities": {"reasoning": 0.9},
            },
            {
                "id": "ollama",
                "label": "本地 Ollama",
                "access": "local",
                "baseURL": "http://127.0.0.1:11434/v1",
            },
        ],
        "routingMode": "manual",
    }


class MigrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wuai-mig-")
        self.ks = Keystore(
            key_file=Path(self.tmp.name) / ".secret",
            store_file=Path(self.tmp.name) / "secrets.json",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_v1_to_v2_strips_plaintext_and_stores_secret(self):
        data, rep = migrate_data(_v1_cfg(), self.ks)
        self.assertIsNone(rep["error"])
        self.assertEqual(rep["after"], LATEST_SCHEMA)
        self.assertEqual([m["version"] for m in rep["applied"]], [2])
        # 明文已从配置中消失，只留引用
        serial = __import__("json").dumps(data)
        self.assertNotIn("sk-plain-111", serial)
        refs = {m.get("apiKeySecret", {}).get("id") for m in data["models"]}
        self.assertEqual(refs, {"deepseek", None})
        # 密库可解出原值
        self.assertEqual(self.ks.get("deepseek"), "sk-plain-111")
        # 无 Key 的本地模型不受影响（不会凭空多出引用里的 apiKey 字段）
        ollama = next(m for m in data["models"] if m["id"] == "ollama")
        self.assertNotIn("apiKey", ollama)

    def test_idempotent_on_latest(self):
        data, _ = migrate_data(_v1_cfg(), self.ks)
        again, rep = migrate_data(data, self.ks)
        self.assertEqual(rep["applied"], [])
        self.assertEqual(rep["before"], rep["after"])

    def test_missing_schema_treated_as_v1(self):
        cfg = _v1_cfg()
        del cfg["schemaVersion"]
        self.assertEqual(current_version(cfg), 1)
        data, rep = migrate_data(cfg, self.ks)
        self.assertIsNone(rep["error"])
        self.assertEqual(data["schemaVersion"], LATEST_SCHEMA)

    def test_failure_preserves_original(self):
        class BrokenKs:
            def put(self, sid, key):
                raise RuntimeError("磁盘炸了")

        cfg = _v1_cfg()
        data, rep = migrate_data(cfg, BrokenKs())
        self.assertIsNotNone(rep["error"])
        self.assertIn("RuntimeError", rep["error"])
        # 失败时返回原始数据（明文仍在），调用方不会把坏数据落盘
        self.assertEqual(data, cfg)


if __name__ == "__main__":
    unittest.main()