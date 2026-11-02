#!/bin/bash
# wu-ai-ui 插件构建管道：类型检查 → tsdown → 注入构建戳 → 回灌 profile
# 用法：plugins/wu-ai-ui/build.sh   （仓库根或任意目录均可）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/plugins/wu-ai-ui"

# 便携 Node（跨平台：runtime/ 下任意 node-v*/bin，取版本最高者）；没有便携版就用系统 Node
NODEBIN="$(ls -d "$ROOT"/runtime/node-v*/bin 2>/dev/null | sort | tail -1)"
if [ -n "$NODEBIN" ]; then
  export PATH="$NODEBIN:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[build] 未找到 node：请先运行 start.command 安装便携 Node，或自行安装 Node 22+" >&2
  exit 1
fi

echo "── tsc"
npx tsc --noEmit --skipLibCheck --target es2022 --lib es2022,dom src/client.ts

echo "── tsdown"
npx tsdown >/dev/null

echo "── 注入构建戳"
STAMP="$(date +%Y%m%d%H%M%S)"
python3 - "$STAMP" <<'EOF'
import sys
p = 'dist/client.js'
s = open(p, encoding='utf-8').read()
n = s.count('__WU_BUILD__')
if n != 1:
    raise SystemExit(f'__WU_BUILD__ 占位符出现 {n} 次（应为 1），中止')
open(p, 'w', encoding='utf-8').write(s.replace('__WU_BUILD__', sys.argv[1]))
print('   build =', sys.argv[1])
EOF

echo "── 回灌 profile"
cd "$ROOT"
python3 - <<'EOF'
import sys
sys.path.insert(0, '.')
from dsh import adapter
from core.paths import DSH_HOME
adapter.sync_plugin_artifacts(DSH_HOME / 'profiles' / 'web', 'plugins/wu-ai-ui', log=print)
EOF

echo "── 完成（刷新浏览器页面生效；旧缓存页面会经构建戳自检自动 reload 一次）"
