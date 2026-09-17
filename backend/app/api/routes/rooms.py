"""房间路由：CRUD（分页+双维度状态筛选+启用状态）+ 房态变更 + 房间资料管理。

权限（alpha.9.6 QA DEF-1 修复后，主数据与运营操作分离）：
- GET /rooms · /rooms/summary · /rooms/{id}  -> room:read
- **房间主数据管理**（POST /rooms · PUT/PATCH /rooms/{id} ·
  POST /rooms/{id}/disable|enable）
  -> **room:inventory_manage**（改动房号/房型/楼层/名称/备注/经营启停/物理库存归属）
- DELETE /rooms/{id} -> room:inventory_manage **且** room:delete
  （QA 修复项 §2 要求 DELETE 纳入 room:inventory_manage 保护区；同时保留仓库
  既有决策「room:delete 不授予任何常规角色」—— 两码 AND 使 FRONT_DESK 与
  MANAGER 均不可删除房间，不产生任何权限扩张。这是本仓库唯一的多码用法，
  且是有意为之、已记录在 docs/DECISIONS.md §11）
- **日常房态操作**（POST /rooms/{id}/status）-> room:write（或按维度细分权限
  room:status_cleaning / room:status_maintenance），由 deps.authorize_status_change 强制
  （后端）。

  即：`room:write` **不再**守卫任何房间主数据端点 —— 否则 FRONT_DESK
  （既有 room:write）将可新增/编辑/停用/启用房间库存，违反 Field Trial PRD
  的最小权限原则。

alpha.9.6 F1（真实酒店现场试用反馈）：
- 新增 POST /rooms/{id}/disable · /enable（软停用，不物理删除）
- 新增 PATCH /rooms/{id}（局部更新，与 PUT 等价，保留 PUT 向后兼容）
- 新增 GET /rooms/summary（总数 / 启用 / 停用 —— 全部由 COUNT 查询计算，
  **不存在 room_count 真值字段**）
- DELETE /rooms/{id} 增加历史业务引用保护：有历史记录的房间拒绝物理删除，
  提示改用停用（历史订单不可破坏）
- 房号全局唯一（含停用房间）；重复时返回区分「已启用 / 已停用」的可读错误
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
    UnavailabilitySource,
    User,
)
from app.schemas.common import Page
from app.schemas.room import (
    RoomCreate,
    RoomOut,
    RoomStatusChange,
    RoomSummaryOut,
    RoomUpdate,
)
from app.services import rooms as room_svc

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
    is_active: bool | None = Query(
        None, description="true=仅启用；false=仅停用；不传=全部"
    ),
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
    if is_active is not None:
        stmt = stmt.where(Room.is_active.is_(is_active))
    stmt = stmt.order_by(Room.id)
    result = paginate(db, stmt, page, page_size)
    result["items"] = [to_room_out(r) for r in result["items"]]
    return result


@router.get(
    "/summary",
    response_model=RoomSummaryOut,
    summary="房间数量统计（总数 / 启用 / 停用，后端 COUNT 计算）",
)
def room_summary(
    _: User = Depends(require_permissions("room:read")),
    db: Session = Depends(get_db),
) -> dict:
    """房间数量永远是 Room 记录的计算结果，不是可编辑字段。"""
    return room_svc.room_counts(db)


@router.post("", response_model=RoomOut, status_code=status.HTTP_201_CREATED)
def create_room(
    payload: RoomCreate,
    request: Request,
    current_user: User = Depends(require_permissions("room:inventory_manage")),
    db: Session = Depends(get_db),
) -> RoomOut:
    _ensure_room_type(db, payload.room_type_id)
    duplicate = room_svc.find_room_by_number(db, payload.room_number)
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=room_svc.duplicate_room_number_detail(db, payload.room_number),
        )
    # Sprint 5 §4：unavailability_source 由后端派生（blocked/OOS -> MANUAL）
    unavailability_source = (
        UnavailabilitySource.MANUAL
        if payload.occupancy_status
        in (OccupancyStatus.blocked, OccupancyStatus.out_of_service)
        else None
    )
    room = Room(
        room_number=payload.room_number,
        name=payload.name,
        room_type_id=payload.room_type_id,
        floor=payload.floor,
        is_active=payload.is_active,
        occupancy_status=payload.occupancy_status,
        cleaning_status=payload.cleaning_status,
        unavailability_source=unavailability_source,
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
            "name": room.name,
            "floor": room.floor,
            "is_active": room.is_active,
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


def _apply_room_update(
    db: Session,
    room: Room,
    payload: RoomUpdate,
    current_user: User,
    request: Request,
) -> RoomOut:
    """房间基础信息更新的共用实现（PUT 与 PATCH 共用，避免两套写逻辑）。

    房态（occupancy_status / cleaning_status）必须走 POST /rooms/{id}/status。
    """
    changes: dict = {}
    if payload.room_number is not None and payload.room_number != room.room_number:
        exists = room_svc.find_room_by_number(db, payload.room_number)
        if exists is not None and exists.id != room.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=room_svc.duplicate_room_number_detail(
                    db, payload.room_number
                ),
            )
        room.room_number = payload.room_number
        changes["room_number"] = payload.room_number
    if payload.name is not None and payload.name != room.name:
        room.name = payload.name or None
        changes["name"] = room.name
    if payload.room_type_id is not None and payload.room_type_id != room.room_type_id:
        _ensure_room_type(db, payload.room_type_id)
        room.room_type_id = payload.room_type_id
        changes["room_type_id"] = payload.room_type_id
    if payload.floor is not None and payload.floor != room.floor:
        room.floor = payload.floor
        changes["floor"] = payload.floor
    if payload.is_active is not None and payload.is_active != room.is_active:
        # 停用必须经 room_svc（校验在住记录 + 审计），不在通用更新里绕过；
        # commit=False 保持单一提交点（本函数的 commit_or_conflict）
        room_svc.set_room_active(
            db,
            room,
            is_active=payload.is_active,
            user=current_user,
            request=request,
            commit=False,
        )
        changes["is_active"] = payload.is_active
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


@router.put("/{room_id}", response_model=RoomOut)
def update_room(
    room_id: int,
    payload: RoomUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("room:inventory_manage")),
    db: Session = Depends(get_db),
) -> RoomOut:
    """更新房间基础信息；房态必须走 POST /rooms/{id}/status。"""
    room = _get_or_404(db, room_id)
    return _apply_room_update(db, room, payload, current_user, request)


@router.patch("/{room_id}", response_model=RoomOut)
def patch_room(
    room_id: int,
    payload: RoomUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("room:inventory_manage")),
    db: Session = Depends(get_db),
) -> RoomOut:
    """局部更新房间基础信息（与 PUT 同一实现）。"""
    room = _get_or_404(db, room_id)
    return _apply_room_update(db, room, payload, current_user, request)


@router.post(
    "/{room_id}/disable",
    response_model=RoomOut,
    summary="停用房间（软停用；不释放房号、不破坏历史记录）",
)
def disable_room(
    room_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("room:inventory_manage")),
    db: Session = Depends(get_db),
) -> RoomOut:
    room = _get_or_404(db, room_id)
    return to_room_out(
        room_svc.set_room_active(
            db, room, is_active=False, user=current_user, request=request
        )
    )


@router.post(
    "/{room_id}/enable",
    response_model=RoomOut,
    summary="恢复启用房间（幂等）",
)
def enable_room(
    room_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("room:inventory_manage")),
    db: Session = Depends(get_db),
) -> RoomOut:
    room = _get_or_404(db, room_id)
    return to_room_out(
        room_svc.set_room_active(
            db, room, is_active=True, user=current_user, request=request
        )
    )


@router.delete("/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_room(
    room_id: int,
    request: Request,
    current_user: User = Depends(
        require_permissions("room:inventory_manage", "room:delete")
    ),
    db: Session = Depends(get_db),
) -> None:
    """物理删除房间 —— 仅当该房从未被任何历史业务记录引用。

    有历史引用 -> 409，提示改用停用（默认产品 UX 优先停用）。
    """
    room = _get_or_404(db, room_id)
    room_svc.ensure_room_deletable(db, room)
    write_audit_log(
        db,
        current_user,
        "room.delete",
        "room",
        room.id,
        {"room_number": room.room_number, "name": room.name},
        request,
    )
    db.delete(room)
    commit_or_conflict(db, "删除房间失败：该房间已被业务记录引用")


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

    Sprint 5 §3/§4：unavailability_source 由后端派生维护（不接受前端显式传值）——
    目标 blocked / out_of_service -> MANUAL（运营/人工来源）；
    目标 available / reserved / occupied -> NULL。
    Maintenance 域写 MAINTENANCE 来源走自己的事务（services/maintenance.py），
    人工改房态永不得把来源写成 MAINTENANCE。
    行锁（SELECT FOR UPDATE）串行化与 Maintenance 房态事务的并发（Sprint 5 §27）。
    """
    room = db.scalar(select(Room).where(Room.id == room_id).with_for_update())
    if room is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="房间不存在"
        )
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
        # Sprint 5：人工来源维护（Maintenance 来源只能由 Maintenance 域写入）
        source_target = (
            UnavailabilitySource.MANUAL
            if occupancy_target
            in (OccupancyStatus.blocked, OccupancyStatus.out_of_service)
            else None
        )
        if room.unavailability_source != source_target:
            changes["unavailability_source"] = {
                "from": (
                    room.unavailability_source.value
                    if room.unavailability_source is not None
                    else None
                ),
                "to": (
                    source_target.value if source_target is not None else None
                ),
            }
            room.unavailability_source = source_target
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
