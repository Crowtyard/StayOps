# -*- coding: utf-8 -*-
"""Sprint 4 Front Desk 数据查询测试：Reservation List 日期窗口重叠查询。

overlap_from / overlap_to（语义 [from, to)）：
- 预订区间 [check_in_date, check_out_date) 与 [overlap_from, overlap_to) 有重叠
  （check_in < overlap_to AND check_out > overlap_from）
- 紧邻（touch）不视为重叠；边界日重叠视为重叠
- 非法窗口（只给一端 / from >= to）→ 422；无 reservation:read → 403
- 权限裁剪与分页继续有效；CANCELLED 等终态仍可被查询（UI 层决定是否展示）
"""

from tests.booking_helpers import (
    check_in,
    create_guest,
    create_reservation,
    d,
    find_room,
    iso,
    today,
)

from tests.test_booking_pii import _make_role_user


def _ids(client, headers, params) -> list[int]:
    resp = client.get("/api/v1/reservations", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    return [item["id"] for item in resp.json()["items"]]


# ---------------------------------------------------------------------------
# 重叠 / 不重叠 / 紧邻 / 边界
# ---------------------------------------------------------------------------


def test_overlap_returns_intersecting_reservation(client, admin_headers):
    """预订 [d2, d5) 与窗口 [d3, d4) 有重叠 → 命中。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "301")
    res = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(2), check_out=d(5),
    )
    ids = _ids(
        client,
        admin_headers,
        {"overlap_from": iso(d(3)), "overlap_to": iso(d(4)), "page_size": 100},
    )
    assert res["id"] in ids


def test_overlap_excludes_non_overlapping_reservation(client, admin_headers):
    """窗口在预订区间之后（touch 起点）或之前（touch 终点）→ 不命中。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "301")
    res = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(2), check_out=d(5),
    )
    # 窗口 [d5, d7)：预订已结束（check_out == d5，不含），紧邻不重叠
    ids = _ids(
        client,
        admin_headers,
        {"overlap_from": iso(d(5)), "overlap_to": iso(d(7)), "page_size": 100},
    )
    assert res["id"] not in ids
    # 窗口 [d0, d2)：预订未开始（check_in == d2，不含），紧邻不重叠
    ids = _ids(
        client,
        admin_headers,
        {"overlap_from": iso(d(0)), "overlap_to": iso(d(2)), "page_size": 100},
    )
    assert res["id"] not in ids


def test_overlap_boundary_inclusive(client, admin_headers):
    """边界日重叠：窗口 [d1, d3) 覆盖预订 d2 一晚；[d4, d6) 覆盖 d4 一晚 → 都命中。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "301")
    res = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(2), check_out=d(5),
    )
    ids = _ids(
        client,
        admin_headers,
        {"overlap_from": iso(d(1)), "overlap_to": iso(d(3)), "page_size": 100},
    )
    assert res["id"] in ids
    ids = _ids(
        client,
        admin_headers,
        {"overlap_from": iso(d(4)), "overlap_to": iso(d(6)), "page_size": 100},
    )
    assert res["id"] in ids


def test_overlap_window_fully_contains_reservation(client, admin_headers):
    """窗口完全覆盖预订区间 → 命中（Room Diary 7/14/30 天窗口）。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "301")
    res = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(2), check_out=d(4),
    )
    ids = _ids(
        client,
        admin_headers,
        {"overlap_from": iso(d(0)), "overlap_to": iso(d(7)), "page_size": 100},
    )
    assert res["id"] in ids


def test_overlap_includes_checked_in_spanning_window(client, admin_headers):
    """已入住且跨窗的预订（check_in 在窗口前）→ 命中（时间线在住条）。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "302")
    res = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(-2), check_out=d(3),
    )
    check_in(client, admin_headers, res["id"])
    ids = _ids(
        client,
        admin_headers,
        {"overlap_from": iso(d(0)), "overlap_to": iso(d(7)), "page_size": 100},
    )
    assert res["id"] in ids


def test_overlap_returns_cancelled_for_client_filtering(client, admin_headers):
    """终态（CANCELLED）仍可被窗口查询返回；是否展示由 UI 层决定（Sprint 4 §8）。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "303")
    res = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(1), check_out=d(3),
    )
    cancel = client.post(
        f"/api/v1/reservations/{res['id']}/cancel", headers=admin_headers
    )
    assert cancel.status_code == 200
    ids = _ids(
        client,
        admin_headers,
        {"overlap_from": iso(d(0)), "overlap_to": iso(d(7)), "page_size": 100},
    )
    assert res["id"] in ids


# ---------------------------------------------------------------------------
# 非法窗口
# ---------------------------------------------------------------------------


def test_overlap_invalid_date_ranges(client, admin_headers):
    """只给一端 / from == to / from > to → 422。"""
    for params in (
        {"overlap_from": iso(d(0))},
        {"overlap_to": iso(d(7))},
        {"overlap_from": iso(d(3)), "overlap_to": iso(d(3))},
        {"overlap_from": iso(d(5)), "overlap_to": iso(d(2))},
    ):
        resp = client.get(
            "/api/v1/reservations", params=params, headers=admin_headers
        )
        assert resp.status_code == 422, (params, resp.text)


def test_overlap_requires_reservation_read(client, admin_headers, make_user, token_for):
    """无 reservation:read → 403（窗口参数不改变权限边界）。"""
    h = _make_role_user(
        client, admin_headers, make_user, token_for, "overlap_denied", []
    )
    resp = client.get(
        "/api/v1/reservations",
        params={"overlap_from": iso(d(0)), "overlap_to": iso(d(7))},
        headers=h,
    )
    assert resp.status_code == 403


def test_overlap_pagination(client, admin_headers):
    """窗口查询 + 分页：total 正确、翻页无重复。"""
    guest = create_guest(client, admin_headers)
    created = []
    for room_no in ("304", "305", "306"):
        room = find_room(client, admin_headers, room_no)
        res = create_reservation(
            client, admin_headers, room=room, guest_id=guest["id"],
            check_in=d(1), check_out=d(3),
        )
        created.append(res["id"])
    page1 = client.get(
        "/api/v1/reservations",
        params={
            "overlap_from": iso(d(0)),
            "overlap_to": iso(d(7)),
            "page": 1,
            "page_size": 2,
        },
        headers=admin_headers,
    ).json()
    assert page1["total"] == 3
    assert len(page1["items"]) == 2
    page2 = client.get(
        "/api/v1/reservations",
        params={
            "overlap_from": iso(d(0)),
            "overlap_to": iso(d(7)),
            "page": 2,
            "page_size": 2,
        },
        headers=admin_headers,
    ).json()
    assert len(page2["items"]) == 1
    all_ids = [i["id"] for i in page1["items"] + page2["items"]]
    assert sorted(all_ids) == sorted(created)


def test_overlap_combines_with_status_filter(client, admin_headers):
    """窗口查询可与 status 等既有筛选组合。"""
    guest = create_guest(client, admin_headers)
    room = find_room(client, admin_headers, "307")
    confirmed = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(1), check_out=d(3),
    )
    cancelled = create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(6), check_out=d(8),
    )
    client.post(
        f"/api/v1/reservations/{cancelled['id']}/cancel", headers=admin_headers
    )
    ids = _ids(
        client,
        admin_headers,
        {
            "overlap_from": iso(d(0)),
            "overlap_to": iso(d(10)),
            "status": "CANCELLED",
            "page_size": 100,
        },
    )
    assert cancelled["id"] in ids
    assert confirmed["id"] not in ids


# ---------------------------------------------------------------------------
# PII：窗口 + search 组合仍遵守 guest:read 裁剪
# ---------------------------------------------------------------------------


def test_overlap_search_pii_cropped_without_guest_read(
    client, admin_headers, make_user, token_for
):
    """无 guest:read 的用户以 Guest 手机号搜索窗口内预订：
    命中结果不出现 guest_name（响应键缺失），后端裁剪而非前端隐藏。"""
    guest = create_guest(
        client, admin_headers, name="窗口隐私客人", phone="13300009999"
    )
    room = find_room(client, admin_headers, "308")
    create_reservation(
        client, admin_headers, room=room, guest_id=guest["id"],
        check_in=d(1), check_out=d(3),
    )
    h = _make_role_user(
        client,
        admin_headers,
        make_user,
        token_for,
        "overlap_no_guest",
        ["reservation:read"],
    )
    resp = client.get(
        "/api/v1/reservations",
        params={
            "overlap_from": iso(d(0)),
            "overlap_to": iso(d(7)),
            "search": "13300009999",
            "page_size": 100,
        },
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] >= 1
    for item in body["items"]:
        assert "guest_name" not in item
        assert "phone" not in item
        assert "email" not in item
        assert "guest_id" in item
        assert "reservation_no" in item
