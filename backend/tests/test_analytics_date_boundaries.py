# -*- coding: utf-8 -*-
"""S8 日期边界测试（§56）：半开区间 + Business Date + 时区转换。

- [8/28, 8/29) → 恰 1 实际房晚；[8/28, 8/30) → 2。
- 月/年边界跨越：日期算术为纯日历日交集，任何边界一致。
- ACTIVE Stay：实际历史 [check_in_bd, current_business_date)，
  不被 planned_checkout 截断；超期 ACTIVE 同理。
"""

from datetime import date, timedelta

from tests.analytics_helpers import build_stay, d, get_analytics, iso
from tests.booking_helpers import find_room


def test_one_night_midnight_boundary(client, db, admin_headers):
    """8/28 23:30（+08）入住、8/29 00:30（+08）退房 → 恰 1 实际房晚。

    同一绝对时刻在 UTC 是 8/28 15:30 / 8/28 16:30 —— 必须按 Asia/Shanghai
    Business Date 归属（§2.4/§56 timezone conversion）。
    """
    room101 = find_room(client, admin_headers, "101")
    build_stay(client, db, admin_headers, room101, ci=(-1, 23, 30), co=(0, 0, 30),
               amount="200.00")
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-1)), "to": iso(d(0))},
    )
    assert data["metrics"]["actual_occupied_room_nights"] == 1
    # 更宽窗口仍只含这一晚
    data2 = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-3)), "to": iso(d(0))},
    )
    assert data2["metrics"]["actual_occupied_room_nights"] == 1


def test_two_nights_half_open(client, db, admin_headers):
    """8/28 14:00 入住、8/30 10:00 退房 → 2 实际房晚（退房日不计）。"""
    room102 = find_room(client, admin_headers, "102")
    build_stay(client, db, admin_headers, room102, ci=(-2, 14), co=(0, 10),
               amount="400.00")
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-2)), "to": iso(d(0))},
    )
    assert data["metrics"]["actual_occupied_room_nights"] == 2
    # 区间交集：只取第 2 晚
    data2 = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-1)), "to": iso(d(0))},
    )
    assert data2["metrics"]["actual_occupied_room_nights"] == 1


def test_month_year_boundary_crossing(client, db, admin_headers):
    """跨月/跨年边界的实际房晚：半开区间交集在任何边界一致（§56）。"""
    today = d(0)
    if today.month == 1:
        boundary = date(today.year, 1, 1)  # 年度边界（1 月 1 日）
    else:
        boundary = (today.replace(day=1) - timedelta(days=1)).replace(day=1)
    ci_date = boundary - timedelta(days=2)
    co_date = boundary + timedelta(days=2)
    ci_offset = (ci_date - today).days
    co_offset = (co_date - today).days
    assert co_date < today, "边界测试的 Stay 必须完全落在过去（Actual 不含未来）"

    room103 = find_room(client, admin_headers, "103")
    build_stay(client, db, admin_headers, room103, ci=(ci_offset, 14),
               co=(co_offset, 10), amount="600.00")
    period_from = boundary - timedelta(days=1)
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(period_from), "to": iso(today)},
    )
    # 交集 [period_from, today) ∩ [ci_date, co_date)
    expected = (min(today, co_date) - max(period_from, ci_date)).days
    assert expected > 0, "测试构造必须与报告区间相交"
    assert data["metrics"]["actual_occupied_room_nights"] == expected


def test_active_stay_not_truncated_by_planned_checkout(client, db, admin_headers):
    """ACTIVE Stay：实际历史 [check_in_bd, D0)，不被 planned_checkout 截断（§4/§6）。"""
    room104 = find_room(client, admin_headers, "104")
    build_stay(client, db, admin_headers, room104, ci=(-2, 13), co=(5, 10),
               amount="500.00", checkout=False, planned_co_days=5)
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-2)), "to": iso(d(0))},
    )
    # planned 是未来 d5，但 Actual 只统计到 D0 之前 → 2 晚
    assert data["metrics"]["actual_occupied_room_nights"] == 2


def test_overdue_active_stay_actual_history_intact(client, db, admin_headers):
    """超期 ACTIVE Stay：实际历史 [check_in_bd, D0) 完整（3 晚），
    不被 planned d(-1) 截断；同时不提前把今晚当成已完成房晚。"""
    room105 = find_room(client, admin_headers, "105")
    build_stay(client, db, admin_headers, room105, ci=(-3, 15), co=(5, 10),
               amount="400.00", checkout=False, planned_co_days=-1)
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-3)), "to": iso(d(0))},
    )
    # [d-3, D0) = 3 晚（d-3、d-2、d-1）；若用 planned d(-1) 截断 → 只有 2 晚
    assert data["metrics"]["actual_occupied_room_nights"] == 3
    assert data["snapshot"]["overdue_active_stays"] == 1
