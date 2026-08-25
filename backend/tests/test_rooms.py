# -*- coding: utf-8 -*-
"""房间 CRUD + 分页/筛选测试（房态转换见 test_room_status.py）。"""


def _std_room_type_id(client, headers) -> int:
    return next(
        r["id"]
        for r in client.get(
            "/api/v1/room-types", params={"page_size": 100}, headers=headers
        ).json()["items"]
        if r["name"] == "标准大床房"
    )


def _find_room(client, headers, room_number: str) -> dict:
    rooms = client.get(
        "/api/v1/rooms", params={"page_size": 100}, headers=headers
    ).json()["items"]
    return next(r for r in rooms if r["room_number"] == room_number)


def test_list_rooms_pagination(client, admin_headers):
    resp = client.get(
        "/api/v1/rooms", params={"page": 1, "page_size": 10}, headers=admin_headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 28
    assert body["page"] == 1
    assert body["page_size"] == 10
    assert len(body["items"]) == 10
    assert {"items", "total", "page", "page_size"} == set(body.keys())
    # 房间响应内嵌房型摘要
    assert body["items"][0]["room_type"]["name"]


def test_list_rooms_status_filter(client, admin_headers):
    """按占用/清洁双维度筛选。"""
    room = _find_room(client, admin_headers, "101")
    assert room["occupancy_status"] == "available"
    assert room["cleaning_status"] == "clean"
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "occupied", "cleaning_status": "dirty"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    occupied = client.get(
        "/api/v1/rooms",
        params={"occupancy_status": "occupied"},
        headers=admin_headers,
    ).json()
    assert occupied["total"] == 1
    assert all(r["occupancy_status"] == "occupied" for r in occupied["items"])
    dirty = client.get(
        "/api/v1/rooms",
        params={"cleaning_status": "dirty"},
        headers=admin_headers,
    ).json()
    assert dirty["total"] == 1
    available = client.get(
        "/api/v1/rooms",
        params={"occupancy_status": "available"},
        headers=admin_headers,
    ).json()
    assert available["total"] == 27


def test_list_rooms_room_type_filter(client, admin_headers):
    std_id = _std_room_type_id(client, admin_headers)
    resp = client.get(
        "/api/v1/rooms",
        params={"room_type_id": std_id, "page_size": 100},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 4  # 种子：101-104
    assert {r["room_number"] for r in body["items"]} == {"101", "102", "103", "104"}


def test_create_room(client, admin_headers):
    std_id = _std_room_type_id(client, admin_headers)
    resp = client.post(
        "/api/v1/rooms",
        json={"room_number": "901", "room_type_id": std_id, "floor": 9},
        headers=admin_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["room_number"] == "901"
    assert body["floor"] == 9
    assert body["occupancy_status"] == "available"  # 默认占用状态
    assert body["cleaning_status"] == "clean"  # 默认清洁状态
    assert body["room_type"]["id"] == std_id


def test_create_room_with_status(client, admin_headers):
    std_id = _std_room_type_id(client, admin_headers)
    resp = client.post(
        "/api/v1/rooms",
        json={
            "room_number": "902",
            "room_type_id": std_id,
            "floor": 9,
            "occupancy_status": "blocked",
            "cleaning_status": "dirty",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 201
    assert resp.json()["occupancy_status"] == "blocked"
    assert resp.json()["cleaning_status"] == "dirty"


def test_create_duplicate_room_number_409(client, admin_headers):
    std_id = _std_room_type_id(client, admin_headers)
    resp = client.post(
        "/api/v1/rooms",
        json={"room_number": "101", "room_type_id": std_id, "floor": 1},
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "房间号已存在"


def test_create_bad_room_type_404(client, admin_headers):
    resp = client.post(
        "/api/v1/rooms",
        json={"room_number": "903", "room_type_id": 99999, "floor": 9},
        headers=admin_headers,
    )
    assert resp.status_code == 404


def test_get_room_404(client, admin_headers):
    assert client.get("/api/v1/rooms/99999", headers=admin_headers).status_code == 404


def test_update_room_ignores_status(client, admin_headers):
    room = _find_room(client, admin_headers, "102")
    resp = client.put(
        f"/api/v1/rooms/{room['id']}",
        json={"floor": 2, "notes": "测试备注", "status": "occupied"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["floor"] == 2
    assert body["notes"] == "测试备注"
    # 状态字段不接收；房态只能走状态机接口
    assert body["occupancy_status"] == "available"


def test_update_room_number_conflict_409(client, admin_headers):
    room = _find_room(client, admin_headers, "103")
    resp = client.put(
        f"/api/v1/rooms/{room['id']}",
        json={"room_number": "104"},
        headers=admin_headers,
    )
    assert resp.status_code == 409


def test_delete_room(client, admin_headers):
    std_id = _std_room_type_id(client, admin_headers)
    created = client.post(
        "/api/v1/rooms",
        json={"room_number": "904", "room_type_id": std_id, "floor": 9},
        headers=admin_headers,
    ).json()
    resp = client.delete(f"/api/v1/rooms/{created['id']}", headers=admin_headers)
    assert resp.status_code == 204
    assert client.get(f"/api/v1/rooms/{created['id']}", headers=admin_headers).status_code == 404


def test_rooms_require_permission(client, make_user, token_for):
    make_user("fin_rooms", role_names=["FINANCE"])  # room:read 无 room:write/delete
    h = {"Authorization": f"Bearer {token_for('fin_rooms')}"}
    assert client.get("/api/v1/rooms", headers=h).status_code == 200
    assert client.post("/api/v1/rooms", json={}, headers=h).status_code == 403
    assert client.put("/api/v1/rooms/1", json={}, headers=h).status_code == 403
    assert client.delete("/api/v1/rooms/1", headers=h).status_code == 403
