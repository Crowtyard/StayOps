# -*- coding: utf-8 -*-
"""Booking PII / 权限裁剪测试（REV-02 / REV-FINAL-04）。

- 无 guest:read：各出口不含 name / phone / email / Guest notes / guest_name
  （仅保留 guest_id）
- 无 reservation:read：不含 reservation_no / 日期 / 金额 / source / status 等
- 审计 details 不含 PII（手机号 / 邮箱 / Guest notes / Reservation notes / 金额值）
"""

import json

from tests.booking_helpers import (
    check_in,
    create_guest,
    create_reservation,
    d,
    find_room,
    iso,
    today,
)


def _make_role_user(
    client, admin_headers, make_user, token_for, username, permission_codes
) -> dict:
    """创建持有指定权限集合的用户，返回其 headers。"""
    perms = client.get(
        "/api/v1/permissions", params={"page_size": 100}, headers=admin_headers
    ).json()["items"]
    by_code = {p["code"]: p["id"] for p in perms}
    role = client.post(
        "/api/v1/roles",
        json={"name": f"ROLE_{username}"},
        headers=admin_headers,
    )
    assert role.status_code == 201, role.text
    client.post(
        f"/api/v1/roles/{role.json()['id']}/permissions",
        json={"permission_ids": [by_code[c] for c in permission_codes]},
        headers=admin_headers,
    )
    make_user(username, role_names=[f"ROLE_{username}"])
    return {"Authorization": f"Bearer {token_for(username)}"}


def _not_as_field(obj, key) -> bool:
    """任意嵌套 dict 的键名含目标字段即失败。"""
    if isinstance(obj, dict):
        for k in obj.keys():
            if k == key:
                return False
            if not _not_as_field(obj[k], key):
                return False
    elif isinstance(obj, list):
        for item in obj:
            if not _not_as_field(item, key):
                return False
    return True


def test_stay_read_only_user_no_guest_no_reservation(
    client, admin_headers, make_user, token_for
):
    """stay:read 但无 guest:read / reservation:read：仅 stay 自身字段 + guest_id。"""
    guest = create_guest(client, admin_headers, name="隐私客人", phone="13300001111")
    room = find_room(client, admin_headers, "205")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    check_in(client, admin_headers, res["id"])
    h = _make_role_user(
        client, admin_headers, make_user, token_for, "stay_only", ["stay:read"]
    )
    body = client.get("/api/v1/stays", params={"page_size": 100}, headers=h).json()
    assert body["total"] >= 1
    item = next(i for i in body["items"] if i["reservation_id"] == res["id"])
    assert "guest_id" in item
    assert _not_as_field(item, "guest_name")
    assert _not_as_field(item, "phone")
    assert _not_as_field(item, "email")
    assert "reservation" not in item
    # 无 reservation:read -> 无 reservation_no（包括嵌套）
    assert _not_as_field(item, "reservation_no")
    # 访问预订端点整体 403
    assert client.get("/api/v1/reservations", headers=h).status_code == 403
    assert client.get("/api/v1/guests", headers=h).status_code == 403


def test_reservation_read_only_user_no_guest_name(
    client, admin_headers, make_user, token_for
):
    """reservation:read 但无 guest:read：无 guest_name，保留 guest_id 与金额。"""
    guest = create_guest(client, admin_headers, name="预订隐私客人", phone="13300002222")
    room = find_room(client, admin_headers, "206")
    create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    h = _make_role_user(
        client,
        admin_headers,
        make_user,
        token_for,
        "res_only",
        ["reservation:read"],
    )
    body = client.get(
        "/api/v1/reservations", params={"page_size": 100}, headers=h
    ).json()
    assert body["total"] >= 1
    item = body["items"][0]
    assert "reservation_no" in item
    assert "agreed_total_amount" in item
    assert "guest_id" in item
    assert _not_as_field(item, "guest_name")
    # search 按 Guest name 命中仍可用，但响应不含 PII
    found = client.get(
        "/api/v1/reservations",
        params={"search": "预订隐私客人", "page_size": 100},
        headers=h,
    ).json()
    assert found["total"] >= 1
    assert _not_as_field(found["items"][0], "guest_name")


def test_audit_details_contain_no_pii(client, admin_headers, db):
    """审计 details 不含手机号/邮箱/Guest notes/Reservation notes/金额值。"""
    from sqlalchemy import select

    from app.models import AuditLog

    phone = "17755556666"
    email = "pii-probe@example.com"
    guest_notes = "GUEST-NOTES-PROBE"
    res_notes = "RES-NOTES-PROBE"
    create_amount = "111.11"
    update_amount = "777.77"

    guest = create_guest(
        client,
        admin_headers,
        name="审计隐私客人",
        phone=phone,
        email=email,
        notes=guest_notes,
    )
    client.patch(
        f"/api/v1/guests/{guest['id']}",
        json={"phone": phone, "email": email, "notes": guest_notes},
        headers=admin_headers,
    )
    room = find_room(client, admin_headers, "207")
    res = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        amount=create_amount,
    )
    client.patch(
        f"/api/v1/reservations/{res['id']}",
        json={"agreed_total_amount": update_amount, "notes": res_notes},
        headers=admin_headers,
    )

    rows = db.scalars(
        select(AuditLog).where(
            AuditLog.action.in_(
                [
                    "guest.create",
                    "guest.update",
                    "reservation.create",
                    "reservation.update",
                ]
            )
        )
    ).all()
    assert rows, "应有 booking 审计记录"
    for row in rows:
        blob = json.dumps(row.details, ensure_ascii=False)
        assert phone not in blob, f"审计泄漏手机号: {blob}"
        assert email not in blob, f"审计泄漏邮箱: {blob}"
        assert guest_notes not in blob, f"审计泄漏 Guest notes: {blob}"
        assert res_notes not in blob, f"审计泄漏 Reservation notes: {blob}"
        assert create_amount not in blob, f"审计泄漏金额: {blob}"
        assert update_amount not in blob, f"审计泄漏金额: {blob}"
    # reservation.update 的金额只记录「金额已更新」摘要
    update_rows = [
        r for r in rows if r.action == "reservation.update"
    ]
    assert update_rows
    assert any(
        "金额已更新" in json.dumps(r.details, ensure_ascii=False)
        for r in update_rows
    )


def test_reservation_detail_no_guest_without_permission(
    client, admin_headers, make_user, token_for
):
    """GET /reservations/{id}（无 guest:read）：guest_name 不出现。"""
    guest = create_guest(client, admin_headers, name="详情隐私客人")
    room = find_room(client, admin_headers, "208")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    h = _make_role_user(
        client,
        admin_headers,
        make_user,
        token_for,
        "res_detail",
        ["reservation:read"],
    )
    body = client.get(f"/api/v1/reservations/{res['id']}", headers=h).json()
    assert "guest_id" in body
    assert _not_as_field(body, "guest_name")


def test_check_in_response_no_guest_without_permission(
    client, admin_headers, make_user, token_for
):
    """Check-in 响应（无 guest:read 的操作者）：reservation/stay 均无 guest_name。"""
    guest = create_guest(client, admin_headers, name="入住隐私客人")
    room = find_room(client, admin_headers, "210")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    h = _make_role_user(
        client,
        admin_headers,
        make_user,
        token_for,
        "checkin_no_guest",
        ["reservation:read", "reservation:write", "stay:check_in", "stay:read"],
    )
    body = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=h
    ).json()
    assert _not_as_field(body["reservation"], "guest_name")
    assert _not_as_field(body["stay"], "guest_name")
    assert body["stay"]["guest_id"] == guest["id"]
