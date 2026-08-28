"""库存域 schemas（Sprint 7）。

原则：
- 写 schema 一律 strict（extra=forbid、空 payload 422）。
- quantity / 库存量使用 Decimal（JSON 序列化为字符串，沿用金额约定，
  规避浮点精度问题）。
- 不允许任何直接 PATCH quantity / current_stock / balance 的通道：
  库存变化只能来自业务动作（INITIAL / ISSUE / RETURN / TRANSFER /
  ADJUSTMENT / PURCHASE_RECEIPT）。
"""

import enum
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.inventory import IssueDestinationType, ItemCategory, MovementType


class StockStatus(str, enum.Enum):
    NORMAL = "NORMAL"
    LOW_STOCK = "LOW_STOCK"
    OUT_OF_STOCK = "OUT_OF_STOCK"


# ---------------------------------------------------------------------------
# InventoryItem
# ---------------------------------------------------------------------------


class InventoryItemCreate(BaseModel):
    """创建物资。item_code 唯一且创建后不可变（Update 不含该字段）。"""

    model_config = ConfigDict(extra="forbid")

    item_code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    category: ItemCategory
    base_unit: str = Field(..., min_length=1, max_length=20)
    specification: str | None = Field(None, max_length=200)
    minimum_stock: Decimal = Field(Decimal("0"), ge=0)
    target_stock: Decimal = Field(Decimal("0"), ge=0)
    is_consumable: bool = True
    notes: str | None = Field(None, max_length=500)

    @model_validator(mode="after")
    def _target_ge_minimum(self) -> "InventoryItemCreate":
        if self.target_stock < self.minimum_stock:
            raise ValueError("目标库存不能小于最低库存")
        return self


class InventoryItemUpdate(BaseModel):
    """PATCH：strict schema。item_code 不可修改（创建后不可变）。

    空 payload 422；minimum/target 的最终配对校验（target >= minimum）
    由 service 基于当前值完成。
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=100)
    category: ItemCategory | None = None
    base_unit: str | None = Field(None, min_length=1, max_length=20)
    specification: str | None = Field(None, max_length=200)
    minimum_stock: Decimal | None = Field(None, ge=0)
    target_stock: Decimal | None = Field(None, ge=0)
    is_consumable: bool | None = None
    is_active: bool | None = None
    notes: str | None = Field(None, max_length=500)

    @model_validator(mode="after")
    def _reject_empty(self) -> "InventoryItemUpdate":
        if not self.model_fields_set:
            raise ValueError("至少提供一个可更新字段")
        return self


class InventoryItemOut(BaseModel):
    id: int
    item_code: str
    name: str
    category: ItemCategory
    base_unit: str
    specification: str | None = None
    minimum_stock: Decimal
    target_stock: Decimal
    is_consumable: bool
    is_active: bool
    notes: str | None = None
    created_at: datetime
    updated_at: datetime


class InventoryBalanceOut(BaseModel):
    id: int
    item_id: int
    location_id: int
    location_code: str
    location_name: str
    location_active: bool
    quantity: Decimal
    updated_at: datetime


class StockMovementOut(BaseModel):
    id: int
    movement_no: str
    item_id: int
    item_code: str
    item_name: str
    location_id: int
    location_code: str
    location_name: str
    movement_type: MovementType
    quantity: Decimal
    reference_type: str | None = None
    reference_id: int | None = None
    reason: str | None = None
    created_by_user_id: int | None = None
    operator_name: str | None = None
    created_at: datetime


class InventoryItemListRow(BaseModel):
    """列表行：聚合 total_stock + 低库存状态（Sprint 7 §19/§20）。"""

    id: int
    item_code: str
    name: str
    category: ItemCategory
    base_unit: str
    minimum_stock: Decimal
    target_stock: Decimal
    is_consumable: bool
    is_active: bool
    total_stock: Decimal
    stock_status: StockStatus
    recommended_replenishment: Decimal


class InventoryItemDetailOut(BaseModel):
    id: int
    item_code: str
    name: str
    category: ItemCategory
    base_unit: str
    specification: str | None = None
    minimum_stock: Decimal
    target_stock: Decimal
    is_consumable: bool
    is_active: bool
    notes: str | None = None
    total_stock: Decimal
    stock_status: StockStatus
    recommended_replenishment: Decimal
    balances: list[InventoryBalanceOut]
    recent_movements: list[StockMovementOut]
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# InventoryLocation
# ---------------------------------------------------------------------------


class InventoryLocationOut(BaseModel):
    id: int
    location_code: str
    name: str
    is_active: bool
    notes: str | None = None
    created_at: datetime
    updated_at: datetime


class InventoryLocationUpdate(BaseModel):
    """PATCH：strict schema；停用用 is_active（不物理删除）。"""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=100)
    is_active: bool | None = None
    notes: str | None = Field(None, max_length=500)

    @model_validator(mode="after")
    def _reject_empty(self) -> "InventoryLocationUpdate":
        if not self.model_fields_set:
            raise ValueError("至少提供一个可更新字段")
        return self


# ---------------------------------------------------------------------------
# Initial stock / Issue / Return / Transfer / Stocktake
# ---------------------------------------------------------------------------


class InitialStockCreate(BaseModel):
    """期初库存（Sprint 7 §10）：必须通过专用动作，形成 INITIAL movement。"""

    model_config = ConfigDict(extra="forbid")

    location_id: int
    quantity: Decimal = Field(..., ge=0)
    reason: str | None = Field(None, max_length=500)


class IssueLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: int
    quantity: Decimal = Field(..., gt=0)


class StockIssueCreate(BaseModel):
    """领用单（Sprint 7 §11）：多行领用整体原子。

    destination_type=ROOM 时 room_id 必填；其它类型 room_id 不得误填（422）。
    """

    model_config = ConfigDict(extra="forbid")

    source_location_id: int
    destination_type: IssueDestinationType
    room_id: int | None = None
    notes: str | None = Field(None, max_length=500)
    lines: list[IssueLineIn] = Field(..., min_length=1)

    @model_validator(mode="after")
    def _room_id_consistency(self) -> "StockIssueCreate":
        if self.destination_type == IssueDestinationType.ROOM:
            if self.room_id is None:
                raise ValueError("领用目的地为房间时必须指定 room_id")
        elif self.room_id is not None:
            raise ValueError("仅领用目的地为房间时可填写 room_id")
        if len({line.item_id for line in self.lines}) != len(self.lines):
            raise ValueError("同一领用单不允许重复物资行")
        return self


class StockIssueLineOut(BaseModel):
    id: int
    item_id: int
    item_code: str
    item_name: str
    base_unit: str
    quantity: Decimal


class StockIssueOut(BaseModel):
    id: int
    issue_no: str
    source_location_id: int
    source_location_name: str
    destination_type: IssueDestinationType
    room_id: int | None = None
    notes: str | None = None
    created_by_user_id: int | None = None
    operator_name: str | None = None
    created_at: datetime
    lines: list[StockIssueLineOut]


class StockReturnCreate(BaseModel):
    """退货/归还（Sprint 7 §15）：专用简单 API，形成 RETURN movement。"""

    model_config = ConfigDict(extra="forbid")

    item_id: int
    location_id: int
    quantity: Decimal = Field(..., gt=0)
    reason: str = Field(..., min_length=1, max_length=500)


class TransferLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: int
    quantity: Decimal = Field(..., gt=0)


class StockTransferCreate(BaseModel):
    """库间调拨（Sprint 7 §16）：多行整体原子；source/destination 不能相同。"""

    model_config = ConfigDict(extra="forbid")

    source_location_id: int
    destination_location_id: int
    reason: str | None = Field(None, max_length=500)
    lines: list[TransferLineIn] = Field(..., min_length=1)

    @model_validator(mode="after")
    def _distinct_locations(self) -> "StockTransferCreate":
        if self.source_location_id == self.destination_location_id:
            raise ValueError("调拨来源与目的地不能相同")
        if len({line.item_id for line in self.lines}) != len(self.lines):
            raise ValueError("同一调拨单不允许重复物资行")
        return self


class StockTransferOut(BaseModel):
    source_location_id: int
    source_location_name: str
    destination_location_id: int
    destination_location_name: str
    reason: str | None = None
    created_by_user_id: int | None = None
    operator_name: str | None = None
    created_at: datetime
    lines: list[StockIssueLineOut]
    movement_ids: list[int]


class StocktakeCreate(BaseModel):
    """盘点/调整（Sprint 7 §18）：expected = 锁定余额，actual 为用户输入。"""

    model_config = ConfigDict(extra="forbid")

    item_id: int
    location_id: int
    actual_quantity: Decimal = Field(..., ge=0)
    reason: str = Field(..., min_length=1, max_length=500)


class StocktakeOut(BaseModel):
    item_id: int
    item_code: str
    item_name: str
    location_id: int
    location_name: str
    expected_quantity: Decimal
    actual_quantity: Decimal
    difference: Decimal
    movement_type: MovementType | None = None
    movement_id: int | None = None
    balance_quantity: Decimal


class StockReturnOut(BaseModel):
    id: int
    movement_no: str
    item_id: int
    item_code: str
    item_name: str
    location_id: int
    location_name: str
    quantity: Decimal
    reason: str
    created_at: datetime


class InitialStockOut(BaseModel):
    id: int
    movement_no: str
    item_id: int
    item_code: str
    item_name: str
    location_id: int
    location_name: str
    quantity: Decimal
    balance_quantity: Decimal
    reason: str | None = None
    created_at: datetime
