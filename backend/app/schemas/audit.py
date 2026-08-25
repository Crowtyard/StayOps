"""审计日志 schemas（details 不包含任何密码/Token 等敏感数据）。"""

from datetime import datetime

from pydantic import BaseModel


class AuditLogOut(BaseModel):
    id: int
    user_id: int | None
    username: str | None  # 操作人用户名（用户被删除后为 None）
    action: str
    resource_type: str | None
    resource_id: int | None
    details: dict | None
    ip: str | None
    created_at: datetime
