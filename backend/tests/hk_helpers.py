# -*- coding: utf-8 -*-
"""Housekeeping 测试共用工具（沿用 booking_helpers 的真实链路风格）。"""

from tests.booking_helpers import find_room


def set_cleaning(client, headers, room_number: str, status_value: str) -> dict:
    """经房间状态 API 设置 cleaning_status（需要 room:write 或 room:status_cleaning）。"""
    room = find_room(client, headers, room_number)
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"cleaning_status": status_value},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def make_dirty(client, headers, room_number: str) -> dict:
    return set_cleaning(client, headers, room_number, "dirty")


def create_task(
    client,
    headers,
    room_id: int,
    expect=201,
    priority: str = "NORMAL",
    notes: str | None = None,
    **kwargs,
) -> dict:
    payload: dict = {"room_id": room_id, "priority": priority, **kwargs}
    if notes is not None:
        payload["notes"] = notes
    resp = client.post("/api/v1/housekeeping/tasks", json=payload, headers=headers)
    assert resp.status_code == expect, resp.text
    return resp.json()


def task_action(
    client, headers, task_id: int, action: str, expect=200
) -> dict:
    """调用任务 action 端点（start / submit-inspection / pass / rework / cancel）。"""
    resp = client.post(
        f"/api/v1/housekeeping/tasks/{task_id}/{action}", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def list_tasks(client, headers, **params) -> dict:
    resp = client.get(
        "/api/v1/housekeeping/tasks",
        params=params,
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def patch_task(client, headers, task_id: int, payload: dict, expect=200) -> dict:
    resp = client.patch(
        f"/api/v1/housekeeping/tasks/{task_id}", json=payload, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()
