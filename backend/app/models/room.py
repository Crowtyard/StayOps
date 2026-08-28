"""房型与房间模型。

房态拆分为两个独立维度（决策见 docs/DECISIONS.md）：
- occupancy_status：占用状态（available/reserved/occupied/blocked/out_of_service）
- cleaning_status：清洁状态（clean/dirty/cleaning/inspection/rework）

两个维度可自由组合，例如 reserved + dirty = 已预订但待清扫。
状态机合法转换校验在 app/core/state_machine.py，由 API 层强制。

Sprint 5 §4：新增 unavailability_source（Room metadata，nullable）：
    available / reserved / occupied -> normally null
    blocked                        -> MANUAL
    out_of_service                 -> MANUAL or MAINTENANCE
语义（Sprint 5 §3）：blocked = 运营/人工主动锁房；out_of_service =
因设施、维修、安全或客房本身问题不适合投入住宿经营。
Maintenance 不得把 Room 设置为 blocked。
"""

import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class UnavailabilitySource(str, enum.Enum):
    """Room 不可售来源（Sprint 5 §4）：MANUAL = 运营/人工锁房，MAINTENANCE = 维修。"""

    MANUAL = "MANUAL"
    MAINTENANCE = "MAINTENANCE"


class OccupancyStatus(str, enum.Enum):
    available = "available"
    reserved = "reserved"
    occupied = "occupied"
    blocked = "blocked"
    out_of_service = "out_of_service"


class CleaningStatus(str, enum.Enum):
    clean = "clean"
    dirty = "dirty"
    cleaning = "cleaning"
    inspection = "inspection"
    rework = "rework"


class RoomType(Base):
    __tablename__ = "room_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(
        String(100), unique=True, nullable=False, index=True
    )
    base_price: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    rooms: Mapped[list["Room"]] = relationship(back_populates="room_type")


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    room_number: Mapped[str] = mapped_column(
        String(20), unique=True, nullable=False, index=True
    )
    room_type_id: Mapped[int] = mapped_column(
        ForeignKey("room_types.id", ondelete="RESTRICT"), nullable=False
    )
    floor: Mapped[int] = mapped_column(Integer, nullable=False)
    occupancy_status: Mapped[OccupancyStatus] = mapped_column(
        Enum(
            OccupancyStatus,
            name="occupancy_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=OccupancyStatus.available,
        server_default=OccupancyStatus.available.value,
        index=True,
    )
    cleaning_status: Mapped[CleaningStatus] = mapped_column(
        Enum(
            CleaningStatus,
            name="cleaning_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=CleaningStatus.clean,
        server_default=CleaningStatus.clean.value,
        index=True,
    )
    unavailability_source: Mapped[UnavailabilitySource | None] = mapped_column(
        Enum(
            UnavailabilitySource,
            name="unavailability_source",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=True,
        index=True,
    )
    notes: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    room_type: Mapped[RoomType] = relationship(back_populates="rooms")
