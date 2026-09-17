"""Dashboard 路由（alpha.9.6 F2：首页房态概览按日期显示）。

`GET /dashboard/room-status?date=YYYY-MM-DD`
- 默认 date = Property Business Date（Asia/Shanghai）。
- 权限：room:read（单权限码，与其他路由一致）。
- **核心业务规则全部在 backend**（app/services/room_status.py）：
  前端不得自己拉全部 Reservation 后计算房态。
- 明确区分「某日占用/销售状态」（status）与「当前物理状态」
  （effective_occupancy_status / current_cleaning_status，仅在业务日期返回）。
- 未来日期返回 `physical_status_authoritative=false`：**禁止用当前 Room.status
  冒充未来房态**，前端必须显式提示。
"""

from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import require_permissions
from app.core.business_date import business_date
from app.database import get_db
from app.models import User
from app.schemas.dashboard import RoomStatusOut
from app.services.room_status import resolve_room_status

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

# 允许查询的范围（防止无界查询与无意义的远古/远期房态）
MAX_PAST_DAYS = 31
MAX_FUTURE_DAYS = 365


@router.get(
    "/room-status",
    response_model=RoomStatusOut,
    summary="某日房态概览（启用房间的可售 / 已预订 / 在住 / 维修停用）",
)
def room_status(
    date: date_type | None = Query(
        None, description="查询日期 YYYY-MM-DD；不传则默认业务日期（今天）"
    ),
    _: User = Depends(require_permissions("room:read")),
    db: Session = Depends(get_db),
) -> dict:
    business_day = business_date()
    target = date if date is not None else business_day
    delta = (target - business_day).days
    if delta < -MAX_PAST_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"查询日期过早：最多可回溯 {MAX_PAST_DAYS} 天",
        )
    if delta > MAX_FUTURE_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"查询日期过远：最多可查询未来 {MAX_FUTURE_DAYS} 天",
        )
    return resolve_room_status(db, target)
