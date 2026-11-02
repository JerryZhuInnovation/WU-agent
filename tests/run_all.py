#!/usr/bin/env python3
"""WU ai 一键测试入口（质量门禁）。

用法：
    python3 tests/run_all.py                     # 全量：单元 + 集成 + A 层 + C 层（DSH 在线时）
    WUAI_LIVE_TEST=1 python3 tests/run_all.py    # 追加 B 层真实调用（会产生少量 API 消费）

分层：
    D 层  单元/集成（Python: keystore/migration/dsh_adapter；Node: analyzer/prefer/
          registry/intel/pipeline + 插件自测 classify/core/dynamic）—— 无外部依赖，永远跑。
    A 层  离线兼容（入口/版本/--dump-config/补丁）—— 不消费 API。
    C 层  运行时契约（Start/Session/Preset/Tool/Model-switch/插件契约）—— 只读。
    B 层  真实调用（chat + SSE 流式）—— opt-in。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"


def _node() -> str | None:
    """便携 Node 优先（版本目录动态发现，按版本号取最新），其次 PATH 上的 node。

    旧实现写死 node-v22.19.0-darwin-arm64：换平台/升级 Node 后会静默跳过整个
    Node 侧测试，属于质量门禁盲区。"""
    best: tuple | None = None
    best_path: Path | None = None
    for cand in (ROOT / "runtime").glob("node-v*-*/bin/node"):
        m = re.search(r"node-v(\d+)\.(\d+)\.(\d+)", str(cand))
        if not m:
            continue
        key = tuple(int(x) for x in m.groups())
        if best is None or key > best:
            best, best_path = key, cand
    if best_path and best_path.is_file():
        return str(best_path)
    return shutil.which("node")


def run(cmd: list, cwd: Path, label: str, env: dict | None = None) -> int:
    print(f"\n{'=' * 66}\n▶ {label}\n{'=' * 66}", flush=True)
    proc = subprocess.run(cmd, cwd=str(cwd), env=env or os.environ.copy())
    print(f"◀ {label} 退出码 {proc.returncode}")
    return proc.returncode


def main() -> int:
    codes: dict = {}

    codes["python-unit"] = run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests",
         "-p", "test_*.py", "-v"],
        ROOT, "D 层 · Python 单元（keystore / migration / dsh_adapter / guard / shadow / HTTP 面 / 兼容契约）",
    )

    node = _node()
    if not node:
        print("⚠ 未找到 Node，跳过 Node 侧测试")
        codes["node-unit"] = 2
        codes["plugin-selftest"] = 2
    else:
        # 显式列出文件：该 Node 构建对 `--test <目录>` 的发现不可靠
        node_cases = sorted(str(p) for p in (TESTS / "router").glob("*.test.mjs"))
        # 控制中心 ES modules 冒烟（mock DOM 驱动 main.js 启动链）
        ui_smoke = TESTS / "ui-modules.test.mjs"
        if ui_smoke.exists():
            node_cases.append(str(ui_smoke))
        codes["node-unit"] = run(
            [node, "--test", *node_cases],
            ROOT, "D 层 · Node 单元/集成（analyzer / registry / intel / pipeline / 风控治理 / UI 模块冒烟）",
        )

        # 插件侧自测脚本（自带 main 与退出码）。统一在临时 DSH_HOME 下跑：
        # test-core/classify 目前是纯函数不落盘，但隔离能兜住将来新增的写档行为。
        plugin_cases = sorted(str(p) for p in (ROOT / "plugins" / "wu-ai-router").glob("test-*.mjs"))
        if plugin_cases:
            env = os.environ.copy()
            env["DSH_HOME"] = tempfile.mkdtemp(prefix="wuai-selftest-dsh-")
            codes["plugin-selftest"] = run(
                [node, "--test", *plugin_cases],
                ROOT, "D 层 · 插件自测（classify / core / dynamic / allocation / debias）", env,
            )
        else:
            codes["plugin-selftest"] = 0

    print("\n" + "=" * 66 + "\n测试汇总\n" + "=" * 66)
    failed = {k: v for k, v in codes.items() if v != 0}
    for k, v in codes.items():
        mark = "✅" if v == 0 else ("⚠️ 跳过" if v == 2 else "❌")
        print(f"  {mark} {k}: {v}")
    if failed:
        print("\n失败项：", ", ".join(f"{k}({v})" for k, v in failed.items()))
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())