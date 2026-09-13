"""认证路由：POST /auth/login、GET /auth/me。"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_permission_codes
from app.config import settings
from app.core.audit import write_audit_log
from app.core.security import create_access_token, hash_password, verify_password
from app.database import get_db
from app.models import User
from app.schemas.auth import ChangePasswordRequest, LoginRequest, MeOut, Token
from app.schemas.role import RoleBrief

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=Token)
def login(
    payload: LoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> Token:
    """登录：bcrypt 验证，返回 JWT access_token；失败也写审计（含 IP）。"""
    user = db.scalar(select(User).where(User.username == payload.username))
    if user is None or not verify_password(payload.password, user.password_hash):
        write_audit_log(
            db,
            None,
            "login_failed",
            "auth",
            None,
            {"username": payload.username, "reason": "invalid_credentials"},
            request,
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
        )
    if not user.is_active:
        write_audit_log(
            db,
            user,
            "login_failed",
            "auth",
            user.id,
            {"username": user.username, "reason": "inactive"},
            request,
        )
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="账号已禁用"
        )
    write_audit_log(
        db, user, "login", "auth", user.id, {"username": user.username}, request
    )
    db.commit()
    return Token(
        access_token=create_access_token(user.id),
        token_type="bearer",
        expires_in=settings.access_token_expire_minutes * 60,
    )


@router.get("/me", response_model=MeOut)
def me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MeOut:
    """当前用户信息 + 角色 + 权限 code 列表。"""
    out = MeOut.model_validate(current_user)
    out.roles = sorted(
        (RoleBrief.model_validate(r) for r in current_user.roles),
        key=lambda r: r.id,
    )
    out.permissions = sorted(get_permission_codes(db, current_user))
    return out


@router.post("/change-password", response_model=MeOut)
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MeOut:
    """自助修改密码（D2 首次安装强制改密走此路径）。

    - 必须提供当前密码（bootstrap 初始密码）；
    - 成功后清除 must_change_password，解除强制改密限制；
    - 审计只记录「密码已更新」，绝不记录密码或哈希。
    """
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="当前密码不正确"
        )
    if verify_password(payload.new_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="新密码不能与当前密码相同"
        )
    current_user.password_hash = hash_password(payload.new_password)
    current_user.must_change_password = False
    write_audit_log(
        db,
        current_user,
        "update",
        "user",
        current_user.id,
        {"field": "password", "reason": "self_service_change", "value": "已更新"},
        request,
    )
    db.commit()
    db.refresh(current_user)
    out = MeOut.model_validate(current_user)
    out.roles = sorted(
        (RoleBrief.model_validate(r) for r in current_user.roles),
        key=lambda r: r.id,
    )
    out.permissions = sorted(get_permission_codes(db, current_user))
    return out
