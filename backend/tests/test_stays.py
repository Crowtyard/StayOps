# -*- coding: utf-8 -*-
"""Stay / Check-in / Check-out 测试。

覆盖：Golden Path、日期资格（REV-FINAL-01）、Dirty/Occupied 409、
重复 Check-in 409、Check-out 四联动、Early Checkout / COMPLETED、
Stay 列表筛选、终态语义。
"""

import re

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

STAY_NO_RE = re.compile(r"^STY\d{8}-\d{4,}$")


def test_check_in_golden(client, admin_headers, db):
    """入住成功：Reservation CHECKED_IN + Stay ACTIVE + Room occupied + 审计 四联动。"""
    from sqlalchemy import select

    from app.models import AuditLog

    guest = create_guest(client, admin_headers, name="入住客人")
    room = find_room(client, admin_headers, "203")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    body = check_in(client, admin_headers, res["id"])
    reservation = body["reservation"]
    stay = body["stay"]
    assert reservation["status"] == "CHECKED_IN"
    assert stay["status"] == "ACTIVE"
    assert STAY_NO_RE.match(stay["stay_no"])
    assert stay["reservation_id"] == res["id"]
    assert stay["room_id"] == room["id"]
    assert stay["planned_check_out_date"] == iso(d(2))
    assert stay["actual_check_in_at"] is not None
    # response_model_exclude_none：null 字段不出现在响应中
    assert "actual_check_out_at" not in stay
    assert stay["guest_name"] == "入住客人"

    room_body = client.get(f"/api/v1/rooms/{room['id']}", headers=admin_headers).json()
    assert room_body["occupancy_status"] == "occupied"
    assert room_body["cleaning_status"] == "clean"  # 入住不改变清洁状态

    audit = db.scalar(
        select(AuditLog)
        .where(
            AuditLog.action == "reservation.check_in",
            AuditLog.resource_id == res["id"],
        )
        .order_by(AuditLog.id.desc())
    )
    assert audit is not None
    assert audit.details["stay_no"] == stay["stay_no"]
    assert audit.details["from"] == "CONFIRMED"
    assert audit.details["to"] == "CHECKED_IN"


def test_check_in_early_409(client, admin_headers):
    """未来预订提前入住 -> 409（REV-FINAL-01）。"""
    guest = create_guest(client, admin_headers, name="提前客人")
    room = find_room(client, admin_headers, "101")
    res = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(1),
        check_out=d(3),
    )
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "未到入住日期" in resp.json()["detail"]


def test_check_in_expired_409(client, admin_headers):
    """已到/超过 check_out_date -> 409（REV-FINAL-01）。"""
    guest = create_guest(client, admin_headers, name="过期客人")
    room = find_room(client, admin_headers, "102")
    res = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(-3),
        check_out=d(-1),
    )
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "超过计划退房日期" in resp.json()["detail"]


def test_check_in_dirty_room_409(client, admin_headers):
    """Dirty room Check-in -> 409（Clean 要求只在 Check-in 当下）。"""
    guest = create_guest(client, admin_headers, name="脏房客人")
    room = find_room(client, admin_headers, "103")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"cleaning_status": "dirty"},
        headers=admin_headers,
    )
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "未清洁" in resp.json()["detail"]


def test_check_in_occupied_room_409(client, admin_headers):
    """Occupied room Check-in -> 409。"""
    guest = create_guest(client, admin_headers, name="占房客人")
    room = find_room(client, admin_headers, "104")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "occupied"},
        headers=admin_headers,
    )
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
    )
    assert resp.status_code == 409


def test_check_in_twice_409(client, admin_headers):
    guest = create_guest(client, admin_headers, name="重复入住客人")
    room = find_room(client, admin_headers, "105")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    check_in(client, admin_headers, res["id"])
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "仅 CONFIRMED" in resp.json()["detail"]


def test_check_out_golden(client, admin_headers, db):
    """退房：Stay CHECKED_OUT + Reservation COMPLETED + Room available+dirty + 审计。"""
    from sqlalchemy import select

    from app.models import AuditLog

    guest = create_guest(client, admin_headers, name="退房客人")
    room = find_room(client, admin_headers, "106")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked_in = check_in(client, admin_headers, res["id"])
    stay_id = checked_in["stay"]["id"]
    body = check_out(client, admin_headers, stay_id)
    assert body["status"] == "CHECKED_OUT"
    assert body["actual_check_out_at"] is not None
    assert body["reservation"]["status"] == "COMPLETED"

    reservation = client.get(
        f"/api/v1/reservations/{res['id']}", headers=admin_headers
    ).json()
    assert reservation["status"] == "COMPLETED"
    assert reservation["stay_id"] == stay_id

    room_body = client.get(f"/api/v1/rooms/{room['id']}", headers=admin_headers).json()
    assert room_body["occupancy_status"] == "available"
    assert room_body["cleaning_status"] == "dirty"

    audit = db.scalar(
        select(AuditLog)
        .where(
            AuditLog.action == "stay.check_out",
            AuditLog.resource_id == stay_id,
        )
        .order_by(AuditLog.id.desc())
    )
    assert audit is not None
    assert audit.details["reservation_from"] == "CHECKED_IN"
    assert audit.details["reservation_to"] == "COMPLETED"
    assert audit.details["stay_from"] == "ACTIVE"
    assert audit.details["stay_to"] == "CHECKED_OUT"


def test_check_out_twice_409(client, admin_headers):
    guest = create_guest(client, admin_headers, name="重复退房客人")
    room = find_room(client, admin_headers, "107")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked_in = check_in(client, admin_headers, res["id"])
    stay_id = checked_in["stay"]["id"]
    check_out(client, admin_headers, stay_id)
    resp = client.post(
        f"/api/v1/stays/{stay_id}/check-out", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "已退房" in resp.json()["detail"]


def test_early_checkout_releases_remaining_dates(client, admin_headers):
    """REV-FINAL-03：A=[today, today+2) 当天入住当天退房 -> COMPLETED；
    B=[today+1, today+3) 同房可再预订。"""
    guest = create_guest(client, admin_headers, name="提前退房客人")
    room = find_room(client, admin_headers, "108")
    res_a = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked_in = check_in(client, admin_headers, res_a["id"])
    check_out(client, admin_headers, checked_in["stay"]["id"])
    # COMPLETED 后原计划剩余日期被释放
    res_b = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(1),
        check_out=d(3),
    )
    assert res_b["status"] == "CONFIRMED"


def test_stay_list_and_filters(client, admin_headers):
    guest = create_guest(client, admin_headers, name="列表在住客人")
    room = find_room(client, admin_headers, "109")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked_in = check_in(client, admin_headers, res["id"])
    stay_id = checked_in["stay"]["id"]
    # status
    body = client.get(
        "/api/v1/stays",
        params={"status": "ACTIVE", "page_size": 100},
        headers=admin_headers,
    ).json()
    assert any(item["id"] == stay_id for item in body["items"])
    # room_id
    body = client.get(
        "/api/v1/stays",
        params={"room_id": room["id"], "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(item["room_id"] == room["id"] for item in body["items"])
    # planned_check_out_date
    body = client.get(
        "/api/v1/stays",
        params={"planned_check_out_date": iso(d(2)), "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(
        item["planned_check_out_date"] == iso(d(2)) for item in body["items"]
    )
    # 退房后 status=CHECKED_OUT 可查
    check_out(client, admin_headers, stay_id)
    body = client.get(
        "/api/v1/stays",
        params={"status": "CHECKED_OUT", "page_size": 100},
        headers=admin_headers,
    ).json()
    assert any(item["id"] == stay_id for item in body["items"])


def test_stay_detail_and_404(client, admin_headers):
    guest = create_guest(client, admin_headers, name="详情客人")
    room = find_room(client, admin_headers, "110")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked_in = check_in(client, admin_headers, res["id"])
    body = client.get(
        f"/api/v1/stays/{checked_in['stay']['id']}", headers=admin_headers
    )
    assert body.status_code == 200
    assert body.json()["status"] == "ACTIVE"
    assert body.json()["reservation"]["reservation_no"] == res["reservation_no"]
    assert (
        client.get("/api/v1/stays/99999", headers=admin_headers).status_code == 404
    )


def test_check_in_then_checkout_patch_409(client, admin_headers):
    """CHECKED_IN 后 PATCH 修改核心字段 -> 409；COMPLETED 后同样 409。"""
    guest = create_guest(client, admin_headers, name="终态编辑客人")
    room = find_room(client, admin_headers, "201")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked_in = check_in(client, admin_headers, res["id"])
    assert (
        client.patch(
            f"/api/v1/reservations/{res['id']}",
            json={"notes": "x"},
            headers=admin_headers,
        ).status_code
        == 409
    )
    check_out(client, admin_headers, checked_in["stay"]["id"])
    assert (
        client.patch(
            f"/api/v1/reservations/{res['id']}",
            json={"notes": "x"},
            headers=admin_headers,
        ).status_code
        == 409
    )
