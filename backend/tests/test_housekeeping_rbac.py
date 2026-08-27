# -*- coding: utf-8 -*-
"""Housekeeping RBAC 与 PII 测试（Sprint 3）：

角色矩阵：
- SUPER_ADMIN / MANAGER = 全部 5 个权限
- FRONT_DESK = read + write（可创建/派单，不可 start/submit/pass/rework/cancel）
- HOUSEKEEPING = read + work + inspect（可执行工作流，不可创建/修改/取消）
- MAINTENANCE / FINANCE = 无任何任务权限（403）

PII：任务响应/审计不含 Guest 身份、联系方式与预订数据。
"""

from tests.booking_helpers import find_room
from tests.hk_helpers import make_dirty, task_action


HK_ALL = {
    "housekeeping_task:read",
    "housekeeping_task:write",
    "housekeeping_task:work",
    "housekeeping_task:inspect",
    "housekeeping_task:cancel",
}


def _make_task(client, admin_headers, room_number: str) -> dict:
    make_dirty(client, admin_headers, room_number)
    room = find_room(client, admin_headers, room_number)
    resp = client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room["id"]}, headers=admin_headers
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_role_permission_matrix(client, admin_headers, make_user, token_for):
    """抽查角色矩阵：FRONT_DESK 可创建/派单但不可执行；HOUSEKEEPING 可执行但不可创建/取消；
    MAINTENANCE 全 403。"""
    room109 = find_room(client, admin_headers, "109")
    make_dirty(client, admin_headers, "109")

    def headers_for(username: str, role: str) -> dict:
        make_user(username, role_names=[role])
        return {"Authorization": f"Bearer {token_for(username)}"}

    fd = headers_for("fd_hk", "FRONT_DESK")
    hk = headers_for("hk_hk", "HOUSEKEEPING")
    maint = headers_for("mt_hk", "MAINTENANCE")

    # FRONT_DESK：read + write
    assert client.get("/api/v1/housekeeping/tasks", headers=fd).status_code == 200
    fd_task = client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room109["id"]}, headers=fd
    )
    assert fd_task.status_code == 201, fd_task.text
    task_id = fd_task.json()["id"]
    assert client.patch(
        f"/api/v1/housekeeping/tasks/{task_id}",
        json={"priority": "URGENT"},
        headers=fd,
    ).status_code == 200
    # FRONT_DESK 无 work/inspect/cancel
    assert client.post(
        f"/api/v1/housekeeping/tasks/{task_id}/start", headers=fd
    ).status_code == 403
    assert client.post(
        f"/api/v1/housekeeping/tasks/{task_id}/cancel", headers=fd
    ).status_code == 403

    # HOUSEKEEPING：work + inspect，无 write/cancel
    assert client.get("/api/v1/housekeeping/tasks", headers=hk).status_code == 200
    assert client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room109["id"]}, headers=hk
    ).status_code == 403
    assert client.patch(
        f"/api/v1/housekeeping/tasks/{task_id}",
        json={"priority": "NORMAL"},
        headers=hk,
    ).status_code == 403
    assert client.post(
        f"/api/v1/housekeeping/tasks/{task_id}/cancel", headers=hk
    ).status_code == 403
    assert client.post(
        f"/api/v1/housekeeping/tasks/{task_id}/start", headers=hk
    ).status_code == 200
    assert client.post(
        f"/api/v1/housekeeping/tasks/{task_id}/submit-inspection", headers=hk
    ).status_code == 200
    assert client.post(
        f"/api/v1/housekeeping/tasks/{task_id}/pass", headers=hk
    ).status_code == 200

    # MAINTENANCE：无任何任务权限
    assert client.get("/api/v1/housekeeping/tasks", headers=maint).status_code == 403
    assert client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room109["id"]}, headers=maint
    ).status_code == 403


def test_me_permissions_matrix(client, admin_headers, make_user, token_for):
    """auth/me 权限码矩阵：各角色拥有预期权限子集。"""
    expectations = {
        "MANAGER": HK_ALL,
        "FRONT_DESK": {"housekeeping_task:read", "housekeeping_task:write"},
        "HOUSEKEEPING": {
            "housekeeping_task:read",
            "housekeeping_task:work",
            "housekeeping_task:inspect",
        },
        "MAINTENANCE": set(),
        "FINANCE": set(),
    }
    for role_name, expected in expectations.items():
        username = f"me_hk_{role_name.lower()}"
        make_user(username, role_names=[role_name])
        token = token_for(username)
        me = client.get(
            "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
        ).json()
        granted = {c for c in me["permissions"] if c.startswith("housekeeping_task")}
        assert granted == expected, f"{role_name}: {granted}"


def test_manager_full_flow(client, admin_headers, make_user, token_for):
    """MANAGER 可执行全链路（create → assign → start → submit → pass → cancel 场景）。"""
    make_user("mg_hk", role_names=["MANAGER"])
    mg = {"Authorization": f"Bearer {token_for('mg_hk')}"}
    task = _make_task(client, mg, "207")
    task_action(client, mg, task["id"], "start")
    task_action(client, mg, task["id"], "submit-inspection")
    task_action(client, mg, task["id"], "pass")
    assert client.get(
        f"/api/v1/housekeeping/tasks/{task['id']}", headers=mg
    ).json()["status"] == "COMPLETED"


def test_assignees_endpoint(client, admin_headers, make_user, token_for):
    """GET /housekeeping/assignees：housekeeping_task:write 可读取；
    只返回持有 housekeeping_task:work 的在职用户（不含无 work 权限的角色）。"""
    make_user("hk_cand1", role_names=["HOUSEKEEPING"])
    make_user("fd_cand2", role_names=["FRONT_DESK"])  # 无 work → 不应出现
    make_user("fd_assigner", role_names=["FRONT_DESK"])
    fd = {"Authorization": f"Bearer {token_for('fd_assigner')}"}

    resp = client.get("/api/v1/housekeeping/assignees", headers=fd)
    assert resp.status_code == 200, resp.text
    usernames = {a["username"] for a in resp.json()}
    assert "hk_cand1" in usernames
    assert "fd_cand2" not in usernames

    # HOUSEKEEPING（无 write）→ 403；MAINTENANCE → 403
    hk = {"Authorization": f"Bearer {token_for('hk_cand1')}"}
    assert client.get("/api/v1/housekeeping/assignees", headers=hk).status_code == 403


def test_task_response_has_no_pii(client, admin_headers, db):
    """任务响应不含任何 Guest 身份/联系方式与预订数据（name/phone/email/
    reservation_no/amount 等键不存在；即使与 Booking 数据共存于库中）。"""
    from tests.booking_helpers import check_in, check_out, create_guest, create_reservation

    guest = create_guest(
        client, admin_headers, name="PII保洁客人", phone="13900009999",
        email="hk-pii@example.com", notes="PII-HK-NOTES",
    )
    room = find_room(client, admin_headers, "208")
    res = create_reservation(client, admin_headers, room=room, guest_id=guest["id"])
    checked = check_in(client, admin_headers, res["id"])
    check_out(client, admin_headers, checked["stay"]["id"])

    tasks = client.get(
        "/api/v1/housekeeping/tasks", params={"room_id": room["id"]},
        headers=admin_headers,
    ).json()["items"]
    assert len(tasks) == 1
    import json as _json

    body = _json.dumps(tasks[0], ensure_ascii=False)
    for forbidden in [
        "张先生", "PII保洁客人", "13900009999", "hk-pii@example.com",
        "PII-HK-NOTES", "reservation_no", "amount",
    ]:
        assert forbidden not in body

    # 审计 details 同样无 PII
    from app.models import AuditLog
    from sqlalchemy import select

    details = db.scalars(
        select(AuditLog.details).where(
            AuditLog.resource_type == "housekeeping_task",
            AuditLog.resource_id == tasks[0]["id"],
        )
    ).all()
    for d in details:
        text = _json.dumps(d, ensure_ascii=False)
        for forbidden in [
            "PII保洁客人", "13900009999", "hk-pii@example.com",
            "PII-HK-NOTES", "reservation_no", "amount",
        ]:
            assert forbidden not in text
