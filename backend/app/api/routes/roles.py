"""角色路由：CRUD + 设置权限。

权限：GET role:read / POST·PUT role:write / DELETE role:delete / 设置权限 role:write。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.api.common import commit_or_conflict
from app.api.deps import require_permissions
from app.core.audit import write_audit_log
from app.core.pagination import paginate
from app.database import get_db
from app.models import Permission, Role, RolePermission, User
from app.schemas.common import Page
from app.schemas.role import (
    RoleCreate,
    RoleOut,
    RolePermissionSet,
    RoleUpdate,
)

router = APIRouter(prefix="/roles", tags=["roles"])


def _get_or_404(db: Session, role_id: int) -> Role:
    role = db.get(Role, role_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="角色不存在")
    return role


def to_role_out(role: Role) -> RoleOut:
    out = RoleOut.model_validate(role)
    out.permissions = sorted(out.permissions, key=lambda p: p.id)
    return out


@router.get("", response_model=Page[RoleOut])
def list_roles(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    _: User = Depends(require_permissions("role:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = (
        select(Role)
        .options(selectinload(Role.permissions))
        .order_by(Role.id)
    )
    result = paginate(db, stmt, page, page_size)
    result["items"] = [to_role_out(r) for r in result["items"]]
    return result


@router.post("", response_model=RoleOut, status_code=status.HTTP_201_CREATED)
def create_role(
    payload: RoleCreate,
    request: Request,
    current_user: User = Depends(require_permissions("role:write")),
    db: Session = Depends(get_db),
) -> RoleOut:
    if db.scalar(select(Role.id).where(Role.name == payload.name)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="角色名已存在")
    role = Role(name=payload.name, description=payload.description)
    db.add(role)
    db.flush()
    write_audit_log(
        db,
        current_user,
        "role.create",
        "role",
        role.id,
        {"name": role.name},
        request,
    )
    commit_or_conflict(db, "角色名已存在")
    return to_role_out(role)


@router.get("/{role_id}", response_model=RoleOut)
def get_role(
    role_id: int,
    _: User = Depends(require_permissions("role:read")),
    db: Session = Depends(get_db),
) -> RoleOut:
    return to_role_out(_get_or_404(db, role_id))


@router.put("/{role_id}", response_model=RoleOut)
def update_role(
    role_id: int,
    payload: RoleUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("role:write")),
    db: Session = Depends(get_db),
) -> RoleOut:
    role = _get_or_404(db, role_id)
    changes: dict = {}
    if payload.name is not None and payload.name != role.name:
        exists = db.scalar(
            select(Role.id).where(Role.name == payload.name, Role.id != role_id)
        )
        if exists:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="角色名已存在")
        role.name = payload.name
        changes["name"] = payload.name
    if payload.description is not None and payload.description != role.description:
        role.description = payload.description
        changes["description"] = payload.description
    if changes:
        write_audit_log(
            db,
            current_user,
            "role.update",
            "role",
            role.id,
            {"changes": changes},
            request,
        )
    commit_or_conflict(db, "角色名已存在")
    return to_role_out(role)


@router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(
    role_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("role:delete")),
    db: Session = Depends(get_db),
) -> None:
    role = _get_or_404(db, role_id)
    write_audit_log(
        db,
        current_user,
        "role.delete",
        "role",
        role.id,
        {"name": role.name},
        request,
    )
    db.delete(role)
    commit_or_conflict(db, "删除角色失败")


@router.post("/{role_id}/permissions", response_model=RoleOut)
def set_role_permissions(
    role_id: int,
    payload: RolePermissionSet,
    request: Request,
    current_user: User = Depends(require_permissions("role:write")),
    db: Session = Depends(get_db),
) -> RoleOut:
    """设置角色权限（整体替换；空列表=清空全部权限）。"""
    role = _get_or_404(db, role_id)
    permission_ids = sorted(set(payload.permission_ids))
    if permission_ids:
        found = set(
            db.scalars(select(Permission.id).where(Permission.id.in_(permission_ids))).all()
        )
        missing = sorted(set(permission_ids) - found)
        if missing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"权限不存在: {missing}",
            )
    db.execute(
        delete(RolePermission).where(RolePermission.role_id == role.id)
    )
    for pid in permission_ids:
        db.add(RolePermission(role_id=role.id, permission_id=pid))
    write_audit_log(
        db,
        current_user,
        "role.set_permissions",
        "role",
        role.id,
        {"permission_ids": permission_ids},
        request,
    )
    commit_or_conflict(db, "设置角色权限失败")
    db.refresh(role)
    return to_role_out(role)
