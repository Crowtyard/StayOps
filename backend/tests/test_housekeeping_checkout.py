# -*- coding: utf-8 -*-
"""Checkout 自动生成翻房任务（Sprint 3）测试：
- 退房 → 房间 dirty + 任务 PENDING（source=CHECKOUT）同事务
- 提前退房（Early Checkout）同样生成任务
- 任务创建失败 → 整个退房 rollback（原子不变式）
- 翻房闭环：退房任务 → 清扫链 → COMPLETED + clean → 下一笔入住成功
- Check-in gating 保持：dirty / cleaning / inspection / rework → 409，clean → SUCCESS
"""

import pytest
from sqlalchemy import func, select

from app.models import AuditLog, HousekeepingTask, Reservation, Room, Stay
from app.services import booking
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
from tests.hk_helpers import make_dirty, set_cleaning, task_action


def _active_task(db, room_id: int) -> HousekeepingTask | None:
    return db.scalar(
        select(HousekeepingTask).where(
            HousekeepingTask.room_id == room_id,
            HousekeepingTask.status.in_(
                ["PENDING", "IN_PROGRESS", "INSPECTION", "REWORK"]
            ),
        )
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


def test_checkout_auto_creates_pending_task(client, admin_headers, db):
    """退房事务：Stay CHECKED_OUT + Reservation COMPLETED + Room available+dirty
    + HousekeepingTask PENDING（CHECKOUT）+ 审计 housekeeping.create。"""
    guest = create_guest(client, admin_headers, name="翻房客人A")
    room = find_room(client, admin_headers, "303")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    stay_id = checked["stay"]["id"]

    checked_out = check_out(client, admin_headers, stay_id)
    assert checked_out["status"] == "CHECKED_OUT"

    room_body = client.get(
        f"/api/v1/rooms/{room['id']}", headers=admin_headers
    ).json()
    assert room_body["occupancy_status"] == "available"
    assert room_body["cleaning_status"] == "dirty"

    task = _active_task(db, room["id"])
    assert task is not None
    assert task.status.value == "PENDING"
    assert task.source.value == "CHECKOUT"
    assert task.task_no.startswith("HKT")
    assert task.assigned_to_user_id is None

    # 审计可追溯（housekeeping.create 关联任务，不含 PII）
    assert _audit_count(db, "housekeeping.create", task.id) == 1
    details = db.scalar(
        select(AuditLog.details).where(
            AuditLog.action == "housekeeping.create",
            AuditLog.resource_id == task.id,
        )
    )
    assert details["stay_id"] == stay_id
    assert details["stay_no"] == checked_out["stay_no"]


def test_early_checkout_also_creates_task(client, admin_headers, db):
    """提前退房（REV-FINAL-03）同样触发翻房任务。"""
    guest = create_guest(client, admin_headers, name="翻房客人B")
    room = find_room(client, admin_headers, "304")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    check_out(client, admin_headers, checked["stay"]["id"])

    assert client.get(
        f"/api/v1/reservations/{res['id']}", headers=admin_headers
    ).json()["status"] == "COMPLETED"
    task = _active_task(db, room["id"])
    assert task is not None and task.source.value == "CHECKOUT"


def test_checkout_rollback_when_task_creation_fails(
    client, admin_headers, db, monkeypatch
):
    """任务创建失败 → 整个 Checkout rollback：Stay / Reservation / Room 无半状态。"""
    guest = create_guest(client, admin_headers, name="翻房回滚客人")
    room = find_room(client, admin_headers, "305")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    stay_id = checked["stay"]["id"]

    def boom(*args, **kwargs):
        raise RuntimeError("housekeeping task creation failure")

    monkeypatch.setattr(booking, "create_checkout_task", boom)
    with pytest.raises(RuntimeError):
        client.post(f"/api/v1/stays/{stay_id}/check-out", headers=admin_headers)

    stay = db.get(Stay, stay_id)
    assert stay.status.value == "ACTIVE"
    assert stay.actual_check_out_at is None
    reservation = db.get(Reservation, res["id"])
    assert reservation.status.value == "CHECKED_IN"
    room_row = db.get(Room, room["id"])
    assert room_row.occupancy_status.value == "occupied"
    assert room_row.cleaning_status.value == "clean"
    assert _active_task(db, room["id"]) is None
    assert _audit_count(db, "stay.check_out", stay_id) == 0


def test_task_transition_rollback_on_audit_failure(
    client, admin_headers, db, monkeypatch
):
    """任务状态转换中途（审计）失败：Task / Room 全部回滚，无部分状态。"""
    from app.services import housekeeping

    make_dirty(client, admin_headers, "306")
    room = find_room(client, admin_headers, "306")
    resp = client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room["id"]}, headers=admin_headers
    )
    task_id = resp.json()["id"]

    def boom(*args, **kwargs):
        raise RuntimeError("audit failure")

    monkeypatch.setattr(housekeeping, "write_audit_log", boom)
    with pytest.raises(RuntimeError):
        client.post(
            f"/api/v1/housekeeping/tasks/{task_id}/start", headers=admin_headers
        )

    task = db.get(HousekeepingTask, task_id)
    assert task.status.value == "PENDING"
    assert task.started_at is None
    assert db.get(Room, room["id"]).cleaning_status.value == "dirty"
    assert _audit_count(db, "housekeeping.start", task_id) == 0


def test_turnover_loop_then_next_checkin_success(client, admin_headers, db):
    """翻房闭环（API 级 Golden Path）：
    退房 → 任务 → start → submit → pass → clean → 下一笔 [today, today+2) 入住成功。"""
    guest = create_guest(client, admin_headers, name="翻房闭环客人")
    room = find_room(client, admin_headers, "307")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    check_out(client, admin_headers, checked["stay"]["id"])

    task = _active_task(db, room["id"])
    assert task is not None and task.status.value == "PENDING"
    task_action(client, admin_headers, task.id, "start")
    assert db.get(Room, room["id"]).cleaning_status.value == "cleaning"
    task_action(client, admin_headers, task.id, "submit-inspection")
    assert db.get(Room, room["id"]).cleaning_status.value == "inspection"
    task_action(client, admin_headers, task.id, "pass")
    assert db.get(Room, room["id"]).cleaning_status.value == "clean"

    # 翻房完成：同一房间可再次预订并入住（clean gating 满足）
    guest2 = create_guest(client, admin_headers, name="翻房闭环客人2")
    res2 = create_reservation(
        client, admin_headers, room=room, guest_id=guest2["id"]
    )
    checked2 = check_in(client, admin_headers, res2["id"])
    assert checked2["reservation"]["status"] == "CHECKED_IN"
    assert db.get(Room, room["id"]).occupancy_status.value == "occupied"


def test_checkin_gating_non_clean_409(client, admin_headers, db):
    """Check-in clean gating（Sprint 2 规则保持）：
    dirty / cleaning / inspection / rework → 409；clean → SUCCESS。

    房间清洁状态机只允许 clean→dirty→cleaning→inspection→rework 顺序，
    因此先走合法路径构造各状态（任务的房态联动由任务状态机驱动，不受此限制）。
    """
    # 合法路径构造各非 clean 状态
    paths: dict[str, list[str]] = {
        "dirty": ["dirty"],
        "cleaning": ["dirty", "cleaning"],
        "inspection": ["dirty", "cleaning", "inspection"],
        "rework": ["dirty", "cleaning", "inspection", "rework"],
    }
    for status_value, room_number in [
        ("dirty", "308"),
        ("cleaning", "207"),
        ("inspection", "208"),
        ("rework", "109"),
    ]:
        guest = create_guest(client, admin_headers, name=f"门禁客人-{status_value}")
        room = find_room(client, admin_headers, room_number)
        res = create_reservation(
            client, admin_headers, room=room, guest_id=guest["id"]
        )
        for step in paths[status_value]:
            set_cleaning(client, admin_headers, room_number, step)
        resp = client.post(
            f"/api/v1/reservations/{res['id']}/check-in", headers=admin_headers
        )
        assert resp.status_code == 409, resp.text
        assert "未清洁" in resp.json()["detail"]

    # 对照：clean 房间 SUCCESS
    guest_clean = create_guest(client, admin_headers, name="门禁客人-clean")
    room_clean = find_room(client, admin_headers, "110")
    res_clean = create_reservation(
        client, admin_headers, room=room_clean, guest_id=guest_clean["id"]
    )
    checked = check_in(client, admin_headers, res_clean["id"])
    assert checked["reservation"]["status"] == "CHECKED_IN"


def test_checkout_task_blocks_manual_duplicate(client, admin_headers, db):
    """Checkout 自动任务存在时，对同一房间手动创建 → 409（Active Task 唯一）。"""
    guest = create_guest(client, admin_headers, name="唯一性客人")
    room = find_room(client, admin_headers, "201")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    check_out(client, admin_headers, checked["stay"]["id"])

    resp = client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room["id"]}, headers=admin_headers
    )
    assert resp.status_code == 409
    assert "已有进行中的保洁任务" in resp.json()["detail"]


def test_availability_unaffected_by_task(client, admin_headers):
    """保洁任务不影响可售性（COMPLETED/进行中任务不阻塞新预订，booking 语义不变）。"""
    avail = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": iso(today()),
            "check_out_date": iso(d(2)),
        },
        headers=admin_headers,
    ).json()
    assert avail["total"] == 28
