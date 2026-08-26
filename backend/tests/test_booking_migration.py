# -*- coding: utf-8 -*-
"""Migration 测试：空库 upgrade head、downgrade/upgrade 往返、排他约束/Sequence/枚举存在性。

使用独立 scratch 库（stayops_test_mig），测试结束即删除，不影响其它用例。
"""

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.config import settings
from tests.conftest import TEST_DATABASE_URL

BACKEND_DIR = Path(__file__).resolve().parents[1]

NEW_REVISION = "16debb5c57f8"
SPRINT1_REVISION = "9e3f9d00338c"


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


def _exclusion_constraint(engine) -> str | None:
    with engine.connect() as conn:
        return conn.execute(
            text(
                "SELECT conname FROM pg_constraint "
                "WHERE conname = 'ex_reservations_room_daterange'"
            )
        ).scalar()


def test_booking_migration_upgrade_downgrade_roundtrip(_database, monkeypatch):
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_mig"

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
        # 1) 空库 upgrade head：完整建立 Sprint 1 + Booking 域
        command.upgrade(cfg, "head")
        tables = _table_names(engine)
        assert {"guests", "reservations", "stays"} <= tables
        assert {"users", "rooms", "audit_logs"} <= tables  # Sprint 1 结构保留
        assert {
            "reservation_status",
            "reservation_source",
            "stay_status",
        } <= _enum_names(engine)
        assert {
            "reservation_no_seq",
            "stay_no_seq",
        } <= _sequence_names(engine)
        assert _exclusion_constraint(engine) == "ex_reservations_room_daterange"

        # 2) downgrade 一个 revision：Booking 表删除，Sprint 1 结构保留
        command.downgrade(cfg, SPRINT1_REVISION)
        tables = _table_names(engine)
        assert not ({"guests", "reservations", "stays"} & tables)
        assert {"users", "rooms"} <= tables
        assert not ({"reservation_no_seq", "stay_no_seq"} & _sequence_names(engine))
        assert not (
            {
                "reservation_status",
                "reservation_source",
                "stay_status",
            }
            & _enum_names(engine)
        )

        # 3) 再 upgrade head（往返）
        command.upgrade(cfg, "head")
        tables = _table_names(engine)
        assert {"guests", "reservations", "stays"} <= tables
        assert _exclusion_constraint(engine) == "ex_reservations_room_daterange"
    finally:
        engine.dispose()
        cleanup = create_engine(url.set(database="postgres"))
        with cleanup.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        cleanup.dispose()
