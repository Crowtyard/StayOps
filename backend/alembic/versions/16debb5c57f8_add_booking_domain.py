"""add booking domain

Revision ID: 16debb5c57f8
Revises: 9e3f9d00338c
Create Date: 2026-08-26 23:21:17.786423

S2-T1 Booking Domain（决策见 docs/DECISIONS.md）：
- guests / reservations / stays 三张新表
- PG 枚举：reservation_status（CONFIRMED/CANCELLED/NO_SHOW/CHECKED_IN/COMPLETED）、
  reservation_source（DIRECT/PHONE/WECHAT/WALK_IN/OTA/CORPORATE/OTHER）、
  stay_status（ACTIVE/CHECKED_OUT）
- 业务单号 Sequence：reservation_no_seq / stay_no_seq（原子生成 + UNIQUE 约束，REV-04）
- Double Booking 数据库级最终仲裁（REV-01）：
    EXCLUDE USING gist (room_id WITH =, daterange(check_in_date, check_out_date, '[)') WITH &&)
    WHERE status NOT IN ('CANCELLED','NO_SHOW','COMPLETED')
  需 btree_gist 扩展（room_id 相等操作符）。排他约束冲突 23P01 由应用层映射为 409。
- stays.reservation_id 唯一约束：一个 Reservation 最多一个 Stay
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '16debb5c57f8'
down_revision: Union[str, Sequence[str], None] = '9e3f9d00338c'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# create_type=False：类型由下方显式 .create() 创建；
# 否则 op.create_table 触发 _on_table_create 会再次 CREATE TYPE 导致 DuplicateObject。
RESERVATION_STATUS_ENUM = sa.dialects.postgresql.ENUM(
    'CONFIRMED', 'CANCELLED', 'NO_SHOW', 'CHECKED_IN', 'COMPLETED',
    name='reservation_status', create_type=False,
)
RESERVATION_SOURCE_ENUM = sa.dialects.postgresql.ENUM(
    'DIRECT', 'PHONE', 'WECHAT', 'WALK_IN', 'OTA', 'CORPORATE', 'OTHER',
    name='reservation_source', create_type=False,
)
STAY_STATUS_ENUM = sa.dialects.postgresql.ENUM(
    'ACTIVE', 'CHECKED_OUT',
    name='stay_status', create_type=False,
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    # btree_gist：排他约束 room_id WITH = 所需扩展
    op.execute('CREATE EXTENSION IF NOT EXISTS btree_gist')

    # 显式创建 PG 枚举类型（sa.Enum 在 create_table 时不会自动 CREATE TYPE）
    RESERVATION_STATUS_ENUM.create(bind, checkfirst=True)
    RESERVATION_SOURCE_ENUM.create(bind, checkfirst=True)
    STAY_STATUS_ENUM.create(bind, checkfirst=True)

    # 业务单号 Sequence（REV-04：原子生成，禁止 SELECT MAX+1）
    op.execute('CREATE SEQUENCE IF NOT EXISTS reservation_no_seq START WITH 1')
    op.execute('CREATE SEQUENCE IF NOT EXISTS stay_no_seq START WITH 1')

    op.create_table(
        'guests',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('phone', sa.String(32), nullable=True),
        sa.Column('email', sa.String(255), nullable=True),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_guests_phone', 'guests', ['phone'])

    op.create_table(
        'reservations',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('reservation_no', sa.String(32), nullable=False),
        sa.Column('guest_id', sa.Integer,
                  sa.ForeignKey('guests.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('room_id', sa.Integer,
                  sa.ForeignKey('rooms.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('room_type_id', sa.Integer,
                  sa.ForeignKey('room_types.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('check_in_date', sa.Date, nullable=False),
        sa.Column('check_out_date', sa.Date, nullable=False),
        sa.Column('status', RESERVATION_STATUS_ENUM, nullable=False,
                  server_default='CONFIRMED'),
        sa.Column('source', RESERVATION_SOURCE_ENUM, nullable=False,
                  server_default='DIRECT'),
        sa.Column('external_reference', sa.String(100), nullable=True),
        sa.Column('agreed_total_amount', sa.Numeric(10, 2), nullable=False),
        sa.Column('currency', sa.String(3), nullable=False, server_default='CNY'),
        sa.Column('notes', sa.String(1000), nullable=True),
        sa.Column('created_by', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('updated_by', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.UniqueConstraint('reservation_no', name='uq_reservations_reservation_no'),
    )
    op.create_index('ix_reservations_status', 'reservations', ['status'])
    op.create_index('ix_reservations_guest_id', 'reservations', ['guest_id'])
    op.create_index('ix_reservations_room_id', 'reservations', ['room_id'])
    op.create_index('ix_reservations_room_type_id', 'reservations', ['room_type_id'])
    op.create_index('ix_reservations_check_in_date', 'reservations', ['check_in_date'])
    op.create_index('ix_reservations_check_out_date', 'reservations', ['check_out_date'])

    # Double Booking 数据库级最终仲裁（REV-01）：
    # 部分排他约束只作用于仍占用日期区间的 CONFIRMED / CHECKED_IN；
    # CANCELLED / NO_SHOW / COMPLETED 不再阻塞新预订（提前退房释放剩余日期）。
    op.execute(
        """
        ALTER TABLE reservations
        ADD CONSTRAINT ex_reservations_room_daterange
        EXCLUDE USING gist (
            room_id WITH =,
            daterange(check_in_date, check_out_date, '[)') WITH &&
        ) WHERE (status NOT IN ('CANCELLED', 'NO_SHOW', 'COMPLETED'))
        """
    )

    op.create_table(
        'stays',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('stay_no', sa.String(32), nullable=False),
        sa.Column('reservation_id', sa.Integer,
                  sa.ForeignKey('reservations.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('room_id', sa.Integer,
                  sa.ForeignKey('rooms.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('status', STAY_STATUS_ENUM, nullable=False, server_default='ACTIVE'),
        sa.Column('actual_check_in_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('planned_check_out_date', sa.Date, nullable=False),
        sa.Column('actual_check_out_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('updated_by', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.UniqueConstraint('stay_no', name='uq_stays_stay_no'),
        # 一个 Reservation 最多产生一个 Stay
        sa.UniqueConstraint('reservation_id', name='uq_stays_reservation_id'),
    )
    op.create_index('ix_stays_status', 'stays', ['status'])
    op.create_index('ix_stays_room_id', 'stays', ['room_id'])
    op.create_index('ix_stays_planned_check_out_date', 'stays',
                    ['planned_check_out_date'])


def downgrade() -> None:
    """Downgrade schema."""
    bind = op.get_bind()

    op.execute(
        'ALTER TABLE reservations DROP CONSTRAINT IF EXISTS ex_reservations_room_daterange'
    )
    op.drop_table('stays')
    op.drop_table('reservations')
    op.drop_table('guests')
    op.execute('DROP SEQUENCE IF EXISTS stay_no_seq')
    op.execute('DROP SEQUENCE IF EXISTS reservation_no_seq')
    STAY_STATUS_ENUM.drop(bind, checkfirst=True)
    RESERVATION_SOURCE_ENUM.drop(bind, checkfirst=True)
    RESERVATION_STATUS_ENUM.drop(bind, checkfirst=True)
    # btree_gist 扩展保留（可能被其它对象使用；DROP EXTENSION 不在本 revision 范围）
