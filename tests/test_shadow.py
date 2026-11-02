"""影子快照（Task Diff）单元测试：快照 / 改动统计 / diff / 回滚 / 路径越界拒绝。"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path

from server import shadow


class ShadowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wu-shadow-"))
        self._old = shadow.DEFAULT_WORKSPACE
        shadow.DEFAULT_WORKSPACE = self.tmp  # 只在测试内改根目录
        (self.tmp / "a.py").write_text("print('a')\n", encoding="utf-8")

    def tearDown(self):
        shadow.DEFAULT_WORKSPACE = self._old
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_snapshot_requires_git(self):
        if shutil.which("git") is None:
            self.skipTest("git 不可用")
        snap = shadow.snapshot("demo")
        self.assertIsNotNone(snap)
        self.assertIn("demo", snap["label"])
        # 快照后没有改动
        st = shadow.status()
        self.assertEqual(st["files"], [])

    def test_diff_and_rollback(self):
        if shutil.which("git") is None:
            self.skipTest("git 不可用")
        shadow.snapshot("before")
        (self.tmp / "a.py").write_text("print('b')\n", encoding="utf-8")
        (self.tmp / "new.txt").write_text("new\n", encoding="utf-8")

        st = shadow.status()
        paths = {f["path"] for f in st["files"]}
        self.assertIn("a.py", paths)
        self.assertIn("new.txt", paths)

        d = shadow.diff("a.py")
        self.assertTrue(d["ok"])
        self.assertIn("print('b')", d["diff"])

        r = shadow.rollback()
        self.assertTrue(r["ok"])
        self.assertEqual((self.tmp / "a.py").read_text(encoding="utf-8"), "print('a')\n")
        self.assertFalse((self.tmp / "new.txt").exists())
        self.assertEqual(shadow.status()["files"], [])

    def test_rollback_keeps_untracked_before_snapshot(self):
        if shutil.which("git") is None:
            self.skipTest("git 不可用")
        (self.tmp / "old.txt").write_text("old\n", encoding="utf-8")
        shadow.snapshot("before")
        (self.tmp / "old.txt").write_text("edited\n", encoding="utf-8")
        shadow.rollback()
        self.assertEqual((self.tmp / "old.txt").read_text(encoding="utf-8"), "old\n")

    def test_path_outside_workspace_rejected(self):
        with self.assertRaises(ValueError):
            shadow.status(self.tmp / ".." / "outside")

    def test_history_lists_tasks_with_their_changes(self):
        if shutil.which("git") is None:
            self.skipTest("git 不可用")
        shadow.snapshot("第一次任务")
        (self.tmp / "a.py").write_text("print('second')\n", encoding="utf-8")
        shadow.snapshot("第二次任务")
        (self.tmp / "a.py").write_text("print('third')\n", encoding="utf-8")

        rows = shadow.history()
        labels = [r["label"] for r in rows]
        self.assertIn("第一次任务", labels)
        self.assertIn("第二次任务", labels)
        # 新 → 旧：最新一档的改动是「第二个快照之后」的编辑
        newest = rows[0]
        self.assertEqual(newest["label"], "第二次任务")
        self.assertEqual(newest["fileCount"], 1)
        self.assertEqual(newest["files"][0]["path"], "a.py")
        # 次新一档：第二次快照 vs 第一次快照之间的编辑
        self.assertEqual(rows[1]["fileCount"], 1)
        self.assertEqual(rows[1]["insertions"], 1)

    def test_history_skips_accept_commits(self):
        if shutil.which("git") is None:
            self.skipTest("git 不可用")
        shadow.snapshot("任务A")
        (self.tmp / "a.py").write_text("print('changed')\n", encoding="utf-8")
        shadow.accept(["a.py"])
        labels = [r["label"] for r in shadow.history()]
        self.assertNotIn("accept 1 file(s)", labels)
        self.assertIn("任务A", labels)

    def test_diff_against_history_commit(self):
        if shutil.which("git") is None:
            self.skipTest("git 不可用")
        shadow.snapshot("t1")
        (self.tmp / "a.py").write_text("print('t2')\n", encoding="utf-8")
        shadow.snapshot("t2")
        (self.tmp / "a.py").write_text("print('t3')\n", encoding="utf-8")
        hist = shadow.history()
        old = hist[1]  # 第一次任务的快照；until = 第二次任务的快照
        d = shadow.diff("a.py", commit=old["commit"], to=old["until"])
        self.assertTrue(d["ok"])
        self.assertIn("print('t2')", d["diff"])

    def test_diff_rejects_bad_commit(self):
        if shutil.which("git") is None:
            self.skipTest("git 不可用")
        shadow.snapshot("t")
        self.assertFalse(shadow.diff("a.py", commit="--upload-pack=evil")["ok"])
        self.assertFalse(shadow.diff("a.py", commit="deadbeef")["ok"])

    def test_symlink_escape_rejected_in_diff(self):
        if shutil.which("git") is None:
            self.skipTest("git 不可用")
        shadow.snapshot("t")
        outside = Path(tempfile.mkdtemp(prefix="wu-shadow-out-"))
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "secret.txt").write_text("secret", encoding="utf-8")
        try:
            (self.tmp / "escape.txt").symlink_to(outside / "secret.txt")
        except (OSError, NotImplementedError):
            self.skipTest("不支持软链接")
        result = shadow.diff("escape.txt")
        self.assertFalse(result["ok"])
        self.assertIn("越权", result["message"])


if __name__ == "__main__":
    unittest.main()
