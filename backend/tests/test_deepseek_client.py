# -*- coding: utf-8 -*-
"""DeepSeek Client HTTP 映射测试（Sprint 9 §7/§33）。

用 httpx.MockTransport 确定性模拟 Provider：timeout / 401 / 402 / 429 / 5xx /
网络不可达 / malformed response / token usage，pytest 不依赖真实网络。
"""

import json

import httpx
import pytest

from app.services.deepseek import (
    AI_AUTH_FAILED,
    AI_PROVIDER_UNAVAILABLE,
    AI_RATE_LIMITED,
    AI_RESPONSE_INVALID,
    AI_TIMEOUT,
    AIError,
    DeepSeekClient,
)

API_KEY = "sk-test-key-1234"


def make_client(handler) -> DeepSeekClient:
    return DeepSeekClient(
        api_key=API_KEY,
        base_url="http://fake.local",
        model="deepseek-chat",
        transport=httpx.MockTransport(handler),
    )


def json_response(status: int, payload: dict) -> httpx.Response:
    return httpx.Response(status, json=payload)


def ok_payload(content: str = "你好", usage: dict | None = None) -> dict:
    payload = {
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "model": "deepseek-chat",
    }
    if usage is not None:
        payload["usage"] = usage
    return payload


def test_chat_ok_parses_content_and_usage():
    usage = {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}
    client = make_client(lambda req: json_response(200, ok_payload(usage=usage)))
    resp = client.chat([{"role": "user", "content": "hi"}])
    assert resp.content == "你好"
    assert resp.model == "deepseek-chat"
    assert resp.usage == usage
    assert resp.tool_calls == []
    assert resp.latency_ms is not None


def test_chat_ok_parses_tool_calls():
    def handler(req):
        payload = {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "get_analytics",
                                    "arguments": json.dumps({"endpoint": "overview"}),
                                },
                            }
                        ],
                    }
                }
            ],
            "model": "deepseek-chat",
            "usage": {"total_tokens": 8},
        }
        return json_response(200, payload)

    resp = make_client(handler).chat([{"role": "user", "content": "q"}])
    assert resp.content is None
    assert len(resp.tool_calls) == 1
    assert resp.tool_calls[0]["name"] == "get_analytics"
    assert json.loads(resp.tool_calls[0]["arguments"]) == {"endpoint": "overview"}


def test_chat_ok_without_usage():
    client = make_client(
        lambda req: json_response(200, ok_payload(usage={}))
    )
    resp = client.chat([{"role": "user", "content": "hi"}])
    assert resp.usage is None


def test_chat_ok_usage_none_key():
    payload = {
        "choices": [{"message": {"role": "assistant", "content": "hi"}}],
        "model": "deepseek-chat",
        "usage": None,
    }
    client = make_client(lambda req: json_response(200, payload))
    resp = client.chat([{"role": "user", "content": "hi"}])
    assert resp.usage is None


@pytest.mark.parametrize(
    ("status", "expected_code"),
    [
        (401, AI_AUTH_FAILED),
        (403, AI_AUTH_FAILED),
        (402, AI_AUTH_FAILED),
        (429, AI_RATE_LIMITED),
        (500, AI_PROVIDER_UNAVAILABLE),
        (503, AI_PROVIDER_UNAVAILABLE),
        (400, AI_PROVIDER_UNAVAILABLE),  # 未知模型等 Provider 错误
        (404, AI_PROVIDER_UNAVAILABLE),
    ],
)
def test_http_status_mapping(status, expected_code):
    client = make_client(lambda req: json_response(status, {"error": "boom"}))
    with pytest.raises(AIError) as excinfo:
        client.chat([{"role": "user", "content": "q"}])
    assert excinfo.value.code == expected_code


def test_malformed_json_body():
    client = make_client(lambda req: httpx.Response(200, text="not-json{{{"))
    with pytest.raises(AIError) as excinfo:
        client.chat([{"role": "user", "content": "q"}])
    assert excinfo.value.code == AI_RESPONSE_INVALID


def test_missing_choices():
    client = make_client(lambda req: json_response(200, {"model": "deepseek-chat"}))
    with pytest.raises(AIError) as excinfo:
        client.chat([{"role": "user", "content": "q"}])
    assert excinfo.value.code == AI_RESPONSE_INVALID


def test_timeout_mapping():
    def handler(req):
        raise httpx.ReadTimeout("timed out")

    client = make_client(handler)
    with pytest.raises(AIError) as excinfo:
        client.chat([{"role": "user", "content": "q"}])
    assert excinfo.value.code == AI_TIMEOUT


def test_network_error_mapping():
    def handler(req):
        raise httpx.ConnectError("connection refused")

    client = make_client(handler)
    with pytest.raises(AIError) as excinfo:
        client.chat([{"role": "user", "content": "q"}])
    assert excinfo.value.code == AI_PROVIDER_UNAVAILABLE


def test_request_carries_bearer_and_payload():
    captured = {}

    def handler(req):
        captured["headers"] = req.headers
        captured["body"] = json.loads(req.content)
        return json_response(200, ok_payload())

    client = make_client(handler)
    client.chat([{"role": "user", "content": "q"}], tools=[{"type": "function"}])
    assert captured["headers"]["authorization"] == f"Bearer {API_KEY}"
    assert captured["body"]["model"] == "deepseek-chat"
    assert captured["body"]["stream"] is False
    assert captured["body"]["tools"] == [{"type": "function"}]


def test_test_connection_ok():
    client = make_client(lambda req: json_response(200, ok_payload("OK")))
    result = client.test_connection()
    assert result["ok"] is True
    assert result["model"] == "deepseek-chat"
    assert result["latency_ms"] is not None


def test_error_does_not_leak_key_in_message():
    client = make_client(lambda req: json_response(401, {"error": "invalid key"}))
    with pytest.raises(AIError) as excinfo:
        client.chat([{"role": "user", "content": "q"}])
    assert API_KEY not in str(excinfo.value)


# ---------------------------------------------------------------------------
# Malformed tool_calls / message 结构（Kun Fast QA Blocking Defect 修复）：
# Provider output 是不可信外部输入 —— 任何结构异常必须映射 AI_RESPONSE_INVALID，
# 禁止 AttributeError / TypeError / KeyError 逃逸为 generic 500。
# ---------------------------------------------------------------------------


def _tool_call_payload(tool_calls) -> dict:
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": tool_calls,
                }
            }
        ],
        "model": "deepseek-chat",
        "usage": {"total_tokens": 8},
    }


def _expect_invalid(handler):
    client = make_client(handler)
    with pytest.raises(AIError) as excinfo:
        client.chat([{"role": "user", "content": "q"}])
    assert excinfo.value.code == AI_RESPONSE_INVALID
    # 必须是业务错误，而不是未处理 Python 异常
    assert "AttributeError" not in str(excinfo.value)
    assert "TypeError" not in str(excinfo.value)
    assert "KeyError" not in str(excinfo.value)


@pytest.mark.parametrize(
    "tool_calls",
    [
        [123],                                # item 为非对象 int
        ["bad"],                              # item 为字符串
        {},                                   # 整体不是数组（空 dict）
        {"x": 1},                             # 整体不是数组
        [None],                               # item 为 null
        [{"function": 123}],                  # function 非对象
        [{"function": "bad"}],                # function 为字符串
        [{}],                                 # 缺 function
        [{"function": {}}],                   # 缺 function.name
        [{"function": {"name": ""}}],         # name 为空字符串
        [{"function": {"name": 123}}],        # name 非字符串
        [{"function": {"name": "get_analytics", "arguments": 123}}],  # arguments 非字符串/对象
        [{"function": {"name": "get_analytics", "arguments": []}}],   # arguments 为数组
        [{"function": {"name": "get_analytics", "arguments": True}}],  # arguments 为布尔
    ],
)
def test_malformed_tool_calls_mapped_to_ai_response_invalid(tool_calls):
    _expect_invalid(lambda req: json_response(200, _tool_call_payload(tool_calls)))


def test_response_top_level_not_object_mapped_to_invalid():
    _expect_invalid(lambda req: json_response(200, [1, 2, 3]))


def test_choice_not_object_mapped_to_invalid():
    payload = {"choices": [123]}
    _expect_invalid(lambda req: json_response(200, payload))


def test_message_not_object_mapped_to_invalid():
    payload = {"choices": [{"message": 123}]}
    _expect_invalid(lambda req: json_response(200, payload))


def test_content_not_string_mapped_to_invalid():
    payload = {"choices": [{"message": {"role": "assistant", "content": 123}}]}
    _expect_invalid(lambda req: json_response(200, payload))


def test_tool_calls_null_or_absent_still_valid():
    """null / absent tool_calls 合法（当前契约保持）。"""
    client = make_client(
        lambda req: json_response(200, {"choices": [{"message": {"content": "ok"}}]})
    )
    resp = client.chat([{"role": "user", "content": "q"}])
    assert resp.content == "ok"
    assert resp.tool_calls == []

    client = make_client(
        lambda req: json_response(
            200,
            {
                "choices": [
                    {"message": {"role": "assistant", "content": "ok", "tool_calls": None}}
                ]
            },
        )
    )
    resp = client.chat([{"role": "user", "content": "q"}])
    assert resp.tool_calls == []


def test_valid_tool_call_contract_preserved():
    """合法 tool_calls（字符串 arguments）行为不变（现有测试契约）。"""
    payload = _tool_call_payload(
        [
            {
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "get_analytics",
                    "arguments": json.dumps({"endpoint": "overview"}),
                },
            }
        ]
    )
    client = make_client(lambda req: json_response(200, payload))
    resp = client.chat([{"role": "user", "content": "q"}])
    assert len(resp.tool_calls) == 1
    assert resp.tool_calls[0]["name"] == "get_analytics"
    assert json.loads(resp.tool_calls[0]["arguments"]) == {"endpoint": "overview"}


def test_dict_arguments_and_missing_arguments_preserved():
    """现有 permissive parser contract 保持：dict arguments 与缺失 arguments。"""
    payload = _tool_call_payload(
        [
            {
                "function": {
                    "name": "query_stayops_database",
                    "arguments": {"sql": "SELECT 1"},
                }
            },
            {"function": {"name": "get_analytics"}},
        ]
    )
    client = make_client(lambda req: json_response(200, payload))
    resp = client.chat([{"role": "user", "content": "q"}])
    assert len(resp.tool_calls) == 2
    assert resp.tool_calls[0]["arguments"] == {"sql": "SELECT 1"}
    assert resp.tool_calls[1]["arguments"] == "{}"


def test_malformed_arguments_json_content_passes_to_tool_layer():
    """malformed arguments JSON 字符串由 Tool Layer（AI_TOOL_ARGUMENTS_INVALID）
    处理，不属于 Provider 解析边界（现有契约不变）。"""
    payload = _tool_call_payload(
        [{"function": {"name": "get_analytics", "arguments": "not-json{{"}}]
    )
    client = make_client(lambda req: json_response(200, payload))
    resp = client.chat([{"role": "user", "content": "q"}])
    assert resp.tool_calls[0]["arguments"] == "not-json{{"
