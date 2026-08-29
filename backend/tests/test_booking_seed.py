# -*- coding: utf-8 -*-
"""Seed 幂等性测试：连续执行两次收敛；Booking 权限与角色映射正确（总纲 §8）。"""

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Permission, Role, RolePermission

BOOKING_CODES = {
    "guest:read",
    "guest:write",
    "reservation:read",
    "reservation:write",
    "reservation:cancel",
    "reservation:no_show",
    "stay:read",
    "stay:check_in",
    "stay:check_out",
}


def _snapshot() -> dict:
    session = SessionLocal()
    try:
        perms = {p.code: p.id for p in session.scalars(select(Permission))}
        mapping: dict[str, set[str]] = {}
        for role in session.scalars(select(Role)):
            codes = {
                p.code
                for p in session.scalars(
                    select(Permission)
                    .join(
                        RolePermission,
                        RolePermission.permission_id == Permission.id,
                    )
                    .where(RolePermission.role_id == role.id)
                )
            }
            mapping[role.name] = codes
        return {
            "permissions": len(perms),
            "roles": len(mapping),
            "mapping": mapping,
        }
    finally:
        session.close()


def test_seed_idempotent_and_booking_role_mapping(_database):
    from app.seed import seed

    seed()
    first = _snapshot()
    seed()
    second = _snapshot()
    assert first == second, "连续执行两次 seed 必须收敛到一致状态"

    assert first["permissions"] == 50  # 48（S7）+ Sprint 8 Analytics 的 2
    mapping = first["mapping"]
    # Sprint 8 §34：Analytics 权限码与矩阵
    assert {"analytics:operations_read", "analytics:business_read"} <= mapping["MANAGER"]
    assert "analytics:operations_read" in mapping["FRONT_DESK"]
    assert "analytics:business_read" not in mapping["FRONT_DESK"]
    assert "analytics:business_read" in mapping["FINANCE"]
    assert "analytics:operations_read" not in mapping["FINANCE"]
    assert BOOKING_CODES <= mapping["SUPER_ADMIN"]
    assert BOOKING_CODES <= mapping["MANAGER"]
    assert BOOKING_CODES <= mapping["FRONT_DESK"]
    # Sprint 6 §18：stay:room_move 授权 SUPER_ADMIN / MANAGER / FRONT_DESK
    assert "stay:room_move" in mapping["MANAGER"]
    assert "stay:room_move" in mapping["FRONT_DESK"]
    assert "stay:room_move" not in mapping["HOUSEKEEPING"]
    assert "stay:room_move" not in mapping["MAINTENANCE"]
    assert "stay:room_move" not in mapping["FINANCE"]
    assert not (BOOKING_CODES & mapping["HOUSEKEEPING"])
    assert not (BOOKING_CODES & mapping["MAINTENANCE"])
    assert not (BOOKING_CODES & mapping["FINANCE"])
