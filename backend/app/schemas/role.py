"""角色与权限 schemas。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class RoleBrief(BaseModel):
    """角色摘要（内嵌于用户/登录响应）。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str


class PermissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name: str
    description: str | None


class RoleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    description: str | None = Field(None, max_length=255)


class RoleUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=50)
    description: str | None = Field(None, max_length=255)


class RolePermissionSet(BaseModel):
    """设置角色权限（整体替换）。"""

    permission_ids: list[int]


class RoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime
    permissions: list[PermissionOut] = []
