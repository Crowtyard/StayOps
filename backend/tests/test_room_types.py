# -*- coding: utf-8 -*-
"""房型 CRUD 测试。"""

from decimal import Decimal


def test_list_seeded_room_types(client, admin_headers):
    resp = client.get(
        "/api/v1/room-types", params={"page_size": 100}, headers=admin_headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 6
    by_name = {r["name"]: r for r in body["items"]}
    assert set(by_name) == {
        "标准大床房",
        "标准双床房",
        "豪华大床房",
        "豪华双床房",
        "豪华套房",
        "行政套房",
    }
    # 种子：101-104 为标准大床房
    assert by_name["标准大床房"]["room_count"] == 4
    assert Decimal(by_name["标准大床房"]["base_price"]) == Decimal("328.00")


def test_create_room_type(client, admin_headers):
    resp = client.post(
        "/api/v1/room-types",
        json={"name": "家庭房", "base_price": "388.00", "capacity": 3},
        headers=admin_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["name"] == "家庭房"
    assert Decimal(body["base_price"]) == Decimal("388.00")
    assert body["capacity"] == 3
    assert body["room_count"] == 0


def test_create_duplicate_room_type_409(client, admin_headers):
    resp = client.post(
        "/api/v1/room-types",
        json={"name": "标准大床房", "base_price": "328.00", "capacity": 2},
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "房型名已存在"


def test_create_invalid_price_422(client, admin_headers):
    resp = client.post(
        "/api/v1/room-types",
        json={"name": "负价房", "base_price": "-1.00", "capacity": 2},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_get_room_type_404(client, admin_headers):
    assert client.get("/api/v1/room-types/99999", headers=admin_headers).status_code == 404


def test_update_room_type(client, admin_headers):
    created = client.post(
        "/api/v1/room-types",
        json={"name": "待改房型", "base_price": "100.00", "capacity": 1},
        headers=admin_headers,
    ).json()
    resp = client.put(
        f"/api/v1/room-types/{created['id']}",
        json={"base_price": "120.50", "capacity": 2},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert Decimal(resp.json()["base_price"]) == Decimal("120.50")
    assert resp.json()["capacity"] == 2


def test_delete_room_type_without_rooms(client, admin_headers):
    created = client.post(
        "/api/v1/room-types",
        json={"name": "待删房型", "base_price": "100.00", "capacity": 1},
        headers=admin_headers,
    ).json()
    resp = client.delete(f"/api/v1/room-types/{created['id']}", headers=admin_headers)
    assert resp.status_code == 204
    assert (
        client.get(f"/api/v1/room-types/{created['id']}", headers=admin_headers).status_code
        == 404
    )


def test_delete_room_type_with_rooms_409(client, admin_headers):
    std_id = next(
        r["id"]
        for r in client.get(
            "/api/v1/room-types", params={"page_size": 100}, headers=admin_headers
        ).json()["items"]
        if r["name"] == "标准大床房"
    )
    resp = client.delete(f"/api/v1/room-types/{std_id}", headers=admin_headers)
    assert resp.status_code == 409


def test_room_types_require_permission(client, make_user, token_for):
    make_user("hk_rt", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('hk_rt')}"}
    assert client.get("/api/v1/room-types", headers=h).status_code == 403
    assert client.post("/api/v1/room-types", json={}, headers=h).status_code == 403
