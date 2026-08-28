# -*- coding: utf-8 -*-
"""Maintenance assignee 测试（Sprint 5 §10/§32，复用 Alpha.3 assignee 模式）。"""

from tests.booking_helpers import find_room
from tests.mwo_helpers import (
    assign_order,
    create_order,
    order_action,
)


def _user_id(client, admin_headers, username: str) -> int:
    users = client.get(
        "/api/v1/users", params={"page_size": 100}, headers=admin_headers
    ).json()["items"]
    return next(u["id"] for u in users if u["username"] == username)


def test_assignees_lists_work_permission_users(client, admin_headers, make_user):
    """候选人 = 持有 maintenance_order:work 的在职用户；
    不含无 work 权限的用户（如 FINANCE / FRONT_DESK）。"""
    make_user("mwo_asg_worker", role_names=["MAINTENANCE"])
    make_user("mwo_asg_manager", role_names=["MANAGER"])
    make_user("mwo_asg_fd", role_names=["FRONT_DESK"])
    make_user("mwo_asg_finance", role_names=["FINANCE"])

    resp = client.get("/api/v1/maintenance/assignees", headers=admin_headers)
    assert resp.status_code == 200
    usernames = {u["username"] for u in resp.json()}
    assert "mwo_asg_worker" in usernames
    assert "mwo_asg_manager" in usernames
    # FRONT_DESK / FINANCE 无 maintenance_order:work
    assert "mwo_asg_fd" not in usernames
    assert "mwo_asg_finance" not in usernames


def test_assign_requires_active_user(client, admin_headers, make_user):
    room = find_room(client, admin_headers, "301")
    order = create_order(client, admin_headers, room_id=room["id"], title="派单校验")
    oid = order["id"]
    # 不存在用户 -> 422
    resp = client.post(
        f"/api/v1/maintenance/orders/{oid}/assign",
        json={"assigned_to_user_id": 99999},
        headers=admin_headers,
    )
    assert resp.status_code == 422
    # 停用用户 -> 422
    make_user("mwo_asg_inactive", role_names=["MAINTENANCE"], is_active=False)
    inactive_id = _user_id(client, admin_headers, "mwo_asg_inactive")
    resp = client.post(
        f"/api/v1/maintenance/orders/{oid}/assign",
        json={"assigned_to_user_id": inactive_id},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_reassign_allowed_while_assigned(client, admin_headers, make_user):
    """ASSIGNED 状态可改派（Sprint 5 §10 assign / reassign）。"""
    room = find_room(client, admin_headers, "302")
    order = create_order(client, admin_headers, room_id=room["id"], title="改派测试")
    oid = order["id"]
    make_user("mwo_asg_a", role_names=["MAINTENANCE"])
    make_user("mwo_asg_b", role_names=["MAINTENANCE"])
    a_id = _user_id(client, admin_headers, "mwo_asg_a")
    b_id = _user_id(client, admin_headers, "mwo_asg_b")

    assigned = assign_order(client, admin_headers, oid, a_id)
    assert assigned["status"] == "ASSIGNED"
    assert assigned["assigned_to_user_id"] == a_id

    reassigned = assign_order(client, admin_headers, oid, b_id)
    assert reassigned["status"] == "ASSIGNED"
    assert reassigned["assigned_to_user_id"] == b_id


def test_assign_on_in_progress_409(client, admin_headers, make_user):
    """开始维修后不可改派。"""
    room = find_room(client, admin_headers, "303")
    order = create_order(client, admin_headers, room_id=room["id"], title="派单时机")
    oid = order["id"]
    make_user("mwo_asg_c", role_names=["MAINTENANCE"])
    worker = _user_id(client, admin_headers, "mwo_asg_c")
    assign_order(client, admin_headers, oid, worker)
    order_action(client, admin_headers, oid, "start")
    resp = client.post(
        f"/api/v1/maintenance/orders/{oid}/assign",
        json={"assigned_to_user_id": worker},
        headers=admin_headers,
    )
    assert resp.status_code == 409
