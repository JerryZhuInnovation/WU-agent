"""WU ai Local AI — 硬件检测 + llama.cpp 运行时管理。

不负责从 HuggingFace 拉模型权重；模型文件由用户本地提供。
"""

import os
import platform
import shutil
import subprocess
import zipfile
from pathlib import Path

from core.paths import RUNTIME

LLAMA_DIR = RUNTIME / "llama.cpp"


def detect_hardware() -> dict:
    """检测 OS / CPU / RAM / GPU 粗信息，用于选择 llama.cpp 构建与默认参数。"""
    system = platform.system().lower()  # darwin / linux / windows
    machine = platform.machine().lower()  # arm64 / x86_64 / amd64
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"

    ram_gb = _detect_ram_gb()
    gpu = _detect_gpu(system, machine)

    return {
        "system": system,
        "machine": machine,
        "arch": arch,
        "ramGb": ram_gb,
        "gpu": gpu,
        "recommendedBackend": _pick_backend(system, machine, gpu),
        "recommendedQuant": _pick_quant(ram_gb, gpu),
    }


def _detect_ram_gb() -> float | None:
    """系统内存（GB）；检测不到返回 None——宁可显示「?」，不编造数值。"""
    try:
        if platform.system() == "Darwin":
            out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip()
            return round(int(out) / (1024**3), 1)
        if platform.system() == "Linux":
            mem = Path("/proc/meminfo").read_text()
            for line in mem.splitlines():
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return round(kb / (1024**2), 1)
        if platform.system() == "Windows":
            out = subprocess.check_output(
                ["wmic", "ComputerSystem", "get", "TotalPhysicalMemory"], text=True
            )
            for line in out.splitlines():
                if line.strip().isdigit():
                    return round(int(line.strip()) / (1024**3), 1)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def _detect_gpu(system: str, machine: str):
    if system == "darwin" and machine in ("arm64", "aarch64"):
        return {"vendor": "apple", "metal": True, "vramGb": None}
    # NVIDIA via nvidia-smi
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
            vram_mb = int(out.splitlines()[0].strip())
            return {"vendor": "nvidia", "cuda": True, "vramGb": round(vram_mb / 1024, 1)}
        except Exception:
            pass
    return {"vendor": "none", "cuda": False, "metal": False, "vramGb": None}


def _pick_backend(system: str, machine: str, gpu: dict) -> str:
    if gpu.get("metal"):
        return "metal"
    if gpu.get("cuda"):
        return "cuda"
    if system == "linux":
        return "vulkan"  # llama.cpp 通用 Linux 回退
    return "cpu"


def _pick_quant(ram_gb: float | None, gpu: dict) -> str:
    vram = gpu.get("vramGb") or 0
    budget = min(ram_gb, vram) if (ram_gb and vram) else (ram_gb or vram)
    if budget is None:
        return "Q4_K_M"  # 内存与显存都测不到：给保守默认，不假装知道
    if budget >= 20:
        return "Q5_K_M"
    if budget >= 8:
        return "Q4_K_M"
    return "Q4_0"


def llama_cpp_release_tag() -> str:
    """当前使用的 llama.cpp 发布 tag（可改配置）。"""
    return os.environ.get("WUAI_LLAMA_TAG", "b4614")


def llama_cpp_download_url(hw: dict) -> str:
    """
    按平台给出 llama.cpp 预编译包 URL（GitHub Releases）。
    用户也可把二进制放到 runtime/llama.cpp/llama-server 手动跳过下载。
    """
    system = hw["system"]
    arch = hw["arch"]
    tag = llama_cpp_release_tag()
    base = f"https://github.com/ggml-org/llama.cpp/releases/download/{tag}"

    if system == "darwin":
        # Apple Silicon / Intel 统一 macOS 包
        return f"{base}/llama-{tag}-bin-macos-{arch}.zip"
    if system == "linux":
        if hw.get("gpu", {}).get("cuda"):
            return f"{base}/llama-{tag}-bin-ubuntu-x64.zip"
        return f"{base}/llama-{tag}-bin-ubuntu-{arch}.zip"
    if system == "windows":
        # llama.cpp 官方 Windows 包暂无独立 CUDA 构建，统一用 CPU 包
        return f"{base}/llama-{tag}-bin-win-cpu-x64.zip"
    raise RuntimeError(f"不支持的平台: {system}/{arch}")


def find_llama_server() -> str | None:
    """已安装的 llama-server 路径。"""
    candidates = [
        LLAMA_DIR / "llama-server",
        LLAMA_DIR / "llama-server.exe",
        LLAMA_DIR / "build" / "bin" / "llama-server",
        RUNTIME / "llama-server",
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    p = shutil.which("llama-server")
    if p:
        return p
    # 兜底：个别发行版把可执行文件命名为 llama.cpp
    return shutil.which("llama.cpp")


def ensure_llama_cpp(progress=None) -> dict:
    """
    确保 llama-server 可用。
    - 已有：直接返回
    - 否则：按硬件下载官方 release zip/tar 并解压到 runtime/llama.cpp
    返回 { path, url, downloaded }
    """
    existing = find_llama_server()
    if existing:
        return {"path": existing, "downloaded": False, "url": None}

    hw = detect_hardware()
    url = llama_cpp_download_url(hw)
    LLAMA_DIR.mkdir(parents=True, exist_ok=True)
    archive = RUNTIME / "llama-dist" / Path(url).name
    archive.parent.mkdir(parents=True, exist_ok=True)

    curl = shutil.which("curl")
    if not curl:
        raise RuntimeError("需要 curl 下载 llama.cpp")

    log_line = f"下载 llama.cpp: {url}"
    if progress:
        progress(log_line)
    proc = subprocess.run(
        [curl, "-L", "--fail", "--retry", "3", "-o", str(archive), url],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"llama.cpp 下载失败: {proc.stderr.strip()[:300]}")

    extract = RUNTIME / "llama-dist" / "extracted"
    if extract.exists():
        shutil.rmtree(extract)
    extract.mkdir(parents=True)
    if url.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(extract)
    else:
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(extract)], check=True, timeout=300)

    # 找到 llama-server 并复制到固定位置
    server = None
    for p in extract.rglob("llama-server*"):
        if p.is_file() and (os.access(p, os.X_OK) or p.suffix == ".exe"):
            server = p
            break
    if not server:
        for p in extract.rglob("*"):
            if p.is_file() and "llama-server" in p.name:
                server = p
                break
    if not server:
        raise RuntimeError("压缩包内未找到 llama-server，请手动放到 runtime/llama.cpp/")

    dest = LLAMA_DIR / ("llama-server.exe" if server.suffix == ".exe" else "llama-server")
    shutil.copy2(server, dest)
    dest.chmod(dest.stat().st_mode | 0o111)
    return {"path": str(dest), "downloaded": True, "url": url}
