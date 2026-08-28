# -*- coding: utf-8 -*-
"""Supplier + Purchase Request 状态机测试（Sprint 7 §22/§24/§25）。"""

from tests.inventory_helpers import (
    create_item,
    create_request,
    create_supplier,
    get_request,
    list_requests,
    list_suppliers,
    request_action,
)


def test_supplier_crud_and_deactivate(client, admin_headers):
    supplier = create_supplier(
        client, admin_headers, code="SUP-CRUD-01", name="泉城日用品",
        phone="0531-88880000",
    )
    assert supplier["supplier_code"] == "SUP-CRUD-01"
    # 重复 code -> 409
    create_supplier(client, admin_headers, code="SUP-CRUD-01", expect=409)

    # PATCH：改基础信息 + 停用
    resp = client.patch(
        f"/api/v1/procurement/suppliers/{supplier['id']}",
        json={"name": "泉城日用品有限公司", "is_active": False},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "泉城日用品有限公司"
    assert resp.json()["is_active"] is False

    # 空 payload -> 422；未知字段 -> 422
    assert client.patch(
        f"/api/v1/procurement/suppliers/{supplier['id']}",
        json={}, headers=admin_headers,
    ).status_code == 422
    assert client.patch(
        f"/api/v1/procurement/suppliers/{supplier['id']}",
        json={"deleted": True}, headers=admin_headers,
    ).status_code == 422

    # 列表过滤 is_active=false 不包含
    active = list_suppliers(client, admin_headers, {"is_active": "true"})
    assert all(s["id"] != supplier["id"] for s in active)
    inactive = list_suppliers(client, admin_headers, {"is_active": "false"})
    assert any(s["id"] == supplier["id"] for s in inactive)

    # 无 DELETE 端点（§47）
    assert client.delete(
        f"/api/v1/procurement/suppliers/{supplier['id']}",
        headers=admin_headers,
    ).status_code in (404, 405)

    # 详情 + 404
    assert client.get(
        f"/api/v1/procurement/suppliers/{supplier['id']}",
        headers=admin_headers,
    ).status_code == 200
    assert client.get(
        "/api/v1/procurement/suppliers/999999", headers=admin_headers
    ).status_code == 404


def test_request_state_machine_golden(client, admin_headers):
    item = create_item(client, admin_headers, code="ITM-PRQ-001")
    pr = create_request(
        client, admin_headers, [{"item_id": item["id"], "quantity": "50"}]
    )
    assert pr["status"] == "DRAFT"
    assert pr["request_no"].startswith("PRQ")
    assert pr["lines"][0]["quantity"] == "50.00"

    # DRAFT 不可直接 approve / reject（409）
    request_action(client, admin_headers, pr["id"], "approve", expect=409)
    request_action(client, admin_headers, pr["id"], "reject", expect=409)

    # submit -> SUBMITTED（记录 submitted_at）
    pr = request_action(client, admin_headers, pr["id"], "submit")
    assert pr["status"] == "SUBMITTED"
    assert pr["submitted_at"] is not None

    # SUBMITTED 不可 cancel（状态机只允许 DRAFT/APPROVED 取消）
    request_action(client, admin_headers, pr["id"], "cancel", expect=409)

    # approve -> APPROVED（记录 approved_by / approved_at）
    pr = request_action(client, admin_headers, pr["id"], "approve")
    assert pr["status"] == "APPROVED"
    assert pr["approved_by_user_id"] is not None
    assert pr["approved_at"] is not None

    # APPROVED 可 cancel（§24：APPROVED -> CANCELLED）
    pr = request_action(client, admin_headers, pr["id"], "cancel")
    assert pr["status"] == "CANCELLED"
    assert pr["cancelled_at"] is not None

    # CANCELLED 终态：submit / approve / reject / cancel 全部 409
    for action in ("submit", "approve", "reject", "cancel"):
        request_action(client, admin_headers, pr["id"], action, expect=409)


def test_request_reject_terminal(client, admin_headers):
    """SUBMITTED -> REJECTED（终态）；不允许 REJECTED -> APPROVED（§24）。"""
    item = create_item(client, admin_headers, code="ITM-PRQ-REJ01")
    pr = create_request(
        client, admin_headers, [{"item_id": item["id"], "quantity": "1"}]
    )
    request_action(client, admin_headers, pr["id"], "submit")
    pr = request_action(client, admin_headers, pr["id"], "reject")
    assert pr["status"] == "REJECTED"
    assert pr["rejected_at"] is not None
    # REJECTED -> APPROVED 不允许（需重新创建 / 重新提交流程）
    request_action(client, admin_headers, pr["id"], "approve", expect=409)
    request_action(client, admin_headers, pr["id"], "submit", expect=409)


def test_request_create_validation(client, admin_headers):
    item = create_item(client, admin_headers, code="ITM-PRQ-VAL01")
    # 空 lines -> 422
    resp = client.post(
        "/api/v1/procurement/requests",
        json={"lines": []}, headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 数量 <= 0 -> 422
    resp = client.post(
        "/api/v1/procurement/requests",
        json={"lines": [{"item_id": item["id"], "quantity": "0"}]},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 物资不存在 -> 422
    resp = client.post(
        "/api/v1/procurement/requests",
        json={"lines": [{"item_id": 999999, "quantity": "1"}]},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 重复物资行 -> 422
    resp = client.post(
        "/api/v1/procurement/requests",
        json={
            "lines": [
                {"item_id": item["id"], "quantity": "1"},
                {"item_id": item["id"], "quantity": "2"},
            ]
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text


def test_request_list_filter_and_search(client, admin_headers):
    item = create_item(client, admin_headers, code="ITM-PRQ-LST01")
    pr = create_request(
        client, admin_headers, [{"item_id": item["id"], "quantity": "1"}]
    )
    submitted = list_requests(
        client, admin_headers, {"status": "SUBMITTED"}
    )
    assert all(r["status"] == "SUBMITTED" for r in submitted)
    found = list_requests(
        client, admin_headers, {"search": pr["request_no"]}
    )
    assert len(found) == 1 and found[0]["id"] == pr["id"]
    assert get_request(client, admin_headers, pr["id"])["id"] == pr["id"]
    assert client.get(
        "/api/v1/procurement/requests/999999", headers=admin_headers
    ).status_code == 404
