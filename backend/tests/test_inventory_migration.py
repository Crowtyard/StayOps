# -*- coding: utf-8 -*-
"""S7 Migration 测试（Sprint 7 §51）：
- alpha.6 DB -> alpha.7：既有数据保留 + 新表/枚举/约束/Sequence 建立
- DB 级约束验证：movement 符号 CHECK / balance 非负 CHECK / 收货不超过订购
- downgrade one revision + re-upgrade head 往返（scratch 库，不碰开发库）

使用独立 scratch 库（stayops_test_mig_s7），测试结束即删除。
"""

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.config import settings
from tests.conftest import TEST_DATABASE_URL

BACKEND_DIR = Path(__file__).resolve().parents[1]

S7_REVISION = "e3a91f5c8d24"
S6_REVISION = "c8e2b7a4d1f3"

S7_TABLES = {
    "inventory_items",
    "inventory_locations",
    "inventory_balances",
    "stock_movements",
    "stock_issues",
    "stock_issue_lines",
    "suppliers",
    "purchase_requests",
    "purchase_request_lines",
    "purchase_orders",
    "purchase_order_lines",
    "goods_receipts",
    "goods_receipt_lines",
}

S7_ENUMS = {
    "item_category",
    "movement_type",
    "issue_destination_type",
    "purchase_request_status",
    "purchase_order_status",
}

S7_SEQUENCES = {
    "stock_movement_no_seq",
    "stock_issue_no_seq",
    "purchase_request_no_seq",
    "purchase_order_no_seq",
    "goods_receipt_no_seq",
}


def _table_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        )
        return {row[0] for row in rows}


def _enum_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT typname FROM pg_type WHERE typtype = 'e'"))
        return {row[0] for row in rows}


def _sequence_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT sequence_name FROM information_schema.sequences")
        )
        return {row[0] for row in rows}


def test_s7_migration_upgrade_downgrade_roundtrip(_database, monkeypatch):
    """S7 迁移：alpha.6 -> alpha.7 数据保留、DB 级约束、downgrade/upgrade 往返。"""
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_mig_s7"

    admin_engine = create_engine(url.set(database="postgres"))
    with admin_engine.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(
            text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
        )
        conn.execute(text(f'CREATE DATABASE "{scratch_name}"'))
    admin_engine.dispose()

    scratch_url = url.set(database=scratch_name)
    monkeypatch.setattr(
        settings,
        "database_url",
        scratch_url.render_as_string(hide_password=False),
    )

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    engine = create_engine(scratch_url)
    try:
        # 1) alpha.6 基线：升到 S6 revision，写入既有域数据
        command.upgrade(cfg, S6_REVISION)
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO room_types (name, base_price, capacity) "
                    "VALUES ('迁移测试房型', 100, 2)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO rooms (room_number, room_type_id, floor,"
                    " occupancy_status, cleaning_status) "
                    "SELECT '9S7', id, 9, 'available', 'clean' FROM room_types LIMIT 1"
                )
            )
        s6_tables_before = _table_names(engine)
        assert "rooms" in s6_tables_before

        # 2) upgrade head（S7）：新结构建立 + 既有数据保留
        command.upgrade(cfg, "head")
        tables = _table_names(engine)
        assert S7_TABLES <= tables
        assert S7_ENUMS <= _enum_names(engine)
        assert S7_SEQUENCES <= _sequence_names(engine)
        # 既有 S6 数据保留
        with engine.connect() as conn:
            count = conn.execute(
                text("SELECT count(*) FROM rooms WHERE room_number = '9S7'")
            ).scalar()
            assert count == 1

        # 3) DB 级约束验证（应用层之外的最终防线）
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO inventory_locations (location_code, name) "
                    "VALUES ('SCRATCH', '临时')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO inventory_items (item_code, name, category,"
                    " base_unit) VALUES ('SC-001', '约束测试', 'OTHER', '个')"
                )
            )
            loc_id = conn.execute(
                text("SELECT id FROM inventory_locations WHERE location_code='SCRATCH'")
            ).scalar()
            item_id = conn.execute(
                text("SELECT id FROM inventory_items WHERE item_code='SC-001'")
            ).scalar()
            conn.execute(
                text(
                    "INSERT INTO inventory_balances (item_id, location_id, quantity)"
                    " VALUES (:i, :l, 10)"
                ),
                {"i": item_id, "l": loc_id},
            )

            # ISSUE 为正数 -> 符号 CHECK 拒绝（savepoint 隔离）
            with pytest.raises(Exception) as exc_info:
                with conn.begin_nested():
                    conn.execute(
                        text(
                            "INSERT INTO stock_movements (movement_no, item_id,"
                            " location_id, movement_type, quantity) VALUES"
                            " ('SMV-SIGN-1', :i, :l, 'ISSUE', 5)"
                        ),
                        {"i": item_id, "l": loc_id},
                    )
            assert "quantity_sign_by_type" in str(exc_info.value)

            # INITIAL 为负数 -> 符号 CHECK 拒绝
            with pytest.raises(Exception):
                with conn.begin_nested():
                    conn.execute(
                        text(
                            "INSERT INTO stock_movements (movement_no, item_id,"
                            " location_id, movement_type, quantity) VALUES"
                            " ('SMV-SIGN-2', :i, :l, 'INITIAL', -1)"
                        ),
                        {"i": item_id, "l": loc_id},
                    )

            # balance 为负 -> CHECK 拒绝
            with pytest.raises(Exception):
                with conn.begin_nested():
                    conn.execute(
                        text(
                            "UPDATE inventory_balances SET quantity = -1 "
                            "WHERE item_id = :i AND location_id = :l"
                        ),
                        {"i": item_id, "l": loc_id},
                    )

            # 收货超过订购 -> PO 行 CHECK 拒绝（received <= ordered）
            conn.execute(
                text(
                    "INSERT INTO suppliers (supplier_code, name) "
                    "VALUES ('SUP-SC-01', '约束供应商')"
                )
            )
            supplier_id = conn.execute(
                text("SELECT id FROM suppliers WHERE supplier_code='SUP-SC-01'")
            ).scalar()
            conn.execute(
                text(
                    "INSERT INTO purchase_orders (order_no, supplier_id, status)"
                    " VALUES ('PO-SC-01', :s, 'ORDERED')"
                ),
                {"s": supplier_id},
            )
            order_id = conn.execute(
                text("SELECT id FROM purchase_orders WHERE order_no='PO-SC-01'")
            ).scalar()
            conn.execute(
                text(
                    "INSERT INTO purchase_order_lines (order_id, item_id,"
                    " ordered_quantity, received_quantity) VALUES"
                    " (:o, :i, 10, 0)"
                ),
                {"o": order_id, "i": item_id},
            )
            with pytest.raises(Exception):
                with conn.begin_nested():
                    conn.execute(
                        text(
                            "UPDATE purchase_order_lines SET received_quantity = 11"
                            " WHERE order_id = :o"
                        ),
                        {"o": order_id},
                    )

            # 一张 Request 至多一张 PO（DB UNIQUE）
            conn.execute(
                text(
                    "INSERT INTO purchase_requests (request_no, status)"
                    " VALUES ('PRQ-SC-01', 'APPROVED')"
                )
            )
            request_id = conn.execute(
                text("SELECT id FROM purchase_requests WHERE request_no='PRQ-SC-01'")
            ).scalar()
            conn.execute(
                text(
                    "INSERT INTO purchase_orders (order_no, supplier_id,"
                    " purchase_request_id, status) VALUES"
                    " ('PO-SC-02', :s, :r, 'DRAFT')"
                ),
                {"s": supplier_id, "r": request_id},
            )
            with pytest.raises(Exception):
                with conn.begin_nested():
                    conn.execute(
                        text(
                            "INSERT INTO purchase_orders (order_no, supplier_id,"
                            " purchase_request_id, status) VALUES"
                            " ('PO-SC-03', :s, :r, 'DRAFT')"
                        ),
                        {"s": supplier_id, "r": request_id},
                    )

        # 4) downgrade one revision（回到 S6）：S7 结构全部移除，S6 结构保留
        command.downgrade(cfg, S6_REVISION)
        tables = _table_names(engine)
        assert not (S7_TABLES & tables), tables & S7_TABLES
        assert not (S7_ENUMS & _enum_names(engine))
        assert not (S7_SEQUENCES & _sequence_names(engine))
        assert "stay_room_assignments" in tables
        with engine.connect() as conn:
            count = conn.execute(
                text("SELECT count(*) FROM rooms WHERE room_number = '9S7'")
            ).scalar()
            assert count == 1

        # 5) re-upgrade head（往返）
        command.upgrade(cfg, "head")
        assert S7_TABLES <= _table_names(engine)
        assert S7_ENUMS <= _enum_names(engine)
    finally:
        engine.dispose()
        cleanup = create_engine(url.set(database="postgres"))
        with cleanup.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        cleanup.dispose()
