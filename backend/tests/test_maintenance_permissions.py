# -*- coding: utf-8 -*-
"""Maintenance RBAC 测试（Sprint 5 §31：用 permission 判断，不用角色名）。

权限矩阵：
    SUPER_ADMIN  read/write/work/verify/cancel（动态全部）
    MANAGER      read/write/work/verify/cancel
    FRONT_DESK   read/write
    HOUSEKEEPING read/write
    MAINTENANCE  read/work
    FINANCE      none
"""

from tests.booking_helpers import find_room
from tests.mwo_helpers import (
    assign_order,
    create_order,
    list_orders,
    me_user_id,
    order_action,
)


def _create_oid(client, headers, room_number: str = "101") -> int:
    room = find_room(client, headers, room_number)
    order = create_order(
        client, headers, room_id=room["id"], blocks_room=True, title="RBAC 工单"
    )
    return order["id"]


def test_manager_full_permissions(client, admin_headers, make_user, token_for):
    make_user("mwo_manager", role_names=["MANAGER"])
    headers = {"Authorization": f"Bearer {token_for('mwo_manager')}"}
    oid = _create_oid(client, headers)
    # read / write（再建一张）/ work / verify / cancel
    assert list_orders(client, headers)["total"] >= 1
    room = find_room(client, headers, "102")
    second = create_order(client, headers, room_id=room["id"], title="MANAGER 第二张")
    assert assign_order(client, headers, oid, me_user_id(client, headers))["status"] == "ASSIGNED"
    assert order_action(client, headers, oid, "start")["status"] == "IN_PROGRESS"
    assert order_action(client, headers, oid, "resolve")["status"] == "RESOLVED"
    assert order_action(client, headers, oid, "verify")["status"] == "COMPLETED"
    assert order_action(client, headers, second["id"], "cancel")["status"] == "CANCELLED"


def test_front_desk_read_write_only(client, admin_headers, make_user, token_for):
    make_user("mwo_frontdesk", role_names=["FRONT_DESK"])
    headers = {"Authorization": f"Bearer {token_for('mwo_frontdesk')}"}
    oid = _create_oid(client, headers, "103")
    assert list_orders(client, headers)["total"] >= 1
    # 无 work / verify / cancel
    assert order_action(client, headers, oid, "start", expect=403)
    assert order_action(client, headers, oid, "resolve", expect=403)
    assert order_action(client, headers, oid, "verify", expect=403)
    assert order_action(client, headers, oid, "rework", expect=403)
    assert order_action(client, headers, oid, "cancel", expect=403)


def test_housekeeping_read_write_only(client, admin_headers, make_user, token_for):
    make_user("mwo_housekeeping", role_names=["HOUSEKEEPING"])
    headers = {"Authorization": f"Bearer {token_for('mwo_housekeeping')}"}
    oid = _create_oid(client, headers, "104")
    assert list_orders(client, headers)["total"] >= 1
    assert order_action(client, headers, oid, "start", expect=403)
    assert order_action(client, headers, oid, "verify", expect=403)
    assert order_action(client, headers, oid, "cancel", expect=403)


def test_maintenance_read_work_only(client, admin_headers, make_user, token_for):
    make_user("mwo_maintenance", role_names=["MAINTENANCE"])
    headers = {"Authorization": f"Bearer {token_for('mwo_maintenance')}"}
    # read OK
    assert list_orders(client, headers)["total"] == 0
    # write -> 403
    room = find_room(client, headers, "105")
    assert create_order(
        client, headers, room_id=room["id"], title="无权创建", expect=403
    )
    # 由 admin 建一张并派单给维修工，验证 work 权限可用
    oid = _create_oid(client, admin_headers, "106")
    make_user("mwo_worker_106", role_names=["MAINTENANCE"])
    worker_id = _get_user_id(client, admin_headers, "mwo_worker_106")
    assign_order(client, admin_headers, oid, worker_id)
    worker_headers = {"Authorization": f"Bearer {token_for('mwo_worker_106')}"}
    assert order_action(client, worker_headers, oid, "start")["status"] == "IN_PROGRESS"
    assert order_action(client, worker_headers, oid, "resolve")["status"] == "RESOLVED"
    # verify / cancel -> 403
    assert order_action(client, worker_headers, oid, "verify", expect=403)
    assert order_action(client, worker_headers, oid, "cancel", expect=403)


def _get_user_id(client, admin_headers, username: str) -> int:
    users = client.get(
        "/api/v1/users", params={"page_size": 100}, headers=admin_headers
    ).json()["items"]
    return next(u["id"] for u in users if u["username"] == username)


def test_finance_no_maintenance_permissions(client, admin_headers, make_user, token_for):
    make_user("mwo_finance", role_names=["FINANCE"])
    headers = {"Authorization": f"Bearer {token_for('mwo_finance')}"}
    resp = client.get("/api/v1/maintenance/orders", headers=headers)
    assert resp.status_code == 403
    resp = client.post(
        "/api/v1/maintenance/orders",
        json={"room_id": 1, "category": "HVAC", "title": "无权创建"},
        headers=headers,
    )
    assert resp.status_code == 403


def test_unauthenticated_401(client):
    resp = client.get("/api/v1/maintenance/orders")
    assert resp.status_code == 401


def test_assignees_endpoint_requires_write(client, admin_headers, make_user, token_for):
    """assignees：maintenance_order:write 才可访问（不要求 user:read）。"""
    make_user("mwo_worker2", role_names=["MAINTENANCE"])
    worker_headers = {"Authorization": f"Bearer {token_for('mwo_worker2')}"}
    resp = client.get("/api/v1/maintenance/assignees", headers=worker_headers)
    assert resp.status_code == 403

    make_user("mwo_fd2", role_names=["FRONT_DESK"])
    fd_headers = {"Authorization": f"Bearer {token_for('mwo_fd2')}"}
    resp = client.get("/api/v1/maintenance/assignees", headers=fd_headers)
    assert resp.status_code == 200
