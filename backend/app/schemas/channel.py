"""客源渠道（Channel）schemas。

约定（与既有模块一致）：
- 请求体 name 去除首尾空白后必须非空（Pydantic 校验失败 -> 422）。
- 停用渠道不得用于新 Reservation；历史 Reservation 保持可读。
- 系统预置渠道（is_system=true）名称固定，仅允许启用/停用 —— 由 service 层
  强制（403/409 语义在 service 决定，schema 不做业务判断）。
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.channel import ChannelCategory


class ChannelCreate(BaseModel):
    """新增自定义渠道（code 由后端生成，不接受前端传入）。"""

    name: str = Field(..., min_length=1, max_length=100)
    category: ChannelCategory = ChannelCategory.OTHER
    sort_order: int = Field(0, ge=0, le=9999)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("渠道名称不能为空")
        return stripped


class ChannelUpdate(BaseModel):
    """PATCH /channels/{id}：局部更新（strict，未提供字段不变）。

    系统预置渠道的 name 变更会被 service 拒绝（409）；其余字段（category /
    sort_order / enabled）允许系统渠道修改。
    """

    name: str | None = Field(None, min_length=1, max_length=100)
    category: ChannelCategory | None = None
    sort_order: int | None = Field(None, ge=0, le=9999)
    enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("渠道名称不能为空")
        return stripped

    def has_any_field(self) -> bool:
        """是否至少提供了一个可更新字段（空 PATCH 由路由 422 拒绝）。"""
        return bool(self.model_fields_set)


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    code: str
    name: str
    category: ChannelCategory
    enabled: bool
    is_system: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime
