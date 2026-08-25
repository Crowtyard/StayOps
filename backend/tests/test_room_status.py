# -*- coding: utf-8 -*-
"""房态状态机测试（双维度：占用/清洁）。

- 合法/非法转换（各自维度独立状态机，非法 409）
- 双维度组合（如 reserved + dirty）
- 细粒度权限（HOUSEKEEPING 仅清洁维度 / MAINTENANCE 仅置 out_of_service）
- 审计写入
"""

from sqlalchemy import select

from app.models import AuditLog


def _find_room(client, headers, room_number: str) -> dict:
    rooms = client.get(
        "/api/v1/rooms", params={"page_size": 100}, headers=headers
    ).json()["items"]
    return next(r for r in rooms if r["room_number"] == room_number)


def _change(client, headers, room_id: int, **status_fields):
    """POST /rooms/{id}/status，status_fields 为 occupancy_status/cleaning_status。"""
    return client.post(
        f"/api/v1/rooms/{room_id}/status",
        json=status_fields,
        headers=headers,
    )


# ---------- 合法转换 ----------

def test_legal_occupancy_guest_cycle(client, admin_headers):
    """available -> reserved -> occupied -> available（预订->入住->退房）。"""
    room = _find_room(client, admin_headers, "101")
    r1 = _change(client, admin_headers, room["id"], occupancy_status="reserved")
    assert r1.status_code == 200 and r1.json()["occupancy_status"] == "reserved"
    r2 = _change(client, admin_headers, room["id"], occupancy_status="occupied")
    assert r2.status_code == 200 and r2.json()["occupancy_status"] == "occupied"
    r3 = _change(client, admin_headers, room["id"], occupancy_status="available")
    assert r3.status_code == 200 and r3.json()["occupancy_status"] == "available"


def test_legal_cleaning_cycle(client, admin_headers):
    """clean -> dirty -> cleaning -> clean（退房->待扫->打扫->干净）。"""
    room = _find_room(client, admin_headers, "102")
    r1 = _change(client, admin_headers, room["id"], cleaning_status="dirty")
    assert r1.status_code == 200 and r1.json()["cleaning_status"] == "dirty"
    r2 = _change(client, admin_headers, room["id"], cleaning_status="cleaning")
    assert r2.status_code == 200 and r2.json()["cleaning_status"] == "cleaning"
    r3 = _change(client, admin_headers, room["id"], cleaning_status="clean")
    assert r3.status_code == 200 and r3.json()["cleaning_status"] == "clean"


def test_legal_cleaning_inspection_rework(client, admin_headers):
    """cleaning -> inspection -> rework -> cleaning（查房->返工->重扫）。"""
    room = _find_room(client, admin_headers, "103")
    _change(client, admin_headers, room["id"], cleaning_status="dirty")
    _change(client, admin_headers, room["id"], cleaning_status="cleaning")
    r1 = _change(client, admin_headers, room["id"], cleaning_status="inspection")
    assert r1.status_code == 200 and r1.json()["cleaning_status"] == "inspection"
    r2 = _change(client, admin_headers, room["id"], cleaning_status="rework")
    assert r2.status_code == 200 and r2.json()["cleaning_status"] == "rework"
    r3 = _change(client, admin_headers, room["id"], cleaning_status="cleaning")
    assert r3.status_code == 200


def test_legal_blocked_and_out_of_service(client, admin_headers):
    """available -> blocked -> available；available -> out_of_service -> available。"""
    room = _find_room(client, admin_headers, "104")
    r1 = _change(client, admin_headers, room["id"], occupancy_status="blocked")
    assert r1.status_code == 200 and r1.json()["occupancy_status"] == "blocked"
    r2 = _change(client, admin_headers, room["id"], occupancy_status="available")
    assert r2.status_code == 200
    r3 = _change(client, admin_headers, room["id"], occupancy_status="out_of_service")
    assert r3.status_code == 200 and r3.json()["occupancy_status"] == "out_of_service"
    r4 = _change(client, admin_headers, room["id"], occupancy_status="available")
    assert r4.status_code == 200


def test_legal_combined_dimensions(client, admin_headers):
    """同时改两个维度（admin 有 room:write）：reserved + dirty 组合被允许。"""
    room = _find_room(client, admin_headers, "105")
    resp = _change(
        client,
        admin_headers,
        room["id"],
        occupancy_status="reserved",
        cleaning_status="dirty",
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["occupancy_status"] == "reserved"
    assert body["cleaning_status"] == "dirty"


# ---------- 非法转换 ----------

def test_illegal_cleaning_skip_409(client, admin_headers):
    """clean -> cleaning 跳级（须先 dirty）409。"""
    room = _find_room(client, admin_headers, "106")
    resp = _change(client, admin_headers, room["id"], cleaning_status="cleaning")
    assert resp.status_code == 409
    assert "非法清洁状态转换" in resp.json()["detail"]


def test_illegal_occupied_to_blocked_409(client, admin_headers):
    """occupied -> blocked 非法 409。"""
    room = _find_room(client, admin_headers, "107")
    _change(client, admin_headers, room["id"], occupancy_status="occupied")
    resp = _change(client, admin_headers, room["id"], occupancy_status="blocked")
    assert resp.status_code == 409
    assert "非法占用状态转换" in resp.json()["detail"]


def test_illegal_dirty_to_clean_409(client, admin_headers):
    """dirty -> clean 跳级（须经 cleaning）409。"""
    room = _find_room(client, admin_headers, "108")
    _change(client, admin_headers, room["id"], cleaning_status="dirty")
    resp = _change(client, admin_headers, room["id"], cleaning_status="clean")
    assert resp.status_code == 409


def test_same_status_409(client, admin_headers):
    room = _find_room(client, admin_headers, "109")
    resp = _change(client, admin_headers, room["id"], occupancy_status="available")
    assert resp.status_code == 409


def test_invalid_status_value_422(client, admin_headers):
    room = _find_room(client, admin_headers, "110")
    resp = _change(client, admin_headers, room["id"], occupancy_status="flying")
    assert resp.status_code == 422


def test_empty_payload_422(client, admin_headers):
    room = _find_room(client, admin_headers, "201")
    resp = _change(client, admin_headers, room["id"])
    assert resp.status_code == 422


# ---------- 细粒度权限 ----------

def test_housekeeping_only_cleaning(client, admin_headers, make_user, token_for):
    """HOUSEKEEPING：仅可改清洁维度；占用维度/同时两维度 403。"""
    make_user("hk_status", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('hk_status')}"}
    room = _find_room(client, admin_headers, "202")
    # 允许：dirty -> cleaning（清洁维度）
    _change(client, admin_headers, room["id"], cleaning_status="dirty")
    r = _change(client, h, room["id"], cleaning_status="cleaning")
    assert r.status_code == 200 and r.json()["cleaning_status"] == "cleaning"
    # 拒绝：改占用维度
    assert (
        _change(client, h, room["id"], occupancy_status="occupied").status_code
        == 403
    )
    # 拒绝：同时改两个维度
    assert (
        _change(
            client, h, room["id"],
            occupancy_status="available", cleaning_status="clean",
        ).status_code
        == 403
    )


def test_maintenance_only_out_of_service(client, admin_headers, make_user, token_for):
    """MAINTENANCE：仅可把占用状态置为 out_of_service（维修停用）。"""
    make_user("mt_status", role_names=["MAINTENANCE"])
    h = {"Authorization": f"Bearer {token_for('mt_status')}"}
    room = _find_room(client, admin_headers, "203")
    r = _change(client, h, room["id"], occupancy_status="out_of_service")
    assert r.status_code == 200 and r.json()["occupancy_status"] == "out_of_service"
    # 拒绝：置为 available（恢复需 room:write）
    assert (
        _change(client, h, room["id"], occupancy_status="available").status_code
        == 403
    )
    # 拒绝：改清洁维度
    assert (
        _change(client, h, room["id"], cleaning_status="dirty").status_code == 403
    )


def test_front_desk_room_write_subject_to_state_machine(
    client, admin_headers, make_user, token_for
):
    """FRONT_DESK 有 room:write：可变更房态，但仍受状态机约束（409）。"""
    make_user("fd_status", role_names=["FRONT_DESK"])
    h = {"Authorization": f"Bearer {token_for('fd_status')}"}
    room = _find_room(client, admin_headers, "204")
    r = _change(client, h, room["id"], occupancy_status="occupied")
    assert r.status_code == 200
    # occupied -> blocked 非法
    assert (
        _change(client, h, room["id"], occupancy_status="blocked").status_code
        == 409
    )


# ---------- 审计 ----------

def test_status_change_writes_audit(client, admin_headers, db):
    room = _find_room(client, admin_headers, "205")
    resp = _change(
        client,
        admin_headers,
        room["id"],
        occupancy_status="reserved",
        cleaning_status="dirty",
    )
    assert resp.status_code == 200
    row = db.scalar(
        select(AuditLog)
        .where(
            AuditLog.action == "room.status_change",
            AuditLog.resource_id == room["id"],
        )
        .order_by(AuditLog.id.desc())
    )
    assert row is not None
    assert row.details == {
        "occupancy_status": {"from": "available", "to": "reserved"},
        "cleaning_status": {"from": "clean", "to": "dirty"},
    }
    assert row.ip == "testclient"
    assert row.resource_type == "room"
    assert row.user_id is not None


def test_status_change_room_404(client, admin_headers):
    resp = _change(client, admin_headers, 99999, occupancy_status="occupied")
    assert resp.status_code == 404
