# -*- coding: utf-8 -*-
"""AI 只读 SQL 执行器测试（Sprint 9 §15/§30/§42）。

双层验证：
- 应用层：execute_ai_query 拒绝写操作（执行前，SqlValidationError）
- 数据库层：绕过 Validator 直接以 stayops_ai_reader 执行 UPDATE/DELETE ->
  PostgreSQL permission denied；只读事务再兜底
- 行数上限 / statement_timeout / JSON 安全序列化
"""

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.config import settings
from app.core.ai_sql_validator import SqlValidationError
from app.services.ai_sql import AiSqlError, execute_ai_query

ALL_OP = {
    "AI_ROOM_TYPES", "AI_ROOMS", "AI_RESERVATIONS", "AI_STAYS",
    "AI_STAY_ROOM_ASSIGNMENTS", "AI_HOUSEKEEPING_TASKS",
    "AI_MAINTENANCE_WORK_ORDERS", "AI_USERS",
}
ALL = ALL_OP | {
    "AI_INVENTORY_ITEMS", "AI_INVENTORY_LOCATIONS", "AI_INVENTORY_BALANCES",
    "AI_STOCK_MOVEMENTS", "AI_STOCK_ISSUES", "AI_STOCK_ISSUE_LINES",
    "AI_SUPPLIERS", "AI_PURCHASE_REQUESTS", "AI_PURCHASE_REQUEST_LINES",
    "AI_PURCHASE_ORDERS", "AI_PURCHASE_ORDER_LINES",
    "AI_GOODS_RECEIPTS", "AI_GOODS_RECEIPT_LINES",
}


def test_execute_valid_select(_database):
    result = execute_ai_query(
        "SELECT room_number, floor FROM ai_rooms ORDER BY id LIMIT 5",
        allowed_tables=ALL_OP,
    )
    assert result["columns"] == ["room_number", "floor"]
    assert result["row_count"] == 5
    assert result["truncated"] is False
    assert result["rows"][0] == ["101", 1]


def test_execute_cte_select(_database):
    result = execute_ai_query(
        "WITH x AS (SELECT id, room_number FROM ai_rooms) "
        "SELECT COUNT(*) AS n FROM x",
        allowed_tables=ALL_OP,
    )
    assert result["columns"] == ["n"]
    assert result["rows"][0][0] == 28  # 种子 28 间房


def test_execute_aggregation_and_date_filter(_database):
    result = execute_ai_query(
        "SELECT COUNT(*) AS cnt, MIN(floor) AS min_floor FROM ai_rooms "
        "WHERE room_number LIKE '2%'",
        allowed_tables=ALL_OP,
    )
    assert result["rows"][0][0] == 10  # 2 楼 10 间（201-210）


def test_row_limit_enforced(_database):
    result = execute_ai_query(
        "SELECT generate_series(1, 300) AS n",
        allowed_tables=ALL,
        limit=200,
    )
    assert result["row_count"] == 200
    assert result["truncated"] is True


def test_hard_limit_caps_configured_limit(_database):
    # 即使调用方要求 1000，硬上限 500 生效
    result = execute_ai_query(
        "SELECT generate_series(1, 1000) AS n",
        allowed_tables=ALL,
        limit=1000,
    )
    assert result["row_count"] == 500
    assert result["truncated"] is True


def test_statement_timeout(_database, monkeypatch):
    monkeypatch.setattr(settings, "ai_sql_statement_timeout_ms", 300)
    with pytest.raises(AiSqlError) as excinfo:
        execute_ai_query("SELECT pg_sleep(5)", allowed_tables=ALL)
    assert excinfo.value.code == "AI_SQL_TIMEOUT"


def test_json_safe_serialization(_database):
    result = execute_ai_query(
        "SELECT CURRENT_DATE AS d, 1.5::numeric AS n, 'x' AS s",
        allowed_tables=ALL,
    )
    row = result["rows"][0]
    assert isinstance(row[0], str)  # date -> isoformat 字符串
    assert row[1] == "1.5"  # Decimal -> 字符串
    assert row[2] == "x"


def test_write_rejected_before_execution(_database):
    """应用层 Validator：写语句执行前拒绝（§30）。"""
    for sql in (
        "UPDATE ai_rooms SET floor = 9",
        "DELETE FROM ai_rooms",
        "INSERT INTO ai_rooms (room_number) VALUES ('999')",
        "TRUNCATE ai_rooms",
        "DROP TABLE ai_rooms",
        "ALTER TABLE ai_rooms ADD COLUMN x int",
        "COPY ai_rooms TO '/tmp/x'",
        "CREATE TABLE evil (id int)",
        "SELECT 1; DELETE FROM ai_rooms",
    ):
        with pytest.raises(SqlValidationError):
            execute_ai_query(sql, allowed_tables=ALL)
    # 数据库未被修改
    result = execute_ai_query(
        "SELECT COUNT(*) AS n FROM ai_rooms", allowed_tables=ALL_OP
    )
    assert result["rows"][0][0] == 28


def _reader_engine():
    url = make_url(settings.database_url).set(
        username="stayops_ai_reader",
        password=settings.ai_reader_database_password,
    )
    return create_engine(url)


def test_database_role_rejects_write_without_validator(_database):
    """绕过 Validator 直连 stayops_ai_reader：UPDATE 必须被数据库拒绝（§30）。"""
    engine = _reader_engine()
    try:
        with engine.connect() as conn:
            with pytest.raises(Exception) as excinfo:
                conn.execute(text("UPDATE rooms SET floor = 9"))
            message = str(excinfo.value)
            assert "permission denied" in message
        # 基表 SELECT 同样被拒（AI 只能经 ai_* 视图）
        with engine.connect() as conn:
            with pytest.raises(Exception) as excinfo:
                conn.execute(text("SELECT * FROM rooms"))
            assert "permission denied" in str(excinfo.value)
    finally:
        engine.dispose()


def test_database_role_rejects_delete_insert_ddl(_database):
    engine = _reader_engine()
    try:
        for sql in (
            "DELETE FROM rooms",
            "INSERT INTO rooms (room_number) VALUES ('999')",
            "DROP TABLE rooms",
            "ALTER TABLE rooms ADD COLUMN x int",
            "TRUNCATE rooms",
            "CREATE TABLE evil (id int)",
        ):
            with engine.connect() as conn:
                with pytest.raises(Exception) as excinfo:
                    conn.execute(text(sql))
                message = str(excinfo.value)
                assert (
                    "permission denied" in message or "must be owner" in message
                ), f"{sql}: {message}"
    finally:
        engine.dispose()


def test_read_only_transaction_blocks_write(_database):
    """只读事务兜底：即使有权限也会被 READ ONLY 拒绝（§15）。"""
    engine = _reader_engine()
    try:
        with engine.connect() as conn:
            conn.execute(text("SET TRANSACTION READ ONLY"))
            with pytest.raises(Exception) as excinfo:
                conn.execute(text("UPDATE ai_rooms SET floor = 9"))
            assert "read-only transaction" in str(excinfo.value).lower() or (
                "permission denied" in str(excinfo.value)
            )
    finally:
        engine.dispose()


def test_reader_cannot_query_guests(_database):
    """Guest PII 数据库级不可见（§17）：guests 表无 SELECT 权限。"""
    engine = _reader_engine()
    try:
        with engine.connect() as conn:
            with pytest.raises(Exception) as excinfo:
                conn.execute(text("SELECT * FROM guests"))
            assert "permission denied" in str(excinfo.value)
    finally:
        engine.dispose()
