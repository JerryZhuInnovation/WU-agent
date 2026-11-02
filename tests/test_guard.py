"""沙箱路径守卫（server/guard.py）单元测试。

覆盖三类真实威胁：`../` 穿越、软链接穿透、前缀误判；以及展示路径脱敏与文件树上限。
软链接用例在文件系统不支持时跳过（不应伪装通过）。
"""

import shutil
import tempfile
import unittest
from pathlib import Path

from server import guard


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wu-guard-")).resolve()
        self.ws = self.tmp / "ws"
        self.ws.mkdir()
        (self.ws / "a.py").write_text("print(1)\n", encoding="utf-8")
        (self.ws / "src").mkdir()
        (self.ws / "src" / "b.js").write_text("// b\n", encoding="utf-8")
        self.outside = self.tmp / "outside"
        self.outside.mkdir()
        (self.outside / "secret.txt").write_text("top-secret", encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _symlink(self, link: Path, target: Path) -> None:
        try:
            link.symlink_to(target, target_is_directory=target.is_dir())
        except (OSError, NotImplementedError):
            self.skipTest("当前文件系统不支持软链接")

    def test_inside_path_ok(self):
        self.assertEqual(guard.resolve_in(self.ws, "src/b.js"), self.ws / "src" / "b.js")
        # 工作区自身也算合法（前端列根目录）
        self.assertEqual(guard.resolve_in(self.ws, ""), self.ws)

    def test_dotdot_escape_rejected(self):
        with self.assertRaises(guard.SandboxEscape):
            guard.resolve_in(self.ws, "../outside/secret.txt")

    def test_absolute_path_rejected(self):
        with self.assertRaises(guard.SandboxEscape):
            guard.resolve_in(self.ws, "/etc/hosts")

    def test_symlink_dir_escape_rejected(self):
        self._symlink(self.ws / "etc", self.outside)
        with self.assertRaises(guard.SandboxEscape):
            guard.resolve_in(self.ws, "etc/secret.txt")
        # 指向工作区外的软链接本身也不允许被当作工作区内路径
        with self.assertRaises(guard.SandboxEscape):
            guard.resolve_in(self.ws, "etc")

    def test_symlink_file_escape_rejected(self):
        self._symlink(self.ws / "passwd", self.outside / "secret.txt")
        with self.assertRaises(guard.SandboxEscape):
            guard.resolve_in(self.ws, "passwd")

    def test_symlink_inside_is_allowed(self):
        self._symlink(self.ws / "alias.py", self.ws / "a.py")
        self.assertEqual(guard.resolve_in(self.ws, "alias.py"), self.ws / "a.py")

    def test_sibling_prefix_not_inside(self):
        # 字符串前缀陷阱：/x/ws2 不能被当成 /x/ws 的子路径
        sibling = self.tmp / "ws2"
        sibling.mkdir()
        with self.assertRaises(guard.SandboxEscape):
            guard.resolve_in(self.ws, "../ws2")

    def test_nul_byte_rejected(self):
        with self.assertRaises(guard.SandboxEscape):
            guard.resolve_in(self.ws, "a.py\x00.png")

    def test_display_masks_home(self):
        home = Path.home()
        self.assertEqual(guard.display(home / "WU-ai-Work"), "~/WU-ai-Work")
        self.assertEqual(guard.display(home), "~")
        self.assertEqual(guard.display("/opt/wu"), "/opt/wu")

    def test_tree_skips_shadow_dir_and_respects_depth(self):
        (self.ws / ".wu-shadow-git" / "info").mkdir(parents=True)
        (self.ws / ".wu-shadow-git" / "HEAD").write_text("x", encoding="utf-8")

        deep = guard.tree("", depth=2, root=self.ws)
        paths = [e["path"] for e in deep["entries"]]
        self.assertIn("a.py", paths)
        self.assertIn("src/b.js", paths)
        self.assertNotIn(".wu-shadow-git", paths)
        self.assertFalse(any(p.startswith(".wu-shadow-git/") for p in paths))

        shallow = guard.tree("", depth=1, root=self.ws)
        shallow_paths = [e["path"] for e in shallow["entries"]]
        self.assertIn("src", shallow_paths)
        self.assertNotIn("src/b.js", shallow_paths)
        self.assertTrue(all(e["depth"] == 1 for e in shallow["entries"]))

    def test_tree_limit(self):
        for i in range(20):
            (self.ws / f"f{i:02d}.txt").write_text("x", encoding="utf-8")
        data = guard.tree("", depth=1, root=self.ws, limit=5)
        self.assertEqual(len(data["entries"]), 5)
        self.assertTrue(data["truncated"])

    def test_tree_on_file_rejected(self):
        with self.assertRaises(guard.SandboxEscape):
            guard.tree("a.py", root=self.ws)


if __name__ == "__main__":
    unittest.main()
