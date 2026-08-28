# -*- coding: utf-8 -*-
"""Maintenance 测试共用工具（沿用 booking_helpers / hk_helpers 的真实链路风格）。"""

from tests.booking_helpers import find_room


def create_order(
    client,
    headers,
    *,
    room_id: int,
    category: str = "HVAC",
    severity: str = "MEDIUM",
    blocks_room: bool = False,
    source: str = "MANUAL",
    title: str = "测试维修工单",
    description: str | None = None,
    expect: int = 201,
) -> dict:
    payload: dict = {
        "room_id": room_id,
        "category": category,
        "severity": severity,
        "blocks_room": blocks_room,
        "source": source,
        "title": title,
    }
    if description is not None:
        payload["description"] = description
    resp = client.post("/api/v1/maintenance/orders", json=payload, headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


def order_action(
    client,
    headers,
    order_id: int,
    action: str,
    expect: int = 200,
    payload: dict | None = None,
) -> dict:
    """调用工单 action 端点（assign 除外：assign 走独立 helper）。

    action ∈ start / resolve / verify / rework / cancel；
    payload 为 None 时不携带 JSON body（空 body 调用）。
    """
    kwargs: dict = {}
    if payload is not None:
        kwargs["json"] = payload
    resp = client.post(
        f"/api/v1/maintenance/orders/{order_id}/{action}",
        headers=headers,
        **kwargs,
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def assign_order(
    client, headers, order_id: int, user_id: int, expect: int = 200
) -> dict:
    resp = client.post(
        f"/api/v1/maintenance/orders/{order_id}/assign",
        json={"assigned_to_user_id": user_id},
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def list_orders(client, headers, **params) -> dict:
    resp = client.get(
        "/api/v1/maintenance/orders", params=params, headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def get_order(client, headers, order_id: int, expect: int = 200) -> dict:
    resp = client.get(
        f"/api/v1/maintenance/orders/{order_id}", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def patch_order(
    client, headers, order_id: int, payload: dict, expect: int = 200
) -> dict:
    resp = client.patch(
        f"/api/v1/maintenance/orders/{order_id}",
        json=payload,
        headers=headers,
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def set_occupancy(client, headers, room_number: str, status_value: str) -> dict:
    """经房间状态 API 设置 occupancy_status（需要 room:write 或 room:status_maintenance）。"""
    room = find_room(client, headers, room_number)
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": status_value},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def room_state(client, headers, room_number: str) -> dict:
    return find_room(client, headers, room_number)


def make_dirty(client, headers, room_number: str) -> dict:
    room = find_room(client, headers, room_number)
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"cleaning_status": "dirty"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def me_user_id(client, headers) -> int:
    """当前登录用户 id（admin 持有全部权限，可作为派单目标）。"""
    resp = client.get("/api/v1/auth/me", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]
