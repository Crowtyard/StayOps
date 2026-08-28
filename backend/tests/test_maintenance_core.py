# -*- coding: utf-8 -*-
"""Maintenance Work Order 核心域测试（Sprint 5）：

- create non-blocking / blocking（available / occupied / reserved / manual OOS / blocked）
- severity ≠ blocks_room（CRITICAL 不自动阻断）
- 完整主路径：Report → Assign → Start → Resolve → Verify → Complete → Room Ready
- Rework / Cancel / 多张 blocking 工单 / Last Blocking 规则
- Maintenance 只能解除自己造成的 OOS（MANUAL OOS / blocked 保护）
- 状态机非法转换 409；PATCH strict（status / blocks_room 禁止）
- 业务单号格式与唯一性；PRE_OPENING source；list 筛选与 search
"""

import re

from app.models import Room
from tests.booking_helpers import find_room
from tests.mwo_helpers import (
    assign_order,
    create_order,
    get_order,
    list_orders,
    make_dirty,
    me_user_id,
    order_action,
    patch_order,
    set_occupancy,
)

WORK_ORDER_NO_RE = re.compile(r"^MWO\d{8}-\d{4,}$")


def _room_row(db, room_id: int) -> Room:
    # API 请求在独立 Session 提交；expire 避免 fixture 会话身份映射返回旧对象
    db.expire_all()
    return db.get(Room, room_id)


# ---------------------------------------------------------------------------
# 创建语义
# ---------------------------------------------------------------------------


def test_create_non_blocking_order_room_unchanged(client, admin_headers, db):
    """blocks_room=false：Room 完全不变（available + clean + source None）。"""
    room = find_room(client, admin_headers, "101")
    assert room["occupancy_status"] == "available"
    assert room["unavailability_source"] is None

    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=False,
        title="灯泡更换",
    )
    assert order["status"] == "OPEN"
    assert order["blocks_room"] is False
    assert order["title"] == "灯泡更换"

    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "available"
    assert row.cleaning_status.value == "clean"
    assert row.unavailability_source is None


def test_create_blocking_available_room_becomes_oos(client, admin_headers, db):
    """blocks_room=true + available -> 同事务 OOS + source=MAINTENANCE；
    Cleaning 不变（可合法出现 out_of_service + clean）。"""
    room = find_room(client, admin_headers, "102")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="PLUMBING",
        severity="HIGH",
        title="无热水",
    )
    assert order["blocks_room"] is True
    assert order["room_occupancy_status"] == "out_of_service"
    assert order["room_cleaning_status"] == "clean"

    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"
    assert row.unavailability_source.value == "MAINTENANCE"
    assert row.cleaning_status.value == "clean"  # 维修不改清洁维度


def test_create_blocking_occupied_room_preserves_occupied(client, admin_headers, db):
    """Sprint 5 §12：occupied 房间发生 blocking 维修 -> 不允许 occupied -> OOS；
    房间保持 occupied，工单独立阻断 Availability / Check-in。"""
    room = find_room(client, admin_headers, "103")
    set_occupancy(client, admin_headers, "103", "occupied")

    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="HVAC",
        title="空调故障",
    )
    assert order["room_occupancy_status"] == "occupied"

    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "occupied"
    assert row.unavailability_source is None  # 未被改成 MAINTENANCE


def test_create_blocking_reserved_room_preserved(client, admin_headers, db):
    """reserved 房间：保留当前占用状态，不粗暴覆盖已有业务状态。"""
    room = find_room(client, admin_headers, "104")
    set_occupancy(client, admin_headers, "104", "reserved")

    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="LOCK",
        title="门锁故障",
    )
    assert order["room_occupancy_status"] == "reserved"
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "reserved"
    assert row.unavailability_source is None


def test_create_blocking_manual_oos_preserved(client, admin_headers, db):
    """Sprint 5 §14：MANUAL OOS 不得被 Maintenance 改成 MAINTENANCE。"""
    set_occupancy(client, admin_headers, "105", "out_of_service")
    room = find_room(client, admin_headers, "105")
    assert room["unavailability_source"] == "MANUAL"

    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="FURNITURE",
        title="床架维修",
    )
    assert order["room_occupancy_status"] == "out_of_service"
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"
    assert row.unavailability_source.value == "MANUAL"  # 未被覆盖


def test_create_blocking_blocked_room_preserved(client, admin_headers, db):
    """blocked（人工锁房）房间：保留 blocked + MANUAL，Maintenance 不得解除/覆盖。"""
    set_occupancy(client, admin_headers, "106", "blocked")
    room = find_room(client, admin_headers, "106")
    assert room["unavailability_source"] == "MANUAL"

    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="FINISHING",
        title="计划装修",
    )
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "blocked"
    assert row.unavailability_source.value == "MANUAL"


def test_severity_critical_does_not_imply_blocks_room(client, admin_headers, db):
    """Sprint 5 §7：severity 与 blocks_room 相互独立。"""
    room = find_room(client, admin_headers, "107")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        severity="CRITICAL",
        blocks_room=False,
        title="紧急但不阻断",
    )
    assert order["severity"] == "CRITICAL"
    assert order["blocks_room"] is False
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "available"


def test_create_order_room_not_found(client, admin_headers):
    resp = client.post(
        "/api/v1/maintenance/orders",
        json={
            "room_id": 99999,
            "category": "HVAC",
            "title": "不存在房间",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 主路径 + 状态机
# ---------------------------------------------------------------------------


def test_full_golden_path_flow(client, admin_headers, db):
    """Report → Assign → Start → Resolve → Verify → Complete；最后一张 blocking
    工单验收通过后 Room 恢复 available + source null，Cleaning 保持。"""
    room = find_room(client, admin_headers, "108")
    make_dirty(client, admin_headers, "108")  # cleaning 与维修独立
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="ELECTRICAL",
        title="插座短路",
    )
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"
    assert row.cleaning_status.value == "dirty"

    # assign：admin（SUPER_ADMIN）自身即持有全部权限，可作为派单目标
    order = assign_order(
        client, admin_headers, order["id"], me_user_id(client, admin_headers)
    )
    assert order["status"] == "ASSIGNED"

    order = order_action(client, admin_headers, order["id"], "start")
    assert order["status"] == "IN_PROGRESS"
    assert order["started_at"] is not None

    order = order_action(
        client,
        admin_headers,
        order["id"],
        "resolve",
        payload={"resolution_notes": "已更换插座面板"},
    )
    assert order["status"] == "RESOLVED"
    assert order["resolved_at"] is not None
    assert order["resolution_notes"] == "已更换插座面板"
    # RESOLVED 仍阻断
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"

    order = order_action(
        client,
        admin_headers,
        order["id"],
        "verify",
        payload={"verification_notes": "复测正常"},
    )
    assert order["status"] == "COMPLETED"
    assert order["verified_at"] is not None
    assert order["completed_at"] is not None
    assert order["verification_notes"] == "复测正常"

    # 最后一张 blocking 工单完成 -> Room 恢复 available + null；Cleaning 保持
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "available"
    assert row.unavailability_source is None
    assert row.cleaning_status.value == "dirty"  # Maintenance 不改 cleaning


def test_rework_flow_keeps_blocking(client, admin_headers, db):
    """Verify 不通过：RESOLVED -> IN_PROGRESS；blocks_room 继续阻断，不恢复 Room。"""
    room = find_room(client, admin_headers, "109")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="BATHROOM",
        title="淋浴漏水",
    )
    worker = me_user_id(client, admin_headers)
    order = assign_order(client, admin_headers, order["id"], worker)
    order = order_action(client, admin_headers, order["id"], "start")
    order = order_action(client, admin_headers, order["id"], "resolve")
    assert order["status"] == "RESOLVED"

    order = order_action(
        client,
        admin_headers,
        order["id"],
        "rework",
        payload={"verification_notes": "仍渗水，需重新打胶"},
    )
    assert order["status"] == "IN_PROGRESS"
    assert order["verification_notes"] == "仍渗水，需重新打胶"

    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"  # 继续阻断

    # 返工后重新 Resolve -> Verify -> Complete -> 恢复
    order = order_action(client, admin_headers, order["id"], "resolve")
    order = order_action(client, admin_headers, order["id"], "verify")
    assert order["status"] == "COMPLETED"
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "available"
    assert row.unavailability_source is None


def test_illegal_transitions_409(client, admin_headers):
    """状态机非法转换全部 409（后端强制，前端只是提示）。"""
    room = find_room(client, admin_headers, "110")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="状态机测试",
    )
    oid = order["id"]
    # OPEN 不能 start / resolve / verify / rework
    assert order_action(client, admin_headers, oid, "start", expect=409)["detail"]
    assert order_action(client, admin_headers, oid, "resolve", expect=409)["detail"]
    assert order_action(client, admin_headers, oid, "verify", expect=409)["detail"]
    assert order_action(client, admin_headers, oid, "rework", expect=409)["detail"]

    # 派单后不能 resolve / verify（必须先 start）
    worker = me_user_id(client, admin_headers)
    assign_order(client, admin_headers, oid, worker)
    assert order_action(client, admin_headers, oid, "resolve", expect=409)["detail"]
    assert order_action(client, admin_headers, oid, "verify", expect=409)["detail"]
    assert order_action(client, admin_headers, oid, "rework", expect=409)["detail"]

    # IN_PROGRESS 不能 assign / verify
    order_action(client, admin_headers, oid, "start")
    assert assign_order(client, admin_headers, oid, worker, expect=409)["detail"]
    assert order_action(client, admin_headers, oid, "verify", expect=409)["detail"]

    # 完成路径后终态不可再操作
    order_action(client, admin_headers, oid, "resolve")
    order_action(client, admin_headers, oid, "verify")
    assert order_action(client, admin_headers, oid, "cancel", expect=409)["detail"]
    assert order_action(client, admin_headers, oid, "rework", expect=409)["detail"]
    assert assign_order(client, admin_headers, oid, worker, expect=409)["detail"]


def test_cancelled_is_terminal(client, admin_headers):
    room = find_room(client, admin_headers, "201")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=False,
        title="取消终态测试",
    )
    order = order_action(client, admin_headers, order["id"], "cancel")
    assert order["status"] == "CANCELLED"
    assert order["cancelled_at"] is not None
    assert order_action(client, admin_headers, order["id"], "start", expect=409)["detail"]


# ---------------------------------------------------------------------------
# Multiple Work Orders / Last Blocking 规则
# ---------------------------------------------------------------------------


def test_multiple_blocking_orders_last_one_restores(client, admin_headers, db):
    """Sprint 5 §21/§22：同一 Room 可有多张 Active 工单；
    仅当 active blocking count == 0 才恢复。"""
    room = find_room(client, admin_headers, "202")
    first = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="HVAC",
        title="空调故障",
    )
    second = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        category="PLUMBING",
        title="马桶堵塞",
    )
    third = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=False,
        category="NETWORK",
        title="WiFi 慢（不阻断）",
    )
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"

    worker = me_user_id(client, admin_headers)

    def complete(order: dict) -> None:
        assign_order(client, admin_headers, order["id"], worker)
        order_action(client, admin_headers, order["id"], "start")
        order_action(client, admin_headers, order["id"], "resolve")
        order_action(client, admin_headers, order["id"], "verify")

    complete(first)
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service", "仍有 blocking 工单，不得恢复"

    complete(third)  # 非 blocking 完成不影响
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"

    complete(second)  # 最后一张 blocking 完成 -> 恢复
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "available"
    assert row.unavailability_source is None


def test_cancel_blocking_last_restores_room(client, admin_headers, db):
    """Sprint 5 §26：取消最后一张 blocking 工单 -> Room 恢复。"""
    room = find_room(client, admin_headers, "203")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="取消恢复测试",
    )
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"

    order_action(client, admin_headers, order["id"], "cancel")
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "available"
    assert row.unavailability_source is None


def test_cancel_blocking_with_other_blocker_keeps_oos(client, admin_headers, db):
    room = find_room(client, admin_headers, "204")
    first = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="阻断一",
    )
    second = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="阻断二",
    )
    order_action(client, admin_headers, first["id"], "cancel")
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"
    order_action(client, admin_headers, second["id"], "cancel")
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "available"


def test_cancel_non_blocking_room_unchanged(client, admin_headers, db):
    room = find_room(client, admin_headers, "205")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=False,
        title="非阻断取消",
    )
    order_action(client, admin_headers, order["id"], "cancel")
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "available"
    assert row.unavailability_source is None


# ---------------------------------------------------------------------------
# Maintenance 只能解除自己造成的 OOS
# ---------------------------------------------------------------------------


def test_verify_does_not_restore_manual_oos(client, admin_headers, db):
    """Sprint 5 §23：MANUAL OOS 完成后不得自动恢复。"""
    set_occupancy(client, admin_headers, "206", "out_of_service")
    room = find_room(client, admin_headers, "206")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="人工停用房维修",
    )
    worker = me_user_id(client, admin_headers)
    assign_order(client, admin_headers, order["id"], worker)
    order_action(client, admin_headers, order["id"], "start")
    order_action(client, admin_headers, order["id"], "resolve")
    order_action(client, admin_headers, order["id"], "verify")

    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"  # 仍停用
    assert row.unavailability_source.value == "MANUAL"  # 来源未被覆盖


def test_verify_does_not_unblock_blocked_room(client, admin_headers, db):
    """blocked 房间：Maintenance 完成后不得解除锁房。"""
    set_occupancy(client, admin_headers, "207", "blocked")
    room = find_room(client, admin_headers, "207")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="锁房期间维修",
    )
    worker = me_user_id(client, admin_headers)
    assign_order(client, admin_headers, order["id"], worker)
    order_action(client, admin_headers, order["id"], "start")
    order_action(client, admin_headers, order["id"], "resolve")
    order_action(client, admin_headers, order["id"], "verify")

    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "blocked"
    assert row.unavailability_source.value == "MANUAL"


def test_cancel_does_not_restore_manual_oos(client, admin_headers, db):
    set_occupancy(client, admin_headers, "208", "out_of_service")
    room = find_room(client, admin_headers, "208")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="人工停用取消测试",
    )
    order_action(client, admin_headers, order["id"], "cancel")
    row = _room_row(db, room["id"])
    assert row.occupancy_status.value == "out_of_service"
    assert row.unavailability_source.value == "MANUAL"


# ---------------------------------------------------------------------------
# PATCH strict
# ---------------------------------------------------------------------------


def test_patch_fields_and_strict_semantics(client, admin_headers):
    room = find_room(client, admin_headers, "209")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=False,
        title="PATCH 测试",
        severity="LOW",
    )
    oid = order["id"]

    # 合法字段编辑
    updated = patch_order(
        client,
        admin_headers,
        oid,
        {"severity": "HIGH", "title": "改标题", "description": "补充描述"},
    )
    assert updated["severity"] == "HIGH"
    assert updated["title"] == "改标题"
    assert updated["description"] == "补充描述"

    # status / blocks_room / 未知字段 -> 422（strict schema）
    assert patch_order(client, admin_headers, oid, {"status": "COMPLETED"}, expect=422)
    assert patch_order(client, admin_headers, oid, {"blocks_room": True}, expect=422)
    assert patch_order(client, admin_headers, oid, {"foo": 1}, expect=422)
    # 空 payload -> 422
    assert patch_order(client, admin_headers, oid, {}, expect=422)

    # 终态 PATCH -> 409
    order_action(client, admin_headers, oid, "cancel")
    assert patch_order(
        client, admin_headers, oid, {"severity": "LOW"}, expect=409
    )["detail"]


# ---------------------------------------------------------------------------
# 业务单号 / source / list 筛选
# ---------------------------------------------------------------------------


def test_work_order_no_format_and_uniqueness(client, admin_headers):
    room = find_room(client, admin_headers, "210")
    first = create_order(client, admin_headers, room_id=room["id"])
    second = create_order(client, admin_headers, room_id=room["id"])
    assert WORK_ORDER_NO_RE.match(first["work_order_no"])
    assert WORK_ORDER_NO_RE.match(second["work_order_no"])
    assert first["work_order_no"] != second["work_order_no"]


def test_pre_opening_source_and_filter(client, admin_headers):
    room = find_room(client, admin_headers, "301")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        source="PRE_OPENING",
        title="开业前整改项",
    )
    assert order["source"] == "PRE_OPENING"
    result = list_orders(client, admin_headers, source="PRE_OPENING", room_id=room["id"])
    assert any(o["id"] == order["id"] for o in result["items"])


def test_list_filters_and_search(client, admin_headers):
    room = find_room(client, admin_headers, "302")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        category="APPLIANCE",
        severity="HIGH",
        blocks_room=True,
        source="FRONT_DESK",
        title="冰箱不制冷",
    )
    # 各筛选维度
    assert list_orders(client, admin_headers, category="APPLIANCE")["total"] >= 1
    assert list_orders(client, admin_headers, severity="HIGH")["total"] >= 1
    assert list_orders(client, admin_headers, source="FRONT_DESK")["total"] >= 1
    assert list_orders(client, admin_headers, blocks_room="true")["total"] >= 1
    assert list_orders(client, admin_headers, room_id=room["id"])["total"] >= 1
    # search：work_order_no / room_no / title
    by_no = list_orders(client, admin_headers, search=order["work_order_no"])
    assert any(o["id"] == order["id"] for o in by_no["items"])
    by_room = list_orders(client, admin_headers, search=room["room_number"])
    assert any(o["id"] == order["id"] for o in by_room["items"])
    by_title = list_orders(client, admin_headers, search="冰箱")
    assert any(o["id"] == order["id"] for o in by_title["items"])


def test_get_order_includes_room_dual_state(client, admin_headers):
    """详情响应包含 Room occupancy_status + cleaning_status（Sprint 5 §35）。"""
    room = find_room(client, admin_headers, "303")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        blocks_room=True,
        title="双状态展示",
    )
    detail = get_order(client, admin_headers, order["id"])
    assert detail["room_occupancy_status"] == "out_of_service"
    assert detail["room_cleaning_status"] == "clean"
    assert detail["room_number"] == "303"


def test_get_order_404(client, admin_headers):
    assert get_order(client, admin_headers, 99999, expect=404)
