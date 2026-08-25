"""用户路由：CRUD + 分配角色。

权限：GET user:read / POST·PUT user:write / DELETE user:delete / 分配角色 user:write。
所有写操作写 audit_log（含 IP，details 不记录密码/哈希）。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.api.common import commit_or_conflict
from app.api.deps import require_permissions
from app.core.audit import write_audit_log
from app.core.pagination import paginate
from app.core.security import hash_password
from app.database import get_db
from app.models import Role, User, UserRole
from app.schemas.common import Page
from app.schemas.user import UserCreate, UserOut, UserRoleAssign, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


def _get_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="用户不存在")
    return user


def to_user_out(user: User) -> UserOut:
    out = UserOut.model_validate(user)
    out.roles = sorted(out.roles, key=lambda r: r.id)
    return out


@router.get("", response_model=Page[UserOut])
def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    _: User = Depends(require_permissions("user:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(User).options(selectinload(User.roles)).order_by(User.id)
    result = paginate(db, stmt, page, page_size)
    result["items"] = [to_user_out(u) for u in result["items"]]
    return result


@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    request: Request,
    current_user: User = Depends(require_permissions("user:write")),
    db: Session = Depends(get_db),
) -> UserOut:
    if db.scalar(select(User.id).where(User.username == payload.username)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="用户名已存在")
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        display_name=payload.display_name or payload.username,
        email=payload.email,
        phone=payload.phone,
        is_active=payload.is_active,
    )
    db.add(user)
    db.flush()
    write_audit_log(
        db,
        current_user,
        "user.create",
        "user",
        user.id,
        {"username": user.username},
        request,
    )
    commit_or_conflict(db, "用户名已存在")
    return to_user_out(user)


@router.get("/{user_id}", response_model=UserOut)
def get_user(
    user_id: int,
    _: User = Depends(require_permissions("user:read")),
    db: Session = Depends(get_db),
) -> UserOut:
    return to_user_out(_get_or_404(db, user_id))


@router.put("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("user:write")),
    db: Session = Depends(get_db),
) -> UserOut:
    user = _get_or_404(db, user_id)
    changes: dict = {}
    if payload.username is not None and payload.username != user.username:
        exists = db.scalar(
            select(User.id).where(
                User.username == payload.username, User.id != user_id
            )
        )
        if exists:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="用户名已存在")
        user.username = payload.username
        changes["username"] = payload.username
    if payload.password is not None:
        user.password_hash = hash_password(payload.password)
        changes["password_hash"] = "已更新"  # 审计仅记录“已更新”，不落哈希
    if payload.display_name is not None:
        user.display_name = payload.display_name
        changes["display_name"] = payload.display_name
    if payload.email is not None:
        user.email = payload.email
        changes["email"] = payload.email
    if payload.phone is not None:
        user.phone = payload.phone
        changes["phone"] = payload.phone
    if payload.is_active is not None and payload.is_active != user.is_active:
        if user.id == current_user.id and not payload.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="不能禁用当前登录用户",
            )
        user.is_active = payload.is_active
        changes["is_active"] = payload.is_active
    if changes:
        write_audit_log(
            db,
            current_user,
            "user.update",
            "user",
            user.id,
            {"changes": changes},
            request,
        )
    commit_or_conflict(db, "用户名已存在")
    return to_user_out(user)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("user:delete")),
    db: Session = Depends(get_db),
) -> None:
    user = _get_or_404(db, user_id)
    if user.id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="不能删除当前登录用户"
        )
    write_audit_log(
        db,
        current_user,
        "user.delete",
        "user",
        user.id,
        {"username": user.username},
        request,
    )
    db.delete(user)
    commit_or_conflict(db, "删除用户失败")


@router.post("/{user_id}/roles", response_model=UserOut)
def assign_roles(
    user_id: int,
    payload: UserRoleAssign,
    request: Request,
    current_user: User = Depends(require_permissions("user:write")),
    db: Session = Depends(get_db),
) -> UserOut:
    """分配角色（整体替换；空列表=清空全部角色）。"""
    user = _get_or_404(db, user_id)
    role_ids = sorted(set(payload.role_ids))
    if role_ids:
        found = set(db.scalars(select(Role.id).where(Role.id.in_(role_ids))).all())
        missing = sorted(set(role_ids) - found)
        if missing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"角色不存在: {missing}",
            )
    db.execute(delete(UserRole).where(UserRole.user_id == user.id))
    for role_id in role_ids:
        db.add(UserRole(user_id=user.id, role_id=role_id))
    names = (
        [
            r.name
            for r in db.scalars(select(Role).where(Role.id.in_(role_ids))).all()
        ]
        if role_ids
        else []
    )
    write_audit_log(
        db,
        current_user,
        "user.assign_roles",
        "user",
        user.id,
        {"role_ids": role_ids, "roles": names},
        request,
    )
    commit_or_conflict(db, "分配角色失败")
    db.refresh(user)
    return to_user_out(user)
