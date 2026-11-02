"""WU ai 数据迁移层（Stable Data Layer 的版本管理）。

设计（发布 P0「版本升级不炸」）：
- data/config.json 顶层带 schemaVersion；本模块持有版本链，启动时把旧数据
  逐级升到 LATEST_SCHEMA，任何一步失败都返回错误并**不丢弃原始数据**。
- 迁移是幂等的：已是最新版本时直接返回原数据（applied=[]）。
- 每个迁移函数签名：fn(cfg, ks) -> cfg（原地改或返回新 dict 均可）。
  ks 是 keystore.Keystore（v1→v2 需要把明文 Key 迁入密库）。

迁移历史：
  v1 → v2 : 模型 apiKey 从 config.json 明文迁入加密密库，仅留引用
            apiKeySecret = {"id": <模型 id>}。
"""

from __future__ import annotations

from typing import Any, Callable

LATEST_SCHEMA = 2

MIGRATIONS: list[tuple[int, str, Callable[[dict, Any], dict]]] = []


def migrator(version: int, name: str):
    def deco(fn: Callable[[dict, Any], dict]):
        MIGRATIONS.append((version, name, fn))
        return fn
    return deco


@migrator(2, "apiKey 明文迁入加密密库")
def _v1_to_v2(cfg: dict, ks) -> dict:
    """v1: models[].apiKey 明文。v2: 删除明文，写入密库并留 apiKeySecret 引用。"""
    out = dict(cfg)
    models = out.get("models")
    if not isinstance(models, list):
        out["schemaVersion"] = 2
        return out
    new_models = []
    for m in models:
        if not isinstance(m, dict):
            new_models.append(m)
            continue
        key = str(m.get("apiKey") or "").strip()
        m2 = dict(m)
        if key:
            # 无 id 的模型也必须保住 Key：合成稳定 id 存密库，绝不静默丢弃
            sid = str(m2.get("id") or "").strip() or f"m-{len(new_models) + 1}"
            ks.put(sid, key)
            m2["apiKeySecret"] = {"id": sid}
            m2.setdefault("id", sid)
        m2.pop("apiKey", None)
        new_models.append(m2)
    out["models"] = new_models
    out["schemaVersion"] = 2
    return out


def current_version(cfg: dict) -> int:
    v = cfg.get("schemaVersion")
    return int(v) if isinstance(v, int) and v >= 1 else 1


def migrate_data(cfg: dict, ks=None) -> tuple[dict, dict]:
    """按版本链升到最新。返回 (新数据, 报告 {before, after, applied, error})。

    任何迁移报错时立即停在当前版本并附 error；调用方应保留原文件不落盘。
    """
    if ks is None:
        from core.keystore import default_keystore  # 延迟导入避免循环
        ks = default_keystore()
    before = current_version(cfg)
    data = dict(cfg)
    applied: list[dict] = []
    try:
        for target, name, fn in sorted(MIGRATIONS, key=lambda t: t[0]):
            if current_version(data) >= target:
                continue
            data = fn(dict(data), ks)
            data["schemaVersion"] = target
            applied.append({"version": target, "name": name})
        return data, {"before": before, "after": current_version(data),
                      "applied": applied, "error": None}
    except Exception as e:  # 迁移失败：保留原始数据，向上报错
        return cfg, {"before": before, "after": current_version(cfg),
                     "applied": applied, "error": f"{type(e).__name__}: {e}"}