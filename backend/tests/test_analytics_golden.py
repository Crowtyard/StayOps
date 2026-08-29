# -*- coding: utf-8 -*-
"""S8 Golden Analytics Dataset（§52/§53）：人工可计算的确定性数据集 + exact assert。

数据集构造见 analytics_helpers.build_golden()；以下断言全部使用字面量
Expected Values（基于 business_date 相对日期的固定区间/金额，非随机日期）。

Golden 窗口：period = [d(-6), d(0))，days = 6，physical = 28 × 6 = 168。
"""

from decimal import Decimal

from tests.analytics_helpers import build_golden, d, get_analytics, iso


def _q(value: str | int, places: int = 4) -> Decimal:
    return (Decimal(value) / Decimal(1)).quantize(Decimal("1." + "0" * places))


def _q4(value: Decimal) -> Decimal:
    """4 位小数（ROUND_HALF_EVEN，与后端 quantize 一致）。"""
    return value.quantize(Decimal("0.0001"))


def _period():
    return {"from": iso(d(-6)), "to": iso(d(0))}


def test_golden_overview(client, db, admin_headers):
    """Overview 周期指标 + 当前快照 + On-books 摘要（§45）。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "operations/overview", _period())

    assert data["business_date"] == iso(d(0))
    assert data["period"] == {"from": iso(d(-6)), "to": iso(d(0)), "days": 6}
    assert data["comparison"] is None

    m = data["metrics"]
    # 实际占用房晚 = 13（S1:2 + S2:3 + S3:2 + S4:4 + S5:2；S2 换房不重复计数）
    assert m["actual_occupied_room_nights"] == 13
    # 物理房晚 = 28 房 × 6 天（来自 Room master，非硬编码）
    assert m["physical_room_nights"] == 28 * 6
    assert m["physical_occupancy_rate"] == round(13 / (28 * 6), 4)
    # ALOS：completed cohort（S1/S2/S5）实际房晚 2+3+2=7 / 3
    assert m["completed_stays"] == 3
    assert m["average_length_of_stay"] == round(7 / 3, 4)
    # Arrival Cohort：R1..R7；cancelled R6；no-show R7
    assert m["scheduled_arrivals"] == 7
    assert m["cancelled_arrivals"] == 1
    assert m["cancellation_rate"] == round(1 / 7, 4)
    assert m["no_show_count"] == 1
    assert m["no_show_rate"] == round(1 / 6, 4)
    # 提前天数（非 CANCELLED）：(3+5+2+2+0+5)/6 = 17/6 ≈ 2.8
    assert m["average_booking_lead_days"] == 2.8
    # Room Move：S2 一次换房；rate = 换房 cohort 1 / 入住 cohort 5
    assert m["room_move_count"] == 1
    assert m["moved_stay_count"] == 1
    assert m["room_move_rate"] == 0.2
    assert m["housekeeping_completed_tasks"] == 3

    snap = data["snapshot"]
    assert snap["active_stays"] == 2  # S3 + S4
    assert snap["overdue_active_stays"] == 1  # S4（planned d-1 <= D0）
    assert snap["housekeeping_backlog"] == 1  # T4 PENDING
    assert snap["active_maintenance"] == 2  # M3 OPEN + M4 ASSIGNED
    assert snap["active_blocking_maintenance"] == 1  # M3

    ob = data["on_books"]
    # Forecast：ACTIVE S3 剩余 2 晚 + CONFIRMED R8 2 晚 + R11 2 晚（7d 内）
    assert ob["7d"]["days"] == 7
    assert ob["7d"]["physical_room_nights"] == 28 * 7
    assert ob["7d"]["on_books_room_nights"] == 6
    assert ob["7d"]["occupancy_rate"] == round(6 / (28 * 7), 4)
    assert ob["14d"]["on_books_room_nights"] == 7  # + R11 第 3 晚
    assert ob["14d"]["occupancy_rate"] == round(7 / (28 * 14), 4)
    assert ob["30d"]["on_books_room_nights"] == 7
    assert ob["30d"]["occupancy_rate"] == round(7 / (28 * 30), 4)


def test_golden_bookings(client, db, admin_headers):
    """Bookings：Arrival Cohort + 提前天数分布 + ALOS + 每日占用趋势（§12-§16）。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "operations/bookings", _period())

    assert data["scheduled_arrivals"] == 7
    assert data["cancelled_arrivals"] == 1
    assert data["cancellation_rate"] == round(1 / 7, 4)
    assert data["no_show_count"] == 1
    assert data["no_show_rate"] == round(1 / 6, 4)
    assert data["average_booking_lead_days"] == 2.8
    assert data["booking_lead_distribution"] == [
        {"bucket": "0-1", "count": 1},   # R5
        {"bucket": "2-3", "count": 3},   # R1 / R3 / R4
        {"bucket": "4-7", "count": 2},   # R2 / R7
        {"bucket": "8-14", "count": 0},
        {"bucket": "15-30", "count": 0},
        {"bucket": "31+", "count": 0},
    ]
    assert data["completed_stays"] == 3
    assert data["average_length_of_stay"] == round(7 / 3, 4)
    assert data["room_move_count"] == 1
    assert data["moved_stay_count"] == 1
    assert data["room_move_rate"] == 0.2

    # 每日实际占用：d-6:1（S5）、d-5:3（S1/S2/S5）、d-4:3（S1/S2/S4）、
    # d-3:2（S2/S4）、d-2:2（S3/S4）、d-1:2（S3/S4）；合计 13
    daily = {row["business_date"]: row["occupied_room_nights"] for row in data["daily"]}
    assert [daily[iso(d(-6 + i))] for i in range(6)] == [1, 3, 3, 2, 2, 2]
    assert sum(row["occupied_room_nights"] for row in data["daily"]) == 13
    for row in data["daily"]:
        assert row["physical_room_nights"] == 28
        assert row["occupancy_rate"] == round(row["occupied_room_nights"] / 28, 4)


def test_golden_business_rooms(client, db, admin_headers):
    """Contracted Room Value / Priced / Unpriced / ADR / RevPAR（§17-§22）。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "business/rooms", _period())

    # 合同房费 = 800 + 1200 + 450（S3 实际 2 晚×225）+ 600（S4 计划内 3 晚×200）
    #         + 500 = 3550.00；S4 超计划 1 晚（d-1）→ unpriced，不猜价格
    assert data["contracted_room_value"] == "3550.00"
    assert data["priced_occupied_room_nights"] == 12
    assert data["unpriced_occupied_room_nights"] == 1
    assert Decimal(data["contracted_adr"]) == _q4(Decimal("3550") / 12)
    assert Decimal(data["contracted_revpar"]) == _q4(Decimal("3550") / 168)
    assert data["physical_room_nights"] == 168

    daily = {row["business_date"]: row for row in data["daily"]}
    # 每日有价房晚：d-6:1（S5）、d-5:3（S1/S2/S5）、d-4:3（S1/S2/S4）、
    # d-3:2（S2/S4）、d-2:2（S3/S4）、d-1:1（S3，S4 超计划）→ 12
    priced_by_day = {iso(d(-6)): 1, iso(d(-5)): 3, iso(d(-4)): 3,
                     iso(d(-3)): 2, iso(d(-2)): 2, iso(d(-1)): 1}
    for day, expected in priced_by_day.items():
        assert daily[day]["priced_occupied_room_nights"] == expected
    assert sum(row["priced_occupied_room_nights"] for row in data["daily"]) == 12


def test_golden_housekeeping(client, db, admin_headers):
    """Housekeeping（§23）：完成数 / 平均周期 / 退房翻房 / 换房保洁 / 积压。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "operations/housekeeping", _period())

    assert data["housekeeping_completed_tasks"] == 3  # T1 + T2 + T3
    # 周期：(120 + 150 + 60) / 3 = 110.0 分钟
    assert data["average_housekeeping_cycle_minutes"] == 110.0
    assert data["checkout_turnover_minutes"] == 120.0  # T1
    assert data["room_move_cleaning_tasks"] == 1  # T3
    assert data["housekeeping_backlog"] == 1  # T4
    completed_days = {row["business_date"]: row["completed_tasks"] for row in data["daily"]}
    assert completed_days[iso(d(-4))] == 1  # T3
    assert completed_days[iso(d(-3))] == 1  # T1
    assert completed_days[iso(d(-2))] == 1  # T2


def test_golden_maintenance(client, db, admin_headers):
    """Maintenance（§24）：新建/完成/Active/阻断 + MTTR/验收 + 分类/房间分布。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "operations/maintenance", _period())

    assert data["maintenance_created"] == 4  # M1..M4
    assert data["maintenance_completed"] == 2  # M1 + M2
    assert data["active_maintenance"] == 2  # M3 + M4
    assert data["active_blocking_maintenance"] == 1  # M3
    # MTTR：(360 + 1140) / 2 = 750.0 分钟；验收：(60 + 60) / 2 = 60.0
    assert data["mean_time_to_resolution_minutes"] == 750.0
    assert data["mean_verification_minutes"] == 60.0
    assert {r["category"]: r["count"] for r in data["maintenance_by_category"]} == {
        "ELECTRICAL": 1, "HVAC": 1, "LOCK": 1, "PLUMBING": 1,
    }
    by_room = {r["room_number"]: r["count"] for r in data["maintenance_by_room"]}
    assert by_room == {"101": 1, "102": 1, "103": 1, "104": 1}


def test_golden_room_moves(client, db, admin_headers):
    """Room Move（§25）：次数 / 涉及住宿 / 换房率 / 原因 / 来源房分布。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "operations/room-moves", _period())

    assert data["room_move_count"] == 1
    assert data["moved_stay_count"] == 1
    assert data["room_move_rate"] == 0.2
    assert data["room_moves_by_reason"] == [{"reason": "GUEST_REQUEST", "count": 1}]
    assert data["room_moves_by_source_room"] == [{"room_id": data["room_moves_by_source_room"][0]["room_id"], "room_number": "102", "count": 1}]


def test_golden_inventory(client, db, admin_headers):
    """Inventory（§26-§28）：低/缺货快照 + 每物资领用量与领用强度（不跨单位求和）。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "business/inventory", _period())

    assert data["current_low_stock_items"] == 1  # B（余额 2 <= 最低 5）
    assert data["current_out_of_stock_items"] == 1  # E（余额 0，无任何流水）
    assert data["occupied_room_nights"] == 13
    items = {row["item_code"]: row for row in data["items"]}
    # A：领用 10+5 = 15（RETURN 不减）；强度 15/13 ≈ 1.1538
    assert items["GOLD-WATER"]["base_unit"] == "瓶"
    assert Decimal(items["GOLD-WATER"]["issue_quantity"]) == Decimal("15")
    assert items["GOLD-WATER"]["issue_quantity_per_occupied_room_night"] == round(15 / 13, 4)
    assert items["GOLD-WATER"]["stock_status"] == "NORMAL"
    # B：领用 3；强度 3/13 ≈ 0.2308；无收货 → LOW_STOCK
    assert items["GOLD-SLIPPER"]["base_unit"] == "双"
    assert Decimal(items["GOLD-SLIPPER"]["issue_quantity"]) == Decimal("3")
    assert items["GOLD-SLIPPER"]["issue_quantity_per_occupied_room_night"] == round(3 / 13, 4)
    assert items["GOLD-SLIPPER"]["stock_status"] == "LOW_STOCK"
    # C：无领用；0 领用 / 13 房晚 = 0.0（非 null）；有收货 → NORMAL
    assert Decimal(items["GOLD-TOWEL"]["issue_quantity"]) == Decimal("0")
    assert items["GOLD-TOWEL"]["issue_quantity_per_occupied_room_night"] == 0.0
    assert items["GOLD-TOWEL"]["stock_status"] == "NORMAL"
    # D：TRANSFER / ADJUSTMENT 不计入领用
    assert Decimal(items["GOLD-PAPER"]["issue_quantity"]) == Decimal("0")
    assert items["GOLD-PAPER"]["issue_quantity_per_occupied_room_night"] == 0.0
    # E：无任何活动 → OUT_OF_STOCK
    assert Decimal(items["GOLD-SHAMPOO"]["issue_quantity"]) == Decimal("0")
    assert items["GOLD-SHAMPOO"]["issue_quantity_per_occupied_room_night"] == 0.0
    assert items["GOLD-SHAMPOO"]["stock_status"] == "OUT_OF_STOCK"


def test_golden_procurement(client, db, admin_headers):
    """Procurement（§29/§30）：申请/订单/待收货 + 到货采购金额（按收货日期归属）。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "business/procurement", _period())

    assert data["purchase_requests_created"] == 2  # PR1（DRAFT）+ PR2（APPROVED）
    assert data["pending_purchase_requests"] == 1  # PR2（SUBMITTED/APPROVED 口径）
    assert data["purchase_orders_created"] == 2  # PO1 + PO2
    assert data["pending_receipt_orders"] == 1  # PO2（PARTIALLY_RECEIVED）
    assert data["partially_received_orders"] == 1  # PO2
    # 到货金额（按 received_at 归属）：PO1 第一次 60×1.5 + 10×3 = 120.00；
    # 第二次 40×1.5 + 10×3 = 90.00 → 210.00；PO2 无单价 → 0 + unpriced 1
    assert data["received_purchase_value"] == "210.00"
    assert data["unpriced_received_lines"] == 1
    assert data["received_value_by_supplier"] == [
        {"supplier_id": data["received_value_by_supplier"][0]["supplier_id"],
         "supplier_code": "SUP-GOLD", "supplier_name": "泉城黄金供应商",
         "received_value": "210.00"},
    ]
    by_item = {r["item_code"]: r for r in data["received_value_by_item"]}
    assert by_item["GOLD-WATER"]["received_value"] == "150.00"
    assert by_item["GOLD-PAPER"]["received_value"] == "60.00"
    assert by_item["GOLD-TOWEL"]["received_value"] == "0.00"
    daily = {r["business_date"]: r["received_purchase_value"] for r in data["daily"]}
    assert daily[iso(d(-2))] == "120.00"
    assert daily[iso(d(-1))] == "90.00"


def test_golden_forecast(client, db, admin_headers):
    """Forecast（§10/§11）：7d/14d/30d + 30 日每日序列。"""
    build_golden(client, db, admin_headers)
    data = get_analytics(client, admin_headers, "forecast")

    assert data["business_date"] == iso(d(0))
    assert data["physical_room_count"] == 28
    assert data["horizons"]["7d"]["on_books_room_nights"] == 6
    assert data["horizons"]["14d"]["on_books_room_nights"] == 7
    assert data["horizons"]["30d"]["on_books_room_nights"] == 7
    daily = {r["business_date"]: r["on_books_room_nights"] for r in data["daily"]}
    # S3 剩余 [D0, d2) → D0、d1；R8 [d1, d3) → d1、d2；R11 [d5, d8) → d5..d7
    assert daily[iso(d(0))] == 1
    assert daily[iso(d(1))] == 2
    assert daily[iso(d(2))] == 1
    assert daily[iso(d(3))] == 0
    assert daily[iso(d(4))] == 0
    assert daily[iso(d(5))] == 1
    assert daily[iso(d(6))] == 1
    assert daily[iso(d(7))] == 1
    assert daily[iso(d(8))] == 0
