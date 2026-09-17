# -*- coding: utf-8 -*-
"""alpha.9.6 F2 某日房态（date occupancy resolver）测试。

覆盖任务书 §12 的 Date occupancy 全部要求：
- no reservation = available
- future reservation（含 arriving 到店标记）
- multi-night reservation
- checkout boundary（退房日不算整日占用）
- occupied stay
- maintenance override（物理 override 优先，不因当天无预订就标可售）
- disabled room excluded（停用房间不进入占用分区与分母）
- 分区不变式（available + reserved + occupied + oos == enabled_room_count）
- 不与可售性引擎矛盾（对拍）
- 未来日期 physical_status_authoritative=false（禁止用当前 Room.status 冒充未来房态）
- 不推断未来 CLEANING
- 参数校验
"""

from datetime import timedelta

import pytest

from app.core.business_date import business_date
from tests.booking_helpers import create_guest, create_reservation, find_room


def _d(days: int):
    return business_date() + timedelta(days=days)


def _status(client, headers, date_value=None) -> dict:
    params = {} if date_value is None else {"date": date_value.isoformat()}
    resp = client.get("/api/v1/dashboard/room-status", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _room(body: dict, room_number: str) -> dict:
    return next(r for r in body["rooms"] if r["room_number"] == room_number)


def _check_in(client, headers, reservation_id: int) -> dict:
    resp = client.post(
        f"/api/v1/reservations/{reservation_id}/check-in", headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["stay"]


def _partition_invariant(body: dict) -> None:
    counts = body["counts"]
    assert (
        counts["available"]
        + counts["reserved"]
        + counts["occupied"]
        + counts["out_of_service"]
        == counts["total_enabled_rooms"]
    )
    assert counts["total_enabled_rooms"] == body["enabled_room_count"]
    assert (
        body["enabled_room_count"] + body["disabled_room_count"]
        == body["total_room_count"]
    )
    enabled_items = [r for r in body["rooms"] if r["is_active"]]
    assert len(enabled_items) == body["enabled_room_count"]


# ---------------------------------------------------------------------------
# 默认与基础
# ---------------------------------------------------------------------------


def test_room_status_defaults_to_business_date(client, admin_headers):
    """不传 date 时默认业务日期（今天）。"""
    body = _status(client, admin_headers)
    assert body["date"] == business_date().isoformat()
    assert body["business_date"] == business_date().isoformat()
    assert body["is_today"] is True
    assert body["physical_status_authoritative"] is True
    assert body["enabled_room_count"] == 28
    assert body["disabled_room_count"] == 0
    assert body["total_room_count"] == 28
    # 种子状态：全部 available + clean
    assert body["counts"]["available"] == 28
    assert body["counts"]["reserved"] == 0
    assert body["counts"]["occupied"] == 0
    assert body["counts"]["out_of_service"] == 0
    assert body["counts"]["sellable_total"] == 28
    _partition_invariant(body)


def test_no_reservation_is_available(client, admin_headers):
    """无预订 = 可售（未来任意日期）。"""
    body = _status(client, admin_headers, _d(30))
    assert _room(body, "101")["status"] == "AVAILABLE"
    assert _room(body, "101")["reservation_id"] is None
    assert _room(body, "101")["arriving"] is False


def test_future_date_physical_status_not_authoritative(client, admin_headers):
    """未来日期：physical_status_authoritative=false，且不返回当前物理/清洁状态。"""
    body = _status(client, admin_headers, _d(1))
    assert body["is_today"] is False
    assert body["is_past"] is False
    assert body["physical_status_authoritative"] is False
    item = _room(body, "101")
    assert item["effective_occupancy_status"] is None
    assert item["current_cleaning_status"] is None


def test_today_returns_current_physical_status(client, admin_headers):
    """业务日期当天返回当前物理占用与清洁状态。"""
    body = _status(client, admin_headers)
    item = _room(body, "101")
    assert item["effective_occupancy_status"] == "available"
    assert item["current_cleaning_status"] == "clean"


def test_past_date_authoritative(client, admin_headers):
    body = _status(client, admin_headers, _d(-3))
    assert body["is_past"] is True
    assert body["is_today"] is False
    assert body["physical_status_authoritative"] is True


# ---------------------------------------------------------------------------
# 未来预订 / 多晚 / 退房边界
# ---------------------------------------------------------------------------


def test_future_reservation_reserved_on_stay_dates(client, admin_headers):
    """未来预订：在 [check_in, check_out) 内为 RESERVED，到店日 arriving=true。"""
    room = find_room(client, admin_headers, "101")
    guest = create_guest(client, admin_headers, phone="13800139601")
    check_in_date = _d(10)
    check_out_date = _d(12)
    reservation = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=check_in_date,
        check_out=check_out_date,
    )

    # 到店日：RESERVED + arriving
    body_in = _status(client, admin_headers, check_in_date)
    item_in = _room(body_in, "101")
    assert item_in["status"] == "RESERVED"
    assert item_in["arriving"] is True
    assert item_in["reservation_id"] == reservation["id"]
    assert item_in["check_in_date"] == check_in_date.isoformat()
    assert item_in["planned_check_out_date"] == check_out_date.isoformat()
    assert body_in["counts"]["reserved"] == 1

    # 中间夜：RESERVED（非到店日 -> arriving false）
    body_mid = _status(client, admin_headers, _d(11))
    item_mid = _room(body_mid, "101")
    assert item_mid["status"] == "RESERVED"
    assert item_mid["arriving"] is False

    # 到店前一天：AVAILABLE
    assert _room(_status(client, admin_headers, _d(9)), "101")["status"] == "AVAILABLE"

    _partition_invariant(body_in)


def test_multi_night_reservation_occupies_every_night(client, admin_headers):
    """多晚预订：区间内每一晚都占用（半开区间）。"""
    room = find_room(client, admin_headers, "102")
    guest = create_guest(client, admin_headers, phone="13800139602")
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=_d(20),
        check_out=_d(24),  # 4 晚：20/21/22/23
    )
    for offset in (20, 21, 22, 23):
        assert (
            _room(_status(client, admin_headers, _d(offset)), "102")["status"]
            == "RESERVED"
        ), f"day +{offset} should be reserved"


def test_checkout_day_is_not_occupied(client, admin_headers):
    """退房日不算整日占用（[check_in, check_out) 半开区间）。"""
    room = find_room(client, admin_headers, "103")
    guest = create_guest(client, admin_headers, phone="13800139603")
    check_in_date = _d(15)
    check_out_date = _d(18)
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=check_in_date,
        check_out=check_out_date,
    )
    assert _room(_status(client, admin_headers, check_in_date), "103")["status"] == "RESERVED"
    assert _room(_status(client, admin_headers, _d(17)), "103")["status"] == "RESERVED"
    # 退房日：可售（其他客人当天可入住）
    checkout_body = _status(client, admin_headers, check_out_date)
    assert _room(checkout_body, "103")["status"] == "AVAILABLE"
    assert _room(checkout_body, "103")["reservation_id"] is None
    # 紧邻区间可售性一致：同日入住不冲突
    next_res = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=check_out_date,
        check_out=_d(20),
    )
    assert next_res["check_in_date"] == check_out_date.isoformat()


# ---------------------------------------------------------------------------
# 在住（Stay）
# ---------------------------------------------------------------------------


def test_occupied_stay_shows_occupied_today(client, admin_headers):
    """在住 Stay：今天 OCCUPIED；到店日 arriving=false（已是事实，不是在预计）。"""
    room = find_room(client, admin_headers, "104")
    guest = create_guest(client, admin_headers, phone="13800139604")
    reservation = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=business_date(),
        check_out=_d(2),
    )
    stay = _check_in(client, admin_headers, reservation["id"])

    body_today = _status(client, admin_headers)
    item = _room(body_today, "104")
    assert item["status"] == "OCCUPIED"
    assert item["arriving"] is False
    assert item["stay_id"] == stay["id"]
    assert item["stay_no"] == stay["stay_no"]
    assert item["effective_occupancy_status"] == "occupied"

    # 次日：仍为 OCCUPIED（住在中，仍占用）
    body_tomorrow = _status(client, admin_headers, _d(1))
    item_tomorrow = _room(body_tomorrow, "104")
    assert item_tomorrow["status"] == "OCCUPIED"
    assert item_tomorrow["effective_occupancy_status"] is None  # 非业务日期

    # 退房日：可售
    assert _room(_status(client, admin_headers, _d(2)), "104")["status"] == "AVAILABLE"
    _partition_invariant(body_today)


def test_cancelled_reservation_not_counted(client, admin_headers):
    """CANCELLED 预订不计入日期占用。"""
    room = find_room(client, admin_headers, "105")
    guest = create_guest(client, admin_headers, phone="13800139605")
    reservation = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=_d(25),
        check_out=_d(27),
    )
    assert _room(_status(client, admin_headers, _d(25)), "105")["status"] == "RESERVED"
    cancel = client.post(
        f"/api/v1/reservations/{reservation['id']}/cancel", headers=admin_headers
    )
    assert cancel.status_code == 200, cancel.text
    assert _room(_status(client, admin_headers, _d(25)), "105")["status"] == "AVAILABLE"


# ---------------------------------------------------------------------------
# physical override
# ---------------------------------------------------------------------------


def test_maintenance_override_not_available(client, admin_headers):
    """维修停用 override：当天无预订也不得标为 AVAILABLE。"""
    room = find_room(client, admin_headers, "106")
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "out_of_service"},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text

    body = _status(client, admin_headers)
    item = _room(body, "106")
    assert item["status"] == "OUT_OF_SERVICE"
    assert item["unavailability_source"] == "MANUAL"
    assert body["counts"]["out_of_service"] == 1
    assert body["counts"]["available"] == 27
    # 维修停用房间不计入可售
    assert body["counts"]["sellable_total"] == 27
    _partition_invariant(body)


def test_blocking_maintenance_order_forces_out_of_service(client, admin_headers):
    """阻断性维修工单（blocks_room=true）当天使房间为 OUT_OF_SERVICE。"""
    from tests.mwo_helpers import create_order

    room = find_room(client, admin_headers, "107")
    create_order(
        client, admin_headers, room_id=room["id"], blocks_room=True, severity="HIGH"
    )
    body = _status(client, admin_headers)
    item = _room(body, "107")
    assert item["status"] == "OUT_OF_SERVICE"
    assert item["unavailability_source"] == "MAINTENANCE"


def test_past_date_uses_stored_physical_state(client, admin_headers):
    """过去日期使用**已落库**的物理状态（不重算今天新产生的维修工单）。

    StayOps 没有 room state 历史时间线，因此过去日期的维修/锁房只能如实反映
    当前库中该房间的 physical 状态；本用例锁定这一已文档化的语义
    （`physical_status_authoritative=true` for past），并明确：
    ——当前阻断性维修工单本身不会被"重新套用"到历史（因为它已经落库为
    `occupancy_status=out_of_service`，属于已存事实，不是重算）。
    """
    from tests.mwo_helpers import create_order

    room = find_room(client, admin_headers, "108")
    before = _status(client, admin_headers, _d(-5))
    assert _room(before, "108")["status"] == "AVAILABLE"

    create_order(
        client, admin_headers, room_id=room["id"], blocks_room=True, severity="HIGH"
    )
    # 工单已把该房置为 out_of_service（落库事实）—— 过去日期如实反映该状态
    after = _status(client, admin_headers, _d(-5))
    assert after["physical_status_authoritative"] is True
    assert _room(after, "108")["status"] == "OUT_OF_SERVICE"
    assert _room(after, "108")["unavailability_source"] == "MAINTENANCE"


def test_past_date_does_not_retroactively_report_occupancy(client, admin_headers):
    """过去日期不被今天的占用事实倒推（半开区间只往前，不往后套用）。"""
    room = find_room(client, admin_headers, "301")
    guest = create_guest(client, admin_headers, phone="13800139608")
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=business_date(),
        check_out=_d(2),
    )
    # 今天：RESERVED（到店日）
    assert _room(_status(client, admin_headers), "301")["status"] == "RESERVED"
    # 昨天：无既存占用事实 -> 可售
    yesterday = _status(client, admin_headers, _d(-1))
    assert yesterday["is_past"] is True
    assert _room(yesterday, "301")["status"] == "AVAILABLE"


def test_temporary_block_does_not_block_future_date(client, admin_headers):
    """人工临时锁房只影响今天，不冒充未来房态（未来无预订则 AVAILABLE）。"""
    room = find_room(client, admin_headers, "109")
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "blocked"},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    assert _room(_status(client, admin_headers), "109")["status"] == "OUT_OF_SERVICE"
    assert _room(_status(client, admin_headers, _d(5)), "109")["status"] == "AVAILABLE"


def test_long_term_out_of_service_applies_to_future(client, admin_headers):
    """明确的人工长期停用（out_of_service）对未来日期同样生效。"""
    room = find_room(client, admin_headers, "110")
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "out_of_service"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    future = _status(client, admin_headers, _d(7))
    assert _room(future, "110")["status"] == "OUT_OF_SERVICE"


def test_maintenance_override_beats_reservation(client, admin_headers):
    """物理 override 优先于日期占用（维修中的房间即便有预订也不算可售）。"""
    room = find_room(client, admin_headers, "201")
    guest = create_guest(client, admin_headers, phone="13800139606")
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=business_date(),
        check_out=_d(3),
    )
    # 今天有 CONFIRMED 预订 -> RESERVED
    assert _room(_status(client, admin_headers), "201")["status"] == "RESERVED"
    # 置为停用（模拟维修/长期停用）after 已被预订 -> 物理 override 优先
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "out_of_service"},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    body = _status(client, admin_headers)
    assert _room(body, "201")["status"] == "OUT_OF_SERVICE"


# ---------------------------------------------------------------------------
# 停用房间
# ---------------------------------------------------------------------------


def test_disabled_room_excluded_from_partition(client, admin_headers):
    """停用房间不进入占用分区，也不计入启用分母。"""
    room = find_room(client, admin_headers, "202")
    enable_before = _status(client, admin_headers)
    assert enable_before["enabled_room_count"] == 28

    resp = client.post(
        f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers
    )
    assert resp.status_code == 200, resp.text

    body = _status(client, admin_headers)
    assert body["enabled_room_count"] == 27
    assert body["disabled_room_count"] == 1
    assert body["total_room_count"] == 28
    # 分区之和 = 启用数（停用房不在任何分区内）
    assert (
        body["counts"]["available"]
        + body["counts"]["reserved"]
        + body["counts"]["occupied"]
        + body["counts"]["out_of_service"]
        == 27
    )
    item = _room(body, "202")
    assert item["is_active"] is False
    _partition_invariant(body)

    # 恢复启用
    client.post(f"/api/v1/rooms/{room['id']}/enable", headers=admin_headers)
    assert _status(client, admin_headers)["enabled_room_count"] == 28


def test_disabled_reserved_room_counted_as_out_of_service_not_reserved(
    client, admin_headers
):
    """停用房即便有历史预订，也不计入 RESERVED 分区（不虚增可售/占用口径）。"""
    room = find_room(client, admin_headers, "203")
    guest = create_guest(client, admin_headers, phone="13800139607")
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=_d(12),
        check_out=_d(14),
    )
    assert _room(_status(client, admin_headers, _d(12)), "203")["status"] == "RESERVED"
    client.post(f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers)
    body = _status(client, admin_headers, _d(12))
    assert _room(body, "203")["is_active"] is False
    assert body["counts"]["reserved"] == 0


# ---------------------------------------------------------------------------
# 与可售性引擎对拍（不得出现两套互相矛盾的房态语义）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("offset", [0, 1, 3, 10])
def test_consistent_with_availability_engine(client, admin_headers, offset):
    """dashboard 某日房态与 GET /availability 的可用性判定互不矛盾。"""
    target = _d(offset)
    body = _status(client, admin_headers, target)
    avail = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": target.isoformat(),
            "check_out_date": (target + timedelta(days=1)).isoformat(),
        },
        headers=admin_headers,
    ).json()
    avail_map = {i["room_number"]: i for i in avail["items"]}

    for item in body["rooms"]:
        engine = avail_map[item["room_number"]]
        if item["status"] == "AVAILABLE":
            assert engine["available"] is True, (
                f"{item['room_number']} dashboard=AVAILABLE 但 availability 拒绝："
                f"{engine['reason']}"
            )
        elif item["status"] in ("RESERVED", "OCCUPIED"):
            # 一日的占用必然让「该日区间」不可售
            assert engine["available"] is False, item["room_number"]
        else:  # OUT_OF_SERVICE
            assert engine["available"] is False, item["room_number"]


# ---------------------------------------------------------------------------
# 参数校验 / RBAC
# ---------------------------------------------------------------------------


def test_date_too_far_in_past_422(client, admin_headers):
    resp = client.get(
        "/api/v1/dashboard/room-status",
        params={"date": _d(-40).isoformat()},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_date_too_far_in_future_422(client, admin_headers):
    resp = client.get(
        "/api/v1/dashboard/room-status",
        params={"date": _d(400).isoformat()},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_invalid_date_format_422(client, admin_headers):
    resp = client.get(
        "/api/v1/dashboard/room-status",
        params={"date": "2026-13-45"},
        headers=admin_headers,
    )
    assert resp.status_code == 422


@pytest.mark.parametrize(
    "role,allowed",
    [
        ("MANAGER", True),
        ("FRONT_DESK", True),
        ("HOUSEKEEPING", True),
        ("MAINTENANCE", True),
        ("FINANCE", True),
    ],
)
def test_room_status_requires_room_read(client, make_user, token_for, role, allowed):
    """房态概览需要 room:read（全部角色均有；无权限角色 403）。"""
    username = f"a96_dash_{role.lower()}"
    make_user(username, role_names=[role])
    headers = {"Authorization": f"Bearer {token_for(username)}"}
    resp = client.get("/api/v1/dashboard/room-status", headers=headers)
    assert resp.status_code == (200 if allowed else 403)
