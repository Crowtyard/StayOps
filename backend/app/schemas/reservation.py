"""Reservation schemas。

- 日期区间 [check_in_date, check_out_date)：check_out > check_in（否则 422）
- WALK_IN：check_in_date 默认 = Property Business Date（Asia/Shanghai，见
  app/core/business_date.py）；显式提供时必须是业务日期当天（统一 Walk-in 流程）
- status 字段不进入 Create/Update（状态只能经 cancel / no-show / check-in /
  check-out 专用 action 端点变更）
- agreed_total_amount 为 Decimal，JSON 序列化为字符串（沿用 base_price 约定）
"""

from datetime import date, datetime
from decimal import Decimal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from app.core.business_date import add_days, business_date
from app.models.reservation import ReservationSource, ReservationStatus


class ReservationCreate(BaseModel):
    guest_id: int
    room_id: int
    room_type_id: int
    check_in_date: date | None = None
    check_out_date: date | None = None
    source: ReservationSource = ReservationSource.DIRECT
    external_reference: str | None = Field(None, max_length=100)
    agreed_total_amount: Decimal = Field(..., ge=0)
    currency: str = Field("CNY", min_length=3, max_length=3)
    notes: str | None = Field(None, max_length=1000)

    @field_validator("currency")
    @classmethod
    def _currency_upper(cls, value: str) -> str:
        return value.upper()

    @model_validator(mode="after")
    def _dates(self) -> "ReservationCreate":
        if self.source == ReservationSource.WALK_IN:
            today = business_date()
            if self.check_in_date is None:
                self.check_in_date = today
            if self.check_out_date is None:
                self.check_out_date = add_days(today, 1)
            if self.check_in_date != today:
                raise ValueError("WALK_IN 预订的入住日期必须为业务日期今天")
        if self.check_in_date is None or self.check_out_date is None:
            raise ValueError("check_in_date 与 check_out_date 必填")
        if self.check_out_date <= self.check_in_date:
            raise ValueError("check_out_date 必须晚于 check_in_date")
        return self


class ReservationUpdate(BaseModel):
    """CONFIRMED 状态可修改（REV-FINAL-05）；其余状态修改核心字段 -> 409（service 层校验）。

    严格输入校验（S2T1-BLK-01，ADR 修订见 docs/DECISIONS.md）：
    - extra="forbid"：未知字段（含 status）一律 422，不得静默忽略
    - 空 payload（{}）一律 422，不得返回伪成功
    - status 不属于本 schema：状态只能经 cancel / no-show / check-in / check-out
      专用 action 端点变更，普通 PATCH 携带 status -> 422
    校验在请求解析阶段原子失败，任何字段都不会被部分应用。

    修改 room_id / room_type_id / check_in_date / check_out_date 时
    service 层重新执行 Availability + Double Booking + Room/RoomType 一致性校验。
    """

    model_config = ConfigDict(extra="forbid")

    guest_id: int | None = None
    room_id: int | None = None
    room_type_id: int | None = None
    check_in_date: date | None = None
    check_out_date: date | None = None
    source: ReservationSource | None = None
    external_reference: str | None = Field(None, max_length=100)
    agreed_total_amount: Decimal | None = Field(None, ge=0)
    currency: str | None = Field(None, min_length=3, max_length=3)
    notes: str | None = Field(None, max_length=1000)

    @field_validator("currency")
    @classmethod
    def _currency_upper(cls, value: str | None) -> str | None:
        return value.upper() if value is not None else None

    @model_validator(mode="after")
    def _at_least_one_field(self) -> "ReservationUpdate":
        if not self.has_any_field():
            raise ValueError("至少提供一个可更新字段")
        return self

    def has_any_field(self) -> bool:
        return any(
            getattr(self, name) is not None
            for name in (
                "guest_id",
                "room_id",
                "room_type_id",
                "check_in_date",
                "check_out_date",
                "source",
                "external_reference",
                "agreed_total_amount",
                "currency",
                "notes",
            )
        )


class ReservationOut(BaseModel):
    """预订响应。可选字段由 service 层按权限裁剪后序列化
    （路由使用 response_model_exclude_none 保证缺失键不出现）。"""

    id: int
    reservation_no: str
    guest_id: int
    guest_name: str | None = None
    room_id: int
    room_number: str | None = None
    room_type_id: int
    room_type_name: str | None = None
    check_in_date: date
    check_out_date: date
    status: ReservationStatus
    source: ReservationSource
    external_reference: str | None = None
    agreed_total_amount: Decimal | None = None
    currency: str | None = None
    notes: str | None = None
    created_by: int | None = None
    updated_by: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    stay_id: int | None = None


class ReservationSummary(BaseModel):
    """嵌套于 StayOut 的预订摘要（仅持有 reservation:read 时出现）。"""

    reservation_no: str
    check_in_date: date
    check_out_date: date
    status: ReservationStatus
    source: ReservationSource
    agreed_total_amount: Decimal
    currency: str
