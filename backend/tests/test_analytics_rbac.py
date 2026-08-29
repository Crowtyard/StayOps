# -*- coding: utf-8 -*-
"""S8 RBAC 测试（§34/§35/§59）：全部 6 角色 × operations/business 域。

矩阵（用 permission 判断，禁止硬编码角色名）：
    SUPER_ADMIN  operations ✓ business ✓
    MANAGER      operations ✓ business ✓
    FRONT_DESK   operations ✓ business ×
    HOUSEKEEPING × ×
    MAINTENANCE  × ×
    FINANCE      operations × business ✓
"""

from tests.analytics_helpers import d, get_analytics, iso
from tests.conftest import auth_headers

PERIOD = {"from": iso(d(-6)), "to": iso(d(0))}

OPS_PATHS = (
    "operations/overview",
    "operations/bookings",
    "operations/housekeeping",
    "operations/maintenance",
    "operations/room-moves",
    "forecast",
)
BIZ_PATHS = (
    "business/rooms",
    "business/inventory",
    "business/procurement",
)

# 角色 -> 允许访问的域
ROLE_ACCESS = {
    "SUPER_ADMIN": {"ops", "biz"},
    "MANAGER": {"ops", "biz"},
    "FRONT_DESK": {"ops"},
    "HOUSEKEEPING": set(),
    "MAINTENANCE": set(),
    "FINANCE": {"biz"},
}


def test_analytics_rbac_matrix(client, make_user, token_for):
    for role_name, access in ROLE_ACCESS.items():
        make_user(f"an_{role_name.lower()}", role_names=[role_name])
        token = token_for(f"an_{role_name.lower()}")
        headers = auth_headers(token)
        for path in OPS_PATHS:
            expected = 200 if "ops" in access else 403
            resp = client.get(
                f"/api/v1/analytics/{path}",
                params=(PERIOD if path != "forecast" else None),
                headers=headers,
            )
            assert resp.status_code == expected, (
                f"{role_name} {path} 期望 {expected} 实际 {resp.status_code}"
            )
        for path in BIZ_PATHS:
            expected = 200 if "biz" in access else 403
            resp = client.get(
                f"/api/v1/analytics/{path}", params=PERIOD, headers=headers
            )
            assert resp.status_code == expected, (
                f"{role_name} {path} 期望 {expected} 实际 {resp.status_code}"
            )


def test_front_desk_operations_yes_business_no(client, make_user, token_for):
    """FRONT_DESK：operations 可见、business 403（页面不能通过另一接口泄露，§59）。"""
    make_user("an_frontdesk2", role_names=["FRONT_DESK"])
    headers = auth_headers(token_for("an_frontdesk2"))
    data = get_analytics(client, headers, "operations/overview", PERIOD)
    assert data["metrics"]["physical_room_nights"] == 28 * 6
    for path in BIZ_PATHS:
        get_analytics(client, headers, path, PERIOD, expect=403)
    # forecast 属 operations 域
    get_analytics(client, headers, "forecast", expect=200)


def test_finance_business_yes_operations_no(client, make_user, token_for):
    """FINANCE：business 可见、operations 403（§59）。"""
    make_user("an_finance2", role_names=["FINANCE"])
    headers = auth_headers(token_for("an_finance2"))
    data = get_analytics(client, headers, "business/rooms", PERIOD)
    assert data["period"]["days"] == 6
    for path in OPS_PATHS:
        params = PERIOD if path != "forecast" else None
        resp = client.get(
            f"/api/v1/analytics/{path}", params=params, headers=headers
        )
        assert resp.status_code == 403, f"FINANCE 不应访问 {path}"


def test_housekeeping_and_maintenance_no_analytics(client, make_user, token_for):
    """HOUSEKEEPING / MAINTENANCE：两个域均 403。"""
    for role_name in ("HOUSEKEEPING", "MAINTENANCE"):
        username = f"an_{role_name.lower()}"
        make_user(username, role_names=[role_name])
        headers = auth_headers(token_for(username))
        for path in (*OPS_PATHS, *BIZ_PATHS):
            params = PERIOD if path != "forecast" else None
            resp = client.get(
                f"/api/v1/analytics/{path}", params=params, headers=headers
            )
            assert resp.status_code == 403, f"{role_name} 不应访问 {path}"


def test_unauthenticated_analytics_401(client):
    resp = client.get(
        "/api/v1/analytics/operations/overview", params=PERIOD
    )
    assert resp.status_code == 401
    resp = client.get(
        "/api/v1/analytics/business/inventory", params=PERIOD
    )
    assert resp.status_code == 401
