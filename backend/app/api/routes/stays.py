"""Stay 路由：列表 / 详情 / check-out。

权限：GET stay:read；check-out stay:check_out。
响应 PII 裁剪（REV-FINAL-04）：无 guest:read 仅保留 guest_id；
无 reservation:read 不含嵌套 reservation 摘要。
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_permission_codes, require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import Reservation, Stay, StayStatus, User
from app.schemas.common import Page
from app.schemas.stay import StayOut
from app.services.booking import build_stay_out, check_out_stay

router = APIRouter(prefix="/stays", tags=["stays"])


def _load_stay(db: Session, stay_id: int) -> Stay | None:
    return db.scalar(
        select(Stay)
        .where(Stay.id == stay_id)
        .options(
            selectinload(Stay.room),
            selectinload(Stay.reservation).selectinload(Reservation.guest),
        )
    )


@router.get(
    "",
    response_model=Page[StayOut],
    response_model_exclude_none=True,
)
def list_stays(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    stay_status: StayStatus | None = Query(None, alias="status"),
    room_id: int | None = Query(None),
    planned_check_out_date: date | None = Query(None),
    current_user: User = Depends(require_permissions("stay:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = (
        select(Stay)
        .options(
            selectinload(Stay.room),
            selectinload(Stay.reservation).selectinload(Reservation.guest),
        )
        .order_by(Stay.id.desc())
    )
    if stay_status is not None:
        stmt = stmt.where(Stay.status == stay_status)
    if room_id is not None:
        stmt = stmt.where(Stay.room_id == room_id)
    if planned_check_out_date is not None:
        stmt = stmt.where(Stay.planned_check_out_date == planned_check_out_date)
    codes = get_permission_codes(db, current_user)
    result = paginate(db, stmt, page, page_size)
    result["items"] = [
        build_stay_out(
            s,
            show_guest="guest:read" in codes,
            show_reservation="reservation:read" in codes,
        )
        for s in result["items"]
    ]
    return result


@router.get(
    "/{stay_id}",
    response_model=StayOut,
    response_model_exclude_none=True,
)
def get_stay(
    stay_id: int,
    current_user: User = Depends(require_permissions("stay:read")),
    db: Session = Depends(get_db),
) -> StayOut:
    stay = _load_stay(db, stay_id)
    if stay is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="入住记录不存在")
    codes = get_permission_codes(db, current_user)
    return build_stay_out(
        stay,
        show_guest="guest:read" in codes,
        show_reservation="reservation:read" in codes,
    )


@router.post(
    "/{stay_id}/check-out",
    response_model=StayOut,
    response_model_exclude_none=True,
)
def check_out_stay_endpoint(
    stay_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("stay:check_out")),
    db: Session = Depends(get_db),
) -> StayOut:
    stay = check_out_stay(db, stay_id, current_user, request)
    # 重新加载关联（service 事务提交后返回的对象关联未 eager load）
    refreshed = _load_stay(db, stay.id)
    assert refreshed is not None
    codes = get_permission_codes(db, current_user)
    return build_stay_out(
        refreshed,
        show_guest="guest:read" in codes,
        show_reservation="reservation:read" in codes,
    )
