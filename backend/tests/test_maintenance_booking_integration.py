# -*- coding: utf-8 -*-
"""Maintenance × Booking 集成测试（Sprint 5 §15/§16/§17/§18/§20）：

- Availability 排除 Active Blocking MWO（无论 Room 当前 occupancy）
- Check-in 纵深防御：no active blocking MWO，否则 409
- Checkout 集成：blocking MWO 存在 -> OOS + MAINTENANCE；否则 available
- 已存在未来 CONFIRMED Reservation 时允许创建 blocking MWO，不自动取消/换房
- Maintenance Complete ≠ Room Clean：验证后仍 dirty 不能 Check-in
"""

from sqlalchemy import select

from app.models import Reservation, Room, Stay
from tests.booking_helpers import (
    check_in,
    check_out,
    create_guest,
    create_reservation,
    d,
    find_room,
    iso,
)
from tests.mwo_helpers import (
    assign_order,
    create_order,
    me_user_id,
    order_action,
)


def _room_row(db, room_id: int) -> Room:
    """API 请求在独立 Session 提交；expire 避免 fixture 会话身份映射返回旧对象。"""
    db.expire_all()
    return db.get(Room, room_id)


# ---------------------------------------------------------------------------
# Availability gating（Sprint 5 §16）
# ---------------------------------------------------------------------------


def test_availability_excludes_active_blocking_mwo(client, admin_headers):
    """available 房间 + blocking MWO -> Availability 不可售（维修原因原文）。"""
    room = find_room(client, admin_headers, "301")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="HVAC",
        title="空调故障",
    )
    resp = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": iso(d(3)),
            "check_out_date": iso(d(5)),
        },
        headers=admin_headers,
    )
    assert resp.status_code == 200
    item = next(i for i in resp.json()["items"] if i["room_id"] == room["id"])
    assert item["available"] is False
    # OOS 房间由占用状态原因先行命中；occupied 等保留占用的房间由维修原因命中
    assert item["reason"] in (
        "房间当前为 out_of_service",
        "该房间存在进行中的阻断性维修工单，暂不可售",
    )

    # 验证完成后恢复可售
    assign_order(client, admin_headers, order["id"], me_user_id(client, admin_headers))
    order_action(client, admin_headers, order["id"], "start")
    order_action(client, admin_headers, order["id"], "resolve")
    order_action(client, admin_headers, order["id"], "verify")
    resp = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": iso(d(3)),
            "check_out_date": iso(d(5)),
        },
        headers=admin_headers,
    )
    item = next(i for i in resp.json()["items"] if i["room_id"] == room["id"])
    assert item["available"] is True


def test_availability_excludes_blocked_occupied_room(client, admin_headers):
    """occupied 房间 + blocking MWO：occupancy 保持 occupied，但 Availability
    仍必须排除（工单本身负责阻断可售性，Sprint 5 §16）。"""
    room = find_room(client, admin_headers, "302")
    # occupied 现场状态
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "occupied"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="在住房维修",
    )
    resp = client.get(
        "/api/v1/availability",
        params={"check_in_date": iso(d(3)), "check_out_date": iso(d(5))},
        headers=admin_headers,
    )
    item = next(i for i in resp.json()["items"] if i["room_id"] == room["id"])
    assert item["available"] is False
    assert "阻断性维修工单" in item["reason"]


def test_create_reservation_blocked_by_maintenance(client, admin_headers):
    """预订预检同样被 Active Blocking MWO 拦截（409 维修原因）。"""
    guest = create_guest(client, admin_headers, name="维修拦截客人")
    room = find_room(client, admin_headers, "303")
    create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="阻断预订",
    )
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": room["id"],
            "room_type_id": room["room_type_id"],
            "check_in_date": iso(d(3)),
            "check_out_date": iso(d(5)),
            "agreed_total_amount": "398.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409
    # 房间已由 blocking 工单置为 OOS：可售性被占用状态原因先行命中；
    # 保留占用状态的房间（occupied/reserved）则由维修原因命中
    assert resp.json()["detail"] in (
        "房间当前为 out_of_service，不可预订",
        "该房间存在进行中的阻断性维修工单，暂不可售",
    )


# ---------------------------------------------------------------------------
# Check-in gating（Sprint 5 §17，后端最终权威）
# ---------------------------------------------------------------------------


def test_check_in_409_with_active_blocking_mwo(client, admin_headers, db):
    """清洁达标但存在 blocking MWO -> Check-in 409，Stay/Reservation 不变。"""
    guest = create_guest(client, admin_headers, name="维修入住拦截")
    room = find_room(client, admin_headers, "304")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="入住前故障",
    )
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "阻断性维修工单" in resp.json()["detail"]
    # 无 Stay 产生，Reservation 仍 CONFIRMED
    assert (
        db.scalar(select(Stay.id).where(Stay.reservation_id == res["id"]))
        is None
    )
    assert db.get(Reservation, res["id"]).status.value == "CONFIRMED"


# ---------------------------------------------------------------------------
# Checkout integration（Sprint 5 §18）
# ---------------------------------------------------------------------------


def _occupied_stay(client, admin_headers, room_number: str) -> tuple[int, int]:
    guest = create_guest(client, admin_headers, name=f"退房集成客人{room_number}")
    room = find_room(client, admin_headers, room_number)
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    return checked["stay"]["id"], room["id"]


def test_checkout_with_active_blocker_room_oos(client, admin_headers, db):
    """occupied + blocking MWO -> Checkout 后 Room = OOS + MAINTENANCE + dirty；
    HousekeepingTask 仍正常创建。"""
    stay_id, room_id = _occupied_stay(client, admin_headers, "305")
    order = create_order(
        client,
        admin_headers,
        room_id=room_id,
        blocks_room=True,
        title="退房前故障",
    )
    # 在住期间房间保持 occupied
    assert _room_row(db, room_id).occupancy_status.value == "occupied"

    check_out(client, admin_headers, stay_id)

    room = _room_row(db, room_id)
    assert room.occupancy_status.value == "out_of_service"
    assert room.unavailability_source.value == "MAINTENANCE"
    assert room.cleaning_status.value == "dirty"
    # Housekeeping 任务已创建
    from app.models import HousekeepingTask

    task = db.scalar(
        select(HousekeepingTask).where(HousekeepingTask.room_id == room_id)
    )
    assert task is not None
    assert task.status.value == "PENDING"

    # 维修完成 -> available + dirty（Sprint 5 §20：Maintenance Complete ≠ Clean）
    assign_order(client, admin_headers, order["id"], me_user_id(client, admin_headers))
    order_action(client, admin_headers, order["id"], "start")
    order_action(client, admin_headers, order["id"], "resolve")
    order_action(client, admin_headers, order["id"], "verify")
    room = _room_row(db, room_id)
    assert room.occupancy_status.value == "available"
    assert room.cleaning_status.value == "dirty"


def test_checkout_without_blocker_still_available(client, admin_headers, db):
    """回归：无 blocking MWO 时 Checkout 行为不变（available + dirty）。"""
    stay_id, room_id = _occupied_stay(client, admin_headers, "306")
    check_out(client, admin_headers, stay_id)
    room = _room_row(db, room_id)
    assert room.occupancy_status.value == "available"
    assert room.unavailability_source is None
    assert room.cleaning_status.value == "dirty"


def test_checkout_does_not_override_manual_oos(client, admin_headers, db):
    """在住期间被人工停用（MANUAL OOS）+ 无 blocking MWO：
    退房不得解除人工停用，来源保持 MANUAL。"""
    stay_id, room_id = _occupied_stay(client, admin_headers, "307")
    resp = client.post(
        f"/api/v1/rooms/{room_id}/status",
        json={"occupancy_status": "out_of_service"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert _room_row(db, room_id).unavailability_source.value == "MANUAL"

    check_out(client, admin_headers, stay_id)
    room = _room_row(db, room_id)
    assert room.occupancy_status.value == "out_of_service"
    assert room.unavailability_source.value == "MANUAL"
    assert room.cleaning_status.value == "dirty"


# ---------------------------------------------------------------------------
# 已存在未来预订 + 故障（Sprint 5 §15）
# ---------------------------------------------------------------------------


def test_future_reservation_kept_with_blocking_mwo(client, admin_headers, db):
    """未来 CONFIRMED 预订 + blocking 故障：允许创建 MWO；
    不自动取消/换房；预订保留；完成后预订仍存在。"""
    guest = create_guest(client, admin_headers, name="未来预订客人")
    room = find_room(client, admin_headers, "308")
    res = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=d(5),
        check_out=d(7),
    )
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="未来预订房故障",
    )
    # Room 变 OOS，但 Reservation 保留 CONFIRMED
    assert _room_row(db, room["id"]).occupancy_status.value == "out_of_service"
    reservation = db.get(Reservation, res["id"])
    assert reservation.status.value == "CONFIRMED"
    assert reservation.room_id == room["id"]

    # 维修完成 -> Room 恢复；Reservation 依然原房原状态
    assign_order(client, admin_headers, order["id"], me_user_id(client, admin_headers))
    order_action(client, admin_headers, order["id"], "start")
    order_action(client, admin_headers, order["id"], "resolve")
    order_action(client, admin_headers, order["id"], "verify")
    assert _room_row(db, room["id"]).occupancy_status.value == "available"
    reservation = db.get(Reservation, res["id"])
    assert reservation.status.value == "CONFIRMED"
    assert reservation.room_id == room["id"]


def test_verified_dirty_room_cannot_check_in(client, admin_headers):
    """Sprint 5 §20：Maintenance Verify -> COMPLETED 后 cleaning 保持原值；
    dirty 房间仍不能 Check-in（clean 门槛由既有逻辑保证）。"""
    guest = create_guest(client, admin_headers, name="维修后脏房入住")
    room = find_room(client, admin_headers, "201")
    # 制造 dirty
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"cleaning_status": "dirty"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="脏房维修",
    )
    # 完成维修链
    assign_order(client, admin_headers, order["id"], me_user_id(client, admin_headers))
    order_action(client, admin_headers, order["id"], "start")
    order_action(client, admin_headers, order["id"], "resolve")
    order_action(client, admin_headers, order["id"], "verify")

    # 房间 available + dirty；Check-in 因 dirty 409
    room_after = find_room(client, admin_headers, "201")
    assert room_after["occupancy_status"] == "available"
    assert room_after["cleaning_status"] == "dirty"
    resp = client.post(
        f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "清洁" in resp.json()["detail"]
