#!/usr/bin/env python3
"""WU ai 模式体系：只保留 WU 一组预设（DSHY 模式已于 2026-10-13 移除）。

DSH 有两种预设注册机制，按版本自动选择：
- legacy（< 0.2.0）：`$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}`，
  由 `- id: agent-presets / includeUserRoot: true` 行扫描该目录。
- declaration（>= 0.2.0）：该目录已无人读取，预设改为 bundle patch 里的
  `@deepseek-ai/dsh-agent-preset` 声明行，注册表行 id 变为
  `agent-preset-registry`。0.2.0 起由 `declaration_preset_section()` 生成声明 YAML。
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

DECLARATION_MIN = (0, 2, 0)
_ORIG_PERSONA = "powered by the {{model}} model"
_WU_PERSONA_LINES = (
    "You are WU ai, a personal AI coding agent powered by the {{model}} model.",
    "ALWAYS reply in Simplified Chinese unless the user asks otherwise.",
    "Routing is always smart: analyze the task, pick the best available model, and explain the choice briefly. File writes stay in workspace sandbox.",
)


def preset_plane(version: str | None) -> str:
    """预设注册机制：declaration（0.2.0+）或 legacy（更早/版本未知）。"""
    m = re.match(r"\s*v?(\d+)\.(\d+)\.(\d+)", version or "")
    if not m:
        return "legacy"
    return "declaration" if tuple(int(x) for x in m.groups()) >= DECLARATION_MIN else "legacy"


def find_declaration_presets_dir(runtime_dir) -> Path | None:
    """定位 `@deepseek-ai/dsh-web-app/presets`（声明式预设的官方模板来源）。"""
    if not runtime_dir:
        return None
    d = Path(runtime_dir) / "node_modules" / "@deepseek-ai" / "dsh-web-app" / "presets"
    return d if (d / "standard.patch.yml").is_file() else None


def _plugins_block(text: str) -> str | None:
    """取出 patch 文件里 `config.plugins:` 下的原始文本块（缩进原样保留）。"""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip() != "plugins:":
            continue
        indent = len(line) - len(line.lstrip())
        block: list = []
        for nxt in lines[i + 1:]:
            if nxt.strip() and (len(nxt) - len(nxt.lstrip())) <= indent:
                break
            block.append(nxt)
        return "\n".join(block).rstrip("\n") or None
    return None


def _apply_wu_persona(block: str) -> str:
    """把 persona 行的 prefix 换成 WU 人设（折叠块标量，缩进沿用原行）。"""
    out: list = []
    for line in block.splitlines():
        if re.match(r"^\s*prefix:\s+.*" + re.escape(_ORIG_PERSONA), line):
            indent = " " * (len(line) - len(line.lstrip()))
            out.append(f"{indent}prefix: >-")
            out.extend(f"{indent}  {seg}" for seg in _WU_PERSONA_LINES)
            continue
        out.append(line)
    return "\n".join(out)


def declaration_preset_section(default_id: str, runtime_dir, preset_desc: dict | None = None) -> str | None:
    """0.2.0+：生成 WU 预设声明 + 关闭原版预设 + 指定默认预设的 YAML 段。

    以 DSH 自带的 standard 预设为模板派生（而不是复用 legacy 的
    agent.cordis.yml —— 包名跨版本会改名，照抄会在激活时失败）。
    取不到模板时返回 None，由调用方回退到 legacy 写法。
    """
    presets_dir = find_declaration_presets_dir(runtime_dir)
    if presets_dir is None:
        return None
    try:
        standard = (presets_dir / "standard.patch.yml").read_text(encoding="utf-8")
    except OSError:
        return None
    block = _plugins_block(standard)
    if not block:
        return None
    wu_block = _apply_wu_persona(block)
    desc = preset_desc or {}
    shipped_off = "\n".join(
        f"- id: preset-{pid}\n  disabled: true"
        for pid in ("standard", "ptc", "minimal", "cordis")
    )
    return f"""- insert:
    - id: preset-wu
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: wu
        name: "{desc.get('wu_name', 'WU 模式')}"
        description: "{desc.get('wu_desc', 'WU ai 智能工作台：把任务交给 WU-ai，它自动理解意图、分配模型、执行并验证结果。')}"
        order: 1
        plugins:
{wu_block}

{shipped_off}

- id: agent-preset-registry
  config:
    default: {default_id}"""


def _is_standard_preset(c: Path) -> bool:
    return (c / "agent.cordis.yml").is_file()


def find_standard_preset_src() -> Path | None:
    """定位 DSH 的 standard preset（agent.cordis.yml 所在目录）。

    优先级：① 环境变量 WU_AI_STANDARD_PRESET 显式指定（跨机器/定制安装）
            ② 相邻 agent 源码（开发态，仓库并列时）
            ③ 预装的 @deepseek-ai/dsh 包里 rglob
    """
    pkg_root = Path(__file__).resolve().parent.parent  # = wu-ai/

    explicit = os.environ.get("WU_AI_STANDARD_PRESET")
    if explicit:
        c = Path(explicit)
        if _is_standard_preset(c):
            return c

    # 相邻源码仓库：<父级>/agent/deepseek-harness-master/...
    for parent in (pkg_root.parent, pkg_root):
        src = (
            parent
            / "agent"
            / "deepseek-harness-master"
            / "packages"
            / "preset"
            / "agent-presets"
            / "presets"
            / "standard"
        )
        if _is_standard_preset(src):
            return src

    runtime_root = pkg_root / "runtime"
    # 版本化安装目录（runtime/dsh/dsh-<ver>，新版本优先）→ legacy dsh-app 兜底
    candidates = sorted(
        runtime_root.glob("dsh/dsh-*/node_modules/@deepseek-ai/dsh"), reverse=True
    )
    candidates.append(runtime_root / "dsh-app" / "node_modules" / "@deepseek-ai" / "dsh")
    for app in candidates:
        if app.is_dir():
            for p in app.rglob("agent-presets/presets/standard"):
                if _is_standard_preset(p):
                    return p
    return None


def _apply_persona(text: str, persona_prefix: str) -> str:
    old = "    prefix: >-\n      You are a coding agent powered by the {{model}} model.\n"
    new = f"    prefix: >-\n{persona_prefix}"
    if old in text:
        return text.replace(old, new, 1)
    return text


def ensure_mode_presets(dsh_home: Path, standard_src: Path | None = None) -> None:
    """创建/修复 WU 预设；清理已退役的 DSHY 与原版模式目录（只保留 WU）。

    legacy 机制（<0.2.0）才需要落盘 user preset；declaration 机制下预设由
    patch 声明生成，这里只做孤儿清理。
    """
    if standard_src is None:
        standard_src = find_standard_preset_src()

    root = dsh_home / ".agent-presets"
    # 孤儿清理：DSHY 与四个原版模式已退役，旧安装残留的目录会让
    # includeUserRoot 继续加载它们——必须删除（幂等）。
    for retired in ("dshy", "standard", "ptc", "minimal", "cordis"):
        stale = root / retired
        if stale.exists():
            shutil.rmtree(stale, ignore_errors=True)

    if standard_src is None or not standard_src.is_dir():
        return
    root.mkdir(parents=True, exist_ok=True)

    # WU：标准能力 + WU 人设
    wu = root / "wu"
    wu_agent = wu / "agent.cordis.yml"
    if not wu_agent.exists() or wu_agent.stat().st_size < 5000:
        if wu.exists():
            shutil.rmtree(wu)
        shutil.copytree(standard_src, wu, dirs_exist_ok=True)
        (wu / "preset.yml").write_text(
            "name: WU 模式\n"
            "description: WU ai 智能工作台：把任务交给 WU-ai，它自动理解意图、分配模型、执行并验证结果。\n",
            encoding="utf-8",
        )
        text = (wu / "agent.cordis.yml").read_text(encoding="utf-8")
        text = _apply_persona(
            text,
            "\n".join(f"      {seg}" for seg in _WU_PERSONA_LINES) + "\n",
        )
        (wu / "agent.cordis.yml").write_text(text, encoding="utf-8")
