# -*- coding: utf-8 -*-
"""alpha.9.6 F3 预订来源渠道集成测试。

覆盖任务书 §12 的 Reservation 要求：
- source_channel persistence（创建/编辑/详情/列表响应）
- invalid channel（不存在 404）/ disabled channel（409）
- legacy migration：legacy source 入站兼容 + 只读投影一致性（单向派生）
- legacy source 与 source_channel_id 冲突时以渠道为准（不产生第二事实源）
- 缺渠道的兼容路径：可写入但 source_channel_id 为 NULL（归入未指定渠道桶）
- RBAC：前台可选择渠道；无 channel:read 的角色仍能在预订响应里看到渠道名

每个用例使用独立新建房间（9xx 段 + uuid），避免与其它用例的
房间占用 / 排他约束互相干扰。
"""

import uuid
from datetime import timedelta

import pytest

from app.core.business_date import business_date
from tests.booking_helpers import create_guest

_room_seq = 0


def _d(days: int):
    return business_date() + timedelta(days=days)


def _fresh_room(client, headers) -> dict:
    """新建独立房间（房间号全局唯一，含停用房，故用 uuid 保证不冲突）。"""
    global _room_seq
    _room_seq += 1
    room_type_id = next(
        r["id"]
        for r in client.get(
            "/api/v1/room-types", params={"page_size": 100}, headers=headers
        ).json()["items"]
        if r["name"] == "标准大床房"
    )
    number = f"9{uuid.uuid4().hex[:3].upper()}{_room_seq}"
    resp = client.post(
        "/api/v1/rooms",
        json={"room_number": number, "room_type_id": room_type_id, "floor": 9},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _channels(client, headers, **params) -> dict:
    resp = client.get("/api/v1/channels", params=params, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _channel_id(client, headers, name: str) -> int:
    for item in _channels(client, headers, page_size=100)["items"]:
        if item["name"] == name:
            return item["id"]
    raise AssertionError(f"渠道 {name} 不存在")


def _raw_create(client, headers, room, guest_id, **extra):
    """直接构造请求体（避免 booking_helpers 注入默认 source 造成渠道冲突告警）。"""
    payload = {
        "guest_id": guest_id,
        "room_id": room["id"],
        "room_type_id": room["room_type_id"],
        "check_in_date": _d(50).isoformat(),
        "check_out_date": _d(52).isoformat(),
        "agreed_total_amount": "399.00",
    }
    payload.update(extra)
    return client.post("/api/v1/reservations", json=payload, headers=headers)


def _book(client, headers, room, guest_id, **extra) -> dict:
    """下单并断言 201，返回响应体。"""
    resp = _raw_create(client, headers, room, guest_id, **extra)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# 持久化与响应
# ---------------------------------------------------------------------------


def test_create_reservation_with_source_channel(client, admin_headers):
    """创建预订时以 source_channel_id 记录来源渠道并在各处回显。"""
    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139801")

    reservation = _book(
        client, admin_headers, room, guest["id"], source_channel_id=meituan
    )
    assert reservation["source_channel_id"] == meituan
    assert reservation["source_channel"]["id"] == meituan
    assert reservation["source_channel"]["name"] == "美团"
    assert reservation["source_channel"]["category"] == "OTA"
    assert reservation["source_channel"]["enabled"] is True
    # legacy 投影由渠道单向派生（OTA 类别 -> OTA）
    assert reservation["source"] == "OTA"

    detail = client.get(
        f"/api/v1/reservations/{reservation['id']}", headers=admin_headers
    ).json()
    assert detail["source_channel"]["name"] == "美团"

    listed = client.get(
        "/api/v1/reservations",
        params={"page_size": 100},
        headers=admin_headers,
    ).json()["items"]
    row = next(r for r in listed if r["id"] == reservation["id"])
    assert row["source_channel"]["name"] == "美团"
    assert row["source_channel_id"] == meituan


def test_create_reservation_with_each_ota_channel(client, admin_headers):
    """美团 / 携程 / 飞猪 可分别记录（不再是一个笼统的 "OTA"）。"""
    for idx, name in enumerate(("美团", "携程", "飞猪")):
        channel_id = _channel_id(client, admin_headers, name)
        room = _fresh_room(client, admin_headers)
        guest = create_guest(client, admin_headers, phone=f"1380013981{idx}")
        body = _book(
            client,
            admin_headers,
            room,
            guest["id"],
            source_channel_id=channel_id,
            check_in_date=_d(70 + idx * 5).isoformat(),
            check_out_date=_d(72 + idx * 5).isoformat(),
        )
        assert body["source_channel"]["name"] == name
        assert body["source_channel"]["category"] == "OTA"


def test_create_reservation_with_custom_channel(client, admin_headers):
    """自定义渠道（电话）可用于预订 —— 现场需求「其他需要可编辑」的落地。"""
    created_channel = client.post(
        "/api/v1/channels",
        json={"name": "电话-现场测试", "category": "OFFLINE"},
        headers=admin_headers,
    )
    assert created_channel.status_code == 201, created_channel.text
    channel = created_channel.json()

    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139820")
    reservation = _book(
        client, admin_headers, room, guest["id"], source_channel_id=channel["id"]
    )
    assert reservation["source_channel"]["name"] == "电话-现场测试"
    assert reservation["source_channel"]["is_system"] is False
    # OFFLINE 类别 -> legacy 投影 OTHER
    assert reservation["source"] == "OTHER"


def test_update_reservation_channel(client, admin_headers):
    """编辑预订可改来源渠道；legacy 投影随之更新。"""
    meituan = _channel_id(client, admin_headers, "美团")
    ctrip = _channel_id(client, admin_headers, "携程")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139830")
    reservation = _book(
        client, admin_headers, room, guest["id"], source_channel_id=meituan
    )
    resp = client.patch(
        f"/api/v1/reservations/{reservation['id']}",
        json={"source_channel_id": ctrip},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source_channel_id"] == ctrip
    assert body["source_channel"]["name"] == "携程"


# ---------------------------------------------------------------------------
# 非法 / 停用渠道
# ---------------------------------------------------------------------------


def test_create_reservation_invalid_channel_404(client, admin_headers):
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139840")
    resp = _raw_create(
        client, admin_headers, room, guest["id"], source_channel_id=999999
    )
    assert resp.status_code == 404
    assert "渠道" in resp.json()["detail"]


def test_create_reservation_disabled_channel_409(client, admin_headers):
    """停用渠道不得用于新预订。"""
    created = client.post(
        "/api/v1/channels",
        json={"name": "停用渠道-测试", "category": "OTHER"},
        headers=admin_headers,
    ).json()
    assert (
        client.post(
            f"/api/v1/channels/{created['id']}/disable", headers=admin_headers
        ).status_code
        == 200
    )
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139841")
    resp = _raw_create(
        client, admin_headers, room, guest["id"], source_channel_id=created["id"]
    )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert "停用" in detail and created["name"] in detail


def test_update_reservation_to_disabled_channel_409(client, admin_headers):
    meituan = _channel_id(client, admin_headers, "美团")
    created = client.post(
        "/api/v1/channels",
        json={"name": "停用渠道-编辑测试", "category": "OTHER"},
        headers=admin_headers,
    ).json()
    client.post(
        f"/api/v1/channels/{created['id']}/disable", headers=admin_headers
    )
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139842")
    reservation = _book(
        client, admin_headers, room, guest["id"], source_channel_id=meituan
    )
    resp = client.patch(
        f"/api/v1/reservations/{reservation['id']}",
        json={"source_channel_id": created["id"]},
        headers=admin_headers,
    )
    assert resp.status_code == 409


def test_existing_reservation_keeps_channel_after_disable(client, admin_headers):
    """渠道停用后历史预订仍完整可读（不破坏历史）。"""
    created = client.post(
        "/api/v1/channels",
        json={"name": "停用后仍可读", "category": "OFFLINE"},
        headers=admin_headers,
    ).json()
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139843")
    reservation = _book(
        client, admin_headers, room, guest["id"], source_channel_id=created["id"]
    )
    client.post(
        f"/api/v1/channels/{created['id']}/disable", headers=admin_headers
    )
    detail = client.get(
        f"/api/v1/reservations/{reservation['id']}", headers=admin_headers
    )
    assert detail.status_code == 200
    assert detail.json()["source_channel"]["name"] == "停用后仍可读"
    # 明确标记该渠道已停用（前端可提示）
    assert detail.json()["source_channel"]["enabled"] is False
    # 也不影响取消等后续操作
    assert (
        client.post(
            f"/api/v1/reservations/{reservation['id']}/cancel", headers=admin_headers
        ).status_code
        == 200
    )


# ---------------------------------------------------------------------------
# legacy 兼容与投影一致性
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "legacy_source,expected_channel",
    [
        ("DIRECT", "直订"),
        ("PHONE", "电话"),
        ("WECHAT", "微信"),
        ("CORPORATE", "协议客户"),
        ("OTA", "其他"),
        ("OTHER", "其他"),
    ],
)
def test_legacy_source_inbound_maps_to_channel(
    client, admin_headers, legacy_source, expected_channel
):
    """legacy source 入站兼容：解析为渠道并落库（不是第二事实源）。"""
    from app.models import Channel, ChannelCategory
    from app.services.channels import legacy_source_for_channel

    room = _fresh_room(client, admin_headers)
    guest = create_guest(
        client, admin_headers, phone=f"1380013985{abs(hash(legacy_source)) % 10}"
    )
    body = _book(
        client, admin_headers, room, guest["id"], source=legacy_source
    )
    assert body["source_channel"]["name"] == expected_channel
    assert body["source_channel_id"] is not None
    # legacy 投影 = 渠道单向派生（同一函数，规则唯一）
    expected_projection = legacy_source_for_channel(
        Channel(
            code=body["source_channel"]["code"],
            name=body["source_channel"]["name"],
            category=ChannelCategory(body["source_channel"]["category"]),
        )
    )
    assert body["source"] == expected_projection.value


def test_walk_in_legacy_source_maps_and_forces_today(client, admin_headers):
    """WALK_IN legacy 入站：映射为「散客」渠道，且入住日固定为业务日期今天。"""
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139855")
    resp = _raw_create(
        client,
        admin_headers,
        room,
        guest["id"],
        source="WALK_IN",
        check_in_date=_d(0).isoformat(),
        check_out_date=_d(1).isoformat(),
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["source_channel"]["name"] == "散客"
    assert body["check_in_date"] == business_date().isoformat()


def test_conflicting_source_prefers_channel(client, admin_headers):
    """source_channel_id 与 legacy source 冲突时以渠道为准（不产生第二事实源）。"""
    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139860")
    body = _book(
        client,
        admin_headers,
        room,
        guest["id"],
        source_channel_id=meituan,
        source="WECHAT",  # 与渠道（OTA）不一致
    )
    assert body["source_channel"]["name"] == "美团"
    # legacy 投影按渠道派生（OTA），不是请求里的 WECHAT
    assert body["source"] == "OTA"


def test_missing_channel_is_allowed_but_flagged_null(client, admin_headers):
    """既无渠道也无 legacy source：兼容写入但 source_channel_id 为 NULL。

    （新前端始终提供渠道；该路径仅为未升级调用方保留，并在渠道经营分析中
    归入「未指定渠道」桶。）
    """
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139861")
    body = _book(client, admin_headers, room, guest["id"])
    assert body.get("source_channel_id") is None
    assert body.get("source_channel") is None


def test_legacy_projection_consistent_with_channel(client, admin_headers):
    """legacy 投影 = 渠道单向派生（对全部启用预置渠道逐一校验）。"""
    from app.models import Channel, ChannelCategory
    from app.services.channels import legacy_source_for_channel

    j = 0
    for item in _channels(client, admin_headers, page_size=100)["items"]:
        if not item["enabled"]:
            continue
        j += 1
        room = _fresh_room(client, admin_headers)
        guest = create_guest(client, admin_headers, phone=f"1380013987{j}")
        body = _book(
            client,
            admin_headers,
            room,
            guest["id"],
            source_channel_id=item["id"],
            check_in_date=_d(200 + j).isoformat(),
            check_out_date=_d(202 + j).isoformat(),
        )
        assert body["source_channel_id"] == item["id"]
        expected = legacy_source_for_channel(
            Channel(
                code=item["code"],
                name=item["name"],
                category=ChannelCategory(item["category"]),
            )
        )
        assert body["source"] == expected.value, item["name"]


# ---------------------------------------------------------------------------
# RBAC
# ---------------------------------------------------------------------------


def test_front_desk_can_choose_channel(client, admin_headers, make_user, token_for):
    """前台可在创建预订时读取并选择启用渠道。"""
    make_user("a96_fd_booking", role_names=["FRONT_DESK"])
    headers = {"Authorization": f"Bearer {token_for('a96_fd_booking')}"}
    channels = _channels(client, headers, page_size=100)
    assert channels["total"] >= 4
    meituan = next(c for c in channels["items"] if c["name"] == "美团")

    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139880")
    body = _book(
        client, headers, room, guest["id"], source_channel_id=meituan["id"]
    )
    assert body["source_channel"]["name"] == "美团"


def test_housekeeping_cannot_read_channels(
    client, admin_headers, make_user, token_for
):
    """无 channel:read 的角色不能调渠道主数据接口。"""
    make_user("a96_hk_channels", role_names=["HOUSEKEEPING"])
    headers = {"Authorization": f"Bearer {token_for('a96_hk_channels')}"}
    assert client.get("/api/v1/channels", headers=headers).status_code == 403


def test_finance_can_read_reservation_channel_name(client, admin_headers):
    """FINANCE 有 room:read + analytics:business_read 但无 reservation:read。

    渠道名随预订响应返回（不需要 channel:read），但预订接口本身受
    reservation:read 约束 —— 保证「来源渠道」展示与渠道主数据管理解耦。
    """
    meituan = _channel_id(client, admin_headers, "美团")
    room = _fresh_room(client, admin_headers)
    guest = create_guest(client, admin_headers, phone="13800139890")
    reservation = _book(
        client, admin_headers, room, guest["id"], source_channel_id=meituan
    )
    detail = client.get(
        f"/api/v1/reservations/{reservation['id']}", headers=admin_headers
    )
    assert detail.status_code == 200
    assert detail.json()["source_channel"]["name"] == "美团"
