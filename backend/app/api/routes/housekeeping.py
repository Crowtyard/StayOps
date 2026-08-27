"""Housekeeping 任务路由（Sprint 3，统一前缀 /api/v1/housekeeping/tasks）。

权限：
- GET    housekeeping_task:read
- POST   housekeeping_task:write（手动创建）
- PATCH  housekeeping_task:write（assignment / priority / notes）
- start / submit-inspection  housekeeping_task:work
- pass / rework              housekeeping_task:inspect
- cancel                     housekeeping_task:cancel

状态只能经专用 action 端点变更；PATCH 不含 status（strict schema，携带即 422）。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import case, or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import (
    HousekeepingTask,
    HousekeepingTaskPriority,
    HousekeepingTaskSource,
    HousekeepingTaskStatus,
    Permission,
    RolePermission,
    Room,
    User,
    UserRole,
)
from app.schemas.common import Page
from app.schemas.housekeeping import (
    HousekeepingAssigneeOut,
    HousekeepingTaskCreate,
    HousekeepingTaskOut,
    HousekeepingTaskUpdate,
)
from app.services.housekeeping import (
    build_task_out,
    cancel_task,
    create_manual_task,
    pass_task,
    rework_task,
    start_task,
    submit_inspection,
    update_task,
)

router = APIRouter(prefix="/housekeeping/tasks", tags=["housekeeping"])
assignees_router = APIRouter(prefix="/housekeeping", tags=["housekeeping"])


@assignees_router.get(
    "/assignees",
    response_model=list[HousekeepingAssigneeOut],
)
def list_assignees(
    _: User = Depends(require_permissions("housekeeping_task:write")),
    db: Session = Depends(get_db),
) -> list[dict]:
    """可派单候选人：持有 housekeeping_task:work 的在职用户。

    供 MANAGER / FRONT_DESK 派单选择（不需要 user:read，也不暴露任何 Guest PII）。
    """
    stmt = (
        select(User)
        .join(UserRole, UserRole.user_id == User.id)
        .join(RolePermission, RolePermission.role_id == UserRole.role_id)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .where(
            Permission.code == "housekeeping_task:work",
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

_TASK_LOAD_OPTIONS = (
    selectinload(HousekeepingTask.room),
    selectinload(HousekeepingTask.assigned_to),
)


def _load(db: Session, task_id: int) -> HousekeepingTask | None:
    return db.scalar(
        select(HousekeepingTask)
        .where(HousekeepingTask.id == task_id)
        .options(*_TASK_LOAD_OPTIONS)
    )


def _get_or_404(db: Session, task_id: int) -> HousekeepingTask:
    task = _load(db, task_id)
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="保洁任务不存在"
        )
    return task


@router.get(
    "",
    response_model=Page[HousekeepingTaskOut],
    response_model_exclude_none=True,
)
def list_tasks(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    task_status: HousekeepingTaskStatus | None = Query(None, alias="status"),
    room_id: int | None = Query(None),
    assigned_to_user_id: int | None = Query(None),
    priority: HousekeepingTaskPriority | None = Query(None),
    source: HousekeepingTaskSource | None = Query(None),
    search: str | None = Query(None),
    _: User = Depends(require_permissions("housekeeping_task:read")),
    db: Session = Depends(get_db),
) -> dict:
    """任务列表：筛选 + search（仅 task_no / room_no，非 PII）。

    排序：进行中任务按流程序（PENDING → IN_PROGRESS → INSPECTION → REWORK）
    优先展示，同状态按创建时间升序（先到先处理）；终态排后。
    """
    status_order = case(
        (HousekeepingTask.status == HousekeepingTaskStatus.PENDING, 0),
        (HousekeepingTask.status == HousekeepingTaskStatus.IN_PROGRESS, 1),
        (HousekeepingTask.status == HousekeepingTaskStatus.INSPECTION, 2),
        (HousekeepingTask.status == HousekeepingTaskStatus.REWORK, 3),
        (HousekeepingTask.status == HousekeepingTaskStatus.COMPLETED, 4),
        else_=5,
    )
    stmt = (
        select(HousekeepingTask)
        .options(*_TASK_LOAD_OPTIONS)
        .order_by(status_order, HousekeepingTask.created_at.asc())
    )
    if task_status is not None:
        stmt = stmt.where(HousekeepingTask.status == task_status)
    if room_id is not None:
        stmt = stmt.where(HousekeepingTask.room_id == room_id)
    if assigned_to_user_id is not None:
        stmt = stmt.where(HousekeepingTask.assigned_to_user_id == assigned_to_user_id)
    if priority is not None:
        stmt = stmt.where(HousekeepingTask.priority == priority)
    if source is not None:
        stmt = stmt.where(HousekeepingTask.source == source)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.join(Room, HousekeepingTask.room_id == Room.id).where(
            or_(
                HousekeepingTask.task_no.ilike(pattern),
                Room.room_number.ilike(pattern),
            )
        )
    result = paginate(db, stmt, page, page_size)
    result["items"] = [build_task_out(t) for t in result["items"]]
    return result


@router.post(
    "",
    response_model=HousekeepingTaskOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_task(
    payload: HousekeepingTaskCreate,
    request: Request,
    current_user: User = Depends(require_permissions("housekeeping_task:write")),
    db: Session = Depends(get_db),
) -> HousekeepingTaskOut:
    task = create_manual_task(db, payload, current_user, request)
    return build_task_out(task)


@router.get(
    "/{task_id}",
    response_model=HousekeepingTaskOut,
    response_model_exclude_none=True,
)
def get_task(
    task_id: int,
    _: User = Depends(require_permissions("housekeeping_task:read")),
    db: Session = Depends(get_db),
) -> HousekeepingTaskOut:
    return build_task_out(_get_or_404(db, task_id))


@router.patch(
    "/{task_id}",
    response_model=HousekeepingTaskOut,
    response_model_exclude_none=True,
)
def patch_task(
    task_id: int,
    payload: HousekeepingTaskUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("housekeeping_task:write")),
    db: Session = Depends(get_db),
) -> HousekeepingTaskOut:
    task = db.scalar(
        select(HousekeepingTask)
        .where(HousekeepingTask.id == task_id)
        .with_for_update()
    )
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="保洁任务不存在"
        )
    update_task(db, task, payload, current_user, request)
    return build_task_out(_get_or_404(db, task_id))


@router.post(
    "/{task_id}/start",
    response_model=HousekeepingTaskOut,
    response_model_exclude_none=True,
)
def start_task_endpoint(
    task_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("housekeeping_task:work")),
    db: Session = Depends(get_db),
) -> HousekeepingTaskOut:
    task = start_task(db, task_id, current_user, request)
    return build_task_out(_get_or_404(db, task.id))


@router.post(
    "/{task_id}/submit-inspection",
    response_model=HousekeepingTaskOut,
    response_model_exclude_none=True,
)
def submit_inspection_endpoint(
    task_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("housekeeping_task:work")),
    db: Session = Depends(get_db),
) -> HousekeepingTaskOut:
    task = submit_inspection(db, task_id, current_user, request)
    return build_task_out(_get_or_404(db, task.id))


@router.post(
    "/{task_id}/pass",
    response_model=HousekeepingTaskOut,
    response_model_exclude_none=True,
)
def pass_task_endpoint(
    task_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("housekeeping_task:inspect")),
    db: Session = Depends(get_db),
) -> HousekeepingTaskOut:
    task = pass_task(db, task_id, current_user, request)
    return build_task_out(_get_or_404(db, task.id))


@router.post(
    "/{task_id}/rework",
    response_model=HousekeepingTaskOut,
    response_model_exclude_none=True,
)
def rework_task_endpoint(
    task_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("housekeeping_task:inspect")),
    db: Session = Depends(get_db),
) -> HousekeepingTaskOut:
    task = rework_task(db, task_id, current_user, request)
    return build_task_out(_get_or_404(db, task.id))


@router.post(
    "/{task_id}/cancel",
    response_model=HousekeepingTaskOut,
    response_model_exclude_none=True,
)
def cancel_task_endpoint(
    task_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("housekeeping_task:cancel")),
    db: Session = Depends(get_db),
) -> HousekeepingTaskOut:
    task = cancel_task(db, task_id, current_user, request)
    return build_task_out(_get_or_404(db, task.id))
