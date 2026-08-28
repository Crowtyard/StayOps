"""Maintenance 域服务层（Sprint 5）：工单生命周期、阻断语义与房态原子联动、审计。

决策（docs/DECISIONS.md Sprint 5）：
- 业务单号：work_order_no 使用 PG Sequence（maintenance_work_order_no_seq）
  原子生成 + UNIQUE 约束（禁止 SELECT MAX+1）。
- 工单状态变化 + Room 可售性联动 + Audit 在同一数据库事务内完成，
  任一步失败全部回滚。
- 同一 Room 允许多张 Active 工单（Sprint 5 §21，不做 active-per-room 唯一约束）。
- 锁顺序（Sprint 5 §27）：所有影响 Room 可售性的 Maintenance transaction
  统一先锁 Room 再锁 MaintenanceWorkOrder；不涉及房态的 action（assign /
  start / resolve / rework / PATCH）只锁工单行。不允许不同路径使用相反锁顺序。
- blocks_room 语义（Sprint 5 §11）：blocks_room=true 且状态 ∈
  OPEN / ASSIGNED / IN_PROGRESS / RESOLVED 时阻断客房销售；RESOLVED 仍阻断。
- 创建 blocking 工单（Sprint 5 §13/§14）：
    Room = available -> 同一事务内置 out_of_service + source=MAINTENANCE
    Room = occupied / reserved / blocked / OOS(MANUAL) -> 保留当前占用/来源，
    工单本身负责阻断 Availability 与 Check-in。
- 自动恢复 Room（Sprint 5 §22/§23）：仅当 active blocking MWO count == 0
  且 Room = out_of_service 且 source == MAINTENANCE 才恢复 available + null；
  MANUAL OOS / blocked 永不被 Maintenance 解除。Cleaning Status 保持原值。
"""

from fastapi import HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.business_date import business_date, property_now
from app.core.db_conflict import is_transaction_conflict, pgcode
from app.core.maintenance_state_machine import (
    BLOCKING_STATUSES,
    can_transition_work_order,
)
from app.models import (
    MaintenanceWorkOrder,
    MaintenanceWorkOrderStatus,
    OccupancyStatus,
    Room,
    UnavailabilitySource,
    User,
)
from app.schemas.maintenance import (
    MaintenanceAssign,
    MaintenanceResolve,
    MaintenanceRework,
    MaintenanceVerify,
    MaintenanceWorkOrderCreate,
    MaintenanceWorkOrderUpdate,
)

WORK_ORDER_NO_SEQ = "maintenance_work_order_no_seq"

# 允许派单/改派的状态（尚未开始维修）
_ASSIGNABLE_STATUSES = (
    MaintenanceWorkOrderStatus.OPEN,
    MaintenanceWorkOrderStatus.ASSIGNED,
)

# PATCH 字段编辑允许的状态（非终态）
_EDITABLE_STATUSES = BLOCKING_STATUSES


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail
    )


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def next_work_order_no(db: Session) -> str:
    """格式 MWO{YYYYMMDD}-{NNNN}（日期 = Property Business Date，序号 = Sequence）。"""
    value = db.scalar(text(f"SELECT nextval('{WORK_ORDER_NO_SEQ}')"))
    return f"MWO{business_date():%Y%m%d}-{value:04d}"


def _commit_or_conflict(db: Session, generic_detail: str) -> None:
    """提交；IntegrityError 与 40P01/40001 并发仲裁映射 409，其余原样 re-raise。"""
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise _conflict(generic_detail) from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict(generic_detail) from exc
        # 其它 OperationalError（57014 / 连接故障 / 库不可用等）：
        # 基础设施错误语义，rollback 后原样 re-raise，不得转换/吞掉
        raise


# ---------------------------------------------------------------------------
# Active Blocking 查询（Availability / Check-in / Checkout 集成共用）
# ---------------------------------------------------------------------------


def active_blocking_room_ids(db: Session) -> set[int]:
    """存在 Active Blocking 工单的房间集合（Sprint 5 §16）。"""
    stmt = select(MaintenanceWorkOrder.room_id).where(
        MaintenanceWorkOrder.blocks_room.is_(True),
        MaintenanceWorkOrder.status.in_(BLOCKING_STATUSES),
    )
    return set(db.scalars(stmt).all())


def has_active_blocking_orders(db: Session, room_id: int) -> bool:
    """该房间当前是否存在 Active Blocking 工单。"""
    stmt = select(MaintenanceWorkOrder.id).where(
        MaintenanceWorkOrder.room_id == room_id,
        MaintenanceWorkOrder.blocks_room.is_(True),
        MaintenanceWorkOrder.status.in_(BLOCKING_STATUSES),
    )
    return db.scalar(stmt) is not None


def _maybe_restore_room(
    db: Session, room: Room
) -> bool:
    """解除 Maintenance 自己造成的 OOS（Sprint 5 §22/§23）。

    仅当：active blocking MWO == 0 AND Room = out_of_service
    AND unavailability_source == MAINTENANCE 时恢复 available + null。
    MANUAL OOS / blocked 永不被解除。Cleaning Status 保持原值。
    返回是否执行了恢复（供审计详情记录）。
    """
    if room.occupancy_status != OccupancyStatus.out_of_service:
        return False
    if room.unavailability_source != UnavailabilitySource.MAINTENANCE:
        return False
    if has_active_blocking_orders(db, room.id):
        return False
    room.occupancy_status = OccupancyStatus.available
    room.unavailability_source = None
    return True


# ---------------------------------------------------------------------------
# 锁（Sprint 5 §27：Room → MaintenanceWorkOrder，全项目一致）
# ---------------------------------------------------------------------------


def _lock_room(db: Session, room_id: int) -> Room:
    room = db.scalar(select(Room).where(Room.id == room_id).with_for_update())
    if room is None:
        raise _not_found("房间不存在")
    return room


def _load_work_order(db: Session, order_id: int, *, for_update: bool) -> MaintenanceWorkOrder:
    stmt = select(MaintenanceWorkOrder).where(MaintenanceWorkOrder.id == order_id)
    if for_update:
        stmt = stmt.with_for_update()
    order = db.scalar(stmt)
    if order is None:
        raise _not_found("维修工单不存在")
    return order


# ---------------------------------------------------------------------------
# 序列化
# ---------------------------------------------------------------------------


def build_order_out(order: MaintenanceWorkOrder) -> dict:
    """工单响应。不包含任何 Guest / Reservation 数据（Maintenance 域无 PII）。"""
    room = order.room
    assignee = order.assigned_to
    reporter = order.reported_by
    verifier = order.verified_by
    return {
        "id": order.id,
        "work_order_no": order.work_order_no,
        "room_id": order.room_id,
        "room_number": room.room_number if room is not None else None,
        "room_occupancy_status": (
            room.occupancy_status if room is not None else None
        ),
        "room_cleaning_status": (
            room.cleaning_status if room is not None else None
        ),
        "category": order.category,
        "severity": order.severity,
        "status": order.status,
        "source": order.source,
        "blocks_room": order.blocks_room,
        "title": order.title,
        "description": order.description,
        "reported_by_user_id": order.reported_by_user_id,
        "reporter_name": (
            (reporter.display_name or reporter.username)
            if reporter is not None
            else None
        ),
        "assigned_to_user_id": order.assigned_to_user_id,
        "assignee_name": (
            (assignee.display_name or assignee.username)
            if assignee is not None
            else None
        ),
        "verified_by_user_id": order.verified_by_user_id,
        "resolution_notes": order.resolution_notes,
        "verification_notes": order.verification_notes,
        "started_at": order.started_at,
        "resolved_at": order.resolved_at,
        "verified_at": order.verified_at,
        "completed_at": order.completed_at,
        "cancelled_at": order.cancelled_at,
        "created_by": order.created_by,
        "updated_by": order.updated_by,
        "created_at": order.created_at,
        "updated_at": order.updated_at,
    }


def _audit_basics(order: MaintenanceWorkOrder, room_number: str | None) -> dict:
    """审计摘要：仅工单单号/房号/分类/严重度/阻断/来源，不含任何 PII。"""
    return {
        "work_order_no": order.work_order_no,
        "room_id": order.room_id,
        "room_number": room_number,
        "category": order.category.value,
        "severity": order.severity.value,
        "blocks_room": order.blocks_room,
        "source": order.source.value,
    }


def _room_occupancy_details(
    *, previous: OccupancyStatus, current: OccupancyStatus
) -> dict:
    return {
        "room_occupancy": {
            "from": previous.value,
            "to": current.value,
        }
    }


# ---------------------------------------------------------------------------
# 创建（报修）
# ---------------------------------------------------------------------------


def create_order(
    db: Session,
    payload: MaintenanceWorkOrderCreate,
    user: User | None,
    request=None,
) -> MaintenanceWorkOrder:
    """创建工单（Sprint 5 §13/§14）。

    锁定房间行（Sprint 5 §27 锁顺序 Room -> MWO）：
    - blocks_room=true 且 Room = available -> 同事务内置 out_of_service +
      source=MAINTENANCE（Cleaning Status 不变）
    - Room = occupied / reserved / blocked / OOS(MANUAL) -> 保留当前
      占用/来源，工单本身负责阻断 Availability 与 Check-in
    - blocks_room=false -> Room 无变化
    """
    room = _lock_room(db, payload.room_id)

    order = MaintenanceWorkOrder(
        work_order_no=next_work_order_no(db),
        room_id=room.id,
        category=payload.category,
        severity=payload.severity,
        status=MaintenanceWorkOrderStatus.OPEN,
        source=payload.source,
        blocks_room=payload.blocks_room,
        title=payload.title,
        description=payload.description,
        reported_by_user_id=user.id if user is not None else None,
        created_by=user.id if user is not None else None,
        updated_by=user.id if user is not None else None,
    )
    db.add(order)

    room_previous = room.occupancy_status
    room_changed = False
    if payload.blocks_room and room.occupancy_status == OccupancyStatus.available:
        room.occupancy_status = OccupancyStatus.out_of_service
        room.unavailability_source = UnavailabilitySource.MAINTENANCE
        room_changed = True

    try:
        db.flush()
        details = _audit_basics(order, room.room_number)
        details.update({"from": None, "to": order.status.value})
        if room_changed:
            details.update(
                _room_occupancy_details(
                    previous=room_previous, current=room.occupancy_status
                )
            )
        write_audit_log(
            db,
            user,
            "maintenance.create",
            "maintenance_work_order",
            order.id,
            details,
            request,
        )
        _commit_or_conflict(db, "工单创建失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("工单创建失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("工单创建失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# PATCH（基础字段编辑；status / blocks_room 不得经 PATCH 修改）
# ---------------------------------------------------------------------------


def update_order(
    db: Session,
    order: MaintenanceWorkOrder,
    payload: MaintenanceWorkOrderUpdate,
    user: User | None,
    request=None,
) -> MaintenanceWorkOrder:
    """PATCH 仅限非终态工单；status / blocks_room 不进入 schema（strict，携带即 422）。"""
    if order.status not in _EDITABLE_STATUSES:
        raise _conflict("仅进行中的工单可修改")

    changes: list[str] = []
    if "category" in payload.model_fields_set and payload.category is not None:
        if payload.category != order.category:
            changes.append(
                f"category:{order.category.value}->{payload.category.value}"
            )
            order.category = payload.category
    if "severity" in payload.model_fields_set and payload.severity is not None:
        if payload.severity != order.severity:
            changes.append(
                f"severity:{order.severity.value}->{payload.severity.value}"
            )
            order.severity = payload.severity
    if "title" in payload.model_fields_set and payload.title is not None:
        if payload.title != order.title:
            changes.append("title")
            order.title = payload.title
    if "description" in payload.model_fields_set:
        if payload.description != order.description:
            changes.append("description")
            order.description = payload.description

    if not changes:
        # 幂等：字段值未变化，直接返回当前工单（不写审计、不提交）
        return order

    order.updated_by = user.id if user is not None else None
    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "maintenance.update",
            "maintenance_work_order",
            order.id,
            {"changed": changes},
            request,
        )
        _commit_or_conflict(db, "工单修改失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("工单修改失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("工单修改失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 状态转换（action 端点；影响可售性的转换与 Room 同事务 + 固定锁顺序）
# ---------------------------------------------------------------------------


def assign_order(
    db: Session,
    order_id: int,
    payload: MaintenanceAssign,
    user: User | None,
    request=None,
) -> MaintenanceWorkOrder:
    """派单 / 改派（Sprint 5 §10）：OPEN / ASSIGNED 状态可指派。"""
    order = _load_work_order(db, order_id, for_update=True)
    if order.status not in _ASSIGNABLE_STATUSES:
        raise _conflict("仅待处理或已派工的工单可指派维修人员")
    target = db.get(User, payload.assigned_to_user_id)
    if target is None or not target.is_active:
        raise _unprocessable("被指派的用户不存在或已停用")

    previous_assignee = order.assigned_to_user_id
    order.assigned_to_user_id = target.id
    order.updated_by = user.id if user is not None else None
    if order.status == MaintenanceWorkOrderStatus.OPEN:
        order.status = MaintenanceWorkOrderStatus.ASSIGNED

    try:
        db.flush()
        room = db.get(Room, order.room_id)
        details = _audit_basics(
            order, room.room_number if room is not None else None
        )
        details.update(
            {
                "from_user_id": previous_assignee,
                "to_user_id": target.id,
                "status": order.status.value,
            }
        )
        write_audit_log(
            db,
            user,
            "maintenance.assign",
            "maintenance_work_order",
            order.id,
            details,
            request,
        )
        _commit_or_conflict(db, "派单失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("派单失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("派单失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def _transition(
    db: Session,
    order: MaintenanceWorkOrder,
    target: MaintenanceWorkOrderStatus,
    *,
    user: User | None,
    request,
    action: str,
    action_detail: str,
    notes: str | None = None,
    note_field: str | None = None,
) -> MaintenanceWorkOrder:
    """通用状态转换（assign / start / resolve / rework 使用，只锁工单行）。

    verify / cancel 涉及 Room 可售性，由专用函数按固定锁顺序 Room -> MWO 实现。
    """
    if not can_transition_work_order(order.status, target):
        raise _conflict(action_detail)

    previous = order.status
    order.status = target
    order.updated_by = user.id if user is not None else None
    now = property_now()
    if target == MaintenanceWorkOrderStatus.IN_PROGRESS and order.started_at is None:
        order.started_at = now  # 首次开始时间；REWORK 后重新开始不覆盖
    if target == MaintenanceWorkOrderStatus.RESOLVED:
        order.resolved_at = now
    if target == MaintenanceWorkOrderStatus.COMPLETED:
        order.completed_at = now
        order.verified_at = now
        order.verified_by_user_id = user.id if user is not None else None
    if target == MaintenanceWorkOrderStatus.CANCELLED:
        order.cancelled_at = now
    if notes is not None and note_field is not None:
        setattr(order, note_field, notes)

    try:
        db.flush()
        room = db.get(Room, order.room_id)
        details = _audit_basics(
            order, room.room_number if room is not None else None
        )
        details.update({"from": previous.value, "to": target.value})
        if note_field is not None and notes is not None:
            details[f"{note_field}_recorded"] = True
        write_audit_log(
            db,
            user,
            action,
            "maintenance_work_order",
            order.id,
            details,
            request,
        )
        _commit_or_conflict(db, "工单状态变更失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("工单状态变更失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("工单状态变更失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def start_order(
    db: Session, order_id: int, user: User | None, request=None
) -> MaintenanceWorkOrder:
    order = _load_work_order(db, order_id, for_update=True)
    # 只允许 ASSIGNED -> start（RESOLVED -> IN_PROGRESS 是 rework 专属边）
    if order.status != MaintenanceWorkOrderStatus.ASSIGNED:
        raise _conflict("仅已派工的工单可开始维修")
    return _transition(
        db,
        order,
        MaintenanceWorkOrderStatus.IN_PROGRESS,
        user=user,
        request=request,
        action="maintenance.start",
        action_detail="仅已派工的工单可开始维修",
    )


def resolve_order(
    db: Session,
    order_id: int,
    payload: MaintenanceResolve | None,
    user: User | None,
    request=None,
) -> MaintenanceWorkOrder:
    order = _load_work_order(db, order_id, for_update=True)
    return _transition(
        db,
        order,
        MaintenanceWorkOrderStatus.RESOLVED,
        user=user,
        request=request,
        action="maintenance.resolve",
        action_detail="仅维修中的工单可提交解决",
        notes=payload.resolution_notes if payload is not None else None,
        note_field="resolution_notes",
    )


def verify_order(
    db: Session,
    order_id: int,
    payload: MaintenanceVerify | None,
    user: User | None,
    request=None,
) -> MaintenanceWorkOrder:
    """验收通过（Sprint 5 §24）：锁顺序 Room -> MWO，同一事务内：

    MWO -> COMPLETED + verified_at / verified_by / verification_notes
    -> 检查同房其它 active blocking MWO
    -> 若为最后一张 blocking 工单且 Room OOS source=MAINTENANCE
       -> Room available + source null（Cleaning Status 保持）
    -> Audit -> commit
    """
    # 先读 room_id（工单 room_id 不可变；只取标量，不把工单对象装入
    # identity map，保证后续 FOR UPDATE 读到锁内最新状态），再按固定顺序加锁
    room_id = db.scalar(
        select(MaintenanceWorkOrder.room_id).where(
            MaintenanceWorkOrder.id == order_id
        )
    )
    if room_id is None:
        raise _not_found("维修工单不存在")
    room = _lock_room(db, room_id)
    order = _load_work_order(db, order_id, for_update=True)

    if not can_transition_work_order(
        order.status, MaintenanceWorkOrderStatus.COMPLETED
    ):
        raise _conflict("仅待验收的工单可通过验收")

    previous = order.status
    order.status = MaintenanceWorkOrderStatus.COMPLETED
    order.updated_by = user.id if user is not None else None
    order.completed_at = property_now()
    order.verified_at = order.completed_at
    order.verified_by_user_id = user.id if user is not None else None
    if payload is not None and payload.verification_notes is not None:
        order.verification_notes = payload.verification_notes

    # 先 flush 状态变更：Last Blocking 判定必须看到本工单已离开 blocking 集合
    # （SessionLocal autoflush=False，未 flush 的 UPDATE 不会被后续查询看到）
    db.flush()
    room_previous = room.occupancy_status
    restored = _maybe_restore_room(db, room)

    try:
        db.flush()
        details = _audit_basics(order, room.room_number)
        details.update({"from": previous.value, "to": order.status.value})
        if payload is not None and payload.verification_notes is not None:
            details["verification_notes_recorded"] = True
        if restored:
            details.update(
                _room_occupancy_details(
                    previous=room_previous, current=room.occupancy_status
                )
            )
        write_audit_log(
            db,
            user,
            "maintenance.verify",
            "maintenance_work_order",
            order.id,
            details,
            request,
        )
        _commit_or_conflict(db, "验收失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("验收失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("验收失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def rework_order(
    db: Session,
    order_id: int,
    payload: MaintenanceRework | None,
    user: User | None,
    request=None,
) -> MaintenanceWorkOrder:
    """验收不通过（Sprint 5 §25）：RESOLVED -> IN_PROGRESS，记录返工原因。

    blocks_room=true 的工单继续阻断，不恢复 Room。
    """
    order = _load_work_order(db, order_id, for_update=True)
    # 只允许 RESOLVED -> rework（ASSIGNED -> IN_PROGRESS 是 start 专属边）
    if order.status != MaintenanceWorkOrderStatus.RESOLVED:
        raise _conflict("仅待验收的工单可返工")

    previous = order.status
    order.status = MaintenanceWorkOrderStatus.IN_PROGRESS
    order.updated_by = user.id if user is not None else None
    if payload is not None and payload.verification_notes is not None:
        order.verification_notes = payload.verification_notes

    try:
        db.flush()
        room = db.get(Room, order.room_id)
        details = _audit_basics(
            order, room.room_number if room is not None else None
        )
        details.update({"from": previous.value, "to": order.status.value})
        if payload is not None and payload.verification_notes is not None:
            details["verification_notes_recorded"] = True
        write_audit_log(
            db,
            user,
            "maintenance.rework",
            "maintenance_work_order",
            order.id,
            details,
            request,
        )
        _commit_or_conflict(db, "返工失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("返工失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("返工失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def cancel_order(
    db: Session, order_id: int, user: User | None, request=None
) -> MaintenanceWorkOrder:
    """取消（Sprint 5 §26）：锁顺序 Room -> MWO。

    MWO -> CANCELLED -> 检查同房其它 active blocking MWO -> 若无且
    Room OOS source=MAINTENANCE -> Room available + source null。
    非 blocking 工单取消：Room 无变化。MANUAL OOS / blocked 永不被解除。
    """
    # 先读 room_id（只取标量，不把工单对象装入 identity map，
    # 保证后续 FOR UPDATE 读到锁内最新状态），再按固定顺序加锁
    room_id = db.scalar(
        select(MaintenanceWorkOrder.room_id).where(
            MaintenanceWorkOrder.id == order_id
        )
    )
    if room_id is None:
        raise _not_found("维修工单不存在")
    room = _lock_room(db, room_id)
    order = _load_work_order(db, order_id, for_update=True)

    if not can_transition_work_order(
        order.status, MaintenanceWorkOrderStatus.CANCELLED
    ):
        raise _conflict("仅进行中的工单可取消")

    previous = order.status
    order.status = MaintenanceWorkOrderStatus.CANCELLED
    order.updated_by = user.id if user is not None else None
    order.cancelled_at = property_now()

    # 先 flush 状态变更：Last Blocking 判定必须看到本工单已离开 blocking 集合
    db.flush()
    room_previous = room.occupancy_status
    restored = _maybe_restore_room(db, room)

    try:
        db.flush()
        details = _audit_basics(order, room.room_number)
        details.update({"from": previous.value, "to": order.status.value})
        if restored:
            details.update(
                _room_occupancy_details(
                    previous=room_previous, current=room.occupancy_status
                )
            )
        write_audit_log(
            db,
            user,
            "maintenance.cancel",
            "maintenance_work_order",
            order.id,
            details,
            request,
        )
        _commit_or_conflict(db, "取消失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("取消失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("取消失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise
