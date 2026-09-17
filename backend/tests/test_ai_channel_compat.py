# -*- coding: utf-8 -*-
"""alpha.9.6 F4 · AI Manager 渠道兼容测试（任务书 §7）。

任务书要求：新增数据模型不得破坏现有 AI analytics，且 AI 至少仍能回答
「最近七天经营情况」「哪个渠道订单最多」「哪个渠道收入最高」。
这里测试的是 **Tool Layer**（不测试模型聪不聪明）：
- get_analytics(endpoint="channels") 可用，且沿用既有 analytics:business_read 域
- 返回结构可直接回答"哪个渠道订单最多 / 合同房费最高"
- 既有 operations endpoints（最近七天经营情况）不受影响
- AI 只读视图 ai_channels 可查询（query_stayops_database）
- 权限域不因新增渠道端点而放宽
"""

from app.core.business_date import add_days, business_date
from app.services.ai_tools import (
    BUSINESS_DOMAIN_TABLES,
    OPERATIONS_DOMAIN_TABLES,
    run_get_analytics,
    run_query_database,
)

OPS_PERMS = {"ai_manager:use", "analytics:operations_read"}
BIZ_PERMS = {"ai_manager:use", "analytics:business_read"}
BOTH_PERMS = OPS_PERMS | BIZ_PERMS


def _period(days: int = 7):
    to_date = business_date()
    return add_days(to_date, -days).isoformat(), to_date.isoformat()


# ---------------------------------------------------------------------------
# 渠道端点在 AI Tool Layer 可用
# ---------------------------------------------------------------------------


def test_get_analytics_channels_endpoint_available_for_business_domain(db):
    """「哪个渠道订单最多 / 收入最高」可由 get_analytics(channels) 回答。"""
    from_str, to_str = _period()
    result = run_get_analytics(
        db,
        BIZ_PERMS,
        {"endpoint": "channels", "from": from_str, "to": to_str},
    )
    assert "error" not in result, result
    assert result["endpoint"] == "channels"
    data = result["data"]
    assert "channels" in data and "totals" in data and "unassigned" in data
    # 可直接排序回答「哪个渠道订单最多 / 合同房费最高」
    for row in data["channels"]:
        assert set(row) >= {
            "channel_name",
            "channel_category",
            "order_count",
            "occupied_room_nights",
            "contracted_room_value",
            "contracted_adr",
            "share",
        }
    # 默认覆盖全部预置渠道（美团 / 携程 / 飞猪 可分别回答）
    names = {row["channel_name"] for row in data["channels"]}
    assert {"美团", "携程", "飞猪"} <= names
    # JSON 可序列化（Decimal -> str，工具层已 _jsonable）
    assert isinstance(data["totals"]["contracted_room_value"], str)


def test_get_analytics_channels_requires_business_permission(db):
    """渠道经营分析属经营域：仅 operations 权限的账号不得读取。"""
    from_str, to_str = _period()
    denied = run_get_analytics(
        db,
        OPS_PERMS,
        {"endpoint": "channels", "from": from_str, "to": to_str},
    )
    assert denied["error"] == "AI_PERMISSION_DENIED", denied
    allowed = run_get_analytics(
        db,
        BIZ_PERMS,
        {"endpoint": "channels", "from": from_str, "to": to_str},
    )
    assert "error" not in allowed


def test_get_analytics_channels_period_validation(db):
    """沿用既有 Actual 区间规则：必须有 from/to 且 to <= 业务日期。"""
    missing = run_get_analytics(db, BIZ_PERMS, {"endpoint": "channels"})
    assert missing["error"] == "AI_ANALYTICS_PARAMETER_ERROR", missing

    future = run_get_analytics(
        db,
        BIZ_PERMS,
        {
            "endpoint": "channels",
            "from": business_date().isoformat(),
            "to": add_days(business_date(), 1).isoformat(),
        },
    )
    assert future["error"] == "AI_ANALYTICS_PARAMETER_ERROR", future


def test_existing_operations_analytics_still_works(db):
    """「最近七天经营情况」仍可回答（本轮不破坏既有 AI analytics）。"""
    from_str, to_str = _period(7)
    for endpoint in ("overview", "bookings"):
        result = run_get_analytics(
            db,
            BOTH_PERMS,
            {"endpoint": endpoint, "from": from_str, "to": to_str},
        )
        assert "error" not in result, (endpoint, result)
        assert result["endpoint"] == endpoint


# ---------------------------------------------------------------------------
# AI 只读视图 / 域白名单
# ---------------------------------------------------------------------------


def test_ai_channels_view_queryable_and_domain_assigned(db):
    """ai_channels 属运营域只读视图，可被 AI 直接查询（回答渠道主数据问题）。"""
    result = run_query_database(
        db,
        OPS_PERMS,
        {"sql": "SELECT name, category, enabled FROM ai_channels ORDER BY sort_order"},
    )
    assert "error" not in result, result
    rows = result["rows"]
    names = {row[0] for row in rows}
    assert {"美团", "携程", "飞猪", "其他"} <= names


def test_ai_channels_in_operations_domain_whitelist():
    """域白名单必须包含 AI_CHANNELS（否则 AI 无法访问该视图）。"""
    assert "AI_CHANNELS" in OPERATIONS_DOMAIN_TABLES
    # 渠道视图不属经营域（避免域交叉）
    assert "AI_CHANNELS" not in BUSINESS_DOMAIN_TABLES


def test_ai_reservations_exposes_source_channel_id(db):
    """AI 可通过 source_channel_id 关联渠道（唯一来源事实）。"""
    result = run_query_database(
        db,
        OPS_PERMS,
        {
            "sql": "SELECT r.reservation_no, c.name FROM ai_reservations r "
            "LEFT JOIN ai_channels c ON c.id = r.source_channel_id LIMIT 5"
        },
    )
    assert "error" not in result, result


def test_ai_rooms_exposes_room_management_fields(db):
    """ai_rooms 增设 name / is_active 后仍可正常查询。"""
    result = run_query_database(
        db,
        OPS_PERMS,
        {"sql": "SELECT room_number, name, is_active FROM ai_rooms ORDER BY id LIMIT 5"},
    )
    assert "error" not in result, result
    assert len(result["rows"]) == 5
