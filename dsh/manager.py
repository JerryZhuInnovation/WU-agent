#!/usr/bin/env python3
"""WU ai 运行时管理：DSH Runtime Adapter + 版本并存 + 兼容门控 + 切换/回滚。

设计原则（防 DSH 锁定）：
- WU ai 自己的 Core（Router/Verifier/配置）不 import DSH 内部模块；start.py 只通过
  本模块的 Runtime API（discover / active / compat / install / switch）与 DSH 交互。
- DSH 版本并存：新版装进 runtime/dsh/dsh-<version>/，旧版不动，互不覆盖。
- 激活指针是配置文件 data/runtime-current.json，不是符号链接（跨平台）。
- 升级流程：检查更新 → 安装到独立目录 → A 层兼容测试 → 测试通过才可切换；出问题
  用「回滚上一版本」应急。回滚走应急通道，不经过兼容门控。
- A 层兼容测试全部离线（不产生 API 消费）：入口存在、版本可读、--dump-config
  配置树可组装（插件/bundle/patch 与目标版本兼容的最好证明）、运行时补丁可应用。
"""

from __future__ import annotations

import json
import platform
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import sys as _sys

_sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 直跑 self-test 时解析 core.*

from core.paths import (  # noqa: E402
    DATA,
    DSH_HOME,
    DEFAULT_WORKSPACE,
    RUNTIME,
)

LEGACY_DIR = RUNTIME / "dsh-app"
VERSIONED_ROOT = RUNTIME / "dsh"
CURRENT_FILE = DATA / "runtime-current.json"

# 运行时补丁：停用 DSH 内置 DeepSeek 官方提供方（WU ai 只用用户添加的模型）
PATCH_TARGET = "node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js"
PATCH_MARKER = "/* WU ai: 内置 DeepSeek 官方提供方已移除 */"
PATCH_HEAD = "function apply(ctx, config) {"

# npm 版本号字符白名单：防御路径注入（版本会被拼进目录名）
_SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]*$")

_ENTRY_CANDS = (
    "node_modules/@deepseek-ai/dsh/lib/bin.js",
    "node_modules/@deepseek-ai/dsh/bin/dsh.js",
    "node_modules/@deepseek-ai/dsh/lib/index.js",
    "node_modules/.bin/dsh",
)

# 兼容测试结果缓存：避免每次刷新都跑 --dump-config（约 10-30s）
_CACHE_LOCK = threading.Lock()
_CACHE: dict = {}


@dataclass
class RuntimeInfo:
    """一个已安装 DSH 运行时的描述（PSV: plain, 可 JSON 序列化）。"""

    key: str                 # "legacy" | "dsh-<version>"
    dir: str                 # 绝对路径
    kind: str                # "legacy" | "versioned"
    version: str | None
    entry: str | None
    active: bool = False

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "dir": self.dir,
            "kind": self.kind,
            "version": self.version or "未知",
            "entry": self.entry,
            "active": self.active,
        }


@dataclass
class CompatCheck:
    name: str
    status: str              # ok | warn | fail
    detail: str = ""


@dataclass
class CompatReport:
    passed: bool
    checks: list   # list[CompatCheck]（JSON 输出时手动序列化）

    def as_dict(self) -> dict:
        return {
            "passed": self.passed,
            "checks": [{"name": c.name, "status": c.status, "detail": c.detail} for c in self.checks],
        }


# ---------------------------------------------------------------- 发现与入口

def entry_of(d: Path) -> str | None:
    """在运行时目录里找 DSH 入口脚本；找不到返回 None。"""
    for rel in _ENTRY_CANDS:
        cand = d / rel
        if cand.is_file():
            return str(cand)
    return None


def version_of(d: Path) -> str | None:
    """读 @deepseek-ai/dsh 的版本号；失败返回 None。"""
    pkg = d / "node_modules" / "@deepseek-ai" / "dsh" / "package.json"
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    version = data.get("version")
    return str(version) if isinstance(version, str) and version else None


def discover() -> list:
    """扫描已安装的 DSH 运行时：versioned 目录 + 传统单安装（legacy）。"""
    out: list[RuntimeInfo] = []
    if VERSIONED_ROOT.is_dir():
        for d in sorted(VERSIONED_ROOT.glob("dsh-*")):
            if not d.is_dir() or entry_of(d) is None:
                continue
            out.append(RuntimeInfo(key=d.name, dir=str(d), kind="versioned",
                                   version=version_of(d), entry=entry_of(d)))
    if entry_of(LEGACY_DIR) is not None:
        out.append(RuntimeInfo(key="legacy", dir=str(LEGACY_DIR), kind="legacy",
                               version=version_of(LEGACY_DIR), entry=entry_of(LEGACY_DIR)))
    active = active_key()
    for info in out:
        info.active = info.key == active
    return out


def find(key: str) -> RuntimeInfo | None:
    return next((info for info in discover() if info.key == key), None)


# ---------------------------------------------------------------- 激活指针

def _ensure_current_file() -> dict:
    CURRENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    if CURRENT_FILE.is_file():
        try:
            data = json.loads(CURRENT_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("active"), str):
                return data
        except (OSError, json.JSONDecodeError):
            pass
    return {"schemaVersion": 1, "active": "legacy", "previous": None, "updatedAt": ""}


def load_current() -> dict:
    return _ensure_current_file()


def _write_current(data: dict) -> None:
    """原子写：先落临时文件再替换，避免写一半损坏指针。"""
    CURRENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = CURRENT_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CURRENT_FILE)


def active_key() -> str:
    data = load_current()
    key = data.get("active") or "legacy"
    # 指针若指向已卸载的版本，回落到 legacy（存在入口时）
    if key != "legacy" and entry_of(VERSIONED_ROOT / key) is None:
        if entry_of(LEGACY_DIR) is not None:
            return "legacy"
    return key


def previous_key() -> str | None:
    data = load_current()
    key = data.get("previous")
    return str(key) if isinstance(key, str) and key else None


def mark_active(key: str) -> None:
    """把 key 设为激活版本；原激活版本记为 previous（供回滚）。"""
    data = load_current()
    old = data.get("active")
    if old == key:
        return
    data["previous"] = old if old and old != key else None
    data["active"] = key
    data["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    _write_current(data)


def active_dir() -> Path:
    """当前激活运行时目录：指针有效时用指针，否则回落到 legacy。"""
    key = active_key()
    if key != "legacy":
        d = VERSIONED_ROOT / key
        if entry_of(d) is not None:
            return d
    return LEGACY_DIR


# ---------------------------------------------------------------- 运行时补丁

def patch_status(d: Path) -> str:
    """运行时补丁状态：applied | pending | moved | unsupported | n/a | error。

    moved：该版本已把 `dsh-llm-deepseek` 降级为共享库（它只导出
    registerDeepSeekProvider，不再是被装载的插件），官方提供商改由
    `dsh-llm-deepseek-api-key` / `-account` 独立插件注册 —— 文件补丁在此无从下手，
    改由控制中心生成 profile patch 里的 `disabled: true` 声明停用。
    """
    cand = d / PATCH_TARGET
    if not cand.is_file():
        return "n/a"
    try:
        text = cand.read_text(encoding="utf-8")
    except OSError:
        return "error"
    if PATCH_MARKER in text:
        return "applied"
    if PATCH_HEAD not in text:
        return "moved" if "registerDeepSeekProvider" in text else "unsupported"
    return "pending"


def apply_runtime_patch(d: Path) -> str:
    """幂等应用运行时补丁（停用内置 DeepSeek 官方提供方）。返回状态。"""
    status = patch_status(d)
    if status in ("applied", "n/a", "moved", "unsupported", "error"):
        return status
    cand = d / PATCH_TARGET
    try:
        text = cand.read_text(encoding="utf-8")
    except OSError:
        return "error"
    text = text.replace(PATCH_HEAD, PATCH_HEAD + "\n\t" + PATCH_MARKER + " return;", 1)
    try:
        cand.write_text(text, encoding="utf-8")
    except OSError:
        return "error"
    return "applied"


# ---------------------------------------------------------------- 品牌补丁
#
# DSH 的产品品牌（鲸鱼标、标语、产品名、思考中的文案）硬编码在它的前端产物里，
# 前端皮肤层改不到。这里做**表驱动的字符串替换**：只改文案与静态资产，
# 绝不碰任何功能逻辑；每条替换天然幂等（旧串替换掉后就不再命中）。
#
# 刻意不改的（避免误伤真实信息）：
#  - 用户自己配置的模型名（他确实在用 DeepSeek 的 API，那是数据不是品牌）
#  - 插件清单/设置页里的技术名（dsh-web-search-deepseek 等，属事实描述）
#  - 消息正文与代码块（用户/模型的真实内容）

BRAND_TEXT_PATCHES = [
    # 外壳静态页：<title> 是首屏标题兜底，不改会先闪一下 DSH 的名字
    ("node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
     "<title>DeepSeek Harness</title>", "<title>WU ai</title>"),
    ("node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html",
     '<html lang="en">', '<html lang="zh-CN">'),
    ("node_modules/@deepseek-ai/dsh-web-frontend/dist/manifest.webmanifest",
     '"name": "DeepSeek Harness"', '"name": "WU ai"'),
    ("node_modules/@deepseek-ai/dsh-web-frontend/dist/manifest.webmanifest",
     '"short_name": "DSH"', '"short_name": "WU ai"'),
    # 标签页标题模板（productTitle）
    ("node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js",
     '"DeepSeek Harness"', '"WU ai"'),
    # 新会话页抬头标语：品牌已收进「WU 章」，抬头不再挂文字（留空，避免出现裸露的 WU 字标）
    ("node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
     '"探索未至之境"', '""'),
    ("node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
     '"Into the Unknown"', '""'),
    # 生成中的状态文案
    ("node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js",
     '"深度求索中..."', '"思考中..."'),
    # 本地构建标记
    ("node_modules/@deepseek-ai/dsh-client-locale/lib/client.js",
     '"DSH 本地构建"', '"WU ai 本地构建"'),
    ("node_modules/@deepseek-ai/dsh-client-locale/lib/client.js",
     '"DSH Local Build"', '"WU ai Local Build"'),
    # 未配置模型时的引导语
    ("node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js",
     '"配置 DeepSeek 官方模型，即可开始使用。"', '"配置模型后即可开始使用。"'),
    ("node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js",
     '"Configure the official DeepSeek provider to start building."',
     '"Configure a model to get started."'),
]

# 站点图标：整文件替换成 WU 的「WU 章」（用标记判断是否已替换）
BRAND_FAVICON = "node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg"
BRAND_FAVICON_MARKER = "WU-ai-favicon"
BRAND_FAVICON_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
    "<!-- WU-ai-favicon -->"
    '<defs><linearGradient id="wu" x1="0" y1="0" x2="1" y2="1">'
    '<stop offset="0" stop-color="#16241F"/><stop offset="1" stop-color="#0A0F12"/></linearGradient>'
    '<linearGradient id="wuline" x1="0" y1="0" x2="1" y2="0">'
    '<stop offset="0" stop-color="#2EE59D" stop-opacity=".85"/>'
    '<stop offset="1" stop-color="#2EE59D" stop-opacity=".06"/></linearGradient></defs>'
    '<rect width="64" height="64" rx="14" fill="#0D0F12"/>'
    '<rect x="4" y="4" width="56" height="56" rx="12" fill="url(#wu)" stroke="#2EE59D" stroke-width="2.5"/>'
    '<rect x="9.25" y="9.25" width="45.5" height="45.5" rx="8" fill="none" stroke="#2EE59D"'
    ' stroke-opacity=".14" stroke-width="1.5"/>'
    '<text x="32" y="40" text-anchor="middle" font-size="25" font-weight="700" fill="#2EE59D"'
    ' letter-spacing="1" font-family="ui-monospace, Menlo, Consolas, monospace">WU</text>'
    '<rect x="20" y="47" width="24" height="2.5" rx="1.25" fill="url(#wuline)"/>'
    "</svg>"
)


def apply_brand_patch(d: Path) -> dict:
    """把 DSH 的产品品牌换成 WU ai（幂等）。返回 {changed, already, missing}。"""
    changed, already, missing = [], [], []
    for rel, old, new in BRAND_TEXT_PATCHES:
        f = d / rel
        if not f.is_file():
            missing.append(rel)
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except OSError:
            missing.append(rel)
            continue
        if old not in text:
            (already if new in text else missing).append(rel)
            continue
        try:
            f.write_text(text.replace(old, new), encoding="utf-8")
            changed.append(rel)
        except OSError:
            missing.append(rel)
    # 站点图标
    fav = d / BRAND_FAVICON
    if fav.is_file():
        try:
            cur = fav.read_text(encoding="utf-8")
            if BRAND_FAVICON_MARKER in cur:
                already.append(BRAND_FAVICON)
            else:
                fav.write_text(BRAND_FAVICON_SVG, encoding="utf-8")
                changed.append(BRAND_FAVICON)
        except OSError:
            missing.append(BRAND_FAVICON)
    else:
        missing.append(BRAND_FAVICON)
    return {"changed": changed, "already": already, "missing": missing}


# ---------------------------------------------------------------- 兼容测试（A 层）

def _run_capture(cmd: list, env: dict, timeout: float) -> tuple:
    try:
        proc = subprocess.run(cmd, cwd=str(DEFAULT_WORKSPACE), env=env,
                              capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", "超时"
    except OSError as e:
        return 125, "", str(e)


def _dump_flag_supported(node: str, info: RuntimeInfo) -> bool | None:
    """探测该版本 CLI 是否支持 --dump-config（顶层 flag，各版本位置可能不同）。"""
    cache_key = ("dump-flag", info.dir)
    if cache_key in _CACHE:
        return _CACHE[cache_key]
    code, out, _ = _run_capture([node, info.entry, "--help"], _dsh_env(), 60)
    supported = code == 0 and "--dump-config" in out
    with _CACHE_LOCK:
        if len(_CACHE) > 64:
            _CACHE.clear()
        _CACHE[cache_key] = supported
    return supported


def _dsh_env() -> dict:
    import os
    env = os.environ.copy()
    env["DSH_HOME"] = str(DSH_HOME)
    env.setdefault("DSH_TELEMETRY_DISABLED", "1")
    return env


def compat_check(node: str, info: RuntimeInfo, refresh: bool = True) -> CompatReport:
    """A 层兼容测试（离线）。

    refresh=True 强制重跑；默认复用近期缓存（key: 目录 + 版本 + 入口 mtime）。
    测试项：入口存在 / 版本可读 / 配置树可组装（--dump-config）/ 补丁可应用。
    补丁仅当「applied」或「n/a」算 ok；「unsupported」降级为 warn（该版本 API
    变了，适配器需人工跟进），不阻断切换；--dump-config 不可用时也降级为 warn。
    """
    if not isinstance(node, str) or not node:
        return CompatReport(passed=False, checks=[CompatCheck("Node", "fail", "无可用的 Node 运行时")])
    cache_key = ("compat", info.dir, info.version, info.entry)
    if not refresh and cache_key in _CACHE:
        return _CACHE[cache_key]

    checks: list[CompatCheck] = []
    status = apply_runtime_patch(Path(info.dir))
    if status == "applied":
        checks.append(CompatCheck("运行时补丁", "ok", "已应用（停用内置 DeepSeek 官方提供方）"))
    elif status == "n/a":
        checks.append(CompatCheck("运行时补丁", "ok", "目标文件不存在（该版本未内置官方提供方）"))
    elif status == "moved":
        checks.append(CompatCheck(
            "运行时补丁", "ok",
            "该版本官方提供商已拆分为独立插件，改由 profile patch 声明停用"))
    elif status == "error":
        checks.append(CompatCheck("运行时补丁", "fail", "补丁读写失败"))
    else:
        checks.append(CompatCheck("运行时补丁", "warn", "apply() 签名变化，补丁未适用；内置官方模型可能重新出现"))

    if info.entry:
        checks.append(CompatCheck("入口", "ok", info.entry))
    else:
        checks.append(CompatCheck("入口", "fail", "未找到 DSH 入口脚本"))

    if info.version:
        checks.append(CompatCheck("版本", "ok", info.version))
    else:
        checks.append(CompatCheck("版本", "fail", "package.json 不可读"))

    supported = _dump_flag_supported(node, info)
    if supported is True:
        code, out, err = _run_capture(
            [node, info.entry, "--dump-config", "--profile", "web"], _dsh_env(), 180
        )
        if code == 0:
            checks.append(CompatCheck("配置树可组装", "ok", "--dump-config 通过（插件/bundle/patch 与本版本兼容）"))
        else:
            tail = (err or out).strip()[-400:]
            if "EPERM" in tail and str(DSH_HOME) in tail:
                # 控制中心被沙箱/权限边界限制时，DSH 写不了 DSH_HOME —— 这是环境问题，不是版本不兼容
                checks.append(CompatCheck(
                    "配置树可组装", "fail",
                    f"环境受限：DSH 无法写入 {DSH_HOME}（EPERM）。"
                    "请退出当前控制中心，改用 Finder 双击 start.command 启动后重试。"))
            else:
                checks.append(CompatCheck("配置树可组装", "fail", f"--dump-config 失败（code={code}）：{tail}"))
    elif supported is False:
        checks.append(CompatCheck("配置树可组装", "warn", "该版本无 --dump-config 探测，跳过结构验证"))
    else:
        checks.append(CompatCheck("配置树可组装", "fail", "无法运行 CLI 探测（Node 异常）"))

    passed = all(c.status != "fail" for c in checks)
    report = CompatReport(passed=passed, checks=checks)
    with _CACHE_LOCK:
        if len(_CACHE) > 64:
            _CACHE.clear()
        _CACHE[cache_key] = report
    return report


# ---------------------------------------------------------------- npm 检查更新 / 并排安装

def npm_bin(node: str) -> str:
    """与当前 Node 同目录的 npm（Windows 为 npm.cmd）。"""
    parent = Path(node).parent
    cand = parent / ("npm.cmd" if platform.system() == "Windows" else "npm")
    if cand.exists():
        return str(cand)
    return str(parent / "npm")


def npm_latest(node: str, timeout: float = 60) -> str | None:
    """npm registry 上的最新版（network 操作，调用方负责超时兜底）。"""
    npm = npm_bin(node)
    env = _dsh_env()
    env["PATH"] = f"{Path(node).parent}:{env.get('PATH', '')}"  # npm shim 依赖 node 在 PATH
    code, out, err = _run_capture(
        [npm, "view", "@deepseek-ai/dsh", "version"], env, timeout
    )
    if code != 0:
        return None
    version = (out or "").strip().splitlines()[0].strip() if out.strip() else ""
    return version if _SAFE_VERSION.match(version) else None


def install_runtime(version: str, node: str, progress=None, timeout: float = 600) -> dict:
    """把 @deepseek-ai/dsh@version 装进独立目录 runtime/dsh/dsh-<version>。

    与旧版完全并存，绝不覆盖 legacy 安装；返回 {ok, info} 供上层展示。
    """
    log = progress or (lambda s: None)
    if not _SAFE_VERSION.match(version or ""):
        return {"ok": False, "message": f"非法版本号：{version!r}"}
    target = VERSIONED_ROOT / f"dsh-{version}"
    if entry_of(target) is not None:
        info = runtime_info_of(target, f"dsh-{version}", "versioned")
        return {"ok": True, "message": "该版本已安装", "info": info}
    target.mkdir(parents=True, exist_ok=True)
    (target / "package.json").write_text(
        json.dumps({"name": f"wu-ai-dsh-{version}", "private": True}, indent=2),
        encoding="utf-8",
    )
    npm = npm_bin(node)
    env = _dsh_env()
    env["PATH"] = f"{Path(node).parent}:{env.get('PATH', '')}"
    log(f"安装 DSH {version} → {target} …")
    try:
        proc = subprocess.run(
            [npm, "install", "--prefix", str(target), "--no-fund", "--no-audit",
             f"@deepseek-ai/dsh@{version}"],
            cwd=str(target), env=env, capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "message": "npm install 超时"}
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip()[-500:]
        return {"ok": False, "message": f"npm install 失败：{tail}"}
    entry = entry_of(target)
    if entry is None:
        return {"ok": False, "message": f"安装完成但未找到入口（{target}）"}
    info = runtime_info_of(target, f"dsh-{version}", "versioned")
    log(f"DSH {version} 安装完成: {entry}")
    return {"ok": True, "message": f"已安装 {version}", "info": info}


def prune_runtimes(keep: list, progress=None) -> dict:
    """清理旧运行时：只保留 keep 里的 key（通常是「最新版 + 上一版」）。

    升级成功后才调用。安全约束（宁可少删不可误删）：
    - 只删 runtime/dsh/dsh-* 与 legacy 单安装（runtime/dsh-app）这两个受管位置的目录；
    - keep 里的 key 一律不删；
    - 只有在目标确实是已识别的运行时目录（有 DSH 入口）时才删。
    """
    log = progress or (lambda s: None)
    keep_set = {k for k in (keep or []) if k}
    removed: list = []
    skipped: list = []
    for info in discover():
        if info.key in keep_set:
            continue
        d = Path(info.dir).resolve()
        managed = d == LEGACY_DIR.resolve() or (
            d.parent == VERSIONED_ROOT.resolve() and d.name.startswith("dsh-")
        )
        if not managed or entry_of(d) is None:
            skipped.append(info.key)
            continue
        try:
            shutil.rmtree(d)
            removed.append(info.key)
            log(f"已清理旧运行时 {info.key}（{d}）")
        except OSError as e:
            skipped.append(info.key)
            log(f"清理 {info.key} 失败：{e}")
    return {"removed": removed, "kept": sorted(keep_set), "skipped": skipped}


def prune_stale(progress=None) -> dict:
    """例行收敛：删掉比「当前激活版」更旧的安装，只留「当前版 + 上一版」。

    升级成功后的清理（prune_runtimes）只在升级流程里跑，一旦升级长期失败或用户
    从不升级，旧版本就会一直堆积（实测可堆到 4 份、1.4G）。这里提供一个可在任意
    时机安全重复调用的收敛入口（控制中心启动时后台跑一次）。

    安全前提（宁可少删不可误删）：
    - 指针还停在 legacy（尚未启用并排版本）时直接跳过；
    - 目录修改时间晚于当前激活版的安装视为「刚装好、还没切换」，一律保留，
      避免把用户刚下载的新版本删掉。
    """
    log = progress or (lambda s: None)
    active = active_key()
    if active == "legacy":
        log("跳过旧版本清理：当前仍在使用 legacy 单安装")
        return {"removed": [], "kept": ["legacy"], "skipped": []}
    keep = {active}
    prev = previous_key()
    if prev:
        keep.add(prev)
    try:
        active_mtime = (VERSIONED_ROOT / active).stat().st_mtime
        for info in discover():
            if info.kind == "versioned" and Path(info.dir).stat().st_mtime > active_mtime:
                keep.add(info.key)
    except OSError:
        pass
    return prune_runtimes(sorted(keep), progress)


def runtime_info_of(d: Path, key: str, kind: str) -> dict:
    return RuntimeInfo(
        key=key, dir=str(d), kind=kind,
        version=version_of(d), entry=entry_of(d),
        active=active_key() == key,
    ).as_dict()


# ---------------------------------------------------------------- self-test CLI

def _self_test() -> int:
    print("== WU ai runtime_manager self-test ==")
    infos = discover()
    print(f"已安装运行时: {len(infos)}")
    for info in infos:
        print(f"  {info.key:20s} version={(info.version or '?'):14s} active={info.active} entry={'yes' if info.entry else 'no'}")
    print(f"active_key = {active_key()}")
    print(f"active_dir = {active_dir()}")
    for info in infos:
        print(f"patch({info.key}) = {patch_status(Path(info.dir))}")
    # 指针读写往返（不改动真实指针：写完立刻恢复）
    saved = load_current()
    _write_current(saved)
    print(f"current 指针文件: {CURRENT_FILE}（读写往返 OK）")
    return 0


if __name__ == "__main__":
    raise SystemExit(_self_test())