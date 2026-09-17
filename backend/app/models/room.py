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

alpha.9.6 F1（真实酒店现场试用反馈）：新增两个基础资料字段 ——
- name：房间显示名称（nullable）。房号 room_number 是物理身份，name 是
  经营者可读的房型描述（如「101 豪华大床房」）。与 RoomType 不同：
  同一房型下不同房间可有各自名称（海景/朝南/无障碍…）。
- is_active：房间是否投入经营（enabled/active）。**停用不释放 room_number**
  （全局唯一，含停用房间）—— 房号代表持续存在的物理房间身份，
  必须保证历史 Reservation / Stay / Maintenance 语义稳定。
- **不存在 room_count 真值字段**：房间数量永远是 Room 记录的计算结果
  （见 app/services/rooms.py::room_counts）。

注意（alpha.9.6 F2）：occupancy_status 只表达 **Business Date 当天**的物理/运营
占用状态，由业务事务（check-in / check-out / Maintenance）单点维护。
它**不表达"未来某天是否被预订"**；某日房态必须由
app/services/room_status.py 的 date occupancy resolver 计算，禁止用本字段
冒充未来房态。
"""

import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
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
    # alpha.9.6 F1：房间显示名称（nullable；未设置时 UI 回退显示房号）。
    name: Mapped[str | None] = mapped_column(String(100))
    room_type_id: Mapped[int] = mapped_column(
        ForeignKey("room_types.id", ondelete="RESTRICT"), nullable=False
    )
    floor: Mapped[int] = mapped_column(Integer, nullable=False)
    # alpha.9.6 F1：是否投入经营（停用房间不参与可售性/新预订/房态概览分母）。
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default="true",
        index=True,
    )
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
