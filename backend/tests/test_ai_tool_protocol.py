# -*- coding: utf-8 -*-
"""Real Provider Tool Calling Protocol Hotfix 单元测试（§4-§8）。

- Strict Fake：拒绝坏序列（缺 assistant(tool_calls) / id 不匹配 / 回显
  wire contract 违规 / 工具响应不完整），接受修复后序列
- Business Date 注入与相对日期（近7天）语义（Real-use Defect #7）
- get_analytics Tool Schema 与 Backend Contract 一致（oneOf 条件 required，
  Real-use Defect #8）
"""

from datetime import date

import pytest

from app.core.business_date import add_days, business_date
from app.services.ai_manager import build_system_prompt
from app.services.ai_tools import TOOL_DEFINITIONS
from tests.fake_deepseek import (
    FakeDeepSeekClient,
    ProtocolViolationError,
    validate_tool_protocol,
)


def _client(script=None):
    return FakeDeepSeekClient(
        api_key="sk-strict-test",
        script=script or [{"kind": "final", "content": "OK"}],
    )


def _echo(call_ids: list[str], *, arguments_by_id: dict | None = None) -> dict:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": cid,
                "type": "function",
                "function": {
                    "name": "query_stayops_database",
                    "arguments": (arguments_by_id or {}).get(
                        cid, '{"sql": "SELECT 1"}'
                    ),
                },
            }
            for cid in call_ids
        ],
    }


def _tool_msg(call_id: str, content: str = '{"ok": true}') -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": content}


# ---------------------------------------------------------------------------
# Strict Fake rejects bad sequences（§4）
# ---------------------------------------------------------------------------


def test_strict_fake_rejects_tool_without_preceding_assistant():
    msgs = [{"role": "user", "content": "q"}, _tool_msg("call_0")]
    with pytest.raises(ProtocolViolationError):
        _client().chat(msgs)


def test_strict_fake_rejects_tool_without_any_assistant_at_all():
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "user", "content": "q2"},
        _tool_msg("call_0"),
    ]
    with pytest.raises(ProtocolViolationError):
        validate_tool_protocol(msgs)


def test_strict_fake_rejects_mismatched_tool_call_id():
    msgs = [{"role": "user", "content": "q"}, _echo(["call_0"]), _tool_msg("call_9")]
    with pytest.raises(ProtocolViolationError) as excinfo:
        _client().chat(msgs)
    assert "不匹配" in str(excinfo.value)


def test_strict_fake_rejects_incomplete_tool_responses():
    """assistant(tool_calls=[c1,c2]) 但只回了一个 tool -> 拒绝。"""
    msgs = [{"role": "user", "content": "q"}, _echo(["call_0", "call_1"]), _tool_msg("call_0")]
    with pytest.raises(ProtocolViolationError):
        _client().chat(msgs)


def test_strict_fake_rejects_echo_missing_type():
    msgs = [
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_0",
                    "function": {"name": "get_analytics", "arguments": "{}"},
                }
            ],
        },
        _tool_msg("call_0"),
    ]
    with pytest.raises(ProtocolViolationError):
        _client().chat(msgs)


def test_strict_fake_rejects_echo_arguments_not_string():
    msgs = [
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_0",
                    "type": "function",
                    "function": {"name": "get_analytics", "arguments": {"endpoint": "overview"}},
                }
            ],
        },
        _tool_msg("call_0"),
    ]
    with pytest.raises(ProtocolViolationError):
        _client().chat(msgs)


def test_strict_fake_rejects_echo_missing_name():
    msgs = [
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_0",
                    "type": "function",
                    "function": {"arguments": "{}"},
                }
            ],
        },
        _tool_msg("call_0"),
    ]
    with pytest.raises(ProtocolViolationError):
        _client().chat(msgs)


# ---------------------------------------------------------------------------
# Strict Fake accepts fixed sequence（§4/§5）
# ---------------------------------------------------------------------------


def test_strict_fake_accepts_single_tool_call_sequence():
    msgs = [{"role": "user", "content": "q"}, _echo(["call_0"]), _tool_msg("call_0")]
    resp = _client().chat(msgs)
    assert resp.content == "OK"


def test_strict_fake_accepts_multi_tool_call_sequence():
    """1 条 assistant(tool_calls=[4]) + 4 条 role=tool（修复后的正确协议）。"""
    msgs = [
        {"role": "user", "content": "q"},
        _echo(["c1", "c2", "c3", "c4"]),
        _tool_msg("c1"),
        _tool_msg("c2"),
        _tool_msg("c3"),
        _tool_msg("c4"),
    ]
    resp = _client().chat(msgs)
    assert resp.content == "OK"


def test_strict_fake_accepts_multi_round_sequence():
    """多轮工具循环（每轮自己的 assistant(tool_calls) + tool 消息）。"""
    msgs = [
        {"role": "user", "content": "q"},
        _echo(["r1c1"]),
        _tool_msg("r1c1"),
        _echo(["r2c1", "r2c2"]),
        _tool_msg("r2c1"),
        _tool_msg("r2c2"),
    ]
    resp = _client().chat(msgs)
    assert resp.content == "OK"


def test_strict_fake_no_tool_messages_no_validation_impact():
    resp = _client().chat(
        [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}]
    )
    assert resp.content == "OK"


# ---------------------------------------------------------------------------
# Business Date 注入（Real-use Defect #7）
# ---------------------------------------------------------------------------


def test_business_date_injected_deterministic():
    """固定业务日期 -> 确定性的提示词（禁止硬编码，禁止依赖时钟）。"""
    prompt = build_system_prompt(date(2026, 8, 30))
    assert "Current StayOps business date: 2026-08-30" in prompt
    assert "当前 StayOps 业务日期为 2026-08-30" in prompt
    assert "相对日期必须以该业务日期计算" in prompt


def test_relative_7day_semantics_matches_analytics():
    """近7天 = [business_date - 7, business_date)，与 S8 口径一致（§7）。"""
    bd = date(2026, 8, 30)
    prompt = build_system_prompt(bd)
    assert f"[{add_days(bd, -7).isoformat()}, {bd.isoformat()})" in prompt
    assert "[2026-08-23, 2026-08-30)" in prompt


def test_business_date_defaults_to_property_business_date():
    prompt = build_system_prompt()
    assert business_date().isoformat() in prompt


# ---------------------------------------------------------------------------
# Analytics Tool Schema（Real-use Defect #8：Schema == Backend Contract）
# ---------------------------------------------------------------------------


def _get_analytics_schema() -> dict:
    tool = next(
        t for t in TOOL_DEFINITIONS if t["function"]["name"] == "get_analytics"
    )
    return tool["function"]["parameters"]


def test_get_analytics_schema_conditional_required():
    schema = _get_analytics_schema()
    assert schema["type"] == "object"
    variants = schema["oneOf"]
    assert len(variants) == 2

    period_variant = next(
        v for v in variants if "forecast" not in v["properties"]["endpoint"]["enum"]
    )
    forecast_variant = next(
        v for v in variants if v["properties"]["endpoint"]["enum"] == ["forecast"]
    )

    # Actual 端点：from/to 为 required（与 Backend _validate_analytics_period 一致）
    assert period_variant["required"] == ["endpoint", "from", "to"]
    assert {"overview", "bookings", "rooms", "inventory", "procurement"} <= set(
        period_variant["properties"]["endpoint"]["enum"]
    )
    # forecast：不需要 period，不粗暴全局 required
    assert forecast_variant["required"] == ["endpoint"]
    assert forecast_variant["properties"]["endpoint"]["enum"] == ["forecast"]


def test_get_analytics_schema_endpoints_cover_backend_contract():
    """Schema 端点集合 == Backend 工具端点集合（白名单一致）。"""
    from app.services.ai_tools import BUSINESS_ENDPOINTS, OPERATIONS_ENDPOINTS

    schema = _get_analytics_schema()
    schema_endpoints = {
        ep
        for variant in schema["oneOf"]
        for ep in variant["properties"]["endpoint"]["enum"]
    }
    backend_endpoints = set(OPERATIONS_ENDPOINTS) | set(BUSINESS_ENDPOINTS)
    assert schema_endpoints == backend_endpoints
