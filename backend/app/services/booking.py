"""Booking 域服务层：可售性引擎、预订生命周期事务、权限裁剪序列化。

结构决策（docs/DECISIONS.md）：预订域业务集中在 service 层，routes 保持薄；
Check-in / Check-out 的事务性逻辑必须单点维护（任一步失败全部回滚）。

关键保证：
- Double Booking：应用层预检（快速失败 + 友好报错）仅为快速路径；
  数据库排他约束 ex_reservations_room_daterange 为最终仲裁（REV-01）。
  排他约束冲突（PostgreSQL 23P01）统一映射为 409，绝不泄漏 500。
- 并发 Check-in / Check-out：SELECT ... FOR UPDATE 串行化 + 状态校验 +
  stays.reservation_id 唯一约束双保险，最终 1 SUCCESS + 1 CONFLICT。
- 业务单号：reservation_no / stay_no 使用 PG Sequence（nextval）原子生成 +
  UNIQUE 约束（REV-04，禁止 SELECT MAX+1）。
- PII：审计 details 不含 phone / email / Guest notes / Reservation notes / 金额；
  响应序列化按 guest:read / reservation:read 裁剪字段。
"""

from datetime import date

from fastapi import HTTPException, status
from sqlalchemy import Date, cast, func, select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import write_audit_log
from app.core.booking_state_machine import (
    can_transition_reservation,
    can_transition_stay,
)
from app.core.business_date import business_date, property_now
from app.core.state_machine import can_change_occupancy
from app.models import (
    CleaningStatus,
    Guest,
    OccupancyStatus,
    Reservation,
    ReservationStatus,
    Room,
    RoomType,
    Stay,
    StayStatus,
    UnavailabilitySource,
    User,
)
from app.schemas.reservation import ReservationCreate, ReservationUpdate
from app.services.housekeeping import create_checkout_task
from app.services.maintenance import (
    active_blocking_room_ids,
    has_active_blocking_orders,
)

# 业务单号使用的 PG Sequence（Migration 创建）
RESERVATION_NO_SEQ = "reservation_no_seq"
STAY_NO_SEQ = "stay_no_seq"

# 不再阻塞新预订的状态（排他约束部分索引同款白名单，REV-01）
_BLOCKING_RESERVATION_STATUSES = (
    ReservationStatus.CONFIRMED,
    ReservationStatus.CHECKED_IN,
)

_DOUBLE_BOOKING_DETAIL = "该房间在所选日期区间已被预订"

# Sprint 5 §16/§17：Active Blocking Maintenance 参与最终可售性判断
_ACTIVE_BLOCKING_MAINTENANCE_DETAIL = "该房间存在进行中的阻断性维修工单，暂不可售"
_ACTIVE_BLOCKING_MAINTENANCE_CHECKIN_DETAIL = (
    "该房间存在进行中的阻断性维修工单，无法办理入住"
)


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail
    )


def _pgcode(exc: IntegrityError | OperationalError) -> str | None:
    """取底层 DBAPI 错误的 SQLSTATE。

    psycopg2：exc.orig.pgcode（连接抛出的真实错误必然携带）；
    回退 exc.orig.diag.sqlstate（防御个别驱动版本差异）。
    """
    orig = getattr(exc, "orig", None)
    if orig is None:
        return None
    code = getattr(orig, "pgcode", None)
    if code is None:
        diag = getattr(orig, "diag", None)
        code = getattr(diag, "sqlstate", None)
    return code


def _is_transaction_conflict(exc: OperationalError) -> bool:
    """仅识别可转换为业务 Conflict 的 PostgreSQL 并发仲裁错误：

    - 40P01 deadlock_detected：并发 Double Booking 排他约束检查互相等待
      ShareLock，PG 中止其一（D1 修复）
    - 40001 serialization_failure：事务序列化冲突，同属并发仲裁

    其它任何 OperationalError（57014 query_canceled / statement timeout、
    连接故障、数据库不可用等）一律不得转换 —— 必须 rollback 后原样 re-raise，
    保持基础设施/数据库错误语义。
    """
    return _pgcode(exc) in ("40P01", "40001")


# ---------------------------------------------------------------------------
# 业务单号（REV-04：PG Sequence 原子生成 + UNIQUE 约束，禁止 SELECT MAX+1）
# ---------------------------------------------------------------------------


def _next_sequence_value(db: Session, seq_name: str) -> int:
    return db.scalar(text(f"SELECT nextval('{seq_name}')"))


def next_reservation_no(db: Session) -> str:
    """格式 RSV{YYYYMMDD}-{NNNN}（日期 = Property Business Date，序号 = Sequence）。"""
    value = _next_sequence_value(db, RESERVATION_NO_SEQ)
    return f"RSV{business_date():%Y%m%d}-{value:04d}"


def next_stay_no(db: Session) -> str:
    """格式 STY{YYYYMMDD}-{NNNN}（日期 = Property Business Date，序号 = Sequence）。"""
    value = _next_sequence_value(db, STAY_NO_SEQ)
    return f"STY{business_date():%Y%m%d}-{value:04d}"


# ---------------------------------------------------------------------------
# Availability Engine（总纲 §6 / 任务书 Business Rules 12）
# ---------------------------------------------------------------------------


def overlapping_reservation_room_ids(
    db: Session,
    check_in: date,
    check_out: date,
    exclude_reservation_id: int | None = None,
) -> set[int]:
    """与查询区间重叠、且仍占用日期的 Reservation 房间集合
    （CONFIRMED / CHECKED_IN；CANCELLED / NO_SHOW / COMPLETED 不再阻塞）。"""
    stmt = select(Reservation.room_id).where(
        Reservation.status.in_(_BLOCKING_RESERVATION_STATUSES),
        Reservation.check_in_date < check_out,
        Reservation.check_out_date > check_in,
    )
    if exclude_reservation_id is not None:
        stmt = stmt.where(Reservation.id != exclude_reservation_id)
    return set(db.scalars(stmt).all())


def active_stay_room_ids(
    db: Session, check_in: date, check_out: date
) -> set[int]:
    """与查询区间重叠的 Active Stay 房间集合。

    Stay 占用区间 = [actual_check_in_at 的 Asia/Shanghai 日期, planned_check_out_date)。
    actual_check_in_at 为 timestamptz：用 PG timezone('Asia/Shanghai', ...) 转换后取日期，
    避免依赖数据库服务器时区。
    """
    stay_check_in_date = cast(
        func.timezone("Asia/Shanghai", Stay.actual_check_in_at), Date
    )
    stmt = select(Stay.room_id).where(
        Stay.status == StayStatus.ACTIVE,
        stay_check_in_date < check_out,
        Stay.planned_check_out_date > check_in,
    )
    return set(db.scalars(stmt).all())


def check_room_availability(
    db: Session,
    room: Room,
    check_in: date,
    check_out: date,
    exclude_reservation_id: int | None = None,
) -> tuple[bool, str | None]:
    """应用层预检（快速路径）。返回 (可售?, 不可售原因)。

    排除：blocked / out_of_service；重叠 CONFIRMED / CHECKED_IN；
    重叠 Active Stay；查询区间含业务日期当天时 occupied / reserved；
    Active Blocking Maintenance（Sprint 5 §16：OPEN/ASSIGNED/IN_PROGRESS/
    RESOLVED 且 blocks_room=true，无论 Room 当前 occupancy 为何）。
    未来预订不要求 cleaning_status = clean（Clean 要求只在 Check-in 当下）。
    数据库排他约束仍为最终仲裁。
    """
    if room.occupancy_status in (
        OccupancyStatus.blocked,
        OccupancyStatus.out_of_service,
    ):
        return False, f"房间当前为 {room.occupancy_status.value}，不可预订"
    if room.id in active_blocking_room_ids(db):
        return False, _ACTIVE_BLOCKING_MAINTENANCE_DETAIL
    if room.id in overlapping_reservation_room_ids(
        db, check_in, check_out, exclude_reservation_id
    ):
        return False, _DOUBLE_BOOKING_DETAIL
    if room.id in active_stay_room_ids(db, check_in, check_out):
        return False, "该房间在所选日期区间已有在住记录"
    if (
        check_in <= business_date() < check_out
        and room.occupancy_status
        in (OccupancyStatus.occupied, OccupancyStatus.reserved)
    ):
        return False, "该房间当前不可用"
    return True, None


def query_availability(
    db: Session, check_in: date, check_out: date, room_type_id: int | None = None
) -> dict:
    """GET /availability 查询：全量房间 + 可售性标注。"""
    today = business_date()
    overlap_ids = overlapping_reservation_room_ids(db, check_in, check_out)
    stay_ids = active_stay_room_ids(db, check_in, check_out)
    blocking_ids = active_blocking_room_ids(db)
    stmt = select(Room).options(selectinload(Room.room_type)).order_by(Room.id)
    if room_type_id is not None:
        stmt = stmt.where(Room.room_type_id == room_type_id)
    rooms = db.scalars(stmt).all()

    items: list[dict] = []
    available_count = 0
    for room in rooms:
        reason: str | None = None
        if room.occupancy_status in (
            OccupancyStatus.blocked,
            OccupancyStatus.out_of_service,
        ):
            reason = f"房间当前为 {room.occupancy_status.value}"
        elif room.id in blocking_ids:
            reason = _ACTIVE_BLOCKING_MAINTENANCE_DETAIL
        elif room.id in overlap_ids:
            reason = _DOUBLE_BOOKING_DETAIL
        elif room.id in stay_ids:
            reason = "该房间在所选日期区间已有在住记录"
        elif (
            check_in <= today < check_out
            and room.occupancy_status
            in (OccupancyStatus.occupied, OccupancyStatus.reserved)
        ):
            reason = "该房间当前不可用"
        if reason is None:
            available_count += 1
        items.append(
            {
                "room_id": room.id,
                "room_number": room.room_number,
                "room_type_id": room.room_type_id,
                "room_type_name": room.room_type.name
                if room.room_type is not None
                else None,
                "floor": room.floor,
                "available": reason is None,
                "reason": reason,
            }
        )
    return {
        "business_date": today,
        "check_in_date": check_in,
        "check_out_date": check_out,
        "total": len(items),
        "available_count": available_count,
        "items": items,
    }


# ---------------------------------------------------------------------------
# 一致性校验（REV-FINAL-06：reservation.room_type_id == room.room_type_id）
# ---------------------------------------------------------------------------


def ensure_room_room_type_consistency(room: Room, room_type_id: int) -> None:
    if room.room_type_id != room_type_id:
        raise _unprocessable(
            "房型与房间不一致：reservation.room_type_id 必须等于 room.room_type_id"
        )


# ---------------------------------------------------------------------------
# 事务提交（排他约束冲突 23P01 -> 409）
# ---------------------------------------------------------------------------


def _commit_or_conflict(
    db: Session,
    *,
    generic_detail: str,
    double_booking_detail: str,
    deadlock_detail: str | None = None,
) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if _pgcode(exc) == "23P01":
            raise _conflict(double_booking_detail) from exc
        raise _conflict(generic_detail) from exc
    except OperationalError as exc:
        db.rollback()
        if _is_transaction_conflict(exc):
            # 40P01 / 40001：并发仲裁 → 409（D1 修复），绝不泄漏 500
            raise _conflict(deadlock_detail or generic_detail) from exc
        # 其它 OperationalError（57014 / 连接故障 / 库不可用等）：
        # 基础设施错误语义，rollback 后原样 re-raise，不得转换/吞掉
        raise


# ---------------------------------------------------------------------------
# Reservation 生命周期（创建 / 修改 / 取消 / No-show）
# ---------------------------------------------------------------------------


def _audit_reservation_basics(reservation: Reservation) -> dict:
    """审计摘要：仅 ID / 状态 / 单号 / 日期 / 来源，不含任何 PII 与金额。"""
    return {
        "reservation_no": reservation.reservation_no,
        "guest_id": reservation.guest_id,
        "room_id": reservation.room_id,
        "check_in_date": reservation.check_in_date.isoformat(),
        "check_out_date": reservation.check_out_date.isoformat(),
        "source": reservation.source.value,
    }


def create_reservation(
    db: Session,
    payload: ReservationCreate,
    user: User | None,
    request=None,
) -> Reservation:
    guest = db.get(Guest, payload.guest_id)
    if guest is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="客人不存在"
        )
    room = db.get(Room, payload.room_id)
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="房间不存在"
        )
    room_type = db.get(RoomType, payload.room_type_id)
    if room_type is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="房型不存在"
        )
    ensure_room_room_type_consistency(room, payload.room_type_id)
    available, reason = check_room_availability(
        db, room, payload.check_in_date, payload.check_out_date
    )
    if not available:
        raise _conflict(reason)

    reservation = Reservation(
        reservation_no=next_reservation_no(db),
        guest_id=payload.guest_id,
        room_id=payload.room_id,
        room_type_id=payload.room_type_id,
        check_in_date=payload.check_in_date,
        check_out_date=payload.check_out_date,
        status=ReservationStatus.CONFIRMED,
        source=payload.source,
        external_reference=payload.external_reference,
        agreed_total_amount=payload.agreed_total_amount,
        currency=payload.currency,
        notes=payload.notes,
        created_by=user.id if user is not None else None,
        updated_by=user.id if user is not None else None,
    )
    db.add(reservation)
    try:
        db.flush()
        details = _audit_reservation_basics(reservation)
        details["status"] = reservation.status.value
        details["currency"] = reservation.currency
        write_audit_log(
            db,
            user,
            "reservation.create",
            "reservation",
            reservation.id,
            details,
            request,
        )
        _commit_or_conflict(
            db,
            generic_detail="预订创建失败：数据冲突",
            double_booking_detail=_DOUBLE_BOOKING_DETAIL,
            deadlock_detail=_DOUBLE_BOOKING_DETAIL,
        )
    except IntegrityError as exc:
        db.rollback()
        if _pgcode(exc) == "23P01":
            raise _conflict(_DOUBLE_BOOKING_DETAIL) from exc
        raise _conflict("预订创建失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if _is_transaction_conflict(exc):
            # 40P01 / 40001：排他约束并发仲裁 → 409 Double Booking 语义（D1）
            raise _conflict(_DOUBLE_BOOKING_DETAIL) from exc
        raise
    except HTTPException:
        db.rollback()
        raise
    return reservation


def update_reservation(
    db: Session,
    reservation: Reservation,
    payload: ReservationUpdate,
    user: User | None,
    request=None,
) -> None:
    """CONFIRMED 可编辑（REV-FINAL-05）；终态修改核心字段 -> 409。

    空 payload 显式 422（S2T1-BLK-01；schema 层已原子拒绝，此处为防御双保险）。
    """
    if not payload.has_any_field():
        raise _unprocessable("至少提供一个可更新字段")
    if reservation.status != ReservationStatus.CONFIRMED:
        raise _conflict("仅 CONFIRMED 状态的预订可修改")

    new_check_in = (
        payload.check_in_date
        if payload.check_in_date is not None
        else reservation.check_in_date
    )
    new_check_out = (
        payload.check_out_date
        if payload.check_out_date is not None
        else reservation.check_out_date
    )
    if new_check_out <= new_check_in:
        raise _unprocessable("check_out_date 必须晚于 check_in_date")

    if payload.guest_id is not None and db.get(Guest, payload.guest_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="客人不存在"
        )
    if payload.room_id is not None and db.get(Room, payload.room_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="房间不存在"
        )
    if (
        payload.room_type_id is not None
        and db.get(RoomType, payload.room_type_id) is None
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="房型不存在"
        )

    new_room_id = payload.room_id if payload.room_id is not None else reservation.room_id
    new_room_type_id = (
        payload.room_type_id
        if payload.room_type_id is not None
        else reservation.room_type_id
    )
    room = db.get(Room, new_room_id)
    ensure_room_room_type_consistency(room, new_room_type_id)

    # 修改 room / room_type / dates -> 重新执行 Availability + Double Booking（REV-FINAL-05）
    availability_related = (
        payload.room_id is not None
        or payload.room_type_id is not None
        or payload.check_in_date is not None
        or payload.check_out_date is not None
    )
    if availability_related:
        available, reason = check_room_availability(
            db, room, new_check_in, new_check_out, reservation.id
        )
        if not available:
            raise _conflict(reason)

    changes: dict = {}
    if payload.guest_id is not None and payload.guest_id != reservation.guest_id:
        changes["guest_id"] = {
            "from": reservation.guest_id,
            "to": payload.guest_id,
        }
        reservation.guest_id = payload.guest_id
    if payload.room_id is not None and payload.room_id != reservation.room_id:
        changes["room_id"] = {"from": reservation.room_id, "to": payload.room_id}
        reservation.room_id = payload.room_id
    if (
        payload.room_type_id is not None
        and payload.room_type_id != reservation.room_type_id
    ):
        changes["room_type_id"] = {
            "from": reservation.room_type_id,
            "to": payload.room_type_id,
        }
        reservation.room_type_id = payload.room_type_id
    if (
        payload.check_in_date is not None
        and payload.check_in_date != reservation.check_in_date
    ):
        changes["check_in_date"] = {
            "from": reservation.check_in_date.isoformat(),
            "to": payload.check_in_date.isoformat(),
        }
        reservation.check_in_date = payload.check_in_date
    if (
        payload.check_out_date is not None
        and payload.check_out_date != reservation.check_out_date
    ):
        changes["check_out_date"] = {
            "from": reservation.check_out_date.isoformat(),
            "to": payload.check_out_date.isoformat(),
        }
        reservation.check_out_date = payload.check_out_date
    if payload.source is not None and payload.source != reservation.source:
        changes["source"] = {
            "from": reservation.source.value,
            "to": payload.source.value,
        }
        reservation.source = payload.source
    if (
        payload.external_reference is not None
        and payload.external_reference != reservation.external_reference
    ):
        changes["external_reference"] = "已更新"
        reservation.external_reference = payload.external_reference
    if (
        payload.agreed_total_amount is not None
        and payload.agreed_total_amount != reservation.agreed_total_amount
    ):
        changes["agreed_total_amount"] = "金额已更新"
        reservation.agreed_total_amount = payload.agreed_total_amount
    if payload.currency is not None and payload.currency != reservation.currency:
        changes["currency"] = {
            "from": reservation.currency,
            "to": payload.currency,
        }
        reservation.currency = payload.currency
    if payload.notes is not None and payload.notes != reservation.notes:
        changes["notes"] = "备注已更新"
        reservation.notes = payload.notes

    if not changes:
        return
    reservation.updated_by = user.id if user is not None else None
    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "reservation.update",
            "reservation",
            reservation.id,
            {"changes": changes},
            request,
        )
        _commit_or_conflict(
            db,
            generic_detail="预订修改失败：数据冲突",
            double_booking_detail=_DOUBLE_BOOKING_DETAIL,
            deadlock_detail=_DOUBLE_BOOKING_DETAIL,
        )
    except IntegrityError as exc:
        db.rollback()
        if _pgcode(exc) == "23P01":
            raise _conflict(_DOUBLE_BOOKING_DETAIL) from exc
        raise _conflict("预订修改失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if _is_transaction_conflict(exc):
            # 40P01 / 40001：改期/换房重检排他约束时的并发仲裁 → 409（D1）
            raise _conflict(_DOUBLE_BOOKING_DETAIL) from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def cancel_reservation(
    db: Session, reservation: Reservation, user: User | None, request=None
) -> None:
    if reservation.status != ReservationStatus.CONFIRMED:
        raise _conflict("仅 CONFIRMED 预订可取消")
    previous = reservation.status.value
    reservation.status = ReservationStatus.CANCELLED
    reservation.updated_by = user.id if user is not None else None
    try:
        db.flush()
        details = _audit_reservation_basics(reservation)
        details["from"] = previous
        details["to"] = reservation.status.value
        write_audit_log(
            db,
            user,
            "reservation.cancel",
            "reservation",
            reservation.id,
            details,
            request,
        )
        _commit_or_conflict(db, generic_detail="取消失败：数据冲突", double_booking_detail=_DOUBLE_BOOKING_DETAIL)
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("取消失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if _is_transaction_conflict(exc):
            raise _conflict("取消失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def no_show_reservation(
    db: Session, reservation: Reservation, user: User | None, request=None
) -> None:
    if reservation.status != ReservationStatus.CONFIRMED:
        raise _conflict("仅 CONFIRMED 预订可标记未到店")
    # REV-FINAL-02：仅 business_date >= check_in_date 可标记 No-show
    if business_date() < reservation.check_in_date:
        raise _conflict("未到入住日期，不能标记未到店")
    previous = reservation.status.value
    reservation.status = ReservationStatus.NO_SHOW
    reservation.updated_by = user.id if user is not None else None
    try:
        db.flush()
        details = _audit_reservation_basics(reservation)
        details["from"] = previous
        details["to"] = reservation.status.value
        write_audit_log(
            db,
            user,
            "reservation.no_show",
            "reservation",
            reservation.id,
            details,
            request,
        )
        _commit_or_conflict(db, generic_detail="标记未到店失败：数据冲突", double_booking_detail=_DOUBLE_BOOKING_DETAIL)
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("标记未到店失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if _is_transaction_conflict(exc):
            raise _conflict("标记未到店失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# Check-in / Check-out 事务（总纲 §3.6 / §3.7，REV-FINAL-01）
# ---------------------------------------------------------------------------


def check_in_reservation(
    db: Session, reservation_id: int, user: User | None, request=None
) -> tuple[Reservation, Stay]:
    """Check-in 单事务：

    Reservation CONFIRMED -> CHECKED_IN
    + Stay CREATE ACTIVE
    + Room occupancy_status -> occupied
    + Audit reservation.check_in
    任一步失败全部回滚。SELECT FOR UPDATE 串行化并发（1 SUCCESS + 1 CONFLICT）。
    """
    reservation = db.scalar(
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .with_for_update()
    )
    if reservation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="预订不存在"
        )
    try:
        if reservation.status != ReservationStatus.CONFIRMED:
            raise _conflict("仅 CONFIRMED 预订可办理入住")
        today = business_date()
        if today < reservation.check_in_date:
            raise _conflict("未到入住日期，不能提前办理入住")
        if today >= reservation.check_out_date:
            raise _conflict("已超过计划退房日期，无法办理入住")
        # Sprint 5 §27：锁顺序 Reservation -> Room（Maintenance 事务为
        # Room -> MWO，无环）；Sprint 5 §17 纵深防御：
        # active blocking MaintenanceWorkOrder -> 409（后端最终权威）
        room = db.scalar(
            select(Room)
            .where(Room.id == reservation.room_id)
            .with_for_update()
        )
        if room is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="房间不存在"
            )
        if room.cleaning_status != CleaningStatus.clean:
            raise _conflict("房间未清洁，请先安排保洁")
        if has_active_blocking_orders(db, room.id):
            raise _conflict(_ACTIVE_BLOCKING_MAINTENANCE_CHECKIN_DETAIL)
        if not can_change_occupancy(
            room.occupancy_status, OccupancyStatus.occupied
        ):
            raise _conflict("房间当前不可用，无法办理入住")
        occupied_by_stay = db.scalar(
            select(Stay.id).where(
                Stay.room_id == room.id, Stay.status == StayStatus.ACTIVE
            )
        )
        if occupied_by_stay is not None:
            raise _conflict("房间已有在住记录，无法重复入住")

        stay = Stay(
            stay_no=next_stay_no(db),
            reservation_id=reservation.id,
            room_id=room.id,
            status=StayStatus.ACTIVE,
            actual_check_in_at=property_now(),
            planned_check_out_date=reservation.check_out_date,
            created_by=user.id if user is not None else None,
            updated_by=user.id if user is not None else None,
        )
        db.add(stay)
        reservation.status = ReservationStatus.CHECKED_IN
        reservation.updated_by = user.id if user is not None else None
        room.occupancy_status = OccupancyStatus.occupied

        db.flush()
        details = _audit_reservation_basics(reservation)
        details.update(
            {
                "from": ReservationStatus.CONFIRMED.value,
                "to": reservation.status.value,
                "stay_no": stay.stay_no,
                "stay_id": stay.id,
                "room_number": room.room_number,
            }
        )
        write_audit_log(
            db,
            user,
            "reservation.check_in",
            "reservation",
            reservation.id,
            details,
            request,
        )
        _commit_or_conflict(
            db,
            generic_detail="该预订已办理入住，请勿重复操作",
            double_booking_detail=_DOUBLE_BOOKING_DETAIL,
        )
        return reservation, stay
    except IntegrityError as exc:
        db.rollback()
        if _pgcode(exc) == "23P01":
            raise _conflict(_DOUBLE_BOOKING_DETAIL) from exc
        raise _conflict("该预订已办理入住，请勿重复操作") from exc
    except OperationalError as exc:
        db.rollback()
        if _is_transaction_conflict(exc):
            raise _conflict("该预订已办理入住，请勿重复操作") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def check_out_stay(
    db: Session, stay_id: int, user: User | None, request=None
) -> Stay:
    """Check-out 单事务（REV-01）：

    Stay ACTIVE -> CHECKED_OUT
    + Reservation CHECKED_IN -> COMPLETED（仅此处可触发，REV-01）
    + Room occupancy_status -> available
    + Room cleaning_status -> dirty
    + Audit stay.check_out
    任一步失败全部回滚。SELECT FOR UPDATE 串行化并发（1 SUCCESS + 1 CONFLICT）。
    """
    stay = db.scalar(
        select(Stay).where(Stay.id == stay_id).with_for_update()
    )
    if stay is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="入住记录不存在"
        )
    try:
        if stay.status != StayStatus.ACTIVE:
            raise _conflict("该入住记录已退房")
        if not can_transition_stay(stay.status, StayStatus.CHECKED_OUT):
            raise _conflict("非法入住状态转换")
        reservation = db.get(Reservation, stay.reservation_id)
        if reservation is None:
            raise _conflict("关联预订不存在，无法退房")
        if reservation.status != ReservationStatus.CHECKED_IN:
            raise _conflict("预订状态异常，无法退房")
        if not can_transition_reservation(
            reservation.status, ReservationStatus.COMPLETED
        ):
            raise _conflict("非法预订状态转换")
        # Sprint 5 §27：退房事务显式锁 Room（顺序 Stay -> Room，
        # 与 Maintenance 事务 Room -> MWO 无环），串行化 vs 维修工单事务
        room = db.scalar(
            select(Room).where(Room.id == stay.room_id).with_for_update()
        )
        if room is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="房间不存在"
            )

        stay.status = StayStatus.CHECKED_OUT
        stay.actual_check_out_at = property_now()
        stay.updated_by = user.id if user is not None else None
        reservation.status = ReservationStatus.COMPLETED
        reservation.updated_by = user.id if user is not None else None

        # Sprint 5 §18：Maintenance-aware 退房（Cleaning 仍无条件置 dirty）
        # - 存在 active blocking MWO -> out_of_service + source=MAINTENANCE
        # - 无 blocking MWO -> available
        # - 已 out_of_service（MANUAL 或 MAINTENANCE）-> 保持停用且来源不变
        #   （退房不得解除人工停用；MAINTENANCE 来源也由维修域负责解除）
        blocking = has_active_blocking_orders(db, room.id)
        if room.occupancy_status == OccupancyStatus.out_of_service:
            room_target = OccupancyStatus.out_of_service
        elif blocking:
            room_target = OccupancyStatus.out_of_service
        else:
            room_target = OccupancyStatus.available

        room_occupancy_previous = room.occupancy_status.value
        if room.occupancy_status != room_target:
            if not can_change_occupancy(room.occupancy_status, room_target):
                raise _conflict("房间占用状态异常，无法退房")
            room.occupancy_status = room_target
            if room_target == OccupancyStatus.out_of_service:
                room.unavailability_source = UnavailabilitySource.MAINTENANCE
            else:
                room.unavailability_source = None
        # 退房即脏房：无条件置 dirty（决策见 DECISIONS，不走手动状态接口）
        room.cleaning_status = CleaningStatus.dirty

        db.flush()
        details = {
            "stay_no": stay.stay_no,
            "stay_id": stay.id,
            "reservation_no": reservation.reservation_no,
            "reservation_id": reservation.id,
            "room_id": room.id,
            "room_number": room.room_number,
            "stay_from": StayStatus.ACTIVE.value,
            "stay_to": stay.status.value,
            "reservation_from": ReservationStatus.CHECKED_IN.value,
            "reservation_to": reservation.status.value,
            "room_occupancy": {
                "from": room_occupancy_previous,
                "to": room.occupancy_status.value,
            },
            "maintenance_blocking": blocking,
        }
        write_audit_log(
            db, user, "stay.check_out", "stay", stay.id, details, request
        )

        # Sprint 3：退房自动生成翻房任务（PENDING，source=CHECKOUT），
        # 与退房同事务：任务创建失败 -> 整个退房 rollback（原子不变式）
        create_checkout_task(db, room, stay, user, request)

        _commit_or_conflict(
            db,
            generic_detail="该入住记录已退房，请勿重复操作",
            double_booking_detail=_DOUBLE_BOOKING_DETAIL,
        )
        return stay
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("该入住记录已退房，请勿重复操作") from exc
    except OperationalError as exc:
        db.rollback()
        if _is_transaction_conflict(exc):
            raise _conflict("该入住记录已退房，请勿重复操作") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 权限裁剪序列化（REV-02 / REV-FINAL-04）
# ---------------------------------------------------------------------------


def build_guest_out(guest: Guest) -> dict:
    return {
        "id": guest.id,
        "name": guest.name,
        "phone": guest.phone,
        "email": guest.email,
        "notes": guest.notes,
        "created_at": guest.created_at,
        "updated_at": guest.updated_at,
    }


def build_reservation_out(
    reservation: Reservation, *, show_guest: bool
) -> dict:
    """Reservation 响应。show_guest = 当前用户持有 guest:read。"""
    out = {
        "id": reservation.id,
        "reservation_no": reservation.reservation_no,
        "guest_id": reservation.guest_id,
        "room_id": reservation.room_id,
        "room_type_id": reservation.room_type_id,
        "check_in_date": reservation.check_in_date,
        "check_out_date": reservation.check_out_date,
        "status": reservation.status,
        "source": reservation.source,
        "external_reference": reservation.external_reference,
        "agreed_total_amount": reservation.agreed_total_amount,
        "currency": reservation.currency,
        "notes": reservation.notes,
        "created_by": reservation.created_by,
        "updated_by": reservation.updated_by,
        "created_at": reservation.created_at,
        "updated_at": reservation.updated_at,
        "room_number": reservation.room.room_number
        if reservation.room is not None
        else None,
        "room_type_name": reservation.room_type.name
        if reservation.room_type is not None
        else None,
        "stay_id": reservation.stay.id
        if reservation.stay is not None
        else None,
    }
    if show_guest:
        out["guest_name"] = (
            reservation.guest.name if reservation.guest is not None else None
        )
    return out


def build_stay_out(
    stay: Stay, *, show_guest: bool, show_reservation: bool
) -> dict:
    """Stay 响应（REV-FINAL-04）：
    - guest_id 始终保留（关系关联）；guest_name 仅 guest:read 时出现
    - 嵌套 reservation 摘要仅 reservation:read 时出现
    """
    out = {
        "id": stay.id,
        "stay_no": stay.stay_no,
        "reservation_id": stay.reservation_id,
        "room_id": stay.room_id,
        "room_number": stay.room.room_number if stay.room is not None else None,
        "status": stay.status,
        "actual_check_in_at": stay.actual_check_in_at,
        "planned_check_out_date": stay.planned_check_out_date,
        "actual_check_out_at": stay.actual_check_out_at,
        "created_by": stay.created_by,
        "updated_by": stay.updated_by,
        "created_at": stay.created_at,
        "updated_at": stay.updated_at,
    }
    reservation = stay.reservation
    if reservation is not None:
        out["guest_id"] = reservation.guest_id
        if show_guest:
            out["guest_name"] = (
                reservation.guest.name
                if reservation.guest is not None
                else None
            )
        if show_reservation:
            out["reservation"] = {
                "reservation_no": reservation.reservation_no,
                "check_in_date": reservation.check_in_date,
                "check_out_date": reservation.check_out_date,
                "status": reservation.status,
                "source": reservation.source,
                "agreed_total_amount": reservation.agreed_total_amount,
                "currency": reservation.currency,
            }
    return out
