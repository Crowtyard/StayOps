# -*- coding: utf-8 -*-
"""RBAC 测试：无 token 401、Token 无效/过期 401、权限不足 403。"""

from datetime import datetime, timedelta, timezone

from jose import jwt

from app.config import settings


def test_protected_endpoints_require_token(client):
    for path in [
        "/api/v1/users",
        "/api/v1/roles",
        "/api/v1/permissions",
        "/api/v1/room-types",
        "/api/v1/rooms",
        "/api/v1/audit-logs",
    ]:
        resp = client.get(path)
        assert resp.status_code == 401, f"{path} 未返回 401"


def test_housekeeping_permissions(client, make_user, token_for):
    make_user("hk_rbac", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('hk_rbac')}"}
    assert client.get("/api/v1/users", headers=h).status_code == 403
    assert client.get("/api/v1/roles", headers=h).status_code == 403
    assert client.get("/api/v1/permissions", headers=h).status_code == 403
    assert client.get("/api/v1/room-types", headers=h).status_code == 403
    assert client.get("/api/v1/audit-logs", headers=h).status_code == 403
    assert client.get("/api/v1/rooms", headers=h).status_code == 200  # room:read


def test_front_desk_permissions(client, make_user, token_for):
    make_user("fd_rbac", role_names=["FRONT_DESK"])
    h = {"Authorization": f"Bearer {token_for('fd_rbac')}"}
    assert client.get("/api/v1/users", headers=h).status_code == 403
    assert client.post("/api/v1/users", json={}, headers=h).status_code == 403
    assert client.get("/api/v1/rooms", headers=h).status_code == 200
    assert client.get("/api/v1/room-types", headers=h).status_code == 200
    assert client.get("/api/v1/audit-logs", headers=h).status_code == 200


def test_finance_permissions(client, make_user, token_for):
    make_user("fin_rbac", role_names=["FINANCE"])
    h = {"Authorization": f"Bearer {token_for('fin_rbac')}"}
    assert client.get("/api/v1/audit-logs", headers=h).status_code == 200
    assert client.get("/api/v1/rooms", headers=h).status_code == 200
    assert client.get("/api/v1/users", headers=h).status_code == 403
    assert client.post("/api/v1/rooms", json={}, headers=h).status_code == 403


def test_write_endpoints_require_permission(client, make_user, token_for):
    make_user("hk_rbac2", role_names=["HOUSEKEEPING"])
    h = {"Authorization": f"Bearer {token_for('hk_rbac2')}"}
    assert client.post("/api/v1/users", json={}, headers=h).status_code == 403
    assert client.put("/api/v1/users/1", json={}, headers=h).status_code == 403
    assert client.delete("/api/v1/users/1", headers=h).status_code == 403
    assert (
        client.post("/api/v1/users/1/roles", json={"role_ids": []}, headers=h).status_code
        == 403
    )
    assert client.post("/api/v1/roles", json={}, headers=h).status_code == 403
    assert client.post("/api/v1/room-types", json={}, headers=h).status_code == 403
    assert client.post("/api/v1/rooms", json={}, headers=h).status_code == 403


def test_expired_token_401(client):
    token = jwt.encode(
        {
            "sub": "1",
            "exp": datetime.now(timezone.utc) - timedelta(hours=1),
        },
        settings.secret_key,
        algorithm=settings.jwt_algorithm,
    )
    resp = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 401


def test_inactive_user_token_rejected(client, admin_headers, make_user):
    """用户登录后被禁用：旧 Token 立即失效（403）。"""
    user = make_user("tobe_disabled", role_names=["FINANCE"])
    token = client.post(
        "/api/v1/auth/login",
        json={"username": "tobe_disabled", "password": "User@123456"},
    ).json()["access_token"]
    assert (
        client.get(
            "/api/v1/rooms", headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 200
    )
    # 管理员禁用该用户
    resp = client.put(
        f"/api/v1/users/{user['id']}",
        json={"is_active": False},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert (
        client.get(
            "/api/v1/rooms", headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 403
    )
