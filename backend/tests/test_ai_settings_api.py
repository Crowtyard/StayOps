# -*- coding: utf-8 -*-
"""AI Settings API 测试（Sprint 9 §26/§40/§42）。

- GET/PUT/DELETE /settings/ai 与 POST /settings/ai/test
- 权限：仅 ai_manager:manage（SUPER_ADMIN / MANAGER）
- 安全：任何响应不返回完整 API Key（只返回 configured / key_masked）
- API Key 密文落库（Fernet），明文不进入响应与审计
"""

import pytest
from sqlalchemy import select

from app.api.deps import get_ai_service
from app.core import ai_crypto
from app.models import AISetting, AuditLog
from app.services.ai_manager import AIManagerService
from tests.fake_deepseek import fake_client_factory, final_step, error_step

FAKE_KEY = "sk-e2e-fake-key-1234abcd"


@pytest.fixture()
def fake_ai_service(app):
    """注入 FakeDeepSeekClient 的 AIManagerService（script 由测试控制）。"""
    from fastapi import Depends

    from app.database import get_db

    state: dict = {"script": []}

    def apply(script=None):
        if script is not None:
            state["script"] = script

        def factory(api_key, model, base_url, timeout_seconds):
            from tests.fake_deepseek import FakeDeepSeekClient

            return FakeDeepSeekClient(
                api_key=api_key,
                model=model,
                base_url=base_url,
                timeout_seconds=timeout_seconds,
                script=list(state["script"]),
            )

        def override(db=Depends(get_db)):
            return AIManagerService(db, client_factory=factory)

        app.dependency_overrides[get_ai_service] = override

    yield apply
    app.dependency_overrides.pop(get_ai_service, None)


def _save_key(client, admin_headers, key=FAKE_KEY, model="deepseek-chat"):
    resp = client.put(
        "/api/v1/settings/ai",
        json={"api_key": key, "model": model},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# GET / PUT / DELETE
# ---------------------------------------------------------------------------


def test_get_settings_not_configured(client, admin_headers):
    resp = client.get("/api/v1/settings/ai", headers=admin_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["provider"] == "deepseek"
    assert body["configured"] is False
    assert body["key_masked"] is None
    assert body["model"] is None


def test_put_saves_key_and_masks(client, admin_headers):
    body = _save_key(client, admin_headers)
    assert body["configured"] is True
    assert body["key_masked"] == "sk-****abcd"
    assert body["model"] == "deepseek-chat"
    # 响应绝不包含完整 Key
    resp = client.get("/api/v1/settings/ai", headers=admin_headers)
    assert FAKE_KEY not in resp.text


def test_key_stored_encrypted_not_plaintext(client, admin_headers, db):
    _save_key(client, admin_headers)
    setting = db.get(AISetting, 1)
    assert setting is not None
    assert setting.api_key_encrypted is not None
    assert FAKE_KEY not in setting.api_key_encrypted
    assert ai_crypto.decrypt_api_key(setting.api_key_encrypted) == FAKE_KEY


def test_put_model_only_keeps_key(client, admin_headers):
    _save_key(client, admin_headers)
    resp = client.put(
        "/api/v1/settings/ai",
        json={"model": "deepseek-reasoner"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "deepseek-reasoner"
    assert body["configured"] is True
    assert body["key_masked"] == "sk-****abcd"  # Key 未被覆盖


def test_put_validation(client, admin_headers):
    resp = client.put("/api/v1/settings/ai", json={}, headers=admin_headers)
    assert resp.status_code == 422
    resp = client.put(
        "/api/v1/settings/ai",
        json={"api_key": "short"},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    resp = client.put(
        "/api/v1/settings/ai",
        json={"api_key": FAKE_KEY, "evil": 1},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_delete_key(client, admin_headers):
    _save_key(client, admin_headers)
    resp = client.delete("/api/v1/settings/ai/key", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["configured"] is False
    resp = client.get("/api/v1/settings/ai", headers=admin_headers)
    assert resp.json()["configured"] is False


def test_settings_rbac_requires_manage_permission(client, make_user):
    """FRONT_DESK（有 ai_manager:use，无 ai_manager:manage）-> 403。"""
    make_user("fd_ai", role_names=["FRONT_DESK"])
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "fd_ai", "password": "User@123456"},
    )
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    for method, path in (
        ("get", "/api/v1/settings/ai"),
        ("put", "/api/v1/settings/ai"),
        ("delete", "/api/v1/settings/ai/key"),
        ("post", "/api/v1/settings/ai/test"),
    ):
        resp = getattr(client, method)(path, headers=headers)
        assert resp.status_code == 403, f"{method} {path}"


def test_settings_audit_without_key(client, admin_headers, db):
    _save_key(client, admin_headers)
    client.delete("/api/v1/settings/ai/key", headers=admin_headers)
    rows = db.scalars(
        select(AuditLog).where(AuditLog.action.in_(
            ("ai_settings.update", "ai_settings.delete_key")
        ))
    ).all()
    actions = {r.action for r in rows}
    assert actions == {"ai_settings.update", "ai_settings.delete_key"}
    for row in rows:
        assert FAKE_KEY not in str(row.details)


# ---------------------------------------------------------------------------
# POST /test（连接测试）
# ---------------------------------------------------------------------------


def test_test_without_key_returns_ai_not_configured(client, admin_headers, fake_ai_service):
    fake_ai_service()
    resp = client.post("/api/v1/settings/ai/test", json={}, headers=admin_headers)
    assert resp.status_code == 409
    assert "AI_NOT_CONFIGURED" in resp.json()["detail"]


def test_test_with_stored_key_ok(client, admin_headers, fake_ai_service):
    _save_key(client, admin_headers)
    fake_ai_service([final_step("OK")])
    resp = client.post("/api/v1/settings/ai/test", json={}, headers=admin_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] == "deepseek-chat"


def test_test_with_provided_key_does_not_save(client, admin_headers, fake_ai_service, db):
    fake_ai_service([final_step("OK")])
    resp = client.post(
        "/api/v1/settings/ai/test",
        json={"api_key": "sk-provided-test-key-9999"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    setting = db.get(AISetting, 1)
    # 提供 Key 只测不存：若此前无配置，仍为未配置
    assert setting is None or setting.api_key_encrypted is None


def test_test_provider_error_mapped(client, admin_headers, fake_ai_service):
    _save_key(client, admin_headers)
    fake_ai_service([error_step("AI_AUTH_FAILED", http_status=502)])
    resp = client.post("/api/v1/settings/ai/test", json={}, headers=admin_headers)
    assert resp.status_code == 502
    assert "AI_AUTH_FAILED" in resp.json()["detail"]


def test_test_unknown_model_detected_by_provider(client, admin_headers, fake_ai_service):
    """未知模型：Test Connection 应能发现 Provider 错误（§27）。"""
    _save_key(client, admin_headers, model="not-a-real-model")
    fake_ai_service([error_step("AI_PROVIDER_UNAVAILABLE", http_status=502)])
    resp = client.post("/api/v1/settings/ai/test", json={}, headers=admin_headers)
    assert resp.status_code == 502
    assert "AI_PROVIDER_UNAVAILABLE" in resp.json()["detail"]
