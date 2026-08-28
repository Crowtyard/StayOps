# -*- coding: utf-8 -*-
"""S7 P0 并发测试（Sprint 7 §14/§17/§32/§48/§49）。

真实 PostgreSQL 并发（两线程 + 独立 SessionLocal 真实提交，不经 conftest
外层事务），repeated stress：
- Issue vs Issue（同 Balance 库存不足竞争）：one success + one 409，final=2
- Transfer vs Issue（同 Source Balance）：无负库存、无丢失更新、无死锁逃逸
- Stocktake vs Issue（同 Balance）：无负库存、ledger == balance
- Receipt vs Receipt（同 PO 剩余数量）：one success + one 409，final received=100
- Receipt vs Issue / Receipt vs Transfer（同目标 Balance）
- Request -> PO vs Request -> PO（同 APPROVED 申请）：exactly one PO

报告：rounds / successes / expected 409s / unexpected errors / deadlocks。
unexpected 500 = 0（任何一轮出现 ERROR 即失败）。
"""

import threading
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import delete, select

from app.database import SessionLocal
from app.models import (
    GoodsReceipt,
    GoodsReceiptLine,
    InventoryBalance,
    InventoryItem,
    InventoryLocation,
    IssueDestinationType,
    MovementType,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseRequest,
    PurchaseRequestLine,
    PurchaseRequestStatus,
    StockIssue,
    StockIssueLine,
    StockMovement,
    Supplier,
)
from app.schemas.inventory import (
    IssueLineIn,
    StockIssueCreate,
    StocktakeCreate,
    StockTransferCreate,
    TransferLineIn,
)
from app.schemas.procurement import (
    GoodsReceiptCreate,
    GoodsReceiptLineIn,
    PurchaseOrderCreate,
)
from app.services import inventory as inventory_service
from app.services import procurement as procurement_service

STRESS_ROUNDS = 10


def _capture(fn, results: list, lock: threading.Lock) -> None:
    try:
        fn()
        with lock:
            results.append(("SUCCESS", None))
    except HTTPException as exc:
        with lock:
            results.append((f"CONFLICT:{exc.status_code}", exc.detail))
    except Exception as exc:  # noqa: BLE001
        with lock:
            results.append((f"ERROR:{type(exc).__name__}", str(exc)))


def _run_threads(targets: list, timeout: float = 90) -> None:
    threads = [threading.Thread(target=t) for t in targets]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=timeout)
        assert not thread.is_alive(), "线程未在限时内结束"


def _stress_report(
    scenario: str, rounds: int, results_per_round: list[list]
) -> None:
    successes = 0
    conflicts = 0
    errors = 0
    deadlocks = 0
    for results in results_per_round:
        for status, detail in results:
            if status == "SUCCESS":
                successes += 1
            elif status == "CONFLICT:409":
                conflicts += 1
            elif status.startswith("ERROR:"):
                errors += 1
                if "DeadlockDetected" in status or "deadlock" in str(
                    detail
                ).lower():
                    deadlocks += 1
    print(
        f"[S7-STRESS] {scenario}: rounds={rounds} successes={successes} "
        f"expected_409s={conflicts} unexpected_errors={errors} "
        f"deadlocks={deadlocks}"
    )
    assert errors == 0, (
        f"{scenario}: 出现未预期错误（500 等价），results={results_per_round}"
    )
    assert deadlocks == 0, f"{scenario}: 出现死锁逃逸"


# ---------------------------------------------------------------------------
# 场景准备（直接 ORM 真实提交，与 test_room_move_concurrency 同风格）
# ---------------------------------------------------------------------------


def _location(session, code: str) -> InventoryLocation:
    return session.scalar(
        select(InventoryLocation).where(
            InventoryLocation.location_code == code
        )
    )


def _make_item(session, code: str) -> int:
    item = InventoryItem(
        item_code=code, name=f"并发物资{code}", category="OTHER",
        base_unit="个",
    )
    session.add(item)
    session.flush()
    return item.id


def _set_stock(session, item_id: int, location_id: int, quantity: str) -> None:
    """直接建立 INITIAL movement + balance（并发场景的确定性起始状态）。"""
    balance = session.scalar(
        select(InventoryBalance).where(
            InventoryBalance.item_id == item_id,
            InventoryBalance.location_id == location_id,
        )
    )
    if balance is None:
        balance = InventoryBalance(
            item_id=item_id, location_id=location_id, quantity=Decimal("0")
        )
        session.add(balance)
        session.flush()
    balance.quantity += Decimal(quantity)
    session.add(
        StockMovement(
            movement_no=f"SMVCONC-{item_id}-{location_id}",
            item_id=item_id,
            location_id=location_id,
            movement_type=MovementType.INITIAL,
            quantity=Decimal(quantity),
        )
    )
    session.flush()


def _make_supplier(session, code: str) -> int:
    supplier = Supplier(supplier_code=code, name=f"并发供应商{code}")
    session.add(supplier)
    session.flush()
    return supplier.id


def _make_ordered_po(
    session,
    supplier_id: int,
    item_id: int,
    ordered: str,
    received: str = "0",
) -> tuple[int, int]:
    """直接建立 ORDERED PO + 行（含已收货数量），返回 (order_id, line_id)。"""
    order = PurchaseOrder(
        order_no=f"POCONC-{item_id}", supplier_id=supplier_id,
        status="ORDERED",
    )
    session.add(order)
    session.flush()
    line = PurchaseOrderLine(
        order_id=order.id, item_id=item_id,
        ordered_quantity=Decimal(ordered),
        received_quantity=Decimal(received),
    )
    session.add(line)
    session.flush()
    return order.id, line.id


def _make_approved_request(session, item_id: int) -> int:
    pr = PurchaseRequest(
        request_no=f"PRQCONC-{item_id}",
        status=PurchaseRequestStatus.APPROVED,
    )
    session.add(pr)
    session.flush()
    session.add(
        PurchaseRequestLine(
            request_id=pr.id, item_id=item_id, quantity=Decimal("10")
        )
    )
    session.flush()
    return pr.id


def _cleanup(
    session,
    *,
    item_ids: list[int],
    supplier_ids: list[int],
    order_ids: list[int],
    request_ids: list[int],
) -> None:
    for order_id in order_ids:
        session.execute(
            delete(GoodsReceiptLine).where(
                GoodsReceiptLine.receipt_id.in_(
                    select(GoodsReceipt.id).where(
                        GoodsReceipt.purchase_order_id == order_id
                    )
                )
            )
        )
        session.execute(
            delete(GoodsReceipt).where(
                GoodsReceipt.purchase_order_id == order_id
            )
        )
        session.execute(
            delete(PurchaseOrderLine).where(
                PurchaseOrderLine.order_id == order_id
            )
        )
    session.execute(delete(PurchaseOrder).where(PurchaseOrder.id.in_(order_ids)))
    for request_id in request_ids:
        session.execute(
            delete(PurchaseRequestLine).where(
                PurchaseRequestLine.request_id == request_id
            )
        )
    session.execute(
        delete(PurchaseRequest).where(PurchaseRequest.id.in_(request_ids))
    )
    session.execute(delete(Supplier).where(Supplier.id.in_(supplier_ids)))
    # 领用单：先删本场景物资的行，再删无行的领用单头
    session.execute(
        delete(StockIssueLine).where(StockIssueLine.item_id.in_(item_ids))
    )
    session.execute(
        delete(StockIssue).where(
            ~StockIssue.id.in_(select(StockIssueLine.issue_id))
        )
    )
    session.execute(
        delete(StockMovement).where(StockMovement.item_id.in_(item_ids))
    )
    session.execute(
        delete(InventoryBalance).where(InventoryBalance.item_id.in_(item_ids))
    )
    session.execute(delete(InventoryItem).where(InventoryItem.id.in_(item_ids)))
    session.commit()


def _balance(session, item_id: int, location_id: int) -> Decimal:
    value = session.scalar(
        select(InventoryBalance.quantity).where(
            InventoryBalance.item_id == item_id,
            InventoryBalance.location_id == location_id,
        )
    )
    return Decimal(value) if value is not None else Decimal("0")


def _ledger(session, item_id: int, location_id: int) -> Decimal:
    from sqlalchemy import func

    value = session.scalar(
        select(func.coalesce(func.sum(StockMovement.quantity), 0)).where(
            StockMovement.item_id == item_id,
            StockMovement.location_id == location_id,
        )
    )
    return Decimal(value)


# ---------------------------------------------------------------------------
# P0-1：Issue vs Issue（Sprint 7 §14）
# ---------------------------------------------------------------------------


def test_concurrent_issue_vs_issue(_database):
    results_per_round: list[list] = []
    all_items: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            main = _location(setup, "MAIN_STORAGE")
            item_id = _make_item(setup, f"CONC-ISSUE-{idx}")
            _set_stock(setup, item_id, main.id, "10")
            setup.commit()
            main_id = main.id
            all_items.append(item_id)
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def worker(quantity: str):
            session = SessionLocal()
            try:
                _capture(
                    lambda: inventory_service.create_issue(
                        session,
                        StockIssueCreate(
                            source_location_id=main_id,
                            destination_type=IssueDestinationType.OTHER,
                            lines=[IssueLineIn(
                                item_id=item_id, quantity=Decimal(quantity)
                            )],
                        ),
                        None,
                        None,
                    ),
                    results,
                    lock,
                )
            finally:
                session.close()

        _run_threads([lambda: worker("8"), lambda: worker("8")])

        statuses = sorted(r[0] for r in results)
        assert statuses == ["CONFLICT:409", "SUCCESS"], (
            f"round {idx}: {results}"
        )
        results_per_round.append(results)

        verify = SessionLocal()
        try:
            final = _balance(verify, item_id, main_id)
            assert final == Decimal("2.00"), (
                f"final balance must be 2, got {final}（不允许 -6）"
            )
            assert _ledger(verify, item_id, main_id) == final
        finally:
            verify.close()

    _stress_report("issue-vs-issue", STRESS_ROUNDS, results_per_round)

    cleanup = SessionLocal()
    try:
        _cleanup(
            cleanup, item_ids=all_items,
            supplier_ids=[], order_ids=[], request_ids=[],
        )
    finally:
        cleanup.close()


# ---------------------------------------------------------------------------
# P0-2：Transfer vs Issue（同 Source Balance，Sprint 7 §17）
# ---------------------------------------------------------------------------


def test_concurrent_transfer_vs_issue(_database):
    results_per_round: list[list] = []
    all_items: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            main = _location(setup, "MAIN_STORAGE")
            front = _location(setup, "FRONT_DESK")
            item_id = _make_item(setup, f"CONC-TRI-{idx}")
            _set_stock(setup, item_id, main.id, "10")
            setup.commit()
            main_id, front_id = main.id, front.id
            all_items.append(item_id)
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def worker_transfer():
            session = SessionLocal()
            try:
                _capture(
                    lambda: inventory_service.create_transfer(
                        session,
                        StockTransferCreate(
                            source_location_id=main_id,
                            destination_location_id=front_id,
                            lines=[TransferLineIn(
                                item_id=item_id, quantity=Decimal("8")
                            )],
                        ),
                        None,
                        None,
                    ),
                    results,
                    lock,
                )
            finally:
                session.close()

        def worker_issue():
            session = SessionLocal()
            try:
                _capture(
                    lambda: inventory_service.create_issue(
                        session,
                        StockIssueCreate(
                            source_location_id=main_id,
                            destination_type=IssueDestinationType.OTHER,
                            lines=[IssueLineIn(
                                item_id=item_id, quantity=Decimal("8")
                            )],
                        ),
                        None,
                        None,
                    ),
                    results,
                    lock,
                )
            finally:
                session.close()

        _run_threads([worker_transfer, worker_issue])

        statuses = sorted(r[0] for r in results)
        assert statuses == ["CONFLICT:409", "SUCCESS"], (
            f"round {idx}: {results}"
        )
        results_per_round.append(results)

        verify = SessionLocal()
        try:
            main_qty = _balance(verify, item_id, main_id)
            front_qty = _balance(verify, item_id, front_id)
            assert main_qty == Decimal("2.00"), (
                f"source must be 2, got {main_qty}（不允许负库存）"
            )
            if front_qty == Decimal("8.00"):
                # 调拨成功：酒店总库存不变 = 10
                assert main_qty + front_qty == Decimal("10.00")
            else:
                # 领用成功：目的地 0，总库存 = 2
                assert front_qty == Decimal("0.00")
                assert main_qty == Decimal("2.00")
            assert _ledger(verify, item_id, main_id) == main_qty
            assert _ledger(verify, item_id, front_id) == front_qty
        finally:
            verify.close()

    _stress_report("transfer-vs-issue", STRESS_ROUNDS, results_per_round)

    cleanup = SessionLocal()
    try:
        _cleanup(
            cleanup, item_ids=all_items,
            supplier_ids=[], order_ids=[], request_ids=[],
        )
    finally:
        cleanup.close()


# ---------------------------------------------------------------------------
# P0-3：Stocktake vs Issue（同 Balance，Sprint 7 §17/§49）
# ---------------------------------------------------------------------------


def test_concurrent_stocktake_vs_issue(_database):
    results_per_round: list[list] = []
    all_items: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            main = _location(setup, "MAIN_STORAGE")
            item_id = _make_item(setup, f"CONC-STI-{idx}")
            _set_stock(setup, item_id, main.id, "10")
            setup.commit()
            main_id = main.id
            all_items.append(item_id)
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def worker_stocktake():
            session = SessionLocal()
            try:
                _capture(
                    lambda: inventory_service.create_stocktake(
                        session,
                        StocktakeCreate(
                            item_id=item_id,
                            location_id=main_id,
                            actual_quantity=Decimal("3"),
                            reason="并发盘点",
                        ),
                        None,
                        None,
                    ),
                    results,
                    lock,
                )
            finally:
                session.close()

        def worker_issue():
            session = SessionLocal()
            try:
                _capture(
                    lambda: inventory_service.create_issue(
                        session,
                        StockIssueCreate(
                            source_location_id=main_id,
                            destination_type=IssueDestinationType.OTHER,
                            lines=[IssueLineIn(
                                item_id=item_id, quantity=Decimal("8")
                            )],
                        ),
                        None,
                        None,
                    ),
                    results,
                    lock,
                )
            finally:
                session.close()

        _run_threads([worker_stocktake, worker_issue])

        # 两种合法交织：
        #   stocktake 先（balance 3）-> issue 409；或 issue 先（balance 2）
        #   -> stocktake expected=2 actual=3 -> +1（balance 3）。都合法。
        for status, _ in results:
            assert status in ("SUCCESS", "CONFLICT:409"), (
                f"round {idx}: {results}"
            )
        assert sum(1 for s, _ in results if s == "SUCCESS") >= 1
        results_per_round.append(results)

        verify = SessionLocal()
        try:
            final = _balance(verify, item_id, main_id)
            assert final >= Decimal("0"), f"不允许负库存，got {final}"
            # 合法终态：issue 成功 -> 2；stocktake 先 -> 3
            assert final in (Decimal("2.00"), Decimal("3.00")), (
                f"round {idx}: final={final}"
            )
            assert _ledger(verify, item_id, main_id) == final
        finally:
            verify.close()

    _stress_report("stocktake-vs-issue", STRESS_ROUNDS, results_per_round)

    cleanup = SessionLocal()
    try:
        _cleanup(
            cleanup, item_ids=all_items,
            supplier_ids=[], order_ids=[], request_ids=[],
        )
    finally:
        cleanup.close()


# ---------------------------------------------------------------------------
# P0-4：Receipt vs Receipt（同 PO 剩余数量，Sprint 7 §32）
# ---------------------------------------------------------------------------


def test_concurrent_receipt_vs_receipt(_database):
    results_per_round: list[list] = []
    all_items: list[int] = []
    all_suppliers: list[int] = []
    all_orders: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            main = _location(setup, "MAIN_STORAGE")
            item_id = _make_item(setup, f"CONC-RCR-{idx}")
            supplier_id = _make_supplier(setup, f"SUPCONC-{idx}")
            order_id, line_id = _make_ordered_po(
                setup, supplier_id, item_id, ordered="100", received="60"
            )
            setup.commit()
            main_id = main.id
            all_items.append(item_id)
            all_suppliers.append(supplier_id)
            all_orders.append(order_id)
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def worker():
            session = SessionLocal()
            try:
                _capture(
                    lambda: procurement_service.receive_goods(
                        session,
                        order_id,
                        GoodsReceiptCreate(
                            inventory_location_id=main_id,
                            lines=[GoodsReceiptLineIn(
                                purchase_order_line_id=line_id,
                                received_quantity=Decimal("40"),
                            )],
                        ),
                        None,
                        None,
                    ),
                    results,
                    lock,
                )
            finally:
                session.close()

        _run_threads([worker, worker])

        statuses = sorted(r[0] for r in results)
        assert statuses == ["CONFLICT:409", "SUCCESS"], (
            f"round {idx}: {results}"
        )
        results_per_round.append(results)

        verify = SessionLocal()
        try:
            received = verify.scalar(
                select(PurchaseOrderLine.received_quantity).where(
                    PurchaseOrderLine.id == line_id
                )
            )
            assert received == Decimal("100.00"), (
                f"final received must be 100, got {received}（不允许 140）"
            )
            assert _balance(verify, item_id, main_id) == Decimal("40.00")
            assert _ledger(verify, item_id, main_id) == Decimal("40.00")
            status = verify.scalar(
                select(PurchaseOrder.status).where(PurchaseOrder.id == order_id)
            )
            assert status == "RECEIVED"
        finally:
            verify.close()

    _stress_report("receipt-vs-receipt", STRESS_ROUNDS, results_per_round)

    cleanup = SessionLocal()
    try:
        _cleanup(
            cleanup, item_ids=all_items,
            supplier_ids=all_suppliers, order_ids=all_orders, request_ids=[],
        )
    finally:
        cleanup.close()


# ---------------------------------------------------------------------------
# P0-5：Receipt vs Issue / Receipt vs Transfer（同目标 Balance，§49）
# ---------------------------------------------------------------------------


def _run_receipt_vs_inventory(
    scenario: str, item_prefix: str, *, transfer: bool
) -> None:
    results_per_round: list[list] = []
    all_items: list[int] = []
    all_suppliers: list[int] = []
    all_orders: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            main = _location(setup, "MAIN_STORAGE")
            front = _location(setup, "FRONT_DESK")
            item_id = _make_item(setup, f"{item_prefix}-{idx}")
            supplier_id = _make_supplier(setup, f"SUP{scenario}-{idx}")
            order_id, line_id = _make_ordered_po(
                setup, supplier_id, item_id, ordered="100", received="0"
            )
            setup.commit()
            main_id, front_id = main.id, front.id
            all_items.append(item_id)
            all_suppliers.append(supplier_id)
            all_orders.append(order_id)
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def worker_receipt():
            session = SessionLocal()
            try:
                _capture(
                    lambda: procurement_service.receive_goods(
                        session,
                        order_id,
                        GoodsReceiptCreate(
                            inventory_location_id=main_id,
                            lines=[GoodsReceiptLineIn(
                                purchase_order_line_id=line_id,
                                received_quantity=Decimal("40"),
                            )],
                        ),
                        None,
                        None,
                    ),
                    results,
                    lock,
                )
            finally:
                session.close()

        def worker_inventory():
            session = SessionLocal()
            try:
                def do():
                    if transfer:
                        inventory_service.create_transfer(
                            session,
                            StockTransferCreate(
                                source_location_id=main_id,
                                destination_location_id=front_id,
                                lines=[TransferLineIn(
                                    item_id=item_id, quantity=Decimal("30")
                                )],
                            ),
                            None,
                            None,
                        )
                    else:
                        inventory_service.create_issue(
                            session,
                            StockIssueCreate(
                                source_location_id=main_id,
                                destination_type=IssueDestinationType.OTHER,
                                lines=[IssueLineIn(
                                    item_id=item_id, quantity=Decimal("20")
                                )],
                            ),
                            None,
                            None,
                        )

                _capture(do, results, lock)
            finally:
                session.close()

        _run_threads([worker_receipt, worker_inventory])

        for status, _ in results:
            assert status in ("SUCCESS", "CONFLICT:409"), (
                f"round {idx}: {results}"
            )
        results_per_round.append(results)

        verify = SessionLocal()
        try:
            main_qty = _balance(verify, item_id, main_id)
            front_qty = _balance(verify, item_id, front_id)
            assert main_qty >= Decimal("0"), "不允许负库存"
            assert _ledger(verify, item_id, main_id) == main_qty
            assert _ledger(verify, item_id, front_id) == front_qty
            received = verify.scalar(
                select(PurchaseOrderLine.received_quantity).where(
                    PurchaseOrderLine.id == line_id
                )
            )
            assert received == Decimal("40.00")
            # 收货 40 必成功；库存动作成败皆合法
            if transfer:
                assert main_qty + front_qty == Decimal("40.00")
            else:
                assert main_qty in (Decimal("40.00"), Decimal("20.00"))
        finally:
            verify.close()

    _stress_report(scenario, STRESS_ROUNDS, results_per_round)

    cleanup = SessionLocal()
    try:
        _cleanup(
            cleanup, item_ids=all_items,
            supplier_ids=all_suppliers, order_ids=all_orders, request_ids=[],
        )
    finally:
        cleanup.close()


def test_concurrent_receipt_vs_issue(_database):
    _run_receipt_vs_inventory("receipt-vs-issue", "CONC-RVI", transfer=False)


def test_concurrent_receipt_vs_transfer(_database):
    _run_receipt_vs_inventory("receipt-vs-transfer", "CONC-RVT", transfer=True)


# ---------------------------------------------------------------------------
# P0-6：Request -> PO vs Request -> PO（同 APPROVED 申请，§28）
# ---------------------------------------------------------------------------


def test_concurrent_request_to_po_exactly_once(_database):
    results_per_round: list[list] = []
    all_items: list[int] = []
    all_suppliers: list[int] = []
    all_orders: list[int] = []
    all_requests: list[int] = []

    for idx in range(STRESS_ROUNDS):
        setup = SessionLocal()
        try:
            item_id = _make_item(setup, f"CONC-RPO-{idx}")
            supplier_id = _make_supplier(setup, f"SUPRPO-{idx}")
            request_id = _make_approved_request(setup, item_id)
            setup.commit()
            all_items.append(item_id)
            all_suppliers.append(supplier_id)
            all_requests.append(request_id)
        finally:
            setup.close()

        results: list = []
        lock = threading.Lock()

        def worker():
            session = SessionLocal()
            try:
                def do():
                    procurement_service.create_order(
                        session,
                        PurchaseOrderCreate(
                            supplier_id=supplier_id,
                            purchase_request_id=request_id,
                        ),
                        None,
                        None,
                    )

                _capture(do, results, lock)
            finally:
                session.close()

        _run_threads([worker, worker])

        statuses = sorted(r[0] for r in results)
        assert statuses == ["CONFLICT:409", "SUCCESS"], (
            f"round {idx}: {results}"
        )
        results_per_round.append(results)

        verify = SessionLocal()
        try:
            orders = verify.scalars(
                select(PurchaseOrder).where(
                    PurchaseOrder.purchase_request_id == request_id
                )
            ).all()
            assert len(orders) == 1, "一张 Request 至多一张 PO"
            all_orders.append(orders[0].id)
            status = verify.scalar(
                select(PurchaseRequest.status).where(
                    PurchaseRequest.id == request_id
                )
            )
            assert status == "ORDERED"
        finally:
            verify.close()

    _stress_report("request-to-po-vs-request-to-po", STRESS_ROUNDS, results_per_round)

    cleanup = SessionLocal()
    try:
        _cleanup(
            cleanup, item_ids=all_items,
            supplier_ids=all_suppliers, order_ids=all_orders,
            request_ids=all_requests,
        )
    finally:
        cleanup.close()
