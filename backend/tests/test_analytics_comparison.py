# -*- coding: utf-8 -*-
"""S8 周期对比测试（§31/§32/§58）。

- 比率指标 → percentage points（pp_delta）
- 数量 / 金额 / 平均 → percent_change
- previous = 0 → percent_change = null（禁止 Infinity%）
- 前一个周期 = 等长区间 [from - days, from)
"""

import json

from app.models import Reservation

from tests.analytics_helpers import backdate, build_stay, d, get_analytics, iso, ts
from tests.booking_helpers import create_guest, create_reservation, find_room


def test_comparison_pp_and_percent(client, db, admin_headers):
    """比率 → pp；数量/平均 → percent；previous=0 → null。"""
    # 当前窗口 [d-6, d0)：1 个完成 Stay 3 晚 + 1 个取消 + 1 个 NO_SHOW
    room201 = find_room(client, admin_headers, "201")
    build_stay(client, db, admin_headers, room201, ci=(-5, 14), co=(-2, 10),
               amount="600.00")
    guest = create_guest(client, admin_headers, name="对比测试客", phone="13933334444")
    r_cancel = create_reservation(client, admin_headers, room=room201,
                                  guest_id=guest["id"], amount="300.00")
    cancel = client.post(f"/api/v1/reservations/{r_cancel['id']}/cancel",
                         headers=admin_headers)
    assert cancel.status_code == 200, cancel.text
    r_noshow = create_reservation(
        client, admin_headers, room=find_room(client, admin_headers, "202"),
        guest_id=guest["id"], amount="300.00")
    noshow = client.post(f"/api/v1/reservations/{r_noshow['id']}/no-show",
                         headers=admin_headers)
    assert noshow.status_code == 200, noshow.text
    from tests.analytics_helpers import backdate
    backdate(db, Reservation, r_cancel["id"], check_in_date=d(-3),
             check_out_date=d(-1), created_at=ts(-5, 9, 0))
    backdate(db, Reservation, r_noshow["id"], check_in_date=d(-4),
             check_out_date=d(-2), created_at=ts(-5, 10, 0))

    # 上一窗口 [d-12, d-6)：1 个完成 Stay 3 晚（无取消/未到店）
    room204 = find_room(client, admin_headers, "204")
    build_stay(client, db, admin_headers, room204, ci=(-10, 14), co=(-7, 10),
               amount="600.00")

    data = get_analytics(client, admin_headers, "operations/overview", {
        "from": iso(d(-6)), "to": iso(d(0)), "compare": "true",
    })
    m = data["metrics"]
    comp = data["comparison"]
    assert comp["period"] == {"from": iso(d(-12)), "to": iso(d(-6)), "days": 6}
    cm = comp["metrics"]

    # 实际房晚：当前 3、上一 3 → percent_change 0.0
    assert m["actual_occupied_room_nights"] == 3
    assert cm["actual_occupied_room_nights"] == 3
    assert comp["changes"]["actual_occupied_room_nights"]["percent_change"] == 0.0

    # 物理入住率：3/168 与 3/168 → pp_delta 0.0（percentage points 语义）
    assert comp["changes"]["physical_occupancy_rate"]["pp_delta"] == 0.0

    # 取消率：当前 1/3 ≈ 0.3333、上一 0/1 = 0.0 → pp_delta ≈ +0.3333
    assert m["scheduled_arrivals"] == 3
    assert m["cancelled_arrivals"] == 1
    assert m["cancellation_rate"] == round(1 / 3, 4)
    assert cm["cancellation_rate"] == 0.0
    assert comp["changes"]["cancellation_rate"]["pp_delta"] == round(1 / 3, 4)

    # no-show：当前 1/(3-1) = 0.5、上一 0.0 → pp_delta 0.5；计数 previous=0 → null
    assert m["no_show_rate"] == 0.5
    assert comp["changes"]["no_show_rate"]["pp_delta"] == 0.5
    assert comp["changes"]["no_show_count"]["percent_change"] is None

    # 平均住宿时长：当前 3.0、上一 3.0 → 0.0
    assert comp["changes"]["average_length_of_stay"]["percent_change"] == 0.0

    # 无换房：cohort 非空（3 与 1）→ 换房率两侧 0.0 → pp_delta 0.0；计数 0/0 → percent null
    assert comp["changes"]["room_move_rate"]["pp_delta"] == 0.0
    assert comp["changes"]["room_move_count"]["percent_change"] is None

    # 无 Infinity
    text = json.dumps(data)
    assert "Infinity" not in text and "NaN" not in text


def test_comparison_previous_zero_percent_null(client, db, admin_headers):
    """上一周期为 0 的数量指标 → percent_change=null（禁止 Infinity%）。"""
    room206 = find_room(client, admin_headers, "206")
    build_stay(client, db, admin_headers, room206, ci=(-3, 14), co=(0, 10),
               amount="400.00")
    data = get_analytics(client, admin_headers, "operations/overview", {
        "from": iso(d(-3)), "to": iso(d(0)), "compare": "true",
    })
    comp = data["comparison"]
    assert comp["period"] == {"from": iso(d(-6)), "to": iso(d(-3)), "days": 3}
    assert data["metrics"]["actual_occupied_room_nights"] == 3
    assert comp["metrics"]["actual_occupied_room_nights"] == 0
    assert comp["changes"]["actual_occupied_room_nights"]["percent_change"] is None
