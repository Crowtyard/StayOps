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
from app.models.maintenance import (
    MaintenanceCategory,
    MaintenanceSeverity,
    MaintenanceSource,
    MaintenanceWorkOrder,
    MaintenanceWorkOrderStatus,
)
from app.models.reservation import Reservation, ReservationSource, ReservationStatus
from app.models.room import (
    CleaningStatus,
    OccupancyStatus,
    Room,
    RoomType,
    UnavailabilitySource,
)
from app.models.stay import Stay, StayStatus
from app.models.stay_assignment import RoomMoveReason, StayRoomAssignment
from app.models.user import Permission, Role, RolePermission, User, UserRole

__all__ = [
    "AuditLog",
    "Base",
    "Guest",
    "HousekeepingTask",
    "HousekeepingTaskPriority",
    "HousekeepingTaskSource",
    "HousekeepingTaskStatus",
    "MaintenanceCategory",
    "MaintenanceSeverity",
    "MaintenanceSource",
    "MaintenanceWorkOrder",
    "MaintenanceWorkOrderStatus",
    "Permission",
    "Reservation",
    "ReservationSource",
    "ReservationStatus",
    "Role",
    "RolePermission",
    "CleaningStatus",
    "OccupancyStatus",
    "UnavailabilitySource",
    "Room",
    "RoomMoveReason",
    "RoomType",
    "Stay",
    "StayRoomAssignment",
    "StayStatus",
    "User",
    "UserRole",
]
