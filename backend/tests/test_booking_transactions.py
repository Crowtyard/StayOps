# -*- coding: utf-8 -*-
"""Check-in / Check-out 事务回滚测试：构造中途失败 → 全部回滚，无半状态。"""

import pytest
from sqlalchemy import func, select

from app.models import AuditLog, Reservation, Room, Stay
from app.services import booking
from tests.booking_helpers import (
    check_in,
    check_out,
    create_guest,
    create_reservation,
    find_room,
)


def _audit_count(db, action: str, resource_id: int) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(
                AuditLog.action == action,
                AuditLog.resource_id == resource_id,
            )
        )
        or 0
    )


def test_check_in_rollback_on_audit_failure(
    client, admin_headers, db, monkeypatch
):
    """Check-in 中途（审计写入）失败：Reservation / Stay / Room 全部回滚。"""
    guest = create_guest(client, admin_headers, name="回滚入住客人")
    room = find_room(client, admin_headers, "301")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])

    def boom(*args, **kwargs):
        raise RuntimeError("audit failure")

    monkeypatch.setattr(booking, "write_audit_log", boom)
    with pytest.raises(RuntimeError):
        client.post(
            f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
        )

    # 无半状态：Reservation 仍 CONFIRMED、无 Stay、房间未变、无审计
    reservation = db.get(Reservation, res["id"])
    assert reservation.status.value == "CONFIRMED"
    stays = db.scalars(
        select(Stay).where(Stay.reservation_id == res["id"])
    ).all()
    assert stays == []
    room_row = db.get(Room, room["id"])
    assert room_row.occupancy_status.value == "available"
    assert room_row.cleaning_status.value == "clean"
    assert _audit_count(db, "reservation.check_in", res["id"]) == 0


def test_check_out_rollback_on_audit_failure(
    client, admin_headers, db, monkeypatch
):
    """Check-out 中途（审计写入）失败：Stay / Reservation / Room 全部回滚。"""
    guest = create_guest(client, admin_headers, name="回滚退房客人")
    room = find_room(client, admin_headers, "302")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked_in = check_in(client, admin_headers, res["id"])
    stay_id = checked_in["stay"]["id"]

    def boom(*args, **kwargs):
        raise RuntimeError("audit failure")

    monkeypatch.setattr(booking, "write_audit_log", boom)
    with pytest.raises(RuntimeError):
        client.post(f"/api/v1/stays/{stay_id}/check-out", headers=admin_headers)

    stay = db.get(Stay, stay_id)
    assert stay.status.value == "ACTIVE"
    assert stay.actual_check_out_at is None
    reservation = db.get(Reservation, res["id"])
    assert reservation.status.value == "CHECKED_IN"
    room = db.get(Room, room["id"])
    assert room.occupancy_status.value == "occupied"
    assert room.cleaning_status.value == "clean"
    assert _audit_count(db, "stay.check_out", stay_id) == 0


def test_check_out_non_active_409_no_changes(client, admin_headers, db):
    """非 ACTIVE Stay Check-out -> 409，且不产生任何状态变化、无重复审计。"""
    guest = create_guest(client, admin_headers, name="重复退房回滚客人")
    room = find_room(client, admin_headers, "303")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked_in = check_in(client, admin_headers, res["id"])
    stay_id = checked_in["stay"]["id"]
    check_out(client, admin_headers, stay_id)
    resp = client.post(
        f"/api/v1/stays/{stay_id}/check-out", headers=admin_headers
    )
    assert resp.status_code == 409
    stay = db.get(Stay, stay_id)
    assert stay.status.value == "CHECKED_OUT"
    assert _audit_count(db, "stay.check_out", stay_id) == 1  # 仅一次有效退房审计
