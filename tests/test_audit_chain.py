"""审计哈希链的 Node/Python 跨语言一致性（P1-6）。

工作台展示的「链完好」必须与 router（Node）的写入算法逐位一致，否则校验
通过/失败都失去意义。这里用 Node 端 audit() 真实写入，Python 端
server.workspace._verify_audit_chain 校验；再验证篡改与删行都能被发现。

隔离：全部走显式临时路径。注意 core/paths.DSH_HOME 写死真实 home（不读
环境变量），任何测试都不得把数据写进 ~/.wu-ai/。
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.workspace import _tail_jsonl, _verify_audit_chain  # noqa: E402


def _node() -> str | None:
    for cand in sorted((ROOT / "runtime").glob("node-v*-*/bin/node")):
        if cand.is_file():
            return str(cand)
    return shutil.which("node")


NODE_WRITE = """
import {{ audit }} from './plugins/wu-ai-router/risk-review.js'
const home = {home}
audit(home, {{ tool: 'shell', decision: 'DENY', by: 'policy', reason: '测试拒绝·中文' }})
audit(home, {{ tool: 'write', decision: 'ALLOW', by: 'policy', confidence: 0.85, tainted: true }})
audit(home, {{ tool: 'shell', decision: 'ASK', by: 'taint', reason: '本会话读取过敏感内容（读密钥文件）' }})
"""


class AuditChainTest(unittest.TestCase):
    def setUp(self) -> None:
        self.node = _node()
        if not self.node:
            self.skipTest("未找到 Node")
        self.tmp = Path(tempfile.mkdtemp(prefix="wuai-chain-"))
        self.audit = self.tmp / "wu-ai-risk-audit.jsonl"

    def _node_write(self, home: Path) -> None:
        script = NODE_WRITE.format(home=json.dumps(str(home)))
        subprocess.run(
            [self.node, "--input-type=module", "-e", script],
            cwd=str(ROOT), capture_output=True, text=True, check=True,
        )

    def test_python_verifies_node_written_chain(self) -> None:
        self._node_write(self.tmp)
        res = _verify_audit_chain(_tail_jsonl(self.audit))
        self.assertEqual(res, {"ok": True, "checked": 3})

    def test_tampered_row_detected(self) -> None:
        self._node_write(self.tmp)
        lines = self.audit.read_text(encoding="utf-8").splitlines()
        rec = json.loads(lines[0])
        rec["decision"] = "ALLOW"  # 攻击者想要的效果：把 DENY 洗成 ALLOW
        lines[0] = json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
        self.audit.write_text("\n".join(lines) + "\n", encoding="utf-8")
        res = _verify_audit_chain(_tail_jsonl(self.audit))
        self.assertFalse(res["ok"])
        self.assertEqual(res["brokenAt"], 0)

    def test_deleted_row_detected(self) -> None:
        home = self.tmp / "home2"
        home.mkdir()
        self._node_write(home)
        target = home / "wu-ai-risk-audit.jsonl"
        rows = [l for l in target.read_text(encoding="utf-8").splitlines() if l]
        target.write_text("\n".join([rows[0], rows[2]]) + "\n", encoding="utf-8")  # 删中间行
        res = _verify_audit_chain(_tail_jsonl(target))
        self.assertFalse(res["ok"])

    def test_missing_file_is_ok(self) -> None:
        res = _verify_audit_chain(_tail_jsonl(self.tmp / "none.jsonl"))
        self.assertEqual(res, {"ok": True, "checked": 0})


if __name__ == "__main__":
    unittest.main()
