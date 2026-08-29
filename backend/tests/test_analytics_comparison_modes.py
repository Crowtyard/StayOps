# -*- coding: utf-8 -*-
"""S8 QA D1：Calendar Preset Comparison semantics（比较语义模式）。

正式三种 Comparison Mode（D1.1 LOCKED）：
- equal_length：Last 7/30/90 Days、Custom —— previous = [from - days, from)
- previous_calendar_month：Last Month —— previous = [上月初, 本月初)
  （两月天数无需相同）
- previous_month_elapsed：This Month —— previous = [上月初, 上月初 + elapsed)
  clamp 于上一自然月月末（D1.2：禁止跨出上一自然月凑等长）

previous_period() 为纯日期函数：本文件用固定日期做确定性断言（不依赖
业务日期）；API 层验证参数校验与模式接线。
"""

from datetime import date, timedelta

import pytest

from app.services.analytics import (
    COMPARISON_MODE_EQUAL_LENGTH,
    COMPARISON_MODE_PREVIOUS_CALENDAR_MONTH,
    COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED,
    previous_period,
)

from tests.analytics_helpers import d, get_analytics, iso


def test_equal_length_7_days():
    """Last 7 Days：previous = [from-7, from)。"""
    assert previous_period(date(2026, 8, 20), date(2026, 8, 27), COMPARISON_MODE_EQUAL_LENGTH) == (
        date(2026, 8, 13), date(2026, 8, 20),
    )


def test_equal_length_30_days():
    assert previous_period(date(2026, 7, 30), date(2026, 8, 29), COMPARISON_MODE_EQUAL_LENGTH) == (
        date(2026, 6, 30), date(2026, 7, 30),
    )


def test_equal_length_custom():
    assert previous_period(date(2026, 8, 1), date(2026, 8, 31), COMPARISON_MODE_EQUAL_LENGTH) == (
        date(2026, 7, 2), date(2026, 8, 1),
    )


def test_this_month_previous_month_elapsed():
    """This Month：current [8/1, 8/20) -> previous [7/1, 7/20)（elapsed = 19）。"""
    assert previous_period(date(2026, 8, 1), date(2026, 8, 20), COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED) == (
        date(2026, 7, 1), date(2026, 7, 20),
    )


def test_last_month_previous_calendar_month():
    """Last Month：current [7/1, 8/1) -> previous [6/1, 7/1)（两月天数无需相同）。"""
    assert previous_period(date(2026, 7, 1), date(2026, 8, 1), COMPARISON_MODE_PREVIOUS_CALENDAR_MONTH) == (
        date(2026, 6, 1), date(2026, 7, 1),
    )


def test_march_mtd_clamps_at_february_end():
    """3 月 MTD 29 日 vs 2 月 28 天：clamp 于 2 月末 [2/1, 3/1)，禁止跨月凑等长。"""
    assert previous_period(date(2026, 3, 1), date(2026, 3, 30), COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED) == (
        date(2026, 2, 1), date(2026, 3, 1),
    )


def test_leap_february_mtd():
    """闰年 2 月（29 天）：3 月 MTD 28 日 -> [2/1, 2/29)（等长、无 clamp）；
    3 月 MTD 29 日 -> [2/1, 3/1)（clamp 于 2 月末）。"""
    assert previous_period(date(2028, 3, 1), date(2028, 3, 29), COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED) == (
        date(2028, 2, 1), date(2028, 2, 29),
    )
    assert previous_period(date(2028, 3, 1), date(2028, 3, 30), COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED) == (
        date(2028, 2, 1), date(2028, 3, 1),
    )


def test_30_day_month_mtd():
    """4 月（30 天）MTD 29 日 vs 3 月 31 天：等长 [3/1, 3/30)，无需 clamp。"""
    assert previous_period(date(2026, 4, 1), date(2026, 4, 30), COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED) == (
        date(2026, 3, 1), date(2026, 3, 30),
    )


def test_31_day_month_mtd():
    """5 月（31 天）MTD 19 日 -> [4/1, 4/20)。"""
    assert previous_period(date(2026, 5, 1), date(2026, 5, 20), COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED) == (
        date(2026, 4, 1), date(2026, 4, 20),
    )


def test_january_versus_december_year_boundary():
    """1 月 MTD vs 去年 12 月（跨年）：[12/1, 12/20)。"""
    assert previous_period(date(2026, 1, 1), date(2026, 1, 20), COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED) == (
        date(2025, 12, 1), date(2025, 12, 20),
    )


def test_january_last_month_previous_calendar_month():
    """1 月 Last Month（跨年）：[12/1, 1/1)。"""
    assert previous_period(date(2026, 1, 1), date(2026, 2, 1), COMPARISON_MODE_PREVIOUS_CALENDAR_MONTH) == (
        date(2025, 12, 1), date(2026, 1, 1),
    )


def test_this_month_first_day_empty_elapsed():
    """本月第 1 天（elapsed=0）：previous 为空区间 [上月初, 上月初)，语义合法。"""
    assert previous_period(date(2026, 8, 1), date(2026, 8, 1), COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED) == (
        date(2026, 7, 1), date(2026, 7, 1),
    )


def test_unknown_mode_raises():
    with pytest.raises(ValueError):
        previous_period(date(2026, 8, 1), date(2026, 8, 20), "not_a_mode")


# ---------------------------------------------------------------------------
# API 层：参数校验 + 模式接线（D1.3/D1.4）
# ---------------------------------------------------------------------------


def test_comparison_mode_invalid_422(client, admin_headers):
    resp = client.get(
        "/api/v1/analytics/operations/overview",
        params={"from": iso(d(-6)), "to": iso(d(0)), "compare": "true",
                "comparison_mode": "weekly"},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    assert "comparison_mode" in resp.json()["detail"]


def test_comparison_mode_ignored_when_compare_false(client, admin_headers):
    """compare=false 时 comparison_mode 不改变结果（无 comparison，D1.4）。"""
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-6)), "to": iso(d(0))},
    )
    data2 = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-6)), "to": iso(d(0)),
         "comparison_mode": "previous_calendar_month"},
    )
    assert data["comparison"] is None
    assert data2["comparison"] is None
    assert data["metrics"] == data2["metrics"]


def test_api_this_month_previous_month_elapsed(client, db, admin_headers):
    """API 层：This Month（本月已过天数）-> previous [上月初, 上月初 + elapsed)。"""
    from app.core.business_date import business_date

    bd = business_date()
    month_start = bd.replace(day=1)
    elapsed = (bd - month_start).days
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(month_start), "to": iso(bd), "compare": "true",
         "comparison_mode": "previous_month_elapsed"},
    )
    comp = data["comparison"]
    assert comp is not None
    expected_from = (month_start - timedelta(days=1)).replace(day=1)
    expected_to = min(expected_from + timedelta(days=elapsed), month_start)
    assert comp["period"]["from"] == iso(expected_from)
    assert comp["period"]["to"] == iso(expected_to)


def test_api_last_month_previous_calendar_month(client, db, admin_headers):
    """API 层：Last Month -> previous [上月初, 本月初)。"""
    from app.core.business_date import business_date

    bd = business_date()
    month_start = bd.replace(day=1)
    prev_start = (month_start - timedelta(days=1)).replace(day=1)
    data = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(prev_start), "to": iso(month_start), "compare": "true",
         "comparison_mode": "previous_calendar_month"},
    )
    comp = data["comparison"]
    assert comp is not None
    assert comp["period"]["from"] == iso((prev_start - timedelta(days=1)).replace(day=1))
    assert comp["period"]["to"] == iso(prev_start)
