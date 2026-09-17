"""Channel 域服务层（alpha.9.6 F3 客源渠道主数据）。

设计要点（决策见 docs/DECISIONS.md）：
- **Channel 是可扩展主数据**，不是硬编码 enum。预置渠道（is_system=true）由
  Migration + 幂等 seed 建立；经营者可新增任意自定义渠道。
- **系统预置渠道名称固定、不可物理删除**，仅允许启用/停用；自定义渠道可改名、
  可停用。
- **停用渠道不释放名称**（name 全局唯一，含停用渠道）—— 避免同名渠道造成
  经营分析歧义；与 Room 停用不释放房号同一原则。
- **不允许物理删除已被 Reservation 引用的渠道**（历史来源事实必须可回溯）；
  默认 UX 是停用。
- 唯一渠道业务事实源 = `reservations.source_channel_id`。
  legacy `reservations.source` 仅在**写入**时按渠道类别单向派生
  （`legacy_source_for_channel`），用于历史兼容；读取一律以
  `source_channel_id` 为准。
- 域内所有写操作写审计（app/core/audit.py），权限在路由层以
  `channel:read` / `channel:write` 强制（后端权威）。
"""

from __future__ import annotations

import re
import uuid

from fastapi import HTTPException, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.models import Channel, ChannelCategory, Reservation, ReservationSource

# 预置渠道 code 前缀（自定义渠道 code 不得使用，避免与迁移映射冲突）
SYSTEM_CODE_PREFIX = "SYS_"
# 「其他」/「历史来源」等由迁移预置但保留改名权的渠道
PRESERVED_CODES = ("CUSTOM_OTHER", "CUSTOM_LEGACY")

CUSTOM_CODE_PREFIX = "CUSTOM_"

# 系统预置渠道名称不可修改（决策：推荐系统渠道名称固定，仅允许启用/停用）。
# 例外：CUSTOM_OTHER / CUSTOM_LEGACY 由迁移预置但语义是「其他 / 历史来源」，
# 允许经营者本地化改名 —— 其稳定归属由不可变的 code 保证。
_RENAMABLE_SYSTEM_CODES = set(PRESERVED_CODES)

# channel category -> legacy ReservationSource（写入时单向派生 legacy 投影）
_CATEGORY_TO_LEGACY_SOURCE: dict[ChannelCategory, ReservationSource] = {
    ChannelCategory.OTA: ReservationSource.OTA,
    ChannelCategory.DIRECT: ReservationSource.DIRECT,
    ChannelCategory.OFFLINE: ReservationSource.OTHER,
    ChannelCategory.CORPORATE: ReservationSource.CORPORATE,
    ChannelCategory.OTHER: ReservationSource.OTHER,
}

# 已知渠道 code -> 更精确的 legacy source（OFFLINE 类别内的细分）
_CODE_TO_LEGACY_SOURCE: dict[str, ReservationSource] = {
    "SYS_PHONE": ReservationSource.PHONE,
    "SYS_WECHAT": ReservationSource.WECHAT,
    "SYS_WALK_IN": ReservationSource.WALK_IN,
}

# 反向映射：legacy source -> 渠道 code（仅用于「旧客户端仍传 source」的入站适配
# 与端到端测试兼容）。这是 migration LEGACY_SOURCE_TO_CHANNEL_CODE 的镜像，
# 由 test_channels.py 断言两者一致，防止漂移。
LEGACY_SOURCE_TO_CHANNEL_CODE: dict[ReservationSource, str] = {
    ReservationSource.DIRECT: "SYS_DIRECT",
    ReservationSource.PHONE: "SYS_PHONE",
    ReservationSource.WECHAT: "SYS_WECHAT",
    ReservationSource.WALK_IN: "SYS_WALK_IN",
    ReservationSource.OTA: "CUSTOM_OTHER",
    ReservationSource.CORPORATE: "SYS_CORPORATE",
    ReservationSource.OTHER: "CUSTOM_OTHER",
}

_SLUG_RE = re.compile(r"[^A-Za-z0-9]+")


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail
    )


def _normalized_name(name: str) -> str:
    """渠道名称规范化：去首尾空白（唯一性按原样比较，不折叠大小写）。"""
    return name.strip()


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------


def list_channels_query(
    db: Session,
    *,
    enabled: bool | None = None,
    category: ChannelCategory | None = None,
):
    """渠道查询语句（按 sort_order, id 稳定排序）。"""
    stmt = select(Channel)
    if enabled is not None:
        stmt = stmt.where(Channel.enabled.is_(enabled))
    if category is not None:
        stmt = stmt.where(Channel.category == category)
    return stmt.order_by(Channel.sort_order, Channel.id)


def get_channel(db: Session, channel_id: int) -> Channel:
    channel = db.get(Channel, channel_id)
    if channel is None:
        raise _not_found("渠道不存在")
    return channel


def _name_taken(db: Session, name: str, exclude_id: int | None = None) -> bool:
    stmt = select(Channel.id).where(Channel.name == name)
    if exclude_id is not None:
        stmt = stmt.where(Channel.id != exclude_id)
    return db.scalar(stmt) is not None


def _code_taken(db: Session, code: str) -> bool:
    return db.scalar(select(Channel.id).where(Channel.code == code)) is not None


def generate_custom_code(db: Session, name: str) -> str:
    """生成稳定、唯一、不含中文的自定义渠道 code。

    形态：`CUSTOM_<大写下划线slug>`；slug 为空/冲突时追加短随机后缀。
    code 一经生成不可变（改名不影响 code），保证外部引用与迁移映射稳定。
    """
    slug = _SLUG_RE.sub("_", name).strip("_").upper()[:30]
    candidates = []
    if slug:
        candidates.append(f"{CUSTOM_CODE_PREFIX}{slug}")
        candidates.append(f"{CUSTOM_CODE_PREFIX}{slug}_{uuid.uuid4().hex[:6].upper()}")
    else:
        candidates.append(f"{CUSTOM_CODE_PREFIX}{uuid.uuid4().hex[:8].upper()}")
        candidates.append(f"{CUSTOM_CODE_PREFIX}{uuid.uuid4().hex[:12].upper()}")
    for candidate in candidates:
        if not _code_taken(db, candidate):
            return candidate
    # 兜底：极小概率连续冲突
    while True:
        candidate = f"{CUSTOM_CODE_PREFIX}{uuid.uuid4().hex[:16].upper()}"
        if not _code_taken(db, candidate):
            return candidate


def legacy_source_for_channel(channel: Channel) -> ReservationSource:
    """渠道 -> legacy `reservations.source` 投影（仅用于写入历史兼容列）。

    已知离线渠道细化到 PHONE / WECHAT / WALK_IN；其余按类别映射。
    **本函数只服务于 legacy 列，读取路径不得使用它作为来源事实。**
    """
    precise = _CODE_TO_LEGACY_SOURCE.get(channel.code)
    if precise is not None:
        return precise
    return _CATEGORY_TO_LEGACY_SOURCE[channel.category]


def resolve_channel(db: Session, channel_id: int) -> Channel:
    """校验渠道存在（供可售/预订/分析等只读路径）。不存在 -> 404。"""
    return get_channel(db, channel_id)


def resolve_channel_by_legacy_source(
    db: Session, source: ReservationSource
) -> Channel:
    """legacy source -> 渠道（入站适配，仅供旧客户端/测试继续传 source 时使用）。

    **这不是第二事实源**：解析结果立即写入 `source_channel_id`，落库后一切读取
    仍以渠道为准。预置渠道由迁移与 seed 保证存在；万一缺失（例如被人工
    停用的极端情况）按 code 回退到「历史来源」。
    """
    code = LEGACY_SOURCE_TO_CHANNEL_CODE[source]
    channel = db.scalar(select(Channel).where(Channel.code == code))
    if channel is None:
        channel = db.scalar(select(Channel).where(Channel.code == "CUSTOM_LEGACY"))
    if channel is None:
        raise _unprocessable("渠道主数据缺失，无法解析来源；请先执行 seed")
    return channel


def resolve_enabled_channel(db: Session, channel_id: int) -> Channel:
    """校验渠道存在且启用（供 Reservation 创建/修改）。

    - 不存在 -> 404
    - 已停用 -> 409（人类可读；历史预订仍可读，不受影响）
    """
    channel = get_channel(db, channel_id)
    if not channel.enabled:
        raise _conflict(
            f"渠道「{channel.name}」已停用，无法用于新预订；"
            "请选择其他渠道或先在渠道管理中启用"
        )
    return channel


def channel_out(channel: Channel) -> dict:
    """Channel 响应字典（避免在路由层重复字段列表）。"""
    return {
        "id": channel.id,
        "code": channel.code,
        "name": channel.name,
        "category": channel.category,
        "enabled": channel.enabled,
        "is_system": channel.is_system,
        "sort_order": channel.sort_order,
        "created_at": channel.created_at,
        "updated_at": channel.updated_at,
    }


# ---------------------------------------------------------------------------
# 写操作（新增 / 编辑 / 停用 / 启用 / 删除）
# ---------------------------------------------------------------------------


def create_channel(db: Session, payload, user, request: Request | None = None) -> Channel:
    """新增自定义渠道。名称重复 -> 409（含已停用渠道，名称不释放）。"""
    name = _normalized_name(payload.name)
    if _name_taken(db, name):
        raise _conflict(f"渠道名称「{name}」已存在，请换一个名称")
    channel = Channel(
        code=generate_custom_code(db, name),
        name=name,
        category=payload.category,
        enabled=True,
        is_system=False,
        sort_order=payload.sort_order,
    )
    db.add(channel)
    try:
        db.flush()
    except Exception:  # pragma: no cover - 唯一约束兜底（并发同名）
        db.rollback()
        raise _conflict(f"渠道名称「{name}」已存在，请换一个名称") from None
    write_audit_log(
        db,
        user,
        "channel.create",
        "channel",
        channel.id,
        {
            "code": channel.code,
            "name": channel.name,
            "category": channel.category.value,
            "sort_order": channel.sort_order,
        },
        request,
    )
    db.commit()
    db.refresh(channel)
    return channel


def update_channel(
    db: Session,
    channel: Channel,
    payload,
    user,
    request: Request | None = None,
) -> Channel:
    """PATCH 渠道。系统预置渠道禁止改名（409）；其余字段可改。"""
    if not payload.has_any_field():
        raise _unprocessable("至少提供一个可更新字段")

    changes: dict = {}
    if payload.name is not None and "name" in payload.model_fields_set:
        new_name = _normalized_name(payload.name)
        if new_name != channel.name:
            if channel.is_system and channel.code not in _RENAMABLE_SYSTEM_CODES:
                raise _conflict(
                    f"渠道「{channel.name}」为系统预置渠道，名称固定不可修改；"
                    "如需停用请使用停用操作"
                )
            if _name_taken(db, new_name, exclude_id=channel.id):
                raise _conflict(f"渠道名称「{new_name}」已存在，请换一个名称")
            changes["name"] = {"from": channel.name, "to": new_name}
            channel.name = new_name

    if (
        payload.category is not None
        and "category" in payload.model_fields_set
        and payload.category != channel.category
    ):
        changes["category"] = {
            "from": channel.category.value,
            "to": payload.category.value,
        }
        channel.category = payload.category

    if (
        payload.sort_order is not None
        and "sort_order" in payload.model_fields_set
        and payload.sort_order != channel.sort_order
    ):
        changes["sort_order"] = {
            "from": channel.sort_order,
            "to": payload.sort_order,
        }
        channel.sort_order = payload.sort_order

    if (
        payload.enabled is not None
        and "enabled" in payload.model_fields_set
        and payload.enabled != channel.enabled
    ):
        changes["enabled"] = {
            "from": channel.enabled,
            "to": payload.enabled,
        }
        channel.enabled = payload.enabled

    if not changes:
        return channel
    try:
        db.flush()
    except Exception:  # pragma: no cover - 唯一约束兜底
        db.rollback()
        raise _conflict("渠道保存失败：名称或编码冲突") from None
    write_audit_log(
        db, user, "channel.update", "channel", channel.id, {"changes": changes}, request
    )
    db.commit()
    db.refresh(channel)
    return channel


def set_channel_enabled(
    db: Session,
    channel: Channel,
    *,
    enabled: bool,
    user,
    request: Request | None = None,
) -> Channel:
    """停用 / 启用渠道（幂等；名称与历史数据不受影响）。"""
    if channel.enabled == enabled:
        return channel
    previous = channel.enabled
    channel.enabled = enabled
    write_audit_log(
        db,
        user,
        "channel.enable" if enabled else "channel.disable",
        "channel",
        channel.id,
        {
            "code": channel.code,
            "name": channel.name,
            "from": previous,
            "to": enabled,
        },
        request,
    )
    db.commit()
    db.refresh(channel)
    return channel


def delete_channel(
    db: Session, channel: Channel, user, request: Request | None = None
) -> None:
    """物理删除渠道（仅限从未被任何 Reservation 引用的自定义渠道）。

    - 系统预置渠道 -> 409（禁止删除）
    - 已被 Reservation 引用 -> 409「请改用停用」
    """
    if channel.is_system:
        raise _conflict(
            f"渠道「{channel.name}」为系统预置渠道，不可删除；"
            "如需停止使用请改为停用"
        )
    referenced = db.scalar(
        select(func.count(Reservation.id)).where(
            Reservation.source_channel_id == channel.id
        )
    )
    if referenced:
        raise _conflict(
            f"渠道「{channel.name}」已被 {referenced} 条预订使用，不能删除；"
            "如需停止使用请改为停用（历史预订不受影响）"
        )
    details = {"code": channel.code, "name": channel.name}
    write_audit_log(
        db, user, "channel.delete", "channel", channel.id, details, request
    )
    db.delete(channel)
    db.commit()
