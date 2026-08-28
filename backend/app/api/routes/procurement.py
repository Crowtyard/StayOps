"""采购域路由（Sprint 7，统一前缀 /api/v1/procurement）。

权限（§35/§36，用 permission 判断，禁止硬编码角色名）：
- GET  suppliers / requests / orders              procurement:read
- POST suppliers / PATCH suppliers/{id}           procurement:supplier_manage
- POST requests / requests/{id}/submit|cancel     procurement:request
- POST requests/{id}/approve|reject               procurement:approve
- POST orders / orders/{id}/order|cancel          procurement:order
- POST orders/{id}/receipts                       procurement:receive

状态只能经专用 action 端点变更；无 generic PATCH status 通道（§25）。
无任何 DELETE 端点（§47 不物理删除）。
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import require_permissions
from app.core.pagination import paginate
from app.database import get_db
from app.models import (
    GoodsReceipt,
    GoodsReceiptLine,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    PurchaseRequest,
    PurchaseRequestLine,
    PurchaseRequestStatus,
    Supplier,
    User,
)
from app.schemas.common import Page
from app.schemas.procurement import (
    GoodsReceiptCreate,
    GoodsReceiptOut,
    PurchaseOrderCreate,
    PurchaseOrderOut,
    PurchaseRequestCreate,
    PurchaseRequestOut,
    SupplierCreate,
    SupplierOut,
    SupplierUpdate,
)
from app.services.procurement import (
    approve_request,
    build_order_out,
    build_receipt_out,
    build_request_out,
    build_supplier_out,
    cancel_order,
    cancel_request,
    create_order,
    create_request,
    create_supplier,
    mark_ordered,
    receive_goods,
    reject_request,
    submit_request,
    update_supplier,
)

router = APIRouter(prefix="/procurement", tags=["procurement"])


# ---------------------------------------------------------------------------
# Suppliers
# ---------------------------------------------------------------------------


@router.get(
    "/suppliers",
    response_model=Page[SupplierOut],
    response_model_exclude_none=True,
)
def list_suppliers(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = Query(None),
    is_active: bool | None = Query(None),
    _: User = Depends(require_permissions("procurement:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = select(Supplier).order_by(Supplier.id)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                Supplier.supplier_code.ilike(pattern),
                Supplier.name.ilike(pattern),
            )
        )
    if is_active is not None:
        stmt = stmt.where(Supplier.is_active.is_(is_active))
    result = paginate(db, stmt, page, page_size)
    result["items"] = [build_supplier_out(s) for s in result["items"]]
    return result


@router.post(
    "/suppliers",
    response_model=SupplierOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_supplier(
    payload: SupplierCreate,
    request: Request,
    current_user: User = Depends(
        require_permissions("procurement:supplier_manage")
    ),
    db: Session = Depends(get_db),
) -> SupplierOut:
    supplier = create_supplier(db, payload, current_user, request)
    return build_supplier_out(
        _get_supplier_or_404(db, supplier.id)
    )


@router.get(
    "/suppliers/{supplier_id}",
    response_model=SupplierOut,
    response_model_exclude_none=True,
)
def get_supplier(
    supplier_id: int,
    _: User = Depends(require_permissions("procurement:read")),
    db: Session = Depends(get_db),
) -> SupplierOut:
    return build_supplier_out(_get_supplier_or_404(db, supplier_id))


@router.patch(
    "/suppliers/{supplier_id}",
    response_model=SupplierOut,
    response_model_exclude_none=True,
)
def patch_supplier(
    supplier_id: int,
    payload: SupplierUpdate,
    request: Request,
    current_user: User = Depends(
        require_permissions("procurement:supplier_manage")
    ),
    db: Session = Depends(get_db),
) -> SupplierOut:
    supplier = db.scalar(
        select(Supplier).where(Supplier.id == supplier_id).with_for_update()
    )
    if supplier is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="供应商不存在"
        )
    update_supplier(db, supplier, payload, current_user, request)
    return build_supplier_out(_get_supplier_or_404(db, supplier_id))


def _get_supplier_or_404(db: Session, supplier_id: int) -> Supplier:
    supplier = db.get(Supplier, supplier_id)
    if supplier is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="供应商不存在"
        )
    return supplier


# ---------------------------------------------------------------------------
# Purchase Requests
# ---------------------------------------------------------------------------

_REQUEST_LOAD_OPTIONS = (
    selectinload(PurchaseRequest.requested_by),
    selectinload(PurchaseRequest.approved_by),
    selectinload(PurchaseRequest.lines).selectinload(PurchaseRequestLine.item),
)


def _load_request(db: Session, request_id: int) -> PurchaseRequest | None:
    return db.scalar(
        select(PurchaseRequest)
        .where(PurchaseRequest.id == request_id)
        .options(*_REQUEST_LOAD_OPTIONS)
    )


def _get_request_or_404(db: Session, request_id: int) -> PurchaseRequest:
    pr = _load_request(db, request_id)
    if pr is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="采购申请不存在"
        )
    return pr


@router.get(
    "/requests",
    response_model=Page[PurchaseRequestOut],
    response_model_exclude_none=True,
)
def list_requests(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    request_status: PurchaseRequestStatus | None = Query(None, alias="status"),
    search: str | None = Query(None),
    _: User = Depends(require_permissions("procurement:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = (
        select(PurchaseRequest)
        .options(*_REQUEST_LOAD_OPTIONS)
        .order_by(PurchaseRequest.id.desc())
    )
    if request_status is not None:
        stmt = stmt.where(PurchaseRequest.status == request_status)
    if search:
        stmt = stmt.where(
            PurchaseRequest.request_no.ilike(f"%{search}%")
        )
    result = paginate(db, stmt, page, page_size)
    result["items"] = [build_request_out(pr) for pr in result["items"]]
    return result


@router.post(
    "/requests",
    response_model=PurchaseRequestOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_request(
    payload: PurchaseRequestCreate,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:request")),
    db: Session = Depends(get_db),
) -> PurchaseRequestOut:
    pr = create_request(db, payload, current_user, request)
    return build_request_out(_get_request_or_404(db, pr.id))


@router.get(
    "/requests/{request_id}",
    response_model=PurchaseRequestOut,
    response_model_exclude_none=True,
)
def get_request(
    request_id: int,
    _: User = Depends(require_permissions("procurement:read")),
    db: Session = Depends(get_db),
) -> PurchaseRequestOut:
    return build_request_out(_get_request_or_404(db, request_id))


@router.post(
    "/requests/{request_id}/submit",
    response_model=PurchaseRequestOut,
    response_model_exclude_none=True,
)
def submit_endpoint(
    request_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:request")),
    db: Session = Depends(get_db),
) -> PurchaseRequestOut:
    pr = submit_request(db, request_id, current_user, request)
    return build_request_out(_get_request_or_404(db, pr.id))


@router.post(
    "/requests/{request_id}/approve",
    response_model=PurchaseRequestOut,
    response_model_exclude_none=True,
)
def approve_endpoint(
    request_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:approve")),
    db: Session = Depends(get_db),
) -> PurchaseRequestOut:
    pr = approve_request(db, request_id, current_user, request)
    return build_request_out(_get_request_or_404(db, pr.id))


@router.post(
    "/requests/{request_id}/reject",
    response_model=PurchaseRequestOut,
    response_model_exclude_none=True,
)
def reject_endpoint(
    request_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:approve")),
    db: Session = Depends(get_db),
) -> PurchaseRequestOut:
    pr = reject_request(db, request_id, current_user, request)
    return build_request_out(_get_request_or_404(db, pr.id))


@router.post(
    "/requests/{request_id}/cancel",
    response_model=PurchaseRequestOut,
    response_model_exclude_none=True,
)
def cancel_request_endpoint(
    request_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:request")),
    db: Session = Depends(get_db),
) -> PurchaseRequestOut:
    pr = cancel_request(db, request_id, current_user, request)
    return build_request_out(_get_request_or_404(db, pr.id))


# ---------------------------------------------------------------------------
# Purchase Orders
# ---------------------------------------------------------------------------

_ORDER_LOAD_OPTIONS = (
    selectinload(PurchaseOrder.supplier),
    selectinload(PurchaseOrder.purchase_request),
    selectinload(PurchaseOrder.lines).selectinload(PurchaseOrderLine.item),
    selectinload(PurchaseOrder.receipts)
    .selectinload(GoodsReceipt.inventory_location),
    selectinload(PurchaseOrder.receipts).selectinload(GoodsReceipt.received_by),
    selectinload(PurchaseOrder.receipts)
    .selectinload(GoodsReceipt.lines)
    .selectinload(GoodsReceiptLine.order_line)
    .selectinload(PurchaseOrderLine.item),
)


def _load_order(db: Session, order_id: int) -> PurchaseOrder | None:
    return db.scalar(
        select(PurchaseOrder)
        .where(PurchaseOrder.id == order_id)
        .options(*_ORDER_LOAD_OPTIONS)
    )


def _get_order_or_404(db: Session, order_id: int) -> PurchaseOrder:
    order = _load_order(db, order_id)
    if order is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="采购订单不存在"
        )
    return order


@router.get(
    "/orders",
    response_model=Page[PurchaseOrderOut],
    response_model_exclude_none=True,
)
def list_orders(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    order_status: PurchaseOrderStatus | None = Query(None, alias="status"),
    supplier_id: int | None = Query(None),
    search: str | None = Query(None),
    _: User = Depends(require_permissions("procurement:read")),
    db: Session = Depends(get_db),
) -> dict:
    stmt = (
        select(PurchaseOrder)
        .options(*_ORDER_LOAD_OPTIONS)
        .order_by(PurchaseOrder.id.desc())
    )
    if order_status is not None:
        stmt = stmt.where(PurchaseOrder.status == order_status)
    if supplier_id is not None:
        stmt = stmt.where(PurchaseOrder.supplier_id == supplier_id)
    if search:
        stmt = stmt.where(PurchaseOrder.order_no.ilike(f"%{search}%"))
    result = paginate(db, stmt, page, page_size)
    result["items"] = [build_order_out(o) for o in result["items"]]
    return result


@router.post(
    "/orders",
    response_model=PurchaseOrderOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_order(
    payload: PurchaseOrderCreate,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:order")),
    db: Session = Depends(get_db),
) -> PurchaseOrderOut:
    """创建 PO：purchase_request_id 提供时 = 申请转订单（同事务
    Request APPROVED -> ORDERED）；否则直接创建无申请订单。"""
    order = create_order(db, payload, current_user, request)
    return build_order_out(_get_order_or_404(db, order.id))


@router.get(
    "/orders/{order_id}",
    response_model=PurchaseOrderOut,
    response_model_exclude_none=True,
)
def get_order(
    order_id: int,
    _: User = Depends(require_permissions("procurement:read")),
    db: Session = Depends(get_db),
) -> PurchaseOrderOut:
    return build_order_out(_get_order_or_404(db, order_id))


@router.post(
    "/orders/{order_id}/order",
    response_model=PurchaseOrderOut,
    response_model_exclude_none=True,
)
def order_endpoint(
    order_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:order")),
    db: Session = Depends(get_db),
) -> PurchaseOrderOut:
    order = mark_ordered(db, order_id, current_user, request)
    return build_order_out(_get_order_or_404(db, order.id))


@router.post(
    "/orders/{order_id}/cancel",
    response_model=PurchaseOrderOut,
    response_model_exclude_none=True,
)
def cancel_order_endpoint(
    order_id: int,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:order")),
    db: Session = Depends(get_db),
) -> PurchaseOrderOut:
    order = cancel_order(db, order_id, current_user, request)
    return build_order_out(_get_order_or_404(db, order.id))


@router.post(
    "/orders/{order_id}/receipts",
    response_model=GoodsReceiptOut,
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_none=True,
)
def post_receipt(
    order_id: int,
    payload: GoodsReceiptCreate,
    request: Request,
    current_user: User = Depends(require_permissions("procurement:receive")),
    db: Session = Depends(get_db),
) -> dict:
    """收货（§29/§30/§31）：支持部分收货；任一行超收整体回滚（409）。"""
    receipt = receive_goods(db, order_id, payload, current_user, request)
    receipt = db.scalar(
        select(GoodsReceipt)
        .options(
            selectinload(GoodsReceipt.inventory_location),
            selectinload(GoodsReceipt.received_by),
            selectinload(GoodsReceipt.lines)
            .selectinload(GoodsReceiptLine.order_line)
            .selectinload(PurchaseOrderLine.item),
        )
        .where(GoodsReceipt.id == receipt.id)
    )
    if receipt is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="收货单不存在"
        )
    return build_receipt_out(receipt)
