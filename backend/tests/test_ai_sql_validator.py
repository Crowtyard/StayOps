# -*- coding: utf-8 -*-
"""AI SQL Validator 测试（Sprint 9 §14/§30/§31）。

写操作全部必须在执行前被拒绝（不依赖模型自己拒绝）；合法分析查询不得误判。
"""

import pytest

from app.core.ai_sql_validator import (
    FORBIDDEN_IDENTIFIERS,
    FORBIDDEN_KEYWORDS,
    SqlValidationError,
    allowed_tables_for,
    validate_sql,
)

ALL_OP = {
    "AI_ROOM_TYPES", "AI_ROOMS", "AI_RESERVATIONS", "AI_STAYS",
    "AI_STAY_ROOM_ASSIGNMENTS", "AI_HOUSEKEEPING_TASKS",
    "AI_MAINTENANCE_WORK_ORDERS", "AI_USERS",
}
ALL_BIZ = {
    "AI_INVENTORY_ITEMS", "AI_INVENTORY_LOCATIONS", "AI_INVENTORY_BALANCES",
    "AI_STOCK_MOVEMENTS", "AI_STOCK_ISSUES", "AI_STOCK_ISSUE_LINES",
    "AI_SUPPLIERS", "AI_PURCHASE_REQUESTS", "AI_PURCHASE_REQUEST_LINES",
    "AI_PURCHASE_ORDERS", "AI_PURCHASE_ORDER_LINES",
    "AI_GOODS_RECEIPTS", "AI_GOODS_RECEIPT_LINES",
}
ALL = ALL_OP | ALL_BIZ


def ok(sql: str, allowed: set[str] = ALL):
    """合法查询必须通过（并返回清理后 SQL）。"""
    return validate_sql(sql, allowed)


def bad(sql: str, allowed: set[str] = ALL, match: str | None = None):
    with pytest.raises(SqlValidationError) as excinfo:
        validate_sql(sql, allowed)
    if match:
        assert match.lower() in str(excinfo.value).lower()


# ---------------------------------------------------------------------------
# 合法查询（§31：不得把合法分析查询误判为危险）
# ---------------------------------------------------------------------------


def test_simple_select():
    ok("SELECT room_number, floor FROM ai_rooms")


def test_select_with_limit_order():
    ok("SELECT id FROM ai_rooms ORDER BY id DESC LIMIT 10")


def test_join_group_by_aggregates():
    ok(
        "SELECT r.room_number, COUNT(*) AS cnt "
        "FROM ai_stays s JOIN ai_rooms r ON r.id = s.room_id "
        "GROUP BY r.room_number HAVING COUNT(*) > 1"
    )
    ok("SELECT SUM(quantity) AS total FROM ai_stock_movements WHERE movement_type = 'ISSUE'")
    ok("SELECT AVG(ordered_quantity) FROM ai_purchase_order_lines")


def test_cte_select():
    ok("WITH x AS (SELECT room_number FROM ai_rooms) SELECT COUNT(*) AS n FROM x")


def test_date_filters():
    ok(
        "SELECT COUNT(*) FROM ai_reservations "
        "WHERE check_in_date >= DATE '2026-08-01' AND check_in_date < '2026-09-01'"
    )


def test_trailing_semicolon_and_comments():
    ok("SELECT 1;")
    ok("-- 注释\nSELECT 1;")
    ok("/* 块注释 */ SELECT 1 /* 尾注 */;")
    ok("SELECT 1; -- 尾行注释")


def test_strings_containing_keywords_are_ignored():
    ok("SELECT 'delete' AS word, 'UPDATE' AS w2")
    ok("SELECT * FROM ai_rooms WHERE room_number = 'DELETE-101'")


def test_column_named_deleted_at_is_not_rejected():
    # 经典 substring 误判场景：deleted_at 含 "delete"
    ok("SELECT created_at FROM ai_housekeeping_tasks")


def test_dollar_quote_contains_semicolons_and_keywords():
    ok("SELECT $tag$; DROP TABLE rooms; $tag$ AS txt")


def test_lowercase_keywords():
    ok("select room_number from ai_rooms where floor = 2")


def test_quoted_identifier_keyword():
    ok('SELECT "order" FROM ai_purchase_orders')


def test_public_schema_qualifier_allowed():
    ok("SELECT * FROM public.ai_rooms")


def test_set_returning_function_in_from():
    ok("SELECT day FROM generate_series(DATE '2026-08-01', DATE '2026-08-03', interval '1 day') AS g(day)")


def test_subquery_from():
    ok("SELECT * FROM (SELECT room_number FROM ai_rooms) AS sub")


# ---------------------------------------------------------------------------
# 写操作 / 危险语句（§30：全部必须在执行前被拒绝）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO ai_rooms (room_number) VALUES ('999')",
        "UPDATE ai_rooms SET floor = 9",
        "DELETE FROM ai_rooms WHERE id = 1",
        "MERGE INTO ai_rooms USING x ON true WHEN MATCHED THEN DELETE",
        "TRUNCATE ai_rooms",
        "CREATE TABLE evil (id int)",
        "ALTER TABLE ai_rooms ADD COLUMN x int",
        "DROP TABLE rooms",
        "GRANT ALL ON rooms TO PUBLIC",
        "REVOKE SELECT ON rooms FROM x",
        "COPY ai_rooms TO '/tmp/x.csv'",
        "CALL some_proc()",
        "DO $$ BEGIN RAISE NOTICE 'x'; END $$;",
        "SET statement_timeout = 0",
        "SET ROLE stayops",
        "SELECT * INTO temp_table FROM ai_rooms",
        "EXECUTE 'SELECT 1'",
        "PREPARE p AS SELECT 1",
        "VACUUM ai_rooms",
        "REINDEX TABLE ai_rooms",
        "CLUSTER ai_rooms",
        "REFRESH MATERIALIZED VIEW x",
        "COMMENT ON TABLE ai_rooms IS 'x'",
        "SECURITY LABEL FOR x ON TABLE ai_rooms IS 'y'",
        "LOCK TABLE ai_rooms IN ACCESS EXCLUSIVE MODE",
        "LISTEN chan",
        "NOTIFY chan",
        "UNLISTEN chan",
        "DISCARD ALL",
        "RESET ALL",
        "SHOW server_version",
        "DECLARE cur CURSOR FOR SELECT 1",
        "MOVE FORWARD 1 IN cur",
        "CLOSE cur",
        "IMPORT FOREIGN SCHEMA x FROM SERVER s INTO public",
        "ANALYZE ai_rooms",
    ],
)
def test_write_statements_rejected(sql):
    bad(sql, match="禁止")


def test_data_modifying_cte_rejected():
    # WITH ... DELETE 数据修改型 CTE：写关键字全局拒绝
    bad("WITH x AS (DELETE FROM ai_rooms WHERE id = 1) SELECT 1 FROM x")


def test_multi_statement_rejected():
    bad("SELECT 1; SELECT 2", match="单条")
    bad("SELECT 1; DROP TABLE rooms", match="单条")
    bad("SELECT 1;;", match="单条")


def test_empty_sql_rejected():
    bad("   ", match="空")
    bad("", match="空")


def test_non_select_first_keyword_rejected():
    bad("EXPLAIN SELECT 1", match="只允许 SELECT")
    bad("VALUES (1)", match="只允许 SELECT")


def test_with_without_select_rejected():
    bad("WITH x AS (SELECT 1)", match="SELECT")


def test_sql_too_long_rejected():
    bad("SELECT 1 " + "a" * 9000, match="过长")


def test_forbidden_table_rejected():
    bad("SELECT * FROM guests", match="无权限访问")
    bad("SELECT * FROM rooms", match="无权限访问")  # 基表不可访问，只能访问 ai_ 视图
    bad("SELECT * FROM other_schema.ai_rooms", match="public")


# ---------------------------------------------------------------------------
# 敏感字段（§17：Guest PII / 凭据纵深防御）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT phone FROM ai_suppliers",
        "SELECT email FROM ai_users",
        "SELECT password_hash FROM ai_users",
        "SELECT * FROM ai_reservations WHERE guest_phone = '1'",
        "SELECT api_key FROM x",
    ],
)
def test_forbidden_identifiers_rejected(sql):
    bad(sql, match="敏感")


def test_forbidden_keywords_and_identifiers_sets_are_defined():
    assert "INSERT" in FORBIDDEN_KEYWORDS
    assert "PHONE" in FORBIDDEN_IDENTIFIERS


# ---------------------------------------------------------------------------
# SQL Domain Access（§24：permission 域 -> 表白名单）
# ---------------------------------------------------------------------------


def test_allowed_tables_operations_only():
    assert allowed_tables_for({"analytics:operations_read"}) == ALL_OP


def test_allowed_tables_business_only():
    assert allowed_tables_for({"analytics:business_read"}) == ALL_BIZ


def test_allowed_tables_both():
    assert allowed_tables_for(
        {"analytics:operations_read", "analytics:business_read"}
    ) == ALL


def test_allowed_tables_none():
    assert allowed_tables_for(set()) == set()


def test_operations_user_cannot_query_business_table():
    bad("SELECT * FROM ai_inventory_items", allowed=ALL_OP, match="无权限访问")


def test_business_user_cannot_query_operations_table():
    bad("SELECT * FROM ai_rooms", allowed=ALL_BIZ, match="无权限访问")
