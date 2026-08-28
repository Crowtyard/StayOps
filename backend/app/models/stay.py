"""Stay（入住）模型。

Stay = 实际入住事实（与 Reservation 分离，决策见 docs/DECISIONS.md）。
一个 Reservation 最多产生一个 Stay：reservation_id 唯一约束 + 事务内状态校验双保险。

状态机：ACTIVE -> CHECKED_OUT（终态），仅经 POST /stays/{id}/check-out 变更。
"""

import enum
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.room import Room


class StayStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    CHECKED_OUT = "CHECKED_OUT"


class Stay(Base):
    __tablename__ = "stays"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stay_no: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    reservation_id: Mapped[int] = mapped_column(
        ForeignKey("reservations.id", ondelete="RESTRICT"),
        unique=True,
        nullable=False,
    )
    room_id: Mapped[int] = mapped_column(
        ForeignKey("rooms.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    status: Mapped[StayStatus] = mapped_column(
        Enum(
            StayStatus,
            name="stay_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=StayStatus.ACTIVE,
        server_default=StayStatus.ACTIVE.value,
        index=True,
    )
    actual_check_in_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    planned_check_out_date: Mapped[date] = mapped_column(
        Date, nullable=False, index=True
    )
    actual_check_out_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
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

    # 跨模块关系（Reservation 定义于 reservation.py）：使用字符串注册表解析，避免循环导入
    reservation = relationship("Reservation", back_populates="stay")
    room: Mapped[Room] = relationship()
    # Sprint 6：在住房间分配历史（StayRoomAssignment 定义于 stay_assignment.py）
    assignments = relationship(
        "StayRoomAssignment",
        back_populates="stay",
        order_by="StayRoomAssignment.started_at",
    )
