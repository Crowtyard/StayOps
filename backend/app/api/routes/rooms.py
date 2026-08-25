"""房间路由：CRUD（分页+双维度状态筛选）+ 房态变更（后端状态机校验）。

权限：GET room:read / POST·PUT room:write / DELETE room:delete；
房态变更：room:write 或按维度细分权限（room:status_cleaning / room:status_maintenance），
由 deps.authorize_status_change 强制（后端）。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.common import commit_or_conflict
from app.api.deps import (
    authorize_status_change,
    get_current_user,
    require_permissions,
)
from app.core.audit import write_audit_log
from app.core.pagination import paginate
from app.core.state_machine import can_change_cleaning, can_change_occupancy
from app.database import get_db
from app.models import (
    CleaningStatus,
    OccupancyStatus,
    Room,
    RoomType,
    User,
)
from app.schemas.common import Page
from app.schemas.room import RoomCreate, RoomOut, RoomStatusChange, RoomUpdate

router = APIRouter(prefix="/rooms", tags=["rooms"])


def _get_or_404(db: Session, room_id: int) -> Room:
    room = db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="房间不存在")
    return room


def _ensure_room_type(db: Session, room_type_id: int) -> RoomType:
    room_type = db.get(RoomType, room_type_id)
    if room_type is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="房型不存在")
    return room_type


def to_room_out(room: Room) -> RoomOut:
    return RoomOut.model_validate(room)


@router.get("", response_model=Page[RoomOut])
def list_rooms(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    occupancy_status: OccupancyStatus | None = Query(None),
    cleaning_status: CleaningStatus | None = Query(None),
    room_type_id: int | None = Query(None),
    _: User = Depends(require_permissions("room:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Room).options(selectinload(Room.room_type))
    if occupancy_status is not None:
        stmt = stmt.where(Room.occupancy_status == occupancy_status)
    if cleaning_status is not None:
        stmt = stmt.where(Room.cleaning_status == cleaning_status)
    if room_type_id is not None:
        stmt = stmt.where(Room.room_type_id == room_type_id)
    stmt = stmt.order_by(Room.id)
    result = paginate(db, stmt, page, page_size)
    result["items"] = [to_room_out(r) for r in result["items"]]
    return result


@router.post("", response_model=RoomOut, status_code=status.HTTP_201_CREATED)
def create_room(
    payload: RoomCreate,
    request: Request,
    current_user: User = Depends(require_permissions("room:write")),
    db: Session = Depends(get_db),
) -> RoomOut:
    _ensure_room_type(db, payload.room_type_id)
    if db.scalar(select(Room.id).where(Room.room_number == payload.room_number)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="房间号已存在")
    room = Room(
        room_number=payload.room_number,
        room_type_id=payload.room_type_id,
        floor=payload.floor,
        occupancy_status=payload.occupancy_status,
        cleaning_status=payload.cleaning_status,
        notes=payload.notes,
    )
    db.add(room)
    db.flush()
    write_audit_log(
        db,
        current_user,
        "room.create",
        "room",
        room.id,
        {
            "room_number": room.room_number,
            "floor": room.floor,
            "occupancy_status": room.occupancy_status.value,
            "cleaning_status": room.cleaning_status.value,
        },
        request,
    )
    commit_or_conflict(db, "房间号已存在")
    return to_room_out(room)


@router.get("/{room_id}", response_model=RoomOut)
def get_room(
    room_id: int,
    _: User = Depends(require_permissions("room:read")),
    db: Session = Depends(get_db),
) -> RoomOut:
    return to_room_out(_get_or_404(db, room_id))


@router.put("/{room_id}", response_model=RoomOut)
def update_room(
    room_id: int,
    payload: RoomUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("room:write")),
    db: Session = Depends(get_db),
) -> RoomOut:
    """更新房间基础信息；房态必须走 POST /rooms/{id}/status。"""
    room = _get_or_404(db, room_id)
    changes: dict = {}
    if payload.room_number is not None and payload.room_number != room.room_number:
        exists = db.scalar(
            select(Room.id).where(
                Room.room_number == payload.room_number, Room.id != room_id
            )
        )
        if exists:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="房间号已存在")
        room.room_number = payload.room_number
        changes["room_number"] = payload.room_number
    if payload.room_type_id is not None and payload.room_type_id != room.room_type_id:
        _ensure_room_type(db, payload.room_type_id)
        room.room_type_id = payload.room_type_id
        changes["room_type_id"] = payload.room_type_id
    if payload.floor is not None and payload.floor != room.floor:
        room.floor = payload.floor
        changes["floor"] = payload.floor
    if payload.notes is not None and payload.notes != room.notes:
        room.notes = payload.notes
        changes["notes"] = payload.notes
    if changes:
        write_audit_log(
            db,
            current_user,
            "room.update",
            "room",
            room.id,
            {"changes": changes},
            request,
        )
    commit_or_conflict(db, "房间号已存在")
    return to_room_out(room)


@router.delete("/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_room(
    room_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("room:delete")),
    db: Session = Depends(get_db),
) -> None:
    room = _get_or_404(db, room_id)
    write_audit_log(
        db,
        current_user,
        "room.delete",
        "room",
        room.id,
        {"room_number": room.room_number},
        request,
    )
    db.delete(room)
    commit_or_conflict(db, "删除房间失败")


@router.post("/{room_id}/status", response_model=RoomOut)
def change_room_status(
    room_id: int,
    payload: RoomStatusChange,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RoomOut:
    """房态变更：先鉴权（403），再按维度状态机校验（非法 409），并写审计。

    可单独改占用或清洁维度，也可同时改（需 room:write）。
    """
    room = _get_or_404(db, room_id)
    occupancy_target = payload.occupancy_status
    cleaning_target = payload.cleaning_status

    authorize_status_change(
        db, current_user, occupancy=occupancy_target, cleaning=cleaning_target
    )

    changes: dict = {}
    if occupancy_target is not None:
        if not can_change_occupancy(room.occupancy_status, occupancy_target):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"非法占用状态转换: {room.occupancy_status.value} -> "
                    f"{occupancy_target.value}"
                ),
            )
        changes["occupancy_status"] = {
            "from": room.occupancy_status.value,
            "to": occupancy_target.value,
        }
        room.occupancy_status = occupancy_target
    if cleaning_target is not None:
        if not can_change_cleaning(room.cleaning_status, cleaning_target):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"非法清洁状态转换: {room.cleaning_status.value} -> "
                    f"{cleaning_target.value}"
                ),
            )
        changes["cleaning_status"] = {
            "from": room.cleaning_status.value,
            "to": cleaning_target.value,
        }
        room.cleaning_status = cleaning_target

    write_audit_log(
        db,
        current_user,
        "room.status_change",
        "room",
        room.id,
        changes,
        request,
    )
    db.commit()
    return to_room_out(room)
