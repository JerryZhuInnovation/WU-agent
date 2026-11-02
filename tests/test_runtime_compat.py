"""Runtime 兼容契约测试（A / C / B 三层）。

- A 层（离线）：runtime_manager.compat_check —— 入口存在 / 版本可读 /
  --dump-config 配置树可组装 / 运行时补丁。全部离线，不产生 API 消费。
- C 层（在线只读）：对**正在运行**的 DSH web 做契约冒烟 —— token 存活、
  Session/Preset/Tool/Model-switch API 面、/plugins 合并 bundle 同时含
  原版 DSH 插件与客户端半体（「兼容原版 DSH 所有插件」契约）。DSH 未运行则跳过。
- B 层（真实调用，opt-in）：WUAI_LIVE_TEST=1 时直连启用中的 provider 做最小
  chat（含 SSE 流式）请求，验证 wire 层 Streaming / 模型切换真实可用。
  默认关闭（会产生少量 API 消费）。
"""

from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dsh import upgrade as runtime_api  # noqa: E402
from dsh import manager as runtime_manager  # noqa: E402
from core import config as start_config  # noqa: E402 — 配置读取
from core.paths import DSH_URL_FILE, DSH_PORT, HOST  # noqa: E402
from server import launcher as start  # noqa: E402 — find_node/dsh_token_url


def _node() -> str | None:
    return start.find_node()


class LayerATest(unittest.TestCase):
    """A 层：已安装运行时全部做离线兼容检查（不消费 API）。"""

    def test_offline_compat_of_all_runtimes(self):
        node = _node()
        if not node:
            self.skipTest("Node 未安装")
        infos = runtime_manager.discover()
        if not infos:
            # 全新 clone 还没装运行时：跳过而非失败（start.py 首次启动后 A 层自动覆盖）
            self.skipTest("尚未安装运行时（start.py 首次启动时安装）")
        for info in infos:
            report = runtime_manager.compat_check(node, info, refresh=True)
            names = [c.name for c in report.checks]
            self.assertIn("入口", names)
            self.assertIn("版本", names)
            entry = next(c for c in report.checks if c.name == "入口")
            version = next(c for c in report.checks if c.name == "版本")
            # 入口与版本是纯文件系统事实：任何环境下都必须是 ok
            self.assertEqual(entry.status, "ok", f"{info.key}: {entry.detail}")
            self.assertEqual(version.status, "ok", f"{info.key}: {version.detail}")


class LayerCTest(unittest.TestCase):
    """C 层：对运行中的 DSH web 做只读契约冒烟。"""

    def _live(self) -> tuple[str, str] | None:
        url_file = DSH_URL_FILE
        if not url_file.is_file():
            # 本副本从未启动过 DSH：不接管机器上别的实例（全新 clone 应跳过 C 层）
            return None
        token_url = url_file.read_text(encoding="utf-8").strip()
        if not token_url.startswith("http"):
            token_url = start.dsh_token_url()
        if not token_url.startswith("http://"):
            return None
        try:
            with socket.create_connection((start.HOST, start.DSH_PORT), timeout=1):
                pass
        except OSError:
            return None
        from urllib.parse import urlparse
        p = urlparse(token_url)
        return f"{p.scheme}://{p.netloc}", token_url

    def test_contract_smoke_live(self):
        live = self._live()
        if live is None:
            self.skipTest("DSH web 未运行，跳过 C 层（启动后自动覆盖）")
        base, token_url = live
        checks = runtime_api.contract_smoke(base, token_url)
        self.assertTrue(checks, "契约检查列表不应为空")
        failed = [c for c in checks if c["status"] == "fail"]
        for c in checks:
            print(f"  [{c['status']:4s}] {c['name']}: {c['detail']}")
        self.assertEqual(failed, [], f"运行时契约不通过: {failed}")


class LayerBTest(unittest.TestCase):
    """B 层（opt-in）：直连 provider 的最小 chat + SSE 流式，验证真实可用。"""

    def test_live_model_switch_and_stream(self):
        if os.environ.get("WUAI_LIVE_TEST") != "1":
            self.skipTest("WUAI_LIVE_TEST=1 才运行 B 层（会产生 API 消费）")
        cfg = start_config.load_config()
        models = [m for m in cfg.get("models") or [] if m.get("enabled") and m.get("apiKey")]
        self.assertTrue(models, "没有带 Key 的启用模型")

        import http.client
        import urllib.error
        import urllib.request

        for m in models:  # 每个模型都试一次 = Model switch 面逐一切换
            base = (m.get("baseURL") or "").rstrip("/")
            if not base.startswith("http"):
                continue
            for stream in (False, True):
                body = json.dumps({
                    "model": m.get("model"),
                    "messages": [{"role": "user", "content": "用一句话回答：1+1=？"}],
                    "max_tokens": 64,
                    "stream": stream,
                }).encode("utf-8")
                req = urllib.request.Request(
                    f"{base}/chat/completions", data=body,
                    headers={"Content-Type": "application/json",
                             "Authorization": f"Bearer {m['apiKey']}"},
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        text = resp.read(2000).decode("utf-8", "replace")
                except urllib.error.HTTPError as e:
                    self.fail(f"{m['id']} stream={stream} HTTP {e.code}: {e.read(300)!r}")
                self.assertTrue(text, f"{m['id']} stream={stream} 空响应")
                print(f"  [ok] {m['id']} stream={stream} resp={len(text)}B")


class PatchStatusTest(unittest.TestCase):
    """运行时补丁状态判定（离线）。

    0.2.0 把 `dsh-llm-deepseek` 降级成共享库（只导出 registerDeepSeekProvider），
    官方提供商改由独立插件注册 —— 文件补丁在此无从下手，必须报 "moved"（ok），
    而不是误导性的 "unsupported"（warn：内置官方模型可能重新出现）。
    """

    def _runtime(self, body: str) -> Path:
        d = Path(tempfile.mkdtemp())
        f = d / runtime_manager.PATCH_TARGET
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(body, encoding="utf-8")
        return d

    def test_missing_target_is_na(self):
        self.assertEqual(runtime_manager.patch_status(Path(tempfile.mkdtemp())), "n/a")

    def test_marker_means_applied(self):
        d = self._runtime(
            "function apply(ctx, config) {\n\t" + runtime_manager.PATCH_MARKER + " return;\n}\n"
        )
        self.assertEqual(runtime_manager.patch_status(d), "applied")
        # 已应用：不再改写文件
        self.assertEqual(runtime_manager.apply_runtime_patch(d), "applied")

    def test_shared_library_is_moved(self):
        """0.2.0：不再是插件（无 apply），只导出 registerDeepSeekProvider。"""
        d = self._runtime("export { registerDeepSeekProvider };\n")
        self.assertEqual(runtime_manager.patch_status(d), "moved")
        self.assertEqual(runtime_manager.apply_runtime_patch(d), "moved")

    def test_unknown_signature_stays_unsupported(self):
        """签名变了但不认识：仍按 unsupported 报出来，提示人工跟进。"""
        d = self._runtime("function setup(ctx) {}\n")
        self.assertEqual(runtime_manager.patch_status(d), "unsupported")


class PruneStaleTest(unittest.TestCase):
    """旧版本收敛的安全前提（离线）。"""

    def test_skips_when_active_is_legacy(self):
        """指针还停在 legacy 时不能清理——此时并排版本可能刚装好还没切换。"""
        with mock.patch.object(runtime_manager, "active_key", return_value="legacy"), \
             mock.patch.object(runtime_manager, "prune_runtimes") as pr:
            res = runtime_manager.prune_stale()
        pr.assert_not_called()
        self.assertEqual(res["removed"], [])

    def test_keeps_active_and_previous(self):
        """收敛时保留「当前版 + 上一版」，两者都不得出现在删除集合里。"""
        with mock.patch.object(runtime_manager, "active_key", return_value="dsh-a"), \
             mock.patch.object(runtime_manager, "previous_key", return_value="dsh-b"), \
             mock.patch.object(runtime_manager, "discover", return_value=[]), \
             mock.patch.object(runtime_manager, "VERSIONED_ROOT", Path("/nonexistent-wu-ai")), \
             mock.patch.object(runtime_manager, "prune_runtimes",
                               return_value={"removed": [], "kept": [], "skipped": []}) as pr:
            runtime_manager.prune_stale()
        keep = pr.call_args[0][0]
        self.assertIn("dsh-a", keep)
        self.assertIn("dsh-b", keep)


if __name__ == "__main__":
    unittest.main()