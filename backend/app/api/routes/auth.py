"""认证路由：POST /auth/login、GET /auth/me。"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_permission_codes
from app.config import settings
from app.core.audit import write_audit_log
from app.core.security import create_access_token, verify_password
from app.database import get_db
from app.models import User
from app.schemas.auth import LoginRequest, MeOut, Token
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
