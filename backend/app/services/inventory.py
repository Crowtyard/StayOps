"""库存域服务层（Sprint 7）。

LOCKED 架构决策（Sprint 7 §2，见 docs/DECISIONS.md）：
- StockMovement = 永久库存账本事实（immutable ledger fact）：
  不允许普通 PATCH / DELETE；修正库存使用新的 ADJUSTMENT_IN / ADJUSTMENT_OUT。
- InventoryBalance = Projection（投影）：每次库存事务必须
  create StockMovement + update InventoryBalance 在同一数据库事务完成；
  no movement = no stock change；不允许任何直接 PATCH quantity 的通道。
- 多库存地点：每个 (item, location) 一个 Balance 行。

并发模型（Sprint 7 §48/§13，Lock Graph）：
- 所有减少库存的操作必须：SELECT InventoryBalance ... FOR UPDATE ->
  recheck quantity -> movement -> balance update；不足返回 409，绝不 500。
- 多 Item 事务按确定性顺序 (item_id, location_id) 升序锁 Balance 行
  （不得按客户端提交顺序）；目的地 Balance 行缺失时
  INSERT ... ON CONFLICT DO NOTHING 后 SELECT FOR UPDATE（防并发插入竞态）。
- 全局无环：Inventory 事务只锁 Balance 行；Procurement 收货锁顺序为
  PurchaseOrder -> PO lines -> Balance 行（Balance 永远在锁链末端，
  不存在 Balance -> 业务文档 的反向路径）。
- 并发仲裁错误窄分类：40P01/40001 -> 409；其它 OperationalError 原样传播。
"""

from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.business_date import business_date
from app.core.db_conflict import classify, is_transaction_conflict
from app.models import (
    DECREASING_TYPES,
    INCREASING_TYPES,
    InventoryBalance,
    InventoryItem,
    InventoryLocation,
    IssueDestinationType,
    MovementType,
    Room,
    StockIssue,
    StockIssueLine,
    StockMovement,
    User,
)
from app.schemas.inventory import (
    InitialStockCreate,
    InventoryItemCreate,
    InventoryItemUpdate,
    InventoryLocationUpdate,
    StockIssueCreate,
    StockReturnCreate,
    StockStatus,
    StockTransferCreate,
    StocktakeCreate,
)

MOVEMENT_NO_SEQ = "stock_movement_no_seq"
ISSUE_NO_SEQ = "stock_issue_no_seq"

RECENT_MOVEMENT_LIMIT = 20


def qstr(value: Decimal) -> str:
    """审计用数量字符串：固定两位小数（Numeric(12,2) 语义，稳定可比较）。"""
    return str(Decimal(value).quantize(Decimal("0.01")))


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail
    )


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def next_movement_no(db: Session) -> str:
    """格式 SMV{YYYYMMDD}-{NNNN}（日期 = Property Business Date，序号 = Sequence）。"""
    value = db.scalar(text(f"SELECT nextval('{MOVEMENT_NO_SEQ}')"))
    return f"SMV{business_date():%Y%m%d}-{value:04d}"


def next_issue_no(db: Session) -> str:
    """格式 SIS{YYYYMMDD}-{NNNN}。"""
    value = db.scalar(text(f"SELECT nextval('{ISSUE_NO_SEQ}')"))
    return f"SIS{business_date():%Y%m%d}-{value:04d}"


def _commit_or_conflict(db: Session, generic_detail: str) -> None:
    """提交；IntegrityError（23505/23514/23P01）与 40P01/40001 并发仲裁
    映射 409；其它 OperationalError 原样 re-raise（不吞基础设施错误）。"""
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check", "exclusion"):
            raise _conflict(generic_detail) from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict(generic_detail) from exc
        raise


# ---------------------------------------------------------------------------
# 基础查询 / 校验
# ---------------------------------------------------------------------------


def _get_location(db: Session, location_id: int) -> InventoryLocation:
    location = db.get(InventoryLocation, location_id)
    if location is None:
        raise _not_found("库存地点不存在")
    return location


def _get_item(db: Session, item_id: int) -> InventoryItem:
    item = db.get(InventoryItem, item_id)
    if item is None:
        raise _not_found("库存物资不存在")
    return item


def _load_items(db: Session, item_ids: list[int]) -> dict[int, InventoryItem]:
    """批量加载物资；任一不存在 -> 422（输入组合不合法）。"""
    items = db.scalars(
        select(InventoryItem).where(InventoryItem.id.in_(item_ids))
    ).all()
    by_id = {item.id: item for item in items}
    missing = [i for i in item_ids if i not in by_id]
    if missing:
        raise _unprocessable("存在不存在的物资 item_id")
    return by_id


# ---------------------------------------------------------------------------
# Balance 锁定（Sprint 7 §13：确定性顺序 (item_id, location_id) 升序）
# ---------------------------------------------------------------------------


def _lock_existing_balance(
    db: Session, item_id: int, location_id: int
) -> InventoryBalance | None:
    """SELECT ... FOR UPDATE；行不存在返回 None（视为数量 0，不创建）。"""
    return db.scalar(
        select(InventoryBalance)
        .where(
            InventoryBalance.item_id == item_id,
            InventoryBalance.location_id == location_id,
        )
        .with_for_update()
    )


def _ensure_locked_balance(
    db: Session, item_id: int, location_id: int
) -> InventoryBalance:
    """目的地余额：INSERT ON CONFLICT DO NOTHING 后 SELECT FOR UPDATE。

    并发安全：两个事务同时为同一 (item, location) 创建行时，一个 INSERT
    成功、另一个 DO NOTHING；随后双方都在 FOR UPDATE 上串行化，
    读到已提交的最新数量（唯一约束 uq_item_location 兜底）。
    """
    db.execute(
        pg_insert(InventoryBalance)
        .values(item_id=item_id, location_id=location_id, quantity=0)
        .on_conflict_do_nothing(index_elements=["item_id", "location_id"])
    )
    return _lock_existing_balance(db, item_id, location_id)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# 流水 + 余额（同事务原子：no movement = no stock change）
# ---------------------------------------------------------------------------


def _record_movement(
    db: Session,
    *,
    item_id: int,
    location_id: int,
    balance: InventoryBalance,
    movement_type: MovementType,
    signed_quantity: Decimal,
    user: User | None,
    reference_type: str | None = None,
    reference_id: int | None = None,
    reason: str | None = None,
) -> StockMovement:
    """创建流水并更新（已锁定的）Balance 行，随后 flush 取得 movement.id。

    符号规则（§8，与 DB CHECK 一致，业务层再强制）：
        INCREASING_TYPES 必须 > 0；DECREASING_TYPES 必须 < 0；INITIAL >= 0。
    """
    if movement_type in INCREASING_TYPES and signed_quantity <= 0:
        raise ValueError(f"{movement_type.value} 数量必须为正")
    if movement_type in DECREASING_TYPES and signed_quantity >= 0:
        raise ValueError(f"{movement_type.value} 数量必须为负")
    if movement_type == MovementType.INITIAL and signed_quantity < 0:
        raise ValueError("INITIAL 数量不能为负")

    movement = StockMovement(
        movement_no=next_movement_no(db),
        item_id=item_id,
        location_id=location_id,
        movement_type=movement_type,
        quantity=signed_quantity,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
        created_by_user_id=user.id if user is not None else None,
    )
    db.add(movement)
    new_quantity = balance.quantity + signed_quantity
    if new_quantity < 0:
        # FOR UPDATE 后重校验的防御性兜底：绝不允许负库存
        raise _conflict("库存不足：扣减后库存不能为负")
    balance.quantity = new_quantity
    db.flush()
    return movement


def _movement_audit_line(item: InventoryItem, quantity: Decimal) -> dict:
    return {
        "item_id": item.id,
        "item_code": item.item_code,
        "quantity": qstr(quantity),
    }


# ---------------------------------------------------------------------------
# 物资档案（Item Master）
# ---------------------------------------------------------------------------


def create_item(
    db: Session,
    payload: InventoryItemCreate,
    user: User | None,
    request=None,
) -> InventoryItem:
    """创建物资档案（item_code 唯一，创建后不可变）。"""
    item = InventoryItem(
        item_code=payload.item_code,
        name=payload.name,
        category=payload.category,
        base_unit=payload.base_unit,
        specification=payload.specification,
        minimum_stock=payload.minimum_stock,
        target_stock=payload.target_stock,
        is_consumable=payload.is_consumable,
        notes=payload.notes,
    )
    db.add(item)
    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "inventory.item.create",
            "inventory_item",
            item.id,
            {
                "item_code": item.item_code,
                "name": item.name,
                "category": item.category.value,
                "base_unit": item.base_unit,
            },
            request,
        )
        _commit_or_conflict(db, "物资代码已存在")
        return item
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("物资代码已存在") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("物资创建失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def update_item(
    db: Session,
    item: InventoryItem,
    payload: InventoryItemUpdate,
    user: User | None,
    request=None,
) -> InventoryItem:
    """PATCH 物资（item_code 不可修改；minimum/target 最终配对校验）。"""
    has_movements = (
        db.scalar(
            select(StockMovement.id)
            .where(StockMovement.item_id == item.id)
            .limit(1)
        )
        is not None
    )

    changes: list[str] = []
    if "name" in payload.model_fields_set and payload.name is not None:
        if payload.name != item.name:
            changes.append("name")
            item.name = payload.name
    if "category" in payload.model_fields_set and payload.category is not None:
        if payload.category != item.category:
            changes.append(f"category:{item.category.value}->{payload.category.value}")
            item.category = payload.category
    if "base_unit" in payload.model_fields_set and payload.base_unit is not None:
        if payload.base_unit != item.base_unit:
            # 已有库存流水的物资不允许改基础单位（账本语义会被破坏）
            if has_movements:
                raise _conflict("该物资已有库存流水，基础单位不可修改")
            changes.append("base_unit")
            item.base_unit = payload.base_unit
    if "specification" in payload.model_fields_set:
        if payload.specification != item.specification:
            changes.append("specification")
            item.specification = payload.specification
    if "minimum_stock" in payload.model_fields_set and payload.minimum_stock is not None:
        if payload.minimum_stock != item.minimum_stock:
            changes.append(f"minimum_stock:{item.minimum_stock}->{payload.minimum_stock}")
            item.minimum_stock = payload.minimum_stock
    if "target_stock" in payload.model_fields_set and payload.target_stock is not None:
        if payload.target_stock != item.target_stock:
            changes.append(f"target_stock:{item.target_stock}->{payload.target_stock}")
            item.target_stock = payload.target_stock
    if "is_consumable" in payload.model_fields_set and payload.is_consumable is not None:
        if payload.is_consumable != item.is_consumable:
            changes.append("is_consumable")
            item.is_consumable = payload.is_consumable
    if "is_active" in payload.model_fields_set and payload.is_active is not None:
        if payload.is_active != item.is_active:
            changes.append(f"is_active:{item.is_active}->{payload.is_active}")
            item.is_active = payload.is_active
    if "notes" in payload.model_fields_set:
        if payload.notes != item.notes:
            changes.append("notes")
            item.notes = payload.notes

    # minimum / target 最终配对校验（DB CHECK 兜底，service 先行友好报错）
    if item.target_stock < item.minimum_stock:
        raise _unprocessable("目标库存不能小于最低库存")

    if not changes:
        return item

    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "inventory.item.update",
            "inventory_item",
            item.id,
            {"item_code": item.item_code, "changed": changes},
            request,
        )
        _commit_or_conflict(db, "物资修改失败：数据冲突")
        return item
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("物资修改失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("物资修改失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def update_location(
    db: Session,
    location: InventoryLocation,
    payload: InventoryLocationUpdate,
    user: User | None,
    request=None,
) -> InventoryLocation:
    """PATCH 库存地点（停用用 is_active；不物理删除）。

    已停用 Location 若仍有库存，总库存计算仍包含其余额（§20），
    不静默从总库存消失。
    """
    changes: list[str] = []
    if "name" in payload.model_fields_set and payload.name is not None:
        if payload.name != location.name:
            changes.append("name")
            location.name = payload.name
    if "is_active" in payload.model_fields_set and payload.is_active is not None:
        if payload.is_active != location.is_active:
            changes.append(f"is_active:{location.is_active}->{payload.is_active}")
            location.is_active = payload.is_active
    if "notes" in payload.model_fields_set:
        if payload.notes != location.notes:
            changes.append("notes")
            location.notes = payload.notes

    if not changes:
        return location

    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "inventory.location.update",
            "inventory_location",
            location.id,
            {"location_code": location.location_code, "changed": changes},
            request,
        )
        _commit_or_conflict(db, "地点修改失败：数据冲突")
        return location
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("地点修改失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("地点修改失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 期初库存（INITIAL，必须通过专用动作）
# ---------------------------------------------------------------------------


def set_initial_stock(
    db: Session,
    item: InventoryItem,
    payload: InitialStockCreate,
    user: User | None,
    request=None,
) -> dict:
    """期初库存（§10）：明确形成 INITIAL movement + Balance 更新同事务。"""
    location = _get_location(db, payload.location_id)
    balance = _ensure_locked_balance(db, item.id, location.id)

    try:
        movement = _record_movement(
            db,
            item_id=item.id,
            location_id=location.id,
            balance=balance,
            movement_type=MovementType.INITIAL,
            signed_quantity=payload.quantity,
            user=user,
            reason=payload.reason,
        )
        write_audit_log(
            db,
            user,
            "inventory.initial",
            "stock_movement",
            movement.id,
            {
                "movement_no": movement.movement_no,
                "item_id": item.id,
                "item_code": item.item_code,
                "location_id": location.id,
                "location_code": location.location_code,
                "quantity": qstr(payload.quantity),
                "balance_quantity": qstr(balance.quantity),
            },
            request,
        )
        _commit_or_conflict(db, "期初库存设置失败：数据冲突")
        return {
            "id": movement.id,
            "movement_no": movement.movement_no,
            "item_id": item.id,
            "item_code": item.item_code,
            "item_name": item.name,
            "location_id": location.id,
            "location_name": location.name,
            "quantity": payload.quantity,
            "balance_quantity": balance.quantity,
            "reason": payload.reason,
            "created_at": movement.created_at,
        }
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        if isinstance(exc, IntegrityError) and classify(exc) in (
            "unique",
            "check",
            "exclusion",
        ):
            raise _conflict("期初库存设置失败：数据冲突") from exc
        if isinstance(exc, OperationalError) and is_transaction_conflict(exc):
            raise _conflict("期初库存设置失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 领用（ISSUE，多行整体原子）
# ---------------------------------------------------------------------------


def create_issue(
    db: Session,
    payload: StockIssueCreate,
    user: User | None,
    request=None,
) -> StockIssue:
    """领用单（§11/§12）：多行领用必须全原子。

    事务：锁所有相关 Balance 行（(item_id, location_id) 升序）->
    校验全部数量 -> 创建 Issue + Lines -> 创建 ISSUE movements ->
    更新 balances -> 审计 -> commit。任一行不足：整体回滚（409）。
    """
    source = _get_location(db, payload.source_location_id)
    items = _load_items(db, [line.item_id for line in payload.lines])

    if payload.destination_type == IssueDestinationType.ROOM:
        room = db.get(Room, payload.room_id)
        if room is None:
            raise _unprocessable("房间不存在")

    # 确定性锁顺序：(item_id, location_id) 升序（§13，不按客户端提交顺序）
    pairs = sorted((line.item_id, source.id) for line in payload.lines)
    balances: dict[tuple[int, int], InventoryBalance | None] = {}
    for pair in pairs:
        balances[pair] = _lock_existing_balance(db, pair[0], pair[1])

    # 全部数量校验（任一不足 -> 409，整体回滚，绝不部分扣减）
    for line in payload.lines:
        balance = balances[(line.item_id, source.id)]
        available = balance.quantity if balance is not None else Decimal("0")
        if available < line.quantity:
            item = items[line.item_id]
            raise _conflict(
                f"库存不足：{item.item_code} 现有 {available} {item.base_unit}，"
                f"领用 {line.quantity} {item.base_unit}"
            )

    issue = StockIssue(
        issue_no=next_issue_no(db),
        source_location_id=source.id,
        destination_type=payload.destination_type,
        room_id=payload.room_id if payload.destination_type == IssueDestinationType.ROOM else None,
        notes=payload.notes,
        created_by_user_id=user.id if user is not None else None,
    )
    db.add(issue)
    db.flush()

    movement_ids: list[int] = []
    for line in payload.lines:
        db.add(
            StockIssueLine(
                issue_id=issue.id,
                item_id=line.item_id,
                quantity=line.quantity,
            )
        )
        balance = balances[(line.item_id, source.id)]
        assert balance is not None  # 数量校验已保证行存在
        movement = _record_movement(
            db,
            item_id=line.item_id,
            location_id=source.id,
            balance=balance,
            movement_type=MovementType.ISSUE,
            signed_quantity=-line.quantity,
            user=user,
            reference_type="stock_issue",
            reference_id=issue.id,
            reason=payload.notes,
        )
        movement_ids.append(movement.id)

    try:
        write_audit_log(
            db,
            user,
            "inventory.issue",
            "stock_issue",
            issue.id,
            {
                "issue_no": issue.issue_no,
                "source_location_id": source.id,
                "source_location_code": source.location_code,
                "destination_type": payload.destination_type.value,
                "room_id": issue.room_id,
                "lines": [
                    _movement_audit_line(items[line.item_id], line.quantity)
                    for line in payload.lines
                ],
                "movement_ids": movement_ids,
            },
            request,
        )
        _commit_or_conflict(db, "领用失败：数据冲突")
        return issue
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        if isinstance(exc, IntegrityError) and classify(exc) in (
            "unique",
            "check",
            "exclusion",
        ):
            raise _conflict("领用失败：数据冲突") from exc
        if isinstance(exc, OperationalError) and is_transaction_conflict(exc):
            raise _conflict("领用失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 归还（RETURN，专用简单 API）
# ---------------------------------------------------------------------------


def create_return(
    db: Session,
    payload: StockReturnCreate,
    user: User | None,
    request=None,
) -> dict:
    """归还（§15）：create movement + update balance + audit 同事务。"""
    item = _get_item(db, payload.item_id)
    location = _get_location(db, payload.location_id)
    balance = _ensure_locked_balance(db, item.id, location.id)

    try:
        movement = _record_movement(
            db,
            item_id=item.id,
            location_id=location.id,
            balance=balance,
            movement_type=MovementType.RETURN,
            signed_quantity=payload.quantity,
            user=user,
            reference_type="stock_return",
            reason=payload.reason,
        )
        write_audit_log(
            db,
            user,
            "inventory.return",
            "stock_movement",
            movement.id,
            {
                "movement_no": movement.movement_no,
                "item_id": item.id,
                "item_code": item.item_code,
                "location_id": location.id,
                "location_code": location.location_code,
                "quantity": qstr(payload.quantity),
                "balance_quantity": qstr(balance.quantity),
            },
            request,
        )
        _commit_or_conflict(db, "归还失败：数据冲突")
        return {
            "id": movement.id,
            "movement_no": movement.movement_no,
            "item_id": item.id,
            "item_code": item.item_code,
            "item_name": item.name,
            "location_id": location.id,
            "location_name": location.name,
            "quantity": payload.quantity,
            "reason": payload.reason,
            "created_at": movement.created_at,
        }
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        if isinstance(exc, IntegrityError) and classify(exc) in (
            "unique",
            "check",
            "exclusion",
        ):
            raise _conflict("归还失败：数据冲突") from exc
        if isinstance(exc, OperationalError) and is_transaction_conflict(exc):
            raise _conflict("归还失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 调拨（TRANSFER_OUT + TRANSFER_IN，同事务，酒店总库存不变）
# ---------------------------------------------------------------------------


def create_transfer(
    db: Session,
    payload: StockTransferCreate,
    user: User | None,
    request=None,
) -> dict:
    """库间调拨（§16/§17）：多行整体原子。

    事务：按 (item_id, location_id) 升序锁 Source（现有行）与
    Destination（INSERT ON CONFLICT + FOR UPDATE）-> 校验全部 Source 库存 ->
    TRANSFER_OUT / TRANSFER_IN 成对 movement（互相 reference 对方） ->
    更新 balances -> 审计 -> commit。任一行不足整体回滚。
    """
    source = _get_location(db, payload.source_location_id)
    destination = _get_location(db, payload.destination_location_id)
    items = _load_items(db, [line.item_id for line in payload.lines])

    # 确定性锁顺序（§13）：同一 Item 的 source/dest 也按 location_id 升序
    pairs = sorted(
        (line.item_id, loc.id)
        for line in payload.lines
        for loc in (source, destination)
    )
    balances: dict[tuple[int, int], InventoryBalance | None] = {}
    for pair in pairs:
        if pair[1] == destination.id:
            balances[pair] = _ensure_locked_balance(db, pair[0], pair[1])
        else:
            balances[pair] = _lock_existing_balance(db, pair[0], pair[1])

    # 全部数量校验（任一不足 -> 409，整体回滚）
    for line in payload.lines:
        balance = balances[(line.item_id, source.id)]
        available = balance.quantity if balance is not None else Decimal("0")
        if available < line.quantity:
            item = items[line.item_id]
            raise _conflict(
                f"库存不足：{item.item_code} 在 {source.name} 现有 "
                f"{available} {item.base_unit}，调拨 {line.quantity} {item.base_unit}"
            )

    try:
        movement_ids: list[int] = []
        for line in payload.lines:
            source_balance = balances[(line.item_id, source.id)]
            dest_balance = balances[(line.item_id, destination.id)]
            assert source_balance is not None and dest_balance is not None
            out_movement = _record_movement(
                db,
                item_id=line.item_id,
                location_id=source.id,
                balance=source_balance,
                movement_type=MovementType.TRANSFER_OUT,
                signed_quantity=-line.quantity,
                user=user,
                reference_type="stock_movement",
                reason=payload.reason,
            )
            in_movement = _record_movement(
                db,
                item_id=line.item_id,
                location_id=destination.id,
                balance=dest_balance,
                movement_type=MovementType.TRANSFER_IN,
                signed_quantity=line.quantity,
                user=user,
                reference_type="stock_movement",
                reason=payload.reason,
            )
            # 成对互指，保证可追溯（OUT <-> IN）
            out_movement.reference_id = in_movement.id
            in_movement.reference_id = out_movement.id
            db.flush()
            movement_ids.extend([out_movement.id, in_movement.id])

        write_audit_log(
            db,
            user,
            "inventory.transfer",
            "stock_movement",
            movement_ids[0] if movement_ids else None,
            {
                "source_location_id": source.id,
                "source_location_code": source.location_code,
                "destination_location_id": destination.id,
                "destination_location_code": destination.location_code,
                "lines": [
                    _movement_audit_line(items[line.item_id], line.quantity)
                    for line in payload.lines
                ],
                "movement_ids": movement_ids,
            },
            request,
        )
        _commit_or_conflict(db, "调拨失败：数据冲突")
        return {
            "source_location_id": source.id,
            "source_location_name": source.name,
            "destination_location_id": destination.id,
            "destination_location_name": destination.name,
            "reason": payload.reason,
            "created_by_user_id": user.id if user is not None else None,
            "operator_name": (
                (user.display_name or user.username) if user is not None else None
            ),
            "created_at": out_movement.created_at,
            "lines": [
                {
                    "id": line.item_id,
                    "item_id": line.item_id,
                    "item_code": items[line.item_id].item_code,
                    "item_name": items[line.item_id].name,
                    "base_unit": items[line.item_id].base_unit,
                    "quantity": line.quantity,
                }
                for line in payload.lines
            ],
            "movement_ids": movement_ids,
        }
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        if isinstance(exc, IntegrityError) and classify(exc) in (
            "unique",
            "check",
            "exclusion",
        ):
            raise _conflict("调拨失败：数据冲突") from exc
        if isinstance(exc, OperationalError) and is_transaction_conflict(exc):
            raise _conflict("调拨失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 盘点 / 调整（Stocktake / ADJUSTMENT）
# ---------------------------------------------------------------------------


def create_stocktake(
    db: Session,
    payload: StocktakeCreate,
    user: User | None,
    request=None,
) -> dict:
    """盘点（§18）：锁定 Balance -> expected = 当前余额 -> actual = 用户输入 ->
    difference -> ADJUSTMENT_IN / ADJUSTMENT_OUT（相同为 no-op，不创建 movement）。

    审计记录 expected / actual / difference。
    """
    item = _get_item(db, payload.item_id)
    location = _get_location(db, payload.location_id)
    balance = _ensure_locked_balance(db, item.id, location.id)

    expected = balance.quantity
    actual = payload.actual_quantity
    difference = actual - expected

    movement_type: MovementType | None
    movement_id: int | None = None
    movement_no: str | None = None

    try:
        if difference != 0:
            movement_type = (
                MovementType.ADJUSTMENT_IN
                if difference > 0
                else MovementType.ADJUSTMENT_OUT
            )
            movement = _record_movement(
                db,
                item_id=item.id,
                location_id=location.id,
                balance=balance,
                movement_type=movement_type,
                signed_quantity=difference,
                user=user,
                reference_type="stocktake",
                reason=payload.reason,
            )
            movement_id = movement.id
            movement_no = movement.movement_no
        else:
            movement_type = None

        write_audit_log(
            db,
            user,
            "inventory.adjust",
            "stock_movement",
            movement_id,
            {
                "item_id": item.id,
                "item_code": item.item_code,
                "location_id": location.id,
                "location_code": location.location_code,
                "expected_quantity": qstr(expected),
                "actual_quantity": qstr(actual),
                "difference": qstr(difference),
                "movement_type": movement_type.value if movement_type else None,
                "movement_no": movement_no,
            },
            request,
        )
        _commit_or_conflict(db, "盘点失败：数据冲突")
        return {
            "item_id": item.id,
            "item_code": item.item_code,
            "item_name": item.name,
            "location_id": location.id,
            "location_name": location.name,
            "expected_quantity": expected,
            "actual_quantity": actual,
            "difference": difference,
            "movement_type": movement_type,
            "movement_id": movement_id,
            "balance_quantity": balance.quantity,
        }
    except (IntegrityError, OperationalError) as exc:
        db.rollback()
        if isinstance(exc, IntegrityError) and classify(exc) in (
            "unique",
            "check",
            "exclusion",
        ):
            raise _conflict("盘点失败：数据冲突") from exc
        if isinstance(exc, OperationalError) and is_transaction_conflict(exc):
            raise _conflict("盘点失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 低库存 / 总库存 / 推荐补货（Sprint 7 §19/§20/§21）
# ---------------------------------------------------------------------------


def total_stock_by_item(db: Session) -> dict[int, Decimal]:
    """Item 总库存 = SUM(active locations balances) 的口径改为：
    全部已持久化 Balance 求和（§20：已停用 Location 仍有库存时不得
    静默从总库存消失；UI 标记 location inactive）。"""
    rows = db.execute(
        select(
            InventoryBalance.item_id,
            func.coalesce(func.sum(InventoryBalance.quantity), 0),
        ).group_by(InventoryBalance.item_id)
    ).all()
    return {item_id: Decimal(quantity) for item_id, quantity in rows}


def stock_status_for(total: Decimal, minimum: Decimal) -> StockStatus:
    """低库存规则（§19）：
    total == 0 -> OUT_OF_STOCK；
    minimum > 0 且 total <= minimum -> LOW_STOCK；
    否则 NORMAL（minimum = 0 时只有 0 是 OUT_OF_STOCK，正库存保持 NORMAL）。"""
    if total <= 0:
        return StockStatus.OUT_OF_STOCK
    if minimum > 0 and total <= minimum:
        return StockStatus.LOW_STOCK
    return StockStatus.NORMAL


def recommended_replenishment(target: Decimal, total: Decimal) -> Decimal:
    """建议补货量 = max(target_stock - current_total_stock, 0)（§21，仅建议值）。"""
    return max(target - total, Decimal("0"))
