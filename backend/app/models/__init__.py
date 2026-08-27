"""模型导出（alembic env.py 通过本模块导入全部模型以注册 metadata）。"""

from app.models.audit import AuditLog
from app.models.base import Base
from app.models.guest import Guest
from app.models.housekeeping import (
    HousekeepingTask,
    HousekeepingTaskPriority,
    HousekeepingTaskSource,
    HousekeepingTaskStatus,
)
from app.models.reservation import Reservation, ReservationSource, ReservationStatus
from app.models.room import (
    CleaningStatus,
    OccupancyStatus,
    Room,
    RoomType,
)
from app.models.stay import Stay, StayStatus
from app.models.user import Permission, Role, RolePermission, User, UserRole

__all__ = [
    "AuditLog",
    "Base",
    "Guest",
    "HousekeepingTask",
    "HousekeepingTaskPriority",
    "HousekeepingTaskSource",
    "HousekeepingTaskStatus",
    "Permission",
    "Reservation",
    "ReservationSource",
    "ReservationStatus",
    "Role",
    "RolePermission",
    "CleaningStatus",
    "OccupancyStatus",
    "Room",
    "RoomType",
    "Stay",
    "StayStatus",
    "User",
    "UserRole",
]
