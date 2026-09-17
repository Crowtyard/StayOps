"""渠道路由（alpha.9.6 F3 客源渠道主数据）。

权限（后端权威，前端隐藏按钮不算权限控制）：
- GET  /channels                -> channel:read
- POST /channels                -> channel:write
- PATCH /channels/{id}          -> channel:write
- POST /channels/{id}/enable    -> channel:write
- POST /channels/{id}/disable   -> channel:write
- DELETE /channels/{id}         -> channel:write

命名约定：新路由一律**单权限码**鉴权（不新增 require_permissions 多码 AND 用法）。

语义要点：
- 默认 `GET /channels` 只返回启用渠道（前台选渠道即可用）；渠道管理 UI 传
  `enabled=false` 查看停用渠道，传 `include_disabled=true` 查看全部。
- 系统预置渠道（美团 / 携程 / 飞猪 / 其他 …）名称固定、不可删除，仅可停用。
- 停用渠道仍保留在库中，历史 Reservation 完整可读（不破坏历史）。
"""

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.orm import Session

from app.api.deps import require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import ChannelCategory, User
from app.schemas.channel import ChannelCreate, ChannelOut, ChannelUpdate
from app.schemas.common import Page
from app.services import channels as svc

router = APIRouter(prefix="/channels", tags=["channels"])


@router.get(
    "",
    response_model=Page[ChannelOut],
    summary="渠道列表（默认仅启用；可按类别筛选）",
)
def list_channels(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    enabled: bool | None = Query(
        None, description="true=仅启用；false=仅停用；不传=仅启用（默认）"
    ),
    include_disabled: bool = Query(
        False, description="true=包含启用与停用（渠道管理 UI 使用）"
    ),
    category: ChannelCategory | None = Query(None),
    _: User = Depends(require_permissions("channel:read")),
    db: Session = Depends(get_db),
) -> dict:
    if include_disabled:
        enabled_filter: bool | None = None
    elif enabled is None:
        enabled_filter = True
    else:
        enabled_filter = enabled
    stmt = svc.list_channels_query(
        db, enabled=enabled_filter, category=category
    )
    result = paginate(db, stmt, page, page_size)
    result["items"] = [svc.channel_out(c) for c in result["items"]]
    return result


@router.post(
    "",
    response_model=ChannelOut,
    status_code=status.HTTP_201_CREATED,
    summary="新增自定义渠道（如 抖音 / 小红书 / 途家 / Booking）",
)
def create_channel(
    payload: ChannelCreate,
    request: Request,
    current_user: User = Depends(require_permissions("channel:write")),
    db: Session = Depends(get_db),
) -> ChannelOut:
    return svc.create_channel(db, payload, current_user, request)


@router.get("/{channel_id}", response_model=ChannelOut, summary="渠道详情")
def get_channel(
    channel_id: int,
    _: User = Depends(require_permissions("channel:read")),
    db: Session = Depends(get_db),
) -> ChannelOut:
    return svc.get_channel(db, channel_id)


@router.patch(
    "/{channel_id}", response_model=ChannelOut, summary="编辑渠道（名称/类别/排序/启用）"
)
def patch_channel(
    channel_id: int,
    payload: ChannelUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("channel:write")),
    db: Session = Depends(get_db),
) -> ChannelOut:
    channel = svc.get_channel(db, channel_id)
    return svc.update_channel(db, channel, payload, current_user, request)


@router.post(
    "/{channel_id}/enable", response_model=ChannelOut, summary="启用渠道（幂等）"
)
def enable_channel(
    channel_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("channel:write")),
    db: Session = Depends(get_db),
) -> ChannelOut:
    channel = svc.get_channel(db, channel_id)
    return svc.set_channel_enabled(
        db, channel, enabled=True, user=current_user, request=request
    )


@router.post(
    "/{channel_id}/disable", response_model=ChannelOut, summary="停用渠道（幂等）"
)
def disable_channel(
    channel_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("channel:write")),
    db: Session = Depends(get_db),
) -> ChannelOut:
    channel = svc.get_channel(db, channel_id)
    return svc.set_channel_enabled(
        db, channel, enabled=False, user=current_user, request=request
    )


@router.delete(
    "/{channel_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除渠道（仅限未被任何预订引用的自定义渠道）",
)
def delete_channel(
    channel_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("channel:write")),
    db: Session = Depends(get_db),
) -> None:
    channel = svc.get_channel(db, channel_id)
    svc.delete_channel(db, channel, current_user, request)
