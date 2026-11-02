"""WU ai 密钥库：API Key 加密静态存储（V1 安全层）。

设计要点（安全 P0）：
- config.json 不再保存明文 apiKey，只保存引用 {"apiKeySecret": {"id": "<模型id>"}}；
  明文迁入 data/secrets.json，用 AES-256-CBC 加密（openssl CLI，PBKDF2 20 万轮）。
- 加密密钥是启动时生成的随机 hex（~/.wu-ai/.secret，0600），机器本地唯一；
  与 secrets.json 分离存储——单独拿到任一文件都无法解出明文。
- 不引入第三方 Python 依赖：直接调用 macOS/Linux 自带的 openssl。
  密钥经环境变量传给子进程（不出现于命令行参数，避免 ps 泄露明文口令）。
- 双进程安全：写盘走「临时文件 + rename」原子替换。
- 传输层脱敏：所有 API 出站只给 mask_key() 后的形态；完整明文只在
  内存（写 DSH credentials / 启动环境变量）中出现。
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path

from core.paths import DATA, KEYSTORE_SECRET

DEFAULT_KEY_FILE = KEYSTORE_SECRET
DEFAULT_STORE_FILE = DATA / "secrets.json"

_STORE_SCHEMA = 1
_PBKDF2_ITERS = 200000


class KeystoreError(RuntimeError):
    pass


def _run_openssl(args: list, passphrase: str, data: bytes | None) -> bytes:
    """执行 openssl enc；口令经环境变量传递，不出现在 ps 命令行。"""
    env = os.environ.copy()
    env["WUAI_KS_PASS"] = passphrase
    try:
        proc = subprocess.run(
            ["openssl", "enc", *args, "-pbkdf2", "-iter", str(_PBKDF2_ITERS),
             "-md", "sha256", "-pass", "env:WUAI_KS_PASS", "-A", "-base64"],
            input=data, env=env, capture_output=True, timeout=30,
        )
    except FileNotFoundError:
        raise KeystoreError("系统缺少 openssl，无法启用密钥加密") from None
    except subprocess.TimeoutExpired:
        raise KeystoreError("openssl 执行超时") from None
    if proc.returncode != 0:
        tail = (proc.stderr or b"").decode("utf-8", "replace").strip()[-200:]
        raise KeystoreError(f"openssl 失败: {tail or '未知错误'}")
    return proc.stdout


def _gen_key() -> str:
    try:
        proc = subprocess.run(
            ["openssl", "rand", "-hex", "32"], capture_output=True, timeout=15
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        raise KeystoreError(f"无法生成密钥: {e}") from None
    if proc.returncode != 0:
        raise KeystoreError("openssl rand 失败")
    return proc.stdout.decode("ascii").strip()


class Keystore:
    """加密密钥库。key_file / store_file 可注入（测试用临时目录）。"""

    def __init__(self, key_file: Path | None = None, store_file: Path | None = None):
        self.key_file = Path(key_file) if key_file else DEFAULT_KEY_FILE
        self.store_file = Path(store_file) if store_file else DEFAULT_STORE_FILE
        self._pass: str | None = None
        # ThreadingHTTPServer 多请求线程并发 save_config：读-改-写必须互斥，否则丢条目
        self._lock = threading.Lock()

    # ------------------------------------------------------------ 可用性

    def available(self) -> bool:
        try:
            self._passphrase()
            return True
        except KeystoreError:
            return False

    # ------------------------------------------------------------ 内部

    def _passphrase(self) -> str:
        if self._pass is not None:
            return self._pass
        if not self.key_file.is_file():
            try:
                self.key_file.parent.mkdir(parents=True, exist_ok=True)
                key = _gen_key()
                self.key_file.write_text(key + "\n", encoding="utf-8")
                self.key_file.chmod(0o600)
            except OSError as e:
                raise KeystoreError(f"密钥文件不可写: {e}") from None
        text = self.key_file.read_text(encoding="utf-8").strip()
        if not text:
            raise KeystoreError("密钥文件为空")
        self._pass = text
        return text

    def _load_store(self) -> dict:
        if not self.store_file.is_file():
            return {"schemaVersion": _STORE_SCHEMA, "secrets": {}}
        try:
            data = json.loads(self.store_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise KeystoreError(f"密库文件损坏: {e}") from None
        if not isinstance(data, dict) or not isinstance(data.get("secrets"), dict):
            raise KeystoreError("密库结构异常")
        return data

    def _write_store(self, data: dict) -> None:
        self.store_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.store_file.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        tmp.replace(self.store_file)

    # ------------------------------------------------------------ 增删查

    def put(self, sid: str, plaintext: str) -> None:
        """加密写入一个密钥；sid 为空或明文为空时忽略。"""
        if not sid or not plaintext:
            return
        ct = _run_openssl(["-aes-256-cbc"], self._passphrase(), plaintext.encode("utf-8"))
        with self._lock:
            data = self._load_store()
            data["secrets"][sid] = {
                "v": 1,
                "alg": "aes-256-cbc-ossl-pbkdf2",
                "ct": ct.decode("ascii").strip(),
            }
            self._write_store(data)

    def get(self, sid: str) -> str | None:
        """解密读出；密文损坏/口令不符时返回 None（不抛，由上层降级）。"""
        data = self._load_store()
        rec = data.get("secrets", {}).get(sid)
        if not isinstance(rec, dict) or not rec.get("ct"):
            return None
        try:
            raw = _run_openssl(
                ["-d", "-aes-256-cbc"], self._passphrase(),
                rec["ct"].encode("ascii"),
            )
        except KeystoreError:
            return None
        return raw.decode("utf-8")

    def delete(self, sid: str) -> None:
        with self._lock:
            data = self._load_store()
            if sid in data.get("secrets", {}):
                del data["secrets"][sid]
                self._write_store(data)

    def ids(self) -> list:
        return sorted(self._load_store().get("secrets", {}).keys())


_default: Keystore | None = None


def default_keystore() -> Keystore:
    global _default
    if _default is None:
        _default = Keystore()
    return _default


def mask_key(key: str) -> str:
    """出站脱敏：仅暴露首尾各 4 位，短密钥给更短的脱敏形态。"""
    if not key:
        return ""
    if len(key) <= 8:
        return key[:2] + "…" + ("*" * max(0, len(key) - 2))
    return key[:4] + "…" + key[-4:]