# -*- coding: utf-8 -*-
"""Housekeeping 审计测试（Sprint 3）：
7 类必要事件全部落库且 details 可追溯、无 PII；Checkout 自动任务同样可追溯。
"""

from sqlalchemy import select

from app.models import AuditLog
from tests.booking_helpers import check_in, check_out, create_guest, create_reservation, find_room
from tests.hk_helpers import create_task, make_dirty, patch_task, task_action


def _details_by_action(db, action: str) -> list[dict]:
    return list(
        db.scalars(
            select(AuditLog.details).where(AuditLog.action == action)
        ).all()
    )


def test_housekeeping_audit_events_full_chain(client, admin_headers, db, make_user):
    """全链路审计事件：create / assign / start / submit_inspection / pass。"""
    assignee = make_user("hk_audit_assignee", role_names=["HOUSEKEEPING"])
    make_dirty(client, admin_headers, "301")
    room = find_room(client, admin_headers, "301")
    task = create_task(client, admin_headers, room["id"])
    patch_task(client, admin_headers, task["id"], {"assigned_to_user_id": assignee["id"]})
    task_action(client, admin_headers, task["id"], "start")
    task_action(client, admin_headers, task["id"], "submit-inspection")
    task_action(client, admin_headers, task["id"], "pass")

    for action in [
        "housekeeping.create",
        "housekeeping.assign",
        "housekeeping.start",
        "housekeeping.submit_inspection",
        "housekeeping.pass",
    ]:
        rows = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.action == action,
                    AuditLog.resource_type == "housekeeping_task",
                    AuditLog.resource_id == task["id"],
                )
            ).all()
        )
        assert len(rows) == 1, f"缺少审计事件 {action}"

    # assign 记录 from/to 用户
    assign_details = db.scalar(
        select(AuditLog.details).where(
            AuditLog.action == "housekeeping.assign",
            AuditLog.resource_id == task["id"],
        )
    )
    assert assign_details["to_user_id"] == assignee["id"]

    # start/submit/pass 记录状态 from/to
    pass_details = db.scalar(
        select(AuditLog.details).where(
            AuditLog.action == "housekeeping.pass",
            AuditLog.resource_id == task["id"],
        )
    )
    assert pass_details["from"] == "INSPECTION"
    assert pass_details["to"] == "COMPLETED"


def test_housekeeping_rework_and_cancel_audit(client, admin_headers, db):
    """rework / cancel 事件落库。"""
    make_dirty(client, admin_headers, "302")
    room = find_room(client, admin_headers, "302")
    task = create_task(client, admin_headers, room["id"])
    task_action(client, admin_headers, task["id"], "start")
    task_action(client, admin_headers, task["id"], "submit-inspection")
    task_action(client, admin_headers, task["id"], "rework")
    task_action(client, admin_headers, task["id"], "cancel")

    for action in ["housekeeping.rework", "housekeeping.cancel"]:
        rows = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.action == action,
                    AuditLog.resource_id == task["id"],
                )
            ).all()
        )
        assert len(rows) == 1, f"缺少审计事件 {action}"


def test_housekeeping_update_audit(client, admin_headers, db):
    """PATCH priority / notes → housekeeping.update 审计（details 无 PII）。"""
    make_dirty(client, admin_headers, "303")
    room = find_room(client, admin_headers, "303")
    task = create_task(client, admin_headers, room["id"])
    patch_task(
        client, admin_headers, task["id"], {"priority": "URGENT", "notes": "VIP 房"}
    )
    rows = list(
        db.scalars(
            select(AuditLog).where(
                AuditLog.action == "housekeeping.update",
                AuditLog.resource_id == task["id"],
            )
        ).all()
    )
    assert len(rows) == 1


def test_checkout_auto_task_audited(client, admin_headers, db):
    """Checkout 自动任务落 housekeeping.create 审计且可追溯到 Stay。

    注意：并发测试（真实提交）可能留下其它任务的 housekeeping.create 审计，
    因此按本任务 resource_id 精确断言。
    """
    from app.models import HousekeepingTask

    guest = create_guest(client, admin_headers, name="审计退房客人")
    room = find_room(client, admin_headers, "304")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    checked_out = check_out(client, admin_headers, checked["stay"]["id"])

    task_id = db.scalar(
        select(HousekeepingTask.id).where(HousekeepingTask.room_id == room["id"])
    )
    assert task_id is not None
    rows = list(
        db.scalars(
            select(AuditLog).where(
                AuditLog.action == "housekeeping.create",
                AuditLog.resource_type == "housekeeping_task",
                AuditLog.resource_id == task_id,
            )
        ).all()
    )
    assert len(rows) == 1
    details = db.scalar(
        select(AuditLog.details).where(
            AuditLog.action == "housekeeping.create",
            AuditLog.resource_type == "housekeeping_task",
            AuditLog.resource_id == task_id,
        )
    )
    assert details["source"] == "CHECKOUT"
    assert details["stay_id"] == checked["stay"]["id"]
    assert details["stay_no"] == checked_out["stay_no"]
    # 无 Guest / Reservation PII 与金额
    text = str(details)
    for forbidden in ["138", "zhang", "428", "notes"]:
        assert forbidden not in text
