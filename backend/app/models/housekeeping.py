"""HousekeepingTask（保洁任务）模型（Sprint 3）。

Housekeeping Task = 房间翻房（Turnover）任务：Checkout 自动生成或对脏房手动创建。
不保存任何 Guest PII（不关联 Guest / Reservation，见总纲 PII 规则）。

关键约束（Migration 内实现）：
- task_no 全局唯一（PG Sequence 原子生成 + UNIQUE 约束）
- Active Task 数据库级唯一：部分唯一索引
    uq_housekeeping_tasks_active_room ON (room_id)
    WHERE status IN ('PENDING','IN_PROGRESS','INSPECTION','REWORK')
  一个 Room 同时最多一个进行中任务；并发重复创建由数据库最终仲裁（409）。

状态机（app/core/housekeeping_state_machine.py，后端强制）：
    PENDING -> IN_PROGRESS -> INSPECTION -> COMPLETED
    INSPECTION -> REWORK -> IN_PROGRESS -> INSPECTION -> COMPLETED
    任意进行中状态 -> CANCELLED（终态）
与 Room.cleaning_status 原子联动：
    PENDING->dirty, IN_PROGRESS->cleaning, INSPECTION->inspection,
    REWORK->rework, COMPLETED->clean, CANCELLED->dirty
"""

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
from app.models.user import User


class HousekeepingTaskStatus(str, enum.Enum):
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    INSPECTION = "INSPECTION"
    REWORK = "REWORK"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"


class HousekeepingTaskSource(str, enum.Enum):
    CHECKOUT = "CHECKOUT"
    MANUAL = "MANUAL"


class HousekeepingTaskPriority(str, enum.Enum):
    NORMAL = "NORMAL"
    URGENT = "URGENT"


class HousekeepingTask(Base):
    __tablename__ = "housekeeping_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_no: Mapped[str] = mapped_column(
        String(32), unique=True, nullable=False
    )
    room_id: Mapped[int] = mapped_column(
        ForeignKey("rooms.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    status: Mapped[HousekeepingTaskStatus] = mapped_column(
        Enum(
            HousekeepingTaskStatus,
            name="hk_task_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=HousekeepingTaskStatus.PENDING,
        server_default=HousekeepingTaskStatus.PENDING.value,
        index=True,
    )
    priority: Mapped[HousekeepingTaskPriority] = mapped_column(
        Enum(
            HousekeepingTaskPriority,
            name="hk_task_priority",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=HousekeepingTaskPriority.NORMAL,
        server_default=HousekeepingTaskPriority.NORMAL.value,
        index=True,
    )
    source: Mapped[HousekeepingTaskSource] = mapped_column(
        Enum(
            HousekeepingTaskSource,
            name="hk_task_source",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=HousekeepingTaskSource.MANUAL,
        server_default=HousekeepingTaskSource.MANUAL.value,
        index=True,
    )
    assigned_to_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    notes: Mapped[str | None] = mapped_column(String(1000))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_for_inspection_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
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
