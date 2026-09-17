"""Room 某日房态解析器（alpha.9.6 F2，date occupancy resolver）。

背景（真实酒店现场试用反馈）：首页房态概览必须能按日期查看，且**禁止**把
未来日期继续直接读 `Room.occupancy_status` 然后声称那是未来房态。

两个必须明确区分的概念（Alpha.9.6 决策，见 docs/DECISIONS.md）：

A. **Physical room status（物理/运营状态）**
   = `rooms.occupancy_status` + `rooms.cleaning_status` + `unavailability_source`，
   由业务事务（check-in / check-out / Maintenance）在 **Business Date 当天**维护。
   **它不是"某天是否被预订"**。

B. **Date-based occupancy（某日占用/销售状态）**
   = 本模块 `resolve_room_status(db, date)` 的计算结果：
   `[check_in_date, check_out_date)` 半开区间 + ACTIVE Stay + physical override。

计算规则（后端单点权威；前端不得自行计算核心房态）：

1. 只统计 **启用房间**（`is_active=true`）。停用房间单列 `disabled_room_count`，
   不进入任何占用分区，也不参与分母。
2. **physical override（优先于日期占用）**：
   - `date <= business_date`（物理状态对当天及过去有效）：
     - `unavailability_source == MAINTENANCE` 或 `occupancy_status == out_of_service`
       -> `OUT_OF_SERVICE`（维修停用）
     - `occupancy_status == blocked` -> `OUT_OF_SERVICE`（人工锁房）
     - 当天额外保险：存在 active blocking 维修工单（`active_blocking_room_ids`）
       -> `OUT_OF_SERVICE`（覆盖工单与房态同步之间的瞬时窗口）
   - `date > business_date`（未来）：物理状态**不能**冒充未来房态，只承认
     明确的人工长期停用 `occupancy_status == out_of_service` -> `OUT_OF_SERVICE`。
     不为未来日期推断维修 / 锁房 / 清洁状态。
3. **日期占用**（半开区间，与全系统一致）：
   - ACTIVE `Stay` 且 `[bd(actual_check_in_at), planned_check_out_date)` 覆盖 date
     -> `OCCUPIED`（在住）
   - `CONFIRMED` `Reservation` 且 `check_in_date <= date < check_out_date`
     -> `RESERVED`（已预订）
   - 否则 -> `AVAILABLE`（可售）
   - 退房日**不算整日占用**（19 日占、20 日不占），与 `ex_reservations_room_daterange`
     排他约束和 `check_room_availability` 完全同语义。
   - `CANCELLED` / `NO_SHOW` / `COMPLETED` Reservation 不参与日期占用。
   - `reservation.room_id` 在 Check-in 后冻结为原分配房，实际在住以 `Stay.room_id`
     为准（换房由 Stay 表达）。
4. `arriving`（预计到店）：仅当 `status == RESERVED`、`date == check_in_date`
   且 `date >= business_date` 时为 true。**绝不把"预计到店"谎报成"在住"。**
5. **CLEANING 不做未来日期推断**：`effective_occupancy_status`（真实入住记录里
   对应的**当前物理**占用状态）与 `current_cleaning_status` 只在
   `date == business_date` 时返回；其它日期一律为 `null`。
6. `date > business_date` 时 `physical_status_authoritative=false`，前端必须显式
   告知用户「物理房态仅供参考」。

不变式（测试锁定）：启用房间恰好落入
`available + reserved + occupied + out_of_service` 之一，
且 `counts.total_enabled_rooms == enabled_count`。
"""

from __future__ import annotations

from datetime import date as date_type

from sqlalchemy import Date, cast, func, select
from sqlalchemy.orm import Session, selectinload

from app.core.business_date import business_date
from app.models import (
    CleaningStatus,
    OccupancyStatus,
    Reservation,
    ReservationStatus,
    Room,
    RoomType,
    Stay,
    StayStatus,
    UnavailabilitySource,
)
from app.services.maintenance import active_blocking_room_ids

# 某日房态分类（对启用房间构成精确 partition）
STATUS_AVAILABLE = "AVAILABLE"
STATUS_RESERVED = "RESERVED"
STATUS_OCCUPIED = "OCCUPIED"
STATUS_OUT_OF_SERVICE = "OUT_OF_SERVICE"

# 参与日期占用的 Reservation 状态（与可售性引擎一致：仅 CONFIRMED）
_BLOCKING_RESERVATION_STATUSES = (ReservationStatus.CONFIRMED,)

# 明确的物理不可售占用状态（不含 occupied/reserved —— 它们表达"今天是"，
# 而不是"未来某天不可售"）
_PHYSICAL_BLOCKING_STATUSES = (
    OccupancyStatus.blocked,
    OccupancyStatus.out_of_service,
)


def _stay_check_in_date_expr():
    """Stay 实际入住 Business Date（Asia/Shanghai 日历日）。

    与 app/services/booking.py::active_stay_room_ids 使用完全相同的表达式，
    避免出现第二套日期语义。
    """
    return cast(func.timezone("Asia/Shanghai", Stay.actual_check_in_at), Date)


def _date_occupancy_maps(
    db: Session, target_date: date_type
) -> tuple[dict[int, dict], dict[int, dict]]:
    """一次查询取回该日的在住 / 已预订事实（避免 N+1）。

    返回 (stays_by_room, reservations_by_room)。
    区间一律半开 [check_in, check_out)：`<= date <` 等价于
    `check_in < date+1 AND check_out > date`。
    """
    stays_by_room: dict[int, dict] = {}
    reservations_by_room: dict[int, dict] = {}

    stay_rows = db.execute(
        select(
            Stay.id,
            Stay.room_id,
            Stay.stay_no,
            Stay.planned_check_out_date,
        ).where(
            Stay.status == StayStatus.ACTIVE,
            _stay_check_in_date_expr() <= target_date,
            Stay.planned_check_out_date > target_date,
        )
    ).all()
    for row in stay_rows:
        # 同一房间不应有多条 ACTIVE Stay（API 层已拦），万一出现取 id 最小者
        if row.room_id not in stays_by_room or row.id < stays_by_room[row.room_id][
            "stay_id"
        ]:
            stays_by_room[row.room_id] = {
                "stay_id": row.id,
                "stay_no": row.stay_no,
                "planned_check_out_date": row.planned_check_out_date,
            }

    reservation_rows = db.execute(
        select(
            Reservation.id,
            Reservation.room_id,
            Reservation.status,
            Reservation.check_in_date,
            Reservation.check_out_date,
            Reservation.source_channel_id,
        ).where(
            Reservation.status.in_(_BLOCKING_RESERVATION_STATUSES),
            Reservation.check_in_date <= target_date,
            Reservation.check_out_date > target_date,
        )
    ).all()
    for row in reservation_rows:
        if (
            row.room_id not in reservations_by_room
            or row.id < reservations_by_room[row.room_id]["reservation_id"]
        ):
            reservations_by_room[row.room_id] = {
                "reservation_id": row.id,
                "reservation_status": row.status,
                "check_in_date": row.check_in_date,
                "check_out_date": row.check_out_date,
                "source_channel_id": row.source_channel_id,
            }

    return stays_by_room, reservations_by_room


def resolve_room_status(db: Session, target_date: date_type | None = None) -> dict:
    """解析某日房态（唯一后端权威入口）。

    `target_date` 默认 Property Business Date。返回结构见模块 docstring。
    """
    business_day = business_date()
    if target_date is None:
        target_date = business_day
    same_as_business_day = target_date == business_day
    is_past = target_date < business_day

    stays_by_room, reservations_by_room = _date_occupancy_maps(db, target_date)
    # 当天额外保险：阻断性维修工单（工单与房态同步之间的瞬时窗口）；
    # 过去日期不重算维修事实（无法复原历史工单状态），依赖当时已落库的房态。
    if same_as_business_day:
        blocking_maintenance_room_ids = active_blocking_room_ids(db)
    else:
        blocking_maintenance_room_ids = set()

    rooms = db.scalars(
        select(Room)
        .options(selectinload(Room.room_type))
        .order_by(Room.room_number, Room.id)
    ).all()

    counts = {
        "available": 0,
        "reserved": 0,
        "occupied": 0,
        "out_of_service": 0,
        "total_enabled_rooms": 0,
    }
    disabled_room_count = 0
    items: list[dict] = []

    for room in rooms:
        if not room.is_active:
            disabled_room_count += 1
            # 停用房间仍返回（前端需要展示「已停用」），但不进入占用分区
            items.append(_room_item(room, STATUS_OUT_OF_SERVICE, None, None,
                                    False, None, None, enabled=False))
            continue

        counts["total_enabled_rooms"] += 1
        stay = stays_by_room.get(room.id)
        reservation = reservations_by_room.get(room.id)
        status, effective_occupancy = _resolve_status(
            room,
            same_as_business_day=same_as_business_day,
            physical_authoritative=(same_as_business_day or is_past),
            blocking_maintenance=room.id in blocking_maintenance_room_ids,
            has_active_stay=stay is not None,
            has_blocking_reservation=reservation is not None,
        )

        if status == STATUS_OUT_OF_SERVICE:
            counts["out_of_service"] += 1
        elif status == STATUS_OCCUPIED:
            counts["occupied"] += 1
        elif status == STATUS_RESERVED:
            counts["reserved"] += 1
        else:
            counts["available"] += 1

        arriving = bool(
            status == STATUS_RESERVED
            and reservation is not None
            and reservation["check_in_date"] == target_date
            and target_date >= business_day
        )

        items.append(
            _room_item(
                room,
                status,
                effective_occupancy,
                room.cleaning_status if same_as_business_day else None,
                arriving,
                stay,
                reservation,
                enabled=True,
            )
        )

    # 可售总数：启用房间中真正可售者（AVAILABLE）—— 已预订/在住/维修停用均不可再售
    counts["sellable_total"] = counts["available"]

    return {
        "date": target_date,
        "business_date": business_day,
        "is_today": same_as_business_day,
        "is_past": is_past,
        "physical_status_authoritative": same_as_business_day or is_past,
        "enabled_room_count": counts["total_enabled_rooms"],
        "disabled_room_count": disabled_room_count,
        "total_room_count": counts["total_enabled_rooms"] + disabled_room_count,
        "counts": counts,
        "rooms": items,
    }


def _resolve_status(
    room: Room,
    *,
    same_as_business_day: bool,
    physical_authoritative: bool,
    blocking_maintenance: bool,
    has_active_stay: bool,
    has_blocking_reservation: bool,
) -> tuple[str, OccupancyStatus | None]:
    """返回 (某日房态分类, 真实入住记录对应的当前物理占用状态)。

    顺序：物理 override -> 日期占用（在住优先于已预订）-> 可售。
    见模块 docstring 规则 2/3。
    """
    # 1) 物理 override
    if physical_authoritative:
        if room.unavailability_source == UnavailabilitySource.MAINTENANCE:
            return STATUS_OUT_OF_SERVICE, room.occupancy_status
        if room.occupancy_status in _PHYSICAL_BLOCKING_STATUSES:
            return STATUS_OUT_OF_SERVICE, room.occupancy_status
        if blocking_maintenance:
            return STATUS_OUT_OF_SERVICE, room.occupancy_status
    else:
        # 未来日期：只承认明确的人工长期停用；不推断维修 / 锁房
        if room.occupancy_status == OccupancyStatus.out_of_service:
            return STATUS_OUT_OF_SERVICE, None

    # 2) 日期占用（半开区间已在上游查询中保证）
    if has_active_stay:
        return (
            STATUS_OCCUPIED,
            room.occupancy_status if same_as_business_day else None,
        )
    if has_blocking_reservation:
        return (
            STATUS_RESERVED,
            room.occupancy_status if same_as_business_day else None,
        )

    # 3) 可售
    return (
        STATUS_AVAILABLE,
        room.occupancy_status if same_as_business_day else None,
    )


def _room_item(
    room: Room,
    status: str,
    effective_occupancy: OccupancyStatus | None,
    current_cleaning: CleaningStatus | None,
    arriving: bool,
    stay: dict | None,
    reservation: dict | None,
    *,
    enabled: bool,
) -> dict:
    return {
        "room_id": room.id,
        "room_number": room.room_number,
        "room_name": room.name,
        "floor": room.floor,
        "is_active": enabled,
        "room_type_id": room.room_type_id,
        "room_type_name": room.room_type.name if room.room_type is not None else None,
        "status": status,
        # 当前物理状态（真实入住记录对应）；非业务日期一律 null（不推断未来）
        "effective_occupancy_status": effective_occupancy,
        "current_cleaning_status": current_cleaning,
        "unavailability_source": room.unavailability_source,
        "arriving": arriving,
        "stay_id": stay["stay_id"] if stay else None,
        "stay_no": stay["stay_no"] if stay else None,
        "planned_check_out_date": (
            stay["planned_check_out_date"]
            if stay
            else (reservation["check_out_date"] if reservation else None)
        ),
        "reservation_id": reservation["reservation_id"] if reservation else None,
        "check_in_date": reservation["check_in_date"] if reservation else None,
    }
