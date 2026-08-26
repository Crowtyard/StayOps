"""Stay schemas。"""

from datetime import date, datetime

from pydantic import BaseModel

from app.models.stay import StayStatus
from app.schemas.reservation import ReservationOut, ReservationSummary


class StayOut(BaseModel):
    """入住响应。可选字段由 service 层按权限裁剪后序列化
    （路由使用 response_model_exclude_none 保证缺失键不出现）。"""

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


class CheckInOut(BaseModel):
    """Check-in 响应：预订 + 新建 Stay（一次性返回，供前端进入退房流程）。"""

    reservation: ReservationOut
    stay: StayOut
