"""客源渠道（Channel）主数据模型。

背景（alpha.9.6 F3，真实酒店现场试用反馈）：
原 `reservations.source` 是 7 值 PG 枚举（DIRECT/PHONE/WECHAT/WALK_IN/OTA/
CORPORATE/OTHER），"OTA" 被当作单一来源过粗，经营者无法区分美团 / 携程 / 飞猪。

设计决策（见 docs/DECISIONS.md）：
- Channel 是**可扩展主数据表**，不是硬编码 enum。经营者可自行新增
  「抖音 / 小红书 / 途家 / Booking」等任意渠道，长期可分析。
- **「其他」不是 `channel=OTHER + other_text` 结构**：所有渠道在 channels 表中
  平权，`其他` 只是其中一行默认渠道（category=OTHER）。
- `is_system=true`（迁移植入的预置渠道）：名称固定、禁止物理删除，仅可停用。
  `is_system=false`（经营者自建）：可改名、可停用。
- `enabled=false` 的渠道不得用于新 Reservation，但历史 Reservation 必须完整保留
  （禁用不破坏历史，与 Room 停用同一原则）。
- `reservations.source_channel_id` 是**唯一渠道业务事实源**；
  legacy `reservations.source` 仅作只读历史投影（alpha.9.6 不删除）。
"""

import enum
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ChannelCategory(str, enum.Enum):
    """渠道类别（粗粒度归类，用于经营分析分组；不限制渠道数量）。"""

    OTA = "OTA"
    DIRECT = "DIRECT"
    OFFLINE = "OFFLINE"
    CORPORATE = "CORPORATE"
    OTHER = "OTHER"


class Channel(Base):
    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # code：稳定机器标识（预置渠道为固定大写码；自建渠道为 CUSTOM_xxx）。
    # 名称可改，code 不可改 —— 供外部系统/迁移映射引用。
    code: Mapped[str] = mapped_column(
        String(50), unique=True, nullable=False, index=True
    )
    # name：对经营者展示的渠道名（美团 / 携程 / 飞猪 / 抖音 …）。
    # 全局唯一（含停用渠道）：停用不释放名称，避免同名渠道造成分析歧义。
    name: Mapped[str] = mapped_column(
        String(100), unique=True, nullable=False, index=True
    )
    category: Mapped[ChannelCategory] = mapped_column(
        Enum(
            ChannelCategory,
            name="channel_category",
            values_callable=lambda members: [m.value for m in members],
        ),
        nullable=False,
        default=ChannelCategory.OTHER,
        server_default=ChannelCategory.OTHER.value,
        index=True,
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default="true",
        index=True,
    )
    # is_system=true：由 Alpha 迁移/seed 预置 —— 名称固定、不可物理删除。
    is_system: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
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
