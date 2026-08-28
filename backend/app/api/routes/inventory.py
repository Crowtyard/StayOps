"""库存域路由（Sprint 7，统一前缀 /api/v1/inventory）。

权限（§35/§36，用 permission 判断，禁止硬编码角色名）：
- GET items / locations / balances / movements     inventory:read
- POST items / PATCH items / locations             inventory:item_manage
- POST items/{id}/initial-stock                    inventory:item_manage（期初库存 = 物资档案设置）
- POST issues / returns                            inventory:issue（领用 + 归还）
- POST transfers                                   inventory:transfer
- POST stocktakes                                  inventory:adjust

不允许任何直接 PATCH quantity / current_stock / balance 的通道（§2.1/§2.2）；
StockMovement 创建后不可普通 PATCH / DELETE（§9，无对应端点）。
"""

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import (
    InventoryBalance,
    InventoryItem,
    InventoryLocation,
    ItemCategory,
    MovementType,
    StockIssue,
    StockIssueLine,
    StockMovement,
    User,
)
from app.schemas.common import Page
from app.schemas.inventory import (
    InitialStockCreate,
    InitialStockOut,
    InventoryBalanceOut,
    InventoryItemCreate,
    InventoryItemDetailOut,
    InventoryItemListRow,
    InventoryItemOut,
    InventoryItemUpdate,
    InventoryLocationOut,
    InventoryLocationUpdate,
    StockIssueCreate,
    StockIssueOut,
    StockMovementOut,
    StockReturnCreate,
    StockReturnOut,
    StockStatus,
    StockTransferCreate,
    StockTransferOut,
    StocktakeCreate,
    StocktakeOut,
)
from app.services.inventory import (
    create_issue,
    create_item,
    create_return,
    create_stocktake,
    create_transfer,
    recommended_replenishment,
    set_initial_stock,
    stock_status_for,
    total_stock_by_item,
    update_item,
    update_location,
)

router = APIRouter(prefix="/inventory", tags=["inventory"])

_STATUS_PRIORITY = {
    StockStatus.OUT_OF_STOCK: 0,
    StockStatus.LOW_STOCK: 1,
    StockStatus.NORMAL: 2,
}

ZERO = Decimal("0")


def _build_item_out(item: InventoryItem) -> dict:
    return {
        "id": item.id,
        "item_code": item.item_code,
        "name": item.name,
        "category": item.category,
        "base_unit": item.base_unit,
        "specification": item.specification,
        "minimum_stock": item.minimum_stock,
        "target_stock": item.target_stock,
        "is_consumable": item.is_consumable,
        "is_active": item.is_active,
        "notes": item.notes,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def _build_balance_out(balance: InventoryBalance) -> dict:
    location = balance.location
    return {
        "id": balance.id,
        "item_id": balance.item_id,
        "location_id": balance.location_id,
        "location_code": location.location_code if location is not None else None,
        "location_name": location.name if location is not None else None,
        "location_active": location.is_active if location is not None else False,
        "quantity": balance.quantity,
        "updated_at": balance.updated_at,
    }


def _build_movement_out(movement: StockMovement) -> dict:
    item = movement.item
    location = movement.location
    operator = movement.created_by
    return {
        "id": movement.id,
        "movement_no": movement.movement_no,
        "item_id": movement.item_id,
        "item_code": item.item_code if item is not None else None,
        "item_name": item.name if item is not None else None,
        "location_id": movement.location_id,
        "location_code": location.location_code if location is not None else None,
        "location_name": location.name if location is not None else None,
        "movement_type": movement.movement_type,
        "quantity": movement.quantity,
        "reference_type": movement.reference_type,
        "reference_id": movement.reference_id,
        "reason": movement.reason,
        "created_by_user_id": movement.created_by_user_id,
        "operator_name": (
            (operator.display_name or operator.username)
            if operator is not None
            else None
        ),
        "created_at": movement.created_at,
    }


def _build_issue_out(issue: StockIssue) -> dict:
    operator = issue.created_by
    lines = []
    for line in issue.lines:
        item = line.item
        lines.append(
            {
                "id": line.id,
                "item_id": line.item_id,
                "item_code": item.item_code if item is not None else None,
                "item_name": item.name if item is not None else None,
                "base_unit": item.base_unit if item is not None else None,
                "quantity": line.quantity,
            }
        )
    return {
        "id": issue.id,
        "issue_no": issue.issue_no,
        "source_location_id": issue.source_location_id,
        "source_location_name": (
            issue.source_location.name
            if issue.source_location is not None
            else None
        ),
        "destination_type": issue.destination_type,
        "room_id": issue.room_id,
        "notes": issue.notes,
        "created_by_user_id": issue.created_by_user_id,
        "operator_name": (
            (operator.display_name or operator.username)
            if operator is not None
            else None
        ),
        "created_at": issue.created_at,
        "lines": lines,
    }


def _get_item_or_404(db: Session, item_id: int) -> InventoryItem:
    item = db.get(InventoryItem, item_id)
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="库存物资不存在"
        )
    return item


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------


@router.get(
    "/items",
    response_model=Page[InventoryItemListRow],
    response_model_exclude_none=True,
)
def list_items(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = Query(None),
    category: ItemCategory | None = Query(None),
    stock_status: StockStatus | None = Query(None),
    is_active: bool | None = Query(None),
    _: User = Depends(require_permissions("inventory:read")),
    db: Session = Depends(get_db),
) -> dict:
    """物资列表：聚合总库存 + 低库存状态 + 建议补货量（§19/§20/§21）。

    排序：OUT_OF_STOCK -> LOW_STOCK -> NORMAL，同状态按 item_code 升序。
    """
    stmt = select(InventoryItem).order_by(InventoryItem.id)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                InventoryItem.item_code.ilike(pattern),
                InventoryItem.name.ilike(pattern),
            )
        )
    if category is not None:
        stmt = stmt.where(InventoryItem.category == category)
    if is_active is not None:
        stmt = stmt.where(InventoryItem.is_active.is_(is_active))
    items = db.scalars(stmt).all()

    totals = total_stock_by_item(db)
    rows = []
    for item in items:
        total = totals.get(item.id, ZERO)
        current_status = stock_status_for(total, item.minimum_stock)
        rows.append(
            {
                "id": item.id,
                "item_code": item.item_code,
                "name": item.name,
                "category": item.category,
                "base_unit": item.base_unit,
                "minimum_stock": item.minimum_stock,
                "target_stock": item.target_stock,
                "is_consumable": item.is_consumable,
                "is_active": item.is_active,
                "total_stock": total,
                "stock_status": current_status,
                "recommended_replenishment": recommended_replenishment(
                    item.target_stock, total
                ),
            }
        )
    if stock_status is not None:
        rows = [r for r in rows if r["stock_status"] == stock_status]
    rows.sort(
        key=lambda r: (
            _STATUS_PRIORITY[r["stock_status"]],
            r["item_code"],
        )
    )

    total = len(rows)
    start = (page - 1) * page_size
    return {
        "items": rows[start : start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post(
    "/items",
    response_model=InventoryItemOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_item(
    payload: InventoryItemCreate,
    request: Request,
    current_user: User = Depends(require_permissions("inventory:item_manage")),
    db: Session = Depends(get_db),
) -> InventoryItemOut:
    item = create_item(db, payload, current_user, request)
    return _build_item_out(_get_item_or_404(db, item.id))


@router.get(
    "/items/{item_id}",
    response_model=InventoryItemDetailOut,
    response_model_exclude_none=True,
)
def get_item(
    item_id: int,
    _: User = Depends(require_permissions("inventory:read")),
    db: Session = Depends(get_db),
) -> dict:
    """物资详情：聚合 balances / recent movements / 低库存状态（§38）。"""
    item = _get_item_or_404(db, item_id)
    totals = total_stock_by_item(db)
    total = totals.get(item.id, ZERO)

    balances = db.scalars(
        select(InventoryBalance)
        .options(selectinload(InventoryBalance.location))
        .where(InventoryBalance.item_id == item.id)
        .order_by(InventoryBalance.location_id)
    ).all()
    movements = db.scalars(
        select(StockMovement)
        .options(
            selectinload(StockMovement.item),
            selectinload(StockMovement.location),
            selectinload(StockMovement.created_by),
        )
        .where(StockMovement.item_id == item.id)
        .order_by(StockMovement.id.desc())
        .limit(20)
    ).all()

    result = _build_item_out(item)
    result.update(
        {
            "total_stock": total,
            "stock_status": stock_status_for(total, item.minimum_stock),
            "recommended_replenishment": recommended_replenishment(
                item.target_stock, total
            ),
            "balances": [_build_balance_out(b) for b in balances],
            "recent_movements": [_build_movement_out(m) for m in movements],
        }
    )
    return result


@router.patch(
    "/items/{item_id}",
    response_model=InventoryItemOut,
    response_model_exclude_none=True,
)
def patch_item(
    item_id: int,
    payload: InventoryItemUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("inventory:item_manage")),
    db: Session = Depends(get_db),
) -> InventoryItemOut:
    item = db.scalar(
        select(InventoryItem)
        .where(InventoryItem.id == item_id)
        .with_for_update()
    )
    if item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="库存物资不存在"
        )
    update_item(db, item, payload, current_user, request)
    return _build_item_out(_get_item_or_404(db, item_id))


@router.post(
    "/items/{item_id}/initial-stock",
    response_model=InitialStockOut,
    response_model_exclude_none=True,
)
def post_initial_stock(
    item_id: int,
    payload: InitialStockCreate,
    request: Request,
    current_user: User = Depends(require_permissions("inventory:item_manage")),
    db: Session = Depends(get_db),
) -> dict:
    """期初库存（§10）：专用动作，形成 INITIAL movement；不允许 Item Create
    payload 直接写隐藏 balance。"""
    item = _get_item_or_404(db, item_id)
    return set_initial_stock(db, item, payload, current_user, request)


# ---------------------------------------------------------------------------
# Locations
# ---------------------------------------------------------------------------


@router.get(
    "/locations",
    response_model=Page[InventoryLocationOut],
    response_model_exclude_none=True,
)
def list_locations(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    is_active: bool | None = Query(None),
    _: User = Depends(require_permissions("inventory:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(InventoryLocation).order_by(InventoryLocation.id)
    if is_active is not None:
        stmt = stmt.where(InventoryLocation.is_active.is_(is_active))
    result = paginate(db, stmt, page, page_size)
    result["items"] = [
        {
            "id": loc.id,
            "location_code": loc.location_code,
            "name": loc.name,
            "is_active": loc.is_active,
            "notes": loc.notes,
            "created_at": loc.created_at,
            "updated_at": loc.updated_at,
        }
        for loc in result["items"]
    ]
    return result


@router.patch(
    "/locations/{location_id}",
    response_model=InventoryLocationOut,
    response_model_exclude_none=True,
)
def patch_location(
    location_id: int,
    payload: InventoryLocationUpdate,
    request: Request,
    current_user: User = Depends(require_permissions("inventory:item_manage")),
    db: Session = Depends(get_db),
) -> InventoryLocationOut:
    """停用地点用 is_active（不物理删除；有库存地点仍计入总库存，§20）。"""
    location = db.scalar(
        select(InventoryLocation)
        .where(InventoryLocation.id == location_id)
        .with_for_update()
    )
    if location is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="库存地点不存在"
        )
    update_location(db, location, payload, current_user, request)
    return {
        "id": location.id,
        "location_code": location.location_code,
        "name": location.name,
        "is_active": location.is_active,
        "notes": location.notes,
        "created_at": location.created_at,
        "updated_at": location.updated_at,
    }


# ---------------------------------------------------------------------------
# Balances / Movements（只读投影与账本，无任何写端点）
# ---------------------------------------------------------------------------


@router.get(
    "/balances",
    response_model=Page[InventoryBalanceOut],
    response_model_exclude_none=True,
)
def list_balances(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    item_id: int | None = Query(None),
    location_id: int | None = Query(None),
    _: User = Depends(require_permissions("inventory:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = (
        select(InventoryBalance)
        .options(selectinload(InventoryBalance.location))
        .order_by(InventoryBalance.item_id, InventoryBalance.location_id)
    )
    if item_id is not None:
        stmt = stmt.where(InventoryBalance.item_id == item_id)
    if location_id is not None:
        stmt = stmt.where(InventoryBalance.location_id == location_id)
    result = paginate(db, stmt, page, page_size)
    result["items"] = [_build_balance_out(b) for b in result["items"]]
    return result


@router.get(
    "/movements",
    response_model=Page[StockMovementOut],
    response_model_exclude_none=True,
)
def list_movements(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    item_id: int | None = Query(None),
    location_id: int | None = Query(None),
    movement_type: MovementType | None = Query(None),
    reference_type: str | None = Query(None),
    _: User = Depends(require_permissions("inventory:read")),
    db: Session = Depends(get_db),
) -> dict:
    """库存流水（只读账本；无 PATCH / DELETE 端点，§9）。"""
    stmt = (
        select(StockMovement)
        .options(
            selectinload(StockMovement.item),
            selectinload(StockMovement.location),
            selectinload(StockMovement.created_by),
        )
        .order_by(StockMovement.id.desc())
    )
    if item_id is not None:
        stmt = stmt.where(StockMovement.item_id == item_id)
    if location_id is not None:
        stmt = stmt.where(StockMovement.location_id == location_id)
    if movement_type is not None:
        stmt = stmt.where(StockMovement.movement_type == movement_type)
    if reference_type is not None:
        stmt = stmt.where(StockMovement.reference_type == reference_type)
    result = paginate(db, stmt, page, page_size)
    result["items"] = [_build_movement_out(m) for m in result["items"]]
    return result


# ---------------------------------------------------------------------------
# 业务动作：Issue / Return / Transfer / Stocktake
# ---------------------------------------------------------------------------


@router.post(
    "/issues",
    response_model=StockIssueOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_issue(
    payload: StockIssueCreate,
    request: Request,
    current_user: User = Depends(require_permissions("inventory:issue")),
    db: Session = Depends(get_db),
) -> dict:
    """领用单（§11/§12）：多行整体原子；任一行不足 409 且整体回滚。"""
    issue = create_issue(db, payload, current_user, request)
    issue = db.scalar(
        select(StockIssue)
        .options(
            selectinload(StockIssue.lines).selectinload(StockIssueLine.item),
            selectinload(StockIssue.source_location),
            selectinload(StockIssue.created_by),
        )
        .where(StockIssue.id == issue.id)
    )
    if issue is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="领用单不存在"
        )
    return _build_issue_out(issue)


@router.post(
    "/returns",
    response_model=StockReturnOut,
    response_model_exclude_none=True,
)
def post_return(
    payload: StockReturnCreate,
    request: Request,
    current_user: User = Depends(require_permissions("inventory:issue")),
    db: Session = Depends(get_db),
) -> dict:
    """归还（§15）：专用简单 API，movement + balance + audit 同事务。"""
    return create_return(db, payload, current_user, request)


@router.post(
    "/transfers",
    response_model=StockTransferOut,
    response_model_exclude_none=True,
)
def post_transfer(
    payload: StockTransferCreate,
    request: Request,
    current_user: User = Depends(require_permissions("inventory:transfer")),
    db: Session = Depends(get_db),
) -> dict:
    """库间调拨（§16/§17）：酒店总库存不变；Source 不足整体回滚。"""
    return create_transfer(db, payload, current_user, request)


@router.post(
    "/stocktakes",
    response_model=StocktakeOut,
    response_model_exclude_none=True,
)
def post_stocktake(
    payload: StocktakeCreate,
    request: Request,
    current_user: User = Depends(require_permissions("inventory:adjust")),
    db: Session = Depends(get_db),
) -> dict:
    """盘点（§18）：expected = 锁定余额；差异生成 ADJUSTMENT_IN / OUT。"""
    return create_stocktake(db, payload, current_user, request)
