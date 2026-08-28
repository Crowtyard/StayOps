"""Stay schemas（Sprint 6 扩展：在住房间分配历史与 Room Move）。"""

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.stay import StayStatus
from app.models.stay_assignment import RoomMoveReason
from app.schemas.reservation import ReservationOut, ReservationSummary


class StayRoomAssignmentOut(BaseModel):
    """在住房间分配记录（Sprint 6）。不含任何 Guest PII。"""

    id: int
    stay_id: int
    room_id: int
    room_number: str | None = None
    started_at: datetime
    ended_at: datetime | None = None
    reason: RoomMoveReason | None = None
    notes: str | None = None
    created_by: int | None = None
    created_at: datetime | None = None


class StayOut(BaseModel):
    """入住响应。可选字段由 service 层按权限裁剪后序列化
    （路由使用 response_model_exclude_none 保证缺失键不出现）。
    assignments 仅在详情接口（GET /stays/{id}）加载。"""

    id: int
    stay_no: str
    reservation_id: int
    room_id: int
    room_number: str | None = None
    status: StayStatus
    actual_check_in_at: datetime
    planned_check_out_date: date
    actual_check_out_at: datetime | None = None
    created_by: int | None = None
    updated_by: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    guest_id: int | None = None
    guest_name: str | None = None
    reservation: ReservationSummary | None = None
    assignments: list[StayRoomAssignmentOut] | None = None


class CheckInOut(BaseModel):
    """Check-in 响应：预订 + 新建 Stay（一次性返回，供前端进入退房流程）。"""

    reservation: ReservationOut
    stay: StayOut


class RoomMoveCreate(BaseModel):
    """POST /stays/{id}/room-move 请求（Sprint 6 §9）。

    reason 为固定枚举（Sprint 6 §10，不建立自由字符串）；notes 可选。
    不允许客户端直接 PATCH Stay.room_id：Room Move 必须走专用 Action API。
    """

    model_config = ConfigDict(extra="forbid")

    target_room_id: int
    reason: RoomMoveReason
    notes: str | None = Field(None, max_length=500)

    @model_validator(mode="after")
    def _no_empty_payload(self) -> "RoomMoveCreate":
        # target_room_id / reason 为必填字段，pydantic 已保证存在；
        # 此处防御 future 演化时出现空 payload 语义。
        return self


class RoomMoveOptionItem(BaseModel):
    """room-move-options 单项：eligible=False 时 reason 为不可换入原因。"""

    room_id: int
    room_number: str
    room_type_id: int
    room_type_name: str | None = None
    floor: int
    eligible: bool
    reason: str | None = None


class RoomMoveOptionsOut(BaseModel):
    """GET /stays/{id}/room-move-options 响应（后端权威的目标房候选）。"""

    business_date: date
    stay_id: int
    stay_no: str
    current_room_id: int
    planned_check_out_date: date
    items: list[RoomMoveOptionItem]
