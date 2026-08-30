"""add ai manager domain

Revision ID: f5d3b9e7a2c4
Revises: e3a91f5c8d24
Create Date: 2026-08-31 09:00:00.000000

Sprint 9 · DeepSeek AI Manager（决策见 docs/DECISIONS.md / docs/AI_MANAGER.md）：
- ai_settings：DeepSeek 配置单行表（id=1 CHECK），API Key 只存 Fernet 密文
- ai_conversations / ai_messages：对话与消息持久化（无凭据、无完整 SQL 结果）
- ai_* 只读视图（21 个）：AI 可见数据的数据库级白名单——
  * 不含 guests 表（Guest PII 完全不开放）
  * 不含 phone / email / wechat / password_hash / notes / 金额（reservations）
  * suppliers 不含 phone / wechat / notes；users 不含 email / phone / password_hash
- stayops_ai_reader 只读 Role（数据库级写保护）：
  * LOGIN 且 NOSUPERUSER / NOCREATEDB / NOCREATEROLE
  * 仅 GRANT CONNECT + USAGE schema public + SELECT ai_* 视图
  * 无任何基表权限：即使应用层 Validator 失效，INSERT/UPDATE/DELETE/
    TRUNCATE/CREATE/ALTER/DROP 仍被 PostgreSQL 拒绝
  * ALTER DEFAULT PRIVILEGES 只授予未来表的 SELECT（不给写权限）
- 密码来源：app.config.settings.ai_reader_database_password（后端 env/config，
  绝不写入 Git 与密文同存；生产必须环境变量提供）
- 角色为集群级对象，downgrade 不 DROP ROLE（避免影响其它数据库），只撤销授权
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.engine.url import make_url

from app.config import settings

# revision identifiers, used by Alembic.
revision: str = 'f5d3b9e7a2c4'
down_revision: Union[str, Sequence[str], None] = 'e3a91f5c8d24'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

AI_READER_ROLE = "stayops_ai_reader"

# ---------------------------------------------------------------------------
# AI 只读视图（数据库级字段/表白名单；不含任何 Guest PII 与凭据）
# ---------------------------------------------------------------------------

# operations 域（analytics:operations_read 可见）
AI_VIEWS: list[tuple[str, str]] = [
    (
        "ai_room_types",
        "SELECT id, name, base_price, capacity FROM room_types",
    ),
    (
        "ai_rooms",
        "SELECT id, room_number, room_type_id, floor, occupancy_status, "
        "cleaning_status, unavailability_source FROM rooms",
    ),
    (
        "ai_reservations",
        "SELECT id, reservation_no, room_id, room_type_id, check_in_date, "
        "check_out_date, status, source, external_reference, created_at, "
        "updated_at FROM reservations",
    ),
    (
        "ai_stays",
        "SELECT id, stay_no, reservation_id, room_id, status, actual_check_in_at, "
        "planned_check_out_date, actual_check_out_at, created_at, updated_at "
        "FROM stays",
    ),
    (
        "ai_stay_room_assignments",
        "SELECT id, stay_id, room_id, started_at, ended_at, reason, created_at "
        "FROM stay_room_assignments",
    ),
    (
        "ai_housekeeping_tasks",
        "SELECT id, task_no, room_id, status, priority, source, "
        "assigned_to_user_id, started_at, submitted_for_inspection_at, "
        "completed_at, cancelled_at, created_at, updated_at "
        "FROM housekeeping_tasks",
    ),
    (
        "ai_maintenance_work_orders",
        "SELECT id, work_order_no, room_id, category, severity, status, source, "
        "blocks_room, title, reported_by_user_id, assigned_to_user_id, "
        "started_at, resolved_at, verified_at, completed_at, cancelled_at, "
        "created_at, updated_at FROM maintenance_work_orders",
    ),
    (
        "ai_users",
        "SELECT id, username, display_name, is_active FROM users",
    ),
    # business 域（analytics:business_read 可见）
    (
        "ai_inventory_items",
        "SELECT id, item_code, name, category, base_unit, specification, "
        "minimum_stock, target_stock, is_consumable, is_active, created_at, "
        "updated_at FROM inventory_items",
    ),
    (
        "ai_inventory_locations",
        "SELECT id, location_code, name, is_active, created_at, updated_at "
        "FROM inventory_locations",
    ),
    (
        "ai_inventory_balances",
        "SELECT id, item_id, location_id, quantity, updated_at "
        "FROM inventory_balances",
    ),
    (
        "ai_stock_movements",
        "SELECT id, movement_no, item_id, location_id, movement_type, quantity, "
        "reference_type, reference_id, created_at FROM stock_movements",
    ),
    (
        "ai_stock_issues",
        "SELECT id, issue_no, source_location_id, destination_type, room_id, "
        "created_at FROM stock_issues",
    ),
    (
        "ai_stock_issue_lines",
        "SELECT id, issue_id, item_id, quantity FROM stock_issue_lines",
    ),
    (
        "ai_suppliers",
        "SELECT id, supplier_code, name, contact_name, is_active, created_at, "
        "updated_at FROM suppliers",
    ),
    (
        "ai_purchase_requests",
        "SELECT id, request_no, status, requested_by_user_id, submitted_at, "
        "approved_at, rejected_at, cancelled_at, created_at, updated_at "
        "FROM purchase_requests",
    ),
    (
        "ai_purchase_request_lines",
        "SELECT id, request_id, item_id, quantity FROM purchase_request_lines",
    ),
    (
        "ai_purchase_orders",
        "SELECT id, order_no, supplier_id, purchase_request_id, status, "
        "ordered_at, cancelled_at, created_at, updated_at FROM purchase_orders",
    ),
    (
        "ai_purchase_order_lines",
        "SELECT id, order_id, item_id, ordered_quantity, received_quantity, "
        "unit_price FROM purchase_order_lines",
    ),
    (
        "ai_goods_receipts",
        "SELECT id, receipt_no, purchase_order_id, inventory_location_id, "
        "received_by_user_id, received_at, created_at FROM goods_receipts",
    ),
    (
        "ai_goods_receipt_lines",
        "SELECT id, receipt_id, purchase_order_line_id, received_quantity "
        "FROM goods_receipt_lines",
    ),
]

# 角色创建/同步 SQL（幂等；密码来自后端配置，绝不进 Git）
def _role_sql(password: str) -> str:
    escaped = password.replace("'", "''")
    return f"""
    DO $$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{AI_READER_ROLE}') THEN
            CREATE ROLE {AI_READER_ROLE} LOGIN PASSWORD '{escaped}'
                NOSUPERUSER NOCREATEDB NOCREATEROLE;
        ELSE
            ALTER ROLE {AI_READER_ROLE} WITH LOGIN PASSWORD '{escaped}'
                NOSUPERUSER NOCREATEDB NOCREATEROLE;
        END IF;
    END $$;
    """


def _grant_sql(db_name: str) -> str:
    grants = "\n".join(
        f"GRANT SELECT ON {name} TO {AI_READER_ROLE};" for name, _ in AI_VIEWS
    )
    return f"""
    GRANT CONNECT ON DATABASE "{db_name}" TO {AI_READER_ROLE};
    REVOKE ALL ON SCHEMA public FROM {AI_READER_ROLE};
    GRANT USAGE ON SCHEMA public TO {AI_READER_ROLE};
    {grants}
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT ON TABLES TO {AI_READER_ROLE};
    """


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    db_name = make_url(settings.database_url).database or "stayops"

    # ------------------------------------------------------------------
    # 1) AI 配置与对话表
    # ------------------------------------------------------------------
    op.create_table(
        'ai_settings',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('provider', sa.String(32), nullable=False,
                  server_default='deepseek'),
        sa.Column('api_key_encrypted', sa.Text(), nullable=True),
        sa.Column('model', sa.String(64), nullable=True),
        sa.Column('updated_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_check_constraint(
        'ck_ai_settings_single_row', 'ai_settings', 'id = 1',
    )

    op.create_table(
        'ai_conversations',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id',
                  ondelete='CASCADE'), nullable=False),
        sa.Column('title', sa.String(200), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_ai_conversations_user_id',
                    'ai_conversations', ['user_id'])

    op.create_table(
        'ai_messages',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('conversation_id', sa.Integer,
                  sa.ForeignKey('ai_conversations.id', ondelete='CASCADE'),
                  nullable=False),
        sa.Column('role', sa.String(16), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('model', sa.String(64), nullable=True),
        sa.Column('provider', sa.String(32), nullable=True),
        sa.Column('usage_json', sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_ai_messages_conversation_id',
                    'ai_messages', ['conversation_id'])
    op.create_check_constraint(
        'ck_ai_messages_role', 'ai_messages', "role IN ('user', 'assistant', 'tool')",
    )

    # ------------------------------------------------------------------
    # 2) AI 只读视图（数据库级表/字段白名单）
    # ------------------------------------------------------------------
    for name, select_sql in AI_VIEWS:
        op.execute(f"CREATE VIEW {name} AS {select_sql}")

    # ------------------------------------------------------------------
    # 3) stayops_ai_reader 只读 Role（数据库级写保护）
    # ------------------------------------------------------------------
    op.execute(sa.text(_role_sql(settings.ai_reader_database_password)))
    op.execute(sa.text(_grant_sql(db_name)))


def downgrade() -> None:
    """Downgrade schema.

    角色为集群级对象：不 DROP ROLE（可能被其它数据库引用），只撤销授权。
    """
    bind = op.get_bind()

    for name, _ in reversed(AI_VIEWS):
        op.execute(f"DROP VIEW IF EXISTS {name}")

    op.execute(
        sa.text(
            f"ALTER DEFAULT PRIVILEGES IN SCHEMA public "
            f"REVOKE SELECT ON TABLES FROM {AI_READER_ROLE};"
        )
    )
    op.execute(
        sa.text(f"REVOKE ALL ON SCHEMA public FROM {AI_READER_ROLE};")
    )
    op.execute(
        sa.text(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {AI_READER_ROLE};")
    )

    op.drop_index('ix_ai_messages_conversation_id', table_name='ai_messages')
    op.drop_table('ai_messages')
    op.drop_index('ix_ai_conversations_user_id', table_name='ai_conversations')
    op.drop_table('ai_conversations')
    op.drop_table('ai_settings')
