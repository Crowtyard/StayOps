# -*- coding: utf-8 -*-
"""Room Move 核心功能测试（Sprint 6 §31）。

覆盖：Check-in 建立 assignment #1、正常换房、重复/同日换房、目标房资格矩阵
（dirty / occupied / blocked / OOS / blocking MWO / 未来预订重叠 / 紧邻允许）、
Source 释放（正常 / blocking MWO / MANUAL 保持）、ROOM_MOVE 保洁任务、
active task 冲突、目标房状态、维修独立性、assignment 历史、
Stay.room_id == open assignment.room_id、Reservation.room_id 冻结、
CHECKED_IN PATCH 封锁、审计、事务回滚、RBAC。
"""

import json

import pytest
from sqlalchemy import func, select

from app.models import (
    AuditLog,
    HousekeepingTask,
    HousekeepingTaskPriority,
    HousekeepingTaskSource,
    HousekeepingTaskStatus,
    MaintenanceWorkOrder,
    Reservation,
    Room,
    Stay,
    StayRoomAssignment,
)
from app.services import room_move as room_move_service
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
from tests.mwo_helpers import create_order, set_occupancy
from tests.room_move_helpers import move, move_options, option_for, setup_stay


def _room(client, headers, number: str) -> dict:
    return find_room(client, headers, number)


def _set_cleaning(client, headers, room_id: int, value: str) -> None:
    resp = client.post(
        f"/api/v1/rooms/{room_id}/status",
        json={"cleaning_status": value},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Check-in 建立 assignment #1（Sprint 6 §5）
# ---------------------------------------------------------------------------


def test_check_in_creates_initial_assignment(client, admin_headers, db):
    """Check-in 原子建立 assignment #1：room = check-in room、
    started_at = actual check-in time、ended_at = NULL。"""
    ctx = setup_stay(client, admin_headers, "301")
    stay_id = ctx["stay"]["id"]
    room_id = ctx["room"]["id"]

    body = client.get(f"/api/v1/stays/{stay_id}", headers=admin_headers).json()
    assignments = body["assignments"]
    assert len(assignments) == 1
    first = assignments[0]
    assert first["room_id"] == room_id
    # response_model_exclude_none：null 字段以键缺失呈现
    assert first.get("ended_at") is None
    assert first.get("reason") is None
    assert first["started_at"] == body["actual_check_in_at"]

    row = db.scalar(
        select(StayRoomAssignment).where(
            StayRoomAssignment.stay_id == stay_id,
            StayRoomAssignment.ended_at.is_(None),
        )
    )
    assert row is not None
    assert row.room_id == room_id
    assert db.get(Stay, stay_id).room_id == row.room_id


# ---------------------------------------------------------------------------
# 正常换房 / 重复换房 / 同日重复（Sprint 6 §12/§20）
# ---------------------------------------------------------------------------


def test_normal_move(client, admin_headers, db):
    """301 -> 302：目标 occupied+clean、旧房 available+dirty + ROOM_MOVE 任务、
    Reservation.room_id 保持原分配房、assignment 历史正确。"""
    ctx = setup_stay(client, admin_headers, "301")
    stay_id, room_id = ctx["stay"]["id"], ctx["room"]["id"]
    target = _room(client, admin_headers, "302")

    body = move(client, admin_headers, stay_id, target["id"], reason="MAINTENANCE",
                notes="空调维修，换房")
    assert body["room_id"] == target["id"]
    assert body["room_number"] == "302"

    # 目标房：occupied + clean（cleaning 不变，不创建目标房任务）
    t = _room(client, admin_headers, "302")
    assert t["occupancy_status"] == "occupied"
    assert t["cleaning_status"] == "clean"

    # 旧房：available + dirty + ROOM_MOVE 保洁任务
    s = _room(client, admin_headers, "301")
    assert s["occupancy_status"] == "available"
    assert s["cleaning_status"] == "dirty"
    task = db.scalar(
        select(HousekeepingTask).where(
            HousekeepingTask.room_id == room_id,
            HousekeepingTask.source == HousekeepingTaskSource.ROOM_MOVE,
        )
    )
    assert task is not None
    assert task.status == HousekeepingTaskStatus.PENDING

    # assignment 历史：[301 closed, 302 open]
    rows = db.scalars(
        select(StayRoomAssignment)
        .where(StayRoomAssignment.stay_id == stay_id)
        .order_by(StayRoomAssignment.id)
    ).all()
    assert [r.room_id for r in rows] == [room_id, target["id"]]
    assert rows[0].ended_at is not None
    assert rows[0].reason is None
    assert rows[1].ended_at is None
    assert rows[1].reason.value == "MAINTENANCE"
    assert rows[1].notes == "空调维修，换房"
    assert rows[0].ended_at == rows[1].started_at

    # Stay.room_id == open assignment.room_id
    stay_row = db.get(Stay, stay_id)
    open_row = db.scalar(
        select(StayRoomAssignment).where(
            StayRoomAssignment.stay_id == stay_id,
            StayRoomAssignment.ended_at.is_(None),
        )
    )
    assert stay_row.room_id == open_row.room_id == target["id"]

    # Reservation.room_id 保持原分配房（Sprint 6 §2）
    reservation = db.get(Reservation, ctx["reservation"]["id"])
    assert reservation.room_id == room_id

    # 详情响应含原分配房与当前在住房
    detail = client.get(f"/api/v1/stays/{stay_id}", headers=admin_headers).json()
    assert detail["reservation"]["room_id"] == room_id
    assert detail["reservation"]["room_number"] == "301"
    assert detail["room_id"] == target["id"]


def test_repeated_and_same_day_moves(client, admin_headers, db):
    """301 -> 302 -> 303 同一天多次换房：完整 assignment 路径（Sprint 6 §20）。"""
    ctx = setup_stay(client, admin_headers, "301")
    stay_id = ctx["stay"]["id"]
    target2 = _room(client, admin_headers, "302")
    target3 = _room(client, admin_headers, "303")

    move(client, admin_headers, stay_id, target2["id"], reason="GUEST_REQUEST")
    move(client, admin_headers, stay_id, target3["id"], reason="UPGRADE")

    rows = db.scalars(
        select(StayRoomAssignment)
        .where(StayRoomAssignment.stay_id == stay_id)
        .order_by(StayRoomAssignment.id)
    ).all()
    assert [r.room_id for r in rows] == [
        ctx["room"]["id"],
        target2["id"],
        target3["id"],
    ]
    assert [r.ended_at is None for r in rows] == [False, False, True]
    assert [r.reason.value if r.reason else None for r in rows] == [
        None,
        "GUEST_REQUEST",
        "UPGRADE",
    ]
    assert rows[0].ended_at == rows[1].started_at
    assert rows[1].ended_at == rows[2].started_at
    assert db.get(Stay, stay_id).room_id == target3["id"]
    # 302 也变为 dirty + ROOM_MOVE 任务（中途房同样释放）
    room302 = db.get(Room, target2["id"])
    assert room302.occupancy_status.value == "available"
    assert room302.cleaning_status.value == "dirty"


# ---------------------------------------------------------------------------
# 拒绝场景（Sprint 6 §11/§12）
# ---------------------------------------------------------------------------


def test_move_target_equals_source_rejected(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "304")
    body = move(
        client, admin_headers, ctx["stay"]["id"], ctx["room"]["id"], expect=409
    )
    assert "目标房间不能是当前房间" in body["detail"]


def test_move_inactive_stay_rejected(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    check_out(client, admin_headers, ctx["stay"]["id"])
    target = _room(client, admin_headers, "302")
    body = move(
        client, admin_headers, ctx["stay"]["id"], target["id"], expect=409
    )
    assert "仅 ACTIVE" in body["detail"]


def test_move_dirty_target_rejected(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    _set_cleaning(client, admin_headers, target["id"], "dirty")
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"], expect=409)
    assert "未清洁" in body["detail"]


def test_move_occupied_target_rejected(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    set_occupancy(client, admin_headers, "302", "occupied")
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"], expect=409)
    assert "occupied" in body["detail"]


def test_move_blocked_target_rejected(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    set_occupancy(client, admin_headers, "302", "blocked")
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"], expect=409)
    assert "blocked" in body["detail"]


def test_move_manual_oos_target_rejected(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    set_occupancy(client, admin_headers, "302", "out_of_service")
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"], expect=409)
    assert "out_of_service" in body["detail"]


def test_move_active_blocking_maintenance_target_rejected(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    create_order(
        client,
        admin_headers,
        room_id=target["id"],
        blocks_room=True,
        title="目标房阻断维修",
    )
    # S5：blocking 工单把 available 房置为 OOS+MAINTENANCE → 不可换入
    assert (
        _room(client, admin_headers, "302")["occupancy_status"]
        == "out_of_service"
    )
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"], expect=409)
    assert "不可换入" in body["detail"]


def test_move_nonblocking_mwo_target_allowed(client, admin_headers):
    """非阻断工单不阻止换入（沿用 S5 规则：blocks_room=false 不影响可售性）。"""
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    create_order(
        client,
        admin_headers,
        room_id=target["id"],
        blocks_room=False,
        title="目标房普通维修",
    )
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"])
    assert body["room_id"] == target["id"]


def test_move_overlapping_confirmed_reservation_rejected(client, admin_headers):
    """目标房在剩余入住区间 [today, d(2)) 内已有 CONFIRMED 预订 -> 409。"""
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "305")
    guest = create_guest(client, admin_headers, name="未来预订客人")
    create_reservation(
        client,
        admin_headers,
        room=target,
        guest_id=guest["id"],
        check_in=d(1),
        check_out=d(3),
    )
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"], expect=409)
    assert "剩余入住日期区间已有预订" in body["detail"]


def test_move_reservation_starting_at_planned_checkout_allowed(
    client, admin_headers
):
    """紧邻允许：[today, d(2)) 在住 + 目标房 [d(2), d(4)) 预订 -> 换房成功。"""
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "306")
    guest = create_guest(client, admin_headers, name="紧邻预订客人")
    create_reservation(
        client,
        admin_headers,
        room=target,
        guest_id=guest["id"],
        check_in=d(2),
        check_out=d(4),
    )
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"])
    assert body["room_id"] == target["id"]


# ---------------------------------------------------------------------------
# Source 释放（Sprint 6 §13/§15/§16）
# ---------------------------------------------------------------------------


def test_source_normal_release(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    move(client, admin_headers, ctx["stay"]["id"], target["id"])
    s = _room(client, admin_headers, "301")
    assert s["occupancy_status"] == "available"
    assert s["cleaning_status"] == "dirty"


def test_source_blocking_mwo_release_and_independence(client, admin_headers, db):
    """旧房 active blocking MWO：换房后 OOS+MAINTENANCE+dirty；
    工单仍属原房、状态不变（Sprint 6 §16 维修独立性）。"""
    ctx = setup_stay(client, admin_headers, "301")
    source_id = ctx["room"]["id"]
    order = create_order(
        client,
        admin_headers,
        room_id=source_id,
        blocks_room=True,
        title="在住房阻断维修",
    )
    # S5：occupied 房不被维修改变占用
    assert _room(client, admin_headers, "301")["occupancy_status"] == "occupied"

    target = _room(client, admin_headers, "302")
    move(client, admin_headers, ctx["stay"]["id"], target["id"])

    s = _room(client, admin_headers, "301")
    assert s["occupancy_status"] == "out_of_service"
    assert s["unavailability_source"] == "MAINTENANCE"
    assert s["cleaning_status"] == "dirty"
    # MWO 未被换房解决/取消/完成：仍 active，仍属原房
    mwo = db.get(MaintenanceWorkOrder, order["id"])
    assert mwo.status.value == "OPEN"
    assert mwo.room_id == source_id


def test_source_manual_unavailability_preserved(client, admin_headers):
    """源房 MANUAL OOS 状态必须继承，绝不被换房覆盖为 available（Sprint 6 §13）。"""
    ctx = setup_stay(client, admin_headers, "301")
    set_occupancy(client, admin_headers, "301", "out_of_service")
    assert (
        _room(client, admin_headers, "301")["unavailability_source"] == "MANUAL"
    )
    target = _room(client, admin_headers, "302")
    move(client, admin_headers, ctx["stay"]["id"], target["id"])
    s = _room(client, admin_headers, "301")
    assert s["occupancy_status"] == "out_of_service"
    assert s["unavailability_source"] == "MANUAL"
    assert s["cleaning_status"] == "dirty"


def test_move_fails_when_source_has_active_hk_task(client, admin_headers, db):
    """源房已有 active HK task -> 合理失败并整体回滚（不创建双任务，§14）。"""
    ctx = setup_stay(client, admin_headers, "301")
    source_id = ctx["room"]["id"]
    db.add(
        HousekeepingTask(
            task_no="HKTTEST-0001",
            room_id=source_id,
            status=HousekeepingTaskStatus.PENDING,
            priority=HousekeepingTaskPriority.NORMAL,
            source=HousekeepingTaskSource.MANUAL,
        )
    )
    db.flush()
    target = _room(client, admin_headers, "302")
    body = move(client, admin_headers, ctx["stay"]["id"], target["id"], expect=409)
    assert "已有进行中的保洁任务" in body["detail"]
    # 整体回滚：Stay 仍 301，assignment 仍 1 条 open，目标房仍 available
    stay_row = db.get(Stay, ctx["stay"]["id"])
    assert stay_row.room_id == source_id
    assert (
        db.scalar(
            select(func.count()).select_from(StayRoomAssignment).where(
                StayRoomAssignment.stay_id == ctx["stay"]["id"]
            )
        )
        == 1
    )
    assert db.get(Room, target["id"]).occupancy_status.value == "available"


# ---------------------------------------------------------------------------
# Reservation.room_id 冻结（Sprint 6 §17）
# ---------------------------------------------------------------------------


def test_checked_in_reservation_room_patch_blocked(client, admin_headers, db):
    ctx = setup_stay(client, admin_headers, "301")
    reservation_id = ctx["reservation"]["id"]
    other = _room(client, admin_headers, "303")
    resp = client.patch(
        f"/api/v1/reservations/{reservation_id}",
        json={"room_id": other["id"]},
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert "不能修改房间" in resp.json()["detail"]
    assert db.get(Reservation, reservation_id).room_id == ctx["room"]["id"]


def test_checked_in_original_room_released_for_new_reservation(
    client, admin_headers
):
    """核心领域语义（§6）：CHECKED_IN 预订的原房在换房后释放，
    可在原计划区间创建新的 CONFIRMED 预订。"""
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    move(client, admin_headers, ctx["stay"]["id"], target["id"])

    # Availability：原房 301 在剩余区间 [today, d(2)) 内不再被 CHECKED_IN 锁定
    avail = client.get(
        "/api/v1/availability",
        params={"check_in_date": iso(today()), "check_out_date": iso(d(2))},
        headers=admin_headers,
    ).json()
    item301 = next(i for i in avail["items"] if i["room_number"] == "301")
    item302 = next(i for i in avail["items"] if i["room_number"] == "302")
    assert item301["available"] is True
    assert item302["available"] is False  # 在住 + 当前日期区间

    # 原房 301 可创建重叠原计划区间的新 CONFIRMED 预订
    guest = create_guest(client, admin_headers, name="原房新客人")
    res = create_reservation(
        client,
        admin_headers,
        room=ctx["room"],
        guest_id=guest["id"],
        check_in=d(1),
        check_out=d(3),
    )
    assert res["status"] == "CONFIRMED"


def test_active_stay_still_blocks_overlap_on_current_room(
    client, admin_headers
):
    """未换房时，重叠 CONFIRMED 预订仍被在住检查拒绝（Active Stay 语义）。"""
    ctx = setup_stay(client, admin_headers, "301")
    guest = create_guest(client, admin_headers, name="抢房客人")
    resp = client.post(
        "/api/v1/reservations",
        json={
            "guest_id": guest["id"],
            "room_id": ctx["room"]["id"],
            "room_type_id": ctx["room"]["room_type_id"],
            "check_in_date": iso(d(1)),
            "check_out_date": iso(d(3)),
            "agreed_total_amount": "299.00",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert "已有在住记录" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# 审计（Sprint 6 §19）
# ---------------------------------------------------------------------------


def test_room_move_audit(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301", name="审计换房客人")
    target = _room(client, admin_headers, "302")
    move(
        client,
        admin_headers,
        ctx["stay"]["id"],
        target["id"],
        reason="GUEST_REQUEST",
        notes="客人要求高层",
    )
    resp = client.get(
        "/api/v1/audit-logs",
        params={"action": "stay.room_move", "page_size": 100},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    entries = [
        e for e in resp.json()["items"] if e["resource_id"] == ctx["stay"]["id"]
    ]
    assert len(entries) == 1
    details = entries[0]["details"]
    assert details["stay_id"] == ctx["stay"]["id"]
    assert details["from_room_number"] == "301"
    assert details["to_room_number"] == "302"
    assert details["reason"] == "GUEST_REQUEST"
    assert details["notes_recorded"] is True
    assert details["operator_user_id"] is not None
    # 不含 Guest PII 与 notes 内容（§19）
    blob = json.dumps(details, ensure_ascii=False)
    assert "审计换房客人" not in blob
    assert "13800" not in blob
    assert "客人要求高层" not in blob
    assert "example.com" not in blob


# ---------------------------------------------------------------------------
# 事务回滚（Sprint 6 §12）
# ---------------------------------------------------------------------------


def _boom(*args, **kwargs):
    raise RuntimeError("hk task failure")


def test_move_rollback_on_hk_task_failure(client, admin_headers, db, monkeypatch):
    """保洁任务创建失败 -> 整个换房事务回滚，不允许半换房。"""
    ctx = setup_stay(client, admin_headers, "301")
    stay_id, source_id = ctx["stay"]["id"], ctx["room"]["id"]
    target = _room(client, admin_headers, "302")

    monkeypatch.setattr(room_move_service, "create_room_move_task", _boom)
    with pytest.raises(RuntimeError):
        client.post(
            f"/api/v1/stays/{stay_id}/room-move",
            json={"target_room_id": target["id"], "reason": "MAINTENANCE"},
            headers=admin_headers,
        )

    stay_row = db.get(Stay, stay_id)
    assert stay_row.room_id == source_id
    open_row = db.scalar(
        select(StayRoomAssignment).where(
            StayRoomAssignment.stay_id == stay_id,
            StayRoomAssignment.ended_at.is_(None),
        )
    )
    assert open_row.room_id == source_id
    source_row = db.get(Room, source_id)
    assert source_row.occupancy_status.value == "occupied"
    assert source_row.cleaning_status.value == "clean"
    target_row = db.get(Room, target["id"])
    assert target_row.occupancy_status.value == "available"
    assert (
        db.scalar(
            select(func.count()).select_from(HousekeepingTask).where(
                HousekeepingTask.room_id == source_id
            )
        )
        == 0
    )


# ---------------------------------------------------------------------------
# room-move-options（Sprint 6 §9/§11）
# ---------------------------------------------------------------------------


def test_move_options_lists_eligible_targets(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    body = move_options(client, admin_headers, ctx["stay"]["id"])
    assert body["current_room_id"] == ctx["room"]["id"]
    assert body["planned_check_out_date"] == iso(d(2))
    source = option_for(body, "301")
    assert source["eligible"] is False
    assert "当前入住房间" in source["reason"]
    target = option_for(body, "302")
    assert target["eligible"] is True
    # response_model_exclude_none：reason 为 null 时键缺失
    assert target.get("reason") is None


def test_move_options_excludes_ineligible(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    target = _room(client, admin_headers, "302")
    _set_cleaning(client, admin_headers, target["id"], "dirty")
    set_occupancy(client, admin_headers, "303", "blocked")
    guest = create_guest(client, admin_headers, name="窗口预订客人")
    create_reservation(
        client,
        admin_headers,
        room=_room(client, admin_headers, "304"),
        guest_id=guest["id"],
        check_in=d(1),
        check_out=d(3),
    )
    body = move_options(client, admin_headers, ctx["stay"]["id"])
    assert option_for(body, "302")["eligible"] is False
    assert "未清洁" in option_for(body, "302")["reason"]
    assert option_for(body, "303")["eligible"] is False
    assert option_for(body, "304")["eligible"] is False
    assert "已有预订" in option_for(body, "304")["reason"]


def test_move_options_non_active_409_and_404(client, admin_headers):
    ctx = setup_stay(client, admin_headers, "301")
    check_out(client, admin_headers, ctx["stay"]["id"])
    move_options(client, admin_headers, ctx["stay"]["id"], expect=409)
    move_options(client, admin_headers, 999999, expect=404)


# ---------------------------------------------------------------------------
# RBAC（Sprint 6 §18）
# ---------------------------------------------------------------------------


def test_room_move_rbac(client, admin_headers, make_user, token_for):
    ctx = setup_stay(client, admin_headers, "301")
    stay_id = ctx["stay"]["id"]
    target = _room(client, admin_headers, "302")

    frontdesk = make_user("rm_front", role_names=["FRONT_DESK"])
    housekeeping = make_user("rm_hk", role_names=["HOUSEKEEPING"])
    maintenance = make_user("rm_maint", role_names=["MAINTENANCE"])
    finance = make_user("rm_fin", role_names=["FINANCE"])

    fd_headers = {"Authorization": f"Bearer {token_for(frontdesk['username'])}"}
    for username in ("rm_hk", "rm_maint", "rm_fin"):
        headers = {"Authorization": f"Bearer {token_for(username)}"}
        assert (
            client.get(
                f"/api/v1/stays/{stay_id}/room-move-options", headers=headers
            ).status_code
            == 403
        )
        assert (
            client.post(
                f"/api/v1/stays/{stay_id}/room-move",
                json={"target_room_id": target["id"], "reason": "GUEST_REQUEST"},
                headers=headers,
            ).status_code
            == 403
        )

    # FRONT_DESK 有 stay:room_move：options + move 均可用
    assert (
        client.get(
            f"/api/v1/stays/{stay_id}/room-move-options", headers=fd_headers
        ).status_code
        == 200
    )
    resp = client.post(
        f"/api/v1/stays/{stay_id}/room-move",
        json={"target_room_id": target["id"], "reason": "GUEST_REQUEST"},
        headers=fd_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["room_id"] == target["id"]
