# -*- coding: utf-8 -*-
"""Availability 引擎测试（总纲 §6）。

排除：重叠 CONFIRMED/CHECKED_IN、Active Stay、blocked、out_of_service；
区间含业务日期当天时 occupied / reserved；未来预订不要求 clean；
COMPLETED 不再阻塞（提前退房释放剩余日期，REV-01）。
"""

from tests.booking_helpers import (
    check_in,
    check_out,
    create_guest,
    create_reservation,
    d,
    find_room,
    iso,
    today,
)


def _availability(client, headers, check_in, check_out, **params):
    resp = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": iso(check_in),
            "check_out_date": iso(check_out),
            **params,
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _room_item(body: dict, room_number: str) -> dict:
    return next(
        item for item in body["items"] if item["room_number"] == room_number
    )


def test_availability_basic_all_available(client, admin_headers):
    body = _availability(client, admin_headers, today(), d(2))
    assert body["total"] == 28
    assert body["available_count"] == 28
    assert body["business_date"] == iso(today())
    assert all(item["available"] for item in body["items"])


def test_availability_room_type_filter(client, admin_headers):
    body = _availability(
        client, admin_headers, today(), d(2), room_type_id=1
    )
    assert body["total"] > 0
    assert all(item["room_type_id"] == 1 for item in body["items"])


def test_availability_invalid_dates_422(client, admin_headers):
    resp = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": iso(d(2)),
            "check_out_date": iso(today()),
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422
    resp = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": "not-a-date",
            "check_out_date": iso(d(2)),
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422


def _set_room_status(client, headers, room_id: int, **fields):
    resp = client.post(
        f"/api/v1/rooms/{room_id}/status", json=fields, headers=headers
    )
    assert resp.status_code == 200, resp.text


def test_availability_blocked_and_out_of_service_excluded(
    client, admin_headers
):
    blocked = find_room(client, admin_headers, "104")
    oos = find_room(client, admin_headers, "105")
    _set_room_status(client, admin_headers, blocked["id"], occupancy_status="blocked")
    _set_room_status(
        client, admin_headers, oos["id"], occupancy_status="out_of_service"
    )
    body = _availability(client, admin_headers, d(1), d(3))
    assert _room_item(body, "104")["available"] is False
    assert "blocked" in _room_item(body, "104")["reason"]
    assert _room_item(body, "105")["available"] is False
    assert "out_of_service" in _room_item(body, "105")["reason"]
    assert body["available_count"] == 26


def test_availability_occupied_only_excluded_when_range_includes_today(
    client, admin_headers
):
    room = find_room(client, admin_headers, "106")
    _set_room_status(client, admin_headers, room["id"], occupancy_status="occupied")
    # 区间包含今天 -> 排除
    body_today = _availability(client, admin_headers, today(), d(2))
    assert _room_item(body_today, "106")["available"] is False
    # 未来区间（不含今天）-> 不因当前 occupied 排除（未来可售性由日期区间决定）
    body_future = _availability(client, admin_headers, d(1), d(3))
    assert _room_item(body_future, "106")["available"] is True


def test_availability_reserved_only_excluded_when_range_includes_today(
    client, admin_headers
):
    room = find_room(client, admin_headers, "107")
    _set_room_status(client, admin_headers, room["id"], occupancy_status="reserved")
    body_today = _availability(client, admin_headers, today(), d(2))
    assert _room_item(body_today, "107")["available"] is False
    body_future = _availability(client, admin_headers, d(1), d(3))
    assert _room_item(body_future, "107")["available"] is True


def test_availability_future_reservation_does_not_require_clean(
    client, admin_headers
):
    """未来预订不要求 cleaning_status=clean（Clean 要求只在 Check-in 当下）。"""
    room = find_room(client, admin_headers, "108")
    _set_room_status(client, admin_headers, room["id"], cleaning_status="dirty")
    body = _availability(client, admin_headers, d(1), d(3))
    assert _room_item(body, "108")["available"] is True
    # 脏房仍可创建未来预订
    guest = create_guest(client, admin_headers, name="脏房预订客人")
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(1),
        check_out=d(3),
    )


def test_availability_active_stay_overlap_excluded(client, admin_headers):
    """Active Stay 按其 [实际入住日, planned_check_out_date) 区间排除。"""
    room = find_room(client, admin_headers, "203")
    guest = create_guest(client, admin_headers, name="在住客人")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    check_in(client, admin_headers, res["id"])
    # 与在住区间 [today, today+2) 重叠 -> 排除
    overlap = _availability(client, admin_headers, d(1), d(3))
    assert _room_item(overlap, "203")["available"] is False
    # 紧邻（[today+2, today+4)）-> 不重叠，可售
    adjacent = _availability(client, admin_headers, d(2), d(4))
    assert _room_item(adjacent, "203")["available"] is True


def test_availability_completed_does_not_block(client, admin_headers):
    """提前退房后 Reservation=COMPLETED，释放原计划剩余日期（REV-01）。"""
    room = find_room(client, admin_headers, "201")
    guest = create_guest(client, admin_headers, name="提前退房客人")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    body = check_in(client, admin_headers, res["id"])
    check_out(client, admin_headers, body["stay"]["id"])
    avail = _availability(client, admin_headers, d(1), d(3))
    assert _room_item(avail, "201")["available"] is True
    # B = [today+1, today+3) 可再预订
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(1),
        check_out=d(3),
    )
