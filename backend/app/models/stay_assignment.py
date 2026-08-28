"""StayRoomAssignment（在住房间分配记录）模型（Sprint 6）。

领域模型（Sprint 6 §2，决策见 docs/DECISIONS.md）：
- Reservation = 商业预订 / 未来房间分配（room_id 在 Check-in 后冻结为原分配房）
- Stay        = 实际住宿（room_id = 当前实际房间快速指针）
- StayRoomAssignment = 实际住宿期间的房间历史

Check-in 建立 assignment #1（room = check-in room，started_at = actual check-in
time，ended_at = NULL）；Room Move 关闭旧 assignment（ended_at = move time）
并开启新 assignment；Check-out 关闭当前 assignment（ended_at = actual
check-out time）。ended_at IS NULL = 当前 active assignment。

数据库约束（Migration 内实现）：
- CHECK ck_stay_room_assignments_interval：ended_at IS NULL OR ended_at > started_at
- 部分唯一索引 uq_stay_room_assignments_active_stay ON (stay_id) WHERE ended_at IS NULL：
  每个 Stay 最多一个 active assignment（数据库最终仲裁）
- 排他约束 ex_stay_room_assignments_no_overlap（btree_gist + tstzrange）：
  同一 Stay 的 assignment 区间 [started_at, ended_at) 互不重叠
  （[s1,e1) 与 [e1,∞) 为紧邻，不重叠；ended_at NULL = 无上界）

reason 只在 Room Move 时记录（7 个固定业务原因，Sprint 6 §10）；
Check-in / backfill 的初始 assignment reason = NULL（UI 显示「入住」）。
"""
from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
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
from app.models.stay import Stay
from app.models.user import User


class RoomMoveReason(str, enum.Enum):
    """换房原因（Sprint 6 §10，固定枚举，不建立自由字符串 reason）。"""

    MAINTENANCE = "MAINTENANCE"
    GUEST_REQUEST = "GUEST_REQUEST"
    ROOM_QUALITY = "ROOM_QUALITY"
    OPERATIONAL = "OPERATIONAL"
    UPGRADE = "UPGRADE"
    DOWNGRADE = "DOWNGRADE"
    OTHER = "OTHER"


class StayRoomAssignment(Base):
    __tablename__ = "stay_room_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    stay_id: Mapped[int] = mapped_column(
        ForeignKey("stays.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    room_id: Mapped[int] = mapped_column(
        ForeignKey("rooms.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[RoomMoveReason | None] = mapped_column(
        Enum(
            RoomMoveReason,
            name="room_move_reason",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=True,
        index=True,
    )
    notes: Mapped[str | None] = mapped_column(String(500))
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    stay: Mapped[Stay] = relationship(back_populates="assignments")
    room: Mapped[Room] = relationship()
    operator: Mapped[User | None] = relationship(foreign_keys=[created_by])
