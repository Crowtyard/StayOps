"""采购域 schemas（Sprint 7）。

原则：
- 写 schema 一律 strict（extra=forbid）。
- 状态只能经专用 action 端点变更（submit / approve / reject / cancel /
  order / cancel / receipts）；不允许 generic PATCH status 绕过状态机。
- 金额使用 Decimal（JSON 序列化为字符串；禁止 float 存金额，Sprint 7 §34）。
- 不物理删除（无 DELETE 端点）。
"""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.procurement import PurchaseOrderStatus, PurchaseRequestStatus


# ---------------------------------------------------------------------------
# Supplier
# ---------------------------------------------------------------------------


class SupplierCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    supplier_code: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=100)
    contact_name: str | None = Field(None, max_length=100)
    phone: str | None = Field(None, max_length=32)
    wechat: str | None = Field(None, max_length=100)
    notes: str | None = Field(None, max_length=500)


class SupplierUpdate(BaseModel):
    """PATCH：strict schema；停用用 is_active（不物理删除）。"""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=100)
    contact_name: str | None = Field(None, max_length=100)
    phone: str | None = Field(None, max_length=32)
    wechat: str | None = Field(None, max_length=100)
    notes: str | None = Field(None, max_length=500)
    is_active: bool | None = None

    @model_validator(mode="after")
    def _reject_empty(self) -> "SupplierUpdate":
        if not self.model_fields_set:
            raise ValueError("至少提供一个可更新字段")
        return self


class SupplierOut(BaseModel):
    id: int
    supplier_code: str
    name: str
    contact_name: str | None = None
    phone: str | None = None
    wechat: str | None = None
    notes: str | None = None
    is_active: bool
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Purchase Request
# ---------------------------------------------------------------------------


class PurchaseRequestLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: int
    quantity: Decimal = Field(..., gt=0)
    notes: str | None = Field(None, max_length=500)


class PurchaseRequestCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notes: str | None = Field(None, max_length=500)
    lines: list[PurchaseRequestLineIn] = Field(..., min_length=1)

    @model_validator(mode="after")
    def _no_duplicate_items(self) -> "PurchaseRequestCreate":
        if len({line.item_id for line in self.lines}) != len(self.lines):
            raise ValueError("同一采购申请不允许重复物资行")
        return self


class PurchaseRequestLineOut(BaseModel):
    id: int
    item_id: int
    item_code: str
    item_name: str
    base_unit: str
    quantity: Decimal
    notes: str | None = None


class PurchaseRequestOut(BaseModel):
    id: int
    request_no: str
    status: PurchaseRequestStatus
    requested_by_user_id: int | None = None
    requester_name: str | None = None
    approved_by_user_id: int | None = None
    approved_by_name: str | None = None
    submitted_at: datetime | None = None
    approved_at: datetime | None = None
    rejected_at: datetime | None = None
    cancelled_at: datetime | None = None
    notes: str | None = None
    created_at: datetime
    updated_at: datetime
    lines: list[PurchaseRequestLineOut]


# ---------------------------------------------------------------------------
# Purchase Order
# ---------------------------------------------------------------------------


class PurchaseOrderLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    item_id: int
    ordered_quantity: Decimal = Field(..., gt=0)
    unit_price: Decimal | None = Field(None, ge=0)


class PurchaseOrderCreate(BaseModel):
    """创建 PO。

    - purchase_request_id 提供时 = 申请转订单（lines 自动复制自申请，不允许
      同时传 lines）；成功后 PurchaseRequest APPROVED -> ORDERED 同事务。
    - 不提供 purchase_request_id = 直接创建无申请订单（仅
      SUPER_ADMIN / MANAGER，procurement:order）。
    """

    model_config = ConfigDict(extra="forbid")

    supplier_id: int
    purchase_request_id: int | None = None
    notes: str | None = Field(None, max_length=500)
    lines: list[PurchaseOrderLineIn] | None = None

    @model_validator(mode="after")
    def _lines_consistency(self) -> "PurchaseOrderCreate":
        if self.purchase_request_id is not None:
            if self.lines:
                raise ValueError("由采购申请转订单时不能同时提供 lines")
        elif not self.lines:
            raise ValueError("直接创建采购订单必须提供 lines")
        if self.lines is not None and len(
            {line.item_id for line in self.lines}
        ) != len(self.lines):
            raise ValueError("同一采购订单不允许重复物资行")
        return self


class PurchaseOrderLineOut(BaseModel):
    id: int
    item_id: int
    item_code: str
    item_name: str
    base_unit: str
    ordered_quantity: Decimal
    received_quantity: Decimal
    remaining_quantity: Decimal
    unit_price: Decimal | None = None
    line_total: Decimal | None = None


class GoodsReceiptLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    purchase_order_line_id: int
    received_quantity: Decimal = Field(..., gt=0)


class GoodsReceiptCreate(BaseModel):
    """收货（Sprint 7 §29/§30）：收货才真正增加库存；任一行超收整体回滚。"""

    model_config = ConfigDict(extra="forbid")

    inventory_location_id: int
    notes: str | None = Field(None, max_length=500)
    lines: list[GoodsReceiptLineIn] = Field(..., min_length=1)

    @model_validator(mode="after")
    def _no_duplicate_lines(self) -> "GoodsReceiptCreate":
        ids = [line.purchase_order_line_id for line in self.lines]
        if len(set(ids)) != len(ids):
            raise ValueError("同一收货单不允许重复订单行")
        return self


class GoodsReceiptLineOut(BaseModel):
    id: int
    purchase_order_line_id: int
    item_id: int
    item_code: str
    item_name: str
    base_unit: str
    received_quantity: Decimal


class GoodsReceiptOut(BaseModel):
    id: int
    receipt_no: str
    purchase_order_id: int
    inventory_location_id: int
    inventory_location_name: str
    received_by_user_id: int | None = None
    receiver_name: str | None = None
    received_at: datetime | None = None
    notes: str | None = None
    created_at: datetime
    lines: list[GoodsReceiptLineOut]


class PurchaseOrderOut(BaseModel):
    id: int
    order_no: str
    supplier_id: int
    supplier_code: str
    supplier_name: str
    purchase_request_id: int | None = None
    request_no: str | None = None
    status: PurchaseOrderStatus
    ordered_at: datetime | None = None
    cancelled_at: datetime | None = None
    created_by_user_id: int | None = None
    notes: str | None = None
    created_at: datetime
    updated_at: datetime
    order_total: Decimal
    lines: list[PurchaseOrderLineOut]
    receipts: list[GoodsReceiptOut]
