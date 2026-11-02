"""WU ai 启动器：Node / DSH 运行时就绪、DSH 进程起停、token 管理。

编排顺序（start_dsh）：写配置（dsh.profile_patch）→ Node 就绪 → 环境变量 →
预设就绪 → 运行时补丁 → 启动进程 → 后台等就绪并抓 token。
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import stat
import subprocess
import threading
import time
import webbrowser
import zipfile
from pathlib import Path

from core.log import log
from core.paths import (
    DEFAULT_WORKSPACE,
    DSH_HOME,
    DSH_LOG,
    DSH_PORT,
    DSH_URL_FILE,
    HOST,
    NODE_VERSION,
    PID_FILE,
    ROOT,
    RUNTIME,
)
from dsh import adapter, manager
from dsh.profile_patch import cleanup_legacy_gates, write_dsh_config
from server import credential_proxy
from server.presence import agent_page_recent


def find_node() -> str | None:
    cand = RUNTIME / f"node-v{NODE_VERSION}-{platform.system().lower()}-{platform.machine()}" / "bin" / "node"
    if cand.is_file():
        return str(cand)
    p = shutil.which("node")
    if p:
        return p
    for c in ("/opt/homebrew/bin/node", "/usr/local/bin/node"):
        if Path(c).is_file():
            return c
    nvm_dir = Path.home() / ".nvm/versions/node"
    if nvm_dir.is_dir():
        for v in sorted(nvm_dir.iterdir(), reverse=True):
            n = v / "bin" / "node"
            if n.is_file():
                return str(n)
    return None


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    curl = shutil.which("curl")
    if not curl:
        raise RuntimeError("需要 curl 下载 Node")
    log(f"curl 下载: {url}")
    proc = subprocess.run(
        [curl, "-L", "--fail", "--retry", "3", "-o", str(dest), url],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl 下载失败: {proc.stderr.strip()}")
    if not dest.is_file() or dest.stat().st_size < 1000:
        raise RuntimeError("下载文件过小")


def download_portable_node() -> str:
    sysname = platform.system().lower()
    # Node 发行包用 x64/arm64 命名，与 platform.machine()（x86_64/AMD64/aarch64）不一致
    arch = {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64", "arm64": "arm64", "x64": "x64"}.get(
        platform.machine(), platform.machine()
    )
    plat = f"{sysname}-{arch}" if sysname in ("darwin", "linux") else f"win-{arch}"
    ext = "zip" if sysname == "windows" else "tar.gz"
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-{plat}.{ext}"
    dest_root = RUNTIME / "node-dist"
    dest_root.mkdir(parents=True, exist_ok=True)
    archive = dest_root / Path(url).name
    download_file(url, archive)
    if ext == "tar.gz":
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(dest_root)], check=True, timeout=300)
    else:
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(dest_root)
    final = RUNTIME / f"node-v{NODE_VERSION}-{platform.system().lower()}-{platform.machine()}"
    if final.exists():
        shutil.rmtree(final)
    extracted = dest_root / f"node-v{NODE_VERSION}"
    if not extracted.exists():
        # 只认解压目录：glob 会同时命中 .tar.gz/.zip 压缩包，选中会 move 出错
        cands = [p for p in dest_root.glob("node-v*") if p.is_dir()]
        extracted = cands[0] if cands else None
    if not extracted or not extracted.exists():
        raise RuntimeError("Node 解压失败")
    shutil.move(str(extracted), str(final))
    node = final / "bin" / "node"
    if not node.exists():
        node = final / "node.exe"
    node.chmod(node.stat().st_mode | stat.S_IEXEC)
    log(f"便携 Node 就绪: {node}")
    return str(node)


def ensure_node() -> str:
    n = find_node()
    if n:
        return n
    return download_portable_node()


def ensure_dsh_package(node: str) -> str:
    """预装 @deepseek-ai/dsh 到当前激活目录，避免每次 npx 拉取；首次安装后秒开。"""
    app = manager.active_dir()
    pkg = app / "node_modules" / "@deepseek-ai" / "dsh"
    # 已有入口
    for cand in (
        pkg / "lib" / "bin.js",
        pkg / "bin" / "dsh.js",
        pkg / "lib" / "index.js",
        app / "node_modules" / ".bin" / "dsh",
    ):
        if Path(cand).is_file():
            return str(cand)

    app.mkdir(parents=True, exist_ok=True)
    npm = Path(node).parent / ("npm.cmd" if platform.system() == "Windows" else "npm")
    package_json = app / "package.json"
    if not package_json.exists():
        package_json.write_text(
            json.dumps(
                {
                    "name": "wu-ai-dsh-app",
                    "private": True,
                    "dependencies": {"@deepseek-ai/dsh": "latest"},
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    env = os.environ.copy()
    env["PATH"] = f"{Path(node).parent}:{env.get('PATH', '')}"
    log(f"预装 DSH 到 {app} …")
    proc = subprocess.run(
        [str(npm), "install", "--prefix", str(app), "--no-fund", "--no-audit", "@deepseek-ai/dsh@latest"],
        cwd=str(app),
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"DSH 预装失败: {proc.stderr[-400:]}")
    # 安装后解析入口
    for cand in (
        pkg / "lib" / "bin.js",
        pkg / "bin" / "dsh.js",
        app / "node_modules" / ".bin" / "dsh",
    ):
        if Path(cand).is_file():
            return str(cand)
    # fallback: npx 一次
    return "npx"


def ensure_runtime_patches() -> None:
    """WU ai 定制补丁：移除内置 DeepSeek 官方提供方 + 品牌替换（幂等，自愈）。"""
    # 先回灌路由插件源文件：profile 是 pnpm 安装时的快照，新增文件不会自动进去，
    # 缺一个 context.js 就会让整个路由插件 import 失败（静默降级为无路由）。
    try:
        changed = adapter.sync_router_artifacts(
            DSH_HOME / "profiles" / "web",
            ROOT / "plugins" / "wu-ai-router",
            log=log,
        )
        if changed:
            log(f"路由插件已同步 {len(changed)} 个文件")
    except Exception as e:  # 同步失败不阻断启动，但必须留痕
        log(f"路由插件同步失败: {e}")

    status = manager.apply_runtime_patch(manager.active_dir())
    if status == "applied":
        log("已应用运行时补丁: 移除内置 DeepSeek 官方提供方")
    elif status not in ("n/a",):
        log(f"运行时补丁状态: {status}")

    brand = manager.apply_brand_patch(manager.active_dir())
    if brand["changed"]:
        log(f"已应用品牌补丁: {len(brand['changed'])} 处（{', '.join(sorted(set(brand['changed'])))}）")
    elif brand["missing"]:
        log(f"品牌补丁部分未命中: {', '.join(sorted(set(brand['missing'])))}")


def prune_stale_runtimes() -> None:
    """后台收敛旧运行时：只留「当前版 + 上一版」（删目录动辄几百 MB，放后台线程跑）。"""
    try:
        res = manager.prune_stale(lambda s: log(s))
        if res.get("removed"):
            log(f"已清理更早的运行时: {', '.join(res['removed'])}")
    except Exception as e:
        log(f"清理更早的运行时失败: {e}")


def ensure_wu_preset() -> None:
    from dsh.modes import ensure_mode_presets, find_standard_preset_src

    ensure_mode_presets(DSH_HOME, find_standard_preset_src())


def build_env(cfg: dict, proxy=None) -> dict:
    env = os.environ.copy()
    env["DSH_HOME"] = str(DSH_HOME)
    env.setdefault("DSH_TELEMETRY_DISABLED", "1")
    # 项目源码树根：risk-review 的「受保护路径」据此把仓库自身纳入硬性禁令
    #（防 Agent 通过提权调用改沙箱策略/路由插件/审计链路）。
    env["WUAI_HOME"] = str(Path(__file__).resolve().parent.parent)
    for m in cfg.get("models") or []:
        key = (m.get("apiKey") or "").strip()
        if key:
            env_name = adapter.env_ref_name(m["id"])
            # P2-9：代理模式下 env 只放占位符——真 Key 不进 DSH 进程，沙箱 `env` 也取不到
            env[env_name] = proxy.placeholder_for(m["id"]) if proxy is not None else key
    return env


# token URL 唯一真源：DSH 就绪时往 stdout 打带 token 的地址，正则只此一处。
# 换端口只改 core/paths.DSH_PORT；改格式只改这一行。
_TOKEN_URL_RE = re.compile(rf"http://{re.escape(HOST)}:{DSH_PORT}/\?token=[A-Za-z0-9_\-]+")

# 读 dsh.log 只取尾部：它是只追加日志，全量读会随运行时间线性变慢
_LOG_TAIL_BYTES = 64 * 1024
# 单次启动前允许的日志上限：超过即轮转一次，避免无界增长
_LOG_MAX_BYTES = 5 * 1024 * 1024


def _rotate_log_if_large() -> None:
    """dsh.log 超过上限时轮转一份 .1（只保留一代），失败不阻断启动。"""
    try:
        if DSH_LOG.exists() and DSH_LOG.stat().st_size > _LOG_MAX_BYTES:
            DSH_LOG.replace(DSH_LOG.with_suffix(".log.1"))
    except OSError:
        pass


def _token_from_log(text: str) -> str | None:
    """从日志文本里抓最后一个带 token 的就绪 URL；没有则 None。"""
    found = _TOKEN_URL_RE.findall(text)
    return found[-1] if found else None


def write_dsh_url(url: str) -> None:
    """dsh.url 含 ?token= 会话凭据：落盘即 0600（与 config.json/.credentials 同标准）。"""
    try:
        DSH_URL_FILE.write_text(url, encoding="utf-8")
        DSH_URL_FILE.chmod(0o600)
    except OSError:
        pass


def dsh_token_url() -> str:
    base = f"http://{HOST}:{DSH_PORT}"
    try:
        size = DSH_LOG.stat().st_size
        with DSH_LOG.open("rb") as f:
            # 只读尾部：dsh.log 会一直追加，全量读会让每次 /api/status 都变慢
            f.seek(max(0, size - _LOG_TAIL_BYTES))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        text = ""
    url = _token_from_log(text)
    if url:
        write_dsh_url(url)
        return url
    if DSH_URL_FILE.exists():
        try:
            saved = DSH_URL_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            saved = ""
        if saved.startswith("http"):
            return saved
    return base


def token_url_alive(url: str, timeout: float = 2.0) -> bool:
    """验证 token URL：跟随 303 并携带 Set-Cookie；服务器在响应即认为就绪。"""
    import http.cookiejar
    import urllib.error
    import urllib.request

    if not url.startswith("http"):
        return False
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    try:
        opener.open(url, timeout=timeout)
        return True
    except urllib.error.HTTPError as e:
        # 401 = 服务在但 cookie 未带上；说明端口活着，token 多半有效
        return e.code < 500
    except Exception:
        return False


def dsh_running() -> dict | None:
    try:
        with socket.create_connection((HOST, DSH_PORT), timeout=0.5):
            pass
    except OSError:
        return None
    pid = None
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
        except (OSError, ValueError):
            pid = None
    return {"pid": pid, "url": dsh_token_url()}


def start_dsh(cfg: dict, wait_ready: float = 0) -> dict:
    """启动 DSH。默认非阻塞：只发起启动，返回 url=None，就绪状态由后台线程跟踪。
    wait_ready>0 时同步等待就绪（最多 wait_ready 秒）并返回就绪 URL，
    供升级编排等需要真实 URL 的调用方使用。"""
    # P2-9 凭据代理先行：settings/env 的占位符形态依赖它；起不来则大声降级直连
    # （真 Key 仍会进 DSH 进程——功能故障必须可见，不能静默失效）。
    # 2026-10-26 起代理随控制中心常驻（幂等复用，生命周期 = 控制中心进程）：
    # DSH 启动失败不再回收代理——它不是「为这次启动而活」的资源。
    proxy = credential_proxy.start_for(cfg)
    return _start_dsh_inner(cfg, proxy=proxy, wait_ready=wait_ready)


def _model_provider_map(cfg: dict) -> dict:
    """配置里的模型清单 → {provider: {model ids}}，供会话缓存清理用。"""
    providers: dict[str, set] = {}
    for m in cfg.get("models") or []:
        prov = str(m.get("provider") or m.get("id") or "")
        mid = str(m.get("model") or m.get("id") or "")
        if prov and mid:
            providers.setdefault(prov, set()).add(mid)
    return providers


def _default_route(cfg: dict) -> tuple[str, str]:
    models = cfg.get("models") or []
    chosen = next((m for m in models if m.get("id") == cfg.get("defaultModelId")), None)
    chosen = chosen or (models[0] if models else {})
    return (
        str(chosen.get("provider") or chosen.get("id") or ""),
        str(chosen.get("model") or chosen.get("id") or ""),
    )


def reconcile_session_models(cfg: dict) -> int:
    """模型改名/删除后立刻修正会话缓存里的旧 provider/model。

    不做这一步，旧会话下一次请求会被 DSH 适配器以
    `no adapter registered for provider "zhipu"` 直接拒绝（连标题生成也中招）。
    """
    dprov, dmodel = _default_route(cfg)
    if not dprov or not dmodel:
        return 0
    return adapter.reconcile_session_model_selection(
        DSH_HOME, _model_provider_map(cfg), dprov, dmodel
    )


def _start_dsh_inner(cfg: dict, proxy, wait_ready: float) -> dict:
    write_dsh_config(cfg, proxy=proxy)
    # 清理会话缓存里指向已下线模型的「最近使用」——否则 DSH 模型选择器会继续
    # 显示早已删除的 provider/model（如 xiaomi/mimo），看起来像还能选。
    try:
        n = reconcile_session_models(cfg)
        if n:
            log(f"已清理 {n} 个会话的失效选模记录")
    except Exception as e:
        log(f"清理失效选模记录失败: {e}")
    # 启动时用配置同步模式文件，保证控制中心与路由器一致（/wu-mode 的临时覆盖会在重启后被配置归一）
    cleanup_legacy_gates()
    node = ensure_node()
    env = build_env(cfg, proxy=proxy)
    env["PATH"] = f"{Path(node).parent}:{env.get('PATH', '')}"
    ensure_wu_preset()
    ensure_runtime_patches()

    running = dsh_running()
    if running:
        # 已在跑：优先给仍有效的 token；否则引导重新登录
        saved = dsh_token_url()
        if saved and "token=" in saved and token_url_alive(saved):
            # DSH 只在启动时自动开页；已在运行时若页面没开着（心跳超时），由控制中心打开
            if not agent_page_recent():
                webbrowser.open(saved)
                log("Agent 已在运行，已打开其页面")
            return {"ok": True, "message": "已在运行", "url": saved}
        return {
            "ok": True,
            "message": "已在运行。若页面打不开，请点「重新登录」。",
            "url": f"http://{HOST}:{DSH_PORT}/",
        }

    entry = ensure_dsh_package(node)
    _rotate_log_if_large()
    log_file = DSH_LOG
    try:
        marker = f"--- launch {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n"
        with log_file.open("a", encoding="utf-8") as mf:
            mf.write(marker)
        launch_offset = log_file.stat().st_size
    except OSError:
        launch_offset = 0
    lf = log_file.open("a", encoding="utf-8")
    cmd = adapter.launch_command(node, entry)
    log(f"启动 DSH: {' '.join(cmd)}")
    try:
        proc = subprocess.Popen(
            cmd, cwd=str(DEFAULT_WORKSPACE), env=env, stdout=lf, stderr=lf, start_new_session=True
        )
    except Exception as e:
        raise RuntimeError(f"无法启动 DSH：{e}") from e
    finally:
        # 子进程已持有 dup 出去的句柄；父进程必须关闭，失败路径也不能泄漏
        lf.close()
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")

    def token_this_launch() -> str:
        try:
            with log_file.open("r", encoding="utf-8") as f:
                f.seek(launch_offset)
                text = f.read()
        except OSError:
            text = ""
        url = _token_from_log(text)
        if url:
            write_dsh_url(url)
            return url
        return dsh_token_url()

    def await_ready(timeout: float = 90.0) -> str | None:
        """等待本次启动就绪：负责落 token、跟踪进程退出。
        返回就绪 URL；进程退出或超时返回 None。"""
        deadline = time.time() + timeout
        i = 0
        while time.time() < deadline:
            i += 1
            if proc.poll() is not None:
                tail = ""
                try:
                    tail = log_file.read_text(encoding="utf-8")[-1500:]
                except OSError:
                    pass
                log(f"DSH 退出 code={proc.returncode}\n{tail}")
                PID_FILE.unlink(missing_ok=True)
                return None
            try:
                with socket.create_connection((HOST, DSH_PORT), timeout=0.5):
                    time.sleep(1.0)
                    url = token_this_launch()
                    if token_url_alive(url):
                        log(f"DSH 已就绪: {url}")
                        return url
                    if i % 5 == 0:
                        log(f"端口已开，等待登录页就绪… ({i}s)")
                    time.sleep(0.8)
                    continue
            except OSError:
                if i % 5 == 0:
                    log(f"等待 DSH 端口… ({i}s)")
                time.sleep(1)
        log(f"DSH 启动超时，见 {log_file}")
        return None

    if wait_ready > 0:
        # 升级编排需要就绪 URL 才能做健康检查与契约冒烟，这里同步等待到就绪
        ready_url = await_ready(wait_ready)
        return {
            "ok": True,
            "message": "已启动并就绪" if ready_url else "已发起启动，等待就绪超时",
            "url": ready_url,
        }

    threading.Thread(target=await_ready, daemon=True).start()
    return {"ok": True, "message": "已发起启动，Agent 页面就绪后会自动打开", "url": None}


def stop_dsh() -> dict:
    import signal as signal_mod

    pids: set[int] = set()
    if PID_FILE.exists():
        try:
            pids.add(int(PID_FILE.read_text().strip()))
        except (OSError, ValueError):
            pass
    lsof = shutil.which("lsof")
    if lsof:
        try:
            out = subprocess.check_output([lsof, "-ti", f"tcp:{DSH_PORT}"], text=True, stderr=subprocess.DEVNULL).strip()
            for s in out.splitlines():
                if s.strip().isdigit():
                    pids.add(int(s.strip()))
        except subprocess.CalledProcessError:
            pass
    stopped = []
    for pid in pids:
        if pid == os.getpid():
            continue
        try:
            os.kill(pid, signal_mod.SIGTERM)
        except (ProcessLookupError, PermissionError):
            continue
        # 先给优雅退出机会（SIGTERM 后轮询），超时才补 SIGKILL
        for _ in range(10):
            time.sleep(0.2)
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            except PermissionError:
                break
        else:
            try:
                os.kill(pid, signal_mod.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        stopped.append(pid)
    PID_FILE.unlink(missing_ok=True)
    for _ in range(10):
        try:
            with socket.create_connection((HOST, DSH_PORT), timeout=0.3):
                time.sleep(0.3)
        except OSError:
            break
    # 凭据代理随控制中心常驻（2026-10-26）：停 DSH 不再回收代理，
    # 下次启动 DSH 直接复用（同端口同 token，旧 DSH 配置无需重写也有效）
    return {"ok": True, "message": f"已停止 ({stopped or '无进程'})"}
