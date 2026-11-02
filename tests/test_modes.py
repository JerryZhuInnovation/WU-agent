"""预设注册机制适配的单元测试（离线、不依赖已安装运行时）。

DSH 0.2.0 起 `$DSH_HOME/.agent-presets` 目录不再被读取，预设必须在 profile
patch 里用 `@deepseek-ai/dsh-agent-preset` 声明行登记；写错的表现是会话
resume 报 `Unknown agent preset`。这里守住「按版本选机制」和「声明 YAML 生成」
这两处纯逻辑。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dsh import modes  # noqa: E402

# 官方 standard.patch.yml 的关键缩进（plugins: 在 8 空格、子项 10 空格）
_STANDARD = """\
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              suffix: Your working directory is {{cwd}}.
              prefix: You are a coding agent powered by the {{model}} model.
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
"""


class PlaneTest(unittest.TestCase):
    def test_declaration_from_0_2_0(self):
        for v in ("0.2.0", "0.2.0-rc.2", "v0.3.1", "0.10.0"):
            self.assertEqual(modes.preset_plane(v), "declaration", v)

    def test_legacy_below_0_2_0(self):
        for v in ("0.1.5-rc.3", "0.1.9", "v0.0.1"):
            self.assertEqual(modes.preset_plane(v), "legacy", v)

    def test_legacy_when_unknown(self):
        # 版本读不出来时必须退化到 legacy（至少不写坏配置），不能当成 declaration
        for v in (None, "", "unknown", "1.x"):
            self.assertEqual(modes.preset_plane(v), "legacy", repr(v))


class PluginsBlockTest(unittest.TestCase):
    def test_extracts_block_verbatim(self):
        block = modes._plugins_block(_STANDARD)
        self.assertIsNotNone(block)
        # 缩进必须原样保留，否则拼回 YAML 会层级错乱
        self.assertTrue(block.startswith("          - id: persona"))
        self.assertIn("          - id: tool-fs", block)
        self.assertNotIn("plugins:", block)

    def test_none_without_plugins(self):
        self.assertIsNone(modes._plugins_block("- id: x\n  config:\n    a: 1\n"))


class PersonaTest(unittest.TestCase):
    def test_replaces_prefix(self):
        block = modes._plugins_block(_STANDARD)
        wu = modes._apply_wu_persona(block)
        self.assertIn("You are WU ai", wu)
        self.assertNotIn("You are a coding agent powered by the", wu)
        # 折叠块标量缩进须与原行一致（14 空格 prefix → 16 空格正文）
        self.assertIn("              prefix: >-", wu)
        self.assertIn("                You are WU ai", wu)
        # suffix 等无关行照旧
        self.assertIn("              suffix: Your working directory is {{cwd}}.", wu)


class DeclarationSectionTest(unittest.TestCase):
    def _runtime_dir(self) -> Path:
        d = Path(tempfile.mkdtemp()) / "node_modules" / "@deepseek-ai" / "dsh-web-app" / "presets"
        d.mkdir(parents=True)
        (d / "standard.patch.yml").write_text(_STANDARD, encoding="utf-8")
        return d.parent.parent.parent.parent

    def test_generates_declaration_and_registry(self):
        section = modes.declaration_preset_section("wu", self._runtime_dir())
        self.assertIsNotNone(section)
        # DSHY 已移除：只生成 WU 预设声明
        self.assertNotIn("preset-dshy", section)
        self.assertIn("id: preset-wu", section)
        # 关闭原版四个预设 + 注册表默认指向 wu
        for pid in ("standard", "ptc", "minimal", "cordis"):
            self.assertIn(f"- id: preset-{pid}\n  disabled: true", section)
        self.assertIn("- id: agent-preset-registry", section)
        self.assertTrue(section.rstrip().endswith("default: wu"))

    def test_wu_persona_replaces_original_only(self):
        section = modes.declaration_preset_section("wu", self._runtime_dir())
        self.assertEqual(section.count("          - id: persona"), 1)
        # wu 换成 WU 人设，原版人设不再出现
        self.assertNotIn("You are a coding agent powered by the", section)
        self.assertEqual(section.count("You are WU ai"), 1)

    def test_none_when_template_missing(self):
        # 取不到官方模板时返回 None，让调用方回退 legacy，而不是抛异常
        self.assertIsNone(modes.declaration_preset_section("wu", Path("/nonexistent-runtime")))


class PresetPatchSectionTest(unittest.TestCase):
    """profile_patch.preset_patch_section：按活动运行时版本选写法，取不到模板回退 legacy。"""

    def test_falls_back_to_legacy_on_old_runtime(self):
        from dsh import profile_patch
        from unittest import mock
        info = mock.Mock(version="0.1.5-rc.3", dir="/nonexistent")
        with mock.patch.object(profile_patch.manager, "find", return_value=info), \
             mock.patch.object(profile_patch.manager, "active_key", return_value="dsh-0.1.5-rc.3"):
            section = profile_patch.preset_patch_section("wu")
        self.assertIn("- id: agent-presets", section)
        self.assertIn("default: wu", section)

    def test_declaration_when_template_available(self):
        from dsh import profile_patch
        from unittest import mock
        tmp = Path(tempfile.mkdtemp()) / "node_modules" / "@deepseek-ai" / "dsh-web-app" / "presets"
        tmp.mkdir(parents=True)
        (tmp / "standard.patch.yml").write_text(_STANDARD, encoding="utf-8")
        info = mock.Mock(version="0.2.0-rc.2", dir=tmp.parent.parent.parent.parent)
        with mock.patch.object(profile_patch.manager, "find", return_value=info), \
             mock.patch.object(profile_patch.manager, "active_key", return_value="dsh-0.2.0-rc.2"):
            got = profile_patch.preset_patch_section("wu")
        self.assertIn("agent-preset-registry", got)
        self.assertIn("default: wu", got)


class ProviderDisableSectionTest(unittest.TestCase):
    """profile_patch.provider_disable_section：按 id 停用内置 DeepSeek 官方提供商。

    0.2.0 把官方提供商从 dsh-llm-deepseek 拆成 dsh-llm-deepseek-api-key /
    -account 两个插件，早先的文件补丁（改 apply 签名）因此失效，官方模型重新
    出现在模型选择器里。改用声明式 disabled 后，entry id 跨版本稳定。
    """

    def test_includes_account_only_on_declaration_plane(self):
        from dsh import profile_patch
        from unittest import mock
        info = mock.Mock(version="0.2.0-rc.2", dir="/nonexistent")
        with mock.patch.object(profile_patch.manager, "find", return_value=info), \
             mock.patch.object(profile_patch.manager, "active_key", return_value="dsh-0.2.0-rc.2"):
            section = profile_patch.provider_disable_section()
        self.assertIn("- id: llm-deepseek\n  disabled: true", section)
        self.assertIn("- id: llm-deepseek-account\n  disabled: true", section)

    def test_legacy_plane_keeps_only_base_entry(self):
        from dsh import profile_patch
        from unittest import mock
        info = mock.Mock(version="0.1.5-rc.3", dir="/nonexistent")
        with mock.patch.object(profile_patch.manager, "find", return_value=info), \
             mock.patch.object(profile_patch.manager, "active_key", return_value="dsh-0.1.5-rc.3"):
            section = profile_patch.provider_disable_section()
        self.assertIn("- id: llm-deepseek\n  disabled: true", section)
        # 0.1.x 没有账号版提供商，写进去只会让 patch 工具报 entry not found
        self.assertNotIn("llm-deepseek-account", section)


class MergedPatchTest(unittest.TestCase):
    """profile_patch.merged_patch：保留 DSH 自己回写的条目，只重写 WU 拥有的 id。

    DSH 的 Web 编辑器把界面设置写进 profile patch（如 ui-settings-general 的
    welcomeNoticeVersion = 「预览版说明」的确认状态）。控制中心整文件重写会把
    它抹掉，表现为确认过的告示反复弹出。
    """

    GENERATED = "- id: wu-ai-router\n  config:\n    mode: auto\n"
    DSH_ROW = "- id: ui-settings-general\n  name: '@deepseek-ai/dsh-client-ui-settings-general'\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n"

    def test_keeps_dsh_written_entry(self):
        from dsh import profile_patch
        merged = profile_patch.merged_patch(self.DSH_ROW, self.GENERATED)
        self.assertIn("welcomeNoticeVersion: 2026-09-28.1", merged)
        self.assertIn("- id: wu-ai-router", merged)
        self.assertEqual(merged.count("- id: ui-settings-general"), 1)

    def test_rewrites_owned_entry_instead_of_keeping_stale_copy(self):
        from dsh import profile_patch
        stale = "- id: wu-ai-router\n  config:\n    mode: manual\n"
        merged = profile_patch.merged_patch(stale, self.GENERATED)
        self.assertIn("mode: auto", merged)
        self.assertNotIn("mode: manual", merged)

    def test_idempotent_and_empty_existing(self):
        from dsh import profile_patch
        self.assertEqual(profile_patch.merged_patch("", self.GENERATED), self.GENERATED)
        once = profile_patch.merged_patch(self.DSH_ROW, self.GENERATED)
        self.assertEqual(profile_patch.merged_patch(once, self.GENERATED), once)

    def test_preserves_indented_insert_block(self):
        """缩进 0 才算顶层：insert 里的 preset 声明不能被当成需要保留的外来条目。"""
        from dsh import profile_patch
        generated = (
            "- insert:\n"
            "    - id: preset-wu\n"
            "      name: '@deepseek-ai/dsh-agent-preset'\n"
            "\n"
            "- id: agent-preset-registry\n"
            "  config:\n"
            "    default: wu\n"
        )
        merged = profile_patch.merged_patch("", generated)
        self.assertEqual(merged, generated)


if __name__ == "__main__":
    unittest.main()
