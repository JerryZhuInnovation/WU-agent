"""keystore 单元测试：加密往返 / 删除 / 篡改容错 / 脱敏格式。"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.keystore import Keystore, KeystoreError, mask_key  # noqa: E402


class KeystoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="wuai-ks-")
        self.ks = Keystore(
            key_file=Path(self.tmp.name) / "k" / ".secret",
            store_file=Path(self.tmp.name) / "s" / "secrets.json",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_roundtrip(self):
        self.ks.put("deepseek", "sk-test-1234567890")
        self.assertEqual(self.ks.get("deepseek"), "sk-test-1234567890")

    def test_store_has_no_plaintext(self):
        self.ks.put("deepseek", "sk-super-secret")
        raw = (Path(self.tmp.name) / "s" / "secrets.json").read_text(encoding="utf-8")
        self.assertNotIn("sk-super-secret", raw)
        data = json.loads(raw)
        rec = data["secrets"]["deepseek"]
        self.assertEqual(rec["alg"], "aes-256-cbc-ossl-pbkdf2")
        self.assertTrue(rec["ct"])

    def test_key_file_permissions(self):
        self.ks.put("a", "b")
        mode = Path(self.ks.key_file).stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_missing_returns_none(self):
        self.assertIsNone(self.ks.get("nope"))

    def test_tampered_ciphertext_returns_none(self):
        self.ks.put("a", "secret-value")
        sf = Path(self.tmp.name) / "s" / "secrets.json"
        data = json.loads(sf.read_text(encoding="utf-8"))
        data["secrets"]["a"]["ct"] = "AAAA" + data["secrets"]["a"]["ct"][4:][:24]
        sf.write_text(json.dumps(data), encoding="utf-8")
        self.assertIsNone(self.ks.get("a"))

    def test_delete_and_ids(self):
        self.ks.put("a", "1")
        self.ks.put("b", "2")
        self.assertEqual(self.ks.ids(), ["a", "b"])
        self.ks.delete("a")
        self.assertEqual(self.ks.ids(), ["b"])
        self.assertIsNone(self.ks.get("a"))

    def test_empty_put_ignored(self):
        self.ks.put("", "x")
        self.ks.put("y", "")
        self.assertEqual(self.ks.ids(), [])

    def test_available_interface(self):
        # 正常环境 openssl 存在 → True；这里只验证接口存在且不含异常
        self.assertTrue(self.ks.available())

    def test_mask_key(self):
        self.assertEqual(mask_key(""), "")
        self.assertEqual(mask_key("abcdefgh12345678"), "abcd…5678")
        self.assertEqual(mask_key("abc"), "ab…*")  # 短密钥


if __name__ == "__main__":
    unittest.main()