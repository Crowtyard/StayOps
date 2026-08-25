"""房型与房间 schemas。

说明：base_price 为 Decimal；Pydantic v2 JSON 序列化输出为字符串（如 "328.00"），
以避免浮点精度问题（前端/客户端需自行转数值，见 docs/API.md）。
房间占用/清洁状态仅可通过 POST /rooms/{id}/status 变更（受后端状态机校验），
PUT /rooms/{id} 不接收状态字段。
"""

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.room import CleaningStatus, OccupancyStatus


class RoomTypeCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    base_price: Decimal = Field(..., gt=0)
    capacity: int = Field(..., ge=1)
    description: str | None = Field(None, max_length=255)


class RoomTypeUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    base_price: Decimal | None = Field(None, gt=0)
    capacity: int | None = Field(None, ge=1)
    description: str | None = Field(None, max_length=255)


class RoomTypeBrief(BaseModel):
    """房型摘要（内嵌于房间响应）。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str


class RoomTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    base_price: Decimal
    capacity: int
    description: str | None
    created_at: datetime
    updated_at: datetime
    room_count: int = 0


class RoomCreate(BaseModel):
    room_number: str = Field(..., min_length=1, max_length=20)
    room_type_id: int
    floor: int
    occupancy_status: OccupancyStatus = OccupancyStatus.available
    cleaning_status: CleaningStatus = CleaningStatus.clean
    notes: str | None = Field(None, max_length=255)


class RoomUpdate(BaseModel):
    """更新房间基础信息；不含状态（房态只能走状态机接口）。"""

    room_number: str | None = Field(None, min_length=1, max_length=20)
    room_type_id: int | None = None
    floor: int | None = None
    notes: str | None = Field(None, max_length=255)


class RoomStatusChange(BaseModel):
    """房态变更请求：占用与清洁维度至少提供一个，后端分别校验状态机。"""

    occupancy_status: OccupancyStatus | None = None
    cleaning_status: CleaningStatus | None = None

    @model_validator(mode="after")
    def _at_least_one(self) -> "RoomStatusChange":
        if self.occupancy_status is None and self.cleaning_status is None:
            raise ValueError("至少提供一个状态字段（occupancy_status 或 cleaning_status）")
        return self


class RoomOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    room_number: str
    room_type_id: int
    floor: int
    occupancy_status: OccupancyStatus
    cleaning_status: CleaningStatus
    notes: str | None
    created_at: datetime
    updated_at: datetime
    room_type: RoomTypeBrief | None = None
