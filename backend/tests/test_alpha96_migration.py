# -*- coding: utf-8 -*-
"""alpha.9.6 Migration 测试（F1 房间资料字段 / F3 渠道主数据）。

覆盖任务书 §8「数据库 Migration」的强制要求：
- 单 head；空库 upgrade head 可重复执行（幂等）
- **从 alpha.9.4 / alpha.9.5 真实 schema（b7c1e5a93d24）→ alpha.9.6 head**：
  现有 28 房完整保留、现有 reservation 完整保留
- legacy `reservations.source` → `source_channel_id` 回填：7 种枚举值逐值断言
  （记录 migration mapping），原列值一字不改
- 不自动 downgrade（显式拒绝）
- 不删除历史数据

使用独立 scratch 库（stayops_test_mig_a96），测试结束即删除；不触碰
开发库 stayops 与测试库 stayops_test。
"""

import importlib.util
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

from app.config import settings
from tests.conftest import TEST_DATABASE_URL

BACKEND_DIR = Path(__file__).resolve().parents[1]
MIGRATION_FILE = (
    BACKEND_DIR
    / "alembic"
    / "versions"
    / "a96b1c4d7e02_add_room_management_and_channels.py"
)

ALPHA94_HEAD = "b7c1e5a93d24"
ALPHA96_REVISION = "a96b1c4d7e02"

LEGACY_SOURCES = [
    "DIRECT",
    "PHONE",
    "WECHAT",
    "WALK_IN",
    "OTA",
    "CORPORATE",
    "OTHER",
]

# 期望的 legacy -> 渠道名 mapping（与 docs/DECISIONS.md 一致）
EXPECTED_MAPPING = {
    "DIRECT": "直订",
    "PHONE": "电话",
    "WECHAT": "微信",
    "WALK_IN": "散客",
    "OTA": "其他",
    "CORPORATE": "协议客户",
    "OTHER": "其他",
}


def _load_migration_module():
    """按路径加载 migration 模块（alembic/versions 不是 python package）。"""
    spec = importlib.util.spec_from_file_location(
        "a96_migration", MIGRATION_FILE
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


def _column_names(engine, table: str) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table},
        )
        return {row[0] for row in rows}


def _enum_labels(engine, type_name: str) -> list[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT e.enumlabel FROM pg_enum e "
                "JOIN pg_type t ON t.oid = e.enumtypid "
                "WHERE t.typname = :n ORDER BY e.enumsortorder"
            ),
            {"n": type_name},
        )
        return [row[0] for row in rows]


def _index_names(engine) -> set[str]:
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")
        )
        return {row[0] for row in rows}


def _make_scratch(url, suffix: str):
    """建独立 scratch 库；返回 (scratch_url, admin_engine)。"""
    name = f"{url.database}_{suffix}"
    admin = create_engine(url.set(database="postgres"))
    with admin.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    admin.dispose()
    return url.set(database=name), name


def _drop_scratch(url, name: str) -> None:
    admin = create_engine(url.set(database="postgres"))
    with admin.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    admin.dispose()


def _alembic_cfg() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    return cfg


def test_alpha96_upgrade_from_alpha94_preserves_data(_database, monkeypatch):
    """从 alpha.9.4 head 真实 schema 升级到 alpha.9.6：数据完整保留 + 回填正确。"""
    url = make_url(TEST_DATABASE_URL)
    scratch_url, scratch_name = _make_scratch(url, "mig_a96")
    monkeypatch.setattr(
        settings,
        "database_url",
        scratch_url.render_as_string(hide_password=False),
    )
    cfg = _alembic_cfg()
    engine = create_engine(scratch_url)
    try:
        # 1) 升到 alpha.9.4 head（= alpha.9.5 的 schema，其 hotfix 不含 migration）
        command.upgrade(cfg, ALPHA94_HEAD)
        with engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == ALPHA94_HEAD
            )
        # alpha.9.6 结构在升级前不存在
        assert "channels" not in _table_names(engine)
        assert "is_active" not in _column_names(engine, "rooms")
        assert "source_channel_id" not in _column_names(engine, "reservations")

        # 2) 插入 legacy 数据：1 房型 + 28 房 + 7 种 source 全覆盖的 reservations
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO room_types (name, base_price, capacity) "
                    "VALUES ('迁移测试房型', 328.00, 2)"
                )
            )
            for i in range(28):
                conn.execute(
                    text(
                        "INSERT INTO rooms (room_number, room_type_id, floor,"
                        " occupancy_status, cleaning_status) "
                        "SELECT :n, id, :f, 'available', 'clean' "
                        "FROM room_types LIMIT 1"
                    ),
                    {"n": f"{i + 101}", "f": 1 + i // 14},
                )
            conn.execute(
                text(
                    "INSERT INTO guests (name) VALUES ('legacy-guest'),"
                    "('legacy-guest-2')"
                )
            )
            room_ids = [
                r[0]
                for r in conn.execute(
                    text("SELECT id FROM rooms ORDER BY room_number LIMIT 7")
                ).all()
            ]
            # 每单不同房间：避开 ex_reservations_room_daterange 排他约束
            for idx, src in enumerate(LEGACY_SOURCES):
                conn.execute(
                    text(
                        "INSERT INTO reservations (reservation_no, guest_id,"
                        " room_id, room_type_id, check_in_date, check_out_date,"
                        " status, source, agreed_total_amount, currency) "
                        "SELECT :no, 1, :rid, room_type_id, '2026-09-20',"
                        " '2026-09-22', 'CONFIRMED',"
                        " CAST(:src AS reservation_source), 400.00, 'CNY' "
                        "FROM rooms WHERE id = :rid"
                    ),
                    {
                        "no": f"RSVMIGA96-{idx:04d}",
                        "rid": room_ids[idx],
                        "src": src,
                    },
                )

        # 3) 升级到 alpha.9.6 head
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == ALPHA96_REVISION
            )

            # 3a) 现有 28 房完整保留
            assert (
                conn.execute(text("SELECT COUNT(*) FROM rooms")).scalar_one()
                == 28
            )
            # 既有房间 is_active 默认 true；name 保持 NULL（不猜名称）
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM rooms WHERE is_active IS NOT TRUE")
                ).scalar_one()
                == 0
            )
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM rooms WHERE name IS NOT NULL")
                ).scalar_one()
                == 0
            )

            # 3b) 现有 reservation 完整保留
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM reservations")
                ).scalar_one()
                == len(LEGACY_SOURCES)
            )

            # 3c) 预置渠道
            assert (
                conn.execute(text("SELECT COUNT(*) FROM channels")).scalar_one()
                == 10
            )
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM channels WHERE is_system")
                ).scalar_one()
                == 10
            )
            names = [
                r[0]
                for r in conn.execute(
                    text("SELECT name FROM channels ORDER BY sort_order")
                ).all()
            ]
            for required in ("美团", "携程", "飞猪", "其他"):
                assert required in names

            # 3d) 回填：全部预订都有渠道，且逐值映射正确
            assert (
                conn.execute(
                    text(
                        "SELECT COUNT(*) FROM reservations "
                        "WHERE source_channel_id IS NULL"
                    )
                ).scalar_one()
                == 0
            )
            rows = conn.execute(
                text(
                    "SELECT r.source::text, c.name FROM reservations r "
                    "JOIN channels c ON c.id = r.source_channel_id"
                )
            ).all()
            assert len(rows) == len(LEGACY_SOURCES)
            for legacy_source, channel_name in rows:
                assert channel_name == EXPECTED_MAPPING[legacy_source]

            # 3e) legacy source 原值一字不改
            legacy_values = {
                r[0]
                for r in conn.execute(
                    text("SELECT source::text FROM reservations")
                ).all()
            }
            assert legacy_values == set(LEGACY_SOURCES)

            # 3f) [QA §6] migration **不写权限表**：授权唯一来源是 app/seed.py。
            #     本 scratch 库从未 seed，因此 permissions / role_permissions
            #     必须为空 —— 证明新权限码不是 migration 授予的。
            assert (
                conn.execute(text("SELECT COUNT(*) FROM permissions")).scalar_one()
                == 0
            )
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM role_permissions")
                ).scalar_one()
                == 0
            )

        # 3f) 结构：枚举 / 索引 / 无 room_count 真值字段
        assert _enum_labels(engine, "channel_category") == [
            "OTA",
            "DIRECT",
            "OFFLINE",
            "CORPORATE",
            "OTHER",
        ]
        indexes = _index_names(engine)
        for expected_index in (
            "ix_rooms_is_active",
            "ix_channels_code",
            "ix_channels_name",
            "ix_reservations_source_channel_id",
        ):
            assert expected_index in indexes
        assert not any(
            "room_count" in column for column in _column_names(engine, "rooms")
        )

        # 3g) AI 只读视图同步
        ai_views = {v for v in _view_names(engine) if v.startswith("ai_")}
        assert len(ai_views) == 22
        assert "ai_channels" in ai_views
        assert {"name", "is_active"} <= _column_names(engine, "ai_rooms")
        assert "source_channel_id" in _column_names(engine, "ai_reservations")
        with engine.connect() as conn:
            assert conn.execute(
                text(
                    "SELECT has_table_privilege("
                    "'stayops_ai_reader', 'ai_channels', 'SELECT')"
                )
            ).scalar_one() is True

        # 4) 幂等：重复 upgrade head 不报错、不重复插入渠道
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            assert (
                conn.execute(text("SELECT COUNT(*) FROM channels")).scalar_one()
                == 10
            )
    finally:
        engine.dispose()
        _drop_scratch(url, scratch_name)


def test_alpha96_empty_database_upgrade_head(_database, monkeypatch):
    """空库 upgrade head（Desktop 首装路径）：结构 + 预置渠道完整建立。"""
    url = make_url(TEST_DATABASE_URL)
    scratch_url, scratch_name = _make_scratch(url, "mig_a96_empty")
    monkeypatch.setattr(
        settings,
        "database_url",
        scratch_url.render_as_string(hide_password=False),
    )
    cfg = _alembic_cfg()
    engine = create_engine(scratch_url)
    try:
        command.upgrade(cfg, "head")
        assert "channels" in _table_names(engine)
        assert {"name", "is_active"} <= _column_names(engine, "rooms")
        assert "source_channel_id" in _column_names(engine, "reservations")
        with engine.connect() as conn:
            assert (
                conn.execute(text("SELECT COUNT(*) FROM channels")).scalar_one()
                == 10
            )
        # 再跑一次（幂等）
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            assert (
                conn.execute(text("SELECT COUNT(*) FROM channels")).scalar_one()
                == 10
            )
    finally:
        engine.dispose()
        _drop_scratch(url, scratch_name)


def test_alpha96_single_head():
    """alembic 必须单 head（禁止分支链）。"""
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(_alembic_cfg())
    heads = script.get_heads()
    assert len(heads) == 1, heads
    assert heads[0] == ALPHA96_REVISION


def test_alpha96_downgrade_roundtrip(_database, monkeypatch):
    """alpha.9.6 revision 可逆（供 migration roundtrip 验证与人工明确回退）。

    仓库政策是运行时不**自动** downgrade；本测试只证明结构可逆，且
    **legacy `reservations.source` 原值在往返中始终未被修改**
    （降级不丢失原始来源事实）。
    """
    url = make_url(TEST_DATABASE_URL)
    scratch_url, scratch_name = _make_scratch(url, "mig_a96_down")
    monkeypatch.setattr(
        settings,
        "database_url",
        scratch_url.render_as_string(hide_password=False),
    )
    cfg = _alembic_cfg()
    engine = create_engine(scratch_url)
    try:
        command.upgrade(cfg, ALPHA94_HEAD)
        with engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO room_types (name, base_price, capacity) "
                    "VALUES ('回退测试房型', 100, 2)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO rooms (room_number, room_type_id, floor,"
                    " occupancy_status, cleaning_status) "
                    "SELECT '9R1', id, 9, 'available', 'clean' "
                    "FROM room_types LIMIT 1"
                )
            )
            conn.execute(text("INSERT INTO guests (name) VALUES ('回退客人')"))
            conn.execute(
                text(
                    "INSERT INTO reservations (reservation_no, guest_id,"
                    " room_id, room_type_id, check_in_date, check_out_date,"
                    " status, source, agreed_total_amount, currency) "
                    "SELECT 'RSVDOWN-0001', 1, id, room_type_id, '2026-09-20',"
                    " '2026-09-22', 'CONFIRMED', 'WECHAT', 100, 'CNY' "
                    "FROM rooms WHERE room_number = '9R1'"
                )
            )

        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            assert (
                conn.execute(text("SELECT COUNT(*) FROM channels")).scalar_one()
                == 10
            )
            assert (
                conn.execute(
                    text(
                        "SELECT COUNT(*) FROM reservations "
                        "WHERE source_channel_id IS NULL"
                    )
                ).scalar_one()
                == 0
            )

        # 回退到 alpha.9.4 head：alpha.9.6 结构与数据消失，业务数据保留
        command.downgrade(cfg, ALPHA94_HEAD)
        with engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == ALPHA94_HEAD
            )
            assert "channels" not in _table_names(engine)
            assert "is_active" not in _column_names(engine, "rooms")
            assert "name" not in _column_names(engine, "rooms")
            assert "source_channel_id" not in _column_names(engine, "reservations")
            assert "ai_channels" not in _view_names(engine)
            assert "name" not in _column_names(engine, "ai_rooms")
            assert "source_channel_id" not in _column_names(
                engine, "ai_reservations"
            )
            # 业务数据完整保留，legacy source 原值未被修改
            assert (
                conn.execute(text("SELECT COUNT(*) FROM rooms")).scalar_one() == 1
            )
            assert (
                conn.execute(
                    text("SELECT COUNT(*) FROM reservations")
                ).scalar_one()
                == 1
            )
            assert (
                conn.execute(
                    text("SELECT source::text FROM reservations")
                ).scalar_one()
                == "WECHAT"
            )

        # 再升级回来：渠道与归因重新建立（legacy source 仍在）
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            assert (
                conn.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == ALPHA96_REVISION
            )
            assert (
                conn.execute(text("SELECT COUNT(*) FROM channels")).scalar_one()
                == 10
            )
            channel_name = conn.execute(
                text(
                    "SELECT c.name FROM reservations r JOIN channels c "
                    "ON c.id = r.source_channel_id"
                )
            ).scalar_one()
            assert channel_name == "微信"
    finally:
        engine.dispose()
        _drop_scratch(url, scratch_name)


def test_alpha96_legacy_mapping_table_is_exhaustive():
    """migration mapping 必须覆盖 ReservationSource 全部枚举值（不丢历史值）。"""
    from app.models.reservation import ReservationSource

    module = _load_migration_module()
    mapping = module.LEGACY_SOURCE_TO_CHANNEL_CODE
    assert set(mapping) == {member.value for member in ReservationSource}
    # 映射目标必须是预置渠道 code（migration 会建出来）
    system_codes = {code for code, _n, _c, _o in module.SYSTEM_CHANNELS}
    assert set(mapping.values()) <= system_codes
    assert module.LEGACY_FALLBACK_CHANNEL_CODE in system_codes
