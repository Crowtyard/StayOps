"""split room status into occupancy and cleaning dimensions

Revision ID: 9e3f9d00338c
Revises: 60a2ab322a5e
Create Date: 2026-08-26 00:55:08.681590

房态拆双维度（决策见 docs/DECISIONS.md）：
- 新增 occupancy_status / cleaning_status 两列（PG 枚举）
- 旧单枚举 status 数据映射后删除，并 DROP TYPE room_status
映射：available->(available,clean) occupied->(occupied,dirty)
      cleaning->(available,cleaning) maintenance->(out_of_service,dirty)
      out_of_service->(out_of_service,dirty)
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '9e3f9d00338c'
down_revision: Union[str, Sequence[str], None] = '60a2ab322a5e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


OCCUPANCY_ENUM = sa.Enum(
    'available', 'reserved', 'occupied', 'blocked', 'out_of_service',
    name='occupancy_status',
)
CLEANING_ENUM = sa.Enum(
    'clean', 'dirty', 'cleaning', 'inspection', 'rework',
    name='cleaning_status',
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    # 显式创建 PG 枚举类型（sa.Enum 在 add_column 时不会自动 CREATE TYPE）
    OCCUPANCY_ENUM.create(bind, checkfirst=True)
    CLEANING_ENUM.create(bind, checkfirst=True)

    op.add_column(
        'rooms',
        sa.Column('occupancy_status', OCCUPANCY_ENUM, nullable=True),
    )
    op.add_column(
        'rooms',
        sa.Column('cleaning_status', CLEANING_ENUM, nullable=True),
    )

    op.execute(
        """
        UPDATE rooms SET
          occupancy_status = CASE status
            WHEN 'available' THEN 'available'::occupancy_status
            WHEN 'occupied' THEN 'occupied'::occupancy_status
            WHEN 'cleaning' THEN 'available'::occupancy_status
            WHEN 'maintenance' THEN 'out_of_service'::occupancy_status
            WHEN 'out_of_service' THEN 'out_of_service'::occupancy_status
          END,
          cleaning_status = CASE status
            WHEN 'available' THEN 'clean'::cleaning_status
            WHEN 'occupied' THEN 'dirty'::cleaning_status
            WHEN 'cleaning' THEN 'cleaning'::cleaning_status
            WHEN 'maintenance' THEN 'dirty'::cleaning_status
            WHEN 'out_of_service' THEN 'dirty'::cleaning_status
          END
        """
    )

    op.alter_column('rooms', 'occupancy_status', nullable=False)
    op.alter_column('rooms', 'cleaning_status', nullable=False)

    op.create_index('ix_rooms_occupancy_status', 'rooms', ['occupancy_status'])
    op.create_index('ix_rooms_cleaning_status', 'rooms', ['cleaning_status'])

    op.drop_index('ix_rooms_status', table_name='rooms')
    op.drop_column('rooms', 'status')
    op.execute('DROP TYPE IF EXISTS room_status')


def downgrade() -> None:
    """Downgrade schema."""
    bind = op.get_bind()

    op.execute(
        "CREATE TYPE room_status AS ENUM "
        "('available', 'occupied', 'cleaning', 'maintenance', 'out_of_service')"
    )
    op.add_column(
        'rooms',
        sa.Column(
            'status',
            sa.Enum(
                'available', 'occupied', 'cleaning', 'maintenance',
                'out_of_service', name='room_status',
            ),
            nullable=True,
        ),
    )

    op.execute(
        """
        UPDATE rooms SET status = CASE
          WHEN occupancy_status = 'out_of_service'
               AND cleaning_status = 'dirty' THEN 'out_of_service'
          WHEN occupancy_status = 'occupied' THEN 'occupied'
          WHEN cleaning_status = 'cleaning' THEN 'cleaning'
          WHEN cleaning_status = 'dirty' THEN 'available'
          ELSE 'available'
        END
        """
    )

    op.alter_column('rooms', 'status', nullable=False)
    op.create_index('ix_rooms_status', 'rooms', ['status'])
    op.drop_index('ix_rooms_occupancy_status', table_name='rooms')
    op.drop_index('ix_rooms_cleaning_status', table_name='rooms')
    op.drop_column('rooms', 'occupancy_status')
    op.drop_column('rooms', 'cleaning_status')
    op.execute('DROP TYPE IF EXISTS occupancy_status')
    op.execute('DROP TYPE IF EXISTS cleaning_status')
