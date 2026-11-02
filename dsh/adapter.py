"""DSH Adapter —— WU ai 与 DSH Runtime 之间唯一的耦合面（Runtime 抽象层）。

设计原则（防 DSH 锁定，P0）：
- WU Core（配置模型 / 路由逻辑）不 import DSH 内部模块；所有 DSH 线上格式
  （settings.yaml / .credentials.yaml / profile package.json / cordis.patch.yml /
  启动命令行）的知识集中在本模块。DSH 改格式 → 只需改这里 + 补版本矩阵。
- 本模块的函数全部是纯函数 + 显式路径参数，可离线单测（tests/test_dsh_adapter.py）。
- 与版本的关系写在 docstring：当前适配 dsh 0.2.0-rc.x（并向下兼容 0.1.5-rc.x 的
  legacy 路径：settings 顶层段 agent-default-model / llm-pi-ai；profile bundles 机制；
  --dump-config 顶层 flag）。0.2.0 起预设注册走 declaration plane，见 modes/。
  换成新大版本时用 runtime_manager 的 A 层兼容测试兜底 + 回滚。
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

# DSH wire 常量（唯一真源）
SETTINGS_OWN_SECTIONS = ("agent-default-model:", "llm-pi-ai:")
PROFILE_BUNDLES_DEFAULT = (
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-wu-ai-router",
    "dsh-wu-ai-ui",
)

# profile 里 DSH 对 file: 依赖做的是快照副本（非软链）——插件产物必须回灌
_UI_ARTIFACTS = ("package.json", "cordis.patch.yml")

# 本地模型没填 baseURL 时的兜底（OpenAI 兼容网关，Ollama 默认端口）
DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1"

# 路由插件运行期文件：profile 里是安装时的快照，新增文件不会被 pnpm 补进去。
# 用目录发现而不是维护清单——清单漏一项就会让整个插件 import 失败并静默降级
# （2026-10-25 的 context.js 事故）。测试脚本（test-*.mjs）不同步进运行时。
_ROUTER_EXTRA = ("package.json", "cordis.patch.yml")


def _router_sources(router_src: Path) -> list[str]:
    names = [
        p.relative_to(router_src).as_posix()
        for p in sorted(router_src.rglob("*.js"))
        if "node_modules" not in p.parts
    ]
    for name in _ROUTER_EXTRA:
        if (router_src / name).is_file():
            names.append(name)
    return names


def env_ref_name(model_id: str) -> str:
    """模型 id → DSH 凭据 ref 名（必须是合法环境变量名）。

    DSH 的 credentials 插件只认 /^[A-Za-z_][A-Za-z0-9_]*$/；
    模型 id 里的点（如 `glm-4.6v`）会让它直接抛错、整个 DSH 启动失败，
    所以这里把所有非法字符统一换成下划线。
    """
    raw = re.sub(r"[^A-Za-z0-9_]", "_", str(model_id).upper())
    if not raw or raw[0].isdigit():
        raw = "_" + raw
    return f"WUAI_{raw}_KEY"


def launch_command(node: str, entry: str, no_open: bool = True) -> list:
    """DSH web 启动命令行。entry 形态随版本/安装方式不同，全部集中在此。

    `--no-open`：DSH 默认会自己开一个浏览器标签页。控制中心已把对话面内嵌进
    单页工作台，再开一个标签就是重复页面（用户明确要求「不开多个标签页」）。
    兼容性：0.2.x 的 `dsh web` 均支持该 flag；升级编排的健康检查会真实启动一次，
    万一新版本不再支持会当场失败并自动回滚（见 dsh/upgrade.py）。
    """
    flags = ["--no-open"] if no_open else []
    if entry.endswith("bin/dsh") or entry.endswith("dsh.cmd") or entry.endswith(".bin/dsh"):
        return [entry, "web", *flags]
    if entry == "npx":
        npx = Path(node).parent / "npx"
        return [node, str(npx), "--yes", "@deepseek-ai/dsh@latest", "web", *flags]
    # node lib/bin.js web
    return [node, entry, "web", *flags]


# ---------------------------------------------------------------- settings.yaml

def _foreign_settings_sections(dsh_home: Path) -> list:
    """DSH 会往 settings.yaml 追加自己的持久化段（如 ui-onboarding）。
    全量重写会抹掉它们导致欢迎弹窗重现，故重写前摘出外来段原样保留。"""
    path = dsh_home / "settings.yaml"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    blocks: list = []
    cur: list = []
    for line in lines:
        if line and not line[0].isspace() and not line.startswith("#"):
            key = line.split(":", 1)[0].strip() + ":"
            if key in SETTINGS_OWN_SECTIONS:
                if cur:
                    blocks.append("\n".join(cur))
                    cur = []
                continue
            if cur:
                blocks.append("\n".join(cur))
            cur = [line]
        elif cur:
            cur.append(line)
    if cur:
        blocks.append("\n".join(cur))
    return blocks


def providers_config_yaml(cfg: dict, proxy=None, indent: int = 4) -> str:
    """渲染 `llm-pi-ai.providers` 下的 provider 块（不含 `providers:` 头）。

    indent 是 provider key 的缩进列数；字段 +2、headers 子项 +4。
    settings.yaml（indent=4）与 profile patch（indent=6）共用，避免两处漂移。
    """
    pad = " " * indent
    p2 = " " * (indent + 2)
    m1 = " " * (indent + 4)
    m2 = " " * (indent + 6)
    m3 = " " * (indent + 8)
    blocks: list[str] = []
    for m in (cfg.get("models") or []):
        if not m.get("enabled"):
            continue
        mid = str(m.get("id") or "")
        if not mid:
            continue
        base = (m.get("baseURL") or "").strip()
        if not base and m.get("access") == "local":
            base = DEFAULT_LOCAL_BASE_URL
        if not base:
            continue
        model_id = m.get("model") or mid
        caps = m.get("capabilities") or {}
        need_image = (
            float(caps.get("vision") or 0) >= 0.3
            or "vl" in model_id.lower()
            or "vision" in model_id.lower()
        )
        # 凭据代理：有 Key 的云端模型走代理（本地模型无可保护的东西，保持直连）
        proxied = proxy is not None and bool((m.get("apiKey") or "").strip()) and m.get("access") != "local"
        if proxied:
            base = proxy.base_url_for(mid)
        headers_block = ""
        if proxied:
            token_lines = "".join(f"{p2}  {k}: {v}\n" for k, v in proxy.token_headers().items())
            headers_block = f"{p2}headers:\n{token_lines}"
        text = (
            f"{pad}{mid}:\n"
            f"{p2}displayName: {m.get('label') or mid}\n"
            f"{p2}apiKeyEnv: {env_ref_name(mid)}\n"
            f"{p2}api: {m.get('api') or 'openai-completions'}\n"
            f"{p2}baseURL: {base}\n"
            f"{headers_block}"
            f"{p2}requestImagePixelBudget: 33554432\n"
            f"{p2}requestImageMaxBytes: 8388608\n"
            f"{p2}maxRequestImageBytes: 83886080\n"
            f"{p2}compat:\n"
            f"{m1}supportsDeveloperRole: false\n"
            f"{m1}supportsReasoningEffort: true\n"
            f"{m1}maxTokensField: max_tokens\n"
            f"{p2}models:\n"
            f"{m1}- id: {model_id}\n"
            + (f"{m2}input: [text, image]\n" if need_image else "")
            + f"{m2}reasoningEfforts:\n"
            f"{m3}off: null\n"
            f"{m3}low: low\n"
            f"{m3}high: high\n"
            f"{m3}max: high\n"
        )
        blocks.append(text)
    return "\n".join(blocks).rstrip("\n")


def settings_yaml(cfg: dict, dsh_home: Path | None = None, proxy=None) -> str:
    """由 WU 配置模型生成 DSH settings.yaml（llm-pi-ai providers + 默认模型）。

    版本耦合点（0.1.5-rc.x ~ 0.2.0-rc.x 实测一致）：
    - 顶层段 agent-default-model.provider 是 llm-pi-ai 的路由名（= model key）
    - provider 块字段：displayName/apiKeyEnv/api/baseURL/compat/models
    - compat.supportsReasoningEffort 守卫 reasoning_effort 的上送；
      wire 值必须合法——`max` 不是合法取值（第三方 provider 会判 400），
      故「最强」映射 high（等级语义由对话页菜单表达）。

    proxy（P2-9 凭据代理）启用时：有 Key 的云端模型 baseURL 改指本机代理，
    并注入 token header（pi-ai 会把 provider.headers 合并进每个请求）；
    DSH 与沙箱只见占位符，真 Key 不落任何 DSH 侧文件。
    """
    models = [m for m in (cfg.get("models") or []) if m.get("enabled")]
    block = providers_config_yaml(cfg, proxy=proxy, indent=4)

    default_id = cfg.get("defaultModelId") or (models[0]["id"] if models else "")
    if not any(m["id"] == default_id for m in models):
        default_id = models[0]["id"] if models else ""
    def_model = next((m.get("model") for m in models if m["id"] == default_id), default_id)

    settings = f"""# 由 WU ai 控制中心生成
agent-default-model:
  provider: {default_id}
  model: {def_model}

llm-pi-ai:
  providers:
{block or '    {}'}
"""
    foreign = _foreign_settings_sections(dsh_home) if dsh_home else []
    if foreign:
        settings = settings.rstrip("\n") + "\n\n" + "\n\n".join(foreign) + "\n"
    return settings


def credentials_yaml(cfg: dict, proxy=None) -> str:
    """WU 配置模型 → DSH .credentials.yaml（env refs 文案，仅启用模型）。

    proxy 启用时写占位符而非明文：DSH 进程与沙箱拿到也无用——真 Key 只在
    代理进程内存，按目标 host 白名单注入（P2-9）。
    """
    creds = []
    for m in (cfg.get("models") or []):
        # 与 settings_yaml 的启用过滤保持一致（真值判断）
        if not m.get("enabled"):
            continue
        key = (m.get("apiKey") or "").strip()
        if key:
            env_name = env_ref_name(m["id"])
            value = proxy.placeholder_for(m["id"]) if proxy is not None else key
            creds.append(f"  {env_name}: {value}")
    return "version: 1\n\nrefs:\n" + ("\n".join(creds) + "\n" if creds else "  {}\n")


def write_config(dsh_home: Path, cfg: dict, log=None, proxy=None) -> None:
    """落盘 settings.yaml + .credentials.yaml（0600）。"""
    log = log or (lambda s: None)
    dsh_home = Path(dsh_home)
    dsh_home.mkdir(parents=True, exist_ok=True)
    (dsh_home / "settings.yaml").write_text(
        settings_yaml(cfg, dsh_home, proxy=proxy), encoding="utf-8"
    )
    cred_path = dsh_home / ".credentials.yaml"
    cred_path.write_text(credentials_yaml(cfg, proxy=proxy), encoding="utf-8")
    try:
        cred_path.chmod(0o600)
    except OSError:
        pass
    mode = "凭据代理（占位符）" if proxy is not None else "直连"
    log(f"已写入 DSH 配置: {dsh_home / 'settings.yaml'}（{mode}）")


# ---------------------------------------------------------------- profile（插件装载面）

def ensure_profile_package_json(
    profile_dir: Path,
    router_dir: Path,
    ui_dir: Path,
    bundles: tuple = PROFILE_BUNDLES_DEFAULT,
    log=None,
) -> Path:
    """幂等生成/修复 profile package.json（插件 file: 依赖 + bundles）。

    客户端插件只有成为「已启用的 Loader 条目」才会被 compose 并下发到浏览器；
    已存在时只做增量补齐，不动其它人工改动（兼容原版 DSH 各类 profile 写法）。"""
    log = log or (lambda s: None)
    profile_dir = Path(profile_dir)
    profile_dir.mkdir(parents=True, exist_ok=True)
    pkg = profile_dir / "package.json"

    payload: dict = {}
    if pkg.is_file():
        try:
            loaded = json.loads(pkg.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                payload = loaded
        except (OSError, json.JSONDecodeError) as e:
            log(f"profile package.json 无法解析，将重建: {e}")

    payload["name"] = payload.get("name") or "dsh-profile-web"
    payload["private"] = True

    deps = payload.get("dependencies")
    if not isinstance(deps, dict):
        deps = {}
    deps["dsh-wu-ai-router"] = f"file:{router_dir}"
    deps["dsh-wu-ai-ui"] = f"file:{ui_dir}"
    payload["dependencies"] = deps

    dsh = payload.get("dsh")
    if not isinstance(dsh, dict):
        dsh = {}
    profile = dsh.get("profile")
    if not isinstance(profile, dict):
        profile = {}
    bundle_list = profile.get("bundles")
    if not isinstance(bundle_list, list):
        bundle_list = []
    for bundle in bundles:
        if bundle not in bundle_list:
            bundle_list.append(bundle)
    profile["bundles"] = bundle_list
    profile.setdefault("patchReload", "live")
    dsh["profile"] = profile
    payload["dsh"] = dsh

    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    if pkg.is_file():
        try:
            if pkg.read_text(encoding="utf-8") == text:
                return pkg
        except OSError:
            pass
    pkg.write_text(text, encoding="utf-8")
    log(f"已写 profile package.json（plugins + bundles）: {profile_dir}")
    return pkg


def sync_plugin_artifacts(profile_dir: Path, ui_src: Path, log=None) -> None:
    """把 wu-ai-ui 的产物（manifest + bundle patch + dist）回灌 profile 快照副本。

    profile 装的是 pnpm 对 file: 依赖的**快照副本**（非软链），改完 src 后必须
    回灌，否则运行时会命中旧 manifest（缺 dsh.bundle.patch 会 compose 失败）与
    旧 dist。逐文件按内容比对，只有不一致才覆盖。"""
    log = log or (lambda s: None)
    ui_src = Path(ui_src)
    src_dist = ui_src / "dist"
    if not src_dist.is_dir():
        return

    def same(src: Path, dst: Path) -> bool:
        try:
            return (
                dst.is_file()
                and src.stat().st_size == dst.stat().st_size
                and src.read_bytes() == dst.read_bytes()
            )
        except OSError:
            return False

    for store in Path(profile_dir).glob("node_modules/dsh-wu-ai-ui"):
        if not store.is_dir():
            continue
        for name in _UI_ARTIFACTS:
            s = ui_src / name
            d = store / name
            if s.is_file() and not same(s, d):
                try:
                    shutil.copy2(s, d)
                    log(f"同步插件产物: dsh-wu-ai-ui/{name}")
                except OSError as e:
                    log(f"同步插件产物失败 {name}: {e}")
        dst_dist = store / "dist"
        if not dst_dist.is_dir():
            continue
        wanted = {p.name for p in src_dist.iterdir() if p.is_file()}
        for stale in dst_dist.iterdir():
            if stale.is_file() and stale.name not in wanted:
                try:
                    stale.unlink()
                except OSError:
                    pass
        for name in sorted(wanted):
            s = src_dist / name
            d = dst_dist / name
            if s.is_file() and not same(s, d):
                try:
                    shutil.copy2(s, d)
                    log(f"同步插件产物: dsh-wu-ai-ui/dist/{name}")
                except OSError as e:
                    log(f"同步插件产物失败 dist/{name}: {e}")


def reconcile_session_model_selection(
    dsh_home: Path,
    providers: dict,
    default_provider: str,
    default_model: str,
) -> int:
    """清理会话缓存里指向“已下线模型”的最近使用记录。

    DSH 的模型选择器会按会话缓存显示最近使用的模型；提供方被删掉后
    （如早已下线的 xiaomi/mimo-v2.5），这些记录会继续出现在选项里，
    看起来像还能用。这里只改 modelSelection 槽（lastUsed / pending），
    不碰消息历史；返回被修正的会话文件数。
    """
    providers = {str(k): {str(x) for x in (v or set())} for k, v in (providers or {}).items()}
    root = Path(dsh_home) / "storages" / "session_projcache" / "sessions"

    def dead(slot) -> bool:
        if not isinstance(slot, dict):
            return False
        prov = slot.get("provider")
        model = slot.get("model")
        if not isinstance(prov, str) or not prov:
            return False
        if prov not in providers:
            return True
        known = providers[prov]
        return bool(known) and isinstance(model, str) and model not in known

    def fix_val(val) -> bool:
        if not isinstance(val, dict):
            return False
        hit = False
        for key in ("lastUsed", "pending"):
            if dead(val.get(key)):
                val[key] = {"provider": default_provider, "model": default_model}
                hit = True
        return hit

    def walk(node) -> bool:
        hit = False
        if isinstance(node, dict):
            ms = node.get("modelSelection")
            if isinstance(ms, dict) and fix_val(ms.get("val")):
                hit = True
            if "lastUsed" in node and fix_val(node):
                hit = True
            for child in node.values():
                if isinstance(child, (dict, list)) and walk(child):
                    hit = True
        elif isinstance(node, list):
            for child in node:
                if isinstance(child, (dict, list)) and walk(child):
                    hit = True
        return hit

    if not root.is_dir():
        return 0
    changed = 0
    for path in root.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not walk(data):
            continue
        try:
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            changed += 1
        except OSError:
            continue
    return changed


def sync_router_artifacts(profile_dir: Path, router_src: Path, log=None) -> list:
    """把 wu-ai-router 的运行期源文件回灌 profile 快照副本。

    踩坑记录（2026-10-25）：profile 里是 9 月 pnpm 安装时的旧副本，后来新增的
    `context.js` / `risk-review.js` / `planner.js` 从未被复制进去，DSH 每次启动
    只报一句 `wu-ai-router: failed to import`（见 data/dsh.log），路由/质检/埋点
    全部静默失效 —— perf.jsonl 只剩 dag-step，没有任何 route/execute/verify 行。
    逐文件按内容比对，只覆盖不一致或缺失的。
    """
    log = log or (lambda s: None)
    router_src = Path(router_src)
    changed: list = []
    for store in Path(profile_dir).glob("node_modules/dsh-wu-ai-router"):
        if not store.is_dir():
            continue
        for name in _router_sources(router_src):
            s = router_src / name
            d = store / name
            if not s.is_file():
                continue
            try:
                if d.is_file() and s.read_bytes() == d.read_bytes():
                    continue
            except OSError:
                pass
            try:
                d.parent.mkdir(parents=True, exist_ok=True)  # allocation/ 子目录首次同步需要
                shutil.copy2(s, d)
                changed.append(name)
                log(f"同步路由插件: dsh-wu-ai-router/{name}")
            except OSError as e:
                log(f"同步路由插件失败 {name}: {e}")
    return changed