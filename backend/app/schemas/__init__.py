"""Pydantic 请求/响应模型（schemas）。"""

from app.schemas.audit import AuditLogOut
from app.schemas.auth import LoginRequest, MeOut, Token
from app.schemas.common import Page
from app.schemas.role import (
    PermissionOut,
    RoleBrief,
    RoleCreate,
    RoleOut,
    RolePermissionSet,
    RoleUpdate,
)
from app.schemas.room import (
    RoomCreate,
    RoomOut,
    RoomStatusChange,
    RoomTypeBrief,
    RoomTypeCreate,
    RoomTypeOut,
    RoomTypeUpdate,
    RoomUpdate,
)
from app.schemas.user import (
    UserCreate,
    UserOut,
    UserRoleAssign,
    UserUpdate,
)

__all__ = [
    "AuditLogOut",
    "LoginRequest",
    "MeOut",
    "Page",
    "PermissionOut",
    "RoleBrief",
    "RoleCreate",
    "RoleOut",
    "RolePermissionSet",
    "RoleUpdate",
    "RoomCreate",
    "RoomOut",
    "RoomStatusChange",
    "RoomTypeBrief",
    "RoomTypeCreate",
    "RoomTypeOut",
    "RoomTypeUpdate",
    "RoomUpdate",
    "Token",
    "UserCreate",
    "UserOut",
    "UserRoleAssign",
    "UserUpdate",
]
