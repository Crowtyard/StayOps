# -*- coding: utf-8 -*-
"""Provider 失败隔离测试（Sprint 9 §7/§42 Flow D）。

DeepSeek timeout / 5xx / 网络不可达只影响 /ai-manager；
/login、/dashboard 数据源（/rooms）、/analytics 等 StayOps 页面保持正常。
"""

from fastapi import Depends

from app.api.deps import get_ai_service
from app.database import get_db
from app.services.ai_manager import AIManagerService
from tests.fake_deepseek import FakeDeepSeekClient, error_step


def _install_failing_provider(app, step):
    def factory(api_key, model, base_url, timeout_seconds):
        return FakeDeepSeekClient(
            api_key=api_key,
            model=model,
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            script=[step],
        )

    def override(db=Depends(get_db)):
        return AIManagerService(db, client_factory=factory)

    app.dependency_overrides[get_ai_service] = override


def _configure_key(client, admin_headers):
    resp = client.put(
        "/api/v1/settings/ai",
        json={"api_key": "sk-isolation-test-0000"},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text


def test_provider_timeout_only_affects_ai_manager(app, client, admin_headers):
    _configure_key(client, admin_headers)
    _install_failing_provider(app, error_step("AI_TIMEOUT"))

    # /ai-manager 失败（清晰业务错误）
    resp = client.post(
        "/api/v1/ai-manager/chat",
        json={"message": "入住率"},
        headers=admin_headers,
    )
    assert resp.status_code == 502
    assert "AI_TIMEOUT" in resp.json()["detail"]

    # StayOps 其余能力不受影响
    assert client.get("/health").status_code == 200
    me = client.get("/api/v1/auth/me", headers=admin_headers)
    assert me.status_code == 200
    rooms = client.get("/api/v1/rooms", headers=admin_headers)
    assert rooms.status_code == 200
    assert rooms.json()["total"] == 28


def test_provider_5xx_only_affects_ai_manager(app, client, admin_headers):
    _configure_key(client, admin_headers)
    _install_failing_provider(app, error_step("AI_PROVIDER_UNAVAILABLE"))

    resp = client.post(
        "/api/v1/ai-manager/chat",
        json={"message": "最近维修情况"},
        headers=admin_headers,
    )
    assert resp.status_code == 502
    assert "AI_PROVIDER_UNAVAILABLE" in resp.json()["detail"]

    # 其余页面健康（前台数据源 /rooms、/reservations、/stays）
    for path in ("/api/v1/rooms", "/api/v1/reservations", "/api/v1/stays"):
        assert client.get(path, headers=admin_headers).status_code == 200
    # 登录不受影响（新会话）
    login = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "Admin@123456"},
    )
    assert login.status_code == 200


def test_settings_test_failure_isolated(app, client, admin_headers):
    """Test Connection 失败不影响其它 API。"""
    _configure_key(client, admin_headers)
    _install_failing_provider(app, error_step("AI_RATE_LIMITED"))
    resp = client.post("/api/v1/settings/ai/test", json={}, headers=admin_headers)
    assert resp.status_code == 502
    assert "AI_RATE_LIMITED" in resp.json()["detail"]
    assert client.get("/health").status_code == 200
    assert (
        client.get("/api/v1/rooms", headers=admin_headers).status_code == 200
    )


def test_chat_route_malformed_tool_calls_returns_ai_response_invalid(
    app, client, admin_headers
):
    """Kun Fast QA Blocking Defect（Route-Level Regression）：

    真实 DeepSeekClient 解析边界 + 真实 HTTP 路由 /api/v1/ai-manager/chat：
    Provider 返回畸形 {"tool_calls": [123]} 必须返回明确 AI Domain Error
    AI_RESPONSE_INVALID（502），绝不 generic 500 / 未捕获 AttributeError。
    """
    import httpx
    from fastapi import Depends

    from app.api.deps import get_ai_service
    from app.database import get_db
    from app.services.ai_manager import AIManagerService
    from app.services.deepseek import DeepSeekClient

    def handler(req):
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [123],
                        }
                    }
                ],
                "model": "deepseek-chat",
            },
        )

    def factory(api_key, model, base_url, timeout_seconds):
        return DeepSeekClient(
            api_key=api_key,
            model=model,
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            transport=httpx.MockTransport(handler),
        )

    def override(db=Depends(get_db)):
        return AIManagerService(db, client_factory=factory)

    app.dependency_overrides[get_ai_service] = override
    try:
        # PUT 不触发 Provider，仅为 chat 准备 Key
        resp = client.put(
            "/api/v1/settings/ai",
            json={"api_key": "sk-route-malformed-test-0000"},
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text

        resp = client.post(
            "/api/v1/ai-manager/chat",
            json={"message": "查询最近维修情况"},
            headers=admin_headers,
        )
        assert resp.status_code == 502, resp.text
        detail = resp.json()["detail"]
        assert detail.startswith("AI_RESPONSE_INVALID"), detail
        assert "AttributeError" not in detail
        assert "TypeError" not in detail
        assert "KeyError" not in detail
    finally:
        app.dependency_overrides.pop(get_ai_service, None)


def test_chat_route_malformed_message_object_returns_ai_response_invalid(
    app, client, admin_headers
):
    """Route-Level：message 为非对象结构同样映射 AI_RESPONSE_INVALID（不 500）。"""
    import httpx
    from fastapi import Depends

    from app.api.deps import get_ai_service
    from app.database import get_db
    from app.services.ai_manager import AIManagerService
    from app.services.deepseek import DeepSeekClient

    def handler(req):
        return httpx.Response(
            200,
            json={"choices": [{"message": "not-an-object"}]},
        )

    def factory(api_key, model, base_url, timeout_seconds):
        return DeepSeekClient(
            api_key=api_key,
            model=model,
            base_url=base_url,
            timeout_seconds=timeout_seconds,
            transport=httpx.MockTransport(handler),
        )

    def override(db=Depends(get_db)):
        return AIManagerService(db, client_factory=factory)

    app.dependency_overrides[get_ai_service] = override
    try:
        client.put(
            "/api/v1/settings/ai",
            json={"api_key": "sk-route-malformed-test-0001"},
            headers=admin_headers,
        )
        resp = client.post(
            "/api/v1/ai-manager/chat",
            json={"message": "查询"},
            headers=admin_headers,
        )
        assert resp.status_code == 502, resp.text
        assert resp.json()["detail"].startswith("AI_RESPONSE_INVALID")
    finally:
        app.dependency_overrides.pop(get_ai_service, None)
