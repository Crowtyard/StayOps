"""add housekeeping domain

Revision ID: 77ec5f0c543e
Revises: 16debb5c57f8
Create Date: 2026-08-27 23:07:59.931181

Sprint 3 Housekeeping Operations & Room Turnover（决策见 docs/DECISIONS.md）：
- housekeeping_tasks 新表
- PG 枚举：hk_task_status（PENDING/IN_PROGRESS/INSPECTION/REWORK/COMPLETED/CANCELLED）、
  hk_task_source（CHECKOUT/MANUAL）、hk_task_priority（NORMAL/URGENT）
- 业务单号 Sequence：housekeeping_task_no_seq（原子生成 + UNIQUE 约束，禁止 SELECT MAX+1）
- Active Task 数据库级唯一（部分唯一索引，WHERE status IN 进行中集合）：
  一个 Room 同时最多存在一个进行中保洁任务；并发重复创建由数据库最终仲裁（23 500 类唯一冲突 -> 409）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '77ec5f0c543e'
down_revision: Union[str, Sequence[str], None] = '16debb5c57f8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# create_type=False：类型由下方显式 .create() 创建（避免 op.create_table 自动 CREATE TYPE 冲突）
HK_TASK_STATUS_ENUM = sa.dialects.postgresql.ENUM(
    'PENDING', 'IN_PROGRESS', 'INSPECTION', 'REWORK', 'COMPLETED', 'CANCELLED',
    name='hk_task_status', create_type=False,
)
HK_TASK_SOURCE_ENUM = sa.dialects.postgresql.ENUM(
    'CHECKOUT', 'MANUAL',
    name='hk_task_source', create_type=False,
)
HK_TASK_PRIORITY_ENUM = sa.dialects.postgresql.ENUM(
    'NORMAL', 'URGENT',
    name='hk_task_priority', create_type=False,
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    HK_TASK_STATUS_ENUM.create(bind, checkfirst=True)
    HK_TASK_SOURCE_ENUM.create(bind, checkfirst=True)
    HK_TASK_PRIORITY_ENUM.create(bind, checkfirst=True)

    # 业务单号 Sequence（原子生成，禁止 SELECT MAX+1）
    op.execute('CREATE SEQUENCE IF NOT EXISTS housekeeping_task_no_seq START WITH 1')

    op.create_table(
        'housekeeping_tasks',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('task_no', sa.String(32), nullable=False),
        sa.Column('room_id', sa.Integer,
                  sa.ForeignKey('rooms.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('status', HK_TASK_STATUS_ENUM, nullable=False,
                  server_default='PENDING'),
        sa.Column('priority', HK_TASK_PRIORITY_ENUM, nullable=False,
                  server_default='NORMAL'),
        sa.Column('source', HK_TASK_SOURCE_ENUM, nullable=False,
                  server_default='MANUAL'),
        sa.Column('assigned_to_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('notes', sa.String(1000), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('submitted_for_inspection_at', sa.DateTime(timezone=True),
                  nullable=True),
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
        sa.UniqueConstraint('task_no', name='uq_housekeeping_tasks_task_no'),
    )
    op.create_index('ix_housekeeping_tasks_status', 'housekeeping_tasks', ['status'])
    op.create_index('ix_housekeeping_tasks_room_id', 'housekeeping_tasks', ['room_id'])
    op.create_index('ix_housekeeping_tasks_assigned_to_user_id',
                    'housekeeping_tasks', ['assigned_to_user_id'])
    op.create_index('ix_housekeeping_tasks_priority', 'housekeeping_tasks',
                    ['priority'])
    op.create_index('ix_housekeeping_tasks_source', 'housekeeping_tasks',
                    ['source'])

    # Active Task 数据库级唯一（总纲 §10）：一个 Room 至多一个进行中任务
    # （PENDING / IN_PROGRESS / INSPECTION / REWORK）。部分唯一索引是最终仲裁，
    # 应用层预检仅为快速路径；冲突由应用层映射为 409。
    op.execute(
        """
        CREATE UNIQUE INDEX uq_housekeeping_tasks_active_room
        ON housekeeping_tasks (room_id)
        WHERE status IN ('PENDING', 'IN_PROGRESS', 'INSPECTION', 'REWORK')
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    bind = op.get_bind()

    op.drop_index('uq_housekeeping_tasks_active_room',
                  table_name='housekeeping_tasks')
    op.drop_table('housekeeping_tasks')
    op.execute('DROP SEQUENCE IF EXISTS housekeeping_task_no_seq')
    HK_TASK_PRIORITY_ENUM.drop(bind, checkfirst=True)
    HK_TASK_SOURCE_ENUM.drop(bind, checkfirst=True)
    HK_TASK_STATUS_ENUM.drop(bind, checkfirst=True)
