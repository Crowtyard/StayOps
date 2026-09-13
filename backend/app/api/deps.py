"""认证与 RBAC 依赖（FastAPI Depends）。

- get_current_user：解析 Bearer JWT，返回当前用户；未认证 401、禁用 403
- require_permissions(*codes)：权限码不足时 403
- authorize_status_change：房态变更专用鉴权（决策见 docs/DECISIONS.md）：
  - 持有 room:write：可改任意维度
  - 仅改清洁维度：需 room:status_cleaning（HOUSEKEEPING）
  - 仅改占用维度：需 room:write，或目标为 out_of_service 且持有 room:status_maintenance（MAINTENANCE）
  - 无 room:write 时不允许同时改两个维度
"""

from collections.abc import Callable

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.database import get_db
from app.models import (
    CleaningStatus,
    OccupancyStatus,
    Permission,
    RolePermission,
    User,
    UserRole,
)

_bearer = HTTPBearer(auto_error=False)


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    request: Request = None,  # type: ignore[assignment]
    db: Session = Depends(get_db),
) -> User:
    """当前登录用户；缺 Token/无效 Token 401，账号禁用 403。

    D2：首次安装（bootstrap 管理员）在修改初始密码之前，除白名单路径外一律 403 ——
    强制改密由后端保证，不能只靠前端跳转。
    """
    if credentials is None or not credentials.credentials:
        raise _unauthorized("未认证：缺少 Bearer Token")
    user_id = decode_access_token(credentials.credentials)
    if user_id is None:
        raise _unauthorized("Token 无效或已过期")
    user = db.get(User, user_id)
    if user is None:
        raise _unauthorized("用户不存在或已被删除")
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="账号已禁用"
        )
    if user.must_change_password and not _password_change_allowed(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="首次登录必须先修改初始密码",
        )
    return user


# 强制改密期间仍可访问的路径（读取自身信息 / 改密 / 退出）
PASSWORD_CHANGE_ALLOWED_PATHS = frozenset(
    {
        "/api/v1/auth/me",
        "/api/v1/auth/change-password",
        "/api/v1/auth/logout",
    }
)


def _password_change_allowed(request: "Request | None") -> bool:
    if request is None:
        return True  # 直接调用依赖（测试/内部）时不拦截
    path = getattr(getattr(request, "url", None), "path", "") or ""
    return path in PASSWORD_CHANGE_ALLOWED_PATHS


def get_permission_codes(db: Session, user: User) -> set[str]:
    """经 user_roles -> role_permissions -> permissions 解析权限 code 集合。"""
    stmt = (
        select(Permission.code)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .join(UserRole, UserRole.role_id == RolePermission.role_id)
        .where(UserRole.user_id == user.id)
    )
    return set(db.scalars(stmt).all())


def get_ai_service(db: Session = Depends(get_db)) -> "AIManagerService":
    """AI Manager 服务依赖（Sprint 9；测试可经 dependency_overrides 注入 Fake）。"""
    from app.services.ai_manager import AIManagerService

    return AIManagerService(db)


def require_permissions(*codes: str) -> Callable[..., User]:
    """权限依赖工厂：要求当前用户持有全部指定权限 code，否则 403。"""

    def dependency(
        current_user: User = Depends(get_current_user),
        db: Session = Depends(get_db),
    ) -> User:
        granted = get_permission_codes(db, current_user)
        if not set(codes).issubset(granted):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="权限不足"
            )
        return current_user

    return dependency


def authorize_status_change(
    db: Session,
    user: User,
    *,
    occupancy: OccupancyStatus | None = None,
    cleaning: CleaningStatus | None = None,
) -> None:
    """房态变更鉴权（后端强制）。

    room:write 可改任意维度；否则仅允许单一维度变更且持有对应权限：
    清洁维度 -> room:status_cleaning；占用维度置为 out_of_service -> room:status_maintenance。
    """
    granted = get_permission_codes(db, user)
    if "room:write" in granted:
        return
    if occupancy is not None and cleaning is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="权限不足：无 room:write 时不允许同时变更占用与清洁状态",
        )
    if cleaning is not None:
        if "room:status_cleaning" not in granted:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="权限不足"
            )
        return
    if occupancy is not None:
        if (
            occupancy == OccupancyStatus.out_of_service
            and "room:status_maintenance" in granted
        ):
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="权限不足"
        )
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN, detail="权限不足"
    )
