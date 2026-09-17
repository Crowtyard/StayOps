"""Reservation（预订）模型。

Reservation = 未来住宿计划（与 Stay 分离，决策见 docs/DECISIONS.md）。

关键约束（Migration 内实现）：
- reservation_no 全局唯一（PG Sequence 原子生成 + UNIQUE 约束，REV-04）
- 排他约束 ex_reservations_room_daterange：
    EXCLUDE USING gist (room_id WITH =, daterange(check_in_date, check_out_date, '[)') WITH &&)
    WHERE status NOT IN ('CANCELLED','NO_SHOW','COMPLETED')
  数据库级 Double Booking 最终仲裁（23P01 -> 409，应用层预检仅为快速路径）。
- 日期区间统一 [check_in_date, check_out_date)：紧邻允许，重叠禁止。
- 创建/修改未来 Reservation 不修改 Room 的 occupancy_status（与当前房态解耦）。

alpha.9.6 F3（真实酒店现场试用反馈）：客源渠道规范化 ——
- **`source_channel_id`（FK channels, nullable）是唯一渠道业务事实源。**
  新建/编辑预订只能写本字段；渠道分析（F4）按本字段归因。
- **legacy `source`（PG enum reservation_source）降级为只读历史投影**：
  alpha.9.6 不删除该列（Migration 已按固定映射表回填 source_channel_id，
  原值一字未改），仅用于历史兼容与必要的只读展示回退。
  **新逻辑禁止以 `source` 作为来源事实**；后续单独的 schema-cleanup 版本
  再评估删除。
- 应用层约束（app/schemas/reservation.py）：新建预订必须提供 source_channel_id；
  已存在的历史数据保留 NULL 容错路径，归入「未指定渠道」桶参与对账。
"""

import enum
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Date,
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
from app.models.channel import Channel
from app.models.guest import Guest
from app.models.room import Room, RoomType


class ReservationStatus(str, enum.Enum):
    CONFIRMED = "CONFIRMED"
    CANCELLED = "CANCELLED"
    NO_SHOW = "NO_SHOW"
    CHECKED_IN = "CHECKED_IN"
    COMPLETED = "COMPLETED"


class ReservationSource(str, enum.Enum):
    """LEGACY（alpha.9.6 起为只读历史投影，禁止作为新的来源事实）。

    新来源事实 = Reservation.source_channel_id -> channels。
    保留本枚举仅为历史兼容（迁移映射、旧数据展示回退）。
    """

    DIRECT = "DIRECT"
    PHONE = "PHONE"
    WECHAT = "WECHAT"
    WALK_IN = "WALK_IN"
    OTA = "OTA"
    CORPORATE = "CORPORATE"
    OTHER = "OTHER"


class Reservation(Base):
    __tablename__ = "reservations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    reservation_no: Mapped[str] = mapped_column(
        String(32), unique=True, nullable=False
    )
    guest_id: Mapped[int] = mapped_column(
        ForeignKey("guests.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    room_id: Mapped[int] = mapped_column(
        ForeignKey("rooms.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    room_type_id: Mapped[int] = mapped_column(
        ForeignKey("room_types.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    check_in_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    check_out_date: Mapped[date] = mapped_column(
        Date, nullable=False, index=True
    )
    status: Mapped[ReservationStatus] = mapped_column(
        Enum(
            ReservationStatus,
            name="reservation_status",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=ReservationStatus.CONFIRMED,
        server_default=ReservationStatus.CONFIRMED.value,
        index=True,
    )
    source: Mapped[ReservationSource] = mapped_column(
        Enum(
            ReservationSource,
            name="reservation_source",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=ReservationSource.DIRECT,
        server_default=ReservationSource.DIRECT.value,
    )
    # alpha.9.6 F3：客源渠道（唯一渠道业务事实源）。
    # nullable 仅为历史数据容错（alpha.9.6 迁移已全量回填）；新建预订由
    # schema 层强制要求，后端 service 校验渠道存在且 enabled。
    source_channel_id: Mapped[int | None] = mapped_column(
        ForeignKey("channels.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    external_reference: Mapped[str | None] = mapped_column(String(100))
    agreed_total_amount: Mapped[Decimal] = mapped_column(
        Numeric(10, 2), nullable=False
    )
    currency: Mapped[str] = mapped_column(
        String(3), nullable=False, default="CNY", server_default="CNY"
    )
    notes: Mapped[str | None] = mapped_column(String(1000))
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

    guest: Mapped[Guest] = relationship()
    room: Mapped[Room] = relationship()
    room_type: Mapped[RoomType] = relationship()
    # alpha.9.6 F3：渠道（lazy 加载；渠道分析/响应序列化使用）
    source_channel: Mapped[Channel | None] = relationship()
    # 跨模块关系（Stay 定义于 stay.py）：使用字符串注册表解析，避免循环导入
    stay = relationship("Stay", back_populates="reservation", uselist=False)
