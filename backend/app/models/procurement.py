"""采购域模型（Sprint 7）。

采购链（Sprint 7 §1 第二条运营链）：
    Low Stock -> Purchase Request -> Approval -> Purchase Order
    -> Goods Receipt -> Stock In

关键语义：
- 采购订单不改变库存（§33）：只有 Goods Receipt 创建
  PURCHASE_RECEIPT movement 并增加库存（§29/§30）。
- 部分收货（§31）：cumulative received <= ordered；
  PO 状态由收货推导（ORDERED -> PARTIALLY_RECEIVED -> RECEIVED）。
- 金额使用 Numeric/Decimal（§34），禁止 float 存金额；
  S7 不做 payment / payable / invoice accounting / tax / ledger。
- 不物理删除（§47）：Supplier / PR / PO / Receipt / Movement 均无 DELETE。
"""

import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.inventory import InventoryItem, InventoryLocation
from app.models.user import User


class PurchaseRequestStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    ORDERED = "ORDERED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"


class PurchaseOrderStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    ORDERED = "ORDERED"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    RECEIVED = "RECEIVED"
    CANCELLED = "CANCELLED"


class Supplier(Base):
    """供应商（Sprint 7 §22）。不做 bank account / tax / contract / CRM。"""

    __tablename__ = "suppliers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    supplier_code: Mapped[str] = mapped_column(
        String(50), unique=True, nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(100))
    phone: Mapped[str | None] = mapped_column(String(32))
    wechat: Mapped[str | None] = mapped_column(String(100))
    notes: Mapped[str | None] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class PurchaseRequest(Base):
    """采购申请（Sprint 7 §23/§24）。

    状态机（Alpha.7，后端唯一权威，不允许 generic PATCH status 绕过）：
        DRAFT -> SUBMITTED -> APPROVED -> ORDERED
        SUBMITTED -> REJECTED（终态，不允许 REJECTED -> APPROVED）
        APPROVED -> CANCELLED / DRAFT -> CANCELLED
    审批与申请分离（§25）：approve / reject 为专用 action 端点。
    """

    __tablename__ = "purchase_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_no: Mapped[str] = mapped_column(
        String(40), unique=True, nullable=False
    )
    status: Mapped[PurchaseRequestStatus] = mapped_column(
        Enum(
            PurchaseRequestStatus,
            name="purchase_request_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=PurchaseRequestStatus.DRAFT,
        server_default=PurchaseRequestStatus.DRAFT.value,
        index=True,
    )
    requested_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    requested_by: Mapped[User | None] = relationship(
        foreign_keys=[requested_by_user_id]
    )
    approved_by: Mapped[User | None] = relationship(
        foreign_keys=[approved_by_user_id]
    )
    lines: Mapped[list["PurchaseRequestLine"]] = relationship(
        back_populates="request", cascade="all, delete-orphan"
    )


class PurchaseRequestLine(Base):
    __tablename__ = "purchase_request_lines"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_requests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    notes: Mapped[str | None] = mapped_column(String(500))

    request: Mapped[PurchaseRequest] = relationship(back_populates="lines")
    item: Mapped[InventoryItem] = relationship()


class PurchaseOrder(Base):
    """采购订单（Sprint 7 §26/§27）。

    - purchase_request_id 唯一（§28）：Alpha.7 一张 PurchaseRequest
      至多转一张 PurchaseOrder；直接创建无 Request 的 PO 仅
      SUPER_ADMIN / MANAGER（procurement:order）。
    - 状态机：DRAFT -> ORDERED -> PARTIALLY_RECEIVED -> RECEIVED；
      DRAFT / ORDERED / PARTIALLY_RECEIVED -> CANCELLED（§27，
      部分收货后取消 = 不再收剩余数量，已收货库存与历史保持）；
      RECEIVED 为终态不可取消。
    - PO 不改变库存（§33）；金额仅表示采购业务金额（§34）。
    """

    __tablename__ = "purchase_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_no: Mapped[str] = mapped_column(
        String(40), unique=True, nullable=False
    )
    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("suppliers.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    purchase_request_id: Mapped[int | None] = mapped_column(
        ForeignKey("purchase_requests.id", ondelete="RESTRICT"),
        nullable=True,
        unique=True,
    )
    status: Mapped[PurchaseOrderStatus] = mapped_column(
        Enum(
            PurchaseOrderStatus,
            name="purchase_order_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=PurchaseOrderStatus.DRAFT,
        server_default=PurchaseOrderStatus.DRAFT.value,
        index=True,
    )
    ordered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    notes: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    supplier: Mapped[Supplier] = relationship()
    purchase_request: Mapped[PurchaseRequest | None] = relationship()
    created_by: Mapped[User | None] = relationship(
        foreign_keys=[created_by_user_id]
    )
    lines: Mapped[list["PurchaseOrderLine"]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )
    receipts: Mapped[list["GoodsReceipt"]] = relationship(
        back_populates="purchase_order"
    )


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"
    __table_args__ = (
        CheckConstraint("ordered_quantity > 0", name="ordered_quantity_positive"),
        CheckConstraint("received_quantity >= 0", name="received_non_negative"),
        CheckConstraint(
            "received_quantity <= ordered_quantity",
            name="received_le_ordered",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_orders.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    ordered_quantity: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False
    )
    received_quantity: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0"), server_default="0"
    )
    unit_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))

    order: Mapped[PurchaseOrder] = relationship(back_populates="lines")
    item: Mapped[InventoryItem] = relationship()
    receipt_lines: Mapped[list["GoodsReceiptLine"]] = relationship(
        back_populates="order_line"
    )


class GoodsReceipt(Base):
    """收货单（Sprint 7 §29/§30）：收货才真正增加库存。

    收货事务必须原子（§30）：lock PurchaseOrder -> lock PO lines ->
    校验 received <= remaining -> lock/create InventoryBalance ->
    create GoodsReceipt -> update received_quantity ->
    create PURCHASE_RECEIPT movements -> update balances ->
    update PO status -> audit -> commit；任一行超收 entire rollback。
    不允许删除历史 Goods Receipt（§27/§47）。
    """

    __tablename__ = "goods_receipts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    receipt_no: Mapped[str] = mapped_column(
        String(40), unique=True, nullable=False
    )
    purchase_order_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_orders.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    inventory_location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    received_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    purchase_order: Mapped[PurchaseOrder] = relationship(
        back_populates="receipts"
    )
    inventory_location: Mapped[InventoryLocation] = relationship()
    received_by: Mapped[User | None] = relationship(
        foreign_keys=[received_by_user_id]
    )
    lines: Mapped[list["GoodsReceiptLine"]] = relationship(
        back_populates="receipt", cascade="all, delete-orphan"
    )


class GoodsReceiptLine(Base):
    __tablename__ = "goods_receipt_lines"
    __table_args__ = (
        CheckConstraint("received_quantity > 0", name="received_quantity_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    receipt_id: Mapped[int] = mapped_column(
        ForeignKey("goods_receipts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    purchase_order_line_id: Mapped[int] = mapped_column(
        ForeignKey("purchase_order_lines.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    received_quantity: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False
    )

    receipt: Mapped[GoodsReceipt] = relationship(back_populates="lines")
    order_line: Mapped[PurchaseOrderLine] = relationship(
        back_populates="receipt_lines"
    )
