"""dsh_adapter 单元测试：DSH 线上格式生成（settings/credentials/launch/profile）。"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dsh import adapter as dsh_adapter  # noqa: E402


def _cfg():
    return {
        "schemaVersion": 2,
        "defaultModelId": "deepseek",
        "routingMode": "manual",
        "models": [
            {
                "id": "deepseek",
                "label": "DeepSeek",
                "apiKey": "sk-test-deepseek",
                "baseURL": "https://api.deepseek.com",
                "api": "openai-completions",
                "access": "api",
                "model": "deepseek-flash",
                "capabilities": {"reasoning": 0.9, "vision": 0},
                "enabled": True,
            },
            {
                "id": "xiaomi",
                "label": "小米 MiMo",
                "apiKey": "sk-test-xiaomi",
                "baseURL": "https://api.xiaomimimo.com/v1",
                "api": "openai-completions",
                "access": "api",
                "model": "mimo-v2.5",
                "capabilities": {"vision": 0.9},
                "enabled": True,
            },
            {
                "id": "off",
                "label": "停用模型",
                "apiKey": "sk-should-not-appear",
                "baseURL": "https://x.example.com",
                "enabled": False,
            },
        ],
    }


class AdapterSettingsTest(unittest.TestCase):
    def test_providers_and_default(self):
        s = dsh_adapter.settings_yaml(_cfg())
        self.assertIn("agent-default-model:", s)
        self.assertIn("provider: deepseek", s)
        self.assertIn("model: deepseek-flash", s)
        self.assertIn("llm-pi-ai:", s)
        self.assertIn("deepseek:", s)
        self.assertIn("apiKeyEnv: WUAI_DEEPSEEK_KEY", s)
        self.assertIn("displayName: DeepSeek", s)
        # 停用模型不产生 provider 段（其 Key 也不得出现在 settings 里）
        self.assertNotIn("sk-should-not-appear", s)
        self.assertNotIn("displayName: 停用模型", s)

    def test_reasoning_efforts_max_maps_to_high(self):
        s = dsh_adapter.settings_yaml(_cfg())
        self.assertIn("max: high", s)
        self.assertNotIn("max: max", s)
        self.assertIn("supportsReasoningEffort: true", s)

    def test_vision_model_gets_image_input(self):
        s = dsh_adapter.settings_yaml(_cfg())
        # xiaomi 段内有 input: [text, image]
        idx = s.index("xiaomi:")
        self.assertIn("input: [text, image]", s[idx:])

    def test_credentials_only_enabled_with_key(self):
        c = dsh_adapter.credentials_yaml(_cfg())
        self.assertIn("WUAI_DEEPSEEK_KEY: sk-test-deepseek", c)
        self.assertIn("WUAI_XIAOMI_KEY: sk-test-xiaomi", c)
        self.assertNotIn("sk-should-not-appear", c)
        self.assertIn("version: 1", c)

    def test_foreign_sections_preserved(self):
        with tempfile.TemporaryDirectory(prefix="wuai-ad-") as td:
            home = Path(td)
            (home / "settings.yaml").write_text(
                "ui-onboarding:\n  shown: true\n",
                encoding="utf-8",
            )
            s = dsh_adapter.settings_yaml(_cfg(), home)
            self.assertIn("ui-onboarding:", s)
            self.assertIn("shown: true", s)

    def test_launch_command_variants(self):
        n = "/x/node"
        # 默认带 --no-open：控制中心把对话面内嵌进单页，DSH 不该再开一个标签页
        self.assertEqual(dsh_adapter.launch_command(n, "/d/lib/bin.js"), [n, "/d/lib/bin.js", "web", "--no-open"])
        dsh_bin = "/d/bin/dsh"
        self.assertEqual(dsh_adapter.launch_command(n, dsh_bin), [dsh_bin, "web", "--no-open"])
        self.assertEqual(
            dsh_adapter.launch_command(n, "npx")[1:],
            [str(Path(n).parent / "npx"), "--yes", "@deepseek-ai/dsh@latest", "web", "--no-open"],
        )

    def test_launch_command_can_keep_native_browser_open(self):
        n = "/x/node"
        self.assertEqual(dsh_adapter.launch_command(n, "/d/lib/bin.js", no_open=False), [n, "/d/lib/bin.js", "web"])


class AdapterProfileTest(unittest.TestCase):
    def test_ensure_profile_preserves_manual_edits(self):
        with tempfile.TemporaryDirectory(prefix="wuai-prof-") as td:
            prof = Path(td)
            router = Path(td) / "r"
            ui = Path(td) / "u"
            router.mkdir(); ui.mkdir()
            # 预置人工文件：自定义 name + 人工依赖
            (prof / "package.json").write_text(
                json.dumps({
                    "name": "my-custom-profile",
                    "dependencies": {"some-manual-dep": "^1.0.0"},
                    "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base"]}},
                }),
                encoding="utf-8",
            )
            dsh_adapter.ensure_profile_package_json(prof, router, ui)
            data = json.loads((prof / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(data["name"], "my-custom-profile")  # 人工字段不动
            self.assertIn("some-manual-dep", data["dependencies"])
            self.assertIn("dsh-wu-ai-router", data["dependencies"])
            self.assertIn("dsh-wu-ai-ui", data["dependencies"])
            for b in dsh_adapter.PROFILE_BUNDLES_DEFAULT:
                self.assertIn(b, data["dsh"]["profile"]["bundles"])
            self.assertEqual(data["dsh"]["profile"].get("patchReload"), "live")

    def test_ensure_idempotent(self):
        with tempfile.TemporaryDirectory(prefix="wuai-prof2-") as td:
            prof = Path(td)
            router = Path(td) / "r"
            ui = Path(td) / "u"
            router.mkdir(); ui.mkdir()
            p1 = dsh_adapter.ensure_profile_package_json(prof, router, ui)
            text1 = p1.read_text(encoding="utf-8")
            p2 = dsh_adapter.ensure_profile_package_json(prof, router, ui)
            self.assertEqual(p2.read_text(encoding="utf-8"), text1)


if __name__ == "__main__":
    unittest.main()