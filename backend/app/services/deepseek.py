"""DeepSeek Client（Sprint 9 §6/§7，Alpha.9 唯一 Provider）。

- 集中封装 chat request / tool calling / timeout / HTTP error mapping /
  malformed response / token usage；禁止在多个 route/service 内散落
  raw HTTP DeepSeek calls。
- 不建立复杂 Multi-provider Framework（Alpha.9：DeepSeek only）。
- Provider 失败只影响 /ai-manager：全部映射为 AIError(code)，由路由层
  转业务错误（AI_NOT_CONFIGURED / AI_AUTH_FAILED / AI_RATE_LIMITED /
  AI_PROVIDER_UNAVAILABLE / AI_TIMEOUT / AI_RESPONSE_INVALID）。
- 日志只记录 provider / model / latency_ms / HTTP status / tool 信息 /
  success（§35），绝不记录 API Key / Authorization header / 请求内容。
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import httpx

from app.config import settings

logger = logging.getLogger("stayops.ai.deepseek")

# 业务错误码（§7）
AI_NOT_CONFIGURED = "AI_NOT_CONFIGURED"
AI_AUTH_FAILED = "AI_AUTH_FAILED"
AI_RATE_LIMITED = "AI_RATE_LIMITED"
AI_PROVIDER_UNAVAILABLE = "AI_PROVIDER_UNAVAILABLE"
AI_TIMEOUT = "AI_TIMEOUT"
AI_RESPONSE_INVALID = "AI_RESPONSE_INVALID"
AI_TOOL_ROUNDS_EXCEEDED = "AI_TOOL_ROUNDS_EXCEEDED"


class AIError(Exception):
    """AI Provider/配置业务错误。code 为 §7 固定业务码；http_status 供路由映射。"""

    def __init__(self, code: str, message: str, http_status: int = 502):
        super().__init__(message)
        self.code = code
        self.http_status = http_status


@dataclass
class DeepSeekResponse:
    content: str | None
    tool_calls: list[dict] = field(default_factory=list)
    model: str | None = None
    usage: dict | None = None
    latency_ms: int | None = None


class DeepSeekClient:
    """DeepSeek Chat Completions 客户端（OpenAI 兼容接口）。"""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str | None = None,
        model: str | None = None,
        timeout_seconds: int | None = None,
        transport: httpx.BaseTransport | None = None,
    ):
        self.api_key = api_key
        self.base_url = (base_url or settings.deepseek_api_base_url).rstrip("/")
        self.model = model or settings.deepseek_default_model
        self.timeout_seconds = timeout_seconds or settings.deepseek_request_timeout_seconds
        # 仅测试注入（httpx.MockTransport）；生产为 None
        self._transport = transport

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
    ) -> DeepSeekResponse:
        """一次 chat completion 请求（可能携带 tool_calls）。

        异常统一抛 AIError；成功返回 DeepSeekResponse（含 usage / latency）。
        """
        payload: dict = {
            "model": self.model,
            "messages": messages,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools

        url = f"{self.base_url}/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        started = time.monotonic()
        try:
            if self._transport is not None:
                with httpx.Client(transport=self._transport, timeout=httpx.Timeout(self.timeout_seconds)) as client:
                    resp = client.post(url, headers=headers, json=payload)
            else:
                resp = httpx.post(
                    url,
                    headers=headers,
                    json=payload,
                    timeout=httpx.Timeout(self.timeout_seconds),
                )
        except httpx.TimeoutException as exc:
            raise AIError(
                AI_TIMEOUT,
                f"DeepSeek 请求超时（{self.timeout_seconds}s）",
            ) from exc
        except httpx.HTTPError as exc:
            raise AIError(
                AI_PROVIDER_UNAVAILABLE,
                "DeepSeek 服务暂时不可用（网络错误）",
            ) from exc

        latency_ms = int((time.monotonic() - started) * 1000)
        status = resp.status_code

        try:
            data = resp.json()
        except ValueError as exc:
            self._log(status, latency_ms, success=False, detail="malformed-json")
            raise AIError(
                AI_RESPONSE_INVALID, "DeepSeek 返回了无法解析的响应"
            ) from exc

        if status in (401, 403):
            self._log(status, latency_ms, success=False, detail="auth")
            raise AIError(AI_AUTH_FAILED, "DeepSeek API Key 无效或没有访问权限")
        if status == 402:
            self._log(status, latency_ms, success=False, detail="payment")
            raise AIError(AI_AUTH_FAILED, "DeepSeek 账户存在计费/配额问题")
        if status == 429:
            self._log(status, latency_ms, success=False, detail="rate-limited")
            raise AIError(AI_RATE_LIMITED, "DeepSeek 请求频率超限（429），请稍后重试")
        if status >= 500:
            self._log(status, latency_ms, success=False, detail="provider-5xx")
            raise AIError(
                AI_PROVIDER_UNAVAILABLE, "DeepSeek 服务暂时不可用（5xx）"
            )
        if status != 200:
            self._log(status, latency_ms, success=False, detail=f"http-{status}")
            raise AIError(
                AI_PROVIDER_UNAVAILABLE,
                f"DeepSeek 请求失败（HTTP {status}）",
            )

        # ------------------------------------------------------------------
        # Provider 响应解析边界（§6/§7，Kun Fast QA Blocking Defect 修复）：
        # DeepSeek 返回 JSON 成功 ≠ JSON 内部结构可信 —— Provider output 是
        # 不可信外部输入。以下对 message / tool_calls / tool_call item /
        # function / tool name / arguments 做显式结构验证，任何结构异常统一
        # 安全映射 AI_RESPONSE_INVALID；禁止 AttributeError / TypeError /
        # KeyError 等解析实现细节逃逸到路由层（绝不 generic 500）。
        # 注意：本边界只做结构校验，不吞掉已正确映射的 AI_AUTH_FAILED /
        # AI_RATE_LIMITED / AI_PROVIDER_UNAVAILABLE / AI_TIMEOUT。
        # ------------------------------------------------------------------
        if not isinstance(data, dict):
            self._log(status, latency_ms, success=False, detail="response-not-object")
            raise AIError(
                AI_RESPONSE_INVALID, "DeepSeek 响应结构异常：顶层不是对象"
            )

        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            self._log(status, latency_ms, success=False, detail="no-choices")
            raise AIError(AI_RESPONSE_INVALID, "DeepSeek 响应缺少 choices")

        choice = choices[0]
        if not isinstance(choice, dict):
            self._log(status, latency_ms, success=False, detail="choice-not-object")
            raise AIError(
                AI_RESPONSE_INVALID, "DeepSeek 响应结构异常：choice 不是对象"
            )

        message = choice.get("message")
        if message is None:
            message = {}
        elif not isinstance(message, dict):
            self._log(status, latency_ms, success=False, detail="message-not-object")
            raise AIError(
                AI_RESPONSE_INVALID, "DeepSeek 响应结构异常：message 不是对象"
            )

        content = message.get("content")
        if content is not None and not isinstance(content, str):
            self._log(status, latency_ms, success=False, detail="content-type-invalid")
            raise AIError(
                AI_RESPONSE_INVALID, "DeepSeek 响应结构异常：content 类型无效"
            )

        tool_calls: list[dict] = []
        raw_tool_calls = message.get("tool_calls")
        if raw_tool_calls is not None:
            if not isinstance(raw_tool_calls, list):
                self._log(
                    status, latency_ms, success=False, detail="tool-calls-not-list"
                )
                raise AIError(
                    AI_RESPONSE_INVALID,
                    "DeepSeek 响应结构异常：tool_calls 不是数组",
                )
            for raw in raw_tool_calls:
                if not isinstance(raw, dict):
                    self._log(
                        status, latency_ms, success=False, detail="tool-call-not-object"
                    )
                    raise AIError(
                        AI_RESPONSE_INVALID,
                        "DeepSeek 响应结构异常：tool_call 项不是对象",
                    )
                fn = raw.get("function")
                if not isinstance(fn, dict):
                    self._log(
                        status, latency_ms, success=False, detail="function-not-object"
                    )
                    raise AIError(
                        AI_RESPONSE_INVALID,
                        "DeepSeek 响应结构异常：function 不是对象",
                    )
                name = fn.get("name")
                if not isinstance(name, str) or not name:
                    self._log(
                        status, latency_ms, success=False, detail="tool-name-invalid"
                    )
                    raise AIError(
                        AI_RESPONSE_INVALID,
                        "DeepSeek 响应结构异常：function.name 缺失或类型无效",
                    )
                arguments = fn.get("arguments")
                if arguments is None:
                    arguments = "{}"
                elif not isinstance(arguments, (str, dict)):
                    # 现有 parser contract（ai_tools._parse_arguments）接受
                    # JSON 字符串或 dict；其它类型视为结构异常
                    self._log(
                        status,
                        latency_ms,
                        success=False,
                        detail="tool-arguments-invalid",
                    )
                    raise AIError(
                        AI_RESPONSE_INVALID,
                        "DeepSeek 响应结构异常：function.arguments 类型无效",
                    )
                tool_calls.append(
                    {
                        "id": raw.get("id") or f"call_{len(tool_calls)}",
                        "name": name,
                        "arguments": arguments,
                    }
                )

        usage = data.get("usage")
        if isinstance(usage, dict):
            usage = {
                key: usage.get(key)
                for key in ("prompt_tokens", "completion_tokens", "total_tokens")
                if usage.get(key) is not None
            }
            if not usage:
                usage = None
        else:
            usage = None

        self._log(
            status,
            latency_ms,
            success=True,
            tool_calls=len(tool_calls),
            content_chars=len(content) if content else 0,
        )
        return DeepSeekResponse(
            content=content,
            tool_calls=tool_calls,
            model=data.get("model") or self.model,
            usage=usage,
            latency_ms=latency_ms,
        )

    def test_connection(self) -> dict:
        """连接测试（§28/§34）：最小 chat 请求，返回 ok / model / latency_ms。"""
        resp = self.chat([{"role": "user", "content": "只回复 OK"}])
        return {
            "ok": True,
            "model": resp.model,
            "latency_ms": resp.latency_ms,
            "usage": resp.usage,
        }

    # ------------------------------------------------------------------
    # 日志（§35：绝不记录 API Key / Authorization header / 请求内容）
    # ------------------------------------------------------------------
    def _log(
        self,
        status: int,
        latency_ms: int,
        *,
        success: bool,
        detail: str = "",
        tool_calls: int = 0,
        content_chars: int = 0,
    ) -> None:
        logger.info(
            "deepseek provider=deepseek model=%s http_status=%s latency_ms=%s "
            "success=%s tool_calls=%s content_chars=%s detail=%s",
            self.model,
            status,
            latency_ms,
            success,
            tool_calls,
            content_chars,
            detail,
        )
