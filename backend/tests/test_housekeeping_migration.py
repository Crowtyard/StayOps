# -*- coding: utf-8 -*-
"""Housekeeping Migration 测试（Sprint 3）：
空库 upgrade head 建立 housekeeping_tasks；downgrade 到 Booking revision 删除；
部分唯一索引（Active Task 唯一）/ 枚举 / Sequence 存在性；往返验证。

使用独立 scratch 库（stayops_test_mig_hk），测试结束即删除。
"""

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.config import settings
from tests.conftest import TEST_DATABASE_URL

BACKEND_DIR = Path(__file__).resolve().parents[1]

HK_REVISION = "77ec5f0c543e"
BOOKING_REVISION = "16debb5c57f8"


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


def _active_unique_index(engine) -> str | None:
    with engine.connect() as conn:
        return conn.execute(
            text(
                "SELECT indexname FROM pg_indexes "
                "WHERE indexname = 'uq_housekeeping_tasks_active_room'"
            )
        ).scalar()


def test_housekeeping_migration_roundtrip(_database, monkeypatch):
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_mig_hk"

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
        # 1) 空库 upgrade head：完整建立 Sprint 1 + Booking + Housekeeping 域
        command.upgrade(cfg, "head")
        tables = _table_names(engine)
        assert "housekeeping_tasks" in tables
        assert {"guests", "reservations", "stays", "users", "rooms"} <= tables
        assert {
            "hk_task_status",
            "hk_task_source",
            "hk_task_priority",
        } <= _enum_names(engine)
        assert "housekeeping_task_no_seq" in _sequence_names(engine)
        assert _active_unique_index(engine) == "uq_housekeeping_tasks_active_room"

        # 2) downgrade 一个 revision：Housekeeping 表删除，Booking/Sprint 1 结构保留
        command.downgrade(cfg, BOOKING_REVISION)
        tables = _table_names(engine)
        assert "housekeeping_tasks" not in tables
        assert {"guests", "reservations", "stays"} <= tables
        assert "housekeeping_task_no_seq" not in _sequence_names(engine)
        assert not (
            {"hk_task_status", "hk_task_source", "hk_task_priority"}
            & _enum_names(engine)
        )

        # 3) 再 upgrade head（往返）
        command.upgrade(cfg, "head")
        assert "housekeeping_tasks" in _table_names(engine)
        assert _active_unique_index(engine) == "uq_housekeeping_tasks_active_room"
    finally:
        engine.dispose()
        cleanup = create_engine(url.set(database="postgres"))
        with cleanup.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        cleanup.dispose()


def test_housekeeping_seed_idempotent_and_role_mapping(_database):
    """seed 幂等 + Housekeeping 权限与角色矩阵正确（总纲 §14）。"""
    from sqlalchemy import select

    from app.database import SessionLocal
    from app.models import Permission, Role, RolePermission
    from app.seed import seed

    HK_CODES = {
        "housekeeping_task:read",
        "housekeeping_task:write",
        "housekeeping_task:work",
        "housekeeping_task:inspect",
        "housekeeping_task:cancel",
    }

    def snapshot() -> dict:
        session = SessionLocal()
        try:
            mapping: dict[str, set[str]] = {}
            for role in session.scalars(select(Role)):
                codes = {
                    p.code
                    for p in session.scalars(
                        select(Permission)
                        .join(
                            RolePermission,
                            RolePermission.permission_id == Permission.id,
                        )
                        .where(RolePermission.role_id == role.id)
                    )
                }
                mapping[role.name] = codes
            return {
                "permissions": len(
                    list(session.scalars(select(Permission)))
                ),
                "mapping": mapping,
            }
        finally:
            session.close()

    seed()
    first = snapshot()
    seed()
    second = snapshot()
    assert first == second, "连续执行两次 seed 必须收敛到一致状态"
    assert first["permissions"] == 48  # Sprint 7：37（S6）+ Inventory/Procurement 的 11

    mapping = first["mapping"]
    assert HK_CODES <= mapping["SUPER_ADMIN"]
    assert HK_CODES <= mapping["MANAGER"]
    assert ({"housekeeping_task:read", "housekeeping_task:write"}) <= mapping[
        "FRONT_DESK"
    ]
    assert not (
        {"housekeeping_task:work", "housekeeping_task:cancel"} & mapping["FRONT_DESK"]
    )
    assert (
        {"housekeeping_task:read", "housekeeping_task:work", "housekeeping_task:inspect"}
        <= mapping["HOUSEKEEPING"]
    )
    assert not ({"housekeeping_task:write", "housekeeping_task:cancel"} & mapping["HOUSEKEEPING"])
    assert not (HK_CODES & mapping["MAINTENANCE"])
    assert not (HK_CODES & mapping["FINANCE"])
