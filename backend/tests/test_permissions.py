# -*- coding: utf-8 -*-
"""权限列表测试。"""


def test_list_permissions(client, admin_headers):
    resp = client.get(
        "/api/v1/permissions", params={"page_size": 100}, headers=admin_headers
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 55  # 52（S9）+ alpha.9.6 渠道 2 + QA DEF-1 房间库存 1
    items = body["items"]
    assert len(items) == 55
    codes = {p["code"] for p in items}
    # Sprint 8 §34：Analytics 权限码存在
    assert {"analytics:operations_read", "analytics:business_read"} <= codes
    # Sprint 9 §22：AI Manager 权限码存在
    assert {"ai_manager:use", "ai_manager:manage"} <= codes
    # alpha.9.6 F3：渠道主数据权限码存在
    assert {"channel:read", "channel:write"} <= codes
    # alpha.9.6 QA DEF-1：房间主数据管理权限码存在（与 room:write 分离）
    assert "room:inventory_manage" in codes
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
