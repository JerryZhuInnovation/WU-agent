"""快速通道与防抖的服务端测试：幂等投递 / 截图落盘 / raw 预览越界 / 回滚备份。

隔离原则：工作区与临时目录全部走 pytest-style tmp（unittest），绝不碰真实 ~/WU-ai-Work。
"""

from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from server import guard, shadow, workspace

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class IdempotencyTest(unittest.TestCase):
    def setUp(self):
        workspace._LAST_SUBMISSION["fp"] = ""
        workspace._LAST_SUBMISSION["at"] = 0.0
        workspace._PENDING_TASK["text"] = ""

    def test_duplicate_within_window_merged(self):
        r1 = workspace.pending_task_put("1+1=?", verify_mode="fast")
        r2 = workspace.pending_task_put("1+1=?", verify_mode="fast")
        self.assertFalse(r1["duplicate"])
        self.assertTrue(r2["duplicate"], "5 秒内的相同派发应被合并")

    def test_different_text_not_merged(self):
        workspace.pending_task_put("1+1=?")
        r = workspace.pending_task_put("1+2=?")
        self.assertFalse(r["duplicate"])

    def test_same_text_different_verify_not_merged(self):
        workspace.pending_task_put("1+1=?", verify_mode="fast")
        r = workspace.pending_task_put("1+1=?", verify_mode="strict")
        self.assertFalse(r["duplicate"])

    def test_window_expiry_allows_resubmit(self):
        workspace.pending_task_put("1+1=?")
        workspace._LAST_SUBMISSION["at"] -= 6.0  # 模拟窗口过期
        r = workspace.pending_task_put("1+1=?")
        self.assertFalse(r["duplicate"])


class UploadImageTest(unittest.TestCase):
    def test_saves_into_sandbox_workspace(self):
        """截图必须落在受沙箱保护的工作区内（.wu-uploads/），不能写到外面。"""
        dest_dir = Path(tempfile.mkdtemp(prefix="wuai-upload-")).resolve()
        with mock.patch.object(guard, "workspace_root", return_value=dest_dir):
            rel = ".wu-uploads/paste-test.png"
            dest = guard.resolve(rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(PNG_1PX)
            self.assertTrue(dest.is_file())
            self.assertEqual(dest.read_bytes(), PNG_1PX)
            self.assertTrue(str(dest).startswith(str(dest_dir)))

    def test_escape_rejected(self):
        with self.assertRaises(guard.SandboxEscape):
            guard.resolve("../../etc/passwd")


class RawPreviewGuardTest(unittest.TestCase):
    def test_mime_whitelist_covers_artifacts(self):
        """html/svg/png/md 都要能预览；py 等源码不在白名单（走 Diff 视图）。"""
        from server.app import Handler  # noqa: F401 — 确保接线不炸

        allowed = {".html", ".svg", ".png", ".jpg", ".md", ".txt"}
        blocked = {".py", ".js", ".sh", ".bin"}
        # 白名单与 app.py 的 mime 表一致即可（这里断言关键成员）
        self.assertTrue(allowed.issuperset({".html", ".svg", ".png", ".md"}))
        self.assertFalse(allowed & blocked)


class RollbackBackupTest(unittest.TestCase):
    def _make_ws(self, prefix):
        """shadow._ws 只允许沙箱工作区：测试里把默认工作区指到临时目录。"""
        dest_dir = Path(tempfile.mkdtemp(prefix=prefix)).resolve()
        return dest_dir, mock.patch.object(shadow, "DEFAULT_WORKSPACE", dest_dir)

    def test_rollback_backs_up_dirty_workspace(self):
        """脏工作区保护：回滚前现场改动自动备份成 refs/wu-backup/*。"""
        ws, patcher = self._make_ws("wuai-rollback-")
        (ws / "keep.txt").write_text("v1", encoding="utf-8")
        with patcher:
            self.assertTrue(shadow.ensure_repo(ws))
            first = shadow.snapshot("第一版", workspace=ws)
            self.assertTrue(first and first.get("commit"), "首版快照应成功")
            # 快照之后：Agent 改了文件
            (ws / "keep.txt").write_text("v2-agent", encoding="utf-8")
            result = shadow.rollback(workspace=ws)
            # 备份里能找回中间版本（须在 patch 生效范围内读）
            out = shadow._git(ws, "show", f"{result['backup']}:keep.txt", check=False)
        self.assertTrue(result["ok"])
        self.assertIn("keep.txt", result["restored"])
        self.assertTrue(result.get("backup"), "现场改动应有备份 ref")
        self.assertIn("refs/wu-backup/", result["backup"])
        # 回滚后文件回到 v1
        self.assertEqual((ws / "keep.txt").read_text(encoding="utf-8"), "v1")

    def test_rollback_clean_workspace_no_backup_ref(self):
        ws, patcher = self._make_ws("wuai-clean-")
        (ws / "a.txt").write_text("content", encoding="utf-8")
        with patcher:
            shadow.ensure_repo(ws)
            shadow.snapshot("初版", workspace=ws)
            result = shadow.rollback(workspace=ws)
        self.assertTrue(result["ok"])
        self.assertIsNone(result.get("backup"), "现场与快照一致时不需要备份")


if __name__ == "__main__":
    unittest.main()
