# -*- coding: utf-8 -*-
"""权限列表测试。"""


def test_list_permissions(client, admin_headers):
    resp = client.get(
        "/api/v1/permissions", params={"page_size": 100}, headers=admin_headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 52  # Sprint 9：50（S8）+ AI Manager 的 2
    items = body["items"]
    assert len(items) == 52
    codes = {p["code"] for p in items}
    # Sprint 8 §34：Analytics 权限码存在
    assert {"analytics:operations_read", "analytics:business_read"} <= codes
    # Sprint 9 §22：AI Manager 权限码存在
    assert {"ai_manager:use", "ai_manager:manage"} <= codes
    # 任务书要求：user/role/room/room_type/audit × read/write/delete
    for module in ["user", "role", "room", "room_type", "audit"]:
        for op in ["read", "write", "delete"]:
            assert f"{module}:{op}" in codes
    # 细粒度房态权限
    assert {"room:status_cleaning", "room:status_maintenance"} <= codes
    # Sprint 2 Booking 域权限
    assert {
        "guest:read",
        "guest:write",
        "reservation:read",
        "reservation:write",
        "reservation:cancel",
        "reservation:no_show",
        "stay:read",
        "stay:check_in",
        "stay:check_out",
    } <= codes
    for p in items:
        assert {"id", "code", "name", "description"} <= set(p.keys())
