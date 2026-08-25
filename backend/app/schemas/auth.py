"""认证 schemas：登录、Token、当前用户（含权限 code 列表）。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.role import RoleBrief


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=50)
    password: str = Field(..., min_length=1, max_length=128)


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # 秒


class MeOut(BaseModel):
    """当前用户 + 角色 + 权限 code 列表。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str | None
    email: str | None
    phone: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime
    roles: list[RoleBrief] = []
    permissions: list[str] = []
