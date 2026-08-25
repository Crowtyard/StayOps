"""房型路由：CRUD。

权限：GET room_type:read / POST·PUT room_type:write / DELETE room_type:delete。
删除限制：房型下仍有房间时返回 409（外键 RESTRICT 双保险）。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.common import commit_or_conflict
from app.api.deps import require_permissions
from app.core.audit import write_audit_log
from app.core.pagination import paginate
from app.database import get_db
from app.models import Room, RoomType, User
from app.schemas.common import Page
from app.schemas.room import RoomTypeCreate, RoomTypeOut, RoomTypeUpdate

router = APIRouter(prefix="/room-types", tags=["room-types"])


def _get_or_404(db: Session, room_type_id: int) -> RoomType:
    room_type = db.get(RoomType, room_type_id)
    if room_type is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="房型不存在")
    return room_type


def to_room_type_out(room_type: RoomType) -> RoomTypeOut:
    out = RoomTypeOut.model_validate(room_type)
    out.room_count = len(room_type.rooms)
    return out


@router.get("", response_model=Page[RoomTypeOut])
def list_room_types(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    _: User = Depends(require_permissions("room_type:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = (
        select(RoomType)
        .options(selectinload(RoomType.rooms))
        .order_by(RoomType.id)
    )
    result = paginate(db, stmt, page, page_size)
    result["items"] = [to_room_type_out(rt) for rt in result["items"]]
    return result


@router.post("", response_model=RoomTypeOut, status_code=status.HTTP_201_CREATED)
def create_room_type(
    payload: RoomTypeCreate,
    request: Request,
    current_user: User = Depends(require_permissions("room_type:write")),
    db: Session = Depends(get_db),
) -> RoomTypeOut:
    if db.scalar(select(RoomType.id).where(RoomType.name == payload.name)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="房型名已存在")
    room_type = RoomType(
        name=payload.name,
        base_price=payload.base_price,
        capacity=payload.capacity,
        description=payload.description,
    )
    db.add(room_type)
    db.flush()
    write_audit_log(
        db,
        current_user,
        "room_type.create",
        "room_type",
        room_type.id,
        {
            "name": room_type.name,
            "base_price": str(room_type.base_price),
            "capacity": room_type.capacity,
        },
        request,
    )
    commit_or_conflict(db, "房型名已存在")
    return to_room_type_out(room_type)


@router.get("/{room_type_id}", response_model=RoomTypeOut)
def get_room_type(
    room_type_id: int,
    _: User = Depends(require_permissions("room_type:read")),
    db: Session = Depends(get_db),
) -> RoomTypeOut:
    return to_room_type_out(_get_or_404(db, room_type_id))


@router.put("/{room_type_id}", response_model=RoomTypeOut)
def update_room_type(
    room_type_id: int,
    payload: RoomTypeUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("room_type:write")),
    db: Session = Depends(get_db),
) -> RoomTypeOut:
    room_type = _get_or_404(db, room_type_id)
    changes: dict = {}
    if payload.name is not None and payload.name != room_type.name:
        exists = db.scalar(
            select(RoomType.id).where(
                RoomType.name == payload.name, RoomType.id != room_type_id
            )
        )
        if exists:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="房型名已存在")
        room_type.name = payload.name
        changes["name"] = payload.name
    if payload.base_price is not None and payload.base_price != room_type.base_price:
        room_type.base_price = payload.base_price
        changes["base_price"] = str(payload.base_price)
    if payload.capacity is not None and payload.capacity != room_type.capacity:
        room_type.capacity = payload.capacity
        changes["capacity"] = payload.capacity
    if payload.description is not None and payload.description != room_type.description:
        room_type.description = payload.description
        changes["description"] = payload.description
    if changes:
        write_audit_log(
            db,
            current_user,
            "room_type.update",
            "room_type",
            room_type.id,
            {"changes": changes},
            request,
        )
    commit_or_conflict(db, "房型名已存在")
    return to_room_type_out(room_type)


@router.delete("/{room_type_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_room_type(
    room_type_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("room_type:delete")),
    db: Session = Depends(get_db),
) -> None:
    room_type = _get_or_404(db, room_type_id)
    room_count = db.scalar(
        select(func.count()).select_from(Room).where(Room.room_type_id == room_type.id)
    )
    if room_count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"该房型下仍有 {room_count} 个房间，无法删除",
        )
    write_audit_log(
        db,
        current_user,
        "room_type.delete",
        "room_type",
        room_type.id,
        {"name": room_type.name},
        request,
    )
    db.delete(room_type)
    commit_or_conflict(db, "删除房型失败")
