"""Guest schemas。

Guest 属于 PII：GET /guests* 整体由 guest:read 门控（无权限 403），
因此 GuestOut 在 guest 端点上下文内可完整返回；嵌套于其它资源时
（reservations/stays 的 guest 关联信息）由 service 层序列化按权限裁剪。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class GuestCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    phone: str | None = Field(None, max_length=32)
    email: str | None = Field(None, max_length=255)
    notes: str | None = Field(None, max_length=500)


class GuestUpdate(BaseModel):
    """更新 Guest；未提供字段保持不变（None = 不修改）。"""

    name: str | None = Field(None, min_length=1, max_length=100)
    phone: str | None = Field(None, max_length=32)
    email: str | None = Field(None, max_length=255)
    notes: str | None = Field(None, max_length=500)


class GuestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    phone: str | None
    email: str | None
    notes: str | None
    created_at: datetime
    updated_at: datetime
