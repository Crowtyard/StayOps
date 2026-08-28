"""Maintenance Work Order 状态机（Sprint 5，后端强制，非法转换 409）。

    OPEN ──→ ASSIGNED ──→ IN_PROGRESS ──→ RESOLVED ──→ COMPLETED（终态）
     │            │              ▲              │  │
     │            │              └──── Rework ───┘  └──→ CANCELLED（终态）
     └────────────┴──────────────┴──────────────┘
        （任意非终态可取消）

- 状态只能经专用 action 端点变更（assign / start / resolve / verify / rework /
  cancel），不得经 PATCH 直接改 status（PATCH 仅限基础字段编辑）。
- COMPLETED / CANCELLED 为终态，不得重新激活。
- 转换表表达合法边；两个 action 共享 IN_PROGRESS 目标边，由 action 层守卫区分：
    start  仅 ASSIGNED -> IN_PROGRESS（首次开工）
    rework 仅 RESOLVED -> IN_PROGRESS（验收失败返工）
- Blocking 语义（Sprint 5 §11）：blocks_room=true 且状态 ∈ BLOCKING_STATUSES
  （OPEN / ASSIGNED / IN_PROGRESS / RESOLVED）时阻断客房销售；
  RESOLVED 仍阻断 —— 维修完成 ≠ 酒店验收通过。
- 状态机只表达工单转换；工单与 Room 可售性的原子联动
  在 app/services/maintenance.py 中与审计同事务完成。
"""

from app.models.maintenance import MaintenanceWorkOrderStatus

MWO_TRANSITIONS: dict[
    MaintenanceWorkOrderStatus, frozenset[MaintenanceWorkOrderStatus]
] = {
    MaintenanceWorkOrderStatus.OPEN: frozenset(
        {
            MaintenanceWorkOrderStatus.ASSIGNED,
            MaintenanceWorkOrderStatus.CANCELLED,
        }
    ),
    MaintenanceWorkOrderStatus.ASSIGNED: frozenset(
        {
            MaintenanceWorkOrderStatus.IN_PROGRESS,
            MaintenanceWorkOrderStatus.CANCELLED,
        }
    ),
    MaintenanceWorkOrderStatus.IN_PROGRESS: frozenset(
        {
            MaintenanceWorkOrderStatus.RESOLVED,
            MaintenanceWorkOrderStatus.CANCELLED,
        }
    ),
    MaintenanceWorkOrderStatus.RESOLVED: frozenset(
        {
            MaintenanceWorkOrderStatus.COMPLETED,
            MaintenanceWorkOrderStatus.IN_PROGRESS,
            MaintenanceWorkOrderStatus.CANCELLED,
        }
    ),
    MaintenanceWorkOrderStatus.COMPLETED: frozenset(),
    MaintenanceWorkOrderStatus.CANCELLED: frozenset(),
}

# Active Blocking 状态集合（Sprint 5 §11）：这四种状态下 blocks_room=true 才阻断销售
BLOCKING_STATUSES = frozenset(
    {
        MaintenanceWorkOrderStatus.OPEN,
        MaintenanceWorkOrderStatus.ASSIGNED,
        MaintenanceWorkOrderStatus.IN_PROGRESS,
        MaintenanceWorkOrderStatus.RESOLVED,
    }
)


def can_transition_work_order(
    current: MaintenanceWorkOrderStatus, target: MaintenanceWorkOrderStatus
) -> bool:
    """工单状态转换是否合法（同状态返回 False）。"""
    return target in MWO_TRANSITIONS.get(current, frozenset())


def is_blocking_status(status: MaintenanceWorkOrderStatus) -> bool:
    """是否为 Active Blocking 状态（OPEN / ASSIGNED / IN_PROGRESS / RESOLVED）。"""
    return status in BLOCKING_STATUSES
