"""审计日志写入工具。

所有写操作（含登录成功/失败）必须调用 write_audit_log；
details 只记录变更摘要，禁止写入密码、Token 等敏感数据（AGENTS.md 规则 10）。
"""

from fastapi import Request
from sqlalchemy.orm import Session

from app.models import AuditLog, User


def get_client_ip(request: Request | None) -> str | None:
    """取客户端 IP：优先 X-Forwarded-For 首段，否则直连地址。

    starlette 1.x 下 request.client 为 Address 对象（含 .host）。
    """
    if request is None:
        return None
    xff = request.headers.get("x-forwarded-for")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    if request.client is not None:
        host = getattr(request.client, "host", None)
        if host is not None:
            return str(host)
    return None


def write_audit_log(
    db: Session,
    user: User | None,
    action: str,
    resource_type: str | None = None,
    resource_id: int | None = None,
    details: dict | None = None,
    request: Request | None = None,
) -> AuditLog:
    """追加一条审计日志（flush 但不 commit，由调用方统一提交）。"""
    entry = AuditLog(
        user_id=user.id if user is not None else None,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        details=details,
        ip=get_client_ip(request),
    )
    db.add(entry)
    db.flush()
    return entry
