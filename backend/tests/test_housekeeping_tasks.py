# -*- coding: utf-8 -*-
"""Housekeeping Task 核心测试（Sprint 3）：
手动创建 / 状态机全链路 / 派单 / PATCH 严格性 / 取消 / 列表筛选与 search。

房间使用专属号段（109/110/207/208），与 Booking 测试（101-104、201-206、
301-308）互不干扰；测试随用例事务整体回滚。
"""

from app.models import Room
from tests.booking_helpers import find_room
from tests.hk_helpers import (
    create_task,
    list_tasks,
    make_dirty,
    patch_task,
    task_action,
)


def _task_no_re(value: str) -> None:
    import re

    assert re.match(r"^HKT\d{8}-\d{4,}$", value), value


def _room(db, room_id: int) -> Room:
    room = db.get(Room, room_id)
    assert room is not None
    return room


def test_create_manual_task_on_dirty_room(client, admin_headers, db):
    """dirty 房间可手动创建任务（PENDING / MANUAL / NORMAL）；task_no 格式正确。"""
    make_dirty(client, admin_headers, "109")
    room = find_room(client, admin_headers, "109")
    task = create_task(client, admin_headers, room["id"], notes="退房后补单")
    assert task["status"] == "PENDING"
    assert task["source"] == "MANUAL"
    assert task["priority"] == "NORMAL"
    assert task["room_number"] == "109"
    assert task["notes"] == "退房后补单"
    _task_no_re(task["task_no"])
    # 房间保持 dirty（创建任务本身不改房态，由状态转换驱动）
    assert _room(db, room["id"]).cleaning_status.value == "dirty"


def test_create_task_requires_dirty_room(client, admin_headers):
    """clean 房间创建任务 -> 409。"""
    room = find_room(client, admin_headers, "110")
    assert room["cleaning_status"] == "clean"
    create_task(client, admin_headers, room["id"], expect=409)
    resp = client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room["id"]}, headers=admin_headers
    )
    assert resp.status_code == 409
    assert "无需清扫" in resp.json()["detail"]


def test_create_task_forbidden_on_occupied_room(client, admin_headers):
    """occupied 房间不得创建保洁任务（不做住中保洁）。"""
    room = find_room(client, admin_headers, "207")
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "occupied", "cleaning_status": "dirty"},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    resp = client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room["id"]}, headers=admin_headers
    )
    assert resp.status_code == 409
    assert "在住房间" in resp.json()["detail"]


def test_create_task_duplicate_active_409(client, admin_headers):
    """已有进行中任务的房间再次创建 -> 409。"""
    make_dirty(client, admin_headers, "208")
    room = find_room(client, admin_headers, "208")
    create_task(client, admin_headers, room["id"])
    create_task(client, admin_headers, room["id"], expect=409)
    resp = client.post(
        "/api/v1/housekeeping/tasks", json={"room_id": room["id"]}, headers=admin_headers
    )
    assert resp.status_code == 409
    assert "已有进行中的保洁任务" in resp.json()["detail"]


def test_full_flow_and_room_sync(client, admin_headers, db):
    """正常清扫链：PENDING → IN_PROGRESS → INSPECTION → COMPLETED，
    每一步 Task.status 与 Room.cleaning_status 原子一致。"""
    make_dirty(client, admin_headers, "110")
    room = find_room(client, admin_headers, "110")
    task = create_task(client, admin_headers, room["id"])

    updated = task_action(client, admin_headers, task["id"], "start")
    assert updated["status"] == "IN_PROGRESS"
    assert updated["started_at"] is not None
    assert _room(db, room["id"]).cleaning_status.value == "cleaning"

    updated = task_action(client, admin_headers, task["id"], "submit-inspection")
    assert updated["status"] == "INSPECTION"
    assert updated["submitted_for_inspection_at"] is not None
    assert _room(db, room["id"]).cleaning_status.value == "inspection"

    updated = task_action(client, admin_headers, task["id"], "pass")
    assert updated["status"] == "COMPLETED"
    assert updated["completed_at"] is not None
    assert _room(db, room["id"]).cleaning_status.value == "clean"


def test_rework_loop_and_room_sync(client, admin_headers, db):
    """返工闭环：INSPECTION → REWORK → IN_PROGRESS → INSPECTION → COMPLETED，
    每一步 Task.status 与 Room.cleaning_status 一致；REWORK 后重新开始不覆盖首次开始时间。"""
    make_dirty(client, admin_headers, "207")
    room = find_room(client, admin_headers, "207")
    task = create_task(client, admin_headers, room["id"])
    task_action(client, admin_headers, task["id"], "start")
    first_started_at = client.get(
        f"/api/v1/housekeeping/tasks/{task['id']}", headers=admin_headers
    ).json()["started_at"]
    task_action(client, admin_headers, task["id"], "submit-inspection")

    updated = task_action(client, admin_headers, task["id"], "rework")
    assert updated["status"] == "REWORK"
    assert _room(db, room["id"]).cleaning_status.value == "rework"

    updated = task_action(client, admin_headers, task["id"], "start")
    assert updated["status"] == "IN_PROGRESS"
    assert updated["started_at"] == first_started_at  # 首次开始时间保留
    assert _room(db, room["id"]).cleaning_status.value == "cleaning"

    task_action(client, admin_headers, task["id"], "submit-inspection")
    assert _room(db, room["id"]).cleaning_status.value == "inspection"
    updated = task_action(client, admin_headers, task["id"], "pass")
    assert updated["status"] == "COMPLETED"
    assert _room(db, room["id"]).cleaning_status.value == "clean"


def test_illegal_transitions_409(client, admin_headers, db):
    """非法跳转 409（后端状态机权威）：
    PENDING 不能 submit/pass/rework；IN_PROGRESS 不能 pass/rework；
    COMPLETED/CANCELLED 终态不可再操作。"""
    make_dirty(client, admin_headers, "208")
    room = find_room(client, admin_headers, "208")
    task = create_task(client, admin_headers, room["id"])

    task_action(client, admin_headers, task["id"], "submit-inspection", expect=409)
    task_action(client, admin_headers, task["id"], "pass", expect=409)
    task_action(client, admin_headers, task["id"], "rework", expect=409)

    task_action(client, admin_headers, task["id"], "start")
    task_action(client, admin_headers, task["id"], "pass", expect=409)
    task_action(client, admin_headers, task["id"], "rework", expect=409)
    task_action(client, admin_headers, task["id"], "start", expect=409)  # 已在清扫中

    task_action(client, admin_headers, task["id"], "submit-inspection")
    task_action(client, admin_headers, task["id"], "pass")
    # COMPLETED 终态：任何 action 409
    for action in ("start", "submit-inspection", "pass", "rework", "cancel"):
        task_action(client, admin_headers, task["id"], action, expect=409)
    # 终态 PATCH 409
    patch_task(
        client, admin_headers, task["id"], {"priority": "URGENT"}, expect=409
    )


def test_cancel_from_active_states(client, admin_headers, db):
    """任意进行中状态可取消 -> CANCELLED + 房间回置 dirty；取消后终态。"""
    make_dirty(client, admin_headers, "109")
    room = find_room(client, admin_headers, "109")
    task = create_task(client, admin_headers, room["id"])
    task_action(client, admin_headers, task["id"], "start")
    task_action(client, admin_headers, task["id"], "submit-inspection")
    updated = task_action(client, admin_headers, task["id"], "cancel")
    assert updated["status"] == "CANCELLED"
    assert updated["cancelled_at"] is not None
    assert _room(db, room["id"]).cleaning_status.value == "dirty"
    task_action(client, admin_headers, task["id"], "start", expect=409)

    # 取消后同一房间可再次创建任务（Active Task 唯一只约束进行中状态）
    again = create_task(client, admin_headers, room["id"])
    assert again["status"] == "PENDING"


def test_assignment_reassign_unassign(client, admin_headers, make_user, db):
    """派单 / 改派 / 取消派单（PATCH assigned_to_user_id，含显式 null）。"""
    make_dirty(client, admin_headers, "110")
    room = find_room(client, admin_headers, "110")
    task = create_task(client, admin_headers, room["id"])

    assignee = make_user("hk_assignee", role_names=["HOUSEKEEPING"])
    updated = patch_task(
        client, admin_headers, task["id"], {"assigned_to_user_id": assignee["id"]}
    )
    assert updated["assigned_to_user_id"] == assignee["id"]
    assert updated["assignee_name"] is not None

    # 改派到另一个用户
    other = make_user("hk_assignee2", role_names=["HOUSEKEEPING"])
    updated = patch_task(
        client, admin_headers, task["id"], {"assigned_to_user_id": other["id"]}
    )
    assert updated["assigned_to_user_id"] == other["id"]

    # 取消派单（显式 null，不得误判为空 payload）
    # 注意：路由 response_model_exclude_none=True，null 字段以键缺失呈现
    updated = patch_task(
        client, admin_headers, task["id"], {"assigned_to_user_id": None}
    )
    assert updated.get("assigned_to_user_id") is None
    assert "assignee_name" not in updated

    # 被指派人不存在 -> 422
    patch_task(
        client, admin_headers, task["id"], {"assigned_to_user_id": 999999}, expect=422
    )


def test_patch_strict_schema(client, admin_headers):
    """PATCH strict：空 payload 422；未知字段（含 status）422；合法 priority/notes 生效。"""
    make_dirty(client, admin_headers, "207")
    room = find_room(client, admin_headers, "207")
    task = create_task(client, admin_headers, room["id"])

    patch_task(client, admin_headers, task["id"], {}, expect=422)
    patch_task(client, admin_headers, task["id"], {"status": "COMPLETED"}, expect=422)
    patch_task(
        client,
        admin_headers,
        task["id"],
        {"priority": "URGENT", "status": "PENDING"},
        expect=422,
    )
    # 混合 payload 原子失败：priority 不得被部分应用
    after = client.get(
        f"/api/v1/housekeeping/tasks/{task['id']}", headers=admin_headers
    ).json()
    assert after["priority"] == "NORMAL"

    updated = patch_task(
        client, admin_headers, task["id"], {"priority": "URGENT", "notes": "加急"}
    )
    assert updated["priority"] == "URGENT"
    assert updated["notes"] == "加急"


def test_list_filters_and_search(client, admin_headers):
    """列表筛选（status/room_id/priority/source/assignee）+ search（task_no / room_no）。"""
    make_dirty(client, admin_headers, "109")
    make_dirty(client, admin_headers, "110")
    room109 = find_room(client, admin_headers, "109")
    room110 = find_room(client, admin_headers, "110")
    t1 = create_task(client, admin_headers, room109["id"], priority="URGENT")
    t2 = create_task(client, admin_headers, room110["id"])

    by_room = list_tasks(client, admin_headers, room_id=room109["id"], page_size=100)
    assert [t["id"] for t in by_room["items"]] == [t1["id"]]

    by_priority = list_tasks(client, admin_headers, priority="URGENT", page_size=100)
    assert {t["id"] for t in by_priority["items"]} == {t1["id"]}

    by_source = list_tasks(client, admin_headers, source="MANUAL", page_size=100)
    assert {t["id"] for t in by_source["items"]} >= {t1["id"], t2["id"]}

    by_status = list_tasks(
        client, admin_headers, status="PENDING", page_size=100
    )
    assert {t["id"] for t in by_status["items"]} >= {t1["id"], t2["id"]}

    # search：room_no 与 task_no（非 PII）
    by_search = list_tasks(client, admin_headers, search="109", page_size=100)
    assert [t["id"] for t in by_search["items"]] == [t1["id"]]
    by_search_no = list_tasks(
        client, admin_headers, search=t2["task_no"], page_size=100
    )
    assert [t["id"] for t in by_search_no["items"]] == [t2["id"]]


def test_task_404(client, admin_headers):
    resp = client.get("/api/v1/housekeeping/tasks/999999", headers=admin_headers)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "保洁任务不存在"
    resp = client.post(
        "/api/v1/housekeeping/tasks/999999/start", headers=admin_headers
    )
    assert resp.status_code == 404
