# -*- coding: utf-8 -*-
"""S7 种子幂等测试（Sprint 7 §52）：11 个新权限 + 4 个库存地点 + 角色矩阵。

沿用 test_booking_seed.py 模式：SessionLocal 真实快照（seed 为真实写入），
连续执行两次收敛。
"""

from sqlalchemy import select

from app.database import SessionLocal
from app.models import (
    InventoryLocation,
    Permission,
    Role,
    RolePermission,
)
from app.seed import INVENTORY_LOCATIONS, seed

S7_PERMISSION_CODES = {
    "inventory:read",
    "inventory:issue",
    "inventory:adjust",
    "inventory:transfer",
    "inventory:item_manage",
    "procurement:read",
    "procurement:request",
    "procurement:approve",
    "procurement:order",
    "procurement:receive",
    "procurement:supplier_manage",
}

S8_PERMISSION_CODES = {
    "analytics:operations_read",
    "analytics:business_read",
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
        locations = {
            loc.location_code: loc.name
            for loc in session.scalars(select(InventoryLocation))
        }
        return {
            "permissions": len(perms),
            "mapping": mapping,
            "locations": locations,
        }
    finally:
        session.close()


def test_seed_idempotent_and_s7_role_matrix(_database):
    """连续执行两次 seed 收敛；52 权限码（50 + S9 的 2）；4 个地点；§36 矩阵。"""
    seed()
    first = _snapshot()
    seed()
    second = _snapshot()
    assert first == second, "连续执行两次 seed 必须收敛到一致状态"

    assert first["permissions"] == 55  # 52（S9）+ alpha.9.6 渠道 2 + QA DEF-1 房间库存 room:inventory_manage
    mapping = first["mapping"]

    # Sprint 8 §34：Analytics 矩阵（与 S7 权限码共存）
    assert {"analytics:operations_read", "analytics:business_read"} <= mapping["MANAGER"]
    assert "analytics:operations_read" in mapping["FRONT_DESK"]
    assert "analytics:business_read" not in mapping["FRONT_DESK"]
    assert "analytics:business_read" in mapping["FINANCE"]
    assert "analytics:operations_read" not in mapping["FINANCE"]
    assert not (S8_PERMISSION_CODES & mapping["HOUSEKEEPING"])
    assert not (S8_PERMISSION_CODES & mapping["MAINTENANCE"])

    # 权限码存在
    assert S7_PERMISSION_CODES <= mapping["SUPER_ADMIN"]

    # §36 矩阵（SUPER_ADMIN 动态全部）
    assert S7_PERMISSION_CODES <= mapping["MANAGER"]
    front_desk = mapping["FRONT_DESK"]
    assert {
        "inventory:read",
        "inventory:issue",
        "procurement:read",
        "procurement:request",
        "procurement:receive",
    } <= front_desk
    assert not (
        S7_PERMISSION_CODES
        - {
            "inventory:read",
            "inventory:issue",
            "procurement:read",
            "procurement:request",
            "procurement:receive",
        }
    ) & front_desk

    for role_name in ("HOUSEKEEPING", "MAINTENANCE"):
        granted = mapping[role_name]
        assert {"inventory:read", "inventory:issue", "procurement:request"} <= granted
        assert not (
            S7_PERMISSION_CODES
            - {"inventory:read", "inventory:issue", "procurement:request"}
        ) & granted

    finance = mapping["FINANCE"]
    assert {"inventory:read", "procurement:read"} <= finance
    assert not (
        S7_PERMISSION_CODES - {"inventory:read", "procurement:read"}
    ) & finance

    # 4 个地点（§6）：MAIN_STORAGE 总仓 / FRONT_DESK 前台 /
    # HOUSEKEEPING 保洁间 / MAINTENANCE 维修间
    locations = first["locations"]
    assert {
        code: name for code, name in INVENTORY_LOCATIONS
    }.items() <= locations.items()
    expected_names = {
        "MAIN_STORAGE": "总仓",
        "FRONT_DESK": "前台",
        "HOUSEKEEPING": "保洁间",
        "MAINTENANCE": "维修间",
    }
    for code, name in expected_names.items():
        assert locations[code] == name
