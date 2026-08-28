# -*- coding: utf-8 -*-
"""认证测试：登录成功/密码错误/未知用户/禁用用户、/auth/me、401、登录审计。"""

from sqlalchemy import select

from app.models import AuditLog


def test_login_success(client):
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "Admin@123456"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["access_token"]
    assert body["token_type"] == "bearer"
    assert body["expires_in"] > 0


def test_login_wrong_password(client):
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "Wrong@123456"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "用户名或密码错误"


def test_login_unknown_user(client):
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": "nobody", "password": "Whatever@123"},
    )
    assert resp.status_code == 401


def test_login_inactive_user(client, make_user):
    make_user("inactive1", is_active=False)
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": "inactive1", "password": "User@123456"},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "账号已禁用"


def test_me_returns_profile_and_permissions(client, admin_token):
    resp = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["username"] == "admin"
    assert body["is_active"] is True
    assert any(r["name"] == "SUPER_ADMIN" for r in body["roles"])
    codes = set(body["permissions"])
    for code in [
        "user:read",
        "user:write",
        "user:delete",
        "role:read",
        "role:write",
        "role:delete",
        "room:read",
        "room:write",
        "room:delete",
        "room:status_cleaning",
        "room:status_maintenance",
        "room_type:read",
        "room_type:write",
        "room_type:delete",
        "audit:read",
    ]:
        assert code in codes, f"缺少权限 {code}"
    assert len(codes) == 36  # SUPER_ADMIN = 全部权限（17 基线 + 9 Booking + 5 Housekeeping + 5 Maintenance）


def test_me_without_token(client):
    resp = client.get("/api/v1/auth/me")
    assert resp.status_code == 401


def test_me_invalid_token(client):
    resp = client.get(
        "/api/v1/auth/me", headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert resp.status_code == 401


def test_me_wrong_scheme(client):
    resp = client.get(
        "/api/v1/auth/me", headers={"Authorization": "Basic dXNlcjpwYXNz"}
    )
    assert resp.status_code == 401


def test_login_failure_writes_audit(client, db):
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "Wrong@123456"},
    )
    assert resp.status_code == 401
    row = db.scalar(select(AuditLog).where(AuditLog.action == "login_failed"))
    assert row is not None
    assert row.details == {"username": "admin", "reason": "invalid_credentials"}
    assert row.ip == "testclient"
    assert row.user_id is None


def test_login_success_writes_audit(client, db):
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "Admin@123456"},
    )
    assert resp.status_code == 200
    rows = db.scalars(select(AuditLog).where(AuditLog.action == "login")).all()
    assert len(rows) == 1
    assert rows[0].details == {"username": "admin"}
    assert rows[0].ip == "testclient"
    assert rows[0].user_id is not None
