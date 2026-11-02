"""沙箱路径守卫（Sandbox Guard）——所有「按用户给的相对路径访问工作区」的唯一入口。

威胁模型（与 README §5 的沙箱章节对应）：
1. `../` 穿越：相对路径解析后跑出工作区；
2. 软链接穿透：工作区里被放了 `ln -s /etc etc`，前缀仍是工作区，物理位置却在外面；
3. 展示泄露：界面与截图里出现 `/Users/<用户名>/...`。

判定方法：先拼成绝对路径，再用 `Path.resolve()` 解析**所有已存在部分**的软链接
（不存在的尾段无法藏链接，因此安全），最后核对物理路径仍落在工作区的物理路径之内。
前缀比较用 `Path.parents` 而非字符串 startswith——`/a/bc` 不会被误判成 `/a/b` 的子路径。

本模块只读：不创建目录、不写文件；工作区不存在时按「空工作区」返回。
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from core import paths

# 工作区里永远不展示的目录：影子 Git 仓库自身、用户自己的 Git、依赖目录
SKIP_NAMES = {".wu-shadow-git", ".git", "node_modules", ".DS_Store", ".venv", "__pycache__"}

# 文件树单次返回的条目上限（前端左栏只做「导航」，不做文件管理器）
TREE_LIMIT = 300


class SandboxEscape(ValueError):
    """相对路径解析后落在工作区之外（越权访问被拦截）。"""


def workspace_root() -> Path:
    """沙箱工作区根目录（单一真源仍是 core.paths.DEFAULT_WORKSPACE）。"""
    return Path(paths.DEFAULT_WORKSPACE).expanduser()


def resolve_in(root: str | Path, rel: str = "") -> Path:
    """把相对路径解析成 root 内的物理路径；越界抛 SandboxEscape。

    root 自身也做 realpath：macOS 上 `/tmp` → `/private/tmp` 这类差异不会误判。
    """
    root_real = Path(root).expanduser().resolve()
    raw = str(rel or "").strip()
    if "\x00" in raw:
        raise SandboxEscape("路径包含非法字符")
    # 绝对路径不接受：调用方只该给「工作区内的相对路径」，否则全是越权
    if os.path.isabs(raw):
        raise SandboxEscape(f"越权访问已被拦截：{raw}（只接受工作区内的相对路径）")
    candidate = (root_real / raw).resolve()
    if candidate != root_real and root_real not in candidate.parents:
        raise SandboxEscape(f"越权访问已被拦截：{raw}")
    return candidate


def resolve(rel: str = "") -> Path:
    """相对沙箱工作区解析（越界抛 SandboxEscape）。"""
    return resolve_in(workspace_root(), rel)


def display(full_path: str | Path) -> str:
    """展示路径脱敏：家目录统一收敛为 `~`（截图不外泄用户名）。"""
    text = str(full_path or "")
    home = str(Path.home())
    if text == home:
        return "~"
    if text.startswith(home + os.sep):
        return "~" + text[len(home) :]
    return text


def _entry_type(path: Path) -> str:
    if path.is_symlink():
        return "link"
    return "dir" if path.is_dir() else "file"


def tree(rel: str = "", depth: int = 2, root: str | Path | None = None, limit: int = TREE_LIMIT) -> dict:
    """工作区文件树（只读、有上限）。

    返回 `{path, entries: [{name, path, type, size, depth, mtime}]}`；
    `path` 一律是相对工作区的 posix 路径，前端不再拼接绝对路径。
    """
    base_root = Path(root).expanduser().resolve() if root else workspace_root().resolve()
    base = resolve_in(base_root, rel)
    if base.exists() and not base.is_dir():
        raise SandboxEscape("只能列目录")
    try:
        max_depth = max(1, min(4, int(depth)))
    except (TypeError, ValueError):
        max_depth = 2

    entries: list[dict] = []

    def walk(directory: Path, level: int) -> None:
        if level > max_depth or len(entries) >= limit:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except OSError:
            return
        for child in children:
            if len(entries) >= limit:
                return
            if child.name in SKIP_NAMES:
                continue
            try:
                st = child.lstat()
                kind = _entry_type(child)
                rel_path = child.relative_to(base_root).as_posix()
            except (OSError, ValueError):
                continue
            entries.append(
                {
                    "name": child.name,
                    "path": rel_path,
                    "type": kind,
                    "depth": level,
                    "size": 0 if kind == "dir" else st.st_size,
                    "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%m-%d %H:%M"),
                }
            )
            if kind == "dir":
                walk(child, level + 1)

    walk(base, 1)
    return {
        "path": base.relative_to(base_root).as_posix() if base != base_root else "",
        "entries": entries,
        "truncated": len(entries) >= limit,
    }
