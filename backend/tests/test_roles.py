# -*- coding: utf-8 -*-
"""角色 CRUD + 权限分配测试。"""


SEEDED_ROLES = {
    "SUPER_ADMIN",
    "MANAGER",
    "FRONT_DESK",
    "HOUSEKEEPING",
    "MAINTENANCE",
    "FINANCE",
}


def test_list_seeded_roles(client, admin_headers):
    resp = client.get("/api/v1/roles", params={"page_size": 100}, headers=admin_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 6
    assert {r["name"] for r in body["items"]} == SEEDED_ROLES
    # SUPER_ADMIN 拥有全部 36 个权限（17 基线 + 9 Booking + 5 Housekeeping + 5 Maintenance）
    super_admin = next(r for r in body["items"] if r["name"] == "SUPER_ADMIN")
    assert len(super_admin["permissions"]) == 36


def test_create_and_get_role(client, admin_headers):
    resp = client.post(
        "/api/v1/roles",
        json={"name": "夜班前台", "description": "夜间值班"},
        headers=admin_headers,
    )
    assert resp.status_code == 201
    role_id = resp.json()["id"]
    get_resp = client.get(f"/api/v1/roles/{role_id}", headers=admin_headers)
    assert get_resp.status_code == 200
    assert get_resp.json()["name"] == "夜班前台"
    assert get_resp.json()["permissions"] == []


def test_create_duplicate_role_409(client, admin_headers):
    resp = client.post(
        "/api/v1/roles", json={"name": "MANAGER"}, headers=admin_headers
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "角色名已存在"


def test_update_role(client, admin_headers):
    created = client.post(
        "/api/v1/roles", json={"name": "待改名"}, headers=admin_headers
    ).json()
    resp = client.put(
        f"/api/v1/roles/{created['id']}",
        json={"name": "已改名", "description": "新描述"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "已改名"
    assert resp.json()["description"] == "新描述"


def test_delete_role_and_cascade_user_roles(client, admin_headers, make_user):
    created = client.post(
        "/api/v1/roles", json={"name": "临时角色"}, headers=admin_headers
    ).json()
    user = make_user("role_user1", role_names=["临时角色"])
    # 确认角色已分配
    detail = client.get(f"/api/v1/users/{user['id']}", headers=admin_headers).json()
    assert [r["name"] for r in detail["roles"]] == ["临时角色"]
    # 删除角色（级联清理 user_roles）
    resp = client.delete(f"/api/v1/roles/{created['id']}", headers=admin_headers)
    assert resp.status_code == 204
    assert (
        client.get(f"/api/v1/roles/{created['id']}", headers=admin_headers).status_code
        == 404
    )
    after = client.get(f"/api/v1/users/{user['id']}", headers=admin_headers).json()
    assert after["roles"] == []


def test_set_permissions_replace(client, admin_headers):
    created = client.post(
        "/api/v1/roles", json={"name": "权限测试角色"}, headers=admin_headers
    ).json()
    perms = client.get(
        "/api/v1/permissions", params={"page_size": 100}, headers=admin_headers
    ).json()["items"]
    ids = {p["code"]: p["id"] for p in perms}
    resp = client.post(
        f"/api/v1/roles/{created['id']}/permissions",
        json={"permission_ids": [ids["room:read"], ids["audit:read"]]},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    codes = {p["code"] for p in resp.json()["permissions"]}
    assert codes == {"room:read", "audit:read"}
    # 整体替换：清空
    cleared = client.post(
        f"/api/v1/roles/{created['id']}/permissions",
        json={"permission_ids": []},
        headers=admin_headers,
    )
    assert cleared.status_code == 200
    assert cleared.json()["permissions"] == []


def test_set_permissions_missing_404(client, admin_headers):
    created = client.post(
        "/api/v1/roles", json={"name": "坏权限角色"}, headers=admin_headers
    ).json()
    resp = client.post(
        f"/api/v1/roles/{created['id']}/permissions",
        json={"permission_ids": [99999]},
        headers=admin_headers,
    )
    assert resp.status_code == 404


def test_role_permissions_affect_user(client, admin_headers, make_user, token_for):
    """给角色分配权限后，持有该角色的用户立即获得权限。"""
    created = client.post(
        "/api/v1/roles", json={"name": "只读房型角色"}, headers=admin_headers
    ).json()
    room_type_read_id = next(
        p["id"]
        for p in client.get(
            "/api/v1/permissions", params={"page_size": 100}, headers=admin_headers
        ).json()["items"]
        if p["code"] == "room_type:read"
    )
    client.post(
        f"/api/v1/roles/{created['id']}/permissions",
        json={"permission_ids": [room_type_read_id]},
        headers=admin_headers,
    )
    make_user("rt_reader", role_names=["只读房型角色"])
    h = {"Authorization": f"Bearer {token_for('rt_reader')}"}
    assert client.get("/api/v1/room-types", headers=h).status_code == 200
    assert client.get("/api/v1/rooms", headers=h).status_code == 403


def test_roles_require_role_read_permission(client, make_user, token_for):
    make_user("hk_roles", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('hk_roles')}"}
    assert client.get("/api/v1/roles", headers=h).status_code == 403
    assert client.get("/api/v1/permissions", headers=h).status_code == 403
    assert client.post("/api/v1/roles", json={}, headers=h).status_code == 403
