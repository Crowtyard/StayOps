"""模型导出（alembic env.py 通过本模块导入全部模型以注册 metadata）。"""

from app.models.audit import AuditLog
from app.models.base import Base
from app.models.room import (
    CleaningStatus,
    OccupancyStatus,
    Room,
    RoomType,
)
from app.models.user import Permission, Role, RolePermission, User, UserRole

__all__ = [
    "AuditLog",
    "Base",
    "Permission",
    "Role",
    "RolePermission",
    "CleaningStatus",
    "OccupancyStatus",
    "Room",
    "User",
    "UserRole",
]
