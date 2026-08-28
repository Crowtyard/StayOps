# -*- coding: utf-8 -*-
"""任务书第 7 条冒烟：admin 登录 -> 列表 -> 创建 -> 改房态 -> 查 audit_logs。"""


def test_smoke_admin_full_flow(client):
    # 1) admin 登录
    login_resp = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "Admin@123456"},
    )
    assert login_resp.status_code == 200
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # 2) 当前用户 + 权限
    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["username"] == "admin"
    assert len(me.json()["permissions"]) == 48  # Sprint 7：37（S6）+ Inventory/Procurement 的 11

    # 3) 房间列表（种子 28 间）
    rooms = client.get("/api/v1/rooms", params={"page_size": 100}, headers=headers)
    assert rooms.status_code == 200
    assert rooms.json()["total"] == 28

    # 4) 创建房型 + 创建房间
    rt = client.post(
        "/api/v1/room-types",
        json={"name": "冒烟测试房型", "base_price": "399.00", "capacity": 2},
        headers=headers,
    )
    assert rt.status_code == 201
    room = client.post(
        "/api/v1/rooms",
        json={"room_number": "999", "room_type_id": rt.json()["id"], "floor": 9},
        headers=headers,
    )
    assert room.status_code == 201
    room_id = room.json()["id"]
    assert room.json()["occupancy_status"] == "available"
    assert room.json()["cleaning_status"] == "clean"

    # 5) 房态变更（合法转换：入住 + 脏）
    status_resp = client.post(
        f"/api/v1/rooms/{room_id}/status",
        json={"occupancy_status": "occupied", "cleaning_status": "dirty"},
        headers=headers,
    )
    assert status_resp.status_code == 200
    assert status_resp.json()["occupancy_status"] == "occupied"
    assert status_resp.json()["cleaning_status"] == "dirty"

    # 6) audit_logs 出现房态变更记录
    logs = client.get(
        "/api/v1/audit-logs",
        params={"action": "room.status_change", "page_size": 100},
        headers=headers,
    )
    assert logs.status_code == 200
    items = logs.json()["items"]
    matched = [
        x
        for x in items
        if x["resource_id"] == room_id
        and x["details"]
        == {
            "occupancy_status": {"from": "available", "to": "occupied"},
            "cleaning_status": {"from": "clean", "to": "dirty"},
        }
    ]
    assert len(matched) == 1
    assert matched[0]["username"] == "admin"
    assert matched[0]["ip"] == "testclient"
