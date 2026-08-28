# -*- coding: utf-8 -*-
"""Room Move Migration 测试（Sprint 6 §4/§38）：

- 空库 upgrade head 建立 stay_room_assignments（表 / 枚举 / CHECK /
  部分唯一索引 / 排他约束）；hk_task_source 含 ROOM_MOVE；
  Reservation 排他约束为 CONFIRMED-only（Sprint 6 §6）
- 既有 Stay 历史回填：在 S5 revision 插入 legacy stays（ACTIVE + CHECKED_OUT
  含真实 check-in/check-out 时间）后 upgrade head，确定性断言回填结果
- downgrade one revision + upgrade head 往返（scratch 库，不碰开发库）

使用独立 scratch 库（stayops_test_mig_rm），测试结束即删除。
"""

from datetime import datetime, timezone
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.config import settings
from tests.conftest import TEST_DATABASE_URL

BACKEND_DIR = Path(__file__).resolve().parents[1]

ROOM_MOVE_REVISION = "c8e2b7a4d1f3"
MAINTENANCE_REVISION = "a7f3e4c1d902"


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


def _constraint_predicate(engine) -> str | None:
    with engine.connect() as conn:
        return conn.execute(
            text(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conname = 'ex_reservations_room_daterange'"
            )
        ).scalar()


def _index_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
        )
        return {row[0] for row in rows}


def _upgrade(cfg, engine, revision: str) -> None:
    command.upgrade(cfg, revision)


def _downgrade(cfg, engine, revision: str) -> None:
    command.downgrade(cfg, revision)


def test_room_move_migration_roundtrip_and_backfill(_database, monkeypatch):
    """S6 迁移往返 + 既有 Stay 历史回填（Sprint 6 §4 确定性 backfill）。"""
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_mig_rm"

    admin_engine = create_engine(url.set(database="postgres"))
    with admin_engine.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)'))
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
        # 1) 空库先升到 S5 revision（Room Move 迁移前），插入 legacy stays
        _upgrade(cfg, engine, MAINTENANCE_REVISION)
        with engine.begin() as conn:
            # scratch 库无 seed：先建 room_types（rooms / reservations 外键需要）
            conn.execute(
                text(
                    "INSERT INTO room_types (name, base_price, capacity) "
                    "VALUES ('迁移测试房型', 100, 2)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO guests (name, phone) VALUES "
                    "('legacy-active', '13800000001'), ('legacy-out', '13800000002')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO rooms (room_number, room_type_id, floor,"
                    " occupancy_status, cleaning_status) "
                    "SELECT '9M1', id, 9, 'available', 'clean' FROM room_types LIMIT 1"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO rooms (room_number, room_type_id, floor,"
                    " occupancy_status, cleaning_status) "
                    "SELECT '9M2', id, 9, 'available', 'clean' FROM room_types LIMIT 1"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO reservations (reservation_no, guest_id, room_id,"
                    " room_type_id, check_in_date, check_out_date, status, source,"
                    " agreed_total_amount, currency) VALUES "
                    "('RSVMIG-0001', 1, (SELECT id FROM rooms WHERE room_number='9M1'),"
                    " (SELECT room_type_id FROM rooms WHERE room_number='9M1'),"
                    " '2026-08-28', '2026-08-31', 'CHECKED_IN', 'DIRECT', 100, 'CNY'),"
                    "('RSVMIG-0002', 2, (SELECT id FROM rooms WHERE room_number='9M2'),"
                    " (SELECT room_type_id FROM rooms WHERE room_number='9M2'),"
                    " '2026-08-25', '2026-08-28', 'COMPLETED', 'DIRECT', 100, 'CNY')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO stays (stay_no, reservation_id, room_id, status,"
                    " actual_check_in_at, planned_check_out_date, actual_check_out_at)"
                    " VALUES "
                    "('STYMIG-0001', (SELECT id FROM reservations WHERE reservation_no='RSVMIG-0001'),"
                    " (SELECT id FROM rooms WHERE room_number='9M1'), 'ACTIVE',"
                    " '2026-08-28 14:00:00+08', '2026-08-31', NULL),"
                    "('STYMIG-0002', (SELECT id FROM reservations WHERE reservation_no='RSVMIG-0002'),"
                    " (SELECT id FROM rooms WHERE room_number='9M2'), 'CHECKED_OUT',"
                    " '2026-08-25 13:00:00+08', '2026-08-28', '2026-08-28 11:30:00+08')"
                )
            )

        # 2) upgrade head（S6）：结构 + 回填
        _upgrade(cfg, engine, "head")
        tables = _table_names(engine)
        assert "stay_room_assignments" in tables
        assert "room_move_reason" in _enum_names(engine)
        index_names = _index_names(engine)
        assert "uq_stay_room_assignments_active_stay" in index_names
        assert "ex_stay_room_assignments_no_overlap" in index_names
        predicate = _constraint_predicate(engine)
        assert "status = 'CONFIRMED'" in predicate, predicate
        with engine.connect() as conn:
            hk_sources = conn.execute(
                text("SELECT enum_range(NULL::hk_task_source)::text")
            ).scalar()
            assert "ROOM_MOVE" in hk_sources

        # 3) 回填断言（确定性）：
        #    ACTIVE stay -> open assignment（ended_at NULL，room = stay.room_id）
        #    CHECKED_OUT stay -> closed assignment（ended_at = actual_check_out_at）
        with engine.connect() as conn:
            active_row = conn.execute(
                text(
                    "SELECT a.room_id, a.started_at, a.ended_at, a.reason,"
                    " a.created_by, s.room_id AS stay_room "
                    "FROM stay_room_assignments a JOIN stays s ON s.id = a.stay_id "
                    "WHERE s.stay_no = 'STYMIG-0001'"
                )
            ).fetchone()
            assert active_row is not None
            assert active_row.room_id == active_row.stay_room
            assert active_row.ended_at is None
            assert active_row.reason is None
            # 14:00+08 == 06:00Z（timestamptz 按会话时区 UTC 归一化）
            assert active_row.started_at == datetime(
                2026, 8, 28, 6, 0, tzinfo=timezone.utc
            )

            closed_row = conn.execute(
                text(
                    "SELECT a.room_id, a.started_at, a.ended_at "
                    "FROM stay_room_assignments a JOIN stays s ON s.id = a.stay_id "
                    "WHERE s.stay_no = 'STYMIG-0002'"
                )
            ).fetchone()
            assert closed_row is not None
            assert closed_row.ended_at is not None
            # 11:30+08 == 03:30Z；13:00+08 == 05:00Z
            assert closed_row.ended_at == datetime(
                2026, 8, 28, 3, 30, tzinfo=timezone.utc
            )
            assert closed_row.started_at == datetime(
                2026, 8, 25, 5, 0, tzinfo=timezone.utc
            )

        # 4) downgrade one revision：S6 结构删除，S5 结构保留
        _downgrade(cfg, engine, MAINTENANCE_REVISION)
        tables = _table_names(engine)
        assert "stay_room_assignments" not in tables
        assert "room_move_reason" not in _enum_names(engine)
        assert {"guests", "reservations", "stays", "maintenance_work_orders"} <= tables
        predicate = _constraint_predicate(engine)
        # 恢复 Alpha.5 语义（pg_get_constraintdef 把 NOT IN 渲染为 <> ALL）
        assert "'COMPLETED'" in predicate, predicate
        with engine.connect() as conn:
            hk_sources = conn.execute(
                text("SELECT enum_range(NULL::hk_task_source)::text")
            ).scalar()
            assert "ROOM_MOVE" not in hk_sources

        # 5) 再 upgrade head（往返）
        _upgrade(cfg, engine, "head")
        assert "stay_room_assignments" in _table_names(engine)
        assert "ROOM_MOVE" in _constraint_ok_hk_enum(engine)
    finally:
        engine.dispose()
        cleanup = create_engine(url.set(database="postgres"))
        with cleanup.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        cleanup.dispose()


def _constraint_ok_hk_enum(engine) -> str:
    with engine.connect() as conn:
        return conn.execute(
            text("SELECT enum_range(NULL::hk_task_source)::text")
        ).scalar()


def test_room_move_migration_exclusion_constraint_confirmed_only(
    _database, monkeypatch
):
    """数据库级：CONFIRMED-only 排他约束（Sprint 6 §6）。"""
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_mig_rm2"
    admin_engine = create_engine(url.set(database="postgres"))
    with admin_engine.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)'))
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
        command.upgrade(cfg, "head")
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO room_types (name, base_price, capacity) "
                    "VALUES ('约束测试房型', 100, 2)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO guests (name) VALUES ('c1'), ('c2'), ('c3')"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO rooms (room_number, room_type_id, floor,"
                    " occupancy_status, cleaning_status) "
                    "SELECT '9C1', id, 9, 'available', 'clean' FROM room_types LIMIT 1"
                )
            )
            room_id = conn.execute(
                text("SELECT id FROM rooms WHERE room_number = '9C1'")
            ).scalar()
            room_type_id = conn.execute(
                text("SELECT room_type_id FROM rooms WHERE id = :rid"),
                {"rid": room_id},
            ).scalar()
            base = (
                "INSERT INTO reservations (reservation_no, guest_id, room_id,"
                " room_type_id, check_in_date, check_out_date, status, source,"
                " agreed_total_amount, currency) VALUES "
            )
            # CHECKED_IN [8/28, 8/31)
            conn.execute(
                text(
                    base
                    + "('RSVC-0001', 1, :rid, :rt, '2026-08-28', '2026-08-31',"
                    " 'CHECKED_IN', 'DIRECT', 100, 'CNY')"
                ),
                {"rid": room_id, "rt": room_type_id},
            )
            # 重叠 CONFIRMED 同房同区间：S6 允许（实际占用由 Stay 表达）
            conn.execute(
                text(
                    base
                    + "('RSVC-0002', 2, :rid, :rt, '2026-08-28', '2026-08-31',"
                    " 'CONFIRMED', 'DIRECT', 100, 'CNY')"
                ),
                {"rid": room_id, "rt": room_type_id},
            )
            # 重叠 CONFIRMED vs CONFIRMED：数据库约束拒绝（savepoint 隔离，
            # 不中断外层事务）
            import pytest as _pytest
            from sqlalchemy.exc import IntegrityError

            with _pytest.raises(IntegrityError):
                with conn.begin_nested():
                    conn.execute(
                        text(
                            base
                            + "('RSVC-0003', 3, :rid, :rt, '2026-08-28',"
                            " '2026-08-31', 'CONFIRMED', 'DIRECT', 100, 'CNY')"
                        ),
                        {"rid": room_id, "rt": room_type_id},
                    )
            # 紧邻 [8/31, 9/2) CONFIRMED：允许（半开区间）
            conn.execute(
                text(
                    base
                    + "('RSVC-0004', 3, :rid, :rt, '2026-08-31', '2026-09-02',"
                    " 'CONFIRMED', 'DIRECT', 100, 'CNY')"
                ),
                {"rid": room_id, "rt": room_type_id},
            )
    finally:
        engine.dispose()
        cleanup = create_engine(url.set(database="postgres"))
        with cleanup.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        cleanup.dispose()
