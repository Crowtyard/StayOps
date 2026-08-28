"""Reservation 路由：列表 / 创建 / 详情 / PATCH / cancel / no-show / check-in。

权限：
- GET reservation:read；POST·PATCH reservation:write
- cancel reservation:cancel；no-show reservation:no_show；check-in stay:check_in
响应 PII 裁剪：无 guest:read 时不含 guest_name（仅保留 guest_id）。
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_permission_codes, require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import (
    Guest,
    Reservation,
    ReservationSource,
    ReservationStatus,
    User,
)
from app.schemas.common import Page
from app.schemas.reservation import (
    ReservationCreate,
    ReservationOut,
    ReservationUpdate,
)
from app.schemas.stay import CheckInOut, StayOut
from app.services.booking import (
    build_reservation_out,
    build_stay_out,
    cancel_reservation,
    check_in_reservation,
    create_reservation,
    no_show_reservation,
    update_reservation,
)

router = APIRouter(prefix="/reservations", tags=["reservations"])


def _get_or_404(db: Session, reservation_id: int) -> Reservation:
    reservation = db.get(Reservation, reservation_id)
    if reservation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="预订不存在")
    return reservation


@router.get(
    "",
    response_model=Page[ReservationOut],
    response_model_exclude_none=True,
)
def list_reservations(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    reservation_status: ReservationStatus | None = Query(None, alias="status"),
    room_id: int | None = Query(None),
    guest_id: int | None = Query(None),
    room_type_id: int | None = Query(None),
    source: ReservationSource | None = Query(None),
    check_in_date: date | None = Query(None),
    check_out_date: date | None = Query(None),
    search: str | None = Query(None),
    overlap_from: date | None = Query(
        None,
        description=(
            "日期窗口重叠查询（Sprint 4）：与 overlap_to 成对提供。"
            "语义 = 预订区间 [check_in_date, check_out_date) 与 [overlap_from,"
            " overlap_to) 有重叠（check_in < overlap_to AND check_out >"
            " overlap_from，紧邻不视为重叠）。"
        ),
    ),
    overlap_to: date | None = Query(None),
    current_user: User = Depends(require_permissions("reservation:read")),
    db: Session = Depends(get_db),
) -> dict:
    """预订列表：筛选 + search（reservation_no OR Guest name/phone，REV-FINAL-07）。

    search 命中 Guest 的结果仍遵守 guest:read（响应不返回 guest_name）。
    Sprint 4 新增 overlap_from / overlap_to：日期窗口重叠查询（供 /front-desk
    Room Diary 批量拉取时间线数据，语义 [from, to)），不改变写操作。
    """
    if (overlap_from is None) != (overlap_to is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="overlap_from 与 overlap_to 必须同时提供",
        )
    if (
        overlap_from is not None
        and overlap_to is not None
        and overlap_from >= overlap_to
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="overlap_to 必须晚于 overlap_from",
        )
    stmt = (
        select(Reservation)
        .options(
            selectinload(Reservation.guest),
            selectinload(Reservation.room),
            selectinload(Reservation.room_type),
            selectinload(Reservation.stay),
        )
        .order_by(Reservation.id.desc())
    )
    if reservation_status is not None:
        stmt = stmt.where(Reservation.status == reservation_status)
    if room_id is not None:
        stmt = stmt.where(Reservation.room_id == room_id)
    if guest_id is not None:
        stmt = stmt.where(Reservation.guest_id == guest_id)
    if room_type_id is not None:
        stmt = stmt.where(Reservation.room_type_id == room_type_id)
    if source is not None:
        stmt = stmt.where(Reservation.source == source)
    if check_in_date is not None:
        stmt = stmt.where(Reservation.check_in_date == check_in_date)
    if check_out_date is not None:
        stmt = stmt.where(Reservation.check_out_date == check_out_date)
    if overlap_from is not None and overlap_to is not None:
        # 区间重叠：[check_in, check_out) ∩ [overlap_from, overlap_to) ≠ ∅
        # 即 check_in < overlap_to AND check_out > overlap_from（紧邻不重叠）
        stmt = stmt.where(
            Reservation.check_in_date < overlap_to,
            Reservation.check_out_date > overlap_from,
        )
    if search:
        pattern = f"%{search}%"
        stmt = stmt.join(Guest, Reservation.guest_id == Guest.id).where(
            or_(
                Reservation.reservation_no.ilike(pattern),
                Guest.name.ilike(pattern),
                Guest.phone.ilike(pattern),
            )
        )
    show_guest = "guest:read" in get_permission_codes(db, current_user)
    result = paginate(db, stmt, page, page_size)
    result["items"] = [
        build_reservation_out(r, show_guest=show_guest) for r in result["items"]
    ]
    return result


@router.post(
    "",
    response_model=ReservationOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_reservation(
    payload: ReservationCreate,
    request: Request,
    current_user: User = Depends(require_permissions("reservation:write")),
    db: Session = Depends(get_db),
) -> ReservationOut:
    reservation = create_reservation(db, payload, current_user, request)
    show_guest = "guest:read" in get_permission_codes(db, current_user)
    return build_reservation_out(reservation, show_guest=show_guest)


@router.get(
    "/{reservation_id}",
    response_model=ReservationOut,
    response_model_exclude_none=True,
)
def get_reservation(
    reservation_id: int,
    current_user: User = Depends(require_permissions("reservation:read")),
    db: Session = Depends(get_db),
) -> ReservationOut:
    reservation = db.scalar(
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .options(
            selectinload(Reservation.guest),
            selectinload(Reservation.room),
            selectinload(Reservation.room_type),
            selectinload(Reservation.stay),
        )
    )
    if reservation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="预订不存在")
    show_guest = "guest:read" in get_permission_codes(db, current_user)
    return build_reservation_out(reservation, show_guest=show_guest)


@router.patch(
    "/{reservation_id}",
    response_model=ReservationOut,
    response_model_exclude_none=True,
)
def patch_reservation(
    reservation_id: int,
    payload: ReservationUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("reservation:write")),
    db: Session = Depends(get_db),
) -> ReservationOut:
    reservation = db.scalar(
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .with_for_update()
    )
    if reservation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="预订不存在")
    update_reservation(db, reservation, payload, current_user, request)
    show_guest = "guest:read" in get_permission_codes(db, current_user)
    return build_reservation_out(reservation, show_guest=show_guest)


@router.post(
    "/{reservation_id}/cancel",
    response_model=ReservationOut,
    response_model_exclude_none=True,
)
def cancel_reservation_endpoint(
    reservation_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("reservation:cancel")),
    db: Session = Depends(get_db),
) -> ReservationOut:
    reservation = db.scalar(
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .with_for_update()
    )
    if reservation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="预订不存在")
    cancel_reservation(db, reservation, current_user, request)
    show_guest = "guest:read" in get_permission_codes(db, current_user)
    return build_reservation_out(reservation, show_guest=show_guest)


@router.post(
    "/{reservation_id}/no-show",
    response_model=ReservationOut,
    response_model_exclude_none=True,
)
def no_show_reservation_endpoint(
    reservation_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("reservation:no_show")),
    db: Session = Depends(get_db),
) -> ReservationOut:
    reservation = db.scalar(
        select(Reservation)
        .where(Reservation.id == reservation_id)
        .with_for_update()
    )
    if reservation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="预订不存在")
    no_show_reservation(db, reservation, current_user, request)
    show_guest = "guest:read" in get_permission_codes(db, current_user)
    return build_reservation_out(reservation, show_guest=show_guest)


@router.post(
    "/{reservation_id}/check-in",
    response_model=CheckInOut,
    response_model_exclude_none=True,
)
def check_in_reservation_endpoint(
    reservation_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("stay:check_in")),
    db: Session = Depends(get_db),
) -> CheckInOut:
    reservation, stay = check_in_reservation(
        db, reservation_id, current_user, request
    )
    codes = get_permission_codes(db, current_user)
    return CheckInOut(
        reservation=build_reservation_out(
            reservation, show_guest="guest:read" in codes
        ),
        stay=build_stay_out(
            stay,
            show_guest="guest:read" in codes,
            show_reservation="reservation:read" in codes,
        ),
    )
