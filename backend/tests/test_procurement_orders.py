# -*- coding: utf-8 -*-
"""Purchase Order + Goods Receipt 测试（Sprint 7 §26-§33）。

关键语义：
- PO 不改变库存（§33）：DRAFT / ORDERED PO 均无 movement / balance 变化
- 只有 Goods Receipt 创建 PURCHASE_RECEIPT movement 并增加库存（§29/§30）
- Request -> PO exactly once（§28）：同事务 APPROVED -> ORDERED
- 部分收货（§31）：cumulative received <= ordered；PO 状态由收货推导
- 超收整体回滚；RECEIVED 终态不可取消；PARTIALLY_RECEIVED 可取消剩余
"""

from decimal import Decimal

from tests.inventory_helpers import (
    balance_for,
    create_item,
    create_order,
    create_request,
    create_supplier,
    get_item,
    get_order,
    get_request,
    list_movements,
    location_by_code,
    order_action,
    po_line,
    receive,
    request_action,
)


def _item_and_supplier(client, headers, code):
    item = create_item(client, headers, code=code)
    supplier = create_supplier(client, headers, code=f"SUP-{code[-4:]}")
    return item, supplier


def test_po_create_direct_and_lifecycle(client, admin_headers):
    item, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-D01")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[{"item_id": item["id"], "ordered_quantity": "100"}],
        unit_prices={item["id"]: "1.50"},
    )
    assert order["status"] == "DRAFT"
    assert order["order_no"].startswith("PO")
    assert Decimal(order["lines"][0]["received_quantity"]) == Decimal("0")
    assert Decimal(order["lines"][0]["remaining_quantity"]) == Decimal("100")
    assert Decimal(order["order_total"]) == Decimal("150")

    # DRAFT 不可收货（409）
    receive(
        client, admin_headers, order["id"],
        location_by_code(client, admin_headers, "MAIN_STORAGE")["id"],
        [{"purchase_order_line_id": order["lines"][0]["id"],
          "received_quantity": "1"}],
        expect=409,
    )

    # DRAFT -> ORDERED（记录 ordered_at）
    order = order_action(client, admin_headers, order["id"], "order")
    assert order["status"] == "ORDERED"
    assert order["ordered_at"] is not None

    # ORDERED -> CANCELLED 允许（§27）
    order = order_action(client, admin_headers, order["id"], "cancel")
    assert order["status"] == "CANCELLED"
    assert order["cancelled_at"] is not None
    # CANCELLED 不可再下单 / 取消
    order_action(client, admin_headers, order["id"], "order", expect=409)
    order_action(client, admin_headers, order["id"], "cancel", expect=409)


def test_po_does_not_change_stock(client, admin_headers):
    """PO 不改变库存（§33）：DRAFT + ORDERED 均无 movement / balance 变化。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-NC01")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[{"item_id": item["id"], "ordered_quantity": "50"}],
    )
    assert balance_for(client, admin_headers, item["id"], main["id"]) is None
    order_action(client, admin_headers, order["id"], "order")
    assert balance_for(client, admin_headers, item["id"], main["id"]) is None
    assert list_movements(
        client, admin_headers, item["id"], main["id"]
    ) == []
    assert Decimal(get_item(client, admin_headers, item["id"])["total_stock"]) == Decimal("0")


def test_partial_and_final_receipt(client, admin_headers):
    """部分收货（§31）：ordered 100 -> 60 -> PARTIALLY_RECEIVED -> 40 -> RECEIVED。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-PR01")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[{"item_id": item["id"], "ordered_quantity": "100"}],
    )
    order_action(client, admin_headers, order["id"], "order")
    line_id = order["lines"][0]["id"]

    receipt1 = receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "60"}],
    )
    assert receipt1["receipt_no"].startswith("GR")
    assert Decimal(receipt1["lines"][0]["received_quantity"]) == Decimal("60")
    order = get_order(client, admin_headers, order["id"])
    assert order["status"] == "PARTIALLY_RECEIVED"
    assert Decimal(po_line(order, item["id"])["received_quantity"]) == Decimal("60")
    assert Decimal(po_line(order, item["id"])["remaining_quantity"]) == Decimal("40")
    # 余额只增加实收数量（§33：收货才是库存增加权威）
    assert balance_for(client, admin_headers, item["id"], main["id"]) == Decimal("60.00")

    receipt2 = receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "40"}],
    )
    assert Decimal(receipt2["lines"][0]["received_quantity"]) == Decimal("40")
    order = get_order(client, admin_headers, order["id"])
    assert order["status"] == "RECEIVED"
    assert balance_for(client, admin_headers, item["id"], main["id"]) == Decimal("100.00")

    # PURCHASE_RECEIPT movements 两条
    movements = [
        m for m in list_movements(client, admin_headers, item["id"], main["id"])
        if m["movement_type"] == "PURCHASE_RECEIPT"
    ]
    assert [Decimal(m["quantity"]) for m in movements] == [
        Decimal("40"), Decimal("60"),
    ]  # id 降序
    assert all(m["reference_id"] is not None for m in movements)
    assert movements[0]["reference_type"] == "goods_receipt"

    # RECEIVED 终态：不可再收货 / 不可取消
    receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "1"}],
        expect=409,
    )
    order_action(client, admin_headers, order["id"], "cancel", expect=409)


def test_over_receipt_rejected(client, admin_headers):
    """超收整体回滚（§30/§31）：cumulative received <= ordered 由行锁保证。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-OV01")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[{"item_id": item["id"], "ordered_quantity": "10"}],
    )
    order_action(client, admin_headers, order["id"], "order")
    line_id = order["lines"][0]["id"]
    receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "6"}],
    )
    # 再收 5 > remaining 4 -> 409
    resp = receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "5"}],
        expect=409,
    )
    assert "收货数量超出" in resp["detail"]
    # 余额与 received 不变（entire rollback）
    assert balance_for(client, admin_headers, item["id"], main["id"]) == Decimal("6.00")
    order = get_order(client, admin_headers, order["id"])
    assert Decimal(po_line(order, item["id"])["received_quantity"]) == Decimal("6")
    # 收货行不属于该订单 -> 422
    receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": 999999, "received_quantity": "1"}],
        expect=422,
    )


def test_receipt_multi_line_rollback(client, admin_headers):
    """多行收货任一行超收：entire rollback（§30）。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item_a, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-MA01")
    item_b = create_item(client, admin_headers, code="ITM-PO-MB01")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[
            {"item_id": item_a["id"], "ordered_quantity": "10"},
            {"item_id": item_b["id"], "ordered_quantity": "10"},
        ],
    )
    order_action(client, admin_headers, order["id"], "order")
    line_a = po_line(order, item_a["id"])["id"]
    line_b = po_line(order, item_b["id"])["id"]

    resp = client.post(
        f"/api/v1/procurement/orders/{order['id']}/receipts",
        json={
            "inventory_location_id": main["id"],
            "lines": [
                {"purchase_order_line_id": line_a, "received_quantity": "5"},
                {"purchase_order_line_id": line_b, "received_quantity": "11"},
            ],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409, resp.text
    # 全量回滚：两行都未收货、无余额、无 movement
    order = get_order(client, admin_headers, order["id"])
    assert Decimal(po_line(order, item_a["id"])["received_quantity"]) == Decimal("0")
    assert Decimal(po_line(order, item_b["id"])["received_quantity"]) == Decimal("0")
    assert order["status"] == "ORDERED"
    assert balance_for(client, admin_headers, item_a["id"], main["id"]) is None
    assert balance_for(client, admin_headers, item_b["id"], main["id"]) is None


def test_cancel_after_partial_receipt(client, admin_headers):
    """PARTIALLY_RECEIVED -> CANCELLED（§27）：已收货库存与历史保持。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-CP01")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[{"item_id": item["id"], "ordered_quantity": "100"}],
    )
    order_action(client, admin_headers, order["id"], "order")
    line_id = order["lines"][0]["id"]
    receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "40"}],
    )
    order = order_action(client, admin_headers, order["id"], "cancel")
    assert order["status"] == "CANCELLED"
    # 已收货库存保持
    assert balance_for(client, admin_headers, item["id"], main["id"]) == Decimal("40.00")
    # 历史收货单保留（无 DELETE，§27）
    order = get_order(client, admin_headers, order["id"])
    assert len(order["receipts"]) == 1
    assert Decimal(
        order["receipts"][0]["lines"][0]["received_quantity"]
    ) == Decimal("40")
    # 取消后不可再收货
    receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "10"}],
        expect=409,
    )


def test_request_to_po_exactly_once(client, admin_headers):
    """Approved Request -> PO：同事务 APPROVED -> ORDERED；重复转换 409（§28）。"""
    item, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-RP01")
    pr = create_request(
        client, admin_headers, [{"item_id": item["id"], "quantity": "80"}]
    )
    request_action(client, admin_headers, pr["id"], "submit")
    request_action(client, admin_headers, pr["id"], "approve")

    order = create_order(
        client, admin_headers, supplier["id"], purchase_request_id=pr["id"]
    )
    assert order["purchase_request_id"] == pr["id"]
    assert order["status"] == "DRAFT"
    # 行复制自申请：数量一致，单价为空（response_model_exclude_none 键缺失）
    assert len(order["lines"]) == 1
    assert Decimal(po_line(order, item["id"])["ordered_quantity"]) == Decimal("80")
    assert po_line(order, item["id"]).get("unit_price") is None
    # Request 同事务 APPROVED -> ORDERED
    pr_after = get_request(client, admin_headers, pr["id"])
    assert pr_after["status"] == "ORDERED"

    # 重复转换 -> 409（DB UNIQUE + 行锁双重仲裁）
    create_order(
        client, admin_headers, supplier["id"],
        purchase_request_id=pr["id"], expect=409,
    )

    # 非 APPROVED 的申请不可转（DRAFT）
    item2 = create_item(client, admin_headers, code="ITM-PO-RP02")
    draft_pr = create_request(
        client, admin_headers, [{"item_id": item2["id"], "quantity": "1"}]
    )
    create_order(
        client, admin_headers, supplier["id"],
        purchase_request_id=draft_pr["id"], expect=409,
    )


def test_request_to_po_payload_validation(client, admin_headers):
    item, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-PV01")
    # 转单 + lines 同时提供 -> 422
    resp = client.post(
        "/api/v1/procurement/orders",
        json={
            "supplier_id": supplier["id"],
            "purchase_request_id": 1,
            "lines": [{"item_id": item["id"], "ordered_quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 直接创建缺 lines -> 422
    resp = client.post(
        "/api/v1/procurement/orders",
        json={"supplier_id": supplier["id"]},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 供应商不存在 -> 422
    resp = client.post(
        "/api/v1/procurement/orders",
        json={
            "supplier_id": 999999,
            "lines": [{"item_id": item["id"], "ordered_quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text


def test_po_actions_not_found(client, admin_headers):
    assert order_action(client, admin_headers, 999999, "order", expect=404)
    assert client.get(
        "/api/v1/procurement/orders/999999", headers=admin_headers
    ).status_code == 404


def test_po_list_filters(client, admin_headers):
    item, supplier = _item_and_supplier(client, admin_headers, "ITM-PO-LS01")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[{"item_id": item["id"], "ordered_quantity": "1"}],
    )
    from tests.inventory_helpers import list_orders
    drafts = list_orders(client, admin_headers, {"status": "DRAFT"})
    assert all(o["status"] == "DRAFT" for o in drafts)
    by_supplier = list_orders(
        client, admin_headers, {"supplier_id": str(supplier["id"])}
    )
    assert any(o["id"] == order["id"] for o in by_supplier)
    by_search = list_orders(
        client, admin_headers, {"search": order["order_no"]}
    )
    assert len(by_search) == 1 and by_search[0]["id"] == order["id"]
