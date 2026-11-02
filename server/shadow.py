"""影子快照（Shadow Git）——在沙箱工作区里维护一个隐藏 Git，供「撤销本次任务改动」。

设计约束：
- 不碰用户自己的 .git：所有命令都显式指定 `--git-dir=<ws>/.wu-shadow-git --work-tree=<ws>`；
- 影子目录自身写进 info/exclude，避免把仓库塞进自己的快照；
- 只在工作区（DEFAULT_WORKSPACE）内操作，路径必须落在其下；
- 回滚只影响「本次快照之后」的改动：被改的文件 checkout 回快照版本，新建的文件删除。
"""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path

from core.paths import DEFAULT_WORKSPACE
from server import guard

GIT_DIR_NAME = ".wu-shadow-git"


def _ws(workspace: str | Path | None = None) -> Path:
    ws = Path(workspace).expanduser().resolve() if workspace else DEFAULT_WORKSPACE.expanduser().resolve()
    root = DEFAULT_WORKSPACE.resolve()
    if ws != root and root not in ws.parents:
        raise ValueError("影子快照只允许在沙箱工作区内使用")
    return ws


def _git(workspace: str | Path | None, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    ws = _ws(workspace)
    cmd = ["git", f"--git-dir={ws / GIT_DIR_NAME}", f"--work-tree={ws}", *args]
    return subprocess.run(cmd, cwd=str(ws), capture_output=True, text=True, check=check, timeout=60)


def ensure_repo(workspace: str | Path | None = None) -> bool:
    """初始化隐藏仓库（幂等）。git 不可用时返回 False，调用方按「无快照」降级。"""
    ws = _ws(workspace)
    gd = ws / GIT_DIR_NAME
    if not gd.exists():
        try:
            _git(ws, "init", "-q")
        except (OSError, subprocess.SubprocessError):
            return False
        exclude = gd / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        exclude.write_text(f"{GIT_DIR_NAME}/\n.DS_Store\n", encoding="utf-8")
    return True


def snapshot(label: str = "", workspace: str | Path | None = None) -> dict | None:
    """把工作区当前状态提交成一个快照，返回 {commit, label, at}；不可用时 None。"""
    if not ensure_repo(workspace):
        return None
    ws = _ws(workspace)
    try:
        _git(ws, "add", "-A")
        msg = f"snapshot-before-task: {label[:80]}" if label else "snapshot"
        _git(ws, "-c", "user.name=WU ai", "-c", "user.email=wu-ai@localhost", "commit", "-q", "--allow-empty", "-m", msg)
        commit = _git(ws, "rev-parse", "HEAD").stdout.strip()
        at = _git(ws, "log", "-1", "--format=%cI").stdout.strip()
        return {"commit": commit, "label": msg, "at": at}
    except (OSError, subprocess.SubprocessError):
        return None


def _rel(ws: Path, path: str) -> str:
    """相对路径 → 工作区内的 posix 相对路径（软链接/越界由 guard 统一拦截）。"""
    target = guard.resolve_in(ws, path)
    return target.relative_to(ws).as_posix()


def _snapshot_commit(workspace: str | Path | None) -> str | None:
    try:
        out = _git(_ws(workspace), "rev-parse", "HEAD", check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 and out.stdout.strip() else None


def status(workspace: str | Path | None = None) -> dict:
    """对比最近一次快照：列出改动文件与行数统计；没有快照时 snapshot=null。"""
    ws = _ws(workspace)
    commit = _snapshot_commit(ws)
    if not commit:
        return {"snapshot": None, "files": [], "insertions": 0, "deletions": 0}
    # 只看工作区相对快照的差异（含新建的未跟踪文件：先 add -N 让它出现在 diff 里）
    _git(ws, "add", "-N", ".", check=False)
    files, ins, dele = _numstat(ws, commit, None)
    return {"snapshot": commit, "files": files, "insertions": ins, "deletions": dele}


def diff(
    path: str,
    workspace: str | Path | None = None,
    limit: int = 20000,
    commit: str | None = None,
    to: str | None = None,
) -> dict:
    """某个文件的文本差异。

    - commit 为空：对比最近一次快照（HEAD）与当前工作区，即「本轮改了什么」；
    - commit 给定、to 为空：该快照与当前工作区；
    - commit + to 都给：两个快照之间，即「那一次任务改了什么」（左栏历史回看）。
    """
    ws = _ws(workspace)
    head = _snapshot_commit(ws)
    if not head:
        return {"ok": False, "message": "还没有快照"}
    ref = head
    if commit:
        # 只接受十六进制 commit 号：历史任务来自 /api/tasks，不接受任意 ref
        cleaned = str(commit).strip()
        if not re.fullmatch(r"[0-9a-fA-F]{7,40}", cleaned):
            return {"ok": False, "message": "无效的快照编号"}
        verify = _git(ws, "rev-parse", "--verify", f"{cleaned}^{{commit}}", check=False)
        if verify.returncode != 0:
            return {"ok": False, "message": "找不到该快照"}
        ref = verify.stdout.strip()
    end_ref = None
    if to:
        cleaned_to = str(to).strip()
        if not re.fullmatch(r"[0-9a-fA-F]{7,40}", cleaned_to):
            return {"ok": False, "message": "无效的快照编号"}
        verify_to = _git(ws, "rev-parse", "--verify", f"{cleaned_to}^{{commit}}", check=False)
        if verify_to.returncode != 0:
            return {"ok": False, "message": "找不到该快照"}
        end_ref = verify_to.stdout.strip()
    try:
        rel = _rel(ws, path)
    except guard.SandboxEscape as e:
        return {"ok": False, "message": str(e)}
    args = ["diff", "--no-color", ref]
    if end_ref:
        args.append(end_ref)
    out = _git(ws, *args, "--", rel, check=False).stdout
    return {
        "ok": True,
        "path": rel,
        "commit": ref,
        "to": end_ref,
        "diff": out[:limit],
        "truncated": len(out) > limit,
    }


def _numstat(ws: Path, base: str, target: str | None) -> tuple[list[dict], int, int]:
    """numstat → (文件列表, 新增行, 删除行)。target 为空表示对比当前工作区。"""
    args = ["diff", "--numstat", base]
    if target:
        args.append(target)
    out = _git(ws, *args, check=False).stdout
    files: list[dict] = []
    ins = dele = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        a, d, rel = parts
        add = int(a) if a.isdigit() else 0
        rem = int(d) if d.isdigit() else 0
        ins += add
        dele += rem
        files.append({"path": rel, "insertions": add, "deletions": rem})
    return files, ins, dele


def history(limit: int = 15, workspace: str | Path | None = None) -> list[dict]:
    """近期任务快照（新 → 旧）。每个快照代表「一次派发前的现场」。

    单个任务的改动 = 该快照与**下一个更新快照**（最新一档与工作区）之间的差异，
    因此这里直接把 files/insertions/deletions 一起算好，前端不用二次请求。
    """
    ws = _ws(workspace)
    if not (ws / GIT_DIR_NAME).exists():
        return []
    try:
        n = max(1, min(50, int(limit)))
        out = _git(ws, "log", f"-n{n}", "--format=%H%x1f%cI%x1f%s", check=False)
    except (OSError, subprocess.SubprocessError):
        return []
    if out.returncode != 0 or not out.stdout.strip():
        return []
    # 未跟踪的新文件也要出现在最新一档的差异里
    _git(ws, "add", "-N", ".", check=False)

    rows: list[dict] = []
    for line in out.stdout.strip().splitlines():
        parts = line.split("\x1f")
        if len(parts) != 3:
            continue
        commit, at, message = parts
        # 用户点「保留」产生的提交不是一次任务，不该出现在任务历史里
        if message.startswith("accept "):
            continue
        label = message
        if label.startswith("snapshot-before-task: "):
            label = label[len("snapshot-before-task: ") :]
        elif label == "snapshot":
            label = "未命名任务"
        rows.append({"commit": commit, "at": at, "label": label})

    for i, row in enumerate(rows):
        # 该任务的改动 = 本快照 → 下一个更新快照（最新一档比到工作区）。until 一并下发，
        # 前端回看历史时直接用 commit..until 取 diff，不会把后续任务的改动混进来。
        target = rows[i - 1]["commit"] if i > 0 else None
        files, ins, dele = _numstat(ws, row["commit"], target)
        row["until"] = target
        row["files"] = files[:10]
        row["fileCount"] = len(files)
        row["insertions"] = ins
        row["deletions"] = dele
    return rows


def accept(files: list[str], workspace: str | Path | None = None) -> dict:
    """确认保留：把指定文件就地提交进快照链，之后 status 不再把它们列为待处理。"""
    ws = _ws(workspace)
    if not _snapshot_commit(ws):
        return {"ok": False, "message": "还没有快照，无法确认保留"}
    wanted = [str(f) for f in files if f]
    if not wanted:
        return {"ok": False, "message": "没有指定文件"}
    _git(ws, "add", "--", *wanted, check=False)
    out = _git(
        ws,
        "-c", "user.name=WU ai",
        "-c", "user.email=wu-ai@localhost",
        "commit", "-q", "-m", f"accept {len(wanted)} file(s)",
        "--", *wanted,
        check=False,
    )
    return {"ok": out.returncode == 0, "accepted": wanted}


def _backup_pending(ws: Path, commit: str) -> str | None:
    """回滚前的安全网（脏工作区保护，2026-11-02）：把「快照之后的所有现场改动」
    打成一个备份 commit（refs/wu-backup/…，不占用主快照链）。用户在 VS Code 里
    手写的代码若被误回滚，仍可从备份找回。返回备份 ref；没有可备份内容返回 None。"""
    _git(ws, "add", "-A", ".", check=False)
    tree = _git(ws, "write-tree", check=False).stdout.strip()
    if not tree:
        return None
    same = _git(ws, "diff", "--quiet", commit, tree, check=False).returncode == 0
    if same:
        return None  # 现场与快照一致，没有需要保护的东西
    ts = time.strftime("%Y%m%d-%H%M%S")
    ref = f"refs/wu-backup/{ts}"
    c = _git(
        ws, "commit-tree", tree, "-p", commit,
        "-m", f"wu-ai rollback safety backup {ts}",
        check=False,
    )
    if c.returncode != 0:
        return None
    _git(ws, "update-ref", ref, c.stdout.strip(), check=False)
    return ref


def rollback(workspace: str | Path | None = None, files: list[str] | None = None) -> dict:
    """把「快照之后的改动」撤销：修改过的还原、新建的删除。files 为空表示全部。

    脏工作区保护：撤销前先把现场全部改动备份到 refs/wu-backup/<时间戳>——
    用户在宿主机上手改的文件即使被一并还原，也能从备份 ref 找回（响应里带 backup）。
    """
    ws = _ws(workspace)
    commit = _snapshot_commit(ws)
    if not commit:
        return {"ok": False, "message": "还没有快照，无法撤销"}
    backup_ref = _backup_pending(ws, commit)
    st = status(ws)
    targets = [f["path"] for f in st["files"]]
    if files:
        wanted = {str(f) for f in files}
        targets = [t for t in targets if t in wanted]
    if not targets:
        return {"ok": True, "restored": [], "removed": []}

    # 快照里存在的 → checkout 回快照；快照里不存在的（本次新建）→ 删除
    restored, removed = [], []
    for rel in targets:
        exists_in_snapshot = _git(ws, "cat-file", "-e", f"{commit}:{rel}", check=False).returncode == 0
        dest = ws / rel
        if exists_in_snapshot:
            _git(ws, "checkout", commit, "--", rel, check=False)
            restored.append(rel)
        elif dest.exists():
            dest.unlink()
            removed.append(rel)
    _git(ws, "add", "-N", ".", check=False)
    out = {"ok": True, "restored": restored, "removed": removed}
    if backup_ref:
        out["backup"] = backup_ref
        out["message"] = "回滚前的现场改动已备份（可从该备份找回）"
    return out

