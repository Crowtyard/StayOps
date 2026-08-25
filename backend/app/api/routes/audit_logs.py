"""审计日志路由：列表（分页、按操作/用户/资源类型筛选）。

权限：audit:read（只读接口，不提供删除）。
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.api.deps import require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import AuditLog, User
from app.schemas.audit import AuditLogOut
from app.schemas.common import Page

router = APIRouter(prefix="/audit-logs", tags=["audit-logs"])


def to_audit_out(log: AuditLog) -> AuditLogOut:
    return AuditLogOut(
        id=log.id,
        user_id=log.user_id,
        username=log.user.username if log.user is not None else None,
        action=log.action,
        resource_type=log.resource_type,
        resource_id=log.resource_id,
        details=log.details,
        ip=log.ip,
        created_at=log.created_at,
    )


@router.get("", response_model=Page[AuditLogOut])
def list_audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    action: str | None = Query(None),
    user_id: int | None = Query(None),
    resource_type: str | None = Query(None),
    _: User = Depends(require_permissions("audit:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(AuditLog).options(joinedload(AuditLog.user))
    if action is not None:
        stmt = stmt.where(AuditLog.action == action)
    if user_id is not None:
        stmt = stmt.where(AuditLog.user_id == user_id)
    if resource_type is not None:
        stmt = stmt.where(AuditLog.resource_type == resource_type)
    stmt = stmt.order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    result = paginate(db, stmt, page, page_size)
    result["items"] = [to_audit_out(log) for log in result["items"]]
    return result
