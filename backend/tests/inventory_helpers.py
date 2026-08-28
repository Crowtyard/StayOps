# -*- coding: utf-8 -*-
"""Inventory / Procurement 测试共用工具（Sprint 7）。

真实 API 链路（TestClient + stayops_test 库）；用例级事务回滚隔离，
跨用例互不污染（物料代码等在回滚后自动消失）。
"""

from decimal import Decimal

from tests.conftest import auth_headers


def login(client, username: str, password: str = "User@123456") -> dict:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return auth_headers(resp.json()["access_token"])


def list_locations(client, headers) -> list[dict]:
    resp = client.get(
        "/api/v1/inventory/locations",
        params={"page_size": 100},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def location_by_code(client, headers, code: str) -> dict:
    return next(
        loc for loc in list_locations(client, headers)
        if loc["location_code"] == code
    )


def create_item(
    client,
    headers,
    *,
    code: str,
    name: str = "测试物资",
    category: str = "OTHER",
    base_unit: str = "个",
    minimum: str | int = "0",
    target: str | int = "0",
    specification: str | None = None,
    is_consumable: bool = True,
    expect: int = 201,
) -> dict:
    payload: dict = {
        "item_code": code,
        "name": name,
        "category": category,
        "base_unit": base_unit,
        "minimum_stock": str(minimum),
        "target_stock": str(target),
        "is_consumable": is_consumable,
    }
    if specification is not None:
        payload["specification"] = specification
    resp = client.post(
        "/api/v1/inventory/items", json=payload, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def patch_item(
    client,
    headers,
    item_id: int,
    payload: dict,
    expect: int = 200,
) -> dict:
    resp = client.patch(
        f"/api/v1/inventory/items/{item_id}", json=payload, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def get_item(client, headers, item_id: int, expect: int = 200) -> dict:
    resp = client.get(
        f"/api/v1/inventory/items/{item_id}", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def list_items(
    client,
    headers,
    params: dict | None = None,
    expect: int = 200,
) -> dict:
    resp = client.get(
        "/api/v1/inventory/items",
        params={**(params or {}), "page_size": 100},
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def initial_stock(
    client,
    headers,
    item_id: int,
    location_id: int,
    quantity: str | int,
    reason: str | None = None,
    expect: int = 200,
) -> dict:
    payload: dict = {"location_id": location_id, "quantity": str(quantity)}
    if reason is not None:
        payload["reason"] = reason
    resp = client.post(
        f"/api/v1/inventory/items/{item_id}/initial-stock",
        json=payload,
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def issue(
    client,
    headers,
    source_location_id: int,
    lines: list[dict],
    *,
    destination_type: str = "HOUSEKEEPING",
    room_id: int | None = None,
    notes: str | None = None,
    expect: int = 201,
) -> dict:
    payload: dict = {
        "source_location_id": source_location_id,
        "destination_type": destination_type,
        "lines": [
            {"item_id": line["item_id"], "quantity": str(line["quantity"])}
            for line in lines
        ],
    }
    if room_id is not None:
        payload["room_id"] = room_id
    if notes is not None:
        payload["notes"] = notes
    resp = client.post("/api/v1/inventory/issues", json=payload, headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


def stock_return(
    client,
    headers,
    item_id: int,
    location_id: int,
    quantity: str | int,
    reason: str = "归还",
    expect: int = 200,
) -> dict:
    resp = client.post(
        "/api/v1/inventory/returns",
        json={
            "item_id": item_id,
            "location_id": location_id,
            "quantity": str(quantity),
            "reason": reason,
        },
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def transfer(
    client,
    headers,
    source_location_id: int,
    destination_location_id: int,
    lines: list[dict],
    reason: str | None = None,
    expect: int = 200,
) -> dict:
    payload: dict = {
        "source_location_id": source_location_id,
        "destination_location_id": destination_location_id,
        "lines": [
            {"item_id": line["item_id"], "quantity": str(line["quantity"])}
            for line in lines
        ],
    }
    if reason is not None:
        payload["reason"] = reason
    resp = client.post(
        "/api/v1/inventory/transfers", json=payload, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def stocktake(
    client,
    headers,
    item_id: int,
    location_id: int,
    actual: str | int,
    reason: str = "月度盘点",
    expect: int = 200,
) -> dict:
    resp = client.post(
        "/api/v1/inventory/stocktakes",
        json={
            "item_id": item_id,
            "location_id": location_id,
            "actual_quantity": str(actual),
            "reason": reason,
        },
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def list_balances(
    client,
    headers,
    item_id: int | None = None,
    location_id: int | None = None,
) -> list[dict]:
    params: dict = {"page_size": 100}
    if item_id is not None:
        params["item_id"] = item_id
    if location_id is not None:
        params["location_id"] = location_id
    resp = client.get(
        "/api/v1/inventory/balances", params=params, headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def balance_for(
    client, headers, item_id: int, location_id: int
) -> Decimal | None:
    for row in list_balances(client, headers, item_id, location_id):
        if row["item_id"] == item_id and row["location_id"] == location_id:
            return Decimal(row["quantity"])
    return None


def list_movements(
    client,
    headers,
    item_id: int | None = None,
    location_id: int | None = None,
    movement_type: str | None = None,
    reference_type: str | None = None,
) -> list[dict]:
    params: dict = {"page_size": 100}
    if item_id is not None:
        params["item_id"] = item_id
    if location_id is not None:
        params["location_id"] = location_id
    if movement_type is not None:
        params["movement_type"] = movement_type
    if reference_type is not None:
        params["reference_type"] = reference_type
    resp = client.get(
        "/api/v1/inventory/movements", params=params, headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def movement_ids(
    client, headers, item_id: int, location_id: int
) -> list[int]:
    return [
        m["id"]
        for m in list_movements(client, headers, item_id, location_id)
    ]


# ---------------------------------------------------------------------------
# Procurement
# ---------------------------------------------------------------------------


def create_supplier(
    client,
    headers,
    *,
    code: str,
    name: str = "测试供应商",
    phone: str | None = None,
    expect: int = 201,
) -> dict:
    payload: dict = {"supplier_code": code, "name": name}
    if phone is not None:
        payload["phone"] = phone
    resp = client.post(
        "/api/v1/procurement/suppliers", json=payload, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def list_suppliers(client, headers, params: dict | None = None) -> list[dict]:
    resp = client.get(
        "/api/v1/procurement/suppliers",
        params={**(params or {}), "page_size": 100},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def create_request(
    client,
    headers,
    lines: list[dict],
    notes: str | None = None,
    expect: int = 201,
) -> dict:
    payload: dict = {
        "lines": [
            {"item_id": line["item_id"], "quantity": str(line["quantity"])}
            for line in lines
        ]
    }
    if notes is not None:
        payload["notes"] = notes
    resp = client.post(
        "/api/v1/procurement/requests", json=payload, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def request_action(
    client, headers, request_id: int, action: str, expect: int = 200
) -> dict:
    resp = client.post(
        f"/api/v1/procurement/requests/{request_id}/{action}", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def get_request(client, headers, request_id: int, expect: int = 200) -> dict:
    resp = client.get(
        f"/api/v1/procurement/requests/{request_id}", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def list_requests(client, headers, params: dict | None = None) -> list[dict]:
    resp = client.get(
        "/api/v1/procurement/requests",
        params={**(params or {}), "page_size": 100},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def create_order(
    client,
    headers,
    supplier_id: int,
    *,
    lines: list[dict] | None = None,
    purchase_request_id: int | None = None,
    unit_prices: dict[int, str] | None = None,
    expect: int = 201,
) -> dict:
    payload: dict = {"supplier_id": supplier_id}
    if purchase_request_id is not None:
        payload["purchase_request_id"] = purchase_request_id
    if lines is not None:
        payload["lines"] = [
            {
                "item_id": line["item_id"],
                "ordered_quantity": str(line["ordered_quantity"]),
                "unit_price": (
                    unit_prices.get(line["item_id"])
                    if unit_prices and line["item_id"] in unit_prices
                    else None
                ),
            }
            for line in lines
        ]
    resp = client.post(
        "/api/v1/procurement/orders", json=payload, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def order_action(
    client, headers, order_id: int, action: str, expect: int = 200
) -> dict:
    resp = client.post(
        f"/api/v1/procurement/orders/{order_id}/{action}", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def receive(
    client,
    headers,
    order_id: int,
    inventory_location_id: int,
    lines: list[dict],
    expect: int = 201,
) -> dict:
    resp = client.post(
        f"/api/v1/procurement/orders/{order_id}/receipts",
        json={
            "inventory_location_id": inventory_location_id,
            "lines": [
                {
                    "purchase_order_line_id": line["purchase_order_line_id"],
                    "received_quantity": str(line["received_quantity"]),
                }
                for line in lines
            ],
        },
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def get_order(client, headers, order_id: int, expect: int = 200) -> dict:
    resp = client.get(
        f"/api/v1/procurement/orders/{order_id}", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def list_orders(client, headers, params: dict | None = None) -> list[dict]:
    resp = client.get(
        "/api/v1/procurement/orders",
        params={**(params or {}), "page_size": 100},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def po_line(order: dict, item_id: int) -> dict:
    return next(line for line in order["lines"] if line["item_id"] == item_id)
