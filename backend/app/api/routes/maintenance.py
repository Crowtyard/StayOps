"""Maintenance Work Order 路由（Sprint 5，统一前缀 /api/v1/maintenance/orders）。

权限（Sprint 5 §31，用 permission 判断，不用角色名）：
- GET                             maintenance_order:read
- POST（报修）                    maintenance_order:write
- PATCH（基础字段编辑）           maintenance_order:write
- assign                          maintenance_order:write
- start / resolve                 maintenance_order:work
- verify / rework                 maintenance_order:verify
- cancel                          maintenance_order:cancel

状态只能经专用 action 端点变更；PATCH 不含 status / blocks_room
（strict schema，携带即 422）。前端只做提前提示，后端为最终权威。
"""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from sqlalchemy import case, or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import (
    MaintenanceCategory,
    MaintenanceSeverity,
    MaintenanceSource,
    MaintenanceWorkOrder,
    MaintenanceWorkOrderStatus,
    Permission,
    RolePermission,
    Room,
    User,
    UserRole,
)
from app.schemas.common import Page
from app.schemas.maintenance import (
    MaintenanceAssign,
    MaintenanceAssigneeOut,
    MaintenanceResolve,
    MaintenanceRework,
    MaintenanceVerify,
    MaintenanceWorkOrderCreate,
    MaintenanceWorkOrderOut,
    MaintenanceWorkOrderUpdate,
)
from app.services.maintenance import (
    assign_order,
    build_order_out,
    cancel_order,
    create_order,
    resolve_order,
    rework_order,
    start_order,
    update_order,
    verify_order,
)

router = APIRouter(prefix="/maintenance/orders", tags=["maintenance"])
assignees_router = APIRouter(prefix="/maintenance", tags=["maintenance"])


@assignees_router.get(
    "/assignees",
    response_model=list[MaintenanceAssigneeOut],
)
def list_assignees(
    _: User = Depends(require_permissions("maintenance_order:write")),
    db: Session = Depends(get_db),
) -> list[dict]:
    """可派单候选人：持有 maintenance_order:work 的在职用户（Sprint 5 §32）。

    复用 Alpha.3 Housekeeping assignee 模式：不因此给请求者扩大 user:read 权限，
    也不暴露任何 Guest PII。
    """
    stmt = (
        select(User)
        .join(UserRole, UserRole.user_id == User.id)
        .join(RolePermission, RolePermission.role_id == UserRole.role_id)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .where(
            Permission.code == "maintenance_order:work",
            User.is_active.is_(True),
        )
        .distinct()
        .order_by(User.username)
    )
    users = db.scalars(stmt).all()
    return [
        {
            "id": u.id,
            "display_name": u.display_name or u.username,
            "username": u.username,
        }
        for u in users
    ]


_ORDER_LOAD_OPTIONS = (
    selectinload(MaintenanceWorkOrder.room),
    selectinload(MaintenanceWorkOrder.assigned_to),
    selectinload(MaintenanceWorkOrder.reported_by),
    selectinload(MaintenanceWorkOrder.verified_by),
)


def _load(db: Session, order_id: int) -> MaintenanceWorkOrder | None:
    return db.scalar(
        select(MaintenanceWorkOrder)
        .where(MaintenanceWorkOrder.id == order_id)
        .options(*_ORDER_LOAD_OPTIONS)
    )


def _get_or_404(db: Session, order_id: int) -> MaintenanceWorkOrder:
    order = _load(db, order_id)
    if order is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="维修工单不存在"
        )
    return order


@router.get(
    "",
    response_model=Page[MaintenanceWorkOrderOut],
    response_model_exclude_none=True,
)
def list_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    order_status: MaintenanceWorkOrderStatus | None = Query(None, alias="status"),
    room_id: int | None = Query(None),
    category: MaintenanceCategory | None = Query(None),
    severity: MaintenanceSeverity | None = Query(None),
    assigned_to: int | None = Query(None),
    blocks_room: bool | None = Query(None),
    source: MaintenanceSource | None = Query(None),
    search: str | None = Query(None),
    _: User = Depends(require_permissions("maintenance_order:read")),
    db: Session = Depends(get_db),
) -> dict:
    """工单列表：筛选 + search（work_order_no / room_no / title，不搜 Guest PII）。

    排序：进行中工单按流程序（OPEN -> ASSIGNED -> IN_PROGRESS -> RESOLVED）
    优先展示，同状态按创建时间升序（先报先处理）；终态排后。
    """
    status_order = case(
        (MaintenanceWorkOrder.status == MaintenanceWorkOrderStatus.OPEN, 0),
        (MaintenanceWorkOrder.status == MaintenanceWorkOrderStatus.ASSIGNED, 1),
        (MaintenanceWorkOrder.status == MaintenanceWorkOrderStatus.IN_PROGRESS, 2),
        (MaintenanceWorkOrder.status == MaintenanceWorkOrderStatus.RESOLVED, 3),
        (MaintenanceWorkOrder.status == MaintenanceWorkOrderStatus.COMPLETED, 4),
        else_=5,
    )
    stmt = (
        select(MaintenanceWorkOrder)
        .options(*_ORDER_LOAD_OPTIONS)
        .order_by(status_order, MaintenanceWorkOrder.created_at.asc())
    )
    if order_status is not None:
        stmt = stmt.where(MaintenanceWorkOrder.status == order_status)
    if room_id is not None:
        stmt = stmt.where(MaintenanceWorkOrder.room_id == room_id)
    if category is not None:
        stmt = stmt.where(MaintenanceWorkOrder.category == category)
    if severity is not None:
        stmt = stmt.where(MaintenanceWorkOrder.severity == severity)
    if assigned_to is not None:
        stmt = stmt.where(
            MaintenanceWorkOrder.assigned_to_user_id == assigned_to
        )
    if blocks_room is not None:
        stmt = stmt.where(MaintenanceWorkOrder.blocks_room.is_(blocks_room))
    if source is not None:
        stmt = stmt.where(MaintenanceWorkOrder.source == source)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.join(Room, MaintenanceWorkOrder.room_id == Room.id).where(
            or_(
                MaintenanceWorkOrder.work_order_no.ilike(pattern),
                MaintenanceWorkOrder.title.ilike(pattern),
                Room.room_number.ilike(pattern),
            )
        )
    result = paginate(db, stmt, page, page_size)
    result["items"] = [build_order_out(o) for o in result["items"]]
    return result


@router.post(
    "",
    response_model=MaintenanceWorkOrderOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_order(
    payload: MaintenanceWorkOrderCreate,
    request: Request,
    current_user: User = Depends(require_permissions("maintenance_order:write")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    order = create_order(db, payload, current_user, request)
    return build_order_out(_get_or_404(db, order.id))


@router.get(
    "/{order_id}",
    response_model=MaintenanceWorkOrderOut,
    response_model_exclude_none=True,
)
def get_order(
    order_id: int,
    _: User = Depends(require_permissions("maintenance_order:read")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    return build_order_out(_get_or_404(db, order_id))


@router.patch(
    "/{order_id}",
    response_model=MaintenanceWorkOrderOut,
    response_model_exclude_none=True,
)
def patch_order(
    order_id: int,
    payload: MaintenanceWorkOrderUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("maintenance_order:write")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    order = db.scalar(
        select(MaintenanceWorkOrder)
        .where(MaintenanceWorkOrder.id == order_id)
        .with_for_update()
    )
    if order is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="维修工单不存在"
        )
    update_order(db, order, payload, current_user, request)
    return build_order_out(_get_or_404(db, order_id))


@router.post(
    "/{order_id}/assign",
    response_model=MaintenanceWorkOrderOut,
    response_model_exclude_none=True,
)
def assign_endpoint(
    order_id: int,
    payload: MaintenanceAssign,
    request: Request,
    current_user: User = Depends(require_permissions("maintenance_order:write")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    order = assign_order(db, order_id, payload, current_user, request)
    return build_order_out(_get_or_404(db, order.id))


@router.post(
    "/{order_id}/start",
    response_model=MaintenanceWorkOrderOut,
    response_model_exclude_none=True,
)
def start_endpoint(
    order_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("maintenance_order:work")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    order = start_order(db, order_id, current_user, request)
    return build_order_out(_get_or_404(db, order.id))


@router.post(
    "/{order_id}/resolve",
    response_model=MaintenanceWorkOrderOut,
    response_model_exclude_none=True,
)
def resolve_endpoint(
    order_id: int,
    request: Request,
    payload: Annotated[MaintenanceResolve | None, Body()] = None,
    current_user: User = Depends(require_permissions("maintenance_order:work")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    order = resolve_order(db, order_id, payload, current_user, request)
    return build_order_out(_get_or_404(db, order.id))


@router.post(
    "/{order_id}/verify",
    response_model=MaintenanceWorkOrderOut,
    response_model_exclude_none=True,
)
def verify_endpoint(
    order_id: int,
    request: Request,
    payload: Annotated[MaintenanceVerify | None, Body()] = None,
    current_user: User = Depends(require_permissions("maintenance_order:verify")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    order = verify_order(db, order_id, payload, current_user, request)
    return build_order_out(_get_or_404(db, order.id))


@router.post(
    "/{order_id}/rework",
    response_model=MaintenanceWorkOrderOut,
    response_model_exclude_none=True,
)
def rework_endpoint(
    order_id: int,
    request: Request,
    payload: Annotated[MaintenanceRework | None, Body()] = None,
    current_user: User = Depends(require_permissions("maintenance_order:verify")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    order = rework_order(db, order_id, payload, current_user, request)
    return build_order_out(_get_or_404(db, order.id))


@router.post(
    "/{order_id}/cancel",
    response_model=MaintenanceWorkOrderOut,
    response_model_exclude_none=True,
)
def cancel_endpoint(
    order_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("maintenance_order:cancel")),
    db: Session = Depends(get_db),
) -> MaintenanceWorkOrderOut:
    order = cancel_order(db, order_id, current_user, request)
    return build_order_out(_get_or_404(db, order.id))
