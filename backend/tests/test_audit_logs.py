# -*- coding: utf-8 -*-
"""审计日志测试：写操作落库、列表分页、按操作/用户筛选、权限、IP。"""


def _write_some(client, headers):
    """产生三类写操作：创建用户、创建房型、房态变更。"""
    client.post(
        "/api/v1/users",
        json={"username": "audit_u1", "password": "Pass@123456"},
        headers=headers,
    )
    client.post(
        "/api/v1/room-types",
        json={"name": "审计房型", "base_price": "100.00", "capacity": 1},
        headers=headers,
    )
    rooms = client.get(
        "/api/v1/rooms", params={"page_size": 100}, headers=headers
    ).json()["items"]
    room = next(r for r in rooms if r["room_number"] == "203")
    client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "occupied", "cleaning_status": "dirty"},
        headers=headers,
    )


def test_writes_recorded_and_listed(client, admin_headers):
    _write_some(client, admin_headers)
    resp = client.get(
        "/api/v1/audit-logs", params={"page_size": 100}, headers=admin_headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert {"items", "total", "page", "page_size"} == set(body.keys())
    actions = {x["action"] for x in body["items"]}
    assert {"user.create", "room_type.create", "room.status_change"} <= actions


def test_filter_by_action(client, admin_headers):
    _write_some(client, admin_headers)
    resp = client.get(
        "/api/v1/audit-logs", params={"action": "user.create"}, headers=admin_headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["action"] == "user.create"
    assert body["items"][0]["resource_type"] == "user"


def test_filter_by_user_id(client, admin_headers, make_user, token_for):
    admin_id = client.get("/api/v1/auth/me", headers=admin_headers).json()["id"]
    make_user("audit_hk", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('audit_hk')}"}
    rooms = client.get(
        "/api/v1/rooms", params={"page_size": 100}, headers=admin_headers
    ).json()["items"]
    room = next(r for r in rooms if r["room_number"] == "204")
    # 先由 admin 置 dirty，保洁才能执行 cleaning（状态机：dirty -> cleaning）
    client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"cleaning_status": "dirty"},
        headers=admin_headers,
    )
    assert (
        client.post(
            f"/api/v1/rooms/{room['id']}/status",
            json={"cleaning_status": "cleaning"},
            headers=h,
        ).status_code
        == 200
    )
    hk_id = client.get("/api/v1/auth/me", headers=h).json()["id"]
    # 按保洁用户筛选：只有保洁的操作
    resp = client.get(
        "/api/v1/audit-logs", params={"user_id": hk_id}, headers=admin_headers
    )
    assert resp.status_code == 200
    assert all(x["user_id"] == hk_id for x in resp.json()["items"])
    assert any(
        x["action"] == "room.status_change" for x in resp.json()["items"]
    )
    # 按 admin 筛选：不含保洁的记录
    admin_rows = client.get(
        "/api/v1/audit-logs", params={"user_id": admin_id}, headers=admin_headers
    ).json()["items"]
    assert all(x["user_id"] == admin_id for x in admin_rows)


def test_pagination(client, admin_headers):
    _write_some(client, admin_headers)
    page1 = client.get(
        "/api/v1/audit-logs", params={"page": 1, "page_size": 2}, headers=admin_headers
    ).json()
    assert len(page1["items"]) == 2
    assert page1["total"] >= 3
    page2 = client.get(
        "/api/v1/audit-logs", params={"page": 2, "page_size": 2}, headers=admin_headers
    ).json()
    assert len(page2["items"]) == 2
    # 分页不重叠
    ids1 = {x["id"] for x in page1["items"]}
    ids2 = {x["id"] for x in page2["items"]}
    assert ids1.isdisjoint(ids2)


def test_ip_recorded(client, admin_headers):
    _write_some(client, admin_headers)
    items = client.get(
        "/api/v1/audit-logs", params={"page_size": 100}, headers=admin_headers
    ).json()["items"]
    assert items
    assert all(x["ip"] == "testclient" for x in items)


def test_details_are_json(client, admin_headers):
    _write_some(client, admin_headers)
    items = client.get(
        "/api/v1/audit-logs",
        params={"action": "room.status_change"},
        headers=admin_headers,
    ).json()["items"]
    assert len(items) == 1
    assert items[0]["details"] == {
        "occupancy_status": {"from": "available", "to": "occupied"},
        "cleaning_status": {"from": "clean", "to": "dirty"},
    }
    assert items[0]["username"] == "admin"


def test_audit_requires_permission(client, make_user, token_for):
    make_user("hk_audit", role_names=["HOUSEKEEPING"])
    assert (
        client.get(
            "/api/v1/audit-logs",
            headers={"Authorization": f"Bearer {token_for('hk_audit')}"},
        ).status_code
        == 403
    )
    make_user("fin_audit", role_names=["FINANCE"])
    assert (
        client.get(
            "/api/v1/audit-logs",
            headers={"Authorization": f"Bearer {token_for('fin_audit')}"},
        ).status_code
        == 200
    )


def test_audit_log_survives_user_delete(client, admin_headers):
    """删除用户后，其历史审计记录 user_id 置空（SET NULL），记录仍可查。"""
    created = client.post(
        "/api/v1/users",
        json={"username": "audit_gone", "password": "Pass@123456"},
        headers=admin_headers,
    ).json()
    client.delete(f"/api/v1/users/{created['id']}", headers=admin_headers)
    rows = client.get(
        "/api/v1/audit-logs",
        params={"action": "user.create", "page_size": 100},
        headers=admin_headers,
    ).json()["items"]
    mine = next(r for r in rows if r["resource_id"] == created["id"])
    assert mine["user_id"] == client.get("/api/v1/auth/me", headers=admin_headers).json()[
        "id"
    ]
    # user.create 记录本身 user_id 是操作人（admin），不受影响；
    # 被删用户的登录记录若存在，user_id 会置空（本用例未登录，仅验证删除不丢记录）
    assert mine["action"] == "user.create"
