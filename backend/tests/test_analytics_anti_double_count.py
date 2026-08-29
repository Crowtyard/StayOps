# -*- coding: utf-8 -*-
"""S8 P0 防重复计数（§54）：Room Move 绝不重复酒店总体实际房晚。

酒店总体房晚 MUST derive from Stay（§5）；StayRoomAssignment 只用于
room history / move event / 实际房间归属，其 per-room 归属之和必须等于
Stay 区间（不产生重复房晚）。
"""

from sqlalchemy import select

from app.core.business_date import PROPERTY_UTC_OFFSET
from app.models import StayRoomAssignment

from tests.analytics_helpers import build_stay, d, get_analytics, iso
from tests.booking_helpers import find_room


def _per_room_nights(db, stay_id: int) -> dict[str, int]:
    """按 assignment 的 Business Date 区间统计每房房晚（归属口径）。"""
    rows = db.scalars(
        select(StayRoomAssignment)
        .where(StayRoomAssignment.stay_id == stay_id)
        .order_by(StayRoomAssignment.id)
    ).all()
    result: dict[str, int] = {}
    for a in rows:
        start_bd = (a.started_at.astimezone(PROPERTY_UTC_OFFSET)).date()
        end_bd = (a.ended_at.astimezone(PROPERTY_UTC_OFFSET)).date()
        room_no = a.room.room_number
        result[room_no] = result.get(room_no, 0) + (end_bd - start_bd).days
    return result


def test_same_stay_room_move_no_double_count(client, db, admin_headers):
    """Stay 203 → 205：酒店总体实际房晚 = Stay 区间 3 晚（不是 4/6）。"""
    room203 = find_room(client, admin_headers, "203")
    room205 = find_room(client, admin_headers, "205")
    built = build_stay(
        client, db, admin_headers, room203, ci=(-3, 14), co=(0, 10),
        amount="600.00",
        moves=[(room205["id"], "OPERATIONAL", (-2, 9))],
    )
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-4)), "to": iso(d(0))},
    )
    m = data["metrics"]
    # Stay 区间 [d-3, d0) = 3 晚；若按 assignment 双计（原房+新房各算整段）→ 6
    assert m["actual_occupied_room_nights"] == 3
    assert m["room_move_count"] == 1
    assert m["moved_stay_count"] == 1

    # 房间归属口径：203 1 晚 + 205 2 晚 = 3 = Stay 区间（无重复、无遗漏）
    per_room = _per_room_nights(db, built["stay_id"])
    assert per_room == {"203": 1, "205": 2}
    assert sum(per_room.values()) == 3


def test_two_moves_still_one_stay(client, db, admin_headers):
    """Stay 203 → 205 → 208（两次换房）：酒店总体房晚仍基于一个 Stay（§54）。"""
    room203 = find_room(client, admin_headers, "203")
    room205 = find_room(client, admin_headers, "205")
    room208 = find_room(client, admin_headers, "208")
    built = build_stay(
        client, db, admin_headers, room203, ci=(-4, 14), co=(0, 10),
        amount="900.00",
        moves=[
            (room205["id"], "OPERATIONAL", (-3, 9)),
            (room208["id"], "GUEST_REQUEST", (-2, 9)),
        ],
    )
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-5)), "to": iso(d(0))},
    )
    m = data["metrics"]
    # Stay 区间 [d-4, d0) = 4 晚；3 条 assignment 归属之和必须仍是 4
    assert m["actual_occupied_room_nights"] == 4
    assert m["room_move_count"] == 2
    assert m["moved_stay_count"] == 1
    per_room = _per_room_nights(db, built["stay_id"])
    assert per_room == {"203": 1, "205": 1, "208": 2}
    assert sum(per_room.values()) == 4
    # room-moves 端点：两次事件、涉及 1 个 Stay、原因分布正确
    rm = get_analytics(
        client, admin_headers, "operations/room-moves",
        {"from": iso(d(-5)), "to": iso(d(0))},
    )
    assert rm["room_move_count"] == 2
    assert rm["moved_stay_count"] == 1
    assert {r["reason"]: r["count"] for r in rm["room_moves_by_reason"]} == {
        "OPERATIONAL": 1, "GUEST_REQUEST": 1,
    }


def test_no_move_single_room_still_exact(client, db, admin_headers):
    """无换房 Stay 的房晚口径保持不变（回归基线）。"""
    room206 = find_room(client, admin_headers, "206")
    built = build_stay(
        client, db, admin_headers, room206, ci=(-2, 14), co=(0, 10),
        amount="400.00",
    )
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-2)), "to": iso(d(0))},
    )
    assert data["metrics"]["actual_occupied_room_nights"] == 2
    assert _per_room_nights(db, built["stay_id"]) == {"206": 2}
