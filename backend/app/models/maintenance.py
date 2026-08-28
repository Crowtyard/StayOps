"""MaintenanceWorkOrder（维修工单）模型（Sprint 5）。

Maintenance Work Order = 独立业务领域：Issue Reported → Work Order → Assign →
Repair → Resolve → Verify / Rework → Complete → Room Ready。

领域原则（Sprint 5 §2）：
    Maintenance Status ≠ Room Occupancy Status ≠ Cleaning Status
维修工单作为第三个独立业务领域，绝不把维修状态塞进 Room 单状态。

关键语义（Sprint 5 §11/§21/§22/§23）：
- blocks_room = true 表示该 Active 工单阻止客房接受新的住宿业务；
  Active Blocking 状态 = OPEN / ASSIGNED / IN_PROGRESS / RESOLVED
  （RESOLVED 仍阻断：维修完成 ≠ 酒店验收通过）。
- 同一 Room 允许多张 Active 工单（不做 active-per-room 唯一约束）。
- 解除 Maintenance 造成的 OOS 必须同时满足：
    active blocking MWO count == 0
    AND Room.occupancy_status == out_of_service
    AND Room.unavailability_source == MAINTENANCE

PII（Sprint 5 §30）：不关联 Guest / Reservation / Stay，不复制 Guest PII。
"""

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.room import Room
from app.models.user import User


class MaintenanceWorkOrderStatus(str, enum.Enum):
    OPEN = "OPEN"
    ASSIGNED = "ASSIGNED"
    IN_PROGRESS = "IN_PROGRESS"
    RESOLVED = "RESOLVED"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class MaintenanceCategory(str, enum.Enum):
    ELECTRICAL = "ELECTRICAL"
    PLUMBING = "PLUMBING"
    HVAC = "HVAC"
    LOCK = "LOCK"
    BATHROOM = "BATHROOM"
    FURNITURE = "FURNITURE"
    APPLIANCE = "APPLIANCE"
    NETWORK = "NETWORK"
    FINISHING = "FINISHING"
    OTHER = "OTHER"


class MaintenanceSeverity(str, enum.Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class MaintenanceSource(str, enum.Enum):
    MANUAL = "MANUAL"
    FRONT_DESK = "FRONT_DESK"
    HOUSEKEEPING = "HOUSEKEEPING"
    PRE_OPENING = "PRE_OPENING"


class MaintenanceWorkOrder(Base):
    __tablename__ = "maintenance_work_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    work_order_no: Mapped[str] = mapped_column(
        String(32), unique=True, nullable=False
    )
    room_id: Mapped[int] = mapped_column(
        ForeignKey("rooms.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    category: Mapped[MaintenanceCategory] = mapped_column(
        Enum(
            MaintenanceCategory,
            name="mwo_category",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        index=True,
    )
    severity: Mapped[MaintenanceSeverity] = mapped_column(
        Enum(
            MaintenanceSeverity,
            name="mwo_severity",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=MaintenanceSeverity.MEDIUM,
        server_default=MaintenanceSeverity.MEDIUM.value,
        index=True,
    )
    status: Mapped[MaintenanceWorkOrderStatus] = mapped_column(
        Enum(
            MaintenanceWorkOrderStatus,
            name="mwo_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=MaintenanceWorkOrderStatus.OPEN,
        server_default=MaintenanceWorkOrderStatus.OPEN.value,
        index=True,
    )
    source: Mapped[MaintenanceSource] = mapped_column(
        Enum(
            MaintenanceSource,
            name="mwo_source",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=MaintenanceSource.MANUAL,
        server_default=MaintenanceSource.MANUAL.value,
        index=True,
    )
    blocks_room: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String(2000))
    reported_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    assigned_to_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    verified_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    resolution_notes: Mapped[str | None] = mapped_column(String(2000))
    verification_notes: Mapped[str | None] = mapped_column(String(2000))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    room: Mapped[Room] = relationship()
    assigned_to: Mapped[User | None] = relationship(
        foreign_keys=[assigned_to_user_id]
    )
    reported_by: Mapped[User | None] = relationship(
        foreign_keys=[reported_by_user_id]
    )
    verified_by: Mapped[User | None] = relationship(
        foreign_keys=[verified_by_user_id]
    )
