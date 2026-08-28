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
from app.models.inventory import (
    DECREASING_TYPES,
    INCREASING_TYPES,
    InventoryBalance,
    InventoryItem,
    InventoryLocation,
    IssueDestinationType,
    ItemCategory,
    MovementType,
    StockIssue,
    StockIssueLine,
    StockMovement,
)
from app.models.maintenance import (
    MaintenanceCategory,
    MaintenanceSeverity,
    MaintenanceSource,
    MaintenanceWorkOrder,
    MaintenanceWorkOrderStatus,
)
from app.models.procurement import (
    GoodsReceipt,
    GoodsReceiptLine,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    PurchaseRequest,
    PurchaseRequestLine,
    PurchaseRequestStatus,
    Supplier,
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
    "DECREASING_TYPES",
    "INCREASING_TYPES",
    "InventoryBalance",
    "InventoryItem",
    "InventoryLocation",
    "IssueDestinationType",
    "ItemCategory",
    "MovementType",
    "StockIssue",
    "StockIssueLine",
    "StockMovement",
    "GoodsReceipt",
    "GoodsReceiptLine",
    "MaintenanceCategory",
    "MaintenanceSeverity",
    "MaintenanceSource",
    "MaintenanceWorkOrder",
    "MaintenanceWorkOrderStatus",
    "Permission",
    "PurchaseOrder",
    "PurchaseOrderLine",
    "PurchaseOrderStatus",
    "PurchaseRequest",
    "PurchaseRequestLine",
    "PurchaseRequestStatus",
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
    "Supplier",
    "User",
    "UserRole",
]
