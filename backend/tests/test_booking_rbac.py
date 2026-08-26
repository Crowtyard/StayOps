# -*- coding: utf-8 -*-
"""Booking RBAC 测试：9 新权限 × 角色矩阵、HOUSEKEEPING 全面 403、seed 幂等。"""

from tests.booking_helpers import d, iso, today

BOOKING_CODES = {
    "guest:read",
    "guest:write",
    "reservation:read",
    "reservation:write",
    "reservation:cancel",
    "reservation:no_show",
    "stay:read",
    "stay:check_in",
    "stay:check_out",
}

BOOKING_ENDPOINTS = [
    "/api/v1/guests",
    f"/api/v1/availability?check_in_date={iso(today())}&check_out_date={iso(d(2))}",
    "/api/v1/reservations",
    "/api/v1/stays",
]


def _codes_of(client, headers) -> set[str]:
    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    return set(me.json()["permissions"])


def test_manager_has_all_booking_permissions(client, make_user, token_for):
    make_user("mgr_booking", role_names=["MANAGER"])
    h = {"Authorization": f"Bearer {token_for('mgr_booking')}"}
    assert BOOKING_CODES <= _codes_of(client, h)


def test_front_desk_has_all_booking_permissions(client, make_user, token_for):
    make_user("fd_booking", role_names=["FRONT_DESK"])
    h = {"Authorization": f"Bearer {token_for('fd_booking')}"}
    assert BOOKING_CODES <= _codes_of(client, h)


def test_housekeeping_has_no_booking_permissions(client, make_user, token_for):
    make_user("hk_booking", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('hk_booking')}"}
    assert not (BOOKING_CODES & _codes_of(client, h))


def test_maintenance_and_finance_no_booking_permissions(
    client, make_user, token_for
):
    make_user("mt_booking", role_names=["MAINTENANCE"])
    make_user("fin_booking", role_names=["FINANCE"])
    mt = {"Authorization": f"Bearer {token_for('mt_booking')}"}
    fin = {"Authorization": f"Bearer {token_for('fin_booking')}"}
    assert not (BOOKING_CODES & _codes_of(client, mt))
    assert not (BOOKING_CODES & _codes_of(client, fin))


def test_housekeeping_booking_endpoints_403(client, make_user, token_for):
    make_user("hk_403", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('hk_403')}"}
    for path in BOOKING_ENDPOINTS:
        resp = client.get(path, headers=h)
        assert resp.status_code == 403, f"{path} 未返回 403"
    assert (
        client.post("/api/v1/guests", json={"name": "x"}, headers=h).status_code
        == 403
    )
    assert client.post("/api/v1/reservations", json={}, headers=h).status_code == 403
    assert (
        client.post("/api/v1/reservations/1/cancel", headers=h).status_code == 403
    )
    assert (
        client.post("/api/v1/reservations/1/no-show", headers=h).status_code == 403
    )
    assert (
        client.post("/api/v1/reservations/1/check-in", headers=h).status_code
        == 403
    )
    assert client.post("/api/v1/stays/1/check-out", headers=h).status_code == 403


def test_booking_endpoints_require_auth(client):
    for path in BOOKING_ENDPOINTS:
        assert client.get(path).status_code == 401, f"{path} 未返回 401"


def test_front_desk_booking_access_ok(client, admin_headers, make_user, token_for):
    """FRONT_DESK 可执行完整预订链路（权限 + 状态机共同裁决）。"""
    make_user("fd_flow", role_names=["FRONT_DESK"])
    h = {"Authorization": f"Bearer {token_for('fd_flow')}"}
    guest = client.post(
        "/api/v1/guests", json={"name": "前台客人"}, headers=h
    )
    assert guest.status_code == 201
    rooms = client.get(
        "/api/v1/rooms", params={"page_size": 100}, headers=h
    ).json()["items"]
    room = next(r for r in rooms if r["room_number"] == "209")
    res = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest.json()["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": iso(today()),
            "check_out_date": iso(d(2)),
            "agreed_total_amount": "299.00",
        },
        headers=h,
    )
    assert res.status_code == 201, res.text
    assert client.get("/api/v1/availability", params={
        "check_in_date": iso(today()), "check_out_date": iso(d(2)),
    }, headers=h).status_code == 200
