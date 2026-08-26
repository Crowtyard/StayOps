"""Booking 域状态机（后端强制验证，非法转换由 API 返回 409）。

Reservation（决策见 docs/DECISIONS.md）：

    CONFIRMED
       ├── CANCELLED
       ├── NO_SHOW
       └── CHECKED_IN
              ↓（仅由 Stay Check-out 事务触发）
           COMPLETED

- CHECKED_IN -> COMPLETED 只能由 Stay Check-out 在同一数据库事务内触发，
  不得经任何普通 Reservation Update / Action API 手工触发（REV-01）。
- CONFIRMED -> CHECKED_IN 仅当 business_date ∈ [check_in_date, check_out_date)（REV-FINAL-01）。
- CONFIRMED -> NO_SHOW   仅当 business_date >= check_in_date（REV-FINAL-02）。
- CANCELLED / NO_SHOW / COMPLETED 为终态；CHECKED_IN 不得回退。

Stay：

    ACTIVE -> CHECKED_OUT（终态，不得重新激活）

状态只能经专用 action 端点变更（cancel / no-show / check-in / check-out），
不得经 PATCH 直接改 status。
"""

from app.models.reservation import ReservationStatus
from app.models.stay import StayStatus

RESERVATION_TRANSITIONS: dict[
    ReservationStatus, frozenset[ReservationStatus]
] = {
    ReservationStatus.CONFIRMED: frozenset(
        {
            ReservationStatus.CANCELLED,
            ReservationStatus.NO_SHOW,
            ReservationStatus.CHECKED_IN,
        }
    ),
    # COMPLETED 仅由 Stay Check-out 事务触发：转换表保留该边，
    # 但 reservations 路由绝不调用 COMPLETED 目标（唯一调用点在 services.booking.check_out_stay）。
    ReservationStatus.CHECKED_IN: frozenset({ReservationStatus.COMPLETED}),
    ReservationStatus.CANCELLED: frozenset(),
    ReservationStatus.NO_SHOW: frozenset(),
    ReservationStatus.COMPLETED: frozenset(),
}

STAY_TRANSITIONS: dict[StayStatus, frozenset[StayStatus]] = {
    StayStatus.ACTIVE: frozenset({StayStatus.CHECKED_OUT}),
    StayStatus.CHECKED_OUT: frozenset(),
}


def can_transition_reservation(
    current: ReservationStatus, target: ReservationStatus
) -> bool:
    """Reservation 状态转换是否合法（同状态返回 False）。"""
    return target in RESERVATION_TRANSITIONS.get(current, frozenset())


def can_transition_stay(current: StayStatus, target: StayStatus) -> bool:
    """Stay 状态转换是否合法（同状态返回 False）。"""
    return target in STAY_TRANSITIONS.get(current, frozenset())
