# -*- coding: utf-8 -*-
"""Stocktake / Adjustment + 账本不可变 + Ledger-Balance 对账测试
（Sprint 7 §9/§18/§50）。"""

from decimal import Decimal

from sqlalchemy import func, select

from app.models import InventoryBalance, StockMovement
from tests.inventory_helpers import (
    balance_for,
    create_item,
    initial_stock,
    issue,
    list_movements,
    location_by_code,
    stock_return,
    stocktake,
    transfer,
)


def test_stocktake_adjustment_up(client, admin_headers, db):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(client, admin_headers, code="ITM-STK-UP001")
    initial_stock(client, admin_headers, item["id"], main["id"], "10")

    result = stocktake(
        client, admin_headers, item["id"], main["id"], "13", reason="盘点修正"
    )
    assert Decimal(result["expected_quantity"]) == Decimal("10")
    assert Decimal(result["actual_quantity"]) == Decimal("13")
    assert Decimal(result["difference"]) == Decimal("3")
    assert result["movement_type"] == "ADJUSTMENT_IN"
    assert Decimal(result["balance_quantity"]) == Decimal("13")

    movement = db.scalar(
        select(StockMovement).where(
            StockMovement.id == result["movement_id"]
        )
    )
    assert movement is not None
    assert movement.quantity == Decimal("3.00")
    assert movement.reason == "盘点修正"


def test_stocktake_adjustment_down(client, admin_headers, db):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(client, admin_headers, code="ITM-STK-DN001")
    initial_stock(client, admin_headers, item["id"], main["id"], "10")

    result = stocktake(
        client, admin_headers, item["id"], main["id"], "6", reason="破损报损"
    )
    assert Decimal(result["difference"]) == Decimal("-4")
    assert result["movement_type"] == "ADJUSTMENT_OUT"
    assert Decimal(result["balance_quantity"]) == Decimal("6")

    movement = db.scalar(
        select(StockMovement).where(
            StockMovement.id == result["movement_id"]
        )
    )
    assert movement.quantity == Decimal("-4.00")


def test_stocktake_noop_no_movement(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(client, admin_headers, code="ITM-STK-NO001")
    initial_stock(client, admin_headers, item["id"], main["id"], "10")

    result = stocktake(
        client, admin_headers, item["id"], main["id"], "10", reason="例行盘点"
    )
    assert Decimal(result["difference"]) == Decimal("0")
    assert result.get("movement_type") is None
    assert result.get("movement_id") is None
    # 没有创建 movement（§18：相同返回 no-op）
    movements = list_movements(
        client, admin_headers, item["id"], main["id"]
    )
    assert all(m["movement_type"] != "ADJUSTMENT_IN" for m in movements)
    assert all(m["movement_type"] != "ADJUSTMENT_OUT" for m in movements)


def test_stocktake_reason_required(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(client, admin_headers, code="ITM-STK-RS001")
    resp = client.post(
        "/api/v1/inventory/stocktakes",
        json={
            "item_id": item["id"],
            "location_id": main["id"],
            "actual_quantity": "1",
            "reason": "",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text


def test_movement_immutability_no_patch_delete(client, admin_headers):
    """StockMovement 创建后无普通 PATCH / DELETE 通道（§9）。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(client, admin_headers, code="ITM-IMM-001")
    initial_stock(client, admin_headers, item["id"], main["id"], "5")
    movements = list_movements(
        client, admin_headers, item["id"], main["id"]
    )
    movement_id = movements[0]["id"]

    for method in ("patch", "put"):
        resp = getattr(client, method)(
            f"/api/v1/inventory/movements/{movement_id}",
            json={"quantity": "999"},
            headers=admin_headers,
        )
        assert resp.status_code in (404, 405), (
            method, resp.status_code, resp.text
        )
    # DELETE：无 json 参数（TestClient 不支持），且无删除端点 -> 404/405
    resp = client.delete(
        f"/api/v1/inventory/movements/{movement_id}",
        headers=admin_headers,
    )
    assert resp.status_code in (404, 405), (resp.status_code, resp.text)

    # 平衡修正只能通过新 movement（adjustment），旧记录不被改写
    stocktake(
        client, admin_headers, item["id"], main["id"], "3", reason="修正"
    )
    movements = list_movements(
        client, admin_headers, item["id"], main["id"]
    )
    initial = next(m for m in movements if m["movement_type"] == "INITIAL")
    assert Decimal(initial["quantity"]) == Decimal("5")  # 历史流水未变


def test_ledger_equals_balance_after_all_operations(client, admin_headers, db):
    """Ledger == Balance 对账（§50）：INITIAL / ISSUE / RETURN / TRANSFER /
    ADJUSTMENT / PURCHASE_RECEIPT 后 InventoryBalance == SUM(StockMovement)。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    front = location_by_code(client, admin_headers, "FRONT_DESK")
    item = create_item(client, admin_headers, code="ITM-RECON-001")

    initial_stock(client, admin_headers, item["id"], main["id"], "100")
    issue(
        client, admin_headers, main["id"],
        [{"item_id": item["id"], "quantity": "25"}],
    )
    stock_return(
        client, admin_headers, item["id"], main["id"], "5", reason="归还"
    )
    transfer(
        client, admin_headers, main["id"], front["id"],
        [{"item_id": item["id"], "quantity": "20"}],
    )
    stocktake(
        client, admin_headers, item["id"], main["id"], "63",
        reason="盘点修正",
    )
    stocktake(
        client, admin_headers, item["id"], front["id"], "18",
        reason="盘点修正",
    )

    def reconcile(location_id: int) -> Decimal:
        ledger = db.scalar(
            select(func.coalesce(func.sum(StockMovement.quantity), 0)).where(
                StockMovement.item_id == item["id"],
                StockMovement.location_id == location_id,
            )
        )
        return Decimal(ledger)

    for location_id in (main["id"], front["id"]):
        balance = db.scalar(
            select(InventoryBalance.quantity).where(
                InventoryBalance.item_id == item["id"],
                InventoryBalance.location_id == location_id,
            )
        )
        assert balance == reconcile(location_id), (
            location_id, balance, reconcile(location_id)
        )
    # 手工核对账本
    assert reconcile(main["id"]) == Decimal("63.00")
    assert reconcile(front["id"]) == Decimal("18.00")
    assert balance_for(client, admin_headers, item["id"], main["id"]) == Decimal("63.00")
    assert balance_for(client, admin_headers, item["id"], front["id"]) == Decimal("18.00")


def test_ledger_equals_balance_includes_receipt(client, admin_headers, db):
    """PURCHASE_RECEIPT 后 Ledger == Balance（§50 采购收货路径）。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    from tests.inventory_helpers import (
        create_order,
        create_supplier,
        order_action,
        receive,
    )

    item = create_item(client, admin_headers, code="ITM-RECON-PR01")
    supplier = create_supplier(client, admin_headers, code="SUP-RECON-01")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[{"item_id": item["id"], "ordered_quantity": "30"}],
    )
    order_action(client, admin_headers, order["id"], "order")
    line_id = order["lines"][0]["id"]
    receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "30"}],
    )

    balance = db.scalar(
        select(InventoryBalance.quantity).where(
            InventoryBalance.item_id == item["id"],
            InventoryBalance.location_id == main["id"],
        )
    )
    ledger = db.scalar(
        select(func.coalesce(func.sum(StockMovement.quantity), 0)).where(
            StockMovement.item_id == item["id"],
            StockMovement.location_id == main["id"],
        )
    )
    assert balance == ledger == Decimal("30.00")
