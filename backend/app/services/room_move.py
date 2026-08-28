"""Room Move 域服务层（Sprint 6）：住中换房（Room Move & In-Stay Recovery）。

领域模型（Sprint 6 §2，决策见 docs/DECISIONS.md）：
- Reservation = 商业预订 / 未来房间分配（Check-in 后 room_id 冻结为原分配房）
- Stay        = 实际住宿（room_id = 当前实际房间快速指针）
- StayRoomAssignment = 实际住宿期间的房间历史（ended_at NULL = active）

原子换房事务（Sprint 6 §12，任一步失败全部回滚，不允许半换房）：
    lock ACTIVE Stay
    → resolve Source Room（stay.room_id + open assignment）
    → lock Source + Target Rooms（Room primary key 升序，Sprint 6 §8）
    → revalidate Stay ACTIVE / current assignment
    → revalidate target eligibility（Sprint 6 §11）
    → close Source assignment / create Target assignment
    → Stay.room_id = Target
    → release Source Room（复用 S5 room_release_state，Maintenance-aware）
    → create Source HousekeepingTask PENDING（source=ROOM_MOVE）
    → Target Room = occupied（cleaning 不变）
    → audit stay.room_move
    → commit

并发安全（Sprint 6 §7/§21/§22/§23）：
- Move vs Move 同目标 / Move vs 新建 CONFIRMED 预订 / Move vs Checkout：
  统一由 Stay 行锁 + 目标 Room 行锁 + 事务内重校验仲裁；
  40P01/40001 窄分类 → 409（复用 app/core/db_conflict），
  其它 OperationalError 原样传播（绝不吞 500）。
- Maintenance 独立性（Sprint 6 §16）：Room Move 绝不 resolve / verify /
  cancel / complete Source Room 的 MaintenanceWorkOrder；维修仍属原房间。

PII（Sprint 6 §19）：审计 details 不含任何 Guest PII 与 notes 内容。
"""

from datetime import date

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, selectinload

from app.core.audit import write_audit_log
from app.core.business_date import business_date, property_now
from app.core.db_conflict import is_transaction_conflict
from app.core.state_machine import can_change_occupancy
from app.models import (
    CleaningStatus,
    OccupancyStatus,
    Reservation,
    ReservationStatus,
    Room,
    Stay,
    StayRoomAssignment,
    StayStatus,
    User,
)
from app.schemas.stay import RoomMoveCreate
from app.services.booking import (
    lock_rooms_for_update,
    room_release_state,
)
from app.services.housekeeping import create_room_move_task, has_active_task
from app.services.maintenance import has_active_blocking_orders


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def _load_stay_for_update(db: Session, stay_id: int) -> Stay:
    stay = db.scalar(
        select(Stay).where(Stay.id == stay_id).with_for_update()
    )
    if stay is None:
        raise _not_found("入住记录不存在")
    return stay


def _open_assignment(db: Session, stay_id: int) -> StayRoomAssignment | None:
    return db.scalar(
        select(StayRoomAssignment).where(
            StayRoomAssignment.stay_id == stay_id,
            StayRoomAssignment.ended_at.is_(None),
        )
    )


# ---------------------------------------------------------------------------
# 目标房资格（Sprint 6 §11，后端最终权威；只读评估，写事务内最终校验）
# ---------------------------------------------------------------------------


def evaluate_move_target(
    db: Session,
    target: Room,
    *,
    move_date: date,
    planned_check_out: date,
    current_room_id: int,
) -> tuple[bool, str | None]:
    """目标房是否可换入：(可换入?, 不可换入原因)。

    规则（Sprint 6 §11）：
    - 非当前房间
    - occupancy_status = available（blocked / out_of_service / reserved 均拒绝）
    - cleaning_status = clean
    - 无 active blocking Maintenance Work Order
    - 无其它 ACTIVE Stay（按 Stay.room_id = 当前实际房间判断）
    - remaining stay interval [move_date, planned_check_out) 内无
      conflicting CONFIRMED Reservation（半开区间：planned_check_out
      当日 Check-in 的下一笔预订 allowed）
    """
    if target.id == current_room_id:
        return False, "当前入住房间"
    if target.occupancy_status != OccupancyStatus.available:
        return False, f"房间当前为 {target.occupancy_status.value}，不可换入"
    if target.cleaning_status != CleaningStatus.clean:
        return False, "房间未清洁，不可换入"
    if has_active_blocking_orders(db, target.id):
        return False, "房间存在进行中的阻断性维修工单，不可换入"
    occupied_by_stay = db.scalar(
        select(Stay.id).where(
            Stay.room_id == target.id, Stay.status == StayStatus.ACTIVE
        )
    )
    if occupied_by_stay is not None:
        return False, "房间已有在住记录"
    if planned_check_out > move_date:
        conflicting = db.scalar(
            select(Reservation.id).where(
                Reservation.room_id == target.id,
                Reservation.status == ReservationStatus.CONFIRMED,
                Reservation.check_in_date < planned_check_out,
                Reservation.check_out_date > move_date,
            )
        )
        if conflicting is not None:
            return False, "房间在剩余入住日期区间已有预订"
    return True, None


# ---------------------------------------------------------------------------
# GET /stays/{id}/room-move-options：目标房候选（后端权威结果驱动 UI）
# ---------------------------------------------------------------------------


def build_room_move_options(
    db: Session, stay: Stay
) -> dict:
    """当前 Stay 可选择的目标房间（含不可选原因，UI 不得自行猜测可用房）。"""
    today = business_date()
    rooms = db.scalars(
        select(Room).options(selectinload(Room.room_type)).order_by(Room.id)
    ).all()
    items: list[dict] = []
    for room in rooms:
        eligible, reason = evaluate_move_target(
            db,
            room,
            move_date=today,
            planned_check_out=stay.planned_check_out_date,
            current_room_id=stay.room_id,
        )
        items.append(
            {
                "room_id": room.id,
                "room_number": room.room_number,
                "room_type_id": room.room_type_id,
                "room_type_name": (
                    room.room_type.name if room.room_type is not None else None
                ),
                "floor": room.floor,
                "eligible": eligible,
                "reason": reason,
            }
        )
    return {
        "business_date": today,
        "stay_id": stay.id,
        "stay_no": stay.stay_no,
        "current_room_id": stay.room_id,
        "planned_check_out_date": stay.planned_check_out_date,
        "items": items,
    }


# ---------------------------------------------------------------------------
# POST /stays/{id}/room-move：原子换房事务（Sprint 6 §12）
# ---------------------------------------------------------------------------


def move_stay(
    db: Session,
    stay_id: int,
    payload: RoomMoveCreate,
    user: User | None,
    request=None,
) -> Stay:
    """原子换房。锁顺序（Sprint 6 §8，全项目一致）：
    Stay → Rooms（多房按 Room primary key 升序），与 Checkout（Stay → Room）、
    Check-in / Reservation update（Reservation → Room）无环。
    """
    stay = _load_stay_for_update(db, stay_id)
    try:
        if stay.status != StayStatus.ACTIVE:
            raise _conflict("仅 ACTIVE 入住记录可换房")

        open_assignment = _open_assignment(db, stay.id)
        if open_assignment is None:
            raise _conflict("入住记录缺少当前房间分配，无法换房")
        source_room_id = stay.room_id
        if open_assignment.room_id != source_room_id:
            raise _conflict("入住记录房间分配状态异常，无法换房")

        target_room_id = payload.target_room_id
        if target_room_id == source_room_id:
            raise _conflict("目标房间不能是当前房间")

        # 锁 Source + Target Rooms：按 primary key 升序（禁止 source first，
        # 否则 203→205 与 205→203 并发死锁，Sprint 6 §8）
        rooms = lock_rooms_for_update(db, [source_room_id, target_room_id])
        source_room = next(r for r in rooms if r.id == source_room_id)
        target_room = next(r for r in rooms if r.id == target_room_id)

        # 事务内重校验（Stay 锁已持有；重读 assignment 防御并发）
        current_assignment = _open_assignment(db, stay.id)
        if current_assignment is None or current_assignment.id != open_assignment.id:
            raise _conflict("入住记录房间分配已变化，请刷新后重试")
        if stay.room_id != source_room_id:
            raise _conflict("入住记录房间已变化，请刷新后重试")

        # 目标房资格（Sprint 6 §11，锁内最终权威；不能只判断目标当前为空）
        eligible, reason = evaluate_move_target(
            db,
            target_room,
            move_date=business_date(),
            planned_check_out=stay.planned_check_out_date,
            current_room_id=source_room_id,
        )
        if not eligible:
            raise _conflict(f"目标房间不可换入：{reason}")

        # 原房保洁任务 invariant（Alpha.3 部分唯一索引）：
        # 已有 active HK task -> 合理失败并回滚（Sprint 6 §14，不创建双任务）
        if has_active_task(db, source_room.id):
            raise _conflict(
                "原房间已有进行中的保洁任务，请先处理后再换房"
            )

        # Source Room 释放决策（Sprint 6 §13：复用 S5 room_release_state，
        # Maintenance-aware；Manual unavailable 状态继承，绝不覆盖为 available）
        release_occupancy, release_source, blocking = room_release_state(
            db, source_room
        )

        now = property_now()

        # 关闭 Source assignment → 创建 Target assignment → Stay.room_id = Target
        current_assignment.ended_at = now
        db.add(
            StayRoomAssignment(
                stay_id=stay.id,
                room_id=target_room.id,
                started_at=now,
                ended_at=None,
                reason=payload.reason,
                notes=payload.notes,
                created_by=user.id if user is not None else None,
            )
        )
        stay.room_id = target_room.id
        stay.updated_by = user.id if user is not None else None

        # Source Room release（Cleaning 无条件 dirty；占用按 S5 语义）
        source_previous = source_room.occupancy_status
        if source_room.occupancy_status != release_occupancy:
            if not can_change_occupancy(
                source_room.occupancy_status, release_occupancy
            ):
                raise _conflict("原房间占用状态异常，无法换房")
            source_room.occupancy_status = release_occupancy
        source_room.unavailability_source = release_source
        source_room.cleaning_status = CleaningStatus.dirty

        # Target Room = occupied；不得修改 cleaning_status；
        # 不得创建 Target housekeeping task（Sprint 6 §15）
        target_room.occupancy_status = OccupancyStatus.occupied
        target_room.unavailability_source = None  # occupied 要求 NULL（CHECK 约束）

        # 旧房保洁任务（source=ROOM_MOVE，PENDING；Sprint 6 §14）
        db.flush()
        create_room_move_task(db, source_room, stay, user, request)

        details = {
            "stay_id": stay.id,
            "stay_no": stay.stay_no,
            "from_room_id": source_room.id,
            "from_room_number": source_room.room_number,
            "to_room_id": target_room.id,
            "to_room_number": target_room.room_number,
            "reason": payload.reason.value,
            "notes_recorded": payload.notes is not None,
            "source_room_occupancy": {
                "from": source_previous.value,
                "to": source_room.occupancy_status.value,
            },
            "maintenance_blocking": blocking,
        }
        if user is not None:
            details["operator_user_id"] = user.id
        write_audit_log(
            db, user, "stay.room_move", "stay", stay.id, details, request
        )

        db.commit()
        return stay
    except IntegrityError as exc:
        db.rollback()
        raise _conflict("换房失败：数据冲突") from exc
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            # 40P01 / 40001 并发仲裁 → 409；其它 OperationalError 原样传播
            raise _conflict("换房失败：并发冲突，请重试") from exc
        raise
    except HTTPException:
        db.rollback()
        raise
