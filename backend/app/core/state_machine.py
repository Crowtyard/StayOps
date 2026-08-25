"""房态状态机（后端强制验证，非法转换由 API 返回 409）。

房态拆为两个独立维度（决策见 docs/DECISIONS.md），各自由独立状态机管理：

占用状态 occupancy_status：
    available      -> reserved / occupied / blocked / out_of_service
    reserved       -> available / occupied / blocked / out_of_service
    occupied       -> available / reserved / out_of_service
    blocked        -> available / out_of_service
    out_of_service -> available / blocked

清洁状态 cleaning_status：
    clean       -> dirty
    dirty       -> cleaning
    cleaning    -> clean / inspection / rework
    inspection  -> clean / rework
    rework      -> cleaning

同一状态不视为转换（返回 False，API 层 409）。
两个维度互不约束，允许组合如 reserved + dirty（已预订但待清扫）。
"""

from app.models.room import CleaningStatus, OccupancyStatus

OCCUPANCY_TRANSITIONS: dict[OccupancyStatus, frozenset[OccupancyStatus]] = {
    OccupancyStatus.available: frozenset(
        {
            OccupancyStatus.reserved,
            OccupancyStatus.occupied,
            OccupancyStatus.blocked,
            OccupancyStatus.out_of_service,
        }
    ),
    OccupancyStatus.reserved: frozenset(
        {
            OccupancyStatus.available,
            OccupancyStatus.occupied,
            OccupancyStatus.blocked,
            OccupancyStatus.out_of_service,
        }
    ),
    OccupancyStatus.occupied: frozenset(
        {
            OccupancyStatus.available,
            OccupancyStatus.reserved,
            OccupancyStatus.out_of_service,
        }
    ),
    OccupancyStatus.blocked: frozenset(
        {OccupancyStatus.available, OccupancyStatus.out_of_service}
    ),
    OccupancyStatus.out_of_service: frozenset(
        {OccupancyStatus.available, OccupancyStatus.blocked}
    ),
}

CLEANING_TRANSITIONS: dict[CleaningStatus, frozenset[CleaningStatus]] = {
    CleaningStatus.clean: frozenset({CleaningStatus.dirty}),
    CleaningStatus.dirty: frozenset({CleaningStatus.cleaning}),
    CleaningStatus.cleaning: frozenset(
        {CleaningStatus.clean, CleaningStatus.inspection, CleaningStatus.rework}
    ),
    CleaningStatus.inspection: frozenset(
        {CleaningStatus.clean, CleaningStatus.rework}
    ),
    CleaningStatus.rework: frozenset({CleaningStatus.cleaning}),
}


def can_change_occupancy(
    current: OccupancyStatus, target: OccupancyStatus
) -> bool:
    """判断占用状态转换是否合法（同状态返回 False）。"""
    return target in OCCUPANCY_TRANSITIONS.get(current, frozenset())


def can_change_cleaning(current: CleaningStatus, target: CleaningStatus) -> bool:
    """判断清洁状态转换是否合法（同状态返回 False）。"""
    return target in CLEANING_TRANSITIONS.get(current, frozenset())
