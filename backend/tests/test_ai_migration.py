# -*- coding: utf-8 -*-
"""AI Manager Migration 测试（Sprint 9 §41）。

空库 upgrade head -> ai 表/视图/只读 Role；downgrade 一个 revision；
再 upgrade 往返；S1-S8 业务事实保留。
"""

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.config import settings
from tests.conftest import TEST_DATABASE_URL

BACKEND_DIR = Path(__file__).resolve().parents[1]

NEW_REVISION = "f5d3b9e7a2c4"
PREV_REVISION = "e3a91f5c8d24"
AI_TABLES = {"ai_settings", "ai_conversations", "ai_messages"}
EXPECTED_AI_VIEWS = 22  # alpha.9.6 新增 ai_channels（F3 客源渠道主数据）
ROLE = "stayops_ai_reader"


def _table_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        )
        return {row[0] for row in rows}


def _view_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT viewname FROM pg_views WHERE schemaname = 'public'")
        )
        return {row[0] for row in rows}


def test_ai_migration_upgrade_downgrade_roundtrip(_database, monkeypatch):
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_ai_mig"

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
        # 1) 空库 upgrade head：AI 域完整建立
        command.upgrade(cfg, "head")
        tables = _table_names(engine)
        assert AI_TABLES <= tables
        ai_views = {v for v in _view_names(engine) if v.startswith("ai_")}
        assert len(ai_views) == EXPECTED_AI_VIEWS
        # 只读 Role 存在且权限正确
        with engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT rolname FROM pg_roles WHERE rolname = :r"), {"r": ROLE}
                ).scalar()
                == ROLE
            )
            assert (
                conn.execute(
                    text(
                        "SELECT has_table_privilege(:r, 'ai_rooms', 'SELECT')"
                    ),
                    {"r": ROLE},
                ).scalar()
                is True
            )
            assert (
                conn.execute(
                    text(
                        "SELECT has_table_privilege(:r, 'rooms', 'INSERT')"
                    ),
                    {"r": ROLE},
                ).scalar()
                is False
            )
            # guests 表（Guest PII）不开放
            assert (
                conn.execute(
                    text("SELECT has_table_privilege(:r, 'guests', 'SELECT')"),
                    {"r": ROLE},
                ).scalar()
                is False
            )

        # 2) downgrade 一个 revision：AI 表/视图删除；S1-S8 结构保留
        command.downgrade(cfg, PREV_REVISION)
        tables = _table_names(engine)
        assert not (AI_TABLES & tables)
        assert not ({v for v in _view_names(engine) if v.startswith("ai_")})
        assert {"users", "rooms", "reservations", "stays", "inventory_items"} <= tables

        # 3) 再 upgrade head（往返）
        command.upgrade(cfg, "head")
        tables = _table_names(engine)
        assert AI_TABLES <= tables
        assert len({v for v in _view_names(engine) if v.startswith("ai_")}) == EXPECTED_AI_VIEWS
    finally:
        engine.dispose()
        cleanup = create_engine(url.set(database="postgres"))
        with cleanup.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        cleanup.dispose()


def test_ai_migration_preserves_s1_s8_business_data(_database, monkeypatch):
    """S1-S8 业务事实在 alpha.8 -> alpha.9 迁移中保留（§41 数据保留）。"""
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_ai_preserve"

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
        # 停在 alpha.8 head，插入业务事实（房型 + 房间）
        command.upgrade(cfg, PREV_REVISION)
        with engine.connect() as conn:
            conn.execute(
                text(
                    "INSERT INTO room_types (name, base_price, capacity) "
                    "VALUES ('测试房型', 300.00, 2)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO rooms (room_number, room_type_id, floor, "
                    "occupancy_status, cleaning_status) "
                    "VALUES ('901', (SELECT id FROM room_types WHERE name='测试房型'), 9, "
                    "'available', 'clean')"
                )
            )
            conn.commit()

        # 升级到 alpha.9：业务事实保留
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM rooms WHERE room_number = '901'")
                ).scalar()
                == 1
            )
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM room_types WHERE name = '测试房型'")
                ).scalar()
                == 1
            )

        # 降级回 alpha.8：业务事实仍保留
        command.downgrade(cfg, PREV_REVISION)
        with engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM rooms WHERE room_number = '901'")
                ).scalar()
                == 1
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
