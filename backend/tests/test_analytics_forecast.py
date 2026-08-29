# -*- coding: utf-8 -*-
"""S8 Forecast 去重测试（§55）：ACTIVE Stay 与其 CHECKED_IN Reservation 只计一次。

- 未来 CONFIRMED Reservation 正常计入。
- CANCELLED / NO_SHOW 不计。
- 超期 ACTIVE Stay（planned_check_out <= current_business_date）不贡献未来房晚
  （overdue 运营问题由 overdue_active_stays 快照反映，§10）。
- 最终按 distinct (business_date, room_id) 仲裁去重。
"""

from tests.analytics_helpers import build_stay, d, get_analytics, iso
from tests.booking_helpers import create_reservation, find_room


def test_active_stay_linked_reservation_counted_once(client, db, admin_headers):
    """ACTIVE Stay + linked CHECKED_IN Reservation：Forecast 只计 Stay 剩余房晚。"""
    room301 = find_room(client, admin_headers, "301")
    build_stay(client, db, admin_headers, room301, ci=(-1, 14), co=(5, 10),
               amount="500.00", checkout=False, planned_co_days=5)
    data = get_analytics(client, admin_headers, "forecast")
    # Stay 剩余 [D0, d5) = 5 晚；若把 CHECKED_IN Reservation.room_id（原分配房）
    # 也计入 → 双算 10 晚
    assert data["horizons"]["7d"]["on_books_room_nights"] == 5
    assert data["horizons"]["14d"]["on_books_room_nights"] == 5
    assert data["horizons"]["30d"]["on_books_room_nights"] == 5
    daily = {r["business_date"]: r["on_books_room_nights"] for r in data["daily"]}
    assert [daily[iso(d(i))] for i in range(5)] == [1, 1, 1, 1, 1]
    assert daily[iso(d(5))] == 0


def test_future_confirmed_included_cancelled_noshow_excluded(client, db, admin_headers):
    """未来 CONFIRMED 计入；CANCELLED / NO_SHOW 不计。"""
    from app.models import Reservation

    from tests.analytics_helpers import backdate
    from tests.booking_helpers import create_guest

    guest = create_guest(client, admin_headers, name="预测测试客", phone="13922223333")
    room302 = find_room(client, admin_headers, "302")
    room303 = find_room(client, admin_headers, "303")
    room304 = find_room(client, admin_headers, "304")
    # 302：未来 CONFIRMED [d2, d4) → 2 晚
    r302 = create_reservation(client, admin_headers, room=room302,
                              guest_id=guest["id"], check_in=d(2), check_out=d(4),
                              amount="400.00")
    # 303：CANCELLED（未来日期可取消）
    r303 = create_reservation(client, admin_headers, room=room303,
                              guest_id=guest["id"], check_in=d(1), check_out=d(3),
                              amount="400.00")
    cancel = client.post(f"/api/v1/reservations/{r303['id']}/cancel",
                         headers=admin_headers)
    assert cancel.status_code == 200, cancel.text
    # 304：NO_SHOW（No-show 资格要求 business_date >= check_in，先按今天创建再回填）
    r304 = create_reservation(client, admin_headers, room=room304,
                              guest_id=guest["id"], amount="400.00")
    noshow = client.post(f"/api/v1/reservations/{r304['id']}/no-show",
                         headers=admin_headers)
    assert noshow.status_code == 200, noshow.text
    backdate(db, Reservation, r304["id"], check_in_date=d(1), check_out_date=d(3))

    data = get_analytics(client, admin_headers, "forecast")
    assert data["horizons"]["7d"]["on_books_room_nights"] == 2  # 仅 302
    assert data["horizons"]["14d"]["on_books_room_nights"] == 2
    assert data["horizons"]["30d"]["on_books_room_nights"] == 2
    daily = {r["business_date"]: r["on_books_room_nights"] for r in data["daily"]}
    assert daily[iso(d(2))] == 1
    assert daily[iso(d(3))] == 1
    assert daily[iso(d(1))] == 0


def test_overdue_active_stay_contributes_nothing_to_forecast(client, db, admin_headers):
    """超期 ACTIVE Stay（planned <= D0）不贡献未来房晚；overdue 由快照反映。"""
    room305 = find_room(client, admin_headers, "305")
    build_stay(client, db, admin_headers, room305, ci=(-3, 15), co=(5, 10),
               amount="400.00", checkout=False, planned_co_days=-1)
    data = get_analytics(client, admin_headers, "forecast")
    assert data["horizons"]["7d"]["on_books_room_nights"] == 0
    assert data["horizons"]["30d"]["on_books_room_nights"] == 0
    assert all(r["on_books_room_nights"] == 0 for r in data["daily"])
    overview = get_analytics(
        client, admin_headers, "operations/overview",
        {"from": iso(d(-6)), "to": iso(d(0))},
    )
    assert overview["snapshot"]["overdue_active_stays"] == 1
    # 但该 Stay 已实际发生的历史房晚仍属于 Actual（3 晚，不被 planned d(-1) 截断）
    assert overview["metrics"]["actual_occupied_room_nights"] == 3


def test_forecast_room_move_active_stay_uses_current_room(client, db, admin_headers):
    """ACTIVE Stay 换房后：Forecast 使用当前实际房间（Stay.room_id），原房不占用。"""
    room306 = find_room(client, admin_headers, "306")
    room307 = find_room(client, admin_headers, "307")
    build_stay(client, db, admin_headers, room306, ci=(-1, 14), co=(5, 10),
               amount="500.00", checkout=False, planned_co_days=5,
               moves=[(room307["id"], "UPGRADE", (0, 9))])
    data = get_analytics(client, admin_headers, "forecast")
    # 剩余 [D0, d5) = 5 晚，落在 307（当前房）；306 不被占用
    assert data["horizons"]["7d"]["on_books_room_nights"] == 5
    daily = {r["business_date"]: r["on_books_room_nights"] for r in data["daily"]}
    assert [daily[iso(d(i))] for i in range(5)] == [1, 1, 1, 1, 1]
