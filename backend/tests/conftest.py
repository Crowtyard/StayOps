# -*- coding: utf-8 -*-
"""pytest 全局配置：独立测试库（stayops_test）+ 事务回滚隔离。

要点：
- 在任何 app.* 导入前，将 DATABASE_URL 指向测试库（app.config 在导入时读取 .env/env）
- session 级：DROP/CREATE 测试库 -> alembic upgrade head -> 幂等 seed
- 每个测试：单连接 + 外层事务 + savepoint 会话；测试结束整体回滚，用例互不污染
"""

import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops_test",
)
# 必须先于任何 app.* 导入设置
os.environ["DATABASE_URL"] = TEST_DATABASE_URL

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.orm import sessionmaker

ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "Admin@123456"


@pytest.fixture(scope="session")
def _database():
    """重建测试库并执行迁移 + 种子（整个测试会话一次）。"""
    url = make_url(TEST_DATABASE_URL)
    db_name = url.database
    admin_engine = create_engine(url.set(database="postgres"))
    with admin_engine.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin_engine.dispose()

    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    command.upgrade(cfg, "head")

    from app.seed import seed

    seed()


@pytest.fixture(scope="session")
def app(_database):
    from app.main import app

    return app


@pytest.fixture()
def session_factory(app):
    """绑定到单连接 + 外层事务的会话工厂（savepoint 模式）。

    API 请求内 session.commit() 只释放 savepoint；测试结束统一 rollback。
    """
    from app.database import engine

    connection = engine.connect()
    transaction = connection.begin()
    factory = sessionmaker(
        bind=connection,
        autoflush=False,
        expire_on_commit=False,
        join_transaction_mode="create_savepoint",
    )
    yield factory
    transaction.rollback()
    connection.close()


@pytest.fixture()
def client(app, session_factory):
    from fastapi.testclient import TestClient

    from app.database import get_db

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture()
def db(session_factory):
    """与请求共享同一事务的会话（可直接查询 API 已写入的数据）。"""
    session = session_factory()
    yield session
    session.close()


# ---------- 常用助手 ----------


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def admin_token(client) -> str:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


@pytest.fixture()
def admin_headers(client) -> dict:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    return auth_headers(resp.json()["access_token"])


@pytest.fixture()
def make_user(client, admin_headers):
    """以管理员身份创建用户并（可选）分配角色，返回用户 JSON。"""

    def _make(username, password="User@123456", role_names=None, is_active=True):
        role_ids = []
        if role_names:
            roles_resp = client.get(
                "/api/v1/roles", params={"page_size": 100}, headers=admin_headers
            )
            assert roles_resp.status_code == 200, roles_resp.text
            roles = {r["name"]: r["id"] for r in roles_resp.json()["items"]}
            role_ids = [roles[name] for name in role_names]
        resp = client.post(
            "/api/v1/users",
            json={
                "username": username,
                "password": password,
                "is_active": is_active,
            },
            headers=admin_headers,
        )
        assert resp.status_code == 201, resp.text
        user = resp.json()
        if role_ids:
            assign = client.post(
                f"/api/v1/users/{user['id']}/roles",
                json={"role_ids": role_ids},
                headers=admin_headers,
            )
            assert assign.status_code == 200, assign.text
        return user

    return _make


@pytest.fixture()
def token_for(client):
    """以指定用户名登录，返回 access_token。"""

    def _token(username, password="User@123456"):
        resp = client.post(
            "/api/v1/auth/login",
            json={"username": username, "password": password},
        )
        assert resp.status_code == 200, resp.text
        return resp.json()["access_token"]

    return _token
