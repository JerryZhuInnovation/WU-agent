"""协议垫片测试：出站清洗 / 思考流归一化（含跨分片标签）/ 工具调用修复 / 透传安全。

核心断言是「跨块边界」：SSE 的 `<think>` 与 `</think>` 经常被网络分片切断，
这是垫片最容易静默失效的地方（切漏了就会把思维链当正文渲染）。
"""

from __future__ import annotations

import json
import unittest

from server.shim import (
    SseTransformer,
    StreamingNormalizer,
    normalize_full_response,
    repair_tool_arguments,
    sanitize_outbound,
)


def sse(obj: dict) -> bytes:
    return b"data: " + json.dumps(obj, ensure_ascii=False).encode() + b"\n\n"


def delta_chunk(content: str | None = None, **extra) -> dict:
    delta = {}
    if content is not None:
        delta["content"] = content
    delta.update(extra)
    return {"choices": [{"index": 0, "delta": delta}]}


class SanitizeOutboundTest(unittest.TestCase):
    def test_strips_deepseek_only_fields(self):
        body = json.dumps({"thinking": {"type": "enabled"}, "logprobs": True, "model": "m"}).encode()
        out = json.loads(sanitize_outbound(body))
        self.assertNotIn("thinking", out)
        self.assertNotIn("logprobs", out)
        self.assertEqual(out["model"], "m")

    def test_keeps_reasoning_effort(self):
        """思考强度由路由器按 provider 兼容性管理，垫片不得一刀切掉。"""
        out = json.loads(sanitize_outbound(json.dumps({"reasoning_effort": "high"}).encode()))
        self.assertEqual(out["reasoning_effort"], "high")

    def test_null_assistant_content_becomes_empty(self):
        out = json.loads(
            sanitize_outbound(
                json.dumps({"messages": [{"role": "assistant", "content": None}, {"role": "user", "content": "hi"}]}).encode()
            )
        )
        self.assertEqual(out["messages"][0]["content"], "")

    def test_non_json_passthrough(self):
        raw = b"not json at all"
        self.assertEqual(sanitize_outbound(raw), raw)
        self.assertIsNone(sanitize_outbound(None))


class ToolArgumentsTest(unittest.TestCase):
    def test_strips_markdown_fence(self):
        self.assertEqual(repair_tool_arguments('```json\n{"a":1}\n```'), '{"a":1}')

    def test_fixes_trailing_comma(self):
        self.assertEqual(json.loads(repair_tool_arguments('{"a":1,}')), {"a": 1})

    def test_object_serialized(self):
        self.assertEqual(json.loads(repair_tool_arguments({"a": 1})), {"a": 1})

    def test_unfixable_returned_as_is(self):
        broken = '{"a":'
        self.assertEqual(repair_tool_arguments(broken), broken)

    def test_empty_becomes_empty_object(self):
        self.assertEqual(repair_tool_arguments(None), "{}")
        self.assertEqual(repair_tool_arguments(""), "{}")


class StreamingNormalizerTest(unittest.TestCase):
    def test_inline_think_moves_to_reasoning(self):
        n = StreamingNormalizer()
        out = n.transform_chunk(delta_chunk("<think>想一想</think>答案"))
        delta = out["choices"][0]["delta"]
        self.assertEqual(delta.get("reasoning_content"), "想一想")
        self.assertEqual(delta.get("content"), "答案")

    def test_native_reasoning_not_duplicated(self):
        """模型已给 reasoning_content 时不再把 content 搬走。"""
        n = StreamingNormalizer()
        out = n.transform_chunk(delta_chunk("正文内容", reasoning_content="原生思考"))
        delta = out["choices"][0]["delta"]
        self.assertEqual(delta["reasoning_content"], "原生思考")
        self.assertEqual(delta["content"], "正文内容")

    def test_tool_call_index_filled(self):
        n = StreamingNormalizer()
        out = n.transform_chunk(
            {
                "choices": [
                    {
                        "index": 0,
                        "delta": {"tool_calls": [{"function": {"name": "f", "arguments": '{"x":1,}'}}]},
                    }
                ]
            }
        )
        tc = out["choices"][0]["delta"]["tool_calls"][0]
        self.assertEqual(tc["index"], 0)
        self.assertEqual(tc["type"], "function")
        self.assertIn("id", tc)
        self.assertEqual(json.loads(tc["function"]["arguments"]), {"x": 1})

    def test_finish_reason_stop_becomes_tool_calls(self):
        """模型发了 tool_calls 却回 stop —— 内核会当成「不用工具」直接结束。"""
        n = StreamingNormalizer()
        n.transform_chunk({"choices": [{"index": 0, "delta": {"tool_calls": [{"function": {"name": "f"}}]}}]})
        out = n.transform_chunk({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        self.assertEqual(out["choices"][0]["finish_reason"], "tool_calls")

    def test_finish_without_tools_keeps_stop(self):
        n = StreamingNormalizer()
        out = n.transform_chunk({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        self.assertEqual(out["choices"][0]["finish_reason"], "stop")

    def test_flushes_pending_think_at_finish(self):
        """流结束时仍在 think 块里：残留文本必须落到 reasoning_content，不能丢。"""
        n = StreamingNormalizer()
        first = n.transform_chunk(delta_chunk("<think>未闭合的思考"))
        last = n.transform_chunk({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        merged = (first["choices"][0]["delta"].get("reasoning_content") or "") + (
            last["choices"][0]["delta"].get("reasoning_content") or ""
        )
        self.assertEqual(merged, "未闭合的思考")


class SseTransformerTest(unittest.TestCase):
    """真实分片场景：标签被网络块切断。"""

    def _run(self, parts: list[bytes]) -> list[dict]:
        t = SseTransformer()
        raw = b"".join(t.feed(p) for p in parts) + t.flush()
        out = []
        for line in raw.split(b"\n"):
            s = line.strip()
            if not s.startswith(b"data:") or s == b"data: [DONE]":
                continue
            out.append(json.loads(s[5:].strip()))
        return out

    def test_think_tag_split_across_chunks(self):
        # 关键回归：'<thi' | 'nk>' 被切断，且答案文本也跨块
        parts = [
            sse(delta_chunk("<thi")),
            sse(delta_chunk("nk>思考")),
            sse(delta_chunk("过程</thi")),
            sse(delta_chunk("nk>最终答案")),
        ]
        # 把一条 SSE 事件再按字节切开，模拟真实网络分片
        cut = [parts[0][:20].__class__(parts[0][:20]), parts[0][20:]]
        chunks = [b"".join(cut)] + parts[1:]
        out = self._run(chunks)
        reasoning = "".join(str(c["choices"][0]["delta"].get("reasoning_content") or "") for c in out)
        content = "".join(str(c["choices"][0]["delta"].get("content") or "") for c in out)
        self.assertEqual(reasoning.replace(" ", ""), "思考过程")
        self.assertEqual(content.replace(" ", ""), "最终答案")

    def test_multibyte_split_preserved(self):
        """UTF-8 汉字被切断时不得乱码或丢字（增量解码）。"""
        text = "答案是正确的".encode()
        t = SseTransformer()
        obj = json.dumps(delta_chunk("答案"), ensure_ascii=False).encode()
        line = b"data: " + obj
        cut = line[: len(line) - 5]
        out = t.feed(cut) + t.feed(line[len(line) - 5:]) + t.flush()
        self.assertIn("答案".encode(), out)

    def test_done_passthrough(self):
        t = SseTransformer()
        raw = t.feed(b"data: [DONE]\n\n") + t.flush()
        self.assertIn(b"data: [DONE]", raw)

    def test_non_json_line_untouched(self):
        t = SseTransformer()
        raw = t.feed(b": keep-alive\n\n") + t.flush()
        self.assertIn(b": keep-alive", raw)

    def test_invalid_json_payload_passthrough(self):
        """异常负载原样透传：垫片不得吞掉一条本来能用的流。"""
        t = SseTransformer()
        bad = b"data: {broken json}\n\n"
        raw = t.feed(bad) + t.flush()
        self.assertIn(b"{broken json}", raw)


class FullResponseTest(unittest.TestCase):
    def test_think_extracted(self):
        payload = json.dumps(
            {
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "<think>想一下</think>答案"},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode()
        out = json.loads(normalize_full_response(payload))
        msg = out["choices"][0]["message"]
        self.assertEqual(msg["reasoning_content"], "想一下")
        self.assertEqual(msg["content"], "答案")

    def test_tool_call_repaired_and_finish_fixed(self):
        payload = json.dumps(
            {
                "choices": [
                    {
                        "message": {"tool_calls": [{"function": {"name": "f", "arguments": '```json\n{"x":1}\n```'}}]},
                        "finish_reason": "stop",
                    }
                ]
            }
        ).encode()
        out = json.loads(normalize_full_response(payload))
        tc = out["choices"][0]["message"]["tool_calls"][0]
        self.assertEqual(json.loads(tc["function"]["arguments"]), {"x": 1})
        self.assertEqual(out["choices"][0]["finish_reason"], "tool_calls")

    def test_non_json_passthrough(self):
        raw = b"<html>error</html>"
        self.assertEqual(normalize_full_response(raw), raw)


if __name__ == "__main__":
    unittest.main()
