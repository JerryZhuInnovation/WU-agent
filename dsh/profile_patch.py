"""WU ai → DSH 的配置渲染层：settings/credentials/profile patch/live 门控文件。

这里集中「从 WU 配置模型生成 DSH 侧全部线上配置」的知识：
- write_dsh_config：settings.yaml + .credentials.yaml（委托 adapter）+ router 插件配置
- write_router_plugin_config / merged_patch：profile cordis.patch.yml 的 WU 拥有条目
- preset_patch_section / provider_disable_section：预设与内置提供商的声明式停用
"""

from __future__ import annotations

import json
import re

from core.config import CAP_KEYS
from core.log import log
from core.paths import DSH_HOME, DEFAULT_WORKSPACE, ROOT
from dsh import adapter, manager
from dsh.modes import (
    declaration_preset_section,
    preset_plane,
)


def write_dsh_config(cfg: dict, proxy=None) -> None:
    """把 WU 配置模型渲染为 DSH settings.yaml + .credentials.yaml + router 插件配置。

    proxy：凭据代理实例（P2-9）。传入时 settings 的 baseURL 指向代理、
    credentials 写占位符；None 为直连模式（真 Key 落 DSH 侧文件）。
    """
    adapter.write_config(DSH_HOME, cfg, log=log, proxy=proxy)
    write_router_plugin_config(cfg, proxy=proxy)


def cleanup_legacy_gates() -> None:
    """兼容清理：手动路由/强制模型与 DSHY 预设已移除，旧版写过的文件不再被读取。"""
    try:
        DSH_HOME.mkdir(parents=True, exist_ok=True)
        for legacy in (
            "wu-ai-routing-mode.txt",
            "wu-ai-preset-mode.txt",
            # 单轮强制模型（wu-ai-model-override.json）已随发射台 Auto 下拉一起退役
            "wu-ai-model-override.json",
        ):
            f = DSH_HOME / legacy
            if f.exists():
                f.unlink()
    except OSError:
        pass


def preset_patch_section(default_id: str = "wu") -> str:
    """按活动运行时的版本选择预设注册写法（只保留 WU，default 恒 wu）。

    0.2.0 起 `$DSH_HOME/.agent-presets` 不再被读取，预设必须在 patch 里声明
    （`@deepseek-ai/dsh-agent-preset` + `agent-preset-registry`）。取不到声明
    模板时回退 legacy 写法，至少不让配置写坏。
    """
    info = manager.find(manager.active_key())
    if info is not None and preset_plane(info.version) == "declaration":
        section = declaration_preset_section(default_id, info.dir)
        if section:
            return section
    return (
        "- id: agent-presets\n"
        "  config:\n"
        f"    default: {default_id}\n"
        "    includeShippedRoot: false\n"
        "    includeUserRoot: true"
    )


def provider_disable_section() -> str:
    """声明式停用 DSH 内置的 DeepSeek 官方提供商（WU ai 只用用户添加的模型）。

    0.1.x 用文件补丁改 `dsh-llm-deepseek` 的 apply()，但 0.2.0 把该包降级成共享
    库、提供商拆到 `dsh-llm-deepseek-api-key` / `-account` 两个插件，签名补丁就此
    失效（官方模型重新出现）。base 组合里的 entry id 跨版本稳定，所以改为按 id
    停用：不碰任何厂商文件，换版也不会失效。
    """
    entries = ["llm-deepseek"]
    info = manager.find(manager.active_key())
    if info is not None and preset_plane(info.version) == "declaration":
        entries.append("llm-deepseek-account")  # 账号版提供商 0.2.0 才拆出来
    return "\n\n".join(f"- id: {e}\n  disabled: true" for e in entries)


def write_router_plugin_config(cfg: dict, proxy=None) -> None:
    profile_dir = DSH_HOME / "profiles" / "web"
    adapter.ensure_profile_package_json(
        profile_dir,
        ROOT / "plugins" / "wu-ai-router",
        ROOT / "plugins" / "wu-ai-ui",
        log=log,
    )
    adapter.sync_plugin_artifacts(
        profile_dir,
        ROOT / "plugins" / "wu-ai-ui",
        log=log,
    )
    models = [m for m in (cfg.get("models") or []) if m.get("enabled")]
    prefer = cfg.get("prefer") or {}
    analyzer = cfg.get("analyzerModelId") or ""

    prefer_y = "\n".join(f"      {k}: {v}" for k, v in prefer.items()) or "      {}"
    preset_section = preset_patch_section("wu")  # 只保留 WU 模式（DSHY 已移除）
    provider_section = provider_disable_section()

    model_blocks = []
    for m in models:
        caps = m.get("capabilities") or {}
        cap_lines = "\n".join(f"              {k}: {float(caps.get(k, 0) or 0)}" for k in CAP_KEYS)
        model_blocks.append(
            f"""          - key: {m['id']}
            provider: {m['id']}
            label: {json.dumps(m.get('label') or m['id'], ensure_ascii=False)}
            model: {m.get('model') or m['id']}
            enabled: true
            costScore: {float(m.get('costScore', 0.8))}
            latencyScore: {float(m.get('latencyScore', 0.7))}
            capabilities:
{cap_lines}"""
        )
    models_y = "\n".join(model_blocks) if model_blocks else "          []"

    # 默认模型与 provider 注册也写进 patch：DSH 的 settings.yaml 导入是「历史迁移」
    # 语义，旧条目会留在 patch 里（曾出现默认模型永远指向已删除的 zhipu）。
    # 这里把两个条目纳入 WU 拥有集合，merged_patch 会顶掉旧值。
    dprov, dmodel = (models[0]["id"], models[0].get("model") or models[0]["id"]) if models else ("", "")
    chosen = next((m for m in models if m["id"] == (cfg.get("defaultModelId") or "")), None)
    if chosen is not None:
        dprov, dmodel = chosen["id"], chosen.get("model") or chosen["id"]
    providers_y = adapter.providers_config_yaml(cfg, proxy=proxy, indent=6) or "      {}"

    patch = f"""# User layer — 由 WU ai 控制中心生成
- id: system-prompt
  config:
    personaPrefix: >-
      You are WU ai, a capable personal AI agent powered by the {{{{model}}}} model.
      ALWAYS reply in Simplified Chinese (简体中文). Do not use English unless
      the user explicitly asks for another language.
      文件沙箱：write/edit 只允许写入当前工作区 {{{{cwd}}}} 与系统临时目录。
    personaSuffix: Your working directory is {{{{cwd}}}}. Sandbox mode is workspace-write.

- id: attachment-local
  config:
    dshHome: !!js dshHomePath('')
    maxImageBytes: 41943040
    maxImagesPerMessage: 40
    maxMessageImageBytes: 209715200
    maxImagePixels: 200000000
    maxImageDimension: 16384
    normalizedImageMaxPixels: 33554432
    normalizedImageMaxDimension: 8192
    normalizedImageMaxBytes: 16777216
    imageCompressionConcurrency: 2

- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: {DEFAULT_WORKSPACE}

{provider_section}

- id: agent-default-model
  config:
    provider: {dprov}
    model: {dmodel}

- id: llm-pi-ai
  config:
    providers:
{providers_y}

{preset_section}

- id: wu-ai-router
  name: dsh-wu-ai-router
  config:
    mode: auto
    analyzerModelId: {json.dumps(analyzer)}
    budget:
      costWeight: 0.25
      latencyWeight: 0.15
    verify:
      enabled: true
      maxRounds: 1
      minScore: 0.75
      preferDifferent: true
    prefer:
{prefer_y}
    models:
{models_y}
"""
    patch_path = profile_dir / "cordis.patch.yml"
    try:
        existing = patch_path.read_text(encoding="utf-8")
    except OSError:
        existing = ""
    patch_path.write_text(merged_patch(existing, patch), encoding="utf-8")
    log(f"已写入 Router 插件配置: {patch_path}")


def _owned_entry_ids(text: str) -> set:
    """取一段 patch 文本里顶层的 `- id:` 集合（缩进 0 才算顶层）。"""
    return {m.group(1) for m in re.finditer(r"^- id:\s*(\S+)\s*$", text, re.MULTILINE)}


def merged_patch(existing: str, generated: str) -> str:
    """把生成内容与「DSH 自己写进 patch 的条目」合并。

    DSH 的 Web 编辑器会把界面设置回写到 profile patch 末尾（例如
    `ui-settings-general.welcomeNoticeVersion` 是「预览版说明」的确认状态）。
    控制中心每次启动都整文件重写，会把它们一起抹掉 —— 表现为确认过的告示反复
    弹出。这里保留所有**不属于 WU 生成集合**的顶层条目块（缩进原样），只重写
    WU 自己拥有的那些 id。
    """
    owned = _owned_entry_ids(generated)
    kept: list = []
    block: list = []

    def flush() -> None:
        if not block:
            return
        text = "\n".join(block)
        ids = _owned_entry_ids(text + "\n")
        if ids and not (ids & owned):
            kept.append(text)

    for line in (existing or "").splitlines():
        if line.startswith("- ") and block:
            flush()
            block = []
        block.append(line)
    flush()
    if not kept:
        return generated
    return generated.rstrip("\n") + "\n\n" + "\n\n".join(kept) + "\n"
