"""add inventory and procurement domain

Revision ID: e3a91f5c8d24
Revises: c8e2b7a4d1f3
Create Date: 2026-08-28 22:00:00.000000

Sprint 7 Inventory & Procurement（决策见 docs/DECISIONS.md）：
- Inventory 域：
  - inventory_items（物资档案；item_code 唯一不可变；CHECK target >= minimum）
  - inventory_locations（多库存地点）
  - inventory_balances（余额 Projection；UNIQUE(item_id, location_id)；CHECK quantity >= 0）
  - stock_movements（不可变库存账本；signed quantity；CHECK 按类型校验符号）
  - stock_issues / stock_issue_lines（多行领用单；ROOM 目的地 room_id 一致性 CHECK）
- Procurement 域：
  - suppliers（is_active 停用，无 DELETE）
  - purchase_requests / purchase_request_lines（PR 状态机）
  - purchase_orders / purchase_order_lines（received <= ordered CHECK；
    purchase_request_id UNIQUE = 一张 PR 至多一张 PO）
  - goods_receipts / goods_receipt_lines（收货才是库存增加权威）
- 业务单号 Sequence（原子取号 + UNIQUE 兜底，禁止 SELECT MAX+1）：
  stock_movement_no_seq / stock_issue_no_seq / purchase_request_no_seq /
  purchase_order_no_seq / goods_receipt_no_seq
- PG 枚举：item_category / movement_type / issue_destination_type /
  purchase_request_status / purchase_order_status
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e3a91f5c8d24'
down_revision: Union[str, Sequence[str], None] = 'c8e2b7a4d1f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


ITEM_CATEGORY_ENUM = sa.dialects.postgresql.ENUM(
    'GUEST_AMENITY', 'LINEN', 'CLEANING', 'FRONT_DESK',
    'MAINTENANCE', 'OFFICE', 'OTHER',
    name='item_category', create_type=False,
)

MOVEMENT_TYPE_ENUM = sa.dialects.postgresql.ENUM(
    'INITIAL', 'PURCHASE_RECEIPT', 'ISSUE', 'RETURN',
    'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
    name='movement_type', create_type=False,
)

ISSUE_DESTINATION_ENUM = sa.dialects.postgresql.ENUM(
    'HOUSEKEEPING', 'FRONT_DESK', 'MAINTENANCE', 'ROOM', 'OTHER',
    name='issue_destination_type', create_type=False,
)

PURCHASE_REQUEST_STATUS_ENUM = sa.dialects.postgresql.ENUM(
    'DRAFT', 'SUBMITTED', 'APPROVED', 'ORDERED', 'REJECTED', 'CANCELLED',
    name='purchase_request_status', create_type=False,
)

PURCHASE_ORDER_STATUS_ENUM = sa.dialects.postgresql.ENUM(
    'DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED',
    name='purchase_order_status', create_type=False,
)


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()

    for enum in (
        ITEM_CATEGORY_ENUM,
        MOVEMENT_TYPE_ENUM,
        ISSUE_DESTINATION_ENUM,
        PURCHASE_REQUEST_STATUS_ENUM,
        PURCHASE_ORDER_STATUS_ENUM,
    ):
        enum.create(bind, checkfirst=True)

    # ------------------------------------------------------------------
    # Inventory 域
    # ------------------------------------------------------------------

    op.create_table(
        'inventory_items',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('item_code', sa.String(50), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('category', ITEM_CATEGORY_ENUM, nullable=False),
        sa.Column('base_unit', sa.String(20), nullable=False),
        sa.Column('specification', sa.String(200), nullable=True),
        sa.Column('minimum_stock', sa.Numeric(12, 2), nullable=False,
                  server_default='0'),
        sa.Column('target_stock', sa.Numeric(12, 2), nullable=False,
                  server_default='0'),
        sa.Column('is_consumable', sa.Boolean, nullable=False,
                  server_default=sa.true()),
        sa.Column('is_active', sa.Boolean, nullable=False,
                  server_default=sa.true()),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_inventory_items_item_code',
                    'inventory_items', ['item_code'], unique=True)
    op.create_index('ix_inventory_items_category',
                    'inventory_items', ['category'])
    op.create_check_constraint(
        'ck_inventory_items_minimum_stock_non_negative',
        'inventory_items', 'minimum_stock >= 0',
    )
    op.create_check_constraint(
        'ck_inventory_items_target_stock_non_negative',
        'inventory_items', 'target_stock >= 0',
    )
    op.create_check_constraint(
        'ck_inventory_items_target_ge_minimum',
        'inventory_items', 'target_stock >= minimum_stock',
    )

    op.create_table(
        'inventory_locations',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('location_code', sa.String(50), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('is_active', sa.Boolean, nullable=False,
                  server_default=sa.true()),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_inventory_locations_location_code',
                    'inventory_locations', ['location_code'], unique=True)

    op.create_table(
        'inventory_balances',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('item_id', sa.Integer,
                  sa.ForeignKey('inventory_items.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('location_id', sa.Integer,
                  sa.ForeignKey('inventory_locations.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('quantity', sa.Numeric(12, 2), nullable=False,
                  server_default='0'),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.UniqueConstraint('item_id', 'location_id',
                            name='uq_item_location'),
        sa.CheckConstraint('quantity >= 0', name='quantity_non_negative'),
    )
    op.create_index('ix_inventory_balances_item_id',
                    'inventory_balances', ['item_id'])
    op.create_index('ix_inventory_balances_location_id',
                    'inventory_balances', ['location_id'])

    op.create_table(
        'stock_movements',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('movement_no', sa.String(40), nullable=False),
        sa.Column('item_id', sa.Integer,
                  sa.ForeignKey('inventory_items.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('location_id', sa.Integer,
                  sa.ForeignKey('inventory_locations.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('movement_type', MOVEMENT_TYPE_ENUM, nullable=False),
        sa.Column('quantity', sa.Numeric(12, 2), nullable=False),
        sa.Column('reference_type', sa.String(50), nullable=True),
        sa.Column('reference_id', sa.Integer, nullable=True),
        sa.Column('reason', sa.String(500), nullable=True),
        sa.Column('created_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'),
                  nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.CheckConstraint(
            "("
            "movement_type IN "
            "('PURCHASE_RECEIPT','RETURN','TRANSFER_IN','ADJUSTMENT_IN') "
            "AND quantity > 0"
            ") OR ("
            "movement_type IN ('ISSUE','TRANSFER_OUT','ADJUSTMENT_OUT') "
            "AND quantity < 0"
            ") OR ("
            "movement_type = 'INITIAL' AND quantity >= 0"
            ")",
            name='quantity_sign_by_type',
        ),
    )
    op.create_index('ix_stock_movements_movement_no',
                    'stock_movements', ['movement_no'], unique=True)
    op.create_index('ix_stock_movements_item_id',
                    'stock_movements', ['item_id'])
    op.create_index('ix_stock_movements_location_id',
                    'stock_movements', ['location_id'])
    op.create_index('ix_stock_movements_movement_type',
                    'stock_movements', ['movement_type'])
    op.create_index('ix_stock_movements_reference_type',
                    'stock_movements', ['reference_type'])
    op.create_index('ix_stock_movements_reference_id',
                    'stock_movements', ['reference_id'])

    op.create_table(
        'stock_issues',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('issue_no', sa.String(40), nullable=False),
        sa.Column('source_location_id', sa.Integer,
                  sa.ForeignKey('inventory_locations.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('destination_type', ISSUE_DESTINATION_ENUM, nullable=False),
        sa.Column('room_id', sa.Integer,
                  sa.ForeignKey('rooms.id', ondelete='RESTRICT'),
                  nullable=True),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('created_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'),
                  nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.CheckConstraint(
            "(destination_type = 'ROOM' AND room_id IS NOT NULL) OR "
            "(destination_type <> 'ROOM' AND room_id IS NULL)",
            name='room_id_matches_destination',
        ),
    )
    op.create_index('ix_stock_issues_issue_no',
                    'stock_issues', ['issue_no'], unique=True)
    op.create_index('ix_stock_issues_source_location_id',
                    'stock_issues', ['source_location_id'])

    op.create_table(
        'stock_issue_lines',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('issue_id', sa.Integer,
                  sa.ForeignKey('stock_issues.id', ondelete='CASCADE'),
                  nullable=False),
        sa.Column('item_id', sa.Integer,
                  sa.ForeignKey('inventory_items.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('quantity', sa.Numeric(12, 2), nullable=False),
        sa.CheckConstraint('quantity > 0', name='quantity_positive'),
    )
    op.create_index('ix_stock_issue_lines_issue_id',
                    'stock_issue_lines', ['issue_id'])
    op.create_index('ix_stock_issue_lines_item_id',
                    'stock_issue_lines', ['item_id'])

    # ------------------------------------------------------------------
    # Procurement 域
    # ------------------------------------------------------------------

    op.create_table(
        'suppliers',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('supplier_code', sa.String(50), nullable=False),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('contact_name', sa.String(100), nullable=True),
        sa.Column('phone', sa.String(32), nullable=True),
        sa.Column('wechat', sa.String(100), nullable=True),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('is_active', sa.Boolean, nullable=False,
                  server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_suppliers_supplier_code',
                    'suppliers', ['supplier_code'], unique=True)

    op.create_table(
        'purchase_requests',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('request_no', sa.String(40), nullable=False),
        sa.Column('status', PURCHASE_REQUEST_STATUS_ENUM, nullable=False,
                  server_default='DRAFT'),
        sa.Column('requested_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'),
                  nullable=True),
        sa.Column('approved_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'),
                  nullable=True),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('rejected_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_purchase_requests_request_no',
                    'purchase_requests', ['request_no'], unique=True)
    op.create_index('ix_purchase_requests_status',
                    'purchase_requests', ['status'])

    op.create_table(
        'purchase_request_lines',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('request_id', sa.Integer,
                  sa.ForeignKey('purchase_requests.id', ondelete='CASCADE'),
                  nullable=False),
        sa.Column('item_id', sa.Integer,
                  sa.ForeignKey('inventory_items.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('quantity', sa.Numeric(12, 2), nullable=False),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.CheckConstraint('quantity > 0', name='quantity_positive'),
    )
    op.create_index('ix_purchase_request_lines_request_id',
                    'purchase_request_lines', ['request_id'])
    op.create_index('ix_purchase_request_lines_item_id',
                    'purchase_request_lines', ['item_id'])

    op.create_table(
        'purchase_orders',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('order_no', sa.String(40), nullable=False),
        sa.Column('supplier_id', sa.Integer,
                  sa.ForeignKey('suppliers.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('purchase_request_id', sa.Integer,
                  sa.ForeignKey('purchase_requests.id', ondelete='RESTRICT'),
                  nullable=True),
        sa.Column('status', PURCHASE_ORDER_STATUS_ENUM, nullable=False,
                  server_default='DRAFT'),
        sa.Column('ordered_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'),
                  nullable=True),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_purchase_orders_order_no',
                    'purchase_orders', ['order_no'], unique=True)
    op.create_index('ix_purchase_orders_supplier_id',
                    'purchase_orders', ['supplier_id'])
    op.create_index('ix_purchase_orders_status',
                    'purchase_orders', ['status'])
    # 一张 PurchaseRequest 至多一张 PurchaseOrder（Sprint 7 §28，DB 最终仲裁）
    op.create_unique_constraint(
        'uq_purchase_orders_purchase_request_id',
        'purchase_orders', ['purchase_request_id'],
    )

    op.create_table(
        'purchase_order_lines',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('order_id', sa.Integer,
                  sa.ForeignKey('purchase_orders.id', ondelete='CASCADE'),
                  nullable=False),
        sa.Column('item_id', sa.Integer,
                  sa.ForeignKey('inventory_items.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('ordered_quantity', sa.Numeric(12, 2), nullable=False),
        sa.Column('received_quantity', sa.Numeric(12, 2), nullable=False,
                  server_default='0'),
        sa.Column('unit_price', sa.Numeric(12, 2), nullable=True),
        sa.CheckConstraint('ordered_quantity > 0',
                           name='ordered_quantity_positive'),
        sa.CheckConstraint('received_quantity >= 0',
                           name='received_non_negative'),
        sa.CheckConstraint('received_quantity <= ordered_quantity',
                           name='received_le_ordered'),
    )
    op.create_index('ix_purchase_order_lines_order_id',
                    'purchase_order_lines', ['order_id'])
    op.create_index('ix_purchase_order_lines_item_id',
                    'purchase_order_lines', ['item_id'])

    op.create_table(
        'goods_receipts',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('receipt_no', sa.String(40), nullable=False),
        sa.Column('purchase_order_id', sa.Integer,
                  sa.ForeignKey('purchase_orders.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('inventory_location_id', sa.Integer,
                  sa.ForeignKey('inventory_locations.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('received_by_user_id', sa.Integer,
                  sa.ForeignKey('users.id', ondelete='SET NULL'),
                  nullable=True),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('notes', sa.String(500), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
    )
    op.create_index('ix_goods_receipts_receipt_no',
                    'goods_receipts', ['receipt_no'], unique=True)
    op.create_index('ix_goods_receipts_purchase_order_id',
                    'goods_receipts', ['purchase_order_id'])
    op.create_index('ix_goods_receipts_inventory_location_id',
                    'goods_receipts', ['inventory_location_id'])

    op.create_table(
        'goods_receipt_lines',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('receipt_id', sa.Integer,
                  sa.ForeignKey('goods_receipts.id', ondelete='CASCADE'),
                  nullable=False),
        sa.Column('purchase_order_line_id', sa.Integer,
                  sa.ForeignKey('purchase_order_lines.id', ondelete='RESTRICT'),
                  nullable=False),
        sa.Column('received_quantity', sa.Numeric(12, 2), nullable=False),
        sa.CheckConstraint('received_quantity > 0',
                           name='received_quantity_positive'),
    )
    op.create_index('ix_goods_receipt_lines_receipt_id',
                    'goods_receipt_lines', ['receipt_id'])
    op.create_index('ix_goods_receipt_lines_purchase_order_line_id',
                    'goods_receipt_lines', ['purchase_order_line_id'])

    # ------------------------------------------------------------------
    # 业务单号 Sequence（原子取号，禁止 SELECT MAX+1）
    # ------------------------------------------------------------------

    op.execute('CREATE SEQUENCE stock_movement_no_seq')
    op.execute('CREATE SEQUENCE stock_issue_no_seq')
    op.execute('CREATE SEQUENCE purchase_request_no_seq')
    op.execute('CREATE SEQUENCE purchase_order_no_seq')
    op.execute('CREATE SEQUENCE goods_receipt_no_seq')


def downgrade() -> None:
    """Downgrade schema（仅用于测试库往返验证；正常开发库禁止降级）。"""
    bind = op.get_bind()

    op.execute('DROP SEQUENCE goods_receipt_no_seq')
    op.execute('DROP SEQUENCE purchase_order_no_seq')
    op.execute('DROP SEQUENCE purchase_request_no_seq')
    op.execute('DROP SEQUENCE stock_issue_no_seq')
    op.execute('DROP SEQUENCE stock_movement_no_seq')

    op.drop_table('goods_receipt_lines')
    op.drop_table('goods_receipts')
    op.drop_table('purchase_order_lines')
    op.drop_table('purchase_orders')
    op.drop_table('purchase_request_lines')
    op.drop_table('purchase_requests')
    op.drop_table('suppliers')
    op.drop_table('stock_issue_lines')
    op.drop_table('stock_issues')
    op.drop_table('stock_movements')
    op.drop_table('inventory_balances')
    op.drop_table('inventory_locations')
    op.drop_table('inventory_items')

    for enum in (
        PURCHASE_ORDER_STATUS_ENUM,
        PURCHASE_REQUEST_STATUS_ENUM,
        ISSUE_DESTINATION_ENUM,
        MOVEMENT_TYPE_ENUM,
        ITEM_CATEGORY_ENUM,
    ):
        enum.drop(bind, checkfirst=True)
