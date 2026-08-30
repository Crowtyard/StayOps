# -*- coding: utf-8 -*-
"""FakeDeepSeekClient（Sprint 9 §33/§34）。

pytest 不依赖真实 DeepSeek API：脚本化（script）确定性返回：
- final answer / SQL tool call / analytics tool call
- malformed response / timeout / auth error / rate limited / provider unavailable

通过 AIManagerService(client_factory=...) 注入；HTTP 映射层另有
httpx.MockTransport 单测（test_deepseek_client.py）。
"""

import json

from app.services.deepseek import AIError, DeepSeekResponse

DEFAULT_USAGE = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}


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


def error_step(code: str, http_status: int = 502) -> dict:
    return {"kind": "error", "code": code, "http_status": http_status}
