# -*- coding: utf-8 -*-
"""Maintenance PII 隔离测试（Sprint 5 §30）：

MaintenanceWorkOrder 不复制 Guest PII —— 不保存 Guest name / phone / email /
reservation amount / Guest notes；不关联 guest_id / reservation_id / stay_id。
维修人员不因 Maintenance 权限获得 Guest PII。
"""

from sqlalchemy import select

from app.models import AuditLog
from tests.booking_helpers import find_room
from tests.mwo_helpers import create_order, list_orders

# Guest PII 可辨识标记值（任何响应 / 审计中不得出现）
_PII_MARKERS = ("13800138000", "zhang@example.com", "张先生", "399.00")


def _assert_no_pii_markers(text: str) -> None:
    for marker in _PII_MARKERS:
        assert marker not in text, f"泄漏 PII 标记: {marker}"


def test_order_response_has_no_guest_pii(client, admin_headers):
    """工单创建/详情/列表响应不含任何 Guest PII 字段与标记。"""
    room = find_room(client, admin_headers, "301")
    order = create_order(
        client,
        admin_headers,
        room_id=room["id"],
        title="空调维修",
        description="客人反馈不制冷",
    )
    import json

    detail = client.get(
        f"/api/v1/maintenance/orders/{order['id']}", headers=admin_headers
    )
    assert detail.status_code == 200
    _assert_no_pii_markers(json.dumps(detail.json(), ensure_ascii=False))
    # 无 Guest / Reservation 关联字段
    for key in detail.json():
        assert "guest" not in key
        assert "reservation" not in key
        assert "stay" not in key
        assert "amount" not in key
        assert "phone" not in key
        assert "email" not in key

    result = list_orders(client, admin_headers, room_id=room["id"])
    _assert_no_pii_markers(json.dumps(result, ensure_ascii=False))


def test_maintenance_audit_has_no_pii(client, admin_headers, db):
    """Maintenance 审计 details 不含任何 Guest PII。"""
    import json

    room = find_room(client, admin_headers, "302")
    order = create_order(
        client, admin_headers, room_id=room["id"], title="审计无 PII"
    )
    logs = db.scalars(
        select(AuditLog).where(
            AuditLog.action == "maintenance.create",
            AuditLog.resource_id == order["id"],
        )
    ).all()
    assert logs
    _assert_no_pii_markers(json.dumps(logs[0].details, ensure_ascii=False))


def test_maintenance_role_cannot_read_guest_pii(client, admin_headers, make_user, token_for):
    """MAINTENANCE 角色不因维修权限获得 Guest PII：
    Booking PII 出口（guests / reservations / stays / availability）全部 403。"""
    from tests.booking_helpers import create_guest, create_reservation, find_room

    guest = create_guest(client, admin_headers, name="维修PII客人", phone="13911112222")
    room = find_room(client, admin_headers, "303")
    create_reservation(client, admin_headers, room=room, guest_id=guest["id"])

    make_user("mwo_pii_worker", role_names=["MAINTENANCE"])
    headers = {"Authorization": f"Bearer {token_for('mwo_pii_worker')}"}

    for path in (
        "/api/v1/guests",
        "/api/v1/reservations",
        "/api/v1/stays",
        "/api/v1/availability?check_in_date=2026-01-01&check_out_date=2026-01-02",
    ):
        resp = client.get(path, headers=headers)
        assert resp.status_code == 403, f"{path} 应 403（无 Guest PII 出口）"

    # 但维修工单本身可读（且内容无 PII）
    orders = client.get("/api/v1/maintenance/orders", headers=headers)
    assert orders.status_code == 200
