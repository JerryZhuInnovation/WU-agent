#!/bin/bash
# WU ai — 双击启动（macOS / Linux 桌面）
# 环境锁定：仅需 Python 3.10+（纯标准库，无第三方依赖）；不做任何全局安装。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[WU ai] 未找到 python3：请安装 Python 3.10+（https://www.python.org/downloads/）" >&2
  exit 1
fi

if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "[WU ai] Python 版本过低：本工程要求 3.10+，当前 $(python3 -V 2>&1)" >&2
  exit 1
fi

# openssl 用于 API Key 加密存储（core/keystore）：缺失只降级该功能，不阻止启动
if ! command -v openssl >/dev/null 2>&1; then
  echo "[WU ai] 警告：未找到 openssl，API Key 加密存储不可用（其余功能正常）" >&2
fi

exec python3 start.py
