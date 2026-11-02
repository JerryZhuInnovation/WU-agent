"""WU ai 配置层：模型与偏好的读写、规范化、密钥落库。

分层职责（零 DSH 知识——DSH 的 settings/credentials 渲染在 dsh/ 层）：
- load_config：读 config.json + 触发 schema 迁移 + 从密库解密出内存明文
- save_config：密钥入密库、只留 apiKeySecret 引用、清理孤儿密钥
- normalize_models：入参防呆与字段归一
"""

from __future__ import annotations

import json
import re

from core.log import log
from core.paths import CONFIG_JSON
from core.keystore import default_keystore, KeystoreError
from core.migration import migrate_data, LATEST_SCHEMA

# 能力字段与中文标签
CAPABILITIES = [
    ("coding", "写代码"),
    ("vision", "看图 / 视觉"),
    ("reasoning", "深度推理"),
    ("research", "调研资料"),
    ("writing", "写作 / 翻译"),
    ("general", "通用对话"),
]
CAP_KEYS = [c[0] for c in CAPABILITIES]

DEFAULT_CONFIG = {
    "schemaVersion": LATEST_SCHEMA,  # Stable Data Layer：新配置直接按最新 schema 落盘（版本链见 core/migration）
    "models": [],
    "prefer": {},
    "routingMode": "smart",
    "analyzerModelId": "",
    "defaultModelId": "",
    "preset": "wu",  # 只保留 WU 模式（DSHY 已移除，该字段仅作配置兼容）
}


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if CONFIG_JSON.exists():
        try:
            raw = json.loads(CONFIG_JSON.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = None
        if isinstance(raw, dict):
            # Stable Data Layer：启动即迁移（v1 明文 Key → v2 密库引用），迁移成功才落盘
            ks = default_keystore()
            raw, rep = migrate_data(raw, ks)
            if rep.get("error"):
                log(f"配置迁移失败（保留原文件，本次按兼容模式读取）: {rep['error']}")
            if rep.get("applied"):
                try:
                    save_config_json(raw)
                    chain = " → ".join(f"v{i['version']} {i['name']}" for i in rep["applied"])
                    log(f"配置已迁移: {chain}")
                except OSError as e:
                    log(f"迁移结果落盘失败: {e}")

            cfg["models"] = normalize_models(raw.get("models") or [])
            cfg["prefer"] = dict(raw.get("prefer") or {})
            # 手动路由已移除：恒智能
            cfg["routingMode"] = "smart"
            # 只保留 WU 模式（DSHY 已移除）：该字段仅为配置兼容保留
            cfg["preset"] = "wu"
            cfg["analyzerModelId"] = str(raw.get("analyzerModelId") or "")
            cfg["defaultModelId"] = str(raw.get("defaultModelId") or "")
            # 旧版 providers 键 → models（历史上手写迁移，现由 migration 链兜底）
            if not cfg["models"] and raw.get("providers"):
                cfg["models"] = migrate_legacy_providers(raw["providers"])
    # 从密库解密出内存明文（apiKeySecret 引用 → apiKey），DSH 配置写入只在这之后发生
    try:
        ks = default_keystore()
        for m in cfg["models"]:
            ref = m.get("apiKeySecret") if isinstance(m.get("apiKeySecret"), dict) else None
            sid = (ref or {}).get("id") or m["id"]
            secret = ks.get(str(sid))
            if secret:
                m["apiKey"] = secret
            elif ref:
                # 引用存在但密库缺失：老版本无法解密失败的兜底提示（不阻断启动）
                m["apiKey"] = ""
    except KeystoreError as e:
        log(f"密钥库不可用（{e}），本次以无 Key 状态运行")
        for m in cfg["models"]:
            m["apiKey"] = ""
    return cfg


def migrate_legacy_providers(providers: dict) -> list:
    out = []
    for pid, pdata in providers.items():
        if not isinstance(pdata, dict):
            continue
        key = (pdata.get("apiKey") or "").strip()
        base = (pdata.get("baseURL") or "").strip()
        models_raw = (pdata.get("models") or "").strip()
        mid = next((m.strip() for m in re.split(r"[,\n]", models_raw) if m.strip()), "")
        # 无内置厂商预设：缺 baseURL/模型名的旧条目无法补全，跳过（控制中心可随时重新添加）
        if not base or not mid:
            continue
        is_local = base.startswith(("http://127.0.0.1", "http://localhost", "http://[::1]"))
        if not is_local and not key:
            continue
        out.append(
            {
                "id": pid,
                "label": pid,
                "access": "local" if is_local else "api",
                "provider": pid,
                "model": mid,
                "apiKey": key,
                "baseURL": base,
                "api": "openai-completions",
                "costScore": 0.8,
                "latencyScore": 0.7,
                "enabled": True,
                "capabilities": default_caps_for(),
            }
        )
    return out


def default_caps_for() -> dict:
    return {"coding": 0.7, "reasoning": 0.7, "general": 0.75, "research": 0.6, "writing": 0.65, "vision": 0}


def normalize_models(models: list) -> list:
    def _f(v, d: float) -> float:
        try:
            return float(v)
        except (TypeError, ValueError):
            return d

    out = []
    for m in models or []:
        if not isinstance(m, dict):
            continue
        mid = str(m.get("id") or "").strip()
        if not mid:
            mid = f"m-{len(out)+1}"
        caps = m.get("capabilities") or {}
        norm_caps = {k: _f(caps.get(k, 0) or 0, 0.0) for k in CAP_KEYS}
        entry = {
            "id": mid,
            "label": str(m.get("label") or mid),
            "access": "local" if m.get("access") == "local" else "api",
            "provider": str(m.get("provider") or mid),
            "model": str(m.get("model") or mid),
            "apiKey": str(m.get("apiKey") or ""),
            "baseURL": str(m.get("baseURL") or ""),
            "api": str(m.get("api") or "openai-completions"),
            "costScore": _f(m.get("costScore", 0.8), 0.8),
            "latencyScore": _f(m.get("latencyScore", 0.7), 0.7),
            "enabled": bool(m.get("enabled", True)),
            "preference": str(m.get("preference") or ""),
            "modelPath": str(m.get("modelPath") or ""),
            "capabilities": norm_caps,
        }
        ref = m.get("apiKeySecret") if isinstance(m.get("apiKeySecret"), dict) else None
        if ref and ref.get("id"):
            entry["apiKeySecret"] = {"id": str(ref["id"])}
        out.append(entry)
    return out


def save_config_json(raw: dict) -> None:
    """落盘原始配置 dict（迁移框架用，绕过密库处理）。"""
    CONFIG_JSON.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_JSON.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    CONFIG_JSON.chmod(0o600)


def save_config(cfg: dict) -> None:
    """把内存配置持久化。安全 P0：apiKey 优先写进密库、只在 config.json 留引用。

    极端环境（openssl 不可用）无法加密时降级为明文并记告警——功能可用的代价，
    日志会明确提示用户检查 openssl。
    """
    ks = default_keystore()
    payload = json.loads(json.dumps(cfg))
    models = payload.get("models") if isinstance(payload.get("models"), list) else []
    valid_ids = set()
    for m in models:
        if not isinstance(m, dict):
            continue
        mid = str(m.get("id") or "").strip()
        if not mid:
            continue
        valid_ids.add(mid)
        key = str(m.get("apiKey") or "").strip()
        if key:
            try:
                ks.put(mid, key)
                m["apiKeySecret"] = {"id": mid}
            except KeystoreError as e:
                # openssl 不可用等极端环境：保功能降级为明文，并记日志告警
                log(f"密钥加密失败，回退明文存储（请检查 openssl）: {e}")
                m.pop("apiKeySecret", None)
                m["apiKey"] = key
                continue
        m.pop("apiKey", None)
        if not m.get("apiKeySecret"):
            m.pop("apiKeySecret", None)
    # 清掉已删除模型的孤儿密钥
    try:
        for orphan in [i for i in ks.ids() if i not in valid_ids]:
            ks.delete(orphan)
    except KeystoreError:
        pass
    payload["schemaVersion"] = LATEST_SCHEMA
    save_config_json(payload)


def cfg_default_brain() -> str:
    cfg = load_config()
    aid = cfg.get("analyzerModelId") or ""
    if aid and any(m["id"] == aid for m in cfg.get("models") or []):
        return aid
    return cfg.get("defaultModelId") or ""
