# -*- coding: utf-8 -*-
"""alpha.9.6 F4 客源渠道经营分析测试。

覆盖任务书 §12 的 Analytics 要求：
- channel order count（含 Arrival Cohort 边界）
- channel revenue（合同房费口径，与既有经营分析同事实源）
- cancelled order exclusion（CANCELLED / NO_SHOW 不计订单，不计房费）
- no double count（同一订单只归因一次；Room Move 不重复计房晚）
- custom channel（自建渠道独立成行）
- 对账不变式：Σ channels + unassigned == totals
- 与既有 /business/rooms 的 contracted_room_value 精确对账
- 空数据：count -> 0、金额 -> 0、占比/ADR 分母 0 -> null（禁止 NaN）
- 权限（analytics:business_read）+ 参数校验
"""

import uuid
from datetime import timedelta

import pytest

from app.core.business_date import business_date
from app.models import Reservation, ReservationStatus, Stay, StayStatus
from app.models.reservation import ReservationSource
from tests.booking_helpers import create_guest

_room_seq = 0


def _d(days: int):
    return business_date() + timedelta(days=days)


def _fresh_room(client, headers) -> dict:
    global _room_seq
    _room_seq += 1
    room_type_id = next(
        r["id"]
        for r in client.get(
            "/api/v1/room-types", params={"page_size": 100}, headers=headers
        ).json()["items"]
        if r["name"] == "标准大床房"
    )
    number = f"9A{uuid.uuid4().hex[:3].upper()}{_room_seq}"
    resp = client.post(
        "/api/v1/rooms",
        json={"room_number": number, "room_type_id": room_type_id, "floor": 9},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _channel_id(client, headers, name: str) -> int:
    for item in client.get(
        "/api/v1/channels", params={"page_size": 100}, headers=headers
    ).json()["items"]:
        if item["name"] == name:
            return item["id"]
    raise AssertionError(f"渠道 {name} 不存在")


def _make_custom_channel(client, headers, name: str, category="OFFLINE") -> dict:
    resp = client.post(
        "/api/v1/channels",
        json={"name": name, "category": category},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _at(day, hour: int):
    """构造带 Asia/Shanghai 偏移的 datetime（列类型为 timestamptz）。"""
    from datetime import datetime, timedelta as _td, timezone

    tz = timezone(_td(hours=8), name="Asia/Shanghai")
    return datetime(day.year, day.month, day.day, hour, 0, 0, tzinfo=tz)


def _book(client, headers, room, guest_id, *, channel_id, amount):
    """下单（真实 API）。

    预订区间固定为 [今天, 明天)：这是 check-in 唯一可办理的窗口
    （check-in 要求 业务日期 ∈ [check_in, check_out)）。需要历史区间的用例
    由 `_stay_done` 通过 ORM 回填时间戳（仓库既有 backdate 做法）。
    """
    payload = {
        "guest_id": guest_id,
        "room_id": room["id"],
        "room_type_id": room["room_type_id"],
        "check_in_date": _d(0).isoformat(),
        "check_out_date": _d(1).isoformat(),
        "agreed_total_amount": amount,
    }
    if channel_id is not None:
        payload["source_channel_id"] = channel_id
    resp = client.post("/api/v1/reservations", json=payload, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _backdate_reservation(db, reservation_id: int, check_in) -> None:
    """把预订的入住日回填到历史日期（使其进入目标 Arrival Cohort）。"""
    reservation = db.get(Reservation, reservation_id)
    reservation.check_in_date = check_in
    # 必须 commit：测试会话与外层 savepoint 隔离，API 请求使用另一会话，
    # 不提交则 API 读不到回填结果（用例最外层事务仍会整体回滚）
    db.commit()


def _check_in_backdated(client, headers, db, reservation_id, check_in, check_out):
    """办理入住并把住宿时间戳回填到 [check_in, check_out)，返回 stay_id。

    check-in 只能在业务日期落在预订区间内时办理，所以真实顺序必须是：
    1) 以 [今天, 明天) 下单
    2) 办理 check-in（真实 API + 状态机）
    3) ORM 回填时间戳到目标历史区间
    4) 缩小 Reservation 的计划区间，避免与后续同房预订的排他约束冲突
    """
    resp = client.post(
        f"/api/v1/reservations/{reservation_id}/check-in", headers=headers
    )
    assert resp.status_code == 200, resp.text
    stay_id = resp.json()["stay"]["id"]

    stay = db.get(Stay, stay_id)
    stay.planned_check_out_date = check_out
    stay.actual_check_in_at = _at(check_in, 14)
    reservation = db.get(Reservation, reservation_id)
    reservation.check_out_date = check_out
    if reservation.check_in_date > check_in:
        reservation.check_in_date = check_in
    db.commit()
    return stay_id


def _stay_done(client, headers, db, reservation_id, check_in, check_out) -> None:
    """把预订做成「已完成的真实住宿」，时间戳落在 [check_in, check_out)。

    全链路走真实 API（check-in / check-out 事务与状态机），仅时间戳按仓库既有
    backdate 做法回填（e2e/setup_backdate_stay.py 同思路）。
    """
    assert check_in < check_out
    stay_id = _check_in_backdated(
        client, headers, db, reservation_id, check_in, check_out
    )
    out = client.post(f"/api/v1/stays/{stay_id}/check-out", headers=headers)
    assert out.status_code == 200, out.text
    stay = db.get(Stay, stay_id)
    stay.actual_check_out_at = _at(check_out, 11)
    db.commit()
    assert stay.status == StayStatus.CHECKED_OUT
    assert db.get(Reservation, reservation_id).status == ReservationStatus.COMPLETED


def _channels_analytics(client, headers, from_date, to_date) -> dict:
    resp = client.get(
        "/api/v1/analytics/business/channels",
        params={"from": from_date.isoformat(), "to": to_date.isoformat()},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _row(body: dict, name: str) -> dict:
    for row in body["channels"]:
        if row["channel_name"] == name:
            return row
    raise AssertionError(f"渠道 {name} 不在结果中")


def _assert_reconciles(body: dict) -> None:
    totals = body["totals"]
    assert (
        sum(r["order_count"] for r in body["channels"])
        + body["unassigned"]["order_count"]
        == totals["order_count"]
    )
    assert (
        sum(r["occupied_room_nights"] for r in body["channels"])
        + body["unassigned"]["occupied_room_nights"]
        == totals["occupied_room_nights"]
    )
    from decimal import Decimal

    assert (
        sum(
            (Decimal(r["contracted_room_value"]) for r in body["channels"]),
            Decimal("0"),
        )
        + Decimal(body["unassigned"]["contracted_room_value"])
        == Decimal(totals["contracted_room_value"])
    )


# ---------------------------------------------------------------------------
# 订单数与房费归因
# ---------------------------------------------------------------------------


def test_channel_order_count_and_revenue(client, admin_headers, db):
    """单渠道已完成住宿：订单数 1、房晚 2、合同房费 400.00、占比 100%。"""
    from decimal import Decimal

    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139901")
    check_in = _d(-5)
    check_out = _d(-3)  # 2 晚
    reservation = _book(
        client,
        admin_headers,
        room,
        guest["id"],
        channel_id=meituan,
                amount="400.00",
    )
    _stay_done(client, admin_headers, db, reservation["id"], check_in, check_out)

    body = _channels_analytics(client, admin_headers, _d(-10), business_date())
    row = _row(body, "美团")
    assert row["order_count"] == 1
    assert row["occupied_room_nights"] == 2
    assert Decimal(row["contracted_room_value"]) == Decimal("400.00")
    # 合同 ADR = 400 / 2
    assert Decimal(row["contracted_adr"]) == Decimal("200.00")
    assert row["share"] == 1.0
    assert body["totals"]["order_count"] == 1
    assert Decimal(body["totals"]["contracted_room_value"]) == Decimal("400.00")
    _assert_reconciles(body)


def test_channel_attribution_splits_by_channel(client, admin_headers, db):
    """多渠道：各自独立成行，占比按合同房费拆分。"""
    from decimal import Decimal

    meituan = _channel_id(client, admin_headers, "美团")
    ctrip = _channel_id(client, admin_headers, "携程")

    room_a = _fresh_room(client, admin_headers)
    guest_a = create_guest(client, admin_headers, phone="13800139902")
    res_a = _book(
        client, admin_headers, room_a, guest_a["id"],
        channel_id=meituan, amount="400.00",
    )
    _stay_done(client, admin_headers, db, res_a["id"], _d(-8), _d(-6))

    room_b = _fresh_room(client, admin_headers)
    guest_b = create_guest(client, admin_headers, phone="13800139903")
    res_b = _book(
        client, admin_headers, room_b, guest_b["id"],
        channel_id=ctrip, amount="900.00",
    )
    _stay_done(client, admin_headers, db, res_b["id"], _d(-8), _d(-5))

    body = _channels_analytics(client, admin_headers, _d(-12), business_date())
    meituan_row = _row(body, "美团")
    ctrip_row = _row(body, "携程")
    assert Decimal(meituan_row["contracted_room_value"]) == Decimal("400.00")
    assert Decimal(ctrip_row["contracted_room_value"]) == Decimal("900.00")
    assert meituan_row["order_count"] == 1
    assert ctrip_row["order_count"] == 1
    # 占比：400/1300≈0.3077，900/1300≈0.6923；和为 1
    assert meituan_row["share"] == pytest.approx(400 / 1300, abs=1e-4)
    assert ctrip_row["share"] == pytest.approx(900 / 1300, abs=1e-4)
    assert Decimal(body["totals"]["contracted_room_value"]) == Decimal("1300.00")
    _assert_reconciles(body)


def test_channel_reconciles_with_business_rooms_total(client, admin_headers, db):
    """与既有 /analytics/business/rooms 的合同房费总额精确对账（同一事实源）。"""
    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139904")
    reservation = _book(
        client, admin_headers, room, guest["id"],
        channel_id=meituan, amount="900.00",
    )
    _stay_done(client, admin_headers, db, reservation["id"], _d(-20), _d(-17))

    params = {"from": _d(-25).isoformat(), "to": business_date().isoformat()}
    channels = _channels_analytics(client, admin_headers, _d(-25), business_date())
    rooms = client.get(
        "/api/v1/analytics/business/rooms", params=params, headers=admin_headers
    ).json()
    from decimal import Decimal

    assert Decimal(channels["totals"]["contracted_room_value"]) == Decimal(
        rooms["contracted_room_value"]
    )
    assert (
        channels["totals"]["occupied_room_nights"]
        == rooms["priced_occupied_room_nights"]
    )


# ---------------------------------------------------------------------------
# 取消 / 未到店排除
# ---------------------------------------------------------------------------


def test_cancelled_order_excluded(client, admin_headers, db):
    """CANCELLED 预订不计订单数、不计房费。"""
    from decimal import Decimal

    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139905")
    reservation = _book(
        client, admin_headers, room, guest["id"],
        channel_id=meituan, amount="400.00",
    )
    assert (
        client.post(
            f"/api/v1/reservations/{reservation['id']}/cancel",
            headers=admin_headers,
        ).status_code
        == 200
    )
    # 把它放入 [-1, 0) 的 Arrival Cohort，验证被排除
    _backdate_reservation(db, reservation["id"], _d(-1))
    body = _channels_analytics(client, admin_headers, _d(-1), business_date())
    row = _row(body, "美团")
    assert row["order_count"] == 0
    assert Decimal(row["contracted_room_value"]) == Decimal("0.00")
    assert row["occupied_room_nights"] == 0


def test_no_show_order_excluded(client, admin_headers, db):
    """NO_SHOW 预订不计订单数（与 bookings 分析 non_cancelled 口径一致）。"""
    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139906")
    reservation = _book(
        client, admin_headers, room, guest["id"],
        channel_id=meituan, amount="400.00",
    )
    resp = client.post(
        f"/api/v1/reservations/{reservation['id']}/no-show", headers=admin_headers
    )
    assert resp.status_code == 200, resp.text

    _backdate_reservation(db, reservation["id"], _d(-1))
    body = _channels_analytics(client, admin_headers, _d(-1), business_date())
    assert _row(body, "美团")["order_count"] == 0
    assert body["totals"]["order_count"] == 0


def test_confirmed_but_not_stayed_counts_order_not_revenue(
    client, admin_headers, db
):
    """CONFIRMED 预订（已过到店日但未办理入住）：计订单数，不产生房晚 / 合同房费。

    Arrival Cohort 取 [-1, 0)：该 CONFIRMED 预订的 check_in 落在区间内；
    但因为还没有真实 Stay，因此不贡献房晚与合同房费。
    """
    from decimal import Decimal

    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139907")
    reservation = _book(
        client, admin_headers, room, guest["id"],
        channel_id=meituan, amount="400.00",
    )
    _backdate_reservation(db, reservation["id"], _d(-1))
    body = _channels_analytics(client, admin_headers, _d(-1), business_date())
    row = _row(body, "美团")
    assert row["order_count"] == 1
    assert row["occupied_room_nights"] == 0
    assert Decimal(row["contracted_room_value"]) == Decimal("0.00")
    assert row["contracted_adr"] is None  # 分母 0 -> null


# ---------------------------------------------------------------------------
# 防重复计数
# ---------------------------------------------------------------------------


def test_no_double_count_on_room_move(client, admin_headers, db):
    """Room Move 不重复计房晚：房晚按 Stay 派生，归因按 Stay -> Reservation。"""
    from app.models import StayRoomAssignment

    meituan = _channel_id(client, admin_headers, "美团")
    room_a = _fresh_room(client, admin_headers)
    room_b = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139908")
    reservation = _book(
        client, admin_headers, room_a, guest["id"],
        channel_id=meituan, amount="800.00",
    )
    # 历史区间：[_d(-6), _d(-3)) = 3 晚
    check_in, check_out = _d(-6), _d(-3)
    _backdate_reservation(db, reservation["id"], check_in)

    resp = client.post(
        f"/api/v1/reservations/{reservation['id']}/check-in", headers=admin_headers
    )
    assert resp.status_code == 200, resp.text
    stay_id = resp.json()["stay"]["id"]
    stay = db.get(Stay, stay_id)
    stay.planned_check_out_date = check_out
    stay.actual_check_in_at = _at(check_in, 14)
    # 计划区间也必须收窄到历史区间，否则合同房费会按「今天→明天」分摊
    db.get(Reservation, reservation["id"]).check_out_date = check_out
    first_assignment = db.query(StayRoomAssignment).filter_by(stay_id=stay_id).one()
    first_assignment.started_at = _at(check_in, 14)
    db.commit()

    # 换房（产生第二条 assignment）—— 不得让房晚翻倍
    move = client.post(
        f"/api/v1/stays/{stay_id}/room-move",
        json={"target_room_id": room_b["id"], "reason": "GUEST_REQUEST"},
        headers=admin_headers,
    )
    assert move.status_code == 200, move.text
    out = client.post(f"/api/v1/stays/{stay_id}/check-out", headers=admin_headers)
    assert out.status_code == 200, out.text
    stay = db.get(Stay, stay_id)
    stay.actual_check_out_at = _at(check_out, 11)
    db.commit()
    db.refresh(stay)
    assert len(stay.assignments) == 2  # 换房确实产生了第二条分配

    body = _channels_analytics(client, admin_headers, _d(-10), business_date())
    row = _row(body, "美团")
    from decimal import Decimal

    # 区间 [_d(-6), _d(-3)) = 3 晚；若按 assignment 计算会变成 6 晚
    assert row["order_count"] == 1
    # 合同房费全额（全部房晚都落在计划区间内）
    assert Decimal(row["contracted_room_value"]) == Decimal("800.00")
    assert row["stay_count"] == 1


def test_one_order_counted_once(client, admin_headers, db):
    """同一订单只归因一次（COUNT(DISTINCT stay) 语义）。"""
    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139909")
    reservation = _book(
        client, admin_headers, room, guest["id"],
        channel_id=meituan, amount="600.00",
    )
    _stay_done(client, admin_headers, db, reservation["id"], _d(-6), _d(-3))
    body = _channels_analytics(client, admin_headers, _d(-8), business_date())
    row = _row(body, "美团")
    assert row["order_count"] == 1
    assert row["stay_count"] == 1
    assert row["occupied_room_nights"] == 3


# ---------------------------------------------------------------------------
# 自定义渠道 / 未指定渠道
# ---------------------------------------------------------------------------


def test_custom_channel_tracked_separately(client, admin_headers, db):
    """自建渠道（电话）在经营分析中独立成行（现场需求 4 的目标）。"""
    from decimal import Decimal

    phone = _make_custom_channel(
        client, admin_headers, f"电话-经营分析-{uuid.uuid4().hex[:6]}"
    )
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139910")
    reservation = _book(
        client, admin_headers, room, guest["id"],
        channel_id=phone["id"], amount="500.00",
    )
    _stay_done(client, admin_headers, db, reservation["id"], _d(-5), _d(-2))

    body = _channels_analytics(client, admin_headers, _d(-9), business_date())
    row = _row(body, phone["name"])
    assert row["channel_id"] == phone["id"]
    assert row["channel_category"] == "OFFLINE"
    assert row["is_system"] is False
    assert row["order_count"] == 1
    # [09-11, 09-14) = 3 晚；合同房费全额 500.00；合同 ADR = 500/3
    assert row["occupied_room_nights"] == 3
    assert Decimal(row["contracted_room_value"]) == Decimal("500.00")
    assert Decimal(row["contracted_adr"]) == (Decimal("500.00") / 3).quantize(
        Decimal("0.01")
    )


def test_unassigned_bucket_present_and_reconciles(client, admin_headers, db):
    """未指定渠道桶存在且参与对账（Σ channels + unassigned == totals）。"""
    from decimal import Decimal

    unassigned_channel_room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139911")
    reservation = _book(
        client, admin_headers, unassigned_channel_room, guest["id"],
        channel_id=None, amount="300.00",
    )
    # channel_id=None -> 走 request body 里显式 None：_book 会写 null
    assert reservation.get("source_channel_id") is None
    _stay_done(client, admin_headers, db, reservation["id"], _d(-8), _d(-5))

    body = _channels_analytics(client, admin_headers, _d(-8), business_date())
    unassigned = body["unassigned"]
    assert unassigned["channel_id"] is None
    assert unassigned["channel_name"] == "未指定渠道"
    assert unassigned["order_count"] == 1
    assert Decimal(unassigned["contracted_room_value"]) == Decimal("300.00")
    assert Decimal(body["totals"]["contracted_room_value"]) == Decimal("300.00")
    _assert_reconciles(body)


def test_enabled_channel_without_business_returned_as_zero(client, admin_headers):
    """启用但区间内无业务的渠道返回 count=0 / value=0 / share=None（全覆盖清单）。"""
    from decimal import Decimal

    body = _channels_analytics(client, admin_headers, _d(-400), _d(-399))
    assert body["totals"]["order_count"] == 0
    assert Decimal(body["totals"]["contracted_room_value"]) == Decimal("0.00")
    # 分母 0 -> null（禁止 NaN / Infinity）
    assert body["totals"]["contracted_adr"] is None
    assert len(body["channels"]) >= 10
    for row in body["channels"]:
        assert row["order_count"] == 0
        assert Decimal(row["contracted_room_value"]) == Decimal("0.00")
        assert row["contracted_adr"] is None
        assert row["share"] is None
    assert body["unassigned"]["share"] is None


def test_disabled_channel_still_reported_with_history(client, admin_headers, db):
    """渠道停用后其历史业绩仍出现在经营分析中（并标记 enabled=false）。"""
    from decimal import Decimal

    name = f"停用渠道分析-{uuid.uuid4().hex[:6]}"
    channel = _make_custom_channel(client, admin_headers, name)
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139912")
    reservation = _book(
        client, admin_headers, room, guest["id"],
        channel_id=channel["id"], amount="420.00",
    )
    _stay_done(client, admin_headers, db, reservation["id"], _d(-7), _d(-5))
    client.post(
        f"/api/v1/channels/{channel['id']}/disable", headers=admin_headers
    )

    body = _channels_analytics(client, admin_headers, _d(-10), business_date())
    row = _row(body, name)
    assert row["channel_enabled"] is False
    assert row["order_count"] == 1
    assert Decimal(row["contracted_room_value"]) == Decimal("420.00")


# ---------------------------------------------------------------------------
# 权限 / 参数校验
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "role,allowed",
    [
        ("MANAGER", True),
        ("FINANCE", True),
        ("FRONT_DESK", False),
        ("HOUSEKEEPING", False),
        ("MAINTENANCE", False),
    ],
)
def test_channel_analytics_rbac(client, make_user, token_for, role, allowed):
    """渠道经营分析属 analytics:business_read 域（不硬编码角色名）。"""
    username = f"a96_chan_{role.lower()}"
    make_user(username, role_names=[role])
    headers = {"Authorization": f"Bearer {token_for(username)}"}
    resp = client.get(
        "/api/v1/analytics/business/channels",
        params={"from": _d(-7).isoformat(), "to": business_date().isoformat()},
        headers=headers,
    )
    assert resp.status_code == (200 if allowed else 403)


def test_channel_analytics_period_validation(client, admin_headers):
    base = {"from": _d(-7).isoformat(), "to": business_date().isoformat()}
    # from >= to -> 422
    assert (
        client.get(
            "/api/v1/analytics/business/channels",
            params={"from": base["to"], "to": base["to"]},
            headers=admin_headers,
        ).status_code
        == 422
    )
    # to 超过业务日期 -> 422（不允许未来实际数据）
    assert (
        client.get(
            "/api/v1/analytics/business/channels",
            params={"from": base["from"], "to": _d(1).isoformat()},
            headers=admin_headers,
        ).status_code
        == 422
    )
    # 跨度 > 366 天 -> 422
    assert (
        client.get(
            "/api/v1/analytics/business/channels",
            params={"from": _d(-400).isoformat(), "to": business_date().isoformat()},
            headers=admin_headers,
        ).status_code
        == 422
    )


def test_channel_analytics_has_no_pii(client, admin_headers):
    """响应不含任何 Guest PII（payload 扫描）。"""
    body = _channels_analytics(client, admin_headers, _d(-7), business_date())
    text = str(body)
    for forbidden in ("phone", "email", "guest_name", "身份证", "1380013"):
        assert forbidden not in text
