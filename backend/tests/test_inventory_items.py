# -*- coding: utf-8 -*-
"""Inventory Item / Location / Initial Stock 测试（Sprint 7 §3/§5/§6/§10）。"""

from decimal import Decimal

from tests.inventory_helpers import (
    create_item,
    get_item,
    initial_stock,
    issue,
    list_items,
    list_locations,
    location_by_code,
    patch_item,
)

Q = Decimal  # 数量字段统一用 Decimal 比较（Pydantic 序列化不保留小数尾零）


def test_item_create_and_duplicate_code(client, admin_headers):
    item = create_item(
        client, admin_headers, code="ITM-CREATE-001", name="矿泉水",
        category="GUEST_AMENITY", base_unit="瓶", minimum="10", target="50",
    )
    assert item["item_code"] == "ITM-CREATE-001"
    assert item["category"] == "GUEST_AMENITY"
    assert Q(item["minimum_stock"]) == Q("10")
    assert item["is_active"] is True
    # item_code 唯一：重复创建 409
    create_item(
        client, admin_headers, code="ITM-CREATE-001", expect=409
    )


def test_item_create_target_below_minimum_422(client, admin_headers):
    # target_stock < minimum_stock -> 422（schema + DB CHECK 双保险）
    resp = client.post(
        "/api/v1/inventory/items",
        json={
            "item_code": "ITM-BAD-001",
            "name": "坏数据",
            "category": "OTHER",
            "base_unit": "个",
            "minimum_stock": "50",
            "target_stock": "10",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text


def test_item_patch_strict_and_immutable_code(client, admin_headers):
    item = create_item(client, admin_headers, code="ITM-PATCH-001")

    # item_code 不可修改：PATCH 携带 item_code -> 422（strict schema）
    resp = client.patch(
        f"/api/v1/inventory/items/{item['id']}",
        json={"item_code": "NEW-CODE"},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 未知字段 -> 422
    resp = client.patch(
        f"/api/v1/inventory/items/{item['id']}",
        json={"quantity": 5},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 空 payload -> 422
    resp = client.patch(
        f"/api/v1/inventory/items/{item['id']}",
        json={},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text

    updated = patch_item(
        client, admin_headers, item["id"],
        {"name": "新名称", "minimum_stock": "5", "target_stock": "30"},
    )
    assert updated["name"] == "新名称"
    assert Q(updated["minimum_stock"]) == Q("5")
    assert Q(updated["target_stock"]) == Q("30")


def test_item_patch_minimum_target_pair_validation(client, admin_headers):
    item = create_item(
        client, admin_headers, code="ITM-PAIR-001",
        minimum="10", target="20",
    )
    # 只改 minimum 超过 target -> 422
    patch_item(
        client, admin_headers, item["id"], {"minimum_stock": "50"}, expect=422
    )
    # 只改 target 低于 minimum -> 422
    patch_item(
        client, admin_headers, item["id"], {"target_stock": "5"}, expect=422
    )
    # 同时修改使 target >= minimum -> 200
    patch_item(
        client, admin_headers, item["id"],
        {"minimum_stock": "0", "target_stock": "40"},
    )


def test_item_base_unit_immutable_after_movement(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(
        client, admin_headers, code="ITM-UNIT-001", base_unit="瓶"
    )
    # 无流水时可改基础单位
    patch_item(client, admin_headers, item["id"], {"base_unit": "箱"})
    assert get_item(client, admin_headers, item["id"])["base_unit"] == "箱"
    # 产生 INITIAL 流水后不可改（账本语义保护）
    initial_stock(client, admin_headers, item["id"], main["id"], "10")
    patch_item(
        client, admin_headers, item["id"], {"base_unit": "瓶"}, expect=409
    )


def test_item_deactivate(client, admin_headers):
    item = create_item(client, admin_headers, code="ITM-DEACT-001")
    patch_item(client, admin_headers, item["id"], {"is_active": False})
    assert get_item(client, admin_headers, item["id"])["is_active"] is False
    # is_active=false 过滤
    active_rows = list_items(
        client, admin_headers, {"is_active": "true"}
    )["items"]
    assert all(r["id"] != item["id"] for r in active_rows)


def test_locations_seed_and_patch(client, admin_headers):
    locations = list_locations(client, admin_headers)
    codes = {loc["location_code"] for loc in locations}
    assert {"MAIN_STORAGE", "FRONT_DESK", "HOUSEKEEPING", "MAINTENANCE"} <= codes

    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    assert main["name"] == "总仓"

    # PATCH 改名 + 停用
    resp = client.patch(
        f"/api/v1/inventory/locations/{main['id']}",
        json={"name": "总仓（一层）", "is_active": False},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "总仓（一层）"
    assert resp.json()["is_active"] is False
    # 恢复激活（避免影响其它用例按 code 查找）
    client.patch(
        f"/api/v1/inventory/locations/{main['id']}",
        json={"name": "总仓", "is_active": True},
        headers=admin_headers,
    )

    # 空 payload -> 422；不存在 -> 404
    assert client.patch(
        f"/api/v1/inventory/locations/{main['id']}",
        json={}, headers=admin_headers,
    ).status_code == 422
    assert client.patch(
        "/api/v1/inventory/locations/999999",
        json={"name": "x"}, headers=admin_headers,
    ).status_code == 404


def test_initial_stock_creates_initial_movement(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    front = location_by_code(client, admin_headers, "FRONT_DESK")
    item = create_item(client, admin_headers, code="ITM-INIT-001")

    result = initial_stock(
        client, admin_headers, item["id"], main["id"], "30", reason="开业盘点"
    )
    assert result["movement_no"].startswith("SMV")
    assert Q(result["balance_quantity"]) == Q("30")

    detail = get_item(client, admin_headers, item["id"])
    assert Q(detail["total_stock"]) == Q("30")
    assert len(detail["recent_movements"]) == 1
    movement = detail["recent_movements"][0]
    assert movement["movement_type"] == "INITIAL"
    assert Q(movement["quantity"]) == Q("30")
    assert movement["location_id"] == main["id"]
    assert movement["reason"] == "开业盘点"

    # 再次期初：累加（每次期初都是真实业务动作）
    initial_stock(
        client, admin_headers, item["id"], main["id"], "10", reason="补录"
    )
    assert Q(get_item(client, admin_headers, item["id"])["total_stock"]) == Q("40")

    # 期初数量为 0 合法（INITIAL >= 0）
    initial_stock(client, admin_headers, item["id"], front["id"], "0")
    # 负数 -> 422
    resp = client.post(
        f"/api/v1/inventory/items/{item['id']}/initial-stock",
        json={"location_id": main["id"], "quantity": "-1"},
        headers=admin_headers,
    )
    assert resp.status_code == 422, resp.text
    # 不存在的物资 -> 404；不存在的地点 -> 404
    assert client.post(
        "/api/v1/inventory/items/999999/initial-stock",
        json={"location_id": main["id"], "quantity": "1"},
        headers=admin_headers,
    ).status_code == 404
    assert client.post(
        f"/api/v1/inventory/items/{item['id']}/initial-stock",
        json={"location_id": 999999, "quantity": "1"},
        headers=admin_headers,
    ).status_code == 404


def test_item_list_filters_and_status(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(
        client, admin_headers, code="ITM-LIST-001", name="浴帽",
        category="GUEST_AMENITY", base_unit="个", minimum="20", target="100",
    )
    initial_stock(client, admin_headers, item["id"], main["id"], "30")

    rows = list_items(client, admin_headers)["items"]
    row = next(r for r in rows if r["id"] == item["id"])
    assert Q(row["total_stock"]) == Q("30")
    # 30 > minimum 20 -> NORMAL（§19：total <= minimum 才是 LOW）
    assert row["stock_status"] == "NORMAL"
    assert Q(row["recommended_replenishment"]) == Q("70")

    # search（code/name）
    assert len(list_items(client, admin_headers, {"search": "ITM-LIST-001"})["items"]) == 1
    assert len(list_items(client, admin_headers, {"search": "浴帽"})["items"]) == 1
    # category 过滤
    rows = list_items(
        client, admin_headers, {"category": "GUEST_AMENITY"}
    )["items"]
    assert all(r["category"] == "GUEST_AMENITY" for r in rows)
    # stock_status 过滤
    low_rows = list_items(
        client, admin_headers, {"stock_status": "LOW_STOCK"}
    )["items"]
    assert all(r["stock_status"] == "LOW_STOCK" for r in low_rows)
    out_rows = list_items(
        client, admin_headers, {"stock_status": "OUT_OF_STOCK"}
    )["items"]
    assert all(r["stock_status"] == "OUT_OF_STOCK" for r in out_rows)

    # 领用 15 -> total 15 <= minimum 20 -> LOW_STOCK
    issue(
        client, admin_headers, main["id"],
        [{"item_id": item["id"], "quantity": "15"}],
    )
    row = next(
        r for r in list_items(client, admin_headers)["items"]
        if r["id"] == item["id"]
    )
    assert Q(row["total_stock"]) == Q("15")
    assert row["stock_status"] == "LOW_STOCK"
    assert Q(row["recommended_replenishment"]) == Q("85")

    # 领用到 0 -> OUT_OF_STOCK
    issue(
        client, admin_headers, main["id"],
        [{"item_id": item["id"], "quantity": "15"}],
    )
    row = next(
        r for r in list_items(client, admin_headers)["items"]
        if r["id"] == item["id"]
    )
    assert Q(row["total_stock"]) == Q("0")
    assert row["stock_status"] == "OUT_OF_STOCK"


def test_low_stock_semantics_zero_minimum(client, admin_headers):
    """minimum=0：只有 total=0 是 OUT_OF_STOCK，正库存保持 NORMAL（§19）。"""
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    item = create_item(
        client, admin_headers, code="ITM-ZMIN-001",
        minimum="0", target="0",
    )
    initial_stock(client, admin_headers, item["id"], main["id"], "1")

    def row():
        return next(
            r for r in list_items(client, admin_headers)["items"]
            if r["id"] == item["id"]
        )

    assert row()["stock_status"] == "NORMAL"
    issue(
        client, admin_headers, main["id"],
        [{"item_id": item["id"], "quantity": "1"}],
    )
    assert row()["stock_status"] == "OUT_OF_STOCK"


def test_item_detail_aggregates(client, admin_headers):
    main = location_by_code(client, admin_headers, "MAIN_STORAGE")
    front = location_by_code(client, admin_headers, "FRONT_DESK")
    item = create_item(
        client, admin_headers, code="ITM-DETAIL-001",
        minimum="20", target="50",
    )
    initial_stock(client, admin_headers, item["id"], main["id"], "10")
    initial_stock(client, admin_headers, item["id"], front["id"], "5")

    detail = get_item(client, admin_headers, item["id"])
    assert Q(detail["total_stock"]) == Q("15")
    # 15 <= minimum 20 -> LOW_STOCK；50 - 15 = 35
    assert detail["stock_status"] == "LOW_STOCK"
    assert Q(detail["recommended_replenishment"]) == Q("35")
    assert len(detail["balances"]) == 2
    assert len(detail["recent_movements"]) == 2
    by_location = {b["location_id"]: b for b in detail["balances"]}
    assert Q(by_location[main["id"]]["quantity"]) == Q("10")
    assert Q(by_location[front["id"]]["quantity"]) == Q("5")
    assert by_location[main["id"]]["location_active"] is True


def test_item_not_found(client, admin_headers):
    assert client.get(
        "/api/v1/inventory/items/999999", headers=admin_headers
    ).status_code == 404
    assert client.patch(
        "/api/v1/inventory/items/999999",
        json={"name": "x"}, headers=admin_headers,
    ).status_code == 404
