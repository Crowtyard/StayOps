# -*- coding: utf-8 -*-
"""alpha.9.6 F3 客源渠道主数据测试。

覆盖任务书 §12 的 Channel 要求：
- defaults（美团 / 携程 / 飞猪 / 其他 预置存在且为系统渠道）
- custom create / edit / disable / enable
- duplicate name policy（含停用渠道不释放名称）
- 系统渠道名称固定、不可删除；自定义渠道可改名
- 已被 Reservation 引用的自定义渠道不可删除（默认 UX = 停用）
- RBAC：channel:read 可选渠道；channel:write 才可管理
- seed 与 migration 的预置渠道表一致（防止两处漂移）
"""

import importlib.util
import uuid
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
MIGRATION_FILE = (
    BACKEND_DIR
    / "alembic"
    / "versions"
    / "a96b1c4d7e02_add_room_management_and_channels.py"
)

REQUIRED_DEFAULT_NAMES = {"美团", "携程", "飞猪", "其他"}


def _uniq(prefix: str) -> str:
    """唯一渠道名（避免与同会话其它用例冲突）。"""
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _list(client, headers, **params) -> dict:
    resp = client.get("/api/v1/channels", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _find_by_name(client, headers, name: str, **params) -> dict | None:
    for item in _list(client, headers, page_size=100, **params)["items"]:
        if item["name"] == name:
            return item
    return None


def _create(client, headers, name, **extra):
    payload = {"name": name}
    payload.update(extra)
    return client.post("/api/v1/channels", json=payload, headers=headers)


# ---------------------------------------------------------------------------
# 默认渠道
# ---------------------------------------------------------------------------


def test_default_channels_present(client, admin_headers):
    """默认至少存在 美团 / 携程 / 飞猪 / 其他，且为系统预置渠道。"""
    body = _list(client, admin_headers, page_size=100)
    by_name = {c["name"]: c for c in body["items"]}
    assert REQUIRED_DEFAULT_NAMES <= set(by_name)
    for name in REQUIRED_DEFAULT_NAMES:
        assert by_name[name]["is_system"] is True
        assert by_name[name]["enabled"] is True
        assert by_name[name]["code"]


def test_default_channel_categories(client, admin_headers):
    """OTA 渠道类别正确（美团/携程/飞猪 = OTA）。"""
    for name in ("美团", "携程", "飞猪"):
        channel = _find_by_name(client, admin_headers, name)
        assert channel is not None, name
        assert channel["category"] == "OTA"
    assert _find_by_name(client, admin_headers, "其他")["category"] == "OTHER"


def test_channels_sorted_by_sort_order(client, admin_headers):
    """列表按 sort_order 稳定排序（美团/携程/飞猪 在前）。"""
    items = _list(client, admin_headers, page_size=100)["items"]
    orders = [c["sort_order"] for c in items]
    assert orders == sorted(orders)
    names = [c["name"] for c in items]
    assert names.index("美团") < names.index("携程") < names.index("飞猪")


def test_channel_list_enabled_filter(client, admin_headers):
    """默认只返回启用渠道；enabled=false 只看停用；include_disabled 看全部。"""
    name = _uniq("渠道筛选")
    created = _create(client, admin_headers, name).json()
    client.post(f"/api/v1/channels/{created['id']}/disable", headers=admin_headers)

    default_names = {c["name"] for c in _list(client, admin_headers, page_size=100)["items"]}
    assert name not in default_names

    disabled = _list(
        client, admin_headers, enabled="false", page_size=100
    )["items"]
    assert name in {c["name"] for c in disabled}

    all_names = {
        c["name"]
        for c in _list(
            client, admin_headers, include_disabled="true", page_size=100
        )["items"]
    }
    assert name in all_names


# ---------------------------------------------------------------------------
# 新增 / 编辑 / 停用 / 启用
# ---------------------------------------------------------------------------


def test_create_custom_channel(client, admin_headers):
    """新增自定义渠道（任务书示例：电话 / 抖音 / 小红书 / 途家 …）。"""
    name = _uniq("抖音")
    resp = _create(client, admin_headers, name, category="OTA", sort_order=55)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == name
    assert body["category"] == "OTA"
    assert body["enabled"] is True
    assert body["is_system"] is False
    assert body["code"].startswith("CUSTOM_")
    # code 不含中文（稳定机器标识）
    assert body["code"].isascii()


def test_create_channel_trims_whitespace_and_rejects_blank(client, admin_headers):
    name = _uniq("  途家  ")
    resp = _create(client, admin_headers, name)
    assert resp.status_code == 201
    assert resp.json()["name"] == name.strip()

    assert _create(client, admin_headers, "   ").status_code == 422
    assert _create(client, admin_headers, "").status_code == 422


def test_create_duplicate_channel_name_409(client, admin_headers):
    """渠道名称重复 -> 409（默认渠道名同样不可重复使用）。"""
    resp = _create(client, admin_headers, "美团")
    assert resp.status_code == 409
    assert "已存在" in resp.json()["detail"]

    name = _uniq("重复渠道")
    assert _create(client, admin_headers, name).status_code == 201
    resp2 = _create(client, admin_headers, name)
    assert resp2.status_code == 409


def test_disabled_channel_name_not_released(client, admin_headers):
    """停用渠道不释放名称（避免经营分析出现同名渠道）。"""
    name = _uniq("停用占用名")
    created = _create(client, admin_headers, name).json()
    client.post(f"/api/v1/channels/{created['id']}/disable", headers=admin_headers)
    resp = _create(client, admin_headers, name)
    assert resp.status_code == 409


def test_edit_custom_channel_name(client, admin_headers):
    """自定义渠道可改名；code 不变。"""
    name = _uniq("改名前")
    created = _create(client, admin_headers, name).json()
    new_name = _uniq("改名后")
    resp = client.patch(
        f"/api/v1/channels/{created['id']}",
        json={"name": new_name, "category": "DIRECT", "sort_order": 77},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == new_name
    assert body["category"] == "DIRECT"
    assert body["sort_order"] == 77
    assert body["code"] == created["code"]  # code 稳定


def test_edit_duplicate_name_409(client, admin_headers):
    created = _create(client, admin_headers, _uniq("改名前")).json()
    resp = client.patch(
        f"/api/v1/channels/{created['id']}",
        json={"name": "携程"},
        headers=admin_headers,
    )
    assert resp.status_code == 409


def test_system_channel_name_is_fixed(client, admin_headers):
    """系统预置渠道名称固定：改名 409，仅允许启用/停用。"""
    meituan = _find_by_name(client, admin_headers, "美团")
    resp = client.patch(
        f"/api/v1/channels/{meituan['id']}",
        json={"name": "美团外卖"},
        headers=admin_headers,
    )
    assert resp.status_code == 409
    assert "系统预置渠道" in resp.json()["detail"]
    # 名称未变
    assert _find_by_name(client, admin_headers, "美团") is not None


def test_other_channel_can_be_renamed(client, admin_headers):
    """「其他」由迁移预置但允许本地化改名（code 固定保证归属稳定）。"""
    other = _find_by_name(client, admin_headers, "其他")
    new_name = _uniq("其他渠道")
    resp = client.patch(
        f"/api/v1/channels/{other['id']}",
        json={"name": new_name},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == new_name
    assert resp.json()["code"] == other["code"]
    # 复原（本会话共享数据库，保持默认渠道名可用）
    client.patch(
        f"/api/v1/channels/{other['id']}",
        json={"name": "其他"},
        headers=admin_headers,
    )


def test_disable_and_enable_channel(client, admin_headers):
    """停用 / 启用幂等；停用后记录仍存在。"""
    created = _create(client, admin_headers, _uniq("启停渠道")).json()

    disabled = client.post(
        f"/api/v1/channels/{created['id']}/disable", headers=admin_headers
    )
    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False

    again = client.post(
        f"/api/v1/channels/{created['id']}/disable", headers=admin_headers
    )
    assert again.status_code == 200
    assert again.json()["enabled"] is False

    enabled = client.post(
        f"/api/v1/channels/{created['id']}/enable", headers=admin_headers
    )
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True


def test_system_channel_can_be_disabled(client, admin_headers):
    """系统预置渠道可停用（不可删除、不可改名）。"""
    name = _uniq("飞猪")  # 用自定义渠道验证语义一致性
    created = _create(client, admin_headers, name, category="OTA").json()
    resp = client.post(
        f"/api/v1/channels/{created['id']}/disable", headers=admin_headers
    )
    assert resp.status_code == 200
    assert resp.json()["enabled"] is False


def test_empty_patch_422(client, admin_headers):
    created = _create(client, admin_headers, _uniq("空PATCH")).json()
    resp = client.patch(
        f"/api/v1/channels/{created['id']}", json={}, headers=admin_headers
    )
    assert resp.status_code == 422


def test_channel_404(client, admin_headers):
    assert client.get("/api/v1/channels/999999", headers=admin_headers).status_code == 404
    assert (
        client.patch(
            "/api/v1/channels/999999", json={"enabled": False}, headers=admin_headers
        ).status_code
        == 404
    )


# ---------------------------------------------------------------------------
# 删除策略
# ---------------------------------------------------------------------------


def test_delete_unreferenced_custom_channel(client, admin_headers):
    created = _create(client, admin_headers, _uniq("可删渠道")).json()
    resp = client.delete(f"/api/v1/channels/{created['id']}", headers=admin_headers)
    assert resp.status_code == 204
    assert (
        client.get(
            f"/api/v1/channels/{created['id']}", headers=admin_headers
        ).status_code
        == 404
    )


def test_system_channel_delete_409(client, admin_headers):
    """系统预置渠道不可彻底删除。"""
    meituan = _find_by_name(client, admin_headers, "美团")
    resp = client.delete(f"/api/v1/channels/{meituan['id']}", headers=admin_headers)
    assert resp.status_code == 409
    assert "系统预置渠道" in resp.json()["detail"]


def test_delete_referenced_channel_409(client, admin_headers, db):
    """已被预订引用的自定义渠道不可删除（历史来源必须可回溯）。"""
    from datetime import timedelta
    from decimal import Decimal

    from app.core.business_date import business_date
    from app.models import Guest, Reservation, ReservationSource, ReservationStatus
    from tests.booking_helpers import find_room

    channel = _create(client, admin_headers, _uniq("被引用渠道")).json()
    room = find_room(client, admin_headers, "302")
    guest = Guest(name="渠道引用测试客人", phone="13800139501")
    db.add(guest)
    db.flush()
    db.add(
        Reservation(
            reservation_no=f"RSVCH-{uuid.uuid4().hex[:8]}",
            guest_id=guest.id,
            room_id=room["id"],
            room_type_id=room["room_type_id"],
            check_in_date=business_date() + timedelta(days=40),
            check_out_date=business_date() + timedelta(days=42),
            status=ReservationStatus.CONFIRMED,
            source=ReservationSource.OTA,
            source_channel_id=channel["id"],
            agreed_total_amount=Decimal("399.00"),
        )
    )
    db.flush()

    resp = client.delete(f"/api/v1/channels/{channel['id']}", headers=admin_headers)
    assert resp.status_code == 409
    assert "停用" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "role,can_read,can_write",
    [
        ("MANAGER", True, True),
        ("FRONT_DESK", True, False),
        ("FINANCE", False, False),
        ("HOUSEKEEPING", False, False),
        ("MAINTENANCE", False, False),
    ],
)
def test_channel_rbac(client, admin_headers, make_user, token_for, role, can_read, can_write):
    """channel:read 可选渠道；channel:write 才可管理（不硬编码角色名）。"""
    meituan = _find_by_name(client, admin_headers, "美团")
    assert meituan is not None
    meituan_id = meituan["id"]

    username = f"a96_ch_{role.lower()}"
    make_user(username, role_names=[role])
    headers = {"Authorization": f"Bearer {token_for(username)}"}

    list_resp = client.get("/api/v1/channels", headers=headers)
    create_resp = client.post(
        "/api/v1/channels",
        json={"name": _uniq(f"rbac_{role}")},
        headers=headers,
    )
    patch_resp = client.patch(
        f"/api/v1/channels/{meituan_id}", json={"sort_order": 11}, headers=headers
    )
    disable_resp = client.post(
        f"/api/v1/channels/{meituan_id}/disable", headers=headers
    )
    delete_resp = client.delete(
        f"/api/v1/channels/{meituan_id}", headers=headers
    )

    if can_read:
        assert list_resp.status_code == 200, list_resp.text
    else:
        assert list_resp.status_code == 403
    if can_write:
        assert create_resp.status_code == 201, create_resp.text
    else:
        assert create_resp.status_code == 403
    assert patch_resp.status_code == (200 if can_write else 403)
    assert disable_resp.status_code == (200 if can_write else 403)
    # 系统渠道删除：有权限者 409（系统渠道不可删除），无权限者 403
    assert delete_resp.status_code == (409 if can_write else 403)
    # 复原美团排序与启用状态（本会话共享数据库）
    if can_write:
        client.patch(
            f"/api/v1/channels/{meituan_id}", json={"sort_order": 10}, headers=admin_headers
        )
        client.post(f"/api/v1/channels/{meituan_id}/enable", headers=admin_headers)


def test_front_desk_channel_read_does_not_grant_business_analytics(
    client, make_user, token_for
):
    """前台可选渠道，但不因此获得渠道收入/经营分析权限。"""
    username = "a96_ch_fd_scope"
    make_user(username, role_names=["FRONT_DESK"])
    headers = {"Authorization": f"Bearer {token_for(username)}"}
    assert client.get("/api/v1/channels", headers=headers).status_code == 200

    me = client.get("/api/v1/auth/me", headers=headers).json()
    codes = set(me["permissions"])
    assert "channel:read" in codes
    assert "channel:write" not in codes
    assert "analytics:business_read" not in codes
    assert "analytics:operations_read" in codes


# ---------------------------------------------------------------------------
# 一致性：seed 与 migration 的预置渠道表必须一致
# ---------------------------------------------------------------------------


def test_seed_and_migration_channel_tables_match():
    """防止 seed.py 与 migration 的 SYSTEM_CHANNELS 漂移（双处定义的守护）。"""
    from app.seed import SYSTEM_CHANNELS as SEED_CHANNELS

    spec = importlib.util.spec_from_file_location("a96_migration", MIGRATION_FILE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert SEED_CHANNELS == module.SYSTEM_CHANNELS


def test_service_and_migration_legacy_mapping_match():
    """防止 service 的 legacy 入站映射与 migration 回填映射漂移。

    两处必须是同一个映射：migration 决定历史数据落到哪个渠道，
    service 决定旧客户端传 source 时落到哪个渠道 —— 不一致会造成
    同一 legacy 值在不同时点归因到不同渠道。
    """
    from app.services.channels import LEGACY_SOURCE_TO_CHANNEL_CODE as SVC_MAP

    spec = importlib.util.spec_from_file_location("a96_migration", MIGRATION_FILE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    mig_map = module.LEGACY_SOURCE_TO_CHANNEL_CODE

    assert {
        k.value: v for k, v in SVC_MAP.items()
    } == mig_map
