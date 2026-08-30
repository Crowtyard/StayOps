# -*- coding: utf-8 -*-
"""FakeDeepSeekClient（Sprint 9 §33/§34 + Real Provider Hotfix）。

pytest 不依赖真实 DeepSeek API：脚本化（script）确定性返回：
- final answer / SQL tool call / analytics tool call
- malformed response / timeout / auth error / rate limited / provider unavailable

通过 AIManagerService(client_factory=...) 注入；HTTP 映射层另有
httpx.MockTransport 单测（test_deepseek_client.py）。

Strict Protocol（Hotfix，锁定真实事故“Fake PASS / Real Provider FAIL”）：
- chat() 收到 role=tool 消息时，必须验证前面存在 assistant(tool_calls) 回显，
  且每个 tool 消息的 tool_call_id 与回显 ids 完全匹配、每轮
  assistant(tool_calls) 与后续 tool 消息一一对应；
- 回显中每个 tool_call 必须符合 wire contract
  （id / type=function / function.name=str / function.arguments=str）；
- 协议不符合 -> 抛 ProtocolViolationError（测试立即失败）。
"""

import json

from app.services.deepseek import AIError, DeepSeekResponse

DEFAULT_USAGE = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}


class ProtocolViolationError(AssertionError):
    """Strict Fake：Provider Tool Calling 协议不符合（模拟 DeepSeek 400 语义）。"""


def validate_tool_protocol(messages: list[dict]) -> None:
    """严格校验工具循环消息序列（Hotfix §4/§5）。

    要求：
    1) 存在 role=tool 消息时，其前面必须有带 tool_calls 的 assistant 消息；
    2) 每个 tool 消息的 tool_call_id 必须匹配其所属 assistant(tool_calls) 的 id；
    3) 每轮 assistant(tool_calls) 与其 tool 消息一一对应（不得“每个 tool call
       分别生成 assistant”）；
    4) assistant(tool_calls) 回显结构必须符合 wire contract。
    """
    assistant_tool_indices = [
        i
        for i, m in enumerate(messages)
        if m.get("role") == "assistant" and m.get("tool_calls")
    ]
    tool_indices = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
    if tool_indices and not assistant_tool_indices:
        raise ProtocolViolationError(
            "role=tool 消息前缺少 assistant(tool_calls) 回显（DeepSeek 会返回 400）"
        )

    # wire contract：回显结构验证
    for idx in assistant_tool_indices:
        tool_calls = messages[idx].get("tool_calls")
        if not isinstance(tool_calls, list) or not tool_calls:
            raise ProtocolViolationError("assistant(tool_calls) 必须为非空数组")
        for tc in tool_calls:
            if not isinstance(tc, dict):
                raise ProtocolViolationError("tool_calls 项必须为对象")
            if not isinstance(tc.get("id"), str) or not tc["id"]:
                raise ProtocolViolationError("tool_call.id 缺失或非字符串")
            if tc.get("type") != "function":
                raise ProtocolViolationError("tool_call.type 必须为 function")
            fn = tc.get("function")
            if not isinstance(fn, dict):
                raise ProtocolViolationError("tool_call.function 必须为对象")
            if not isinstance(fn.get("name"), str) or not fn["name"]:
                raise ProtocolViolationError("function.name 缺失或非字符串")
            if not isinstance(fn.get("arguments"), str):
                raise ProtocolViolationError(
                    "function.arguments 必须是 JSON string（wire contract）"
                )

    # 每个 tool 消息必须匹配其之前最近的 assistant(tool_calls)
    for ti in tool_indices:
        prev = [i for i in assistant_tool_indices if i < ti]
        if not prev:
            raise ProtocolViolationError("role=tool 消息前缺少 assistant(tool_calls)")
        assistant = messages[prev[-1]]
        ids = {tc.get("id") for tc in assistant.get("tool_calls", [])}
        if messages[ti].get("tool_call_id") not in ids:
            raise ProtocolViolationError(
                f"tool_call_id {messages[ti].get('tool_call_id')!r} "
                "与 assistant(tool_calls) 回显不匹配"
            )

    # 每轮 assistant(tool_calls) 与其 tool 消息一一对应（禁止逐 call 生成 assistant）
    for pos, ai in enumerate(assistant_tool_indices):
        next_ai = (
            assistant_tool_indices[pos + 1]
            if pos + 1 < len(assistant_tool_indices)
            else len(messages)
        )
        expected_ids = {tc.get("id") for tc in messages[ai].get("tool_calls", [])}
        seen = {
            messages[j].get("tool_call_id")
            for j in range(ai + 1, next_ai)
            if messages[j].get("role") == "tool"
        }
        if seen != expected_ids:
            raise ProtocolViolationError(
                f"assistant(tool_calls) 与后续 role=tool 消息不一一对应："
                f"expected={expected_ids} got={seen}"
            )


class FakeDeepSeekClient:
    """确定性 Fake Provider：每次 chat() 从 script 取下一步行为。

    shared=True 时所有客户端共享同一个 script 队列（模拟一次对话中的
    多轮工具循环：每一步只消费一次）。
    """

    def __init__(
        self,
        *,
        api_key: str,
        model: str | None = None,
        base_url: str | None = None,
        timeout_seconds: int | None = None,
        script: list[dict] | None = None,
        shared: bool = False,
    ):
        self.api_key = api_key
        self.model = model or "deepseek-chat"
        self.base_url = base_url
        self.timeout_seconds = timeout_seconds
        self.script: list[dict] = script if shared else list(script or [])
        self.calls: list[dict] = []  # 每次 chat 的入参（供断言上下文窗口等）

    def chat(self, messages: list[dict], tools: list[dict] | None = None) -> DeepSeekResponse:
        self.calls.append({"messages": messages, "tools": tools})
        # Strict Protocol：每次请求都校验工具循环消息序列（Hotfix 锁回归）
        validate_tool_protocol(messages)

        if self.script:
            step = self.script.pop(0)
        else:
            step = {"kind": "final", "content": "OK（Fake）"}

        kind = step.get("kind", "final")
        if kind == "error":
            raise AIError(
                step["code"],
                step.get("message", "fake provider error"),
                http_status=step.get("http_status", 502),
            )
        if kind == "tool_call":
            tool_calls = step.get("tool_calls") or [
                {
                    "name": step["name"],
                    "arguments": step.get("arguments", {}),
                }
            ]
            return DeepSeekResponse(
                content=None,
                tool_calls=[
                    {
                        "id": f"call_{idx}",
                        "name": tc["name"],
                        "arguments": (
                            tc["arguments"]
                            if isinstance(tc["arguments"], str)
                            else json.dumps(tc.get("arguments", {}), ensure_ascii=False)
                        ),
                    }
                    for idx, tc in enumerate(tool_calls)
                ],
                model=self.model,
                usage=dict(DEFAULT_USAGE),
            )
        content = step.get("content", "OK（Fake）")
        return DeepSeekResponse(
            content=content,
            model=self.model,
            usage=dict(DEFAULT_USAGE),
            latency_ms=step.get("latency_ms", 12),
        )

    def test_connection(self) -> dict:
        return self.chat([{"role": "user", "content": "只回复 OK"}]).__dict__ | {
            "ok": True
        }


def fake_client_factory(script: list[dict] | None = None):
    """构造 client_factory（与 default_client_factory 同签名）。"""

    def factory(api_key: str, model: str, base_url: str, timeout_seconds: int):
        return FakeDeepSeekClient(
            api_key=api_key,
            model=model,
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            script=script,
        )

    return factory


def final_step(content: str = "OK（Fake）") -> dict:
    return {"kind": "final", "content": content}


def tool_step(name: str, arguments: dict) -> dict:
    return {"kind": "tool_call", "name": name, "arguments": arguments}


def multi_tool_step(tool_calls: list[dict]) -> dict:
    """第一轮同时返回多个 tool_calls（Hotfix §5 Multi-tool Regression）。"""
    return {"kind": "tool_call", "tool_calls": tool_calls}


def error_step(code: str, http_status: int = 502) -> dict:
    return {"kind": "error", "code": code, "http_status": http_status}
