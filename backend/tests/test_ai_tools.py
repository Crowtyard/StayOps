# -*- coding: utf-8 -*-
"""AI Tools 测试（Sprint 9 §11/§12/§22/§23/§24）。

- get_analytics：返回 S8 正式 Metric（不测试模型聪不聪明，测试 Tool Layer）；
  operations / business 权限域继承（FRONT_DESK 拿不到经营数据，FINANCE 拿不到
  运营数据）。
- query_stayops_database：SQL Domain Access 表映射；写操作与 PII 请求被硬拒绝。
"""

from app.core.business_date import add_days, business_date
from app.services.ai_tools import run_get_analytics, run_query_database

OPS_PERMS = {"ai_manager:use", "analytics:operations_read"}
BIZ_PERMS = {"ai_manager:use", "analytics:business_read"}
BOTH_PERMS = OPS_PERMS | BIZ_PERMS


def _period():
    to_date = business_date()
    return add_days(to_date, -30).isoformat(), to_date.isoformat()


# ---------------------------------------------------------------------------
# get_analytics
# ---------------------------------------------------------------------------


def test_get_analytics_overview_returns_s8_metrics(db):
    from_str, to_str = _period()
    result = run_get_analytics(
        db,
        BOTH_PERMS,
        {"endpoint": "overview", "from": from_str, "to": to_str},
    )
    assert "error" not in result
    data = result["data"]
    assert "metrics" in data and "snapshot" in data and "on_books" in data
    metrics = data["metrics"]
    # 正式 S8 Metric 字段（零数据语义：Count->0，Rate 分母 0 -> null；
    # 物理入住率分母 = 物理房晚（28×30）非 0 -> 0.0）
    assert metrics["actual_occupied_room_nights"] == 0
    assert metrics["physical_occupancy_rate"] == 0.0
    assert "physical_room_nights" in metrics
    assert "scheduled_arrivals" in metrics
    assert "housekeeping_completed_tasks" in metrics
    assert set(metrics) >= {
        "actual_occupied_room_nights",
        "physical_room_nights",
        "physical_occupancy_rate",
        "completed_stays",
        "average_length_of_stay",
        "scheduled_arrivals",
        "cancelled_arrivals",
        "cancellation_rate",
        "no_show_count",
        "no_show_rate",
        "average_booking_lead_days",
        "room_move_count",
        "moved_stay_count",
        "room_move_rate",
    }


def test_get_analytics_business_rooms_returns_contracted_value(db):
    from_str, to_str = _period()
    result = run_get_analytics(
        db,
        BOTH_PERMS,
        {"endpoint": "rooms", "from": from_str, "to": to_str},
    )
    assert "error" not in result
    data = result["data"]
    assert data["contracted_room_value"] == "0.00"
    assert data["priced_occupied_room_nights"] == 0
    assert data["contracted_adr"] is None


def test_get_analytics_forecast_no_dates(db):
    result = run_get_analytics(db, BOTH_PERMS, {"endpoint": "forecast"})
    assert "error" not in result
    assert result["data"]["physical_room_count"] == 28
    assert len(result["data"]["daily"]) == 30


def test_get_analytics_front_desk_business_denied(db):
    """FRONT_DESK（仅 operations）：business 端点必须拒绝（§22/§23）。"""
    from_str, to_str = _period()
    result = run_get_analytics(
        db,
        OPS_PERMS,
        {"endpoint": "rooms", "from": from_str, "to": to_str},
    )
    assert result["error"] == "AI_PERMISSION_DENIED"


def test_get_analytics_finance_operations_denied(db):
    """FINANCE（仅 business）：operations 端点必须拒绝。"""
    from_str, to_str = _period()
    result = run_get_analytics(
        db,
        BIZ_PERMS,
        {"endpoint": "overview", "from": from_str, "to": to_str},
    )
    assert result["error"] == "AI_PERMISSION_DENIED"


def test_get_analytics_unknown_endpoint(db):
    result = run_get_analytics(db, BOTH_PERMS, {"endpoint": "everything"})
    assert result["error"] == "AI_UNKNOWN_ENDPOINT"


def test_get_analytics_parameter_errors(db):
    result = run_get_analytics(db, BOTH_PERMS, {"endpoint": "overview"})
    assert result["error"] == "AI_ANALYTICS_PARAMETER_ERROR"
    result = run_get_analytics(
        db,
        BOTH_PERMS,
        {"endpoint": "overview", "from": "2026-08-01", "to": "2026-07-01"},
    )
    assert result["error"] == "AI_ANALYTICS_PARAMETER_ERROR"
    # 未来实际数据拒绝
    future = add_days(business_date(), 1).isoformat()
    result = run_get_analytics(
        db,
        BOTH_PERMS,
        {
            "endpoint": "overview",
            "from": add_days(business_date(), -5).isoformat(),
            "to": future,
        },
    )
    assert result["error"] == "AI_ANALYTICS_PARAMETER_ERROR"


def test_get_analytics_malformed_arguments(db):
    result = run_get_analytics(db, BOTH_PERMS, "not-json{{")
    assert result["error"] == "AI_TOOL_ARGUMENTS_INVALID"


# ---------------------------------------------------------------------------
# query_stayops_database
# ---------------------------------------------------------------------------


def test_query_database_admin_operations(db):
    result = run_query_database(
        db,
        BOTH_PERMS,
        {"sql": "SELECT room_number FROM ai_rooms ORDER BY id LIMIT 2"},
    )
    assert result["columns"] == ["room_number"]
    assert result["row_count"] == 2
    assert result["rows"][0] == ["101"]


def test_query_database_front_desk_can_query_operations(db):
    result = run_query_database(
        db,
        OPS_PERMS,
        {"sql": "SELECT COUNT(*) AS n FROM ai_rooms"},
    )
    assert "error" not in result
    assert result["rows"][0][0] == 28


def test_query_database_front_desk_cannot_query_business_table(db):
    """FRONT_DESK 经 SQL 也不能绕开 RBAC 看库存（§24）。"""
    result = run_query_database(
        db,
        OPS_PERMS,
        {"sql": "SELECT * FROM ai_inventory_items"},
    )
    assert result["error"] == "AI_SQL_REJECTED"
    assert result["sql_rejected"] is True


def test_query_database_finance_can_query_business_not_operations(db):
    result = run_query_database(
        db,
        BIZ_PERMS,
        {"sql": "SELECT location_code FROM ai_inventory_locations ORDER BY id"},
    )
    assert "error" not in result
    result = run_query_database(
        db,
        BIZ_PERMS,
        {"sql": "SELECT room_number FROM ai_rooms"},
    )
    assert result["error"] == "AI_SQL_REJECTED"


def test_query_database_write_sql_rejected(db):
    for sql in (
        "UPDATE ai_rooms SET floor = 9",
        "DELETE FROM ai_stays",
        "INSERT INTO ai_rooms (room_number) VALUES ('999')",
        "DROP TABLE rooms",
    ):
        result = run_query_database(db, BOTH_PERMS, {"sql": sql})
        assert result["error"] == "AI_SQL_REJECTED"
        assert result["sql_rejected"] is True


def test_query_database_pii_request_rejected(db):
    """Prompt Injection PII 请求：数据库/字段级拒绝，不依赖模型拒绝（§29/§17）。"""
    result = run_query_database(
        db,
        BOTH_PERMS,
        {"sql": "SELECT name, phone FROM guests"},
    )
    assert result["error"] == "AI_SQL_REJECTED"
    result = run_query_database(
        db,
        BOTH_PERMS,
        {"sql": "SELECT phone FROM ai_suppliers"},
    )
    assert result["error"] == "AI_SQL_REJECTED"
    result = run_query_database(
        db,
        BOTH_PERMS,
        {"sql": "SELECT * FROM ai_users WHERE password_hash IS NOT NULL"},
    )
    assert result["error"] == "AI_SQL_REJECTED"


def test_query_database_no_permissions(db):
    result = run_query_database(db, set(), {"sql": "SELECT 1"})
    # 无任何域权限：唯一可能放行的只有 CTE 名；SELECT 1 无表引用，放行
    assert "error" not in result
    result = run_query_database(db, set(), {"sql": "SELECT * FROM ai_rooms"})
    assert result["error"] == "AI_SQL_REJECTED"
