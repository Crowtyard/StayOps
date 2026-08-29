# -*- coding: utf-8 -*-
"""S8 参数校验测试（§3/§38）：from < to、to <= current_business_date、跨度 <= 366。

Actual API 收到 to > current_business_date 不得静默制造未来实际数据 → 422。
"""

from tests.analytics_helpers import d, get_analytics, iso


def test_missing_params_422(client, admin_headers):
    resp = client.get("/api/v1/analytics/operations/overview", headers=admin_headers)
    assert resp.status_code == 422
    resp = client.get(
        "/api/v1/analytics/operations/overview",
        params={"from": iso(d(-6))},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_from_not_before_to_422(client, admin_headers):
    # from == to
    resp = client.get(
        "/api/v1/analytics/operations/overview",
        params={"from": iso(d(-6)), "to": iso(d(-6))},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    # from > to
    resp = client.get(
        "/api/v1/analytics/operations/overview",
        params={"from": iso(d(0)), "to": iso(d(-6))},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    # 业务域端点同样校验
    resp = client.get(
        "/api/v1/analytics/business/inventory",
        params={"from": iso(d(-2)), "to": iso(d(-6))},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_future_actual_rejected_422(client, admin_headers):
    """to > current_business_date → 422（不允许未来实际数据，§3）。"""
    resp = client.get(
        "/api/v1/analytics/operations/overview",
        params={"from": iso(d(-6)), "to": iso(d(1))},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    assert "未来" in resp.json()["detail"]


def test_max_span_366(client, admin_headers):
    """跨度上限 366 天：367 → 422；366 → 200。"""
    resp = client.get(
        "/api/v1/analytics/operations/overview",
        params={"from": iso(d(-367)), "to": iso(d(0))},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    get_analytics(client, admin_headers, "operations/overview",
                  {"from": iso(d(-366)), "to": iso(d(0))})


def test_forecast_no_params_ok(client, admin_headers):
    """Forecast 无参数，一次返回 7d/14d/30d + 30 日序列（§38）。"""
    data = get_analytics(client, admin_headers, "forecast")
    assert set(data["horizons"].keys()) == {"7d", "14d", "30d"}
    assert len(data["daily"]) == 30
