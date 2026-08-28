"""采购域服务层（Sprint 7）。

状态机（后端唯一权威；不允许 generic PATCH status 绕过）：
    PurchaseRequest:  DRAFT -> SUBMITTED -> APPROVED -> ORDERED
                      SUBMITTED -> REJECTED（终态）
                      APPROVED -> CANCELLED / DRAFT -> CANCELLED
    PurchaseOrder:    DRAFT -> ORDERED -> PARTIALLY_RECEIVED -> RECEIVED
                      DRAFT / ORDERED / PARTIALLY_RECEIVED -> CANCELLED
                      RECEIVED 为终态不可取消

关键语义：
- Purchase Request -> Purchase Order（§28）：Approved Request 转 PO 成功后
  PurchaseRequest APPROVED -> ORDERED 同事务；一张 Request 至多一张 PO
  （purchase_orders.purchase_request_id UNIQUE 数据库最终仲裁 +
  Request 行 FOR UPDATE 串行化）。
- PO 不改变库存（§33）：DRAFT / ORDERED PO 均不产生任何
  StockMovement / InventoryBalance 变化。
- 只有 Goods Receipt 创建 PURCHASE_RECEIPT movement 并增加库存（§29/§30）。
- 部分收货（§31）：cumulative received <= ordered；PO 状态由收货推导。
- PARTIALLY_RECEIVED -> CANCELLED（§27）：允许代表「不再收剩余数量」，
  已收货库存与历史保持；不允许删除历史 Goods Receipt。

锁顺序（Lock Graph，Sprint 7 §48）：
    Goods Receipt: PurchaseOrder row -> PO lines (id asc)
                   -> InventoryBalance ((item_id, location_id) asc)
    Request -> PO: PurchaseRequest row（无 Balance 参与）
    与 Inventory 域（只锁 Balance）全局无环。
"""

from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.business_date import business_date, property_now
from app.core.db_conflict import classify, is_transaction_conflict
from app.models import (
    GoodsReceipt,
    GoodsReceiptLine,
    InventoryBalance,
    InventoryItem,
    InventoryLocation,
    MovementType,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    PurchaseRequest,
    PurchaseRequestLine,
    PurchaseRequestStatus,
    StockMovement,
    Supplier,
    User,
)
from app.schemas.procurement import (
    GoodsReceiptCreate,
    PurchaseOrderCreate,
    PurchaseRequestCreate,
    SupplierCreate,
    SupplierUpdate,
)
from app.services.inventory import (
    _ensure_locked_balance,
    next_movement_no,
    qstr,
)

REQUEST_NO_SEQ = "purchase_request_no_seq"
ORDER_NO_SEQ = "purchase_order_no_seq"
RECEIPT_NO_SEQ = "goods_receipt_no_seq"


def _conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail
    )


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def next_request_no(db: Session) -> str:
    """格式 PRQ{YYYYMMDD}-{NNNN}。"""
    value = db.scalar(text(f"SELECT nextval('{REQUEST_NO_SEQ}')"))
    return f"PRQ{business_date():%Y%m%d}-{value:04d}"


def next_order_no(db: Session) -> str:
    """格式 PO{YYYYMMDD}-{NNNN}。"""
    value = db.scalar(text(f"SELECT nextval('{ORDER_NO_SEQ}')"))
    return f"PO{business_date():%Y%m%d}-{value:04d}"


def next_receipt_no(db: Session) -> str:
    """格式 GR{YYYYMMDD}-{NNNN}。"""
    value = db.scalar(text(f"SELECT nextval('{RECEIPT_NO_SEQ}')"))
    return f"GR{business_date():%Y%m%d}-{value:04d}"


def _commit_or_conflict(db: Session, generic_detail: str) -> None:
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


def _load_items(db: Session, item_ids: list[int]) -> dict[int, InventoryItem]:
    items = db.scalars(
        select(InventoryItem).where(InventoryItem.id.in_(item_ids))
    ).all()
    by_id = {item.id: item for item in items}
    missing = [i for i in item_ids if i not in by_id]
    if missing:
        raise _unprocessable("存在不存在的物资 item_id")
    return by_id


def _user_name(user: User | None) -> str | None:
    if user is None:
        return None
    return user.display_name or user.username


# ---------------------------------------------------------------------------
# Supplier
# ---------------------------------------------------------------------------


def create_supplier(
    db: Session,
    payload: SupplierCreate,
    user: User | None,
    request=None,
) -> Supplier:
    supplier = Supplier(
        supplier_code=payload.supplier_code,
        name=payload.name,
        contact_name=payload.contact_name,
        phone=payload.phone,
        wechat=payload.wechat,
        notes=payload.notes,
    )
    db.add(supplier)
    try:
        db.flush()
        # 审计不含 phone / wechat / notes 自由文本（Sprint 7 §37）
        write_audit_log(
            db,
            user,
            "supplier.create",
            "supplier",
            supplier.id,
            {"supplier_code": supplier.supplier_code, "name": supplier.name},
            request,
        )
        _commit_or_conflict(db, "供应商代码已存在")
        return supplier
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("供应商代码已存在") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("供应商创建失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def update_supplier(
    db: Session,
    supplier: Supplier,
    payload: SupplierUpdate,
    user: User | None,
    request=None,
) -> Supplier:
    changes: list[str] = []
    for field in ("name", "contact_name", "phone", "wechat", "notes"):
        if field in payload.model_fields_set:
            new_value = getattr(payload, field)
            if new_value != getattr(supplier, field):
                changes.append(field)
                setattr(supplier, field, new_value)
    if "is_active" in payload.model_fields_set and payload.is_active is not None:
        if payload.is_active != supplier.is_active:
            changes.append(f"is_active:{supplier.is_active}->{payload.is_active}")
            supplier.is_active = payload.is_active

    if not changes:
        return supplier

    try:
        db.flush()
        # 审计只记字段名，不复制 phone / notes 等自由文本内容
        write_audit_log(
            db,
            user,
            "supplier.update",
            "supplier",
            supplier.id,
            {"supplier_code": supplier.supplier_code, "changed": changes},
            request,
        )
        _commit_or_conflict(db, "供应商修改失败：数据冲突")
        return supplier
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("供应商修改失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("供应商修改失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# Purchase Request
# ---------------------------------------------------------------------------


def create_request(
    db: Session,
    payload: PurchaseRequestCreate,
    user: User | None,
    request=None,
) -> PurchaseRequest:
    items = _load_items(db, [line.item_id for line in payload.lines])

    pr = PurchaseRequest(
        request_no=next_request_no(db),
        status=PurchaseRequestStatus.DRAFT,
        requested_by_user_id=user.id if user is not None else None,
        notes=payload.notes,
    )
    db.add(pr)
    db.flush()
    for line in payload.lines:
        db.add(
            PurchaseRequestLine(
                request_id=pr.id,
                item_id=line.item_id,
                quantity=line.quantity,
                notes=line.notes,
            )
        )

    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "purchase_request.create",
            "purchase_request",
            pr.id,
            {
                "request_no": pr.request_no,
                "status": pr.status.value,
                "lines": [
                    {
                        "item_id": line.item_id,
                        "item_code": items[line.item_id].item_code,
                        "quantity": qstr(line.quantity),
                    }
                    for line in payload.lines
                ],
            },
            request,
        )
        _commit_or_conflict(db, "采购申请创建失败：数据冲突")
        return pr
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("采购申请创建失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("采购申请创建失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def _lock_request(db: Session, request_id: int) -> PurchaseRequest:
    pr = db.scalar(
        select(PurchaseRequest)
        .where(PurchaseRequest.id == request_id)
        .with_for_update()
    )
    if pr is None:
        raise _not_found("采购申请不存在")
    return pr


def _transition_request(
    db: Session,
    pr: PurchaseRequest,
    target: PurchaseRequestStatus,
    *,
    allowed: tuple[PurchaseRequestStatus, ...],
    user: User | None,
    request,
    action: str,
    invalid_detail: str,
) -> PurchaseRequest:
    """通用状态转换（submit / approve / reject / cancel），调用前已锁定。"""
    if pr.status not in allowed:
        raise _conflict(invalid_detail)

    previous = pr.status
    pr.status = target
    now = property_now()
    if target == PurchaseRequestStatus.SUBMITTED:
        pr.submitted_at = now
    elif target == PurchaseRequestStatus.APPROVED:
        pr.approved_at = now
        pr.approved_by_user_id = user.id if user is not None else None
    elif target == PurchaseRequestStatus.REJECTED:
        pr.rejected_at = now
    elif target == PurchaseRequestStatus.CANCELLED:
        pr.cancelled_at = now

    try:
        db.flush()
        write_audit_log(
            db,
            user,
            action,
            "purchase_request",
            pr.id,
            {
                "request_no": pr.request_no,
                "from": previous.value,
                "to": target.value,
            },
            request,
        )
        _commit_or_conflict(db, "采购申请状态变更失败：数据冲突")
        return pr
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("采购申请状态变更失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("采购申请状态变更失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def submit_request(
    db: Session, request_id: int, user: User | None, request=None
) -> PurchaseRequest:
    pr = _lock_request(db, request_id)
    return _transition_request(
        db,
        pr,
        PurchaseRequestStatus.SUBMITTED,
        allowed=(PurchaseRequestStatus.DRAFT,),
        user=user,
        request=request,
        action="purchase_request.submit",
        invalid_detail="仅草稿状态的采购申请可提交",
    )


def approve_request(
    db: Session, request_id: int, user: User | None, request=None
) -> PurchaseRequest:
    pr = _lock_request(db, request_id)
    return _transition_request(
        db,
        pr,
        PurchaseRequestStatus.APPROVED,
        allowed=(PurchaseRequestStatus.SUBMITTED,),
        user=user,
        request=request,
        action="purchase_request.approve",
        invalid_detail="仅已提交的采购申请可审批通过",
    )


def reject_request(
    db: Session, request_id: int, user: User | None, request=None
) -> PurchaseRequest:
    pr = _lock_request(db, request_id)
    return _transition_request(
        db,
        pr,
        PurchaseRequestStatus.REJECTED,
        allowed=(PurchaseRequestStatus.SUBMITTED,),
        user=user,
        request=request,
        action="purchase_request.reject",
        invalid_detail="仅已提交的采购申请可驳回",
    )


def cancel_request(
    db: Session, request_id: int, user: User | None, request=None
) -> PurchaseRequest:
    pr = _lock_request(db, request_id)
    return _transition_request(
        db,
        pr,
        PurchaseRequestStatus.CANCELLED,
        allowed=(
            PurchaseRequestStatus.DRAFT,
            PurchaseRequestStatus.APPROVED,
        ),
        user=user,
        request=request,
        action="purchase_request.cancel",
        invalid_detail="仅草稿或已批准的采购申请可取消",
    )


# ---------------------------------------------------------------------------
# Purchase Order
# ---------------------------------------------------------------------------


def _line_total(line: PurchaseOrderLine) -> Decimal | None:
    if line.unit_price is None:
        return None
    return (line.unit_price * line.ordered_quantity).quantize(Decimal("0.01"))


def order_total(lines: list[PurchaseOrderLine]) -> Decimal:
    total = Decimal("0")
    for line in lines:
        value = _line_total(line)
        if value is not None:
            total += value
    return total


def _lock_order(db: Session, order_id: int) -> PurchaseOrder:
    order = db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == order_id)
        .with_for_update()
    )
    if order is None:
        raise _not_found("采购订单不存在")
    return order


def create_order(
    db: Session,
    payload: PurchaseOrderCreate,
    user: User | None,
    request=None,
) -> PurchaseOrder:
    """创建 PO（§28）。

    - 由采购申请转订单：锁定 Request 行 -> 校验 APPROVED -> 创建 PO（DRAFT）
      + 复制 lines -> Request APPROVED -> ORDERED 同事务。
      并发重复转换由 Request 行锁串行化（第二次读到 ORDERED -> 409），
      purchase_orders.purchase_request_id UNIQUE 数据库最终仲裁。
    - 直接创建（无申请）：仅 procurement:order（SUPER_ADMIN / MANAGER）。
    """
    supplier = db.get(Supplier, payload.supplier_id)
    if supplier is None:
        raise _unprocessable("供应商不存在")

    from_request: PurchaseRequest | None = None
    if payload.purchase_request_id is not None:
        from_request = _lock_request(db, payload.purchase_request_id)
        if from_request.status != PurchaseRequestStatus.APPROVED:
            raise _conflict("仅已批准的采购申请可转为采购订单")

    order = PurchaseOrder(
        order_no=next_order_no(db),
        supplier_id=supplier.id,
        purchase_request_id=from_request.id if from_request is not None else None,
        status=PurchaseOrderStatus.DRAFT,
        created_by_user_id=user.id if user is not None else None,
        notes=payload.notes,
    )
    db.add(order)
    db.flush()

    if from_request is not None:
        lines = db.scalars(
            select(PurchaseRequestLine)
            .where(PurchaseRequestLine.request_id == from_request.id)
            .order_by(PurchaseRequestLine.id)
        ).all()
        line_count = len(lines)
        for line in lines:
            db.add(
                PurchaseOrderLine(
                    order_id=order.id,
                    item_id=line.item_id,
                    ordered_quantity=line.quantity,
                    received_quantity=Decimal("0"),
                    unit_price=None,
                )
            )
    else:
        items = _load_items(db, [line.item_id for line in payload.lines or []])
        line_count = len(payload.lines or [])
        for line in payload.lines or []:
            db.add(
                PurchaseOrderLine(
                    order_id=order.id,
                    item_id=line.item_id,
                    ordered_quantity=line.ordered_quantity,
                    received_quantity=Decimal("0"),
                    unit_price=line.unit_price,
                )
            )

    try:
        if from_request is not None:
            # APPROVED -> ORDERED 同事务（§28）
            from_request.status = PurchaseRequestStatus.ORDERED
        db.flush()
        details: dict = {
            "order_no": order.order_no,
            "supplier_code": supplier.supplier_code,
            "status": order.status.value,
            "line_count": line_count,
        }
        if from_request is not None:
            details.update(
                {
                    "from_request_no": from_request.request_no,
                    "request_transition": "APPROVED->ORDERED",
                }
            )
        write_audit_log(
            db,
            user,
            "purchase_order.create",
            "purchase_order",
            order.id,
            details,
            request,
        )
        _commit_or_conflict(db, "采购订单创建失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) == "unique":
            raise _conflict("该采购申请已转为采购订单") from exc
        if classify(exc) == "check":
            raise _conflict("采购订单创建失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("采购订单创建失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


def mark_ordered(
    db: Session, order_id: int, user: User | None, request=None
) -> PurchaseOrder:
    """下达订单（DRAFT -> ORDERED）。不产生任何库存变化（§33）。"""
    order = _lock_order(db, order_id)
    if order.status != PurchaseOrderStatus.DRAFT:
        raise _conflict("仅草稿状态的采购订单可下达")

    order.status = PurchaseOrderStatus.ORDERED
    order.ordered_at = property_now()

    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "purchase_order.order",
            "purchase_order",
            order.id,
            {
                "order_no": order.order_no,
                "from": PurchaseOrderStatus.DRAFT.value,
                "to": PurchaseOrderStatus.ORDERED.value,
            },
            request,
        )
        _commit_or_conflict(db, "订单下达失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("订单下达失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("订单下达失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


_CANCELLABLE_ORDER_STATUSES = (
    PurchaseOrderStatus.DRAFT,
    PurchaseOrderStatus.ORDERED,
    PurchaseOrderStatus.PARTIALLY_RECEIVED,
)


def cancel_order(
    db: Session, order_id: int, user: User | None, request=None
) -> PurchaseOrder:
    """取消订单（§27）。

    DRAFT / ORDERED / PARTIALLY_RECEIVED -> CANCELLED；
    PARTIALLY_RECEIVED 取消 = 不再收剩余数量，已收货库存与历史保持；
    RECEIVED 为终态不可取消。
    """
    order = _lock_order(db, order_id)
    if order.status not in _CANCELLABLE_ORDER_STATUSES:
        raise _conflict("仅未完成收货的采购订单可取消")

    previous = order.status
    order.status = PurchaseOrderStatus.CANCELLED
    order.cancelled_at = property_now()

    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "purchase_order.cancel",
            "purchase_order",
            order.id,
            {
                "order_no": order.order_no,
                "from": previous.value,
                "to": PurchaseOrderStatus.CANCELLED.value,
            },
            request,
        )
        _commit_or_conflict(db, "订单取消失败：数据冲突")
        return order
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check"):
            raise _conflict("订单取消失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("订单取消失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# Goods Receipt（收货才是库存增加权威，§29/§30/§31/§32）
# ---------------------------------------------------------------------------


_RECEIVABLE_ORDER_STATUSES = (
    PurchaseOrderStatus.ORDERED,
    PurchaseOrderStatus.PARTIALLY_RECEIVED,
)


def receive_goods(
    db: Session,
    order_id: int,
    payload: GoodsReceiptCreate,
    user: User | None,
    request=None,
) -> GoodsReceipt:
    """收货事务（§30，全原子）。

    锁顺序：PurchaseOrder row -> PO lines (id asc) -> InventoryBalance
    ((item_id, location_id) asc) -> movements。任一行超收：entire rollback。
    并发两个收货同时收剩余数量：PO 行锁串行化，后到者重校验后
    409（剩余不足或订单已 RECEIVED），最终 received 绝不超过 ordered。
    """
    location = db.get(InventoryLocation, payload.inventory_location_id)
    if location is None:
        raise _unprocessable("库存地点不存在")

    order = _lock_order(db, order_id)
    if order.status not in _RECEIVABLE_ORDER_STATUSES:
        if order.status == PurchaseOrderStatus.DRAFT:
            raise _conflict("仅已下达的采购订单可收货")
        if order.status == PurchaseOrderStatus.RECEIVED:
            raise _conflict("该订单已全部收货")
        raise _conflict("已取消的采购订单不可收货")

    # 锁 PO lines（id 升序，确定性）
    lines = db.scalars(
        select(PurchaseOrderLine)
        .where(PurchaseOrderLine.order_id == order.id)
        .order_by(PurchaseOrderLine.id)
        .with_for_update()
    ).all()
    lines_by_id = {line.id: line for line in lines}

    items = _load_items(db, [line.item_id for line in lines])

    # 校验所有收货行（任一非法/超收 -> 409，整体回滚）
    for entry in payload.lines:
        line = lines_by_id.get(entry.purchase_order_line_id)
        if line is None:
            raise _unprocessable("收货行不属于该采购订单")
        remaining = line.ordered_quantity - line.received_quantity
        if entry.received_quantity > remaining:
            raise _conflict(
                f"收货数量超出剩余可收数量：{items[line.item_id].item_code} "
                f"剩余 {remaining}，本次收货 {entry.received_quantity}"
            )

    # 锁 / 创建 Balance（(item_id, location_id) 升序）
    pairs = sorted(
        (line.item_id, location.id)
        for entry in payload.lines
        for line in [lines_by_id[entry.purchase_order_line_id]]
    )
    balances: dict[tuple[int, int], InventoryBalance] = {}
    for pair in pairs:
        balances[pair] = _ensure_locked_balance(db, pair[0], pair[1])

    receipt = GoodsReceipt(
        receipt_no=next_receipt_no(db),
        purchase_order_id=order.id,
        inventory_location_id=location.id,
        received_by_user_id=user.id if user is not None else None,
        received_at=property_now(),
        notes=payload.notes,
    )
    db.add(receipt)
    db.flush()

    movement_ids: list[int] = []
    line_audit: list[dict] = []
    for entry in payload.lines:
        line = lines_by_id[entry.purchase_order_line_id]
        db.add(
            GoodsReceiptLine(
                receipt_id=receipt.id,
                purchase_order_line_id=line.id,
                received_quantity=entry.received_quantity,
            )
        )
        line.received_quantity += entry.received_quantity
        movement = StockMovement(
            movement_no=next_movement_no(db),
            item_id=line.item_id,
            location_id=location.id,
            movement_type=MovementType.PURCHASE_RECEIPT,
            quantity=entry.received_quantity,
            reference_type="goods_receipt",
            reference_id=receipt.id,
            reason=None,
            created_by_user_id=user.id if user is not None else None,
        )
        db.add(movement)
        balance = balances[(line.item_id, location.id)]
        balance.quantity += entry.received_quantity
        db.flush()
        movement_ids.append(movement.id)
        item = items[line.item_id]
        line_audit.append(
            {
                "item_id": item.id,
                "item_code": item.item_code,
                "quantity": qstr(entry.received_quantity),
            }
        )

    # PO 状态由收货推导：全部收满 -> RECEIVED，否则 PARTIALLY_RECEIVED
    previous_status = order.status
    all_received = all(
        line.received_quantity >= line.ordered_quantity for line in lines
    )
    if all_received:
        order.status = PurchaseOrderStatus.RECEIVED
    else:
        order.status = PurchaseOrderStatus.PARTIALLY_RECEIVED

    try:
        db.flush()
        write_audit_log(
            db,
            user,
            "goods_receipt.receive",
            "goods_receipt",
            receipt.id,
            {
                "receipt_no": receipt.receipt_no,
                "order_no": order.order_no,
                "order_status": f"{previous_status.value}->{order.status.value}",
                "inventory_location_id": location.id,
                "inventory_location_code": location.location_code,
                "lines": line_audit,
                "movement_ids": movement_ids,
            },
            request,
        )
        _commit_or_conflict(db, "收货失败：数据冲突")
        return receipt
    except IntegrityError as exc:
        db.rollback()
        if classify(exc) in ("unique", "check", "exclusion"):
            raise _conflict("收货失败：数据冲突") from exc
        raise
    except OperationalError as exc:
        db.rollback()
        if is_transaction_conflict(exc):
            raise _conflict("收货失败：数据冲突") from exc
        raise
    except HTTPException:
        db.rollback()
        raise


# ---------------------------------------------------------------------------
# 序列化
# ---------------------------------------------------------------------------


def build_supplier_out(supplier: Supplier) -> dict:
    return {
        "id": supplier.id,
        "supplier_code": supplier.supplier_code,
        "name": supplier.name,
        "contact_name": supplier.contact_name,
        "phone": supplier.phone,
        "wechat": supplier.wechat,
        "notes": supplier.notes,
        "is_active": supplier.is_active,
        "created_at": supplier.created_at,
        "updated_at": supplier.updated_at,
    }


def _build_request_lines(lines: list[PurchaseRequestLine]) -> list[dict]:
    result = []
    for line in lines:
        item = line.item
        result.append(
            {
                "id": line.id,
                "item_id": line.item_id,
                "item_code": item.item_code if item is not None else None,
                "item_name": item.name if item is not None else None,
                "base_unit": item.base_unit if item is not None else None,
                "quantity": line.quantity,
                "notes": line.notes,
            }
        )
    return result


def build_request_out(pr: PurchaseRequest) -> dict:
    return {
        "id": pr.id,
        "request_no": pr.request_no,
        "status": pr.status,
        "requested_by_user_id": pr.requested_by_user_id,
        "requester_name": _user_name(pr.requested_by),
        "approved_by_user_id": pr.approved_by_user_id,
        "approved_by_name": _user_name(pr.approved_by),
        "submitted_at": pr.submitted_at,
        "approved_at": pr.approved_at,
        "rejected_at": pr.rejected_at,
        "cancelled_at": pr.cancelled_at,
        "notes": pr.notes,
        "created_at": pr.created_at,
        "updated_at": pr.updated_at,
        "lines": _build_request_lines(pr.lines),
    }


def _build_order_lines(lines: list[PurchaseOrderLine]) -> list[dict]:
    result = []
    for line in lines:
        item = line.item
        result.append(
            {
                "id": line.id,
                "item_id": line.item_id,
                "item_code": item.item_code if item is not None else None,
                "item_name": item.name if item is not None else None,
                "base_unit": item.base_unit if item is not None else None,
                "ordered_quantity": line.ordered_quantity,
                "received_quantity": line.received_quantity,
                "remaining_quantity": line.ordered_quantity
                - line.received_quantity,
                "unit_price": line.unit_price,
                "line_total": _line_total(line),
            }
        )
    return result


def build_receipt_out(receipt: GoodsReceipt) -> dict:
    lines: list[dict] = []
    for line in receipt.lines:
        order_line = line.order_line
        item = order_line.item if order_line is not None else None
        lines.append(
            {
                "id": line.id,
                "purchase_order_line_id": line.purchase_order_line_id,
                "item_id": order_line.item_id if order_line is not None else None,
                "item_code": item.item_code if item is not None else None,
                "item_name": item.name if item is not None else None,
                "base_unit": item.base_unit if item is not None else None,
                "received_quantity": line.received_quantity,
            }
        )
    return {
        "id": receipt.id,
        "receipt_no": receipt.receipt_no,
        "purchase_order_id": receipt.purchase_order_id,
        "inventory_location_id": receipt.inventory_location_id,
        "inventory_location_name": (
            receipt.inventory_location.name
            if receipt.inventory_location is not None
            else None
        ),
        "received_by_user_id": receipt.received_by_user_id,
        "receiver_name": _user_name(receipt.received_by),
        "received_at": receipt.received_at,
        "notes": receipt.notes,
        "created_at": receipt.created_at,
        "lines": lines,
    }


def build_order_out(order: PurchaseOrder) -> dict:
    supplier = order.supplier
    return {
        "id": order.id,
        "order_no": order.order_no,
        "supplier_id": order.supplier_id,
        "supplier_code": supplier.supplier_code if supplier is not None else None,
        "supplier_name": supplier.name if supplier is not None else None,
        "purchase_request_id": order.purchase_request_id,
        "request_no": (
            order.purchase_request.request_no
            if order.purchase_request is not None
            else None
        ),
        "status": order.status,
        "ordered_at": order.ordered_at,
        "cancelled_at": order.cancelled_at,
        "created_by_user_id": order.created_by_user_id,
        "notes": order.notes,
        "created_at": order.created_at,
        "updated_at": order.updated_at,
        "order_total": order_total(order.lines),
        "lines": _build_order_lines(order.lines),
        "receipts": [build_receipt_out(r) for r in order.receipts],
    }
