"""Room 域服务层（alpha.9.6 F1 房间资料管理）。

覆盖房间管理所需、但不属于状态机也不属于预订域的公共逻辑：

- **房间数量**：永远是 rooms 记录的计算结果（COUNT 查询）。
  业务事实是 **Room records**，房间数量只是「当前启用 Room 记录的计算结果」；
  **不存在也禁止新增 rooms.room_count 真值字段**（否则与 Room 表双事实源）。
- **停用 / 启用**：停用不释放 room_number（全局唯一，含停用房间）；停用前校验
  该房当前无 ACTIVE 在住（在住客房不得从经营中摘除）。
- **物理删除保护**：房间一旦被任何历史业务记录（Reservation / Stay /
  房间分配历史 / 保洁任务 / 维修工单）引用，即禁止物理删除 —— 默认 UX 是停用，
  不因为「以后不卖了」而破坏历史订单。
"""

from __future__ import annotations

from fastapi import HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.models import (
    HousekeepingTask,
    MaintenanceWorkOrder,
    Reservation,
    Room,
    Stay,
    StayRoomAssignment,
)

# 历史业务引用表（物理删除保护）；顺序即错误信息优先级
_REFERENCE_SOURCES: tuple[tuple[str, type, str], ...] = (
    ("reservation", Reservation, "预订"),
    ("stay", Stay, "入住记录"),
    ("stay_room_assignment", StayRoomAssignment, "房间分配历史"),
    ("housekeeping_task", HousekeepingTask, "保洁任务"),
    ("maintenance_work_order", MaintenanceWorkOrder, "维修工单"),
)


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def room_counts(db: Session) -> dict:
    """房间数量统计（后端权威，全部由 COUNT 查询得出）。"""
    row = db.execute(
        select(
            func.count(Room.id),
            func.count(Room.id).filter(Room.is_active.is_(True)),
            func.count(Room.id).filter(Room.is_active.is_(False)),
        )
    ).one()
    return {
        "total_count": int(row[0]),
        "enabled_count": int(row[1]),
        "disabled_count": int(row[2]),
    }


def duplicate_room_number_detail(db: Session, room_number: str) -> str:
    """房间号重复时的人类可读错误（区分「已启用」与「已停用」占用者）。

    停用房号不释放（房号 = 持续存在的物理房间身份），因此重复时明确告知。
    """
    existing = db.scalar(
        select(Room).where(Room.room_number == room_number)
    )
    if existing is None:
        return "房间号已存在"
    if existing.is_active:
        return f"房间号 {room_number} 已被启用的房间占用，请换一个房间号"
    return (
        f"房间号 {room_number} 已被停用房间占用（停用房号不释放）；"
        "请换一个房间号，或先修改 / 恢复该停用房间"
    )


def find_room_by_number(db: Session, room_number: str) -> Room | None:
    return db.scalar(select(Room).where(Room.room_number == room_number))


def reference_counts(db: Session, room_id: int) -> dict[str, int]:
    """该房间被历史业务记录引用的次数（0 表示可安全物理删除）。"""
    counts: dict[str, int] = {}
    for key, model, _label in _REFERENCE_SOURCES:
        counts[key] = int(
            db.scalar(
                select(func.count()).select_from(model).where(model.room_id == room_id)
            )
            or 0
        )
    return counts


def _active_stay_no(db: Session, room_id: int) -> str | None:
    return db.scalar(
        select(Stay.stay_no).where(
            Stay.room_id == room_id,
            Stay.status == "ACTIVE",
        )
    )


def ensure_room_deletable(db: Session, room: Room) -> None:
    """房间有历史业务引用时拒绝物理删除（默认 UX = 停用）。"""
    counts = reference_counts(db, room.id)
    referenced = {k: v for k, v in counts.items() if v}
    if not referenced:
        return
    labels = {
        key: f"{label} {counts[key]} 条"
        for key, _model, label in _REFERENCE_SOURCES
        if counts.get(key)
    }
    raise _conflict(
        f"房间 {room.room_number} 存在历史业务记录（"
        + "、".join(labels.values())
        + "），不能删除；请改为停用（历史记录必须保持完整）"
    )


def set_room_active(
    db: Session,
    room: Room,
    *,
    is_active: bool,
    user,
    request: Request | None = None,
    commit: bool = True,
) -> Room:
    """停用 / 启用房间（幂等）。

    - 停用前：该房不得有 ACTIVE 在住（在住客房必须先退房或换房）。
    - 停用不释放 room_number，也不影响历史 Reservation / Stay / 工单。
    - commit=False：只 flush 并写审计，由调用方的统一提交点（如
      PUT/PATCH /rooms/{id} 的 commit_or_conflict）提交，保持单一提交路径。
    """
    if room.is_active == is_active:
        return room
    if not is_active:
        active_stay_no = _active_stay_no(db, room.id)
        if active_stay_no is not None:
            raise _conflict(
                f"房间 {room.room_number} 当前有在住记录（{active_stay_no}），"
                "不能停用；请先办理退房或换房"
            )
    previous = room.is_active
    room.is_active = is_active
    write_audit_log(
        db,
        user,
        "room.enable" if is_active else "room.disable",
        "room",
        room.id,
        {
            "room_number": room.room_number,
            "from": previous,
            "to": is_active,
        },
        request,
    )
    db.flush()
    if commit:
        db.commit()
        db.refresh(room)
    return room
