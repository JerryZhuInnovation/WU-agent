"""控制中心的工作台数据面：工作台聚合 / 工作流模板 / 任务投递箱 / 沙箱自检。

从 server/app.py 拆出（2026-10-24 模块化重构）：这些是「工作台视图」的只读聚合
与轻量状态，与 HTTP 路由无关。改工作台数据来源只需动本模块；
HTTP 接线仍在 server/app.py。
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from datetime import datetime
from pathlib import Path

from core.log import log
from core.paths import DSH_HOME, WORKFLOWS_JSON
from dsh import manager

WORKFLOWS_FILE = WORKFLOWS_JSON

# 工作台「发射台」投递箱：控制中心下发任务 → 对话页客户端插件取走并填入输入区。
# 内存态、单次消费（GET 即清空）；控制中心或 Agent 任一重启都会自然丢弃，
# 避免旧任务在几天后突然被填进输入区。
_PENDING_LOCK = threading.Lock()
# autoSend：工作台「派发」默认就是执行；置 false 时只填入输入区，等用户确认。
# verifyMode：发射器前置选择（strict 完整流水线 / fast 快速直通），取件时落 turn-config。
_PENDING_TASK: dict = {"text": "", "at": 0.0, "autoSend": True, "verifyMode": "strict"}

# 幂等防抖（2026-11-02）：冷启动卡顿时用户容易连按回车/连点派发，前端重连也可能
# 重复提交——5 秒内「相同文本 + 相同核验档」的派发直接合并，不再入箱（左栏刷出
# 5 条一模一样任务的根治点）。指纹只存内存，重启即清。
_IDEMPOTENCY_WINDOW = 5.0
_LAST_SUBMISSION: dict = {"fp": "", "at": 0.0}


def _submission_fingerprint(text: str, verify_mode: str) -> str:
    return hashlib.sha256(f"{text.strip()}::{'fast' if verify_mode == 'fast' else 'strict'}".encode()).hexdigest()

# perf.jsonl 尾部读取窗口：只读尾部 TAIL 字节（文件可能很大，没必要全量载入）
_TAIL_BYTES = 512 * 1024


def _read_perf_events() -> list[dict]:
    """读 perf.jsonl 尾部并解析成事件列表；任何缺失都返回空列表。"""
    perf = DSH_HOME / "perf.jsonl"
    if not perf.exists():
        return []
    try:
        with perf.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            start = max(0, size - _TAIL_BYTES)
            f.seek(start)
            data = f.read()
    except OSError:
        return []
    lines = data.decode("utf-8", "replace").splitlines()
    # 只有从文件中段开始读时，首行才可能是半截 JSON（尾部窗口恰从行首开始时不能丢）
    if start > 0 and lines:
        lines = lines[1:]
    events: list[dict] = []
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        # 路由插件写的是 ts（perf.js logPerf），工作台聚合读 at —— 统一补齐，
        # 否则 tail() 的 at 过滤会把所有埋点判为「无时间」而返回空列表。
        if not row.get("at") and row.get("ts"):
            row["at"] = row["ts"]
        events.append(row)
    return events


def workspace_payload() -> dict:
    """工作台只读聚合（任务中心 / 协作流程 / 质量与验证 / 工作成果 / 运行记录）。

    数据源全部是本机文件：路由插件埋点 perf.jsonl（事件流）+ 产物仓库
    wu-ai-context/（任务产物全文）。任何一项缺失都返回空列表——由前端渲染
    「暂无数据」空状态，绝不伪造样本（工作台文档 §四.3：样本不足须明示）。
    """
    events = _read_perf_events()

    def tail(kind: str, n: int) -> list[dict]:
        rows = [e for e in events if e.get("kind") == kind and e.get("at")]
        return rows[-n:]

    # 用量按模型聚合（kind=llm：每次模型调用一行）
    usage: dict[str, dict] = {}
    for e in events:
        if e.get("kind") != "llm":
            continue
        key = e.get("model") or "未知"
        u = usage.setdefault(key, {"model": key, "calls": 0, "input": 0, "output": 0, "cacheRead": 0, "total": 0})
        u["calls"] += 1
        tu = e.get("usage") or {}
        u["input"] += int(tu.get("input") or 0)
        u["output"] += int(tu.get("output") or 0)
        u["cacheRead"] += int(tu.get("cacheRead") or 0)
        u["total"] += int(tu.get("total") or 0)

    # 产物仓库（context.js 落盘：task_<sid>_art<N>.json）
    artifacts: list[dict] = []
    ctx_dir = DSH_HOME / "wu-ai-context"
    if ctx_dir.exists():
        try:
            for p in sorted(ctx_dir.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:30]:
                artifacts.append(
                    {
                        "file": p.name,
                        "size": p.stat().st_size,
                        "updatedAt": datetime.fromtimestamp(p.stat().st_mtime).strftime("%m-%d %H:%M"),
                    }
                )
        except OSError:
            pass

    return {
        "ok": True,
        "executes": [
            {
                "at": e.get("at"),
                "capability": e.get("capability"),
                "model": e.get("model"),
                "success": e.get("success"),
                "verified": e.get("verified"),
                "latencyMs": e.get("latencyMs"),
            }
            for e in tail("execute", 15)
        ],
        "verifies": [
            {
                "at": e.get("at"),
                "score": e.get("score"),
                "pass": e.get("pass"),
                "round": e.get("round"),
                "gaps": e.get("gaps"),
            }
            for e in tail("verify", 15)
        ],
        "plans": [{"at": e.get("at"), "steps": len(e.get("steps") or [])} for e in tail("plan", 10)],
        "routes": [
            {"at": e.get("at"), "capability": e.get("capability"), "model": e.get("model"), "reason": e.get("reason")}
            for e in tail("route", 15)
        ],
        "allocation": allocation_payload(),
        "usage": sorted(usage.values(), key=lambda u: -u["calls"])[:10],
        "artifacts": artifacts,
        "eventCount": len(events),
        "risk": risk_audit_payload(),
        "budget": budget_payload(),
    }


# ---------------------------------------------------------------- 可审计任务分配（ADR）

# 路由插件的决策记录目录（与 perf.jsonl 同级）。缺失 = 分配内核从未跑过。
ADR_DIR = "wu-ai-adr"

STATE_UI = {
    "EXECUTABLE": ("可执行", "ok"),
    "TRIAL_FIRST": ("先试运行", "warn"),
    "HOLD_FOR_CONFIRMATION": ("待确认", "bad"),
}


def allocation_payload() -> dict:
    """抽屉 ALLOCATION 卡：最近的分配决策记录（ADR）+ 表现账本摘要。

    数据全部来自路由插件落盘的 ADR JSON 与账本，任何缺失都返回空 —— 不伪造。
    """
    adrs: list[dict] = []
    adr_root = DSH_HOME / ADR_DIR
    if adr_root.is_dir():
        try:
            files = sorted(
                (p for p in adr_root.glob("adr_*.json")),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )[:8]
        except OSError:
            files = []
        for p in files:
            try:
                r = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            state = str(r.get("decisionState") or "UNKNOWN")
            label, tone = STATE_UI.get(state, (state, "muted"))
            audit = r.get("postExecutionAudit")
            adrs.append(
                {
                    "adrId": r.get("adrId"),
                    "at": r.get("timestamp"),
                    "state": state,
                    "stateLabel": label,
                    "tone": tone,
                    "reason": str(r.get("decisionReason") or "")[:160],
                    "taskType": (r.get("taskRequirements") or {}).get("taskType"),
                    "riskLevel": (r.get("taskRequirements") or {}).get("riskLevel"),
                    "planningMode": (r.get("planning") or {}).get("mode"),
                    "planners": [x.get("key") for x in (r.get("planning") or {}).get("plannersUsed") or []],
                    "totalScore": r.get("totalScore"),
                    "dimensions": r.get("dimensions") or {},
                    "conflicts": (r.get("uncertaintiesAndCritiques") or {}).get("plannerConflicts") or [],
                    "uncertainties": (r.get("uncertaintiesAndCritiques") or {}).get("uncertainties") or [],
                    "critiques": (r.get("uncertaintiesAndCritiques") or {}).get("redTeamCritiques") or [],
                    "steps": r.get("selectedAllocation") or [],
                    "audit": audit,
                }
            )
    ledger = ledger_payload()
    return {"available": bool(adrs), "records": adrs, "ledger": ledger}


def ledger_payload() -> list[dict]:
    """表现账本尾部摘要（由路由插件维护的 wu-ai-model-ledger.json）。"""
    path = DSH_HOME / "wu-ai-model-ledger.json"
    try:
        db = json.loads(path.read_text(encoding="utf-8"))
        records = db.get("records") if isinstance(db, dict) else None
        if not isinstance(records, dict):
            return []
    except (OSError, json.JSONDecodeError):
        return []
    rows = []
    for k, rec in records.items():
        parts = str(k).split("::")
        if len(parts) != 3 or not isinstance(rec, dict):
            continue
        n = int(rec.get("totalRuns") or 0)
        passed = int(rec.get("passedCount") or 0)
        rework = int(rec.get("reworkCount") or 0)
        rows.append(
            {
                "model": parts[0],
                "taskType": parts[1],
                "role": parts[2],
                "sampleSize": n,
                "confidence": "RELIABLE" if n >= 10 else "样本不足",
                "passRate": round(passed / n, 2) if n else None,
                "smoothedScore": round((passed + 1) / (n + 2) * (1 - (rework / n if n else 0) * 0.5), 2),
                "reworkRate": round(rework / n, 2) if n else None,
            }
        )
    rows.sort(key=lambda r: -r["sampleSize"])
    return rows[:12]


# ---------------------------------------------------------------- 工作流模板


def workflows_load() -> list[dict]:
    """可复用工作流模板（文档 §四.2）。文件缺失/损坏一律按空表处理。"""
    try:
        data = json.loads(WORKFLOWS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def workflows_save(items: list[dict]) -> None:
    WORKFLOWS_FILE.parent.mkdir(parents=True, exist_ok=True)
    WORKFLOWS_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")


def workflow_upsert(body: dict) -> tuple[dict | None, str | None]:
    """保存/更新一个模板。返回 (记录, 错误信息)。"""
    wf = body.get("workflow") or {}
    items = workflows_load()
    wf_id = str(wf.get("id") or f"wf-{int(time.time() * 1000)}")
    rec = {
        "id": wf_id,
        "name": str(wf.get("name") or "")[:60],
        "goal": str(wf.get("goal") or "")[:2000],
        "steps": str(wf.get("steps") or "")[:2000],
        "inputs": str(wf.get("inputs") or "")[:500],
        "gate": str(wf.get("gate") or "")[:500],
        "output": str(wf.get("output") or "")[:500],
        "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    if not rec["name"] or not rec["goal"]:
        return None, "名称与目标为必填"
    items[:] = [w for w in items if w.get("id") != wf_id]
    items.append(rec)
    workflows_save(items)
    return rec, None


def workflow_delete(wf_id: str) -> None:
    items = workflows_load()
    items[:] = [w for w in items if w.get("id") != wf_id]
    workflows_save(items)


# ---------------------------------------------------------------- 任务投递箱


def pending_task_put(text: str, auto_send: bool = True, verify_mode: str = "strict") -> dict:
    """投递任务。返回 {"duplicate": bool}——幂等窗口内的相同派发不入箱。"""
    fp = _submission_fingerprint(text, verify_mode)
    with _PENDING_LOCK:
        now = time.time()
        if _LAST_SUBMISSION["fp"] == fp and now - _LAST_SUBMISSION["at"] < _IDEMPOTENCY_WINDOW:
            return {"duplicate": True}
        _LAST_SUBMISSION["fp"] = fp
        _LAST_SUBMISSION["at"] = now
        _PENDING_TASK["text"] = text[:8000]
        _PENDING_TASK["at"] = now
        _PENDING_TASK["autoSend"] = bool(auto_send)
        _PENDING_TASK["verifyMode"] = "fast" if verify_mode == "fast" else "strict"
    return {"duplicate": False}


def _pending_snapshot() -> dict | None:
    """投递箱当前内容（调用方须先持有 _PENDING_LOCK）。"""
    text = _PENDING_TASK["text"]
    return {
        "text": text,
        "at": _PENDING_TASK["at"],
        "autoSend": bool(_PENDING_TASK["autoSend"]),
        "verifyMode": str(_PENDING_TASK.get("verifyMode") or "strict"),
    } if text else None


def pending_task_peek() -> dict | None:
    """只读投递箱，不清空（对话页还没进入会话时用来决定要不要先开会话）。"""
    with _PENDING_LOCK:
        return _pending_snapshot()


def _write_turn_config(verify_mode: str) -> None:
    """核验强度随任务下发：对话页取件即写入 turn-config（路由插件按 30 分钟 TTL 读取）。
    发射器「快速直通」→ 路由插件跳过分配内核与独立核验；读不到 / 过期一律按 strict。"""
    try:
        (DSH_HOME / "wu-ai-turn-config.json").write_text(
            json.dumps({"verifyMode": verify_mode, "at": time.time()}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as e:  # 下发失败不阻断派发：路由默认 strict，宁可多验
        log(f"turn-config 写入失败: {e}")


def pending_task_take() -> dict | None:
    with _PENDING_LOCK:
        task = _pending_snapshot()
        _PENDING_TASK.update(text="", at=0.0, autoSend=True, verifyMode="strict")
    if task:
        _write_turn_config(task["verifyMode"])
    return task


# ---------------------------------------------------------------- 沙箱自检


def sandbox_status() -> dict:
    """命令执行是否真在沙箱里：只读激活版本的 base bundle 与用户补丁，不做猜测。

    DSH 的 bash 有两个执行器：`dsh-bash-sandbox`（Seatbelt/Landlock 受限）与
    `dsh-bash-local`（以宿主权限直接跑）。前者一旦被换掉，文件沙箱对命令就形同虚设，
    但界面上不会有任何提示——所以这里每次开页都核对一次并说明结论。
    """
    d = manager.active_dir()
    base = d / "node_modules" / "@deepseek-ai" / "dsh-base" / "cordis.patch.yml"
    try:
        text = base.read_text(encoding="utf-8")
    except OSError:
        return {"enforced": False, "provider": "unknown", "reason": "找不到 base bundle"}
    has_provider = "dsh-sandbox-local" in text
    has_bash = "dsh-bash-sandbox" in text
    disabled = False
    try:
        patch = (DSH_HOME / "profiles" / "web" / "cordis.patch.yml").read_text(encoding="utf-8")
        for block in re.split(r"\n\s*- ", patch):
            if re.search(r"id:\s*(bash-sandbox|sandbox)\s*$", block, re.M) and "disabled: true" in block:
                disabled = True
    except OSError:
        pass
    enforced = bool(has_provider and has_bash and not disabled)
    reason = "命令行由 dsh-bash-sandbox 执行（写限工作区与临时目录）"
    if disabled:
        reason = "用户补丁禁用了沙箱执行器"
    elif not has_bash:
        reason = "base bundle 未挂载 dsh-bash-sandbox"
    elif not has_provider:
        reason = "base bundle 未挂载 dsh-sandbox-local"
    return {"enforced": enforced, "provider": "dsh-bash-sandbox", "reason": reason}


# ---------------------------------------------------------------- 风险审计与预算（P1-6/P1-7）

AUDIT_FILE = "wu-ai-risk-audit.jsonl"
BUDGET_FILE = "wu-ai-budget.json"
POLICY_FILE = "wu-ai-policy.json"

# 托管沙箱策略默认值（P2-10，Codex requirements.toml 模式「管理员基线」）：
# allowedModes 默认只放行 workspace-write——danger-full-access（沙箱几乎失效）
# 必须由用户显式加入白名单，Agent 侧的任何 escalation 都绕不过本清单。
DEFAULT_POLICY = {
    "allowedModes": ["workspace-write"],
    "budget": {"toolCalls": 200, "wallClockMs": 2 * 60 * 60 * 1000, "reviewFails": 5},
}


def sandbox_policy_load() -> dict:
    """读托管沙箱策略；文件缺失/损坏 → 默认值（fail-safe：默认禁危险模式）。"""
    try:
        data = json.loads((DSH_HOME / POLICY_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return json.loads(json.dumps(DEFAULT_POLICY))
    modes = [str(m) for m in (data.get("allowedModes") or []) if isinstance(m, str)]
    budget = data.get("budget") if isinstance(data.get("budget"), dict) else {}
    merged = {
        "allowedModes": modes or list(DEFAULT_POLICY["allowedModes"]),
        "budget": {
            "toolCalls": int(budget.get("toolCalls") or DEFAULT_POLICY["budget"]["toolCalls"]),
            "wallClockMs": int(budget.get("wallClockMs") or DEFAULT_POLICY["budget"]["wallClockMs"]),
            "reviewFails": int(budget.get("reviewFails") or DEFAULT_POLICY["budget"]["reviewFails"]),
        },
    }
    return merged


def sandbox_policy_save(policy: dict) -> dict:
    """校验并落盘（0600）。mode 名只认 DSH 的 ESCALATION_TARGETS 词表。"""
    valid_modes = {"workspace-write", "danger-full-access"}
    modes = [str(m) for m in (policy.get("allowedModes") or []) if str(m) in valid_modes]
    if not modes:
        raise ValueError("白名单不能为空（至少保留 workspace-write）")

    def num(v, default: int) -> int:
        # 显式区分「0」与「没提供」：0 是合法输入（会被下方 clamp 抬到下限），
        # 用 `v or default` 会把 0 误判成缺失
        try:
            return int(v)
        except (TypeError, ValueError):
            return default

    budget_in = policy.get("budget") if isinstance(policy.get("budget"), dict) else {}
    rec = {
        "allowedModes": modes,
        "budget": {
            "toolCalls": max(1, min(10000, num(budget_in.get("toolCalls"), DEFAULT_POLICY["budget"]["toolCalls"]))),
            "wallClockMs": max(60000, min(24 * 3600 * 1000, num(budget_in.get("wallClockMs"), DEFAULT_POLICY["budget"]["wallClockMs"]))),
            "reviewFails": max(1, min(50, num(budget_in.get("reviewFails"), DEFAULT_POLICY["budget"]["reviewFails"]))),
        },
        "updatedAt": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    path = DSH_HOME / POLICY_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return rec


def _tail_jsonl(path: Path, max_lines: int = 200) -> list[dict]:
    """读 jsonl 尾部至多 max_lines 行（与 perf 同思路：不全量载入）。"""
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[-512 * 1024 :]
    except OSError:
        return []
    rows: list[dict] = []
    for line in text.splitlines()[-max_lines:]:
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _verify_audit_chain(rows: list[dict]) -> dict:
    """校验审计哈希链（与 Node risk-review.verifyAuditChain 同算法）。

    逐行重算 sha256(prev + 行内容)：任一行对不上即报告断裂位置。
    只覆盖传入的尾部窗口——足以发现尾部删改，全链校验留给专用工具。
    """
    prev = "genesis"
    for i, row in enumerate(rows):
        rec_prev = row.get("prev")
        rec_h = row.get("h")
        body = {k: v for k, v in row.items() if k not in ("h", "prev")}
        body["prev"] = rec_prev
        canonical = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
        expect = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
        if rec_prev != prev or rec_h != expect:
            return {"ok": False, "brokenAt": i}
        prev = rec_h
    return {"ok": True, "checked": len(rows)}


def risk_audit_payload() -> dict:
    """工作台「风险审计」卡：判定统计 + 尾部链校验 + 最近明细。

    审计文件不存在（DSH 从未跑过带风险层的对话）→ 全空，前端渲染空状态。
    """
    rows = _tail_jsonl(DSH_HOME / AUDIT_FILE)
    if not rows:
        return {"available": False, "total": 0, "chain": None, "recent": []}
    counts: dict[str, int] = {}
    for r in rows:
        d = str(r.get("decision") or "PENDING")
        counts[d] = counts.get(d, 0) + 1
    chain = _verify_audit_chain(rows)
    recent = [
        {
            "at": r.get("ts"),
            "tool": r.get("tool"),
            "decision": r.get("decision"),
            "by": r.get("by"),
            "level": r.get("policyLevel"),
            "reason": str(r.get("reason") or r.get("note") or "")[:120],
            "tainted": bool(r.get("tainted")),
        }
        for r in rows[-8:]
    ]
    return {
        "available": True,
        "total": len(rows),
        "counts": counts,
        "chain": chain,
        "recent": list(reversed(recent)),
    }


def budget_payload() -> dict:
    """会话预算快照（router flushBudget 落盘）。文件缺失 → 不可用。"""
    file = DSH_HOME / BUDGET_FILE
    try:
        snap = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"available": False}
    sessions = snap.get("sessions") if isinstance(snap.get("sessions"), list) else []
    return {
        "available": True,
        "at": snap.get("at"),
        "limits": snap.get("limits") or {},
        "sessions": sessions[-5:],
    }


# ---------------------------------------------------------------- 流水线事件流（任务执行态）
#
# 执行态顶部的四步流水线需要「一进入某阶段就亮」，因此不能靠整页轮询 /api/workspace
# （512KB 尾部解析 + 全量聚合）。这里按**文件偏移**增量读 perf.jsonl：客户端连一次
# SSE（/api/task-stream），服务端每 0.5s 只解析新追加的行；连不上时前端退回
# /api/task-events?offset= 轮询，两条路共用同一份解析逻辑。
#
# 事件仍是路由插件的真实埋点，不伪造：没有埋点就没有动画。

# 流水线关注的事件类型（llm 逐次用量不进四步条；idle 表示本轮结束，前端据此收尾）
PIPELINE_KINDS = ("analyze", "route", "plan", "multi", "execute", "verify", "retry", "idle", "request-error")

_EVENT_FIELDS = (
    "at",
    "kind",
    "capability",
    "model",
    "reason",
    "success",
    "verified",
    "latencyMs",
    "pass",
    "score",
    "gaps",
    "round",
    "role",
    "steps",
)


def perf_offset() -> str:
    """当前 perf.jsonl 的读取位置令牌（`头长.头哈希:偏移`），对客户端不透明。

    令牌里带「文件头签名」而不是纯偏移：文件被轮转（perf.jsonl → perf.jsonl.1）
    或截断后，旧偏移会指到新文件的中段，纯偏移续读会丢掉新文件开头的事件。
    签名只覆盖**令牌那一刻已经存在**的头部长（`hlen`），所以文件继续追加不会
    让签名失效（`hlen` 固定、前 hlen 字节不变）。
    """
    perf = DSH_HOME / "perf.jsonl"
    try:
        size = perf.stat().st_size
    except OSError:
        return "0:0"
    hlen = min(_HEAD_BYTES, size)
    return f"{hlen}.{_head_hash(perf, hlen)}:{size}"


_HEAD_BYTES = 64


def _head_hash(path: Path, n: int) -> str:
    if n <= 0:
        return "0"
    try:
        with path.open("rb") as f:
            head = f.read(n)
    except OSError:
        return "0"
    return hashlib.sha1(head).hexdigest()[:8] if len(head) == n else "0"


def _parse_offset(offset: str | int | None) -> tuple[str, int]:
    """令牌 → (签名, 偏移)。无法解析时按「从头读」处理（宁可重放，不丢事件）。"""
    if isinstance(offset, int):
        return ("", max(0, offset))
    parts = str(offset or "").split(":")
    if len(parts) == 2 and parts[0] and parts[1].isdigit():
        return (parts[0], int(parts[1]))
    return ("", 0)


def _trim_event(row: dict) -> dict:
    rec = {k: row.get(k) for k in _EVENT_FIELDS if k in row}
    if not rec.get("at") and row.get("ts"):
        rec["at"] = row["ts"]
    if isinstance(rec.get("steps"), list):
        rec["steps"] = len(rec["steps"])
    return rec


def read_perf_since(offset: str | int | None, limit: int = 200) -> tuple[str, list[dict]]:
    """从 offset 令牌起读新增的流水线事件，返回 (新令牌, 事件列表)。

    只消费到最后一个**完整行**：追加写进行到一半时不会解析出半截 JSON。
    文件被截断/轮转（头签名不一致或偏移超出文件长度）时自动从头读，不丢事件。
    """
    perf = DSH_HOME / "perf.jsonl"
    try:
        size = perf.stat().st_size
    except OSError:
        return "0:0", []
    old_sig, pos = _parse_offset(offset)
    if old_sig:
        hlen_text, _, old_hash = old_sig.partition(".")
        try:
            hlen = max(0, int(hlen_text))
        except ValueError:
            hlen = 0
        # 只校验令牌里那一段头（不随文件增长而变化）
        if _head_hash(perf, hlen) != old_hash:
            pos = 0
    if pos < 0 or pos > size:
        pos = 0
    next_sig = f"{min(_HEAD_BYTES, size)}.{_head_hash(perf, min(_HEAD_BYTES, size))}"
    if size <= pos:
        return f"{next_sig}:{pos}", []
    try:
        with perf.open("rb") as f:
            f.seek(pos)
            chunk = f.read(1024 * 1024)
    except OSError:
        return f"{next_sig}:{pos}", []
    cut = chunk.rfind(b"\n")
    if cut < 0:
        # 还没有完整行：偏移不前进，令牌原样带回（等下一次追加）
        if isinstance(offset, str) and offset:
            return offset, []
        return f"{next_sig}:{pos}", []
    complete = chunk[: cut + 1]
    events: list[dict] = []
    for line in complete.decode("utf-8", "replace").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict) or row.get("kind") not in PIPELINE_KINDS:
            continue
        events.append(_trim_event(row))
        if len(events) >= limit:
            break
    return f"{next_sig}:{pos + len(complete)}", events


def task_events(offset: str | int | None = -1) -> dict:
    """JSON 回退通道：offset 为空/-1 表示从当前末尾开始（不回放历史）。"""
    start = perf_offset() if offset in (None, "", -1, "-1") else offset
    new_offset, events = read_perf_since(start)
    return {"ok": True, "offset": new_offset, "events": events}
