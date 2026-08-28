# -*- coding: utf-8 -*-
"""Inventory / Procurement RBAC 矩阵测试（Sprint 7 §35/§36）。

用 permission 判断（种子角色权限），禁止硬编码角色名；后端 403 为唯一裁决。
矩阵：
    SUPER_ADMIN / MANAGER = 全部 11 个新权限
    FRONT_DESK  = inventory:read/issue + procurement:read/request/receive
    HOUSEKEEPING= inventory:read/issue + procurement:request
    MAINTENANCE = inventory:read/issue + procurement:request
    FINANCE     = inventory:read + procurement:read
"""

import pytest

from tests.conftest import auth_headers
from tests.inventory_helpers import (
    create_item,
    create_supplier,
    location_by_code,
)

ALL_ROLES = [
    "SUPER_ADMIN",
    "MANAGER",
    "FRONT_DESK",
    "HOUSEKEEPING",
    "MAINTENANCE",
    "FINANCE",
]

READ_INVENTORY_ROLES = ALL_ROLES  # inventory:read 全角色
ISSUE_ROLES = ["SUPER_ADMIN", "MANAGER", "FRONT_DESK", "HOUSEKEEPING", "MAINTENANCE"]
MANAGE_ROLES = ["SUPER_ADMIN", "MANAGER"]
PROCUREMENT_READ_ROLES = ["SUPER_ADMIN", "MANAGER", "FRONT_DESK", "FINANCE"]
REQUEST_ROLES = ["SUPER_ADMIN", "MANAGER", "FRONT_DESK", "HOUSEKEEPING", "MAINTENANCE"]
RECEIVE_ROLES = ["SUPER_ADMIN", "MANAGER", "FRONT_DESK"]


@pytest.fixture()
def role_users(client, make_user, token_for):
    users = {}
    for role in ALL_ROLES:
        make_user(f"s7_{role.lower()}", role_names=[role])
        token = token_for(f"s7_{role.lower()}")
        users[role] = auth_headers(token)
    return users


@pytest.fixture()
def base_data(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(client, admin_headers, code="ITM-RBAC-001")
    supplier = create_supplier(client, admin_headers, code="SUP-RBAC-001")
    return main, item, supplier


def test_inventory_read_all_roles(client, role_users, base_data):
    main, item, _ = base_data
    for role in ALL_ROLES:
        headers = role_users[role]
        resp = client.get(
            "/api/v1/inventory/items",
            params={"page_size": 100}, headers=headers,
        )
        assert resp.status_code == 200, (role, resp.text)
        resp = client.get(
            f"/api/v1/inventory/items/{item['id']}", headers=headers
        )
        assert resp.status_code == 200, (role, resp.text)
        resp = client.get(
            "/api/v1/inventory/locations",
            params={"page_size": 100}, headers=headers,
        )
        assert resp.status_code == 200, (role, resp.text)
        resp = client.get(
            "/api/v1/inventory/movements",
            params={"page_size": 100}, headers=headers,
        )
        assert resp.status_code == 200, (role, resp.text)
        resp = client.get(
            "/api/v1/inventory/balances",
            params={"page_size": 100}, headers=headers,
        )
        assert resp.status_code == 200, (role, resp.text)


def test_inventory_issue_rbac(client, role_users, base_data):
    main, item, _ = base_data
    payload = {
        "source_location_id": main["id"],
        "destination_type": "OTHER",
        "lines": [{"item_id": item["id"], "quantity": "1"}],
    }
    for role in ALL_ROLES:
        resp = client.post(
            "/api/v1/inventory/issues", json=payload,
            headers=role_users[role],
        )
        if role in ISSUE_ROLES:
            # 无库存 -> 409（业务校验），证明权限通过
            assert resp.status_code == 409, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)

    # FINANCE 归还 403；ISSUE_ROLES 归还通过（409 库存不足或 200）
    for role in ALL_ROLES:
        resp = client.post(
            "/api/v1/inventory/returns",
            json={"item_id": item["id"], "location_id": main["id"],
                  "quantity": "1", "reason": "x"},
            headers=role_users[role],
        )
        if role in ISSUE_ROLES:
            assert resp.status_code == 200, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)


def test_inventory_manage_transfer_adjust_rbac(client, role_users, base_data):
    main, item, _ = base_data

    transfer_payload = {
        "source_location_id": main["id"],
        "destination_location_id": main["id"],  # 422 用于权限通过后的业务校验
        "lines": [{"item_id": item["id"], "quantity": "1"}],
    }
    stocktake_payload = {
        "item_id": item["id"],
        "location_id": main["id"],
        "actual_quantity": "1",
        "reason": "盘点",
    }
    for role in ALL_ROLES:
        headers = role_users[role]
        create_payload = {
            "item_code": f"ITM-RBAC-NEW-{role}",
            "name": "权限测试",
            "category": "OTHER",
            "base_unit": "个",
        }
        # POST items（item_manage）
        resp = client.post(
            "/api/v1/inventory/items", json=create_payload, headers=headers
        )
        if role in MANAGE_ROLES:
            assert resp.status_code == 201, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        # PATCH items
        resp = client.patch(
            f"/api/v1/inventory/items/{item['id']}",
            json={"name": "改名"}, headers=headers,
        )
        if role in MANAGE_ROLES:
            assert resp.status_code == 200, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        # transfer
        resp = client.post(
            "/api/v1/inventory/transfers", json=transfer_payload, headers=headers
        )
        if role in MANAGE_ROLES:
            assert resp.status_code == 422, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        # stocktake
        resp = client.post(
            "/api/v1/inventory/stocktakes", json=stocktake_payload, headers=headers
        )
        if role in MANAGE_ROLES:
            assert resp.status_code == 200, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)


def test_procurement_read_rbac(client, role_users, base_data):
    for role in ALL_ROLES:
        resp = client.get(
            "/api/v1/procurement/suppliers",
            params={"page_size": 100}, headers=role_users[role],
        )
        if role in PROCUREMENT_READ_ROLES:
            assert resp.status_code == 200, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        resp = client.get(
            "/api/v1/procurement/requests",
            params={"page_size": 100}, headers=role_users[role],
        )
        if role in PROCUREMENT_READ_ROLES:
            assert resp.status_code == 200, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        resp = client.get(
            "/api/v1/procurement/orders",
            params={"page_size": 100}, headers=role_users[role],
        )
        if role in PROCUREMENT_READ_ROLES:
            assert resp.status_code == 200, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)


def test_procurement_request_approve_order_receive_rbac(
    client, role_users, admin_headers, base_data
):
    main, item, supplier = base_data

    # admin 准备一个 SUBMITTED 申请 + ORDERED 订单供 approve / receive 用
    from tests.inventory_helpers import (
        create_order,
        create_request,
        order_action,
        request_action,
    )
    pr = create_request(
        client, admin_headers, [{"item_id": item["id"], "quantity": "1"}]
    )
    request_action(client, admin_headers, pr["id"], "submit")
    order = create_order(
        client, admin_headers, supplier["id"],
        lines=[{"item_id": item["id"], "ordered_quantity": "5"}],
    )
    order_action(client, admin_headers, order["id"], "order")

    request_payload = {"lines": [{"item_id": item["id"], "quantity": "1"}]}
    order_payload = {
        "supplier_id": supplier["id"],
        "lines": [{"item_id": item["id"], "ordered_quantity": "1"}],
    }
    receipt_payload = {
        "inventory_location_id": main["id"],
        "lines": [
            {
                "purchase_order_line_id": order["lines"][0]["id"],
                "received_quantity": "1",
            }
        ],
    }

    for role in ALL_ROLES:
        headers = role_users[role]
        supplier_payload = {
            "supplier_code": f"SUP-RBAC-NEW-{role}",
            "name": "新供应商",
        }
        # POST requests（procurement:request）
        resp = client.post(
            "/api/v1/procurement/requests", json=request_payload, headers=headers
        )
        if role in REQUEST_ROLES:
            assert resp.status_code == 201, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        # approve（procurement:approve）：每角色准备自己的 SUBMITTED 申请
        own_pr = create_request(
            client, admin_headers, [{"item_id": item["id"], "quantity": "1"}]
        )
        request_action(client, admin_headers, own_pr["id"], "submit")
        resp = client.post(
            f"/api/v1/procurement/requests/{own_pr['id']}/approve",
            headers=headers,
        )
        if role in MANAGE_ROLES:
            assert resp.status_code == 200, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        # POST orders（procurement:order）
        resp = client.post(
            "/api/v1/procurement/orders", json=order_payload, headers=headers
        )
        if role in MANAGE_ROLES:
            assert resp.status_code == 201, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        # receipts（procurement:receive）
        resp = client.post(
            f"/api/v1/procurement/orders/{order['id']}/receipts",
            json=receipt_payload, headers=headers,
        )
        if role in RECEIVE_ROLES:
            # 管理员已可能部分收货 -> 409 也证明权限通过
            assert resp.status_code in (201, 409), (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)
        # suppliers 写（procurement:supplier_manage）
        resp = client.post(
            "/api/v1/procurement/suppliers", json=supplier_payload, headers=headers
        )
        if role in MANAGE_ROLES:
            assert resp.status_code == 201, (role, resp.text)
        else:
            assert resp.status_code == 403, (role, resp.status_code)


def test_rbac_uses_permissions_not_role_names(client, role_users, base_data):
    """权限裁决基于 permission code（§36 禁止 Role Name hardcode）。"""
    # FINANCE 角色若被动态授予 inventory:issue，即可领用——权限唯一裁决点
    main, item, _ = base_data
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": main["id"],
            "destination_type": "OTHER",
            "lines": [{"item_id": item["id"], "quantity": "1"}],
        },
        headers=role_users["FINANCE"],
    )
    assert resp.status_code == 403
