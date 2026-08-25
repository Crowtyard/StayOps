"""用户 schemas（响应绝不包含 password_hash）。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.role import RoleBrief


class UserCreate(BaseModel):
    username: str = Field(..., min_length=2, max_length=50)
    password: str = Field(..., min_length=6, max_length=128)
    display_name: str | None = Field(None, max_length=100)
    email: str | None = Field(None, max_length=255)
    phone: str | None = Field(None, max_length=32)
    is_active: bool = True


class UserUpdate(BaseModel):
    """更新用户；password 可选（提供时重新 bcrypt 哈希，不返回）。"""

    username: str | None = Field(None, min_length=2, max_length=50)
    password: str | None = Field(None, min_length=6, max_length=128)
    display_name: str | None = Field(None, max_length=100)
    email: str | None = Field(None, max_length=255)
    phone: str | None = Field(None, max_length=32)
    is_active: bool | None = None


class UserRoleAssign(BaseModel):
    """分配角色（整体替换）。"""

    role_ids: list[int]


class UserOut(BaseModel):
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
