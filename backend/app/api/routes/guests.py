"""Guest 路由：列表（search=name OR phone）/ 创建 / 详情 / PATCH。

权限：GET guest:read / POST·PATCH guest:write。
Guest 属于 PII：无 guest:read 一律 403（整体拒绝，不做字段裁剪）。
审计：guest.create / guest.update（details 不含任何 PII 值）。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.common import commit_or_conflict
from app.api.deps import require_permissions
from app.core.audit import write_audit_log
from app.core.pagination import paginate
from app.database import get_db
from app.models import Guest, User
from app.schemas.common import Page
from app.schemas.guest import GuestCreate, GuestOut, GuestUpdate
from app.services.booking import build_guest_out

router = APIRouter(prefix="/guests", tags=["guests"])


def _get_or_404(db: Session, guest_id: int) -> Guest:
    guest = db.get(Guest, guest_id)
    if guest is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="客人不存在")
    return guest


@router.get("", response_model=Page[GuestOut])
def list_guests(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = Query(None),
    _: User = Depends(require_permissions("guest:read")),
    db: Session = Depends(get_db),
) -> dict:
    """客人列表；search 匹配 name OR phone（REV-FINAL-07）。"""
    stmt = select(Guest).order_by(Guest.id)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(
            or_(Guest.name.ilike(pattern), Guest.phone.ilike(pattern))
        )
    result = paginate(db, stmt, page, page_size)
    result["items"] = [build_guest_out(g) for g in result["items"]]
    return result


@router.post("", response_model=GuestOut, status_code=status.HTTP_201_CREATED)
def create_guest(
    payload: GuestCreate,
    request: Request,
    current_user: User = Depends(require_permissions("guest:write")),
    db: Session = Depends(get_db),
) -> GuestOut:
    guest = Guest(
        name=payload.name,
        phone=payload.phone,
        email=payload.email,
        notes=payload.notes,
    )
    db.add(guest)
    db.flush()
    # 审计 details 不记录 name/phone/email/notes（PII）
    write_audit_log(
        db, current_user, "guest.create", "guest", guest.id, None, request
    )
    commit_or_conflict(db, "创建客人失败")
    return build_guest_out(guest)


@router.get("/{guest_id}", response_model=GuestOut)
def get_guest(
    guest_id: int,
    _: User = Depends(require_permissions("guest:read")),
    db: Session = Depends(get_db),
) -> GuestOut:
    return build_guest_out(_get_or_404(db, guest_id))


@router.patch("/{guest_id}", response_model=GuestOut)
def update_guest(
    guest_id: int,
    payload: GuestUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("guest:write")),
    db: Session = Depends(get_db),
) -> GuestOut:
    guest = _get_or_404(db, guest_id)
    changed: list[str] = []
    if payload.name is not None and payload.name != guest.name:
        guest.name = payload.name
        changed.append("name")
    if payload.phone is not None and payload.phone != guest.phone:
        guest.phone = payload.phone
        changed.append("phone")
    if payload.email is not None and payload.email != guest.email:
        guest.email = payload.email
        changed.append("email")
    if payload.notes is not None and payload.notes != guest.notes:
        guest.notes = payload.notes
        changed.append("notes")
    if changed:
        # 审计只记录字段名，不记录任何 PII 值
        write_audit_log(
            db,
            current_user,
            "guest.update",
            "guest",
            guest.id,
            {"changed": changed},
            request,
        )
    commit_or_conflict(db, "更新客人失败")
    return build_guest_out(guest)
