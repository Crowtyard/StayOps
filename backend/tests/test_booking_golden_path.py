# -*- coding: utf-8 -*-
"""S2-T1 Golden Path（总纲 §2）：API 层完整链路。

Guest → Availability → Reservation → 重叠 409 → Check-in（四联动）
→ Check-out（四联动）→ 审计完整 → HOUSEKEEPING 无 PII。
日期一律基于 Property Business Date 动态生成。
"""

from sqlalchemy import select

from app.models import AuditLog
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


def test_golden_path_end_to_end(client, admin_headers, db, make_user, token_for):
    # 1) 创建客人（张先生）
    guest = create_guest(
        client, admin_headers, name="张先生", phone="13812345678"
    )

    # 2) Availability：203 在 [today, today+2) 可用
    avail = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": iso(today()),
            "check_out_date": iso(d(2)),
        },
        headers=admin_headers,
    ).json()
    room_item = next(
        item for item in avail["items"] if item["room_number"] == "203"
    )
    assert room_item["available"] is True

    # 3) 创建预订 203 [today, today+2)
    room = find_room(client, admin_headers, "203")
    reservation = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        amount="428.00",
    )
    assert reservation["status"] == "CONFIRMED"

    # 4) 第二个重叠预订 -> 409
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": iso(d(1)),
            "check_out_date": iso(d(3)),
            "agreed_total_amount": "428.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert "已被预订" in resp.json()["detail"]

    # 5) Check-in：Reservation CHECKED_IN + Stay ACTIVE + Room occupied + 审计
    checked_in = check_in(client, admin_headers, reservation["id"])
    assert checked_in["reservation"]["status"] == "CHECKED_IN"
    stay = checked_in["stay"]
    assert stay["status"] == "ACTIVE"
    assert stay["planned_check_out_date"] == iso(d(2))
    room_body = client.get(
        f"/api/v1/rooms/{room['id']}", headers=admin_headers
    ).json()
    assert room_body["occupancy_status"] == "occupied"

    # 6) Check-out：Reservation COMPLETED + Stay CHECKED_OUT + Room available+dirty
    checked_out = check_out(client, admin_headers, stay["id"])
    assert checked_out["status"] == "CHECKED_OUT"
    assert checked_out["reservation"]["status"] == "COMPLETED"
    room_body = client.get(
        f"/api/v1/rooms/{room['id']}", headers=admin_headers
    ).json()
    assert room_body["occupancy_status"] == "available"
    assert room_body["cleaning_status"] == "dirty"

    # 7) 审计完整记录全过程
    actions = db.scalars(
        select(AuditLog.action).where(
            AuditLog.resource_id.in_(
                [reservation["id"], stay["id"]]
            )
        )
    ).all()
    assert "reservation.create" in actions
    assert "reservation.check_in" in actions
    assert "stay.check_out" in actions
    assert "guest.create" in db.scalars(
        select(AuditLog.action).where(AuditLog.resource_id == guest["id"])
    ).all()

    # 8) HOUSEKEEPING：Booking 端点全部 403，无法获得 Guest/Reservation 数据
    make_user("hk_golden", role_names=["HOUSEKEEPING"])
    hk = {"Authorization": f"Bearer {token_for('hk_golden')}"}
    assert client.get("/api/v1/guests", headers=hk).status_code == 403
    assert client.get("/api/v1/reservations", headers=hk).status_code == 403
    assert client.get("/api/v1/stays", headers=hk).status_code == 403
    # 但仍可看到房间 dirty（房态工作）
    room_view = client.get(
        f"/api/v1/rooms/{room['id']}", headers=hk
    ).json()
    assert room_view["cleaning_status"] == "dirty"
