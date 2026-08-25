"""房型与房间模型。

rooms.status 为 PostgreSQL 原生枚举（room_status），合法值：
available / occupied / cleaning / maintenance / out_of_service。
状态机合法转换的校验在 API 层（Sprint 1 第二阶段）实现。
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


class RoomStatus(str, enum.Enum):
    available = "available"
    occupied = "occupied"
    cleaning = "cleaning"
    maintenance = "maintenance"
    out_of_service = "out_of_service"


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
    status: Mapped[RoomStatus] = mapped_column(
        Enum(
            RoomStatus,
            name="room_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=RoomStatus.available,
        server_default=RoomStatus.available.value,
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
