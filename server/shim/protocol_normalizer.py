"""协议垫片（Protocol Shimming）——让 DSH 内核以为在和「标准模型」通信。

背景（2026-11-01）：本项目把**所有云端模型**的 baseURL 都指向本机凭据代理
（server/credential_proxy.py）。这就是天然的、零侵入的协议边界：DSH 与
node_modules 一行不改（不改内核、不随 npm update 失效），全部在代理里做
「向外清洗、向内归一化」。

解决的三个真实排异点：
1. 出站 400：部分第三方网关拒绝 DeepSeek 专属字段 / assistant 消息 content=null;
2. 入站思考流：有的模型把思维链内嵌在正文 ``<think>…</think>``（或
   ``<thinking>``），而内核只认 ``delta.reasoning_content`` —— 不归一化就会
   把思维链当正文渲染，或判定「没有思考」；
3. 工具调用：``tool_calls[].function.arguments`` 被包 ```json``` 或带尾逗号时
   内核 JSON.parse 会崩，且部分模型 ``finish_reason`` 只回 ``stop`` —— 内核
   据此不执行工具（表现为「模型没干活」，被错记成能力缺陷）。

铁律：垫片是减震器，不是新的单点故障 —— 任何解析失败都原样透传。
"""

from __future__ import annotations

import codecs
import json
import re

# DeepSeek 专属、第三方网关可能拒收的字段。
# 保留 reasoning_effort：它由路由器按 provider 兼容性管理（有剥离重试），
# 一刀切会把「思考强度」这个正常功能也关掉。
_DROP_FIELDS = ("thinking", "logprobs", "top_logprobs")

_THINK_TAG_RE = re.compile(r"<think(?:ing)?>([\s\S]*?)</think(?:ing)?>", re.IGNORECASE)
_OPEN_TAGS = ("<think>", "<thinking>")
_CLOSE_TAGS = ("</think>", "</thinking>")

_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*", re.IGNORECASE)


# ---------------------------------------------------------------- 出站清洗


def sanitize_outbound(body: bytes | None) -> bytes | None:
    """清洗发往模型的请求体。非 JSON / 解析失败一律原样返回（不阻断请求）。"""
    if not body:
        return body
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    if not isinstance(data, dict):
        return body

    for field in _DROP_FIELDS:
        data.pop(field, None)

    # 部分模型不接受 assistant 消息 content 为 null（多轮工具调用历史里常见）
    msgs = data.get("messages")
    if isinstance(msgs, list):
        for m in msgs:
            if isinstance(m, dict) and m.get("role") == "assistant" and m.get("content") is None:
                m["content"] = ""
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


# ---------------------------------------------------------------- 工具调用修复


def repair_tool_arguments(raw) -> str:
    """把工具参数修成合法 JSON 字符串；修不动就原样返回（交给上层重试）。"""
    if raw is None or raw == "":
        return "{}"
    if isinstance(raw, dict):
        return json.dumps(raw, ensure_ascii=False)
    s = str(raw).strip()
    s = _JSON_FENCE_RE.sub("", s)
    if s.endswith("```"):
        s = s[:-3].strip()
    try:
        json.loads(s)
        return s
    except ValueError:
        pass
    fixed = re.sub(r",\s*([}\]])", r"\1", s)  # 尾逗号
    try:
        json.loads(fixed)
        return fixed
    except ValueError:
        return s


def _normalize_tool_calls(msg: dict) -> bool:
    """补齐 index / type / id，修好 arguments。返回是否真的存在工具调用。"""
    calls = msg.get("tool_calls")
    if not isinstance(calls, list) or not calls:
        return False
    for i, tc in enumerate(calls):
        if not isinstance(tc, dict):
            continue
        tc.setdefault("index", i)
        tc.setdefault("type", "function")
        tc.setdefault("id", f"call_wu_{i}")
        fn = tc.get("function")
        if isinstance(fn, dict):
            fn["arguments"] = repair_tool_arguments(fn.get("arguments"))
    return True


# ---------------------------------------------------------------- 流式归一化


class _ThinkSplitter:
    """把正文里的思维链切出来（支持标签被 SSE 分片截断）。

    回退窗口按「最长后缀恰是标签前缀」精确计算，而不是固定 8 字符 ——
    固定窗口在短标签上白等、在长标签上漏切。
    """

    def __init__(self) -> None:
        self.in_think = False
        self.buf = ""

    def _hold(self, tags: tuple[str, ...]) -> int:
        n = min(max(len(t) for t in tags) - 1, len(self.buf))
        for k in range(n, 0, -1):
            tail = self.buf[-k:]
            if any(t.startswith(tail) for t in tags):
                return k
        return 0

    def feed(self, text: str) -> tuple[str, str]:
        self.buf += text
        content_parts: list[str] = []
        think_parts: list[str] = []
        while True:
            if not self.in_think:
                hit = _find_any(self.buf, _OPEN_TAGS)
                if hit is not None:
                    pos, tag = hit
                    content_parts.append(self.buf[:pos])
                    self.buf = self.buf[pos + len(tag):]
                    self.in_think = True
                    continue
                keep = self._hold(_OPEN_TAGS)
                if len(self.buf) > keep:
                    content_parts.append(self.buf[: len(self.buf) - keep])
                    self.buf = self.buf[len(self.buf) - keep:]
                break
            hit = _find_any(self.buf, _CLOSE_TAGS)
            if hit is not None:
                pos, tag = hit
                think_parts.append(self.buf[:pos])
                self.buf = self.buf[pos + len(tag):]
                self.in_think = False
                continue
            keep = self._hold(_CLOSE_TAGS)
            if len(self.buf) > keep:
                think_parts.append(self.buf[: len(self.buf) - keep])
                self.buf = self.buf[len(self.buf) - keep:]
            break
        return "".join(content_parts), "".join(think_parts)

    def flush(self) -> tuple[str, str]:
        rest, self.buf = self.buf, ""
        return ("", rest) if self.in_think else (rest, "")


def _find_any(text: str, tags: tuple[str, ...]) -> tuple[int, str] | None:
    best: tuple[int, str] | None = None
    for tag in tags:
        i = text.find(tag)
        if i >= 0 and (best is None or i < best[0]):
            best = (i, tag)
    return best


class StreamingNormalizer:
    """逐块归一流式 chunk。状态跨块，处理标签截断与工具调用收尾。"""

    def __init__(self) -> None:
        self.splitter = _ThinkSplitter()
        self.seen_tool_calls = False

    def transform_chunk(self, obj: dict) -> dict:
        if not isinstance(obj, dict):
            return obj
        choices = obj.get("choices")
        if not isinstance(choices, list) or not choices:
            return obj
        choice = choices[0]
        if not isinstance(choice, dict):
            return obj
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            delta = choice.get("message")
            if not isinstance(delta, dict):
                return obj

        # 1) 正文里的思维链 → reasoning_content（模型已给原生字段时不重复搬）
        if isinstance(delta.get("reasoning_content"), str):
            pass
        else:
            content = delta.get("content")
            if isinstance(content, str) and content:
                out_c, out_r = self.splitter.feed(content)
                if out_r:
                    delta["reasoning_content"] = out_r
                if out_c:
                    delta["content"] = out_c
                else:
                    delta.pop("content", None)

        # 2) tool_calls：补齐 index（内核聚合流时强依赖）
        if _normalize_tool_calls(delta):
            self.seen_tool_calls = True

        # 3) 收尾：冲刷残留 + 修正 finish_reason
        finish = choice.get("finish_reason")
        if finish:
            tail_c, tail_r = self.splitter.flush()
            if tail_r:
                delta["reasoning_content"] = (delta.get("reasoning_content") or "") + tail_r
            if tail_c:
                delta["content"] = (delta.get("content") or "") + tail_c
            if self.seen_tool_calls and finish == "stop":
                # 部分模型发了 tool_calls 却回 stop：内核会当成「不用工具」直接结束
                choice["finish_reason"] = "tool_calls"
        return obj


class SseTransformer:
    """SSE 行级转换器：只重写 `data:` 的 JSON 负载，其余原样透传。

    用增量 UTF-8 解码：网络块可能切断多字节汉字，按块直接 decode 会乱码。
    """

    def __init__(self) -> None:
        self._decoder = codecs.getincrementaldecoder("utf-8")("strict")
        self._line_buf = ""
        self._chunks = StreamingNormalizer()

    def feed(self, raw: bytes) -> bytes:
        try:
            text = self._decoder.decode(raw)
        except UnicodeDecodeError:
            return raw  # 编码异常：原样放行，不吞内容
        self._line_buf += text
        lines = self._line_buf.split("\n")
        self._line_buf = lines.pop()
        return b"".join(self._transform_line(line) + b"\n" for line in lines)

    def flush(self) -> bytes:
        out = b""
        if self._line_buf:
            out += self._transform_line(self._line_buf) + b"\n"
            self._line_buf = ""
        try:
            rest = self._decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            rest = ""
        if rest:
            out += rest.encode("utf-8")
        return out

    def _transform_line(self, line: str) -> bytes:
        trimmed = line.strip()
        if not trimmed.startswith("data:"):
            return line.encode("utf-8")
        payload = trimmed[5:].strip()
        if payload == "[DONE]" or not payload:
            return line.encode("utf-8")
        try:
            obj = json.loads(payload)
        except ValueError:
            return line.encode("utf-8")  # 非 JSON：保持原样
        try:
            obj = self._chunks.transform_chunk(obj)
            return b"data: " + json.dumps(obj, ensure_ascii=False).encode("utf-8")
        except Exception:
            return line.encode("utf-8")


def normalize_full_response(data: bytes) -> bytes:
    """非流式响应归一化（JSON 解析失败原样返回）。"""
    try:
        obj = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        return data
    if not isinstance(obj, dict):
        return data
    choices = obj.get("choices")
    if not isinstance(choices, list):
        return data
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        msg = choice.get("message")
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, str) and content and not isinstance(msg.get("reasoning_content"), str):
            m = _THINK_TAG_RE.search(content)
            if m:
                msg["reasoning_content"] = m.group(1).strip()
                msg["content"] = _THINK_TAG_RE.sub("", content).strip()
        if _normalize_tool_calls(msg) and choice.get("finish_reason") == "stop":
            choice["finish_reason"] = "tool_calls"
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")
