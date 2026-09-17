# -*- coding: utf-8 -*-
"""S8 Analytics 权限 Seed 测试（§34）+ S9 AI Manager 权限矩阵（§22）。

不只是机械改计数：必须验证真实 code 与 role matrix。
"""

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Permission, Role, RolePermission
from app.seed import seed

S8_PERMISSION_CODES = {
    "analytics:operations_read",
    "analytics:business_read",
}

S9_PERMISSION_CODES = {
    "ai_manager:use",
    "ai_manager:manage",
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
                    .join(RolePermission, RolePermission.permission_id == Permission.id)
                    .where(RolePermission.role_id == role.id)
                )
            }
            mapping[role.name] = codes
        return {"permissions": len(perms), "codes": set(perms), "mapping": mapping}
    finally:
        session.close()


def test_seed_idempotent_50_permissions_and_s8_matrix(_database):
    """连续两次 seed 收敛；52 权限码（50 + S9 的 2）；§34/§22 矩阵。"""
    seed()
    first = _snapshot()
    seed()
    second = _snapshot()
    assert first == second, "连续执行两次 seed 必须收敛到一致状态"

    assert first["permissions"] == 55  # 52（S9）+ alpha.9.6 渠道 2 + QA DEF-1 房间库存 room:inventory_manage
    assert S8_PERMISSION_CODES <= first["codes"]
    assert S9_PERMISSION_CODES <= first["codes"]

    mapping = first["mapping"]
    # SUPER_ADMIN / MANAGER：operations ✓ + business ✓
    assert S8_PERMISSION_CODES <= mapping["SUPER_ADMIN"]
    assert S8_PERMISSION_CODES <= mapping["MANAGER"]
    # FRONT_DESK：operations ✓、business ×
    front_desk = mapping["FRONT_DESK"]
    assert "analytics:operations_read" in front_desk
    assert "analytics:business_read" not in front_desk
    # HOUSEKEEPING / MAINTENANCE：两个都 ×
    for role_name in ("HOUSEKEEPING", "MAINTENANCE"):
        assert not (S8_PERMISSION_CODES & mapping[role_name])
    # FINANCE：operations ×、business ✓
    finance = mapping["FINANCE"]
    assert "analytics:operations_read" not in finance
    assert "analytics:business_read" in finance

    # Sprint 9 §22：AI Manager 矩阵
    #   SUPER_ADMIN / MANAGER / FRONT_DESK / FINANCE = ai_manager:use ✓
    #   HOUSEKEEPING / MAINTENANCE = ×；ai_manager:manage 仅 SUPER_ADMIN / MANAGER
    assert S9_PERMISSION_CODES <= mapping["SUPER_ADMIN"]
    assert S9_PERMISSION_CODES <= mapping["MANAGER"]
    assert "ai_manager:use" in front_desk
    assert "ai_manager:manage" not in front_desk
    assert "ai_manager:use" in finance
    assert "ai_manager:manage" not in finance
    for role_name in ("HOUSEKEEPING", "MAINTENANCE"):
        assert not (S9_PERMISSION_CODES & mapping[role_name])

    # 其它既有权限不回归（抽样）
    assert "inventory:read" in mapping["FRONT_DESK"]
    assert "procurement:read" in mapping["FINANCE"]
    assert "reservation:read" in mapping["MANAGER"]
