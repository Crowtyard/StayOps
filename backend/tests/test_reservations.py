# -*- coding: utf-8 -*-
"""Reservation CRUD / 筛选 / 校验 / cancel / no-show / PATCH 编辑测试。

日期一律基于 Property Business Date 动态生成（REV-03）。
"""

import re

from tests.booking_helpers import (
    check_in,
    create_guest,
    create_reservation,
    d,
    find_room,
    iso,
    today,
)

RESERVATION_NO_RE = re.compile(r"^RSV\d{8}-\d{4,}$")


def test_create_reservation_echo(client, admin_headers):
    guest = create_guest(client, admin_headers, name="预订客人")
    room = find_room(client, admin_headers, "203")
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": iso(today()),
            "check_out_date": iso(d(2)),
            "source": "WECHAT",
            "external_reference": "WX-1001",
            "agreed_total_amount": "688.50",
            "notes": "需要婴儿床",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert RESERVATION_NO_RE.match(body["reservation_no"])
    assert body["status"] == "CONFIRMED"
    assert body["source"] == "WECHAT"
    assert body["agreed_total_amount"] == "688.50"  # Decimal -> JSON 字符串
    assert body["currency"] == "CNY"
    assert body["room_number"] == "203"
    assert body["room_type_name"] is not None
    assert body["guest_name"] == "预订客人"
    # response_model_exclude_none：未产生 Stay 时 stay_id 键不出现
    assert "stay_id" not in body


def test_create_reservation_defaults(client, admin_headers):
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "204")
    body = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    assert body["source"] == "DIRECT"
    assert body["currency"] == "CNY"
    assert body["agreed_total_amount"] == "399.00"


def test_create_reservation_date_validation(client, admin_headers):
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "205")
    # co == ci -> 422
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": iso(today()),
            "check_out_date": iso(today()),
            "agreed_total_amount": "100.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422
    # co < ci -> 422
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": iso(d(2)),
            "check_out_date": iso(today()),
            "agreed_total_amount": "100.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422
    # 格式错误 -> 422
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": "2026/08/30",
            "check_out_date": iso(d(2)),
            "agreed_total_amount": "100.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_create_reservation_404s(client, admin_headers):
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "206")
    base = {
        "guest_id": guest["id"],
        "room_id": room["id"],
        "room_type_id": room["room_type_id"],
        "check_in_date": iso(today()),
        "check_out_date": iso(d(2)),
        "agreed_total_amount": "100.00",
    }
    assert (
        client.post(
            "/api/v1/reservations",
            json={**base, "guest_id": 99999},
            headers=admin_headers,
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/v1/reservations",
            json={**base, "room_id": 99999},
            headers=admin_headers,
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/v1/reservations",
            json={**base, "room_type_id": 99999},
            headers=admin_headers,
        ).status_code
        == 404
    )


def test_room_room_type_consistency_create_422(client, admin_headers):
    """reservation.room_type_id 必须等于 room.room_type_id（REV-FINAL-06）。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "207")
    other_type_id = next(
        i for i in range(1, 10) if i != room["room_type_id"]
    )
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": other_type_id,
            "check_in_date": iso(today()),
            "check_out_date": iso(d(2)),
            "agreed_total_amount": "100.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422
    assert "不一致" in resp.json()["detail"]


def test_adjacent_reservations_allowed(client, admin_headers):
    """[ci, co) 紧邻可共存：A=[today, today+2) 与 B=[today+2, today+4)。"""
    guest = create_guest(client, admin_headers, name="紧邻客人")
    room = find_room(client, admin_headers, "208")
    create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(2),
        check_out=d(4),
    )


def test_overlap_reservation_409(client, admin_headers):
    """重叠 -> 409（应用层预检；数据库排他约束为最终仲裁，见并发测试）。"""
    guest = create_guest(client, admin_headers, name="重叠客人")
    room = find_room(client, admin_headers, "209")
    create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": iso(d(1)),
            "check_out_date": iso(d(3)),
            "agreed_total_amount": "100.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert "已被预订" in resp.json()["detail"]


def test_list_and_filters(client, admin_headers):
    guest_a = create_guest(client, admin_headers, name="筛选甲", phone="13511110000")
    guest_b = create_guest(client, admin_headers, name="筛选乙", phone="13522220000")
    room = find_room(client, admin_headers, "210")
    res_a = create_reservation(
        client, admin_headers, room=room, guest_id=guest_a["id"], source="PHONE"
    )
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest_b["id"],
        check_in=d(2),
        check_out=d(4),
        source="OTA",
    )
    # status
    body = client.get(
        "/api/v1/reservations",
        params={"status": "CONFIRMED", "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(item["status"] == "CONFIRMED" for item in body["items"])
    # room_id
    body = client.get(
        "/api/v1/reservations",
        params={"room_id": room["id"], "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(item["room_id"] == room["id"] for item in body["items"])
    # guest_id
    body = client.get(
        "/api/v1/reservations",
        params={"guest_id": guest_a["id"], "page_size": 100},
        headers=admin_headers,
    ).json()
    assert [item["id"] for item in body["items"]] == [res_a["id"]]
    # source
    body = client.get(
        "/api/v1/reservations",
        params={"source": "PHONE", "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(item["source"] == "PHONE" for item in body["items"])
    # check_in_date
    body = client.get(
        "/api/v1/reservations",
        params={"check_in_date": iso(today()), "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(item["check_in_date"] == iso(today()) for item in body["items"])
    # check_out_date
    body = client.get(
        "/api/v1/reservations",
        params={"check_out_date": iso(d(4)), "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(item["check_out_date"] == iso(d(4)) for item in body["items"])
    # room_type_id
    body = client.get(
        "/api/v1/reservations",
        params={"room_type_id": room["room_type_id"], "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(item["room_type_id"] == room["room_type_id"] for item in body["items"])


def test_reservation_search(client, admin_headers):
    guest = create_guest(client, admin_headers, name="搜索目标", phone="18899990000")
    room = find_room(client, admin_headers, "301")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    # 按 reservation_no
    body = client.get(
        "/api/v1/reservations",
        params={"search": res["reservation_no"][-6:]},
        headers=admin_headers,
    ).json()
    assert any(item["id"] == res["id"] for item in body["items"])
    # 按 Guest name
    body = client.get(
        "/api/v1/reservations",
        params={"search": "搜索目标"},
        headers=admin_headers,
    ).json()
    assert any(item["id"] == res["id"] for item in body["items"])
    # 按 Guest phone
    body = client.get(
        "/api/v1/reservations",
        params={"search": "1889999"},
        headers=admin_headers,
    ).json()
    assert any(item["id"] == res["id"] for item in body["items"])


def test_reservation_get_and_404(client, admin_headers):
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "302")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    body = client.get(
        f"/api/v1/reservations/{res['id']}", headers=admin_headers
    )
    assert body.status_code == 200
    assert body.json()["reservation_no"] == res["reservation_no"]
    assert (
        client.get("/api/v1/reservations/99999", headers=admin_headers).status_code
        == 404
    )


def test_walk_in_default_dates(client, admin_headers):
    """WALK_IN：不传日期默认 [business_date, business_date+1)。"""
    guest = create_guest(client, admin_headers, name="散客")
    room = find_room(client, admin_headers, "303")
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "source": "WALK_IN",
            "agreed_total_amount": "328.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["check_in_date"] == iso(today())
    assert body["check_out_date"] == iso(d(1))


def test_walk_in_future_date_422(client, admin_headers):
    guest = create_guest(client, admin_headers, name="散客2")
    room = find_room(client, admin_headers, "304")
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": iso(d(1)),
            "check_out_date": iso(d(2)),
            "source": "WALK_IN",
            "agreed_total_amount": "328.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_cancel_flow(client, admin_headers):
    guest = create_guest(client, admin_headers, name="取消客人")
    room = find_room(client, admin_headers, "305")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/cancel", headers=admin_headers
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "CANCELLED"
    # 重复 cancel -> 409
    resp2 = client.post(
        f"/api/v1/reservations/{res['id']}/cancel", headers=admin_headers
    )
    assert resp2.status_code == 409
    # CANCELLED 后 check-in -> 409
    check_in_resp = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
    )
    assert check_in_resp.status_code == 409


def test_cancel_releases_dates(client, admin_headers):
    """CANCELLED 不再阻塞新预订（部分排他约束语义）。"""
    guest = create_guest(client, admin_headers, name="取消释放客人")
    room = find_room(client, admin_headers, "306")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    client.post(f"/api/v1/reservations/{res['id']}/cancel", headers=admin_headers)
    create_reservation(client, admin_headers, room=room, guest_id=guest["id"])


def test_no_show_future_409(client, admin_headers):
    """未来预订提前 No-show -> 409（REV-FINAL-02）。"""
    guest = create_guest(client, admin_headers, name="未来客人")
    room = find_room(client, admin_headers, "307")
    res = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(2),
        check_out=d(4),
    )
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/no-show", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "未到入住日期" in resp.json()["detail"]


def test_no_show_valid_then_checkin_409(client, admin_headers):
    guest = create_guest(client, admin_headers, name="未到店客人")
    room = find_room(client, admin_headers, "308")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/no-show", headers=admin_headers
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "NO_SHOW"
    # NO_SHOW 后 check-in -> 409
    assert (
        client.post(
            f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
        ).status_code
        == 409
    )
    # NO_SHOW 后 cancel -> 409
    assert (
        client.post(
            f"/api/v1/reservations/{res['id']}/cancel", headers=admin_headers
        ).status_code
        == 409
    )
    # NO_SHOW 后 PATCH -> 409
    assert (
        client.patch(
            f"/api/v1/reservations/{res['id']}",
            json={"notes": "改备注"},
            headers=admin_headers,
        ).status_code
        == 409
    )


def test_patch_confirmed_dates_and_amount(client, admin_headers):
    guest = create_guest(client, admin_headers, name="改期客人")
    room = find_room(client, admin_headers, "101")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={
            "check_in_date": iso(d(3)),
            "check_out_date": iso(d(5)),
            "agreed_total_amount": "456.78",
            "notes": "改期后的备注",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["check_in_date"] == iso(d(3))
    assert body["check_out_date"] == iso(d(5))
    assert body["agreed_total_amount"] == "456.78"
    assert body["notes"] == "改期后的备注"


def test_patch_to_overlapping_dates_409(client, admin_headers):
    guest = create_guest(client, admin_headers, name="改期冲突客人")
    room = find_room(client, admin_headers, "102")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    # 第二笔预订占据 [today+3, today+5)
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(3),
        check_out=d(5),
    )
    # 把第一笔改到重叠区间 -> 409
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"check_in_date": iso(d(4)), "check_out_date": iso(d(6))},
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert "已被预订" in resp.json()["detail"]
    # 原日期不变
    body = client.get(
        f"/api/v1/reservations/{res['id']}", headers=admin_headers
    ).json()
    assert body["check_in_date"] == iso(today())


def test_patch_change_room_revalidates(client, admin_headers):
    guest = create_guest(client, admin_headers, name="换房客人")
    room_a = find_room(client, admin_headers, "103")
    room_b = find_room(client, admin_headers, "109")
    res = create_reservation(client, admin_headers, room=room_a, guest_id=guest["id"])
    # 换到空闲房 109 -> 成功（room_type_id 同步修改保持一致）
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"room_id": room_b["id"], "room_type_id": room_b["room_type_id"]},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["room_id"] == room_b["id"]
    assert resp.json()["room_type_id"] == room_b["room_type_id"]
    # 换到被占用的 103 -> 409（103 已被同区间第二笔预订占用）
    create_reservation(client, admin_headers, room=room_a, guest_id=guest["id"])
    resp2 = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"room_id": room_a["id"], "room_type_id": room_a["room_type_id"]},
        headers=admin_headers,
    )
    assert resp2.status_code == 409


def test_patch_room_type_mismatch_422(client, admin_headers):
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "110")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    other_type_id = next(i for i in range(1, 10) if i != room["room_type_id"])
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"room_type_id": other_type_id},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_patch_partial_dates_combined_validation(client, admin_headers):
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "201")
    res = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(2),
        check_out=d(4),
    )
    # 只改 check_out 早于现有 check_in -> 422
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"check_out_date": iso(today())},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_patch_checked_in_409(client, admin_headers):
    guest = create_guest(client, admin_headers, name="在住编辑客人")
    room = find_room(client, admin_headers, "202")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    check_in(client, admin_headers, res["id"])
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"notes": "在住后改"},
        headers=admin_headers,
    )
    assert resp.status_code == 409


def test_patch_status_field_rejected_422(client, admin_headers):
    """S2T1-BLK-01：status 只能经专用 action 端点变更，PATCH 携带 status -> 422。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "204")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"status": "CANCELLED"},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    body = client.get(
        f"/api/v1/reservations/{res['id']}", headers=admin_headers
    ).json()
    assert body["status"] == "CONFIRMED"


def test_patch_unknown_field_rejected_422(client, admin_headers):
    """S2T1-BLK-01：未知字段 -> 422（strict schema，禁止静默忽略）。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "206")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"bogus_field": 123},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_patch_mixed_status_and_notes_atomic_422(client, admin_headers):
    """S2T1-BLK-01：混合 payload（status + notes）整体 422，notes/status 均无变化。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "207")
    res = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"], notes="原始备注"
    )
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"status": "CANCELLED", "notes": "should-not-save"},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    body = client.get(
        f"/api/v1/reservations/{res['id']}", headers=admin_headers
    ).json()
    assert body["status"] == "CONFIRMED"
    assert body["notes"] == "原始备注"


def test_patch_empty_payload_422(client, admin_headers):
    """S2T1-BLK-01：空 PATCH {} -> 422，不得返回伪成功。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "208")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}", json={}, headers=admin_headers
    )
    assert resp.status_code == 422


def test_patch_valid_notes_success(client, admin_headers):
    """合法 PATCH（仅 notes）-> 200，行为保持不变。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "209")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    resp = client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"notes": "valid"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["notes"] == "valid"


def test_reservation_pagination(client, admin_headers):
    guest = create_guest(client, admin_headers)
    rooms = client.get(
        "/api/v1/rooms", params={"page_size": 100}, headers=admin_headers
    ).json()["items"]
    for room in rooms[:3]:
        create_reservation(
            client,
            admin_headers,
            room=room,
            guest_id=guest["id"],
            check_in=d(10),
            check_out=d(12),
        )
    page1 = client.get(
        "/api/v1/reservations", params={"page": 1, "page_size": 2},
        headers=admin_headers,
    ).json()
    assert len(page1["items"]) == 2
    assert page1["total"] >= 3
    page2 = client.get(
        "/api/v1/reservations", params={"page": 2, "page_size": 2},
        headers=admin_headers,
    ).json()
    assert len(page2["items"]) >= 1
    ids1 = {r["id"] for r in page1["items"]}
    ids2 = {r["id"] for r in page2["items"]}
    assert ids1.isdisjoint(ids2)
