"""add room management fields and channel master data

Revision ID: a96b1c4d7e02
Revises: b7c1e5a93d24
Create Date: 2026-09-14 10:00:00.000000

alpha.9.6 · Field Trial Operations Improvements（真实酒店现场试用反馈闭环）。
本 revision 只处理 4 个现场需求所需的 schema 变化，不含 alpha.9.5 hotfix，
不触碰任何既有列/既有数据（除必要的渠道回填外）。

F1 · 房间资料管理：
- rooms.name（String(100), NULL）：房间显示名称（房号 = 物理身份，name = 可读名称）。
- rooms.is_active（Boolean, NOT NULL, default true, index）：是否投入经营。
  **停用不释放 room_number**（room_number 保持全局唯一，含停用房间）——
  房号代表持续存在的物理房间身份，必须保证历史 Reservation / Stay /
  Maintenance 语义稳定。
- **不新增 room_count 列**：房间数量永远是 rooms 记录的计算结果。

F3 · 客源渠道主数据：
- 新表 channels（id / code / name / category / enabled / is_system /
  sort_order / created_at / updated_at）+ PG 枚举 channel_category
  （OTA / DIRECT / OFFLINE / CORPORATE / OTHER）。
  渠道是**可扩展主数据**，不是硬编码 enum；「其他」只是其中一行平权渠道，
  不使用 `channel=OTHER + other_text` 结构。
- reservations.source_channel_id（FK channels, ondelete=RESTRICT, nullable, index）
  = 唯一渠道业务事实源。
- **legacy mapping（不丢历史值）**：按固定映射表把 legacy
  `reservations.source`（PG enum reservation_source）回填到
  `source_channel_id`，`source` 列原值一字不改（降级为只读历史投影）。

AI 只读视图同步（否则 AI 会按旧 schema 生成无效 SQL）：
- ai_rooms 追加 name, is_active；ai_reservations 追加 source_channel_id；
- 新增 ai_channels（渠道属运营域：不含任何 Guest/金额信息；
  reservations.source_channel_id 本身不泄漏金额，与既有 ai_reservations 同级）。
- 新视图不在 f5d3b9e7a2c4 的授权集合内，需显式 GRANT SELECT 给 AI 只读角色。

安全性：本 revision **不写 permissions / role_permissions**，不授予任何业务权限。
新增权限码（channel:read / channel:write）只经 app/seed.py 幂等收敛
（既有先例：Sprint 8/9 新增权限码同样只改 seed，不加 migration）。

可重复验证：全部 DDL 幂等（checkfirst / IF NOT EXISTS），渠道插入用
ON CONFLICT DO NOTHING，回填只更新 source_channel_id IS NULL 的行，
upgrade head 可重复执行；不删除任何历史数据。

downgrade（可逆，供既有 migration roundtrip 测试使用；仓库政策是运行时不
**自动** downgrade）：回退顺序与 upgrade 完全对称 —— 先恢复 legacy AI 视图定义，
再删除列/表。**legacy `reservations.source` 列自始至终未被修改**，因此降级不会
丢失任何原始来源事实（只是失去渠道归因与渠道主数据）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = "a96b1c4d7e02"
down_revision: Union[str, Sequence[str], None] = "b7c1e5a93d24"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

AI_READER_ROLE = "stayops_ai_reader"

CHANNEL_CATEGORY_ENUM = sa.dialects.postgresql.ENUM(
    "OTA", "DIRECT", "OFFLINE", "CORPORATE", "OTHER",
    name="channel_category", create_type=False,
)

# ---------------------------------------------------------------------------
# 预置系统渠道（is_system=true）
# code 稳定不可改（供外部引用与迁移映射）；name 为经营者可见名称。
# 「其他」name 固定为「其他」，code = CUSTOM_OTHER，让经营者改名后
# 未指定渠道的预订仍有稳定归属。
# ---------------------------------------------------------------------------
SYSTEM_CHANNELS: list[tuple[str, str, str, int]] = [
    # (code, name, category, sort_order)
    ("SYS_MEITUAN", "美团", "OTA", 10),
    ("SYS_CTRIP", "携程", "OTA", 20),
    ("SYS_FLIGGY", "飞猪", "OTA", 30),
    ("SYS_DIRECT", "直订", "DIRECT", 40),
    ("SYS_PHONE", "电话", "OFFLINE", 50),
    ("SYS_WECHAT", "微信", "OFFLINE", 60),
    ("SYS_WALK_IN", "散客", "OFFLINE", 70),
    ("SYS_CORPORATE", "协议客户", "CORPORATE", 80),
    ("CUSTOM_OTHER", "其他", "OTHER", 900),
    ("CUSTOM_LEGACY", "历史来源", "OTHER", 990),
]

# ---------------------------------------------------------------------------
# legacy 回填映射表（唯一权威，逐值固定；与 docs/DECISIONS.md 一致）
#   已知值 -> 语义等价渠道；OTA -> 其他（历史 OTA 无法可靠拆分到具体平台）；
#   未知历史字符串 -> 历史来源。
# ---------------------------------------------------------------------------
LEGACY_SOURCE_TO_CHANNEL_CODE: dict[str, str] = {
    "DIRECT": "SYS_DIRECT",
    "PHONE": "SYS_PHONE",
    "WECHAT": "SYS_WECHAT",
    "WALK_IN": "SYS_WALK_IN",
    "OTA": "CUSTOM_OTHER",
    "CORPORATE": "SYS_CORPORATE",
    "OTHER": "CUSTOM_OTHER",
}
LEGACY_FALLBACK_CHANNEL_CODE = "CUSTOM_LEGACY"

# AI 只读视图（本 revision 新增/替换的部分）
# upgrade 后的定义（新增列必须追加在末尾，CREATE OR REPLACE VIEW 才合法）
AI_CHANNELS_VIEW_SQL = (
    "SELECT id, code, name, category, enabled, is_system, sort_order "
    "FROM channels"
)
AI_ROOMS_VIEW_SQL = (
    "SELECT id, room_number, room_type_id, floor, occupancy_status, "
    "cleaning_status, unavailability_source, name, is_active FROM rooms"
)
AI_RESERVATIONS_VIEW_SQL = (
    "SELECT id, reservation_no, room_id, room_type_id, check_in_date, "
    "check_out_date, status, source, external_reference, created_at, "
    "updated_at, source_channel_id FROM reservations"
)
# downgrade 时恢复的 legacy 定义（= f5d3b9e7a2c4 建立的形态）
LEGACY_AI_ROOMS_VIEW_SQL = (
    "SELECT id, room_number, room_type_id, floor, occupancy_status, "
    "cleaning_status, unavailability_source FROM rooms"
)
LEGACY_AI_RESERVATIONS_VIEW_SQL = (
    "SELECT id, reservation_no, room_id, room_type_id, check_in_date, "
    "check_out_date, status, source, external_reference, created_at, "
    "updated_at FROM reservations"
)


def _insert_system_channels(bind) -> None:
    """幂等插入预置渠道（ON CONFLICT (name) DO NOTHING）。"""
    for code, name, category, sort_order in SYSTEM_CHANNELS:
        bind.execute(
            sa.text(
                """
                INSERT INTO channels
                    (code, name, category, enabled, is_system, sort_order)
                VALUES
                    (:code, :name, CAST(:category AS channel_category),
                     true, true, :sort_order)
                ON CONFLICT (name) DO NOTHING
                """
            ),
            {
                "code": code,
                "name": name,
                "category": category,
                "sort_order": sort_order,
            },
        )


def _backfill_source_channel(bind) -> None:
    """legacy source -> source_channel_id 回填（只写 NULL 行，原列不改）。

    先按已知映射更新，再把剩余 NULL（含 source 为 NULL / 未知历史值）
    统一归入「历史来源」。两条 UPDATE 合起来覆盖全部 NULL 行，
    因此回填后不存在可归因而未归因的行。
    """
    bind.execute(
        sa.text(
            """
            UPDATE reservations r
               SET source_channel_id = c.id
              FROM channels c
             WHERE r.source_channel_id IS NULL
               AND c.code = (CASE r.source::text
                                WHEN 'DIRECT'    THEN 'SYS_DIRECT'
                                WHEN 'PHONE'     THEN 'SYS_PHONE'
                                WHEN 'WECHAT'    THEN 'SYS_WECHAT'
                                WHEN 'WALK_IN'   THEN 'SYS_WALK_IN'
                                WHEN 'OTA'       THEN 'CUSTOM_OTHER'
                                WHEN 'CORPORATE' THEN 'SYS_CORPORATE'
                                WHEN 'OTHER'     THEN 'CUSTOM_OTHER'
                                ELSE :fallback
                             END)
            """
        ),
        {"fallback": LEGACY_FALLBACK_CHANNEL_CODE},
    )


def _sync_ai_views(bind) -> None:
    """替换/新建 AI 只读视图并补授权（幂等）。"""
    bind.execute(
        sa.text(f"CREATE OR REPLACE VIEW ai_rooms AS {AI_ROOMS_VIEW_SQL}")
    )
    bind.execute(
        sa.text(
            "CREATE OR REPLACE VIEW ai_reservations AS "
            f"{AI_RESERVATIONS_VIEW_SQL}"
        )
    )
    bind.execute(
        sa.text(f"CREATE OR REPLACE VIEW ai_channels AS {AI_CHANNELS_VIEW_SQL}")
    )
    # 视图所有者必须显式授权新视图（旧迁移的授权集合不含 ai_channels）
    bind.execute(sa.text(f"GRANT SELECT ON ai_channels TO {AI_READER_ROLE};"))


def _restore_legacy_ai_views(bind) -> None:
    """downgrade：把 AI 视图恢复为不含新增列的形态。

    PostgreSQL 的 `CREATE OR REPLACE VIEW` **只能追加列**，无法删除列，因此这里
    必须 DROP + CREATE（并重新 GRANT，DROP VIEW 会一并丢弃授权）。
    不保留依赖对象：若未来有其它视图依赖 ai_rooms / ai_reservations，
    DROP 会直接失败（fail loud，而不是 CASCADE 静默删除依赖者）。
    """
    for view, select_sql in (
        ("ai_rooms", LEGACY_AI_ROOMS_VIEW_SQL),
        ("ai_reservations", LEGACY_AI_RESERVATIONS_VIEW_SQL),
    ):
        bind.execute(sa.text(f"DROP VIEW IF EXISTS {view}"))
        bind.execute(sa.text(f"CREATE VIEW {view} AS {select_sql}"))
        bind.execute(sa.text(f"GRANT SELECT ON {view} TO {AI_READER_ROLE}"))


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    # ------------------------------------------------------------------
    # F1 · 房间资料管理字段
    # ------------------------------------------------------------------
    op.add_column("rooms", sa.Column("name", sa.String(100), nullable=True))
    op.add_column(
        "rooms",
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.create_index("ix_rooms_is_active", "rooms", ["is_active"])

    # ------------------------------------------------------------------
    # F3 · 渠道主数据
    # ------------------------------------------------------------------
    CHANNEL_CATEGORY_ENUM.create(bind, checkfirst=True)
    op.create_table(
        "channels",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("category", CHANNEL_CATEGORY_ENUM, nullable=False,
                  server_default="OTHER"),
        sa.Column("enabled", sa.Boolean, nullable=False,
                  server_default=sa.true()),
        sa.Column("is_system", sa.Boolean, nullable=False,
                  server_default=sa.false()),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index("ix_channels_code", "channels", ["code"], unique=True)
    op.create_index("ix_channels_name", "channels", ["name"], unique=True)
    op.create_index("ix_channels_category", "channels", ["category"])
    op.create_index("ix_channels_enabled", "channels", ["enabled"])

    _insert_system_channels(bind)

    # ------------------------------------------------------------------
    # F3 · Reservation 渠道关联 + legacy 回填
    # ------------------------------------------------------------------
    op.add_column(
        "reservations",
        sa.Column(
            "source_channel_id",
            sa.Integer,
            sa.ForeignKey("channels.id", ondelete="RESTRICT"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_reservations_source_channel_id",
        "reservations",
        ["source_channel_id"],
    )
    _backfill_source_channel(bind)

    # ------------------------------------------------------------------
    # AI 只读视图同步
    # ------------------------------------------------------------------
    _sync_ai_views(bind)


def downgrade() -> None:
    """回退 alpha.9.6 结构变化（与 upgrade 完全对称）。

    顺序（镜像 upgrade，先处理依赖视图）：
      1. AI 视图恢复为 legacy 定义（去掉 name / is_active / source_channel_id）
      2. drop ai_channels（视图无数据）
      3. drop reservations.source_channel_id（+ 索引）
      4. drop channels 表（含渠道主数据）
      5. drop rooms.name / rooms.is_active（+ 索引）
      6. channel_category 枚举类型保留不动（无害；PG 无 DROP TYPE IF UNUSED，
         强行 DROP TYPE 在枚举仍被引用时会失败）

    **不丢失原始来源事实**：`reservations.source`（legacy 投影）从未被本
    revision 修改，降级后来源归因仍可从该列读到；失去的只是渠道主数据与
    渠道归因（source_channel_id）。

    仓库政策是运行时不**自动** downgrade（见 AGENTS.md / docs/DECISIONS.md）；
    本函数仅为 migration roundtrip 验证与人工明确回退而存在。
    """
    bind = op.get_bind()
    _restore_legacy_ai_views(bind)
    op.execute("DROP VIEW IF EXISTS ai_channels")
    op.drop_index("ix_reservations_source_channel_id", table_name="reservations")
    op.drop_column("reservations", "source_channel_id")
    op.drop_index("ix_channels_enabled", table_name="channels")
    op.drop_index("ix_channels_category", table_name="channels")
    op.drop_index("ix_channels_name", table_name="channels")
    op.drop_index("ix_channels_code", table_name="channels")
    op.drop_table("channels")
    op.drop_index("ix_rooms_is_active", table_name="rooms")
    op.drop_column("rooms", "is_active")
    op.drop_column("rooms", "name")
