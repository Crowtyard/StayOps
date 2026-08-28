# -*- coding: utf-8 -*-
"""Inventory / Procurement 审计测试（Sprint 7 §37）。

后端自动审计：inventory.item.create/update、inventory.initial/issue/return/
adjust/transfer、supplier.create/update、purchase_request.create/submit/
approve/reject/cancel、purchase_order.create/order/cancel、
goods_receipt.receive。Audit 记录 ID / code / quantities / state transition；
不复制 Supplier phone / notes 自由文本。
"""

from tests.inventory_helpers import (
    create_item,
    create_order,
    create_request,
    create_supplier,
    initial_stock,
    issue,
    list_movements,
    location_by_code,
    order_action,
    patch_item,
    receive,
    request_action,
    stock_return,
    stocktake,
    transfer,
)


def _audit_actions(client, headers, action: str) -> list[dict]:
    resp = client.get(
        "/api/v1/audit-logs",
        params={"action": action, "page_size": 100},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def _audit_for_resource(client, headers, action: str, resource_id: int) -> list[dict]:
    return [
        entry
        for entry in _audit_actions(client, headers, action)
        if entry["resource_id"] == resource_id
    ]


def test_inventory_audit_actions(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    front = location_by_code(client, admin_headers, "FRONT_DESK")

    # item.create / item.update
    item = create_item(client, admin_headers, code="ITM-AUD-001")
    assert len(_audit_for_resource(
        client, admin_headers, "inventory.item.create", item["id"]
    )) == 1
    patch_item(client, admin_headers, item["id"], {"name": "审计物资改"})
    assert len(_audit_for_resource(
        client, admin_headers, "inventory.item.update", item["id"]
    )) == 1

    # initial
    initial_stock(client, admin_headers, item["id"], main["id"], "10")
    movements = list_movements(client, admin_headers, item["id"], main["id"])
    initial_movement = next(
        m for m in movements if m["movement_type"] == "INITIAL"
    )
    entries = _audit_for_resource(
        client, admin_headers, "inventory.initial", initial_movement["id"]
    )
    assert len(entries) == 1
    details = entries[0]["details"]
    assert details["item_code"] == "ITM-AUD-001"
    assert details["quantity"] == "10.00"
    assert details["balance_quantity"] == "10.00"

    # issue（审计记录 ID / code / quantities）
    issue_result = issue(
        client, admin_headers, main["id"],
        [{"item_id": item["id"], "quantity": "3"}],
    )
    entries = _audit_for_resource(
        client, admin_headers, "inventory.issue", issue_result["id"]
    )
    assert len(entries) == 1
    details = entries[0]["details"]
    assert details["issue_no"] == issue_result["issue_no"]
    assert details["lines"][0]["item_code"] == "ITM-AUD-001"
    assert details["lines"][0]["quantity"] == "3.00"
    assert len(details["movement_ids"]) == 1

    # return
    stock_return(client, admin_headers, item["id"], main["id"], "1", reason="归还")
    return_entries = _audit_actions(client, admin_headers, "inventory.return")
    assert any(
        e["details"]["item_code"] == "ITM-AUD-001"
        and e["details"]["quantity"] == "1.00"
        for e in return_entries
    )

    # transfer（审计记录 lines + movement_ids）
    transfer(
        client, admin_headers, main["id"], front["id"],
        [{"item_id": item["id"], "quantity": "2"}],
    )
    transfer_entries = _audit_actions(client, admin_headers, "inventory.transfer")
    assert any(
        e["details"]["source_location_code"] == "MAIN_STORAGE"
        and e["details"]["destination_location_code"] == "FRONT_DESK"
        and len(e["details"]["movement_ids"]) == 2
        for e in transfer_entries
    )

    # adjust（审计记录 expected / actual / difference）
    stocktake(
        client, admin_headers, item["id"], main["id"], "8", reason="盘点"
    )
    adjust_entries = _audit_actions(client, admin_headers, "inventory.adjust")
    target = [
        e for e in adjust_entries
        if e["details"]["item_code"] == "ITM-AUD-001"
        and e["details"]["expected_quantity"] == "6.00"
        and e["details"]["actual_quantity"] == "8.00"
        and e["details"]["difference"] == "2.00"
        and e["details"]["movement_type"] == "ADJUSTMENT_IN"
    ]
    assert len(target) == 1


def test_procurement_audit_actions(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(client, admin_headers, code="ITM-AUD-P01")

    # supplier.create / update（不复制 phone / notes 自由文本）
    supplier = create_supplier(
        client, admin_headers, code="SUP-AUD-001",
        name="审计供应商", phone="0531-12345678",
    )
    entries = _audit_for_resource(
        client, admin_headers, "supplier.create", supplier["id"]
    )
    assert len(entries) == 1
    assert "phone" not in str(entries[0]["details"])
    resp = client.patch(
        f"/api/v1/procurement/suppliers/{supplier['id']}",
        json={"name": "审计供应商改", "notes": "内部备注内容"},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    entries = _audit_for_resource(
        client, admin_headers, "supplier.update", supplier["id"]
    )
    assert len(entries) == 1
    # 审计只记字段名，不复制自由文本内容（§37）
    assert "内部备注内容" not in str(entries[0]["details"])

    # purchase_request.create / submit / approve
    pr = create_request(
        client, admin_headers, [{"item_id": item["id"], "quantity": "20"}]
    )
    entries = _audit_for_resource(
        client, admin_headers, "purchase_request.create", pr["id"]
    )
    assert len(entries) == 1
    assert entries[0]["details"]["status"] == "DRAFT"
    assert entries[0]["details"]["lines"][0]["quantity"] == "20.00"
    request_action(client, admin_headers, pr["id"], "submit")
    entries = _audit_for_resource(
        client, admin_headers, "purchase_request.submit", pr["id"]
    )
    assert entries[0]["details"] == {
        "request_no": pr["request_no"],
        "from": "DRAFT",
        "to": "SUBMITTED",
    }
    request_action(client, admin_headers, pr["id"], "approve")
    entries = _audit_for_resource(
        client, admin_headers, "purchase_request.approve", pr["id"]
    )
    assert entries[0]["details"]["to"] == "APPROVED"

    # purchase_order.create（含 request transition）
    order = create_order(
        client, admin_headers, supplier["id"], purchase_request_id=pr["id"]
    )
    entries = _audit_for_resource(
        client, admin_headers, "purchase_order.create", order["id"]
    )
    assert len(entries) == 1
    assert entries[0]["details"]["from_request_no"] == pr["request_no"]
    assert entries[0]["details"]["request_transition"] == "APPROVED->ORDERED"

    # purchase_order.order / goods_receipt.receive
    order_action(client, admin_headers, order["id"], "order")
    entries = _audit_for_resource(
        client, admin_headers, "purchase_order.order", order["id"]
    )
    assert entries[0]["details"]["to"] == "ORDERED"
    line_id = order["lines"][0]["id"]
    receipt = receive(
        client, admin_headers, order["id"], main["id"],
        [{"purchase_order_line_id": line_id, "received_quantity": "10"}],
    )
    entries = _audit_for_resource(
        client, admin_headers, "goods_receipt.receive", receipt["id"]
    )
    assert len(entries) == 1
    details = entries[0]["details"]
    assert details["order_no"] == order["order_no"]
    assert details["lines"][0]["item_code"] == "ITM-AUD-P01"
    assert details["lines"][0]["quantity"] == "10.00"
    assert details["order_status"] == "ORDERED->PARTIALLY_RECEIVED"
    assert len(details["movement_ids"]) == 1

    # purchase_order.cancel（部分收货后取消剩余，历史保持）
    order_action(client, admin_headers, order["id"], "cancel")
    entries = _audit_for_resource(
        client, admin_headers, "purchase_order.cancel", order["id"]
    )
    assert entries[0]["details"] == {
        "order_no": order["order_no"],
        "from": "PARTIALLY_RECEIVED",
        "to": "CANCELLED",
    }


def test_request_reject_cancel_audit(client, admin_headers):
    item = create_item(client, admin_headers, code="ITM-AUD-P02")
    # reject
    pr = create_request(
        client, admin_headers, [{"item_id": item["id"], "quantity": "1"}]
    )
    request_action(client, admin_headers, pr["id"], "submit")
    request_action(client, admin_headers, pr["id"], "reject")
    entries = _audit_for_resource(
        client, admin_headers, "purchase_request.reject", pr["id"]
    )
    assert entries[0]["details"]["to"] == "REJECTED"
    # cancel（DRAFT）
    pr2 = create_request(
        client, admin_headers, [{"item_id": item["id"], "quantity": "1"}]
    )
    request_action(client, admin_headers, pr2["id"], "cancel")
    entries = _audit_for_resource(
        client, admin_headers, "purchase_request.cancel", pr2["id"]
    )
    assert entries[0]["details"] == {
        "request_no": pr2["request_no"],
        "from": "DRAFT",
        "to": "CANCELLED",
    }
