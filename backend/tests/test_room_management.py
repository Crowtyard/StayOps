# -*- coding: utf-8 -*-
"""alpha.9.6 F1 房间资料管理测试。

覆盖任务书 §12 的 Room 要求：
- create / edit / duplicate number / disable / enable / summary
- historical room protection（有历史业务记录的房间不得物理删除）
- 停用不释放房号（全局唯一含停用房）
- 停用房不参与可售性（不可新预订）
- 停用房间不得影响历史 Reservation / Stay（可读、可退房）
- RBAC：房间主数据管理按 `room:inventory_manage` 判定（alpha.9.6 QA DEF-1）：
  SUPER_ADMIN / MANAGER 允许；FRONT_DESK / HOUSEKEEPING / MAINTENANCE / FINANCE
  对 POST/PUT/PATCH/disable/enable 全部 403；DELETE 还需 room:delete
  （`room:inventory_manage` 且 `room:delete`，两个码都要求）
- 回归保护：FRONT_DESK 的房态操作（room:write）与 HOUSEKEEPING/MAINTENANCE
  的细分房态权限不得因本次权限拆分而回归
"""

from datetime import timedelta

import pytest

from app.core.business_date import business_date
from tests.booking_helpers import (
    check_in,
    check_out,
    create_guest,
    create_reservation,
    find_room,
)


def _check_in(client, headers, reservation_id: int) -> dict:
    """办理入住，返回 check-in 响应的 stay 部分（CheckInOut.stay）。"""
    resp = client.post(
        f"/api/v1/reservations/{reservation_id}/check-in", headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["stay"]


def _std_room_type_id(client, headers) -> int:
    return next(
        r["id"]
        for r in client.get(
            "/api/v1/room-types", params={"page_size": 100}, headers=headers
        ).json()["items"]
        if r["name"] == "标准大床房"
    )


def _luxury_room_type_id(client, headers) -> int:
    return next(
        r["id"]
        for r in client.get(
            "/api/v1/room-types", params={"page_size": 100}, headers=headers
        ).json()["items"]
        if r["name"] == "豪华大床房"
    )


def _create_room(client, headers, room_number, room_type_id, **extra) -> dict:
    payload = {"room_number": room_number, "room_type_id": room_type_id, "floor": 9}
    payload.update(extra)
    resp = client.post("/api/v1/rooms", json=payload, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _summary(client, headers) -> dict:
    resp = client.get("/api/v1/rooms/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# 新增 / 编辑
# ---------------------------------------------------------------------------


def test_create_room_with_name_and_defaults(client, admin_headers):
    """新增房间：name 落库；is_active 默认 true；房态默认 available/clean。"""
    std = _std_room_type_id(client, admin_headers)
    body = _create_room(
        client, admin_headers, "9A1", std, name="海景大床房", notes="9 楼测试房"
    )
    assert body["room_number"] == "9A1"
    assert body["name"] == "海景大床房"
    assert body["notes"] == "9 楼测试房"
    assert body["is_active"] is True
    assert body["occupancy_status"] == "available"
    assert body["cleaning_status"] == "clean"


def test_create_room_without_name(client, admin_headers):
    """name 选填（null 合法）。"""
    std = _std_room_type_id(client, admin_headers)
    body = _create_room(client, admin_headers, "9A2", std)
    assert body["name"] is None


def test_create_room_empty_room_number_422(client, admin_headers):
    std = _std_room_type_id(client, admin_headers)
    resp = client.post(
        "/api/v1/rooms",
        json={"room_number": "", "room_type_id": std, "floor": 9},
        headers=admin_headers,
    )
    assert resp.status_code == 422


def test_edit_room_number_name_and_type(client, admin_headers):
    """编辑房间：房号 / 名称 / 房型 / 楼层 / 备注（任务书验收：101 大床房 -> 豪华大床房）。"""
    std = _std_room_type_id(client, admin_headers)
    luxury = _luxury_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9A3", std, name="大床房")

    resp = client.patch(
        f"/api/v1/rooms/{room['id']}",
        json={"name": "豪华大床房", "room_type_id": luxury, "floor": 8},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "豪华大床房"
    assert body["room_type_id"] == luxury
    assert body["room_type"]["name"] == "豪华大床房"
    assert body["floor"] == 8

    # 房号可改（PUT 与 PATCH 同一实现）
    resp = client.put(
        f"/api/v1/rooms/{room['id']}",
        json={"room_number": "9A3X"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["room_number"] == "9A3X"


def test_edit_room_cannot_set_status_via_patch(client, admin_headers):
    """房态仍只能走状态机接口（PATCH/PUT 不接收 occupancy_status）。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9A4", std)
    resp = client.patch(
        f"/api/v1/rooms/{room['id']}",
        json={"occupancy_status": "occupied", "cleaning_status": "dirty"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["occupancy_status"] == "available"
    assert body["cleaning_status"] == "clean"


def test_edit_duplicate_room_number_409(client, admin_headers):
    """编辑为已存在的房号 -> 409 人类可读错误。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9A5", std)
    resp = client.patch(
        f"/api/v1/rooms/{room['id']}",
        json={"room_number": "101"},
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert "101" in resp.json()["detail"]


def test_duplicate_room_number_of_disabled_room_409(client, admin_headers):
    """停用房号不释放：新建同名房号 -> 409 且提示可恢复 / 改名。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9A6", std)
    assert (
        client.post(
            f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers
        ).status_code
        == 200
    )
    resp = client.post(
        "/api/v1/rooms",
        json={"room_number": "9A6", "room_type_id": std, "floor": 9},
        headers=admin_headers,
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "9A6" in detail and "停用" in detail


# ---------------------------------------------------------------------------
# 停用 / 启用 / 数量统计
# ---------------------------------------------------------------------------


def test_disable_and_enable_room(client, admin_headers):
    """停用 / 启用幂等；停用不释放房号、不删除记录。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9B1", std)

    disabled = client.post(
        f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers
    )
    assert disabled.status_code == 200
    assert disabled.json()["is_active"] is False

    # 幂等：再停用一次仍 200 且状态不变
    again = client.post(
        f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers
    )
    assert again.status_code == 200
    assert again.json()["is_active"] is False

    # 房间记录仍在（软停用，非物理删除）
    assert (
        client.get(f"/api/v1/rooms/{room['id']}", headers=admin_headers).status_code
        == 200
    )

    enabled = client.post(
        f"/api/v1/rooms/{room['id']}/enable", headers=admin_headers
    )
    assert enabled.status_code == 200
    assert enabled.json()["is_active"] is True


def test_room_summary_counts_are_computed(client, admin_headers):
    """房间数量由 DB COUNT 计算：总数 / 启用 / 停用。"""
    before = _summary(client, admin_headers)
    # 种子 28 房全部启用
    assert before["total_count"] == 28
    assert before["enabled_count"] == 28
    assert before["disabled_count"] == 0

    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9B2", std)
    mid = _summary(client, admin_headers)
    assert mid["total_count"] == 29
    assert mid["enabled_count"] == 29
    assert mid["disabled_count"] == 0

    client.post(f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers)
    after = _summary(client, admin_headers)
    assert after["total_count"] == 29
    assert after["enabled_count"] == 28
    assert after["disabled_count"] == 1
    # 数量恒等式：总数 = 启用 + 停用
    assert after["total_count"] == after["enabled_count"] + after["disabled_count"]


def test_list_rooms_is_active_filter(client, admin_headers):
    """列表支持 is_active 筛选。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9B3", std)
    client.post(f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers)

    enabled = client.get(
        "/api/v1/rooms",
        params={"is_active": "true", "page_size": 100},
        headers=admin_headers,
    ).json()
    assert all(r["is_active"] for r in enabled["items"])
    assert "9B3" not in {r["room_number"] for r in enabled["items"]}

    disabled = client.get(
        "/api/v1/rooms",
        params={"is_active": "false", "page_size": 100},
        headers=admin_headers,
    ).json()
    assert disabled["total"] == 1
    assert disabled["items"][0]["room_number"] == "9B3"


def test_disable_room_with_active_stay_409(client, admin_headers):
    """在住客房不得停用（必须先退房或换房）。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9B4", std)
    guest = create_guest(client, admin_headers, phone="13800139001")
    reservation = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=business_date(),
        check_out=business_date() + timedelta(days=2),
    )
    stay = _check_in(client, admin_headers, reservation["id"])

    resp = client.post(
        f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers
    )
    assert resp.status_code == 409
    assert "在住" in resp.json()["detail"]

    # 退房后可停用
    check_out(client, admin_headers, stay["id"])
    after = client.post(
        f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers
    )
    assert after.status_code == 200
    assert after.json()["is_active"] is False


def test_disable_room_via_patch_also_guarded(client, admin_headers):
    """PATCH is_active=false 走同一停用校验（不能绕过 service）。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9B5", std)
    guest = create_guest(client, admin_headers, phone="13800139002")
    reservation = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=business_date(),
        check_out=business_date() + timedelta(days=2),
    )
    _check_in(client, admin_headers, reservation["id"])
    resp = client.patch(
        f"/api/v1/rooms/{room['id']}",
        json={"is_active": False},
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert "在住" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# 停用房与可售性 / 历史数据
# ---------------------------------------------------------------------------


def test_disabled_room_not_sellable(client, admin_headers):
    """停用房间不出现在可售结果中，也不能新建预订。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9C1", std)
    guest = create_guest(client, admin_headers, phone="13800139003")
    check_in_date = business_date() + timedelta(days=10)
    check_out_date = business_date() + timedelta(days=12)

    avail = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": check_in_date.isoformat(),
            "check_out_date": check_out_date.isoformat(),
        },
        headers=admin_headers,
    ).json()
    item = next(i for i in avail["items"] if i["room_number"] == "9C1")
    assert item["available"] is True

    client.post(f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers)

    avail2 = client.get(
        "/api/v1/availability",
        params={
            "check_in_date": check_in_date.isoformat(),
            "check_out_date": check_out_date.isoformat(),
        },
        headers=admin_headers,
    ).json()
    item2 = next(i for i in avail2["items"] if i["room_number"] == "9C1")
    assert item2["available"] is False
    assert "停用" in item2["reason"]

    # 直接对该房下单 -> 409
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=check_in_date,
        check_out=check_out_date,
        expect=409,
    )


def test_disabled_room_reservation_still_readable_and_stay_completable(
    client, admin_headers
):
    """停用不破坏历史：已有预订仍可读；在住可正常退房。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9C2", std)
    guest = create_guest(client, admin_headers, phone="13800139004")
    reservation = create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=business_date(),
        check_out=business_date() + timedelta(days=3),
    )
    stay = _check_in(client, admin_headers, reservation["id"])

    # 在住期间不可停用（上面已覆盖）；这里验证：
    # 先退房 -> 停用 -> 历史预订/入住仍完整可读
    check_out(client, admin_headers, stay["id"])
    assert (
        client.post(
            f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers
        ).status_code
        == 200
    )

    res_detail = client.get(
        f"/api/v1/reservations/{reservation['id']}", headers=admin_headers
    )
    assert res_detail.status_code == 200
    assert res_detail.json()["status"] == "COMPLETED"
    assert res_detail.json()["room_number"] == "9C2"

    stay_detail = client.get(f"/api/v1/stays/{stay['id']}", headers=admin_headers)
    assert stay_detail.status_code == 200
    assert stay_detail.json()["status"] == "CHECKED_OUT"


# ---------------------------------------------------------------------------
# 历史房间保护（物理删除）
# ---------------------------------------------------------------------------


def test_delete_unreferenced_room_allowed(client, admin_headers):
    """从未被任何业务记录引用的房间可以安全删除。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9D1", std)
    resp = client.delete(f"/api/v1/rooms/{room['id']}", headers=admin_headers)
    assert resp.status_code == 204
    assert (
        client.get(f"/api/v1/rooms/{room['id']}", headers=admin_headers).status_code
        == 404
    )


def test_delete_room_with_reservation_409(client, admin_headers):
    """有预订历史的房间禁止物理删除（默认 UX = 停用）。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9D2", std)
    guest = create_guest(client, admin_headers, phone="13800139005")
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=business_date() + timedelta(days=20),
        check_out=business_date() + timedelta(days=22),
    )
    resp = client.delete(f"/api/v1/rooms/{room['id']}", headers=admin_headers)
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "9D2" in detail and "历史" in detail
    assert "停用" in detail
    # 房间仍然存在
    assert (
        client.get(f"/api/v1/rooms/{room['id']}", headers=admin_headers).status_code
        == 200
    )


def test_delete_seeded_room_with_history_409(client, admin_headers):
    """种子房（101）已有历史类记录时不得删除。"""
    room = find_room(client, admin_headers, "101")
    guest = create_guest(client, admin_headers, phone="13800139006")
    create_reservation(
        client,
        admin_headers,
        room=room,
        guest_id=guest["id"],
        check_in=business_date() + timedelta(days=30),
        check_out=business_date() + timedelta(days=32),
    )
    resp = client.delete(f"/api/v1/rooms/{room['id']}", headers=admin_headers)
    assert resp.status_code == 409


def test_room_type_room_count_includes_disabled_rooms(client, admin_headers):
    """房型 room_count 计算全部房间（含停用）—— 停用不丢历史房间记录。"""
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9D3", std)
    client.post(f"/api/v1/rooms/{room['id']}/disable", headers=admin_headers)
    row = next(
        r
        for r in client.get(
            "/api/v1/room-types", params={"page_size": 100}, headers=admin_headers
        ).json()["items"]
        if r["id"] == std
    )
    # 种子 4 间（101-104）+ 新增 1 间（停用后仍计入）
    assert row["room_count"] == 5


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "role,can_manage,can_delete",
    [
        # can_delete 单独一列：room:delete 不授予任何常规角色，仅 SUPER_ADMIN
        # 经 seed 动态全权限持有（MANAGER 亦无删除权）。
        ("SUPER_ADMIN", True, True),
        ("MANAGER", True, False),
        ("FRONT_DESK", False, False),
        ("FINANCE", False, False),
        ("HOUSEKEEPING", False, False),
        ("MAINTENANCE", False, False),
    ],
)
def test_room_inventory_manage_rbac(
    client, admin_headers, make_user, token_for, role, can_manage, can_delete
):
    """房间**主数据管理**按 room:inventory_manage 判定（不硬编码角色名）。

    alpha.9.6 QA DEF-1 修复：main() 与 room:write 分离 —— FRONT_DESK 虽持有
    room:write（房态操作），但**不得**新增/编辑/停用/启用房间主数据。
    """
    std = _std_room_type_id(client, admin_headers)
    target = _create_room(client, admin_headers, f"9E{role[:1]}", std)

    username = f"a96_inv_{role.lower()}"
    make_user(username, role_names=[role])
    headers = {"Authorization": f"Bearer {token_for(username)}"}

    # 读权限不受影响（room:read 全部角色都有）
    assert client.get("/api/v1/rooms", headers=headers).status_code == 200
    assert client.get("/api/v1/rooms/summary", headers=headers).status_code == 200

    create_resp = client.post(
        "/api/v1/rooms",
        json={"room_number": f"9F{role[:1]}", "room_type_id": std, "floor": 9},
        headers=headers,
    )
    put_resp = client.put(
        f"/api/v1/rooms/{target['id']}", json={"notes": "rbac"}, headers=headers
    )
    patch_resp = client.patch(
        f"/api/v1/rooms/{target['id']}", json={"notes": "rbac"}, headers=headers
    )
    disable_resp = client.post(
        f"/api/v1/rooms/{target['id']}/disable", headers=headers
    )
    enable_resp = client.post(
        f"/api/v1/rooms/{target['id']}/enable", headers=headers
    )
    if can_manage:
        assert create_resp.status_code == 201, create_resp.text
        assert put_resp.status_code == 200, put_resp.text
        assert patch_resp.status_code == 200, patch_resp.text
        assert disable_resp.status_code == 200, disable_resp.text
        assert disable_resp.json()["is_active"] is False
        assert enable_resp.status_code == 200, enable_resp.text
        assert enable_resp.json()["is_active"] is True
    else:
        # 主数据端点全部 403（含新增/编辑/停用/启用）
        assert create_resp.status_code == 403, create_resp.text
        assert put_resp.status_code == 403, put_resp.text
        assert patch_resp.status_code == 403, patch_resp.text
        assert disable_resp.status_code == 403, disable_resp.text
        assert enable_resp.status_code == 403, enable_resp.text

    # DELETE 需要 room:inventory_manage **且** room:delete：MANAGER 有前者但无后者，
    # 因此同样 403（既纳入主数据保护，又保持 room:delete 不授予常规角色）
    if can_delete:
        assert (
            client.delete(
                f"/api/v1/rooms/{target['id']}", headers=headers
            ).status_code
            == 204
        )
    else:
        assert (
            client.delete(
                f"/api/v1/rooms/{target['id']}", headers=headers
            ).status_code
            == 403
        )
        # 房间未被任何非授权角色改动
        assert (
            client.get(
                f"/api/v1/rooms/{target['id']}", headers=admin_headers
            ).json()["is_active"]
            is True
        )


def test_front_desk_keeps_daily_room_status_operation(
    client, admin_headers, make_user, token_for
):
    """[回归保护] FRONT_DESK 现有**房态操作**能力不得因权限拆分而回归。

    room:write 语义保持不变：POST /rooms/{id}/status 仍可用（合法转换 200）。
    本用例断言「拆分手数据权限 ≠ 削弱日常房态作业」。
    """
    std = _std_room_type_id(client, admin_headers)
    room = _create_room(client, admin_headers, "9G1", std)

    make_user("a96_fd_status", role_names=["FRONT_DESK"])
    headers = {"Authorization": f"Bearer {token_for('a96_fd_status')}"}

    # 房态变更（占用维度）仍允许
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"occupancy_status": "occupied"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["occupancy_status"] == "occupied"

    # 清洁维度同样允许（room:write 可改任意维度）
    resp = client.post(
        f"/api/v1/rooms/{room['id']}/status",
        json={"cleaning_status": "dirty"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["cleaning_status"] == "dirty"

    # 但主数据字段不可改（PATCH 403），房号保持原值
    assert (
        client.patch(
            f"/api/v1/rooms/{room['id']}",
            json={"room_number": "9G2"},
            headers=headers,
        ).status_code
        == 403
    )
    assert (
        client.get(f"/api/v1/rooms/{room['id']}", headers=admin_headers).json()[
            "room_number"
        ]
        == "9G1"
    )


def test_housekeeping_maintenance_room_status_permissions_unchanged(
    client, admin_headers, make_user, token_for
):
    """[回归保护] HOUSEKEEPING / MAINTENANCE 的细分房态权限不受本轮拆分影响。"""
    std = _std_room_type_id(client, admin_headers)
    room_hk = _create_room(client, admin_headers, "9H1", std)
    room_mt = _create_room(client, admin_headers, "9H2", std)

    make_user("a96_hk_status", role_names=["HOUSEKEEPING"])
    hk = {"Authorization": f"Bearer {token_for('a96_hk_status')}"}
    assert (
        client.post(
            f"/api/v1/rooms/{room_hk['id']}/status",
            json={"cleaning_status": "dirty"},
            headers=hk,
        ).status_code
        == 200
    )
    # 保洁不得改占用维度、不得改主数据
    assert (
        client.post(
            f"/api/v1/rooms/{room_hk['id']}/status",
            json={"occupancy_status": "occupied"},
            headers=hk,
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/v1/rooms/{room_hk['id']}", json={"notes": "x"}, headers=hk
        ).status_code
        == 403
    )

    make_user("a96_mt_status", role_names=["MAINTENANCE"])
    mt = {"Authorization": f"Bearer {token_for('a96_mt_status')}"}
    assert (
        client.post(
            f"/api/v1/rooms/{room_mt['id']}/status",
            json={"occupancy_status": "out_of_service"},
            headers=mt,
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/api/v1/rooms/{room_mt['id']}/status",
            json={"occupancy_status": "available"},
            headers=mt,
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/v1/rooms/{room_mt['id']}", json={"notes": "x"}, headers=mt
        ).status_code
        == 403
    )


def test_seed_room_permission_matrix(client, admin_headers):
    """[QA §6] seed 后矩阵正确：`room:inventory_manage` 只授予 SUPER_ADMIN / MANAGER。

    直接读 seed 落库的真实角色→权限（唯一授权来源），不硬编码角色名判断逻辑；
    同时锁住 `room:write` / `room:delete` 的既有分布，防止权限拆分时被顺手改掉。
    （「seed 前无新权限授权」由 test_alpha96_migration 断言；
      「second seed idempotent」由既有 seed 快照测试断言。）
    """
    resp = client.get(
        "/api/v1/roles", params={"page_size": 100}, headers=admin_headers
    )
    assert resp.status_code == 200
    matrix = {
        role["name"]: {p["code"] for p in role["permissions"]}
        for role in resp.json()["items"]
    }
    assert set(matrix) == {
        "SUPER_ADMIN",
        "MANAGER",
        "FRONT_DESK",
        "HOUSEKEEPING",
        "MAINTENANCE",
        "FINANCE",
    }

    # 房间主数据管理：仅 SUPER_ADMIN / MANAGER
    expected_inventory = {
        "SUPER_ADMIN": True,
        "MANAGER": True,
        "FRONT_DESK": False,
        "HOUSEKEEPING": False,
        "MAINTENANCE": False,
        "FINANCE": False,
    }
    for role, allowed in expected_inventory.items():
        assert ("room:inventory_manage" in matrix[role]) is allowed, (
            f"{role} 的 room:inventory_manage 授权与预期不符"
        )

    # 日常房态操作权限分布未变（FRONT_DESK / MANAGER 持有 = alpha.9.4 语义）
    for role in ("SUPER_ADMIN", "MANAGER", "FRONT_DESK"):
        assert "room:write" in matrix[role]
    for role in ("HOUSEKEEPING", "MAINTENANCE", "FINANCE"):
        assert "room:write" not in matrix[role]

    # room:delete 仍不授予任何常规角色（仅 SUPER_ADMIN 经动态全权限持有）
    for role in (
        "MANAGER",
        "FRONT_DESK",
        "HOUSEKEEPING",
        "MAINTENANCE",
        "FINANCE",
    ):
        assert "room:delete" not in matrix[role]
    assert "room:delete" in matrix["SUPER_ADMIN"]
