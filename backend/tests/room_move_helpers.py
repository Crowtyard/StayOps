# -*- coding: utf-8 -*-
"""Room Move 测试共用工具（Sprint 6，沿用 booking_helpers 真实链路风格）。"""

from tests.booking_helpers import (
    check_in as do_check_in,
    create_guest,
    create_reservation,
    find_room,
)


def setup_stay(
    client,
    headers,
    room_number: str,
    *,
    name: str = "换房客人",
    check_in=None,
    check_out=None,
) -> dict:
    """创建客人 + 预订（默认 [today, today+2)）+ Check-in，返回
    {"guest": ..., "reservation": ..., "stay": ..., "room": ...}。"""
    room = find_room(client, headers, room_number)
    guest = create_guest(client, headers, name=name)
    res = create_reservation(
        client,
        headers,
        room=room,
        guest_id=guest["id"],
        check_in=check_in,
        check_out=check_out,
    )
    body = do_check_in(client, headers, res["id"])
    return {
        "guest": guest,
        "reservation": body["reservation"],
        "stay": body["stay"],
        "room": room,
    }


def move(
    client,
    headers,
    stay_id: int,
    target_room_id: int,
    reason: str = "GUEST_REQUEST",
    notes: str | None = None,
    expect: int = 200,
) -> dict:
    payload: dict = {"target_room_id": target_room_id, "reason": reason}
    if notes is not None:
        payload["notes"] = notes
    resp = client.post(
        f"/api/v1/stays/{stay_id}/room-move", json=payload, headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def move_options(
    client, headers, stay_id: int, expect: int = 200
) -> dict:
    resp = client.get(
        f"/api/v1/stays/{stay_id}/room-move-options", headers=headers
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


def option_for(body: dict, room_number: str) -> dict:
    return next(
        item for item in body["items"] if item["room_number"] == room_number
    )
