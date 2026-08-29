# -*- coding: utf-8 -*-
"""S8 零数据测试（§57，RELEASE BLOCKING）：Pre-opening 酒店必须原生支持空数据。

规则：Count -> 0；Rate/Average 分母 0 -> null；Empty series -> []；
禁止 NaN / Infinity / fake business data。
"""

import json
import math

from tests.analytics_helpers import d, get_analytics, iso

ALL_PATHS = (
    "operations/overview",
    "operations/bookings",
    "operations/housekeeping",
    "operations/maintenance",
    "operations/room-moves",
    "business/rooms",
    "business/inventory",
    "business/procurement",
)


def _assert_no_non_finite(payload) -> None:
    """递归扫描：不允许 NaN / Infinity（§33）。"""
    def walk(value):
        if isinstance(value, float):
            assert math.isfinite(value), f"non-finite value: {value}"
        elif isinstance(value, dict):
            for v in value.values():
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)
    walk(payload)


def test_zero_data_all_endpoints(client, admin_headers):
    """无任何业务数据（仅种子房间/权限）：全部端点 200 且 0/null/[] 语义合法。"""
    params = {"from": iso(d(-6)), "to": iso(d(0))}
    overview = get_analytics(client, admin_headers, "operations/overview", params)
    m = overview["metrics"]
    assert m["actual_occupied_room_nights"] == 0
    assert m["physical_room_nights"] == 28 * 6
    assert m["physical_occupancy_rate"] == 0.0  # 0/168，分母非 0 → 0.0
    assert m["completed_stays"] == 0
    assert m["average_length_of_stay"] is None  # 分母 0
    assert m["scheduled_arrivals"] == 0
    assert m["cancellation_rate"] is None
    assert m["no_show_rate"] is None
    assert m["average_booking_lead_days"] is None
    assert m["room_move_rate"] is None
    assert m["housekeeping_completed_tasks"] == 0
    snap = overview["snapshot"]
    assert snap["active_stays"] == 0
    assert snap["overdue_active_stays"] == 0
    assert snap["housekeeping_backlog"] == 0
    assert snap["active_maintenance"] == 0
    assert snap["active_blocking_maintenance"] == 0
    assert overview["on_books"]["7d"]["on_books_room_nights"] == 0
    assert overview["on_books"]["7d"]["occupancy_rate"] == 0.0

    bookings = get_analytics(client, admin_headers, "operations/bookings", params)
    assert bookings["booking_lead_distribution"] == [
        {"bucket": "0-1", "count": 0},
        {"bucket": "2-3", "count": 0},
        {"bucket": "4-7", "count": 0},
        {"bucket": "8-14", "count": 0},
        {"bucket": "15-30", "count": 0},
        {"bucket": "31+", "count": 0},
    ]
    assert len(bookings["daily"]) == 6
    assert all(row["occupied_room_nights"] == 0 for row in bookings["daily"])

    hk = get_analytics(client, admin_headers, "operations/housekeeping", params)
    assert hk["housekeeping_completed_tasks"] == 0
    assert hk["average_housekeeping_cycle_minutes"] is None
    assert hk["checkout_turnover_minutes"] is None
    assert hk["room_move_cleaning_tasks"] == 0
    assert hk["housekeeping_backlog"] == 0
    assert hk["daily"] == []

    mnt = get_analytics(client, admin_headers, "operations/maintenance", params)
    assert mnt["maintenance_created"] == 0
    assert mnt["mean_time_to_resolution_minutes"] is None
    assert mnt["mean_verification_minutes"] is None
    assert mnt["maintenance_by_category"] == []
    assert mnt["maintenance_by_room"] == []

    rm = get_analytics(client, admin_headers, "operations/room-moves", params)
    assert rm["room_move_count"] == 0
    assert rm["moved_stay_count"] == 0
    assert rm["room_move_rate"] is None
    assert rm["room_moves_by_reason"] == []
    assert rm["room_moves_by_source_room"] == []

    rooms = get_analytics(client, admin_headers, "business/rooms", params)
    assert rooms["contracted_room_value"] == "0.00"
    assert rooms["priced_occupied_room_nights"] == 0
    assert rooms["unpriced_occupied_room_nights"] == 0
    assert rooms["contracted_adr"] is None  # 分母（有价房晚）= 0
    # RevPAR 分母 = 物理房晚 168（非 0）→ 0.0000（不是 null，也不是 NaN）
    assert rooms["contracted_revpar"] == "0.0000"

    inv = get_analytics(client, admin_headers, "business/inventory", params)
    assert inv["current_low_stock_items"] == 0
    assert inv["current_out_of_stock_items"] == 0
    assert inv["occupied_room_nights"] == 0
    assert inv["items"] == []

    prc = get_analytics(client, admin_headers, "business/procurement", params)
    assert prc["purchase_requests_created"] == 0
    assert prc["pending_purchase_requests"] == 0
    assert prc["purchase_orders_created"] == 0
    assert prc["pending_receipt_orders"] == 0
    assert prc["partially_received_orders"] == 0
    assert prc["received_purchase_value"] == "0.00"
    assert prc["unpriced_received_lines"] == 0
    assert prc["received_value_by_supplier"] == []
    assert prc["received_value_by_item"] == []
    assert prc["daily"] == []

    forecast = get_analytics(client, admin_headers, "forecast")
    assert forecast["horizons"]["7d"]["on_books_room_nights"] == 0
    assert forecast["horizons"]["7d"]["occupancy_rate"] == 0.0
    assert len(forecast["daily"]) == 30
    assert all(r["on_books_room_nights"] == 0 for r in forecast["daily"])

    # 全量 payload 无 NaN / Infinity（§33）
    for path in ALL_PATHS:
        _assert_no_non_finite(get_analytics(client, admin_headers, path, params))
    _assert_no_non_finite(get_analytics(client, admin_headers, "forecast"))


def test_zero_data_compare_no_infinity(client, admin_headers):
    """零数据 + compare=true：previous=0 → percent_change=null，无 Infinity%（§58）。"""
    params = {"from": iso(d(-6)), "to": iso(d(0)), "compare": "true"}
    data = get_analytics(client, admin_headers, "operations/overview", params)
    assert data["comparison"] is not None
    changes = data["comparison"]["changes"]
    for key in ("actual_occupied_room_nights", "completed_stays",
                "scheduled_arrivals", "no_show_count", "room_move_count",
                "housekeeping_completed_tasks"):
        assert changes[key]["percent_change"] is None, f"{key} 应因 previous=0 为 null"
    # 物理入住率两侧分母都非 0 → 0.0 - 0.0 = 0.0 pp；比率类分母 0 → pp_delta null
    assert changes["physical_occupancy_rate"]["pp_delta"] == 0.0
    for key in ("cancellation_rate", "no_show_rate", "room_move_rate"):
        assert changes[key]["pp_delta"] is None, f"{key} 两侧为空 → pp_delta null"
    # 序列化往返无 NaN / Infinity
    text = json.dumps(data)
    assert "NaN" not in text and "Infinity" not in text
