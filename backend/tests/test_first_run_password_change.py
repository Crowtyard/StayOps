# -*- coding: utf-8 -*-
"""D2 首次安装强制改密（alpha.9.4）行为测试。

覆盖：
- bootstrap 管理员（must_change_password=True）在改密前除白名单外一律 403；
- /auth/me 可读且返回 must_change_password=true（前端据此跳转改密页）；
- POST /auth/change-password 成功后清除标记，旧密码失效、新密码可登录；
- 非 bootstrap 用户（默认 false）行为完全不变（既有 646 用例的基线语义）。
"""

from sqlalchemy import select

from app.core.security import verify_password
from app.models import User
from tests.conftest import ADMIN_PASSWORD, ADMIN_USERNAME, auth_headers

NEW_PASSWORD = "StayOps-NewPass-2026!"


def _login(client, password: str):
    return client.post(
        "/api/v1/auth/login",
        json={"username": ADMIN_USERNAME, "password": password},
    )


def _set_flag(db, value: bool) -> None:
    admin = db.scalar(select(User).where(User.username == ADMIN_USERNAME))
    assert admin is not None
    admin.must_change_password = value
    db.flush()


def test_default_admin_does_not_require_change(client, admin_headers):
    """既有环境（非 bootstrap）默认不受影响。"""
    me = client.get("/api/v1/auth/me", headers=admin_headers)
    assert me.status_code == 200
    assert me.json()["must_change_password"] is False
    assert client.get("/api/v1/rooms", headers=admin_headers).status_code == 200


def test_bootstrap_admin_is_blocked_until_password_changed(client, db):
    _set_flag(db, True)
    login = _login(client, ADMIN_PASSWORD)
    assert login.status_code == 200
    headers = auth_headers(login.json()["access_token"])

    # /auth/me 白名单：可读，并且明确告知必须改密
    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["must_change_password"] is True

    # 其它业务接口被后端强制拒绝
    blocked = client.get("/api/v1/rooms", headers=headers)
    assert blocked.status_code == 403
    assert "必须先修改初始密码" in blocked.json()["detail"]

    # 改密：当前密码错误 → 400
    bad = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "wrong-password", "new_password": NEW_PASSWORD},
        headers=headers,
    )
    assert bad.status_code == 400

    # 新密码过短 → 422（schema 校验）
    short = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": ADMIN_PASSWORD, "new_password": "short"},
        headers=headers,
    )
    assert short.status_code == 422

    # 正确改密 → 标记清除
    ok = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": ADMIN_PASSWORD, "new_password": NEW_PASSWORD},
        headers=headers,
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["must_change_password"] is False

    # 解除限制后可正常访问业务接口
    assert client.get("/api/v1/rooms", headers=headers).status_code == 200

    # 数据库中的哈希已更新为新密码，且旧密码失效 / 新密码可登录
    admin = db.scalar(select(User).where(User.username == ADMIN_USERNAME))
    db.refresh(admin)
    assert verify_password(NEW_PASSWORD, admin.password_hash)
    assert not verify_password(ADMIN_PASSWORD, admin.password_hash)
    assert _login(client, ADMIN_PASSWORD).status_code == 401
    assert _login(client, NEW_PASSWORD).status_code == 200


def test_change_password_rejects_same_password(client, admin_headers):
    same = client.post(
        "/api/v1/auth/change-password",
        json={"current_password": ADMIN_PASSWORD, "new_password": ADMIN_PASSWORD},
        headers=admin_headers,
    )
    assert same.status_code == 400
    assert "不能与当前密码相同" in same.json()["detail"]
