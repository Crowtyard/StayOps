"""Housekeeping 域服务层（Sprint 3）：任务生命周期、状态机与房态原子联动、审计。

决策（docs/DECISIONS.md）：
- 业务单号：task_no 使用 PG Sequence（housekeeping_task_no_seq）原子生成 +
  UNIQUE 约束（禁止 SELECT MAX+1）。
- Task 状态变化 + Room.cleaning_status + Audit 在同一数据库事务内完成，
  任一步失败全部回滚。
- Active Task 唯一：应用层预检为快速路径；数据库部分唯一索引
  （uq_housekeeping_tasks_active_room）为最终仲裁，冲突映射为 409。
- 并发转换：SELECT ... FOR UPDATE 串行化 + 状态机校验，
  并发 start / pass vs rework 最终只有一个合法结果。
- 手动创建任务仅允许 cleaning_status = dirty 且非 occupied 的房间
  （不做住中保洁，Sprint 3 Out of Scope）。
- Checkout 自动生成任务由 services/booking.py 在同一退房事务内调用
  create_checkout_task（不 commit），保证「退房必有翻房任务」原子不变式。
"""

from fastapi import HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.business_date import business_date, property_now
from app.core.housekeeping_state_machine import (
    TASK_TO_CLEANING,
    can_transition_housekeeping_task,
    is_active_task_status,
)
from app.models import (
    CleaningStatus,
    HousekeepingTask,
    HousekeepingTaskPriority,
    HousekeepingTaskSource,
    HousekeepingTaskStatus,
    OccupancyStatus,
    Room,
    Stay,
    User,
)
from app.schemas.housekeeping import HousekeepingTaskCreate, HousekeepingTaskUpdate

TASK_NO_SEQ = "housekeeping_task_no_seq"

_TASK_ACTIVE_PREDICATE = (
    HousekeepingTaskStatus.PENDING,
    HousekeepingTaskStatus.IN_PROGRESS,
    HousekeepingTaskStatus.INSPECTION,
    HousekeepingTaskStatus.REWORK,
)


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail
    )


def next_task_no(db: Session) -> str:
    """格式 HKT{YYYYMMDD}-{NNNN}（日期 = Property Business Date，序号 = Sequence）。"""
    value = db.scalar(text(f"SELECT nextval('{TASK_NO_SEQ}')"))
    return f"HKT{business_date():%Y%m%d}-{value:04d}"


def _commit_or_conflict(db: Session, generic_detail: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        # 部分唯一索引冲突（Active Task 唯一，23505）与其它完整性冲突统一 409
        raise _conflict(generic_detail) from exc


# ---------------------------------------------------------------------------
# 序列化
# ---------------------------------------------------------------------------


def build_task_out(task: HousekeepingTask) -> dict:
    """任务响应。不包含任何 Guest / Reservation 数据（Housekeeping 域无 PII）。"""
    assignee = task.assigned_to
    return {
        "id": task.id,
        "task_no": task.task_no,
        "room_id": task.room_id,
        "room_number": task.room.room_number if task.room is not None else None,
        "status": task.status,
        "priority": task.priority,
        "source": task.source,
        "assigned_to_user_id": task.assigned_to_user_id,
        "assignee_name": (
            (assignee.display_name or assignee.username)
            if assignee is not None
            else None
        ),
        "notes": task.notes,
        "started_at": task.started_at,
        "submitted_for_inspection_at": task.submitted_for_inspection_at,
        "completed_at": task.completed_at,
        "cancelled_at": task.cancelled_at,
        "created_by": task.created_by,
        "updated_by": task.updated_by,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
    }


def _audit_basics(task: HousekeepingTask, room_number: str | None) -> dict:
    """审计摘要：仅任务单号/房号/来源/优先级/状态，不含任何 PII 与金额。"""
    return {
        "task_no": task.task_no,
        "room_id": task.room_id,
        "room_number": room_number,
        "source": task.source.value,
        "priority": task.priority.value,
    }


# ---------------------------------------------------------------------------
# 创建（手动 + Checkout 自动）
# ---------------------------------------------------------------------------


def _active_task_exists(db: Session, room_id: int) -> bool:
    return (
        db.scalar(
            select(HousekeepingTask.id).where(
                HousekeepingTask.room_id == room_id,
                HousekeepingTask.status.in_(_TASK_ACTIVE_PREDICATE),
            )
        )
        is not None
    )


def create_manual_task(
    db: Session,
    payload: HousekeepingTaskCreate,
    user: User | None,
    request=None,
) -> HousekeepingTask:
    """手动创建保洁任务（source=MANUAL）。

    前置：房间存在；cleaning_status = dirty；occupancy_status != occupied
    （不做住中保洁）；无进行中任务（预检；数据库部分唯一索引兜底）。
    """
    room = db.get(Room, payload.room_id)
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="房间不存在"
        )
    if room.occupancy_status == OccupancyStatus.occupied:
        raise _conflict("在住房间不能创建保洁任务（不做住中保洁）")
    if room.cleaning_status != CleaningStatus.dirty:
        raise _conflict("房间当前无需清扫（只有待清扫房间可创建保洁任务）")
    if _active_task_exists(db, room.id):
        raise _conflict("该房间已有进行中的保洁任务")

    task = HousekeepingTask(
        task_no=next_task_no(db),
        room_id=room.id,
        status=HousekeepingTaskStatus.PENDING,
        priority=payload.priority,
        source=HousekeepingTaskSource.MANUAL,
        notes=payload.notes,
        created_by=user.id if user is not None else None,
        updated_by=user.id if user is not None else None,
    )
    db.add(task)
    try:
        db.flush()
        details = _audit_basics(task, room.room_number)
        details.update({"from": None, "to": task.status.value})
        write_audit_log(
            db,
            user,
            "housekeeping.create",
            "housekeeping_task",
            task.id,
            details,
            request,
        )
        _commit_or_conflict(db, "该房间已有进行中的保洁任务")
        return task
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("该房间已有进行中的保洁任务") from exc
    except HTTPException:
        db.rollback()
        raise


def create_checkout_task(
    db: Session,
    room: Room,
    stay: Stay,
    user: User | None,
    request=None,
) -> HousekeepingTask:
    """Checkout 事务内创建翻房任务（source=CHECKOUT，PENDING）。

    由 services/booking.check_out_stay 在退房事务内调用；本函数只 flush
    不 commit，任何失败由退房事务整体回滚（原子不变式：退房必有翻房任务）。
    """
    task = HousekeepingTask(
        task_no=next_task_no(db),
        room_id=room.id,
        status=HousekeepingTaskStatus.PENDING,
        priority=HousekeepingTaskPriority.NORMAL,
        source=HousekeepingTaskSource.CHECKOUT,
        notes=None,
        created_by=user.id if user is not None else None,
        updated_by=user.id if user is not None else None,
    )
    db.add(task)
    db.flush()
    details = _audit_basics(task, room.room_number)
    details.update(
        {
            "from": None,
            "to": task.status.value,
            # Checkout 可追溯（不含 Guest PII / Reservation 数据）
            "stay_id": stay.id,
            "stay_no": stay.stay_no,
        }
    )
    write_audit_log(
        db,
        user,
        "housekeeping.create",
        "housekeeping_task",
        task.id,
        details,
        request,
    )
    db.flush()
    return task


# ---------------------------------------------------------------------------
# PATCH（assignment / priority / notes）
# ---------------------------------------------------------------------------


def update_task(
    db: Session,
    task: HousekeepingTask,
    payload: HousekeepingTaskUpdate,
    user: User | None,
    request=None,
) -> HousekeepingTask:
    """PATCH 仅限进行中任务；status 不进入 schema（strict，携带即 422）。"""
    if not is_active_task_status(task.status):
        raise _conflict("仅进行中的任务可修改")

    fields = payload.model_fields_set
    assign_changed = False
    other_changes: list[str] = []

    if "assigned_to_user_id" in fields:
        new_assignee = payload.assigned_to_user_id
        if new_assignee != task.assigned_to_user_id:
            if new_assignee is not None:
                target = db.get(User, new_assignee)
                if target is None or not target.is_active:
                    raise _unprocessable("被指派的用户不存在或已停用")
            old_assignee = task.assigned_to_user_id
            task.assigned_to_user_id = new_assignee
            assign_changed = True
            assign_details: dict = _audit_basics(
                task, _room_number(db, task.room_id)
            )
            assign_details.update(
                {
                    "from_user_id": old_assignee,
                    "to_user_id": new_assignee,
                }
            )

    if "priority" in fields and payload.priority is not None:
        if payload.priority != task.priority:
            other_changes.append(
                f"priority:{task.priority.value}->{payload.priority.value}"
            )
            task.priority = payload.priority

    if "notes" in fields and payload.notes != task.notes:
        other_changes.append("notes")
        task.notes = payload.notes

    if not assign_changed and not other_changes:
        # 幂等：字段值未变化，直接返回当前任务（不写审计、不提交）
        return task

    task.updated_by = user.id if user is not None else None
    try:
        db.flush()
        if assign_changed:
            write_audit_log(
                db,
                user,
                "housekeeping.assign",
                "housekeeping_task",
                task.id,
                assign_details,
                request,
            )
        if other_changes:
            write_audit_log(
                db,
                user,
                "housekeeping.update",
                "housekeeping_task",
                task.id,
                {"changed": other_changes},
                request,
            )
        _commit_or_conflict(db, "任务修改失败：数据冲突")
        return task
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("任务修改失败：数据冲突") from exc
    except HTTPException:
        db.rollback()
        raise


def _room_number(db: Session, room_id: int) -> str | None:
    room = db.get(Room, room_id)
    return room.room_number if room is not None else None


# ---------------------------------------------------------------------------
# 状态转换（action 端点；Task + Room + Audit 同事务）
# ---------------------------------------------------------------------------


def _transition(
    db: Session,
    task: HousekeepingTask,
    target: HousekeepingTaskStatus,
    *,
    user: User | None,
    request,
    action: str,
    action_detail: str,
) -> HousekeepingTask:
    if not can_transition_housekeeping_task(task.status, target):
        raise _conflict(action_detail)
    room = db.get(Room, task.room_id)
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="房间不存在"
        )

    previous = task.status
    task.status = target
    task.updated_by = user.id if user is not None else None
    now = property_now()
    if target == HousekeepingTaskStatus.IN_PROGRESS and task.started_at is None:
        task.started_at = now  # 首次开始时间；REWORK 后重新开始不覆盖
    if target == HousekeepingTaskStatus.INSPECTION:
        task.submitted_for_inspection_at = now
    if target == HousekeepingTaskStatus.COMPLETED:
        task.completed_at = now
    if target == HousekeepingTaskStatus.CANCELLED:
        task.cancelled_at = now

    # Task ↔ Room 原子联动
    room.cleaning_status = TASK_TO_CLEANING[target]

    try:
        db.flush()
        details = _audit_basics(task, room.room_number)
        details.update({"from": previous.value, "to": target.value})
        write_audit_log(
            db,
            user,
            action,
            "housekeeping_task",
            task.id,
            details,
            request,
        )
        _commit_or_conflict(db, "任务状态变更失败：数据冲突")
        return task
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("任务状态变更失败：数据冲突") from exc
    except HTTPException:
        db.rollback()
        raise


def _load_for_update(db: Session, task_id: int) -> HousekeepingTask:
    task = db.scalar(
        select(HousekeepingTask).where(HousekeepingTask.id == task_id).with_for_update()
    )
    if task is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="保洁任务不存在"
        )
    return task


def start_task(
    db: Session, task_id: int, user: User | None, request=None
) -> HousekeepingTask:
    task = _load_for_update(db, task_id)
    return _transition(
        db,
        task,
        HousekeepingTaskStatus.IN_PROGRESS,
        user=user,
        request=request,
        action="housekeeping.start",
        action_detail="仅待清扫或返工的任务可开始清扫",
    )


def submit_inspection(
    db: Session, task_id: int, user: User | None, request=None
) -> HousekeepingTask:
    task = _load_for_update(db, task_id)
    return _transition(
        db,
        task,
        HousekeepingTaskStatus.INSPECTION,
        user=user,
        request=request,
        action="housekeeping.submit_inspection",
        action_detail="仅清扫中的任务可提交验房",
    )


def pass_task(
    db: Session, task_id: int, user: User | None, request=None
) -> HousekeepingTask:
    task = _load_for_update(db, task_id)
    return _transition(
        db,
        task,
        HousekeepingTaskStatus.COMPLETED,
        user=user,
        request=request,
        action="housekeeping.pass",
        action_detail="仅待验房的任务可通过验收",
    )


def rework_task(
    db: Session, task_id: int, user: User | None, request=None
) -> HousekeepingTask:
    task = _load_for_update(db, task_id)
    return _transition(
        db,
        task,
        HousekeepingTaskStatus.REWORK,
        user=user,
        request=request,
        action="housekeeping.rework",
        action_detail="仅待验房的任务可返工",
    )


def cancel_task(
    db: Session, task_id: int, user: User | None, request=None
) -> HousekeepingTask:
    task = _load_for_update(db, task_id)
    return _transition(
        db,
        task,
        HousekeepingTaskStatus.CANCELLED,
        user=user,
        request=request,
        action="housekeeping.cancel",
        action_detail="仅进行中的任务可取消",
    )
