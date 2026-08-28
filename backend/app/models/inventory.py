"""库存域模型（Sprint 7）。

领域语义（Sprint 7 §2 LOCKED Architecture Decision）：
- StockMovement（库存流水）= 永久库存账本事实（immutable ledger fact）。
  不允许普通 PATCH / DELETE；修正库存只能使用新的
  ADJUSTMENT_IN / ADJUSTMENT_OUT movement。
- InventoryBalance（库存余额）= Projection（投影），不是独立事实。
  每次库存事务必须：create StockMovement + update InventoryBalance
  在同一数据库事务完成（no movement = no stock change）。
- 所有库存变化必须来自业务动作：
  INITIAL / PURCHASE_RECEIPT / ISSUE / RETURN / TRANSFER_OUT /
  TRANSFER_IN / ADJUSTMENT_IN / ADJUSTMENT_OUT。
- 多库存地点（Alpha.7 第一版即支持）：MAIN_STORAGE / FRONT_DESK /
  HOUSEKEEPING / MAINTENANCE 等，不做复杂多酒店仓储网络。
- 不自动扣账（§2.4）：Checkout / Housekeeping completion / Room Move
  都不得自动扣减客耗品库存；库存变化只能来自真实业务操作。
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
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.room import Room
from app.models.user import User


class ItemCategory(str, enum.Enum):
    GUEST_AMENITY = "GUEST_AMENITY"
    LINEN = "LINEN"
    CLEANING = "CLEANING"
    FRONT_DESK = "FRONT_DESK"
    MAINTENANCE = "MAINTENANCE"
    OFFICE = "OFFICE"
    OTHER = "OTHER"


class MovementType(str, enum.Enum):
    INITIAL = "INITIAL"
    PURCHASE_RECEIPT = "PURCHASE_RECEIPT"
    ISSUE = "ISSUE"
    RETURN = "RETURN"
    TRANSFER_OUT = "TRANSFER_OUT"
    TRANSFER_IN = "TRANSFER_IN"
    ADJUSTMENT_IN = "ADJUSTMENT_IN"
    ADJUSTMENT_OUT = "ADJUSTMENT_OUT"


class IssueDestinationType(str, enum.Enum):
    HOUSEKEEPING = "HOUSEKEEPING"
    FRONT_DESK = "FRONT_DESK"
    MAINTENANCE = "MAINTENANCE"
    ROOM = "ROOM"
    OTHER = "OTHER"


# 增加库存的 movement 类型（quantity > 0）
INCREASING_TYPES = (
    MovementType.PURCHASE_RECEIPT,
    MovementType.RETURN,
    MovementType.TRANSFER_IN,
    MovementType.ADJUSTMENT_IN,
)

# 减少库存的 movement 类型（quantity < 0）
DECREASING_TYPES = (
    MovementType.ISSUE,
    MovementType.TRANSFER_OUT,
    MovementType.ADJUSTMENT_OUT,
)


class InventoryItem(Base):
    """库存物资档案（Sprint 7 §3）。

    - item_code 唯一且创建后不可变（PATCH schema 不含 item_code）。
    - base_unit 唯一基础单位：采购/领用/调拨/盘点统一使用（§5，
      不做 Packaging Conversion）。
    - minimum_stock / target_stock 驱动低库存规则（§19）；
      target_stock >= minimum_stock（DB CHECK + service 校验）。
    """

    __tablename__ = "inventory_items"
    __table_args__ = (
        CheckConstraint(
            "minimum_stock >= 0", name="minimum_stock_non_negative"
        ),
        CheckConstraint("target_stock >= 0", name="target_stock_non_negative"),
        CheckConstraint(
            "target_stock >= minimum_stock", name="target_ge_minimum"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_code: Mapped[str] = mapped_column(
        String(50), unique=True, nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    category: Mapped[ItemCategory] = mapped_column(
        Enum(
            ItemCategory,
            name="item_category",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        index=True,
    )
    base_unit: Mapped[str] = mapped_column(String(20), nullable=False)
    specification: Mapped[str | None] = mapped_column(String(200))
    minimum_stock: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0"), server_default="0"
    )
    target_stock: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0"), server_default="0"
    )
    is_consumable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
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

    balances: Mapped[list["InventoryBalance"]] = relationship(
        back_populates="item"
    )


class InventoryLocation(Base):
    """库存地点（Sprint 7 §6）。种子 4 个地点：总仓 / 前台 / 保洁间 / 维修间。"""

    __tablename__ = "inventory_locations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    location_code: Mapped[str] = mapped_column(
        String(50), unique=True, nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
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

    balances: Mapped[list["InventoryBalance"]] = relationship(
        back_populates="location"
    )


class InventoryBalance(Base):
    """库存余额 Projection（Sprint 7 §2.2）。

    为快速查询建立的投影，不是独立事实；唯一 (item_id, location_id)。
    每次库存事务必须与 StockMovement 同事务更新，不允许只更新其一。
    """

    __tablename__ = "inventory_balances"
    __table_args__ = (
        UniqueConstraint("item_id", "location_id", name="uq_item_location"),
        CheckConstraint("quantity >= 0", name="quantity_non_negative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    quantity: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), nullable=False, default=Decimal("0"), server_default="0"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    item: Mapped[InventoryItem] = relationship(back_populates="balances")
    location: Mapped[InventoryLocation] = relationship(back_populates="balances")


class StockMovement(Base):
    """库存流水（Sprint 7 §8/§9）——永久库存账本事实，不可变。

    quantity 为 signed quantity：+ = 增加，- = 减少（§8）。
    业务层与 DB CHECK 共同保证符号规则：
        PURCHASE_RECEIPT / RETURN / TRANSFER_IN / ADJUSTMENT_IN > 0
        ISSUE / TRANSFER_OUT / ADJUSTMENT_OUT < 0
        INITIAL >= 0
    创建后不允许普通 PATCH / DELETE；修正库存使用新的
    ADJUSTMENT_IN / ADJUSTMENT_OUT movement。
    """

    __tablename__ = "stock_movements"
    __table_args__ = (
        CheckConstraint(
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
            name="quantity_sign_by_type",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    movement_no: Mapped[str] = mapped_column(
        String(40), unique=True, nullable=False
    )
    item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    movement_type: Mapped[MovementType] = mapped_column(
        Enum(
            MovementType,
            name="movement_type",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        index=True,
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    reference_type: Mapped[str | None] = mapped_column(String(50), index=True)
    reference_id: Mapped[int | None] = mapped_column(Integer, index=True)
    reason: Mapped[str | None] = mapped_column(String(500))
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    item: Mapped[InventoryItem] = relationship()
    location: Mapped[InventoryLocation] = relationship()
    created_by: Mapped[User | None] = relationship(
        foreign_keys=[created_by_user_id]
    )


class StockIssue(Base):
    """领用单（Sprint 7 §11）：一张领用单允许多个 Item，全部原子。"""

    __tablename__ = "stock_issues"
    __table_args__ = (
        CheckConstraint(
            "(destination_type = 'ROOM' AND room_id IS NOT NULL) OR "
            "(destination_type <> 'ROOM' AND room_id IS NULL)",
            name="room_id_matches_destination",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    issue_no: Mapped[str] = mapped_column(
        String(40), unique=True, nullable=False
    )
    source_location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    destination_type: Mapped[IssueDestinationType] = mapped_column(
        Enum(
            IssueDestinationType,
            name="issue_destination_type",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
    )
    room_id: Mapped[int | None] = mapped_column(
        ForeignKey("rooms.id", ondelete="RESTRICT"), nullable=True
    )
    notes: Mapped[str | None] = mapped_column(String(500))
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    source_location: Mapped[InventoryLocation] = relationship(
        foreign_keys=[source_location_id]
    )
    room: Mapped[Room | None] = relationship()
    created_by: Mapped[User | None] = relationship(
        foreign_keys=[created_by_user_id]
    )
    lines: Mapped[list["StockIssueLine"]] = relationship(
        back_populates="issue", cascade="all, delete-orphan"
    )


class StockIssueLine(Base):
    __tablename__ = "stock_issue_lines"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    issue_id: Mapped[int] = mapped_column(
        ForeignKey("stock_issues.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    issue: Mapped[StockIssue] = relationship(back_populates="lines")
    item: Mapped[InventoryItem] = relationship()
