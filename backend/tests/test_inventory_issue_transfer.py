# -*- coding: utf-8 -*-
"""Issue / Return / Transfer 测试（Sprint 7 §11-§17）。"""

from decimal import Decimal

from tests.inventory_helpers import (
    balance_for,
    create_item,
    get_item,
    initial_stock,
    issue,
    list_movements,
    location_by_code,
    stock_return,
    transfer,
)


def _setup_two_items(client, headers, *, stock_a="10", stock_b="10"):
    main = location_by_code(client, headers, "MAIN_STORAGE")
    item_a = create_item(client, headers, code="ITM-ISS-A01", name="水")
    item_b = create_item(client, headers, code="ITM-ISS-B01", name="拖鞋")
    initial_stock(client, headers, item_a["id"], main["id"], stock_a)
    initial_stock(client, headers, item_b["id"], main["id"], stock_b)
    return main, item_a, item_b


def test_issue_single_line_decreases_balance(client, admin_headers):
    main, item_a, _ = _setup_two_items(client, admin_headers)
    result = issue(
        client, admin_headers, main["id"],
        [{"item_id": item_a["id"], "quantity": "4"}],
    )
    assert result["issue_no"].startswith("SIS")
    assert Decimal(result["lines"][0]["quantity"]) == Decimal("4")
    assert balance_for(client, admin_headers, item_a["id"], main["id"]) == Decimal("6.00")

    movements = [
        m for m in list_movements(
            client, admin_headers, item_a["id"], main["id"]
        )
        if m.get("reference_type") == "stock_issue"
    ]
    assert len(movements) == 1
    assert movements[0]["movement_type"] == "ISSUE"
    assert Decimal(movements[0]["quantity"]) == Decimal("-4")
    assert movements[0]["reference_id"] == result["id"]
    assert movements[0]["operator_name"] is not None


def test_issue_multi_line_all_or_nothing(client, admin_headers):
    """多行领用整体原子：一行不足 -> 全部回滚（§12）。"""
    main, item_a, item_b = _setup_two_items(
        client, admin_headers, stock_a="8", stock_b="1"
    )
    # 牙刷（item_b）只有 1，领 2 -> 整体 409，水也不被扣
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": main["id"],
            "destination_type": "HOUSEKEEPING",
            "lines": [
                {"item_id": item_a["id"], "quantity": "8"},
                {"item_id": item_b["id"], "quantity": "2"},
            ],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409, resp.text
    assert "库存不足" in resp.json()["detail"]
    # 全部回滚：水仍是 8
    assert balance_for(client, admin_headers, item_a["id"], main["id"]) == Decimal("8.00")
    assert balance_for(client, admin_headers, item_b["id"], main["id"]) == Decimal("1.00")
    # 没有产生任何领用单
    issues = list_movements(
        client, admin_headers, item_a["id"], main["id"]
    )
    assert all(m.get("reference_type") != "stock_issue" for m in issues)

    # 合法多行：整体成功
    issue(
        client, admin_headers, main["id"],
        [
            {"item_id": item_a["id"], "quantity": "3"},
            {"item_id": item_b["id"], "quantity": "1"},
        ],
    )
    assert balance_for(client, admin_headers, item_a["id"], main["id"]) == Decimal("5.00")
    assert balance_for(client, admin_headers, item_b["id"], main["id"]) == Decimal("0.00")


def test_issue_insufficient_stock_409(client, admin_headers):
    main, item_a, _ = _setup_two_items(client, admin_headers, stock_a="2")
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": main["id"],
            "destination_type": "HOUSEKEEPING",
            "lines": [{"item_id": item_a["id"], "quantity": "3"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409, resp.text
    assert "库存不足" in resp.json()["detail"]
    # 无余额行时同样 409（不 500）
    empty_item = create_item(client, admin_headers, code="ITM-ISS-EMPTY")
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": main["id"],
            "destination_type": "OTHER",
            "lines": [{"item_id": empty_item["id"], "quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409, resp.text
    assert balance_for(client, admin_headers, empty_item["id"], main["id"]) is None


def test_issue_destination_room_validation(client, admin_headers):
    main, item_a, _ = _setup_two_items(client, admin_headers)
    rooms = client.get(
        "/api/v1/rooms", params={"page_size": 100}, headers=admin_headers
    ).json()["items"]
    room_id = rooms[0]["id"]

    # ROOM 且带 room_id：成功
    result = issue(
        client, admin_headers, main["id"],
        [{"item_id": item_a["id"], "quantity": "1"}],
        destination_type="ROOM", room_id=room_id,
    )
    assert result["destination_type"] == "ROOM"
    assert result["room_id"] == room_id

    # ROOM 缺 room_id -> 422
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": main["id"],
            "destination_type": "ROOM",
            "lines": [{"item_id": item_a["id"], "quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text

    # 非 ROOM 误填 room_id -> 422
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": main["id"],
            "destination_type": "HOUSEKEEPING",
            "room_id": room_id,
            "lines": [{"item_id": item_a["id"], "quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text

    # ROOM 但房间不存在 -> 422
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": main["id"],
            "destination_type": "ROOM",
            "room_id": 999999,
            "lines": [{"item_id": item_a["id"], "quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text

    # 重复物资行 -> 422
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": main["id"],
            "destination_type": "HOUSEKEEPING",
            "lines": [
                {"item_id": item_a["id"], "quantity": "1"},
                {"item_id": item_a["id"], "quantity": "1"},
            ],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text


def test_return_increases_balance(client, admin_headers):
    main, item_a, _ = _setup_two_items(client, admin_headers, stock_a="5")
    result = stock_return(
        client, admin_headers, item_a["id"], main["id"], "3", reason="未用完归还"
    )
    assert result["movement_no"].startswith("SMV")
    assert balance_for(client, admin_headers, item_a["id"], main["id"]) == Decimal("8.00")
    movements = [
        m for m in list_movements(
            client, admin_headers, item_a["id"], main["id"]
        )
        if m["movement_type"] == "RETURN"
    ]
    assert len(movements) == 1
    assert Decimal(movements[0]["quantity"]) == Decimal("3")
    assert movements[0]["reason"] == "未用完归还"

    # 无余额行时归还：自动创建余额行（projection 与 movement 同事务）
    new_item = create_item(client, admin_headers, code="ITM-RET-NEW01")
    stock_return(
        client, admin_headers, new_item["id"], main["id"], "2", reason="归还"
    )
    assert balance_for(client, admin_headers, new_item["id"], main["id"]) == Decimal("2.00")

    # 数量必须 > 0（422）
    resp = client.post(
        "/api/v1/inventory/returns",
        json={"item_id": item_a["id"], "location_id": main["id"],
              "quantity": "0", "reason": "x"},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text


def test_transfer_moves_stock_total_invariant(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    front = location_by_code(client, admin_headers, "FRONT_DESK")
    item = create_item(client, admin_headers, code="ITM-TRF-001")
    initial_stock(client, admin_headers, item["id"], main["id"], "10")

    result = transfer(
        client, admin_headers, main["id"], front["id"],
        [{"item_id": item["id"], "quantity": "4"}], reason="前台补货",
    )
    assert len(result["movement_ids"]) == 2
    assert Decimal(result["lines"][0]["quantity"]) == Decimal("4")
    # source 减少 / destination 增加 / 总库存不变（§16）
    assert balance_for(client, admin_headers, item["id"], main["id"]) == Decimal("6.00")
    assert balance_for(client, admin_headers, item["id"], front["id"]) == Decimal("4.00")
    assert Decimal(get_item(client, admin_headers, item["id"])["total_stock"]) == Decimal("10")

    movements = list_movements(client, admin_headers, item["id"])
    out_m = next(m for m in movements if m["movement_type"] == "TRANSFER_OUT")
    in_m = next(m for m in movements if m["movement_type"] == "TRANSFER_IN")
    assert Decimal(out_m["quantity"]) == Decimal("-4")
    assert Decimal(in_m["quantity"]) == Decimal("4")
    # OUT <-> IN 成对互指（可追溯）
    assert out_m["reference_id"] == in_m["id"]
    assert in_m["reference_id"] == out_m["id"]


def test_transfer_multi_line_atomic_rollback(client, admin_headers):
    """多行调拨整体原子：一行不足 -> 全部回滚（§16）。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    front = location_by_code(client, admin_headers, "FRONT_DESK")
    item_a = create_item(client, admin_headers, code="ITM-TRFM-A01")
    item_b = create_item(client, admin_headers, code="ITM-TRFM-B01")
    initial_stock(client, admin_headers, item_a["id"], main["id"], "10")
    initial_stock(client, admin_headers, item_b["id"], main["id"], "1")

    resp = client.post(
        "/api/v1/inventory/transfers",
        json={
            "source_location_id": main["id"],
            "destination_location_id": front["id"],
            "lines": [
                {"item_id": item_a["id"], "quantity": "5"},
                {"item_id": item_b["id"], "quantity": "2"},
            ],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 409, resp.text
    assert balance_for(client, admin_headers, item_a["id"], main["id"]) == Decimal("10.00")
    assert balance_for(client, admin_headers, item_a["id"], front["id"]) is None
    assert balance_for(client, admin_headers, item_b["id"], main["id"]) == Decimal("1.00")


def test_transfer_validation(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    front = location_by_code(client, admin_headers, "FRONT_DESK")
    item = create_item(client, admin_headers, code="ITM-TRF-VAL01")
    initial_stock(client, admin_headers, item["id"], main["id"], "5")

    # source == destination -> 422
    resp = client.post(
        "/api/v1/inventory/transfers",
        json={
            "source_location_id": main["id"],
            "destination_location_id": main["id"],
            "lines": [{"item_id": item["id"], "quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 地点不存在 -> 404
    resp = client.post(
        "/api/v1/inventory/transfers",
        json={
            "source_location_id": 999999,
            "destination_location_id": front["id"],
            "lines": [{"item_id": item["id"], "quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 404, resp.text
    # 物资不存在 -> 422
    resp = client.post(
        "/api/v1/inventory/transfers",
        json={
            "source_location_id": main["id"],
            "destination_location_id": front["id"],
            "lines": [{"item_id": 999999, "quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text


def test_issue_location_missing_404(client, admin_headers):
    item = create_item(client, admin_headers, code="ITM-ISS-LOC01")
    resp = client.post(
        "/api/v1/inventory/issues",
        json={
            "source_location_id": 999999,
            "destination_type": "OTHER",
            "lines": [{"item_id": item["id"], "quantity": "1"}],
        },
        headers=admin_headers,
    )
    assert resp.status_code == 404, resp.text


def test_movements_list_filters(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(client, admin_headers, code="ITM-MVL-001")
    initial_stock(client, admin_headers, item["id"], main["id"], "10")
    issue(
        client, admin_headers, main["id"],
        [{"item_id": item["id"], "quantity": "2"}],
    )

    movements = list_movements(
        client, admin_headers, item_id=item["id"], location_id=main["id"]
    )
    types = [m["movement_type"] for m in movements]
    assert types == ["ISSUE", "INITIAL"]  # id 降序

    initial_only = list_movements(
        client, admin_headers, item_id=item["id"],
        location_id=main["id"], movement_type="INITIAL",
    )
    assert all(m["movement_type"] == "INITIAL" for m in initial_only)

    by_ref = list_movements(
        client, admin_headers, item_id=item["id"],
        location_id=main["id"], reference_type="stock_issue",
    )
    assert all(m.get("reference_type") == "stock_issue" for m in by_ref)
