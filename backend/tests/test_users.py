# -*- coding: utf-8 -*-
"""用户 CRUD + 分配角色测试。"""


def test_create_user(client, admin_headers):
    resp = client.post(
        "/api/v1/users",
        json={
            "username": "u1",
            "password": "Pass@123456",
            "display_name": "用户一",
        },
        headers=admin_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["username"] == "u1"
    assert body["display_name"] == "用户一"
    assert body["is_active"] is True
    assert body["roles"] == []
    assert "password" not in body and "password_hash" not in body


def test_create_duplicate_username_409(client, admin_headers):
    payload = {"username": "dup1", "password": "Pass@123456"}
    assert client.post("/api/v1/users", json=payload, headers=admin_headers).status_code == 201
    resp = client.post("/api/v1/users", json=payload, headers=admin_headers)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "用户名已存在"


def test_create_short_password_422(client, admin_headers):
    resp = client.post(
        "/api/v1/users",
        json={"username": "shortpw", "password": "123"},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_list_users_pagination(client, admin_headers, make_user):
    make_user("u2")
    make_user("u3")
    resp = client.get(
        "/api/v1/users", params={"page": 1, "page_size": 2}, headers=admin_headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["page"] == 1
    assert body["page_size"] == 2
    assert body["total"] == 3  # admin + u2 + u3
    assert len(body["items"]) == 2
    page2 = client.get(
        "/api/v1/users", params={"page": 2, "page_size": 2}, headers=admin_headers
    ).json()
    assert len(page2["items"]) == 1


def test_get_user_and_404(client, admin_headers, make_user):
    user = make_user("u4")
    resp = client.get(f"/api/v1/users/{user['id']}", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["username"] == "u4"
    assert client.get("/api/v1/users/99999", headers=admin_headers).status_code == 404


def test_update_user(client, admin_headers, make_user):
    user = make_user("u5")
    resp = client.put(
        f"/api/v1/users/{user['id']}",
        json={"display_name": "新名字", "phone": "13800000000"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["display_name"] == "新名字"
    assert body["phone"] == "13800000000"


def test_update_password_then_login(client, admin_headers, make_user):
    user = make_user("u5b")
    resp = client.put(
        f"/api/v1/users/{user['id']}",
        json={"password": "NewPass@123"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    ok = client.post(
        "/api/v1/auth/login",
        json={"username": "u5b", "password": "NewPass@123"},
    )
    assert ok.status_code == 200
    bad = client.post(
        "/api/v1/auth/login",
        json={"username": "u5b", "password": "User@123456"},
    )
    assert bad.status_code == 401


def test_update_username_conflict_409(client, admin_headers, make_user):
    make_user("u6")
    other = make_user("u6b")
    resp = client.put(
        f"/api/v1/users/{other['id']}",
        json={"username": "u6"},
        headers=admin_headers,
    )
    assert resp.status_code == 409


def test_delete_user(client, admin_headers, make_user):
    user = make_user("u7")
    resp = client.delete(f"/api/v1/users/{user['id']}", headers=admin_headers)
    assert resp.status_code == 204
    assert client.get(f"/api/v1/users/{user['id']}", headers=admin_headers).status_code == 404
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "u7", "password": "User@123456"},
    )
    assert login.status_code == 401


def test_delete_self_forbidden(client, admin_headers):
    me = client.get("/api/v1/auth/me", headers=admin_headers).json()
    resp = client.delete(f"/api/v1/users/{me['id']}", headers=admin_headers)
    assert resp.status_code == 400


def test_disable_self_forbidden(client, admin_headers):
    me = client.get("/api/v1/auth/me", headers=admin_headers).json()
    resp = client.put(
        f"/api/v1/users/{me['id']}", json={"is_active": False}, headers=admin_headers
    )
    assert resp.status_code == 400


def test_assign_roles_and_effect(client, admin_headers, make_user, token_for):
    user = make_user("u8")
    manager_id = next(
        r["id"]
        for r in client.get(
            "/api/v1/roles", params={"page_size": 100}, headers=admin_headers
        ).json()["items"]
        if r["name"] == "MANAGER"
    )
    resp = client.post(
        f"/api/v1/users/{user['id']}/roles",
        json={"role_ids": [manager_id]},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    roles = resp.json()["roles"]
    assert [r["name"] for r in roles] == ["MANAGER"]
    # 登录后权限生效：MANAGER 有 room:write / audit:read，无 role:write
    me = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token_for('u8')}"}
    ).json()
    codes = set(me["permissions"])
    assert "room:write" in codes
    assert "audit:read" in codes
    assert "role:write" not in codes


def test_assign_roles_missing_role_404(client, admin_headers, make_user):
    user = make_user("u9")
    resp = client.post(
        f"/api/v1/users/{user['id']}/roles",
        json={"role_ids": [99999]},
        headers=admin_headers,
    )
    assert resp.status_code == 404


def test_assign_empty_roles_clears(client, admin_headers, make_user):
    user = make_user("u10", role_names=["FINANCE"])
    resp = client.post(
        f"/api/v1/users/{user['id']}/roles",
        json={"role_ids": []},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["roles"] == []
