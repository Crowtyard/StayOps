"""Dashboard schemas（alpha.9.6 F2 首页房态概览按日期显示）。

核心语义：响应中的 `status` 是 **某日（date）的房态**，不是 `rooms.occupancy_status`
的当前值。`effective_occupancy_status` / `current_cleaning_status` 表达**当前物理
状态**，且仅在 `date == business_date` 时返回（不推断未来清洁/物理状态）。
"""

from datetime import date as date_type

from pydantic import BaseModel

from app.models.room import CleaningStatus, OccupancyStatus, UnavailabilitySource


class RoomStatusCountsOut(BaseModel):
    """启用房间在某日的房态分区（四类之和恒等于 total_enabled_rooms）。"""

    available: int
    reserved: int
    occupied: int
    out_of_service: int
    total_enabled_rooms: int
    sellable_total: int


class RoomStatusItemOut(BaseModel):
    """单个房间在某日的房态。"""

    room_id: int
    room_number: str
    room_name: str | None = None
    floor: int
    is_active: bool
    room_type_id: int
    room_type_name: str | None = None
    # 某日房态：AVAILABLE / RESERVED / OCCUPIED / OUT_OF_SERVICE
    status: str
    # 当前物理占用状态（真实入住记录对应）；非业务日期为 null
    effective_occupancy_status: OccupancyStatus | None = None
    # 当前清洁状态；非业务日期为 null（不推断未来 CLEANING）
    current_cleaning_status: CleaningStatus | None = None
    unavailability_source: UnavailabilitySource | None = None
    # 预计到店（status=RESERVED 且 date == check_in_date）
    arriving: bool = False
    stay_id: int | None = None
    stay_no: str | None = None
    reservation_id: int | None = None
    check_in_date: date_type | None = None
    planned_check_out_date: date_type | None = None


class RoomStatusOut(BaseModel):
    """GET /dashboard/room-status?date=YYYY-MM-DD"""

    date: date_type
    business_date: date_type
    is_today: bool
    is_past: bool
    # false 表示该日期为未来：物理房态不具权威性，前端须显式提示
    physical_status_authoritative: bool
    enabled_room_count: int
    disabled_room_count: int
    total_room_count: int
    counts: RoomStatusCountsOut
    rooms: list[RoomStatusItemOut]
