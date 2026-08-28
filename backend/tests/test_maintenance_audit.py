# -*- coding: utf-8 -*-
"""Maintenance 审计测试（Sprint 5 §29）：

- 全部 action 自动审计：maintenance.create / assign / start / resolve /
  verify / rework / cancel（+ update），不依赖前端生成
- Room 因 Maintenance become out_of_service / restore available 有足够审计证据
"""

from sqlalchemy import select

from app.models import AuditLog
from tests.booking_helpers import find_room
from tests.mwo_helpers import (
    assign_order,
    create_order,
    me_user_id,
    order_action,
    patch_order,
)


def _audits(db, action: str, resource_id: int) -> list[AuditLog]:
    return list(
        db.scalars(
            select(AuditLog).where(
                AuditLog.action == action,
                AuditLog.resource_id == resource_id,
            )
        )
    )


def test_full_flow_audit_trail(client, admin_headers, db):
    """全链路每个动作产生对应审计，resource_type = maintenance_work_order。"""
    room = find_room(client, admin_headers, "301")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="审计链路",
    )
    oid = order["id"]
    patch_order(client, admin_headers, oid, {"severity": "LOW"})  # maintenance.update
    assign_order(client, admin_headers, oid, me_user_id(client, admin_headers))
    order_action(client, admin_headers, oid, "start")
    order_action(client, admin_headers, oid, "resolve")
    order_action(client, admin_headers, oid, "rework")
    order_action(client, admin_headers, oid, "resolve")
    order_action(client, admin_headers, oid, "verify")
    order_action(client, admin_headers, oid, "start", expect=409)  # 终态 409，不产生审计

    expected_actions = [
        "maintenance.create",
        "maintenance.assign",
        "maintenance.start",
        "maintenance.resolve",
        "maintenance.rework",
        "maintenance.verify",
        "maintenance.update",
    ]
    for action in expected_actions:
        logs = _audits(db, action, oid)
        assert logs, f"缺少审计 {action}"
        assert logs[0].resource_type == "maintenance_work_order"


def test_audit_evidence_for_room_oos_and_restore(client, admin_headers, db):
    """create blocking 审计记录 room_occupancy available->out_of_service；
    verify 审计记录 room_occupancy out_of_service->available（可售性证据）。"""
    room = find_room(client, admin_headers, "302")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="可售性审计",
    )
    oid = order["id"]
    create_logs = _audits(db, "maintenance.create", oid)
    assert create_logs[0].details["room_occupancy"] == {
        "from": "available",
        "to": "out_of_service",
    }

    assign_order(client, admin_headers, oid, me_user_id(client, admin_headers))
    order_action(client, admin_headers, oid, "start")
    order_action(client, admin_headers, oid, "resolve")
    order_action(client, admin_headers, oid, "verify")

    verify_logs = _audits(db, "maintenance.verify", oid)
    assert verify_logs
    assert verify_logs[0].details["room_occupancy"] == {
        "from": "out_of_service",
        "to": "available",
    }


def test_cancel_audit(client, admin_headers, db):
    room = find_room(client, admin_headers, "303")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="取消审计",
    )
    order_action(client, admin_headers, order["id"], "cancel")
    logs = _audits(db, "maintenance.cancel", order["id"])
    assert logs
    assert logs[0].details["from"] == "OPEN"
    assert logs[0].details["to"] == "CANCELLED"


def test_no_audit_on_illegal_transition(client, admin_headers, db):
    """非法转换 409 不产生审计。"""
    room = find_room(client, admin_headers, "304")
    order = create_order(
        client, admin_headers, room_id=room["id"], blocks_room=True, title="无审计409"
    )
    oid = order["id"]
    order_action(client, admin_headers, oid, "start", expect=409)
    assert _audits(db, "maintenance.start", oid) == []
