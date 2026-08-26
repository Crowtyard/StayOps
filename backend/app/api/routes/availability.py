"""Availability 路由：GET /availability（可售性查询）。

权限：reservation:read。
参数：check_in_date / check_out_date（YYYY-MM-DD）、room_type_id?。
规则见 app/services/booking.py（总纲 §6）。
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import require_permissions
from app.database import get_db
from app.models import User
from app.schemas.availability import AvailabilityOut
from app.services.booking import query_availability

router = APIRouter(prefix="/availability", tags=["availability"])


@router.get("", response_model=AvailabilityOut)
def get_availability(
    check_in_date: date = Query(...),
    check_out_date: date = Query(...),
    room_type_id: int | None = Query(None),
    _: User = Depends(require_permissions("reservation:read")),
    db: Session = Depends(get_db),
) -> dict:
    if check_out_date <= check_in_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="check_out_date 必须晚于 check_in_date",
        )
    return query_availability(db, check_in_date, check_out_date, room_type_id)
