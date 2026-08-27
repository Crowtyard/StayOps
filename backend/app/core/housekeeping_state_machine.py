"""Housekeeping Task 状态机（Sprint 3，后端强制，非法转换 409）。

    PENDING ──→ IN_PROGRESS ──→ INSPECTION ──→ COMPLETED（终态）
    │               ▲                │
    │               └──── REWORK ◄───┘
    └──→ CANCELLED（任意进行中状态可取消，终态）

- 状态只能经专用 action 端点变更（start / submit-inspection / pass / rework / cancel），
  不得经 PATCH 直接改 status（PATCH 仅限 priority / assigned_to_user_id / notes）。
- COMPLETED / CANCELLED 为终态，不得重新激活。
- REWORK -> IN_PROGRESS（返工后重新开始清扫）。
- 状态机只表达 Task 转换；Task 与 Room.cleaning_status 的原子联动
  在 app/services/housekeeping.py 中与审计同事务完成。
"""

from app.models.housekeeping import HousekeepingTaskStatus
from app.models.room import CleaningStatus

HK_TASK_TRANSITIONS: dict[
    HousekeepingTaskStatus, frozenset[HousekeepingTaskStatus]
] = {
    HousekeepingTaskStatus.PENDING: frozenset(
        {
            HousekeepingTaskStatus.IN_PROGRESS,
            HousekeepingTaskStatus.CANCELLED,
        }
    ),
    HousekeepingTaskStatus.IN_PROGRESS: frozenset(
        {
            HousekeepingTaskStatus.INSPECTION,
            HousekeepingTaskStatus.CANCELLED,
        }
    ),
    HousekeepingTaskStatus.INSPECTION: frozenset(
        {
            HousekeepingTaskStatus.COMPLETED,
            HousekeepingTaskStatus.REWORK,
            HousekeepingTaskStatus.CANCELLED,
        }
    ),
    HousekeepingTaskStatus.REWORK: frozenset(
        {
            HousekeepingTaskStatus.IN_PROGRESS,
            HousekeepingTaskStatus.CANCELLED,
        }
    ),
    HousekeepingTaskStatus.COMPLETED: frozenset(),
    HousekeepingTaskStatus.CANCELLED: frozenset(),
}

# 进行中状态集合：占用「Active Task 唯一」部分索引的谓词集合
ACTIVE_TASK_STATUSES = frozenset(
    {
        HousekeepingTaskStatus.PENDING,
        HousekeepingTaskStatus.IN_PROGRESS,
        HousekeepingTaskStatus.INSPECTION,
        HousekeepingTaskStatus.REWORK,
    }
)

# Task 状态 -> Room.cleaning_status 联动映射（CANCELLED 回置 dirty：
# 翻房未完成即取消，房间保持待清扫，见 docs/DECISIONS.md）
TASK_TO_CLEANING: dict[HousekeepingTaskStatus, CleaningStatus] = {
    HousekeepingTaskStatus.PENDING: CleaningStatus.dirty,
    HousekeepingTaskStatus.IN_PROGRESS: CleaningStatus.cleaning,
    HousekeepingTaskStatus.INSPECTION: CleaningStatus.inspection,
    HousekeepingTaskStatus.REWORK: CleaningStatus.rework,
    HousekeepingTaskStatus.COMPLETED: CleaningStatus.clean,
    HousekeepingTaskStatus.CANCELLED: CleaningStatus.dirty,
}


def can_transition_housekeeping_task(
    current: HousekeepingTaskStatus, target: HousekeepingTaskStatus
) -> bool:
    """Task 状态转换是否合法（同状态返回 False）。"""
    return target in HK_TASK_TRANSITIONS.get(current, frozenset())


def is_active_task_status(status: HousekeepingTaskStatus) -> bool:
    """是否为进行中状态（PENDING / IN_PROGRESS / INSPECTION / REWORK）。"""
    return status in ACTIVE_TASK_STATUSES
