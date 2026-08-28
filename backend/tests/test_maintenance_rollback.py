# -*- coding: utf-8 -*-
"""Maintenance 回滚测试（Sprint 5 §28）：

- blocking MWO create 中途失败 -> Room 不得遗留孤儿 OOS
- Verify 审计失败 -> MWO 保持 RESOLVED、Room 保持 OOS
- Cancel 中途失败 -> MWO / Room 保持先前一致状态
- Checkout（blocking 场景）Housekeeping 任务创建失败 -> 整体回滚
"""

import pytest
from sqlalchemy import func, select

from app.models import (
    AuditLog,
    HousekeepingTask,
    MaintenanceWorkOrder,
    Reservation,
    Room,
    Stay,
)
from app.services import booking, maintenance
from tests.booking_helpers import (
    check_in,
    create_guest,
    create_reservation,
    find_room,
)
from tests.mwo_helpers import (
    assign_order,
    create_order,
    me_user_id,
    order_action,
)


def _boom(*args, **kwargs):
    raise RuntimeError("audit failure")


def test_blocking_create_failure_leaves_no_orphan_oos(
    client, admin_headers, db, monkeypatch
):
    """Sprint 5 §28：blocking MWO create 失败 -> Room 必须不残留 OOS。"""
    room = find_room(client, admin_headers, "301")
    monkeypatch.setattr(maintenance, "write_audit_log", _boom)
    with pytest.raises(RuntimeError):
        client.post(
            "/api/v1/maintenance/orders",
            json={
                "room_id": room["id"],
                "category": "HVAC",
                "blocks_room": True,
                "title": "回滚创建",
            },
            headers=admin_headers,
        )
    row = db.get(Room, room["id"])
    assert row.occupancy_status.value == "available"
    assert row.unavailability_source is None
    count = db.scalar(
        select(func.count()).select_from(MaintenanceWorkOrder).where(
            MaintenanceWorkOrder.room_id == room["id"]
        )
    )
    assert count == 0


def test_verify_audit_failure_keeps_resolved_and_oos(
    client, admin_headers, db, monkeypatch
):
    """Verify 审计失败：MWO 保持 RESOLVED、Room 保持 OOS、无审计残留。"""
    room = find_room(client, admin_headers, "302")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="验收回滚",
    )
    oid = order["id"]
    assign_order(client, admin_headers, oid, me_user_id(client, admin_headers))
    order_action(client, admin_headers, oid, "start")
    order_action(client, admin_headers, oid, "resolve")

    monkeypatch.setattr(maintenance, "write_audit_log", _boom)
    with pytest.raises(RuntimeError):
        client.post(
            f"/api/v1/maintenance/orders/{oid}/verify", headers=admin_headers
        )

    order_row = db.get(MaintenanceWorkOrder, oid)
    assert order_row.status.value == "RESOLVED"
    assert order_row.verified_at is None
    room_row = db.get(Room, room["id"])
    assert room_row.occupancy_status.value == "out_of_service"
    assert room_row.unavailability_source.value == "MAINTENANCE"
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(
                AuditLog.action == "maintenance.verify",
                AuditLog.resource_id == oid,
            )
        )
        == 0
    )


def test_cancel_audit_failure_keeps_previous_state(
    client, admin_headers, db, monkeypatch
):
    """Cancel 中途失败：MWO 保持 OPEN、Room 保持 OOS。"""
    room = find_room(client, admin_headers, "303")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="取消回滚",
    )
    oid = order["id"]

    monkeypatch.setattr(maintenance, "write_audit_log", _boom)
    with pytest.raises(RuntimeError):
        client.post(
            f"/api/v1/maintenance/orders/{oid}/cancel", headers=admin_headers
        )

    order_row = db.get(MaintenanceWorkOrder, oid)
    assert order_row.status.value == "OPEN"
    assert order_row.cancelled_at is None
    room_row = db.get(Room, room["id"])
    assert room_row.occupancy_status.value == "out_of_service"
    assert room_row.unavailability_source.value == "MAINTENANCE"


def test_checkout_with_blocker_housekeeping_failure_rolls_back(
    client, admin_headers, db, monkeypatch
):
    """Sprint 5 §18/§28：Checkout + blocking MWO 场景中 Housekeeping 任务
    创建失败 -> Stay / Reservation / Room / MWO-aware 状态全部回滚。"""
    guest = create_guest(client, admin_headers, name="退房回滚客人")
    room = find_room(client, admin_headers, "304")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    stay_id = checked["stay"]["id"]
    create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="退房回滚工单",
    )

    def boom_create_task(*args, **kwargs):
        raise RuntimeError("housekeeping task creation failure")

    monkeypatch.setattr(booking, "create_checkout_task", boom_create_task)
    with pytest.raises(RuntimeError):
        client.post(f"/api/v1/stays/{stay_id}/check-out", headers=admin_headers)

    stay = db.get(Stay, stay_id)
    assert stay.status.value == "ACTIVE"
    assert stay.actual_check_out_at is None
    reservation = db.get(Reservation, res["id"])
    assert reservation.status.value == "CHECKED_IN"
    room_row = db.get(Room, room["id"])
    # 在住期间保持 occupied（blocking 工单不改占用）
    assert room_row.occupancy_status.value == "occupied"
    assert room_row.cleaning_status.value == "clean"
    task_count = db.scalar(
        select(func.count()).select_from(HousekeepingTask).where(
            HousekeepingTask.room_id == room["id"]
        )
    )
    assert task_count == 0
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(
                AuditLog.action == "stay.check_out",
                AuditLog.resource_id == stay_id,
            )
        )
        == 0
    )
