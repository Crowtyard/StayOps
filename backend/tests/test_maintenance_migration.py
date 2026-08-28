# -*- coding: utf-8 -*-
"""Maintenance Migration 测试（Sprint 5 §43）：

- 空库 upgrade head 建立 maintenance_work_orders + rooms.unavailability_source
- downgrade 到 Housekeeping revision 删除；再 upgrade（往返）
- 历史数据安全回填：existing blocked / out_of_service -> MANUAL；
  其它 occupancy -> NULL（不得把人工不可售房错误标记为 MAINTENANCE）
- CHECK 约束存在性；部分索引（active blocking）存在性
- seed 幂等 + Maintenance 权限与角色矩阵正确

使用独立 scratch 库（stayops_test_mig_mwo），测试结束即删除。
"""

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.config import settings
from tests.conftest import TEST_DATABASE_URL

BACKEND_DIR = Path(__file__).resolve().parents[1]

MWO_REVISION = "a7f3e4c1d902"
HK_REVISION = "77ec5f0c543e"

# Room 需要 room_type 外键：手工插入一行
_INSERT_ROOM_TYPE = (
    "INSERT INTO room_types (name, base_price, capacity, created_at, updated_at) "
    "VALUES ('迁移测试房型', 100.00, 2, now(), now()) RETURNING id"
)


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


def _index_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
        )
        return {row[0] for row in rows}


def _room_sources(engine) -> dict[str, str | None]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT room_number, unavailability_source::text FROM rooms "
                "ORDER BY room_number"
            )
        )
        return {row[0]: row[1] for row in rows}


def test_maintenance_migration_roundtrip(_database, monkeypatch):
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_mig_mwo"

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
        # 1) 空库 upgrade head：完整建立 Sprint 1-5 全部域
        command.upgrade(cfg, "head")
        tables = _table_names(engine)
        assert "maintenance_work_orders" in tables
        assert {"guests", "reservations", "stays", "users", "rooms"} <= tables
        assert {
            "mwo_status",
            "mwo_category",
            "mwo_severity",
            "mwo_source",
            "unavailability_source",
        } <= _enum_names(engine)
        assert "maintenance_work_order_no_seq" in _sequence_names(engine)
        indexes = _index_names(engine)
        assert "ix_mwo_active_blocking_room" in indexes
        assert "uq_maintenance_work_orders_work_order_no" in indexes
        assert "ix_rooms_unavailability_source" in indexes

        # 2) downgrade 一个 revision：Maintenance 域删除，Housekeeping 保留
        command.downgrade(cfg, HK_REVISION)
        tables = _table_names(engine)
        assert "maintenance_work_orders" not in tables
        assert "housekeeping_tasks" in tables
        assert "maintenance_work_order_no_seq" not in _sequence_names(engine)
        assert not (
            {"mwo_status", "mwo_category", "mwo_severity", "mwo_source"}
            & _enum_names(engine)
        )

        # 3) 再 upgrade head（往返）
        command.upgrade(cfg, "head")
        assert "maintenance_work_orders" in _table_names(engine)
    finally:
        engine.dispose()
        cleanup = create_engine(url.set(database="postgres"))
        with cleanup.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        cleanup.dispose()


def test_migration_backfill_safety(_database, monkeypatch):
    """历史 Room 安全回填：existing blocked / out_of_service -> MANUAL；
    其它 occupancy -> NULL。不允许将人工不可售房错误标记成 MAINTENANCE。"""
    url = make_url(TEST_DATABASE_URL)
    scratch_name = f"{url.database}_mig_mwo_backfill"

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
        # 先升级到 Housekeeping revision（unavailability_source 尚未存在）
        command.upgrade(cfg, HK_REVISION)
        with engine.connect() as conn:
            room_type_id = conn.execute(text(_INSERT_ROOM_TYPE)).scalar()
            # 历史数据：blocked / out_of_service / available / occupied
            rows = [
                ("901", "blocked"),
                ("902", "out_of_service"),
                ("903", "available"),
                ("904", "occupied"),
                ("905", "reserved"),
            ]
            for number, occupancy in rows:
                conn.execute(
                    text(
                        "INSERT INTO rooms (room_number, room_type_id, floor, "
                        "occupancy_status, cleaning_status, created_at, updated_at) "
                        "VALUES (:n, :t, 9, :o, 'clean', now(), now())"
                    ),
                    {"n": number, "t": room_type_id, "o": occupancy},
                )
            conn.commit()

        # 升级到 head -> 回填执行
        command.upgrade(cfg, "head")
        sources = _room_sources(engine)
        assert sources["901"] == "MANUAL", "existing blocked -> MANUAL"
        assert sources["902"] == "MANUAL", "existing out_of_service -> MANUAL"
        assert sources["903"] is None, "existing available -> NULL"
        assert sources["904"] is None, "existing occupied -> NULL"
        assert sources["905"] is None, "existing reserved -> NULL"

        # CHECK 约束兜底：违反语义的直接写入被拒绝
        with engine.connect() as conn:
            import sqlalchemy.exc

            try:
                conn.execute(
                    text(
                        "UPDATE rooms SET unavailability_source = 'MAINTENANCE' "
                        "WHERE room_number = '903'"
                    )
                )
                conn.commit()
                raise AssertionError("CHECK 约束应拒绝 available + MAINTENANCE")
            except sqlalchemy.exc.IntegrityError:
                conn.rollback()
            try:
                conn.execute(
                    text(
                        "UPDATE rooms SET unavailability_source = NULL "
                        "WHERE room_number = '901'"
                    )
                )
                conn.commit()
                raise AssertionError("CHECK 约束应拒绝 blocked + NULL")
            except sqlalchemy.exc.IntegrityError:
                conn.rollback()
    finally:
        engine.dispose()
        cleanup = create_engine(url.set(database="postgres"))
        with cleanup.connect() as conn:
            conn = conn.execution_options(isolation_level="AUTOCOMMIT")
            conn.execute(
                text(f'DROP DATABASE IF EXISTS "{scratch_name}" WITH (FORCE)')
            )
        cleanup.dispose()


def test_maintenance_seed_role_mapping(_database):
    """seed 幂等 + Maintenance 权限与角色矩阵正确（Sprint 5 §31）。"""
    from sqlalchemy import select

    from app.database import SessionLocal
    from app.models import Permission, Role, RolePermission
    from app.seed import seed

    MWO_CODES = {
        "maintenance_order:read",
        "maintenance_order:write",
        "maintenance_order:work",
        "maintenance_order:verify",
        "maintenance_order:cancel",
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
                "permissions": len(list(session.scalars(select(Permission)))),
                "mapping": mapping,
            }
        finally:
            session.close()

    seed()
    first = snapshot()
    seed()
    second = snapshot()
    assert first == second, "连续执行两次 seed 必须收敛到一致状态"
    assert first["permissions"] == 36

    mapping = first["mapping"]
    assert MWO_CODES <= mapping["SUPER_ADMIN"]
    assert MWO_CODES <= mapping["MANAGER"]
    assert (
        {"maintenance_order:read", "maintenance_order:write"}
        <= mapping["FRONT_DESK"]
    )
    assert not (
        {"maintenance_order:work", "maintenance_order:verify",
         "maintenance_order:cancel"}
        & mapping["FRONT_DESK"]
    )
    assert (
        {"maintenance_order:read", "maintenance_order:write"}
        <= mapping["HOUSEKEEPING"]
    )
    assert not (
        {"maintenance_order:work", "maintenance_order:verify",
         "maintenance_order:cancel"}
        & mapping["HOUSEKEEPING"]
    )
    assert (
        {"maintenance_order:read", "maintenance_order:work"}
        <= mapping["MAINTENANCE"]
    )
    assert not (
        {"maintenance_order:write", "maintenance_order:verify",
         "maintenance_order:cancel"}
        & mapping["MAINTENANCE"]
    )
    assert not (MWO_CODES & mapping["FINANCE"])
