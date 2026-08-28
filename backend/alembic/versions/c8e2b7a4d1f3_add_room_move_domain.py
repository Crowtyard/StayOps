"""add room move domain

Revision ID: c8e2b7a4d1f3
Revises: a7f3e4c1d902
Create Date: 2026-09-06 10:00:00.000000

Sprint 6 Room Move & In-Stay Recovery（决策见 docs/DECISIONS.md）：
- stay_room_assignments 新表（Stay 实际住宿期间的房间历史；ended_at NULL = active）
- PG 枚举 room_move_reason（7 个固定换房原因，Sprint 6 §10）
- CHECK ck_stay_room_assignments_interval：ended_at IS NULL OR ended_at > started_at
- 部分唯一索引 uq_stay_room_assignments_active_stay：每个 Stay 最多一个 active assignment
- 排他约束 ex_stay_room_assignments_no_overlap（btree_gist + tstzrange）：
  同一 Stay 的 assignment 区间不重叠（DB 最终仲裁）
- hk_task_source 增加 ROOM_MOVE（换房自动保洁任务，Sprint 6 §14）
- Reservation 排他约束调整为 CONFIRMED-only（Sprint 6 §6）：
  CHECKED_IN 后实际住宿房间由 Stay + StayRoomAssignment 表达，
  Reservation.room_id 在 Check-in 后冻结为原分配房，不得继续锁原房
- 既有 Stay 历史回填（Sprint 6 §4，确定性）：
    room_id     = stays.room_id
    started_at  = stays.actual_check_in_at（canonical check-in 时间）
    ended_at    = stays.actual_check_out_at（已退房）或 NULL（ACTIVE）
    reason      = NULL（初始分配，UI 显示「入住」）
    created_by  = stays.created_by
    created_at  = started_at（历史分配记录时间）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c8e2b7a4d1f3'
down_revision: Union[str, Sequence[str], None] = 'a7f3e4c1d902'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


ROOM_MOVE_REASON_ENUM = sa.dialects.postgresql.ENUM(
    'MAINTENANCE', 'GUEST_REQUEST', 'ROOM_QUALITY', 'OPERATIONAL',
    'UPGRADE', 'DOWNGRADE', 'OTHER',
    name='room_move_reason', create_type=False,
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    # btree_gist：assignment 排他约束 stay_id WITH = 所需扩展
    # （Booking 迁移已创建，此处幂等兜底）
    op.execute('CREATE EXTENSION IF NOT EXISTS btree_gist')

    ROOM_MOVE_REASON_ENUM.create(bind, checkfirst=True)

    op.create_table(
        'stay_room_assignments',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('stay_id', sa.Integer,
                  sa.ForeignKey('stays.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('room_id', sa.Integer,
                  sa.ForeignKey('rooms.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('reason', ROOM_MOVE_REASON_ENUM, nullable=True),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('created_by', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_stay_room_assignments_stay_id',
                    'stay_room_assignments', ['stay_id'])
    op.create_index('ix_stay_room_assignments_room_id',
                    'stay_room_assignments', ['room_id'])
    op.create_index('ix_stay_room_assignments_reason',
                    'stay_room_assignments', ['reason'])

    # ended_at > started_at（ended_at NULL = active assignment，Sprint 6 §3）
    op.create_check_constraint(
        'ck_stay_room_assignments_interval',
        'stay_room_assignments',
        '(ended_at IS NULL) OR (ended_at > started_at)',
    )

    # 每个 Stay 最多一个 active assignment（数据库最终仲裁，Sprint 6 §3）
    op.execute(
        """
        CREATE UNIQUE INDEX uq_stay_room_assignments_active_stay
        ON stay_room_assignments (stay_id)
        WHERE ended_at IS NULL
        """
    )

    # 同一 Stay 的 assignment 区间不重叠（[started_at, ended_at) 半开区间；
    # ended_at NULL = 无上界；紧邻不重叠，允许 [s1,e1) 与 [e1,∞) 共存）
    op.execute(
        """
        ALTER TABLE stay_room_assignments
        ADD CONSTRAINT ex_stay_room_assignments_no_overlap
        EXCLUDE USING gist (
            stay_id WITH =,
            tstzrange(started_at, ended_at, '[)') WITH &&
        )
        """
    )

    # hk_task_source 增加 ROOM_MOVE（换房自动保洁任务，Sprint 6 §14）
    op.execute(
        "ALTER TYPE hk_task_source ADD VALUE IF NOT EXISTS 'ROOM_MOVE'"
    )

    # Reservation 排他约束调整为 CONFIRMED-only（Sprint 6 §6）：
    # CHECKED_IN 后 Reservation.room_id 冻结为原分配房，实际占用由
    # Stay.room_id / StayRoomAssignment 表达，不再锁原房至原退房日
    op.execute(
        'ALTER TABLE reservations DROP CONSTRAINT IF EXISTS ex_reservations_room_daterange'
    )
    op.execute(
        """
        ALTER TABLE reservations
        ADD CONSTRAINT ex_reservations_room_daterange
        EXCLUDE USING gist (
            room_id WITH =,
            daterange(check_in_date, check_out_date, '[)') WITH &&
        ) WHERE (status = 'CONFIRMED')
        """
    )

    # 既有 Stay 历史回填（Sprint 6 §4，确定性）：
    # room_id = 当前 stays.room_id；started_at = canonical check-in 时间；
    # 已退房 Stay 用真实 Checkout 时间关闭，ACTIVE Stay 保持 open
    op.execute(
        """
        INSERT INTO stay_room_assignments
            (stay_id, room_id, started_at, ended_at, reason, notes,
             created_by, created_at)
        SELECT
            id,
            room_id,
            actual_check_in_at,
            actual_check_out_at,
            NULL,
            NULL,
            created_by,
            actual_check_in_at
        FROM stays
        """
    )


def downgrade() -> None:
    """Downgrade schema（仅用于测试库往返验证；正常开发库禁止降级）。"""
    bind = op.get_bind()

    op.execute(
        'ALTER TABLE reservations DROP CONSTRAINT IF EXISTS ex_reservations_room_daterange'
    )
    # 恢复 Alpha.5 语义：CONFIRMED / CHECKED_IN 均阻塞日期区间。
    # 注意：若 S6 已产生「CHECKED_IN 原房与新 CONFIRMED 预订重叠」数据，
    # 重新添加旧约束会失败（该数据在旧模型下本不合法）——属预期行为。
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

    # hk_task_source 移除 ROOM_MOVE：PG 不支持 DROP VALUE，
    # 采用「旧类型改名 → 建新类型 → 列转换 → 删旧类型」的确定性流程。
    # ROOM_MOVE 数据先回退为 MANUAL（保持行可用且不丢任务）。
    # 列 default（'MANUAL'::hk_task_source）会在类型改名后引用旧类型名，
    # 必须先 DROP DEFAULT 再转换列类型，最后恢复 default。
    op.execute(
        "UPDATE housekeeping_tasks SET source = 'MANUAL' WHERE source = 'ROOM_MOVE'"
    )
    op.execute(
        "ALTER TABLE housekeeping_tasks ALTER COLUMN source DROP DEFAULT"
    )
    op.execute("ALTER TYPE hk_task_source RENAME TO hk_task_source_old")
    op.execute(
        """
        CREATE TYPE hk_task_source AS ENUM ('CHECKOUT', 'MANUAL')
        """
    )
    op.execute(
        """
        ALTER TABLE housekeeping_tasks
        ALTER COLUMN source TYPE hk_task_source
        USING source::text::hk_task_source
        """
    )
    op.execute(
        """
        ALTER TABLE housekeeping_tasks
        ALTER COLUMN source SET DEFAULT 'MANUAL'
        """
    )
    op.execute("DROP TYPE hk_task_source_old")

    op.execute(
        'ALTER TABLE stay_room_assignments DROP CONSTRAINT IF EXISTS ex_stay_room_assignments_no_overlap'
    )
    op.execute(
        'DROP INDEX IF EXISTS uq_stay_room_assignments_active_stay'
    )
    op.drop_table('stay_room_assignments')

    ROOM_MOVE_REASON_ENUM.drop(bind, checkfirst=True)
