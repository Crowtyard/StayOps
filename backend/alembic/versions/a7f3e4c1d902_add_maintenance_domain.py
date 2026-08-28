"""add maintenance domain

Revision ID: a7f3e4c1d902
Revises: 77ec5f0c543e
Create Date: 2026-09-02 10:00:00.000000

Sprint 5 Maintenance Operations & Room Readiness（决策见 docs/DECISIONS.md）：
- maintenance_work_orders 新表（同一 Room 允许多张 Active 工单，不做 active-per-room 唯一约束）
- PG 枚举：mwo_status（OPEN/ASSIGNED/IN_PROGRESS/RESOLVED/COMPLETED/CANCELLED）、
  mwo_category、mwo_severity、mwo_source、unavailability_source（MANUAL/MAINTENANCE）
- 业务单号 Sequence：maintenance_work_order_no_seq（原子生成 + UNIQUE 约束，禁止 SELECT MAX+1）
- rooms.unavailability_source 新列（nullable）+ 历史数据安全回填：
    existing blocked / out_of_service -> MANUAL；其它 occupancy -> NULL
- CHECK 约束 ck_rooms_unavailability_source：unavailability_source 与
  occupancy_status 语义一致性（blocked/out_of_service 必须有来源，
  其它状态必须为 NULL），数据库级兜底
- 部分索引 ix_mwo_active_blocking_room：Active Blocking 工单查询加速
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7f3e4c1d902'
down_revision: Union[str, Sequence[str], None] = '77ec5f0c543e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


MWO_STATUS_ENUM = sa.dialects.postgresql.ENUM(
    'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'COMPLETED', 'CANCELLED',
    name='mwo_status', create_type=False,
)
MWO_CATEGORY_ENUM = sa.dialects.postgresql.ENUM(
    'ELECTRICAL', 'PLUMBING', 'HVAC', 'LOCK', 'BATHROOM',
    'FURNITURE', 'APPLIANCE', 'NETWORK', 'FINISHING', 'OTHER',
    name='mwo_category', create_type=False,
)
MWO_SEVERITY_ENUM = sa.dialects.postgresql.ENUM(
    'LOW', 'MEDIUM', 'HIGH', 'CRITICAL',
    name='mwo_severity', create_type=False,
)
MWO_SOURCE_ENUM = sa.dialects.postgresql.ENUM(
    'MANUAL', 'FRONT_DESK', 'HOUSEKEEPING', 'PRE_OPENING',
    name='mwo_source', create_type=False,
)
UNAVAILABILITY_SOURCE_ENUM = sa.dialects.postgresql.ENUM(
    'MANUAL', 'MAINTENANCE',
    name='unavailability_source', create_type=False,
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    MWO_STATUS_ENUM.create(bind, checkfirst=True)
    MWO_CATEGORY_ENUM.create(bind, checkfirst=True)
    MWO_SEVERITY_ENUM.create(bind, checkfirst=True)
    MWO_SOURCE_ENUM.create(bind, checkfirst=True)
    UNAVAILABILITY_SOURCE_ENUM.create(bind, checkfirst=True)

    # 业务单号 Sequence（原子生成，禁止 SELECT MAX+1）
    op.execute(
        'CREATE SEQUENCE IF NOT EXISTS maintenance_work_order_no_seq START WITH 1'
    )

    # Room metadata：不可售来源（Sprint 5 §4）
    op.add_column(
        'rooms',
        sa.Column('unavailability_source', UNAVAILABILITY_SOURCE_ENUM, nullable=True),
    )
    # 历史数据安全回填：已有人工锁房/停用 -> MANUAL；其它 -> NULL
    # （不允许将既有人工不可售房错误标记成 Maintenance）
    op.execute(
        """
        UPDATE rooms
        SET unavailability_source = 'MANUAL'
        WHERE occupancy_status IN ('blocked', 'out_of_service')
        """
    )
    op.create_check_constraint(
        'ck_rooms_unavailability_source',
        'rooms',
        (
            "(unavailability_source IS NULL AND occupancy_status "
            " NOT IN ('blocked', 'out_of_service'))"
            " OR (unavailability_source IS NOT NULL AND occupancy_status "
            " IN ('blocked', 'out_of_service'))"
        ),
    )
    op.create_index(
        'ix_rooms_unavailability_source', 'rooms', ['unavailability_source']
    )

    op.create_table(
        'maintenance_work_orders',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('work_order_no', sa.String(32), nullable=False),
        sa.Column('room_id', sa.Integer,
                  sa.ForeignKey('rooms.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('category', MWO_CATEGORY_ENUM, nullable=False),
        sa.Column('severity', MWO_SEVERITY_ENUM, nullable=False,
                  server_default='MEDIUM'),
        sa.Column('status', MWO_STATUS_ENUM, nullable=False,
                  server_default='OPEN'),
        sa.Column('source', MWO_SOURCE_ENUM, nullable=False,
                  server_default='MANUAL'),
        sa.Column('blocks_room', sa.Boolean, nullable=False,
                  server_default=sa.false()),
        sa.Column('title', sa.String(200), nullable=False),
        sa.Column('description', sa.String(2000), nullable=True),
        sa.Column('reported_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('assigned_to_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('verified_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('resolution_notes', sa.String(2000), nullable=True),
        sa.Column('verification_notes', sa.String(2000), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('updated_by', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.UniqueConstraint('work_order_no', name='uq_maintenance_work_orders_work_order_no'),
    )
    op.create_index('ix_maintenance_work_orders_status',
                    'maintenance_work_orders', ['status'])
    op.create_index('ix_maintenance_work_orders_room_id',
                    'maintenance_work_orders', ['room_id'])
    op.create_index('ix_maintenance_work_orders_category',
                    'maintenance_work_orders', ['category'])
    op.create_index('ix_maintenance_work_orders_severity',
                    'maintenance_work_orders', ['severity'])
    op.create_index('ix_maintenance_work_orders_assigned_to_user_id',
                    'maintenance_work_orders', ['assigned_to_user_id'])
    op.create_index('ix_maintenance_work_orders_source',
                    'maintenance_work_orders', ['source'])

    # Active Blocking 工单查询加速（Availability / Check-in / Checkout 集成路径）
    op.execute(
        """
        CREATE INDEX ix_mwo_active_blocking_room
        ON maintenance_work_orders (room_id)
        WHERE blocks_room
          AND status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED')
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    bind = op.get_bind()

    op.drop_index('ix_mwo_active_blocking_room',
                  table_name='maintenance_work_orders')
    op.drop_table('maintenance_work_orders')
    op.execute('DROP SEQUENCE IF EXISTS maintenance_work_order_no_seq')

    op.drop_constraint('ck_rooms_unavailability_source', 'rooms',
                       type_='check')
    op.drop_index('ix_rooms_unavailability_source', table_name='rooms')
    op.drop_column('rooms', 'unavailability_source')

    UNAVAILABILITY_SOURCE_ENUM.drop(bind, checkfirst=True)
    MWO_SOURCE_ENUM.drop(bind, checkfirst=True)
    MWO_SEVERITY_ENUM.drop(bind, checkfirst=True)
    MWO_CATEGORY_ENUM.drop(bind, checkfirst=True)
    MWO_STATUS_ENUM.drop(bind, checkfirst=True)
