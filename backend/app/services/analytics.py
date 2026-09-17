"""Analytics Service（Sprint 8，read-only derived layer）。

原则（Sprint 8 §2/§41/§42）：
- Analytics 是只读派生层：正式业务表（stays / reservations / housekeeping_tasks /
  maintenance_work_orders / stock_movements / goods_receipts ...）仍是 Source of Truth；
  不建立第二套业务事实表，不建 analytics 表，无 ETL。
- 指标计算优先使用 SQL aggregation / GROUP BY / joins / CTE / PostgreSQL 日期运算；
  禁止「load all rows → Python nested loops 手算」；避免 N+1（28 房规模单查询聚合）。
- 全部日期区间统一 [from, to) 半开区间 + Business Date（Asia/Shanghai）（§2.4）；
  Actual 至多统计到 current_business_date（exclusive，§3）。
- Count -> 0；Rate/Average 分母 0 -> null；Empty series -> []；禁止 NaN / Infinity。
- 酒店总体房晚 MUST derive from Stay（§5，Room Move 防重复计数）；
  Forecast 按 distinct (business_date, room_id) 仲裁去重（§10）。
- 不返回任何 Guest / Supplier 联系信息（PII，§36）。
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.business_date import business_date
from app.models import Channel

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

# Business Date 时间戳转换（timestamptz -> Asia/Shanghai 日历日）
# 用法：_BD.format(col="actual_check_in_at") -> (actual_check_in_at AT TIME ZONE ...)
_BD = "({col} AT TIME ZONE 'Asia/Shanghai')::date"

HK_BACKLOG_STATUSES = ("PENDING", "IN_PROGRESS", "INSPECTION", "REWORK")
MWO_ACTIVE_STATUSES = ("OPEN", "ASSIGNED", "IN_PROGRESS", "RESOLVED")
PR_PENDING_STATUSES = ("SUBMITTED", "APPROVED")
PO_PENDING_RECEIPT_STATUSES = ("ORDERED", "PARTIALLY_RECEIVED")

LEAD_BUCKET_SPEC = (
    ("0-1", 0, 1),
    ("2-3", 2, 3),
    ("4-7", 4, 7),
    ("8-14", 8, 14),
    ("15-30", 15, 30),
    ("31+", 31, None),
)

ZERO = Decimal("0")


def _money(value: Decimal) -> Decimal:
    """金额统一两位小数（Money 一律 Decimal/Numeric，§18；SQL SUM 精度收敛）。"""
    return value.quantize(Decimal("0.01"))


def _rate(numerator: int | float | Decimal, denominator: int | float | Decimal) -> float | None:
    """比率（0..1）。分母 0 -> None（禁止 NaN/Infinity，§33）。"""
    if denominator == 0:
        return None
    return round(float(numerator) / float(denominator), 4)


def _avg_minutes(seconds_value) -> float | None:
    """分钟（保留 1 位小数）；None 透传。

    SQL 侧已用 EXTRACT(EPOCH FROM ...) / 60.0 换算为分钟；EXTRACT 返回
    NUMERIC（可能为 Decimal），这里只做 float 收敛，不再二次换算。
    """
    if seconds_value is None:
        return None
    return round(float(seconds_value), 1)


def _percent_change(current: float, previous: float) -> float | None:
    """百分比变化。previous = 0 -> None（禁止 Infinity，§32）。"""
    if previous == 0:
        return None
    return round((current - previous) / previous, 4)


# ---------------------------------------------------------------------------
# 基础查询
# ---------------------------------------------------------------------------


def physical_room_count(db: Session) -> int:
    """物理房间数：必须查询当前正式 Room master（§6），禁止硬编码。"""
    return db.execute(text("SELECT COUNT(*) FROM rooms")).scalar_one()


def _stay_intervals_sql(from_date: date, to_date: date, current_bd: date) -> str:
    """Stay 实际占用区间 CTE（§4/§5）。

    - COMPLETED Stay: [business_date(actual_check_in_at), business_date(actual_check_out_at))
    - ACTIVE Stay:    [business_date(actual_check_in_at), current_business_date)
      （实际历史不能被 planned_checkout 截断；不提前把今晚当成已完成房晚）
    """
    return f"""
    WITH stay_intervals AS (
        SELECT id,
               {_BD.format(col="actual_check_in_at")} AS check_in_bd,
               CASE WHEN status = 'ACTIVE' THEN :current_bd
                    ELSE {_BD.format(col="actual_check_out_at")} END AS check_out_bd
          FROM stays
    )
    """


def _occupied_room_nights(db: Session, from_date: date, to_date: date) -> int:
    """报告区间内实际占用房晚（按 Stay 计算，天然防 Room Move 重复计数，§5）。"""
    current_bd = business_date()
    sql = _stay_intervals_sql(from_date, to_date, current_bd) + """
    SELECT COALESCE(SUM(LEAST(:to, check_out_bd) - GREATEST(:from, check_in_bd)), 0)
      FROM stay_intervals
     WHERE check_in_bd < :to AND check_out_bd > :from
    """
    return int(
        db.execute(
            text(sql),
            {"from": from_date, "to": to_date, "current_bd": current_bd},
        ).scalar_one()
    )


def _daily_occupied(db: Session, from_date: date, to_date: date) -> list[dict]:
    """每日实际占用房晚序列（[from, to) 内每一天）。"""
    current_bd = business_date()
    sql = _stay_intervals_sql(from_date, to_date, current_bd) + """
    SELECT g.day::date AS business_date, COUNT(*)::int AS occupied_room_nights
      FROM generate_series(CAST(:from AS date), CAST(:to AS date) - 1, interval '1 day') AS g(day)
      JOIN stay_intervals s
        ON g.day::date >= s.check_in_bd AND g.day::date < s.check_out_bd
     GROUP BY g.day
     ORDER BY g.day
    """
    rows = db.execute(
        text(sql), {"from": from_date, "to": to_date, "current_bd": current_bd}
    ).all()
    return [{"business_date": r.business_date, "occupied_room_nights": r.occupied_room_nights} for r in rows]


# ---------------------------------------------------------------------------
# Operations: Overview 周期指标
# ---------------------------------------------------------------------------


def overview_metrics(db: Session, from_date: date, to_date: date) -> dict:
    """Overview 周期指标（§45，全部为 operations 域）。"""
    current_bd = business_date()
    physical_count = physical_room_count(db)
    report_days = (to_date - from_date).days
    physical_nights = physical_count * report_days
    occupied = _occupied_room_nights(db, from_date, to_date)

    alos = db.execute(
        text(
            f"""
            SELECT COUNT(*)::int AS completed,
                   COALESCE(SUM({_BD.format(col="actual_check_out_at")} - {_BD.format(col="actual_check_in_at")}), 0)::int AS nights
              FROM stays
             WHERE status = 'CHECKED_OUT'
               AND {_BD.format(col="actual_check_out_at")} >= :from
               AND {_BD.format(col="actual_check_out_at")} < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    cohort = db.execute(
        text(
            """
            SELECT COUNT(*)::int AS scheduled,
                   COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                   COUNT(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
                   AVG(GREATEST(0, check_in_date - (created_at AT TIME ZONE 'Asia/Shanghai')::date))
                       FILTER (WHERE status <> 'CANCELLED') AS avg_lead
              FROM reservations
             WHERE check_in_date >= :from AND check_in_date < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    moves = db.execute(
        text(
            f"""
            SELECT COUNT(*)::int AS move_count,
                   COUNT(DISTINCT stay_id)::int AS moved_stays
              FROM stay_room_assignments
             WHERE reason IS NOT NULL
               AND {_BD.format(col="started_at")} >= :from
               AND {_BD.format(col="started_at")} < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    # room_move_rate：cohort = 实际入住日落在区间的 Stay；numerator = cohort 中发生过 ≥1 次换房的 Stay（§25）
    move_rate_numerator = db.execute(
        text(
            f"""
            WITH cohort AS (
                SELECT id FROM stays
                 WHERE {_BD.format(col="actual_check_in_at")} >= :from
                   AND {_BD.format(col="actual_check_in_at")} < :to
            ),
            moved AS (
                SELECT DISTINCT stay_id FROM stay_room_assignments
                 WHERE reason IS NOT NULL
                   AND {_BD.format(col="started_at")} >= :from
                   AND {_BD.format(col="started_at")} < :to
            )
            SELECT COUNT(*)::int FROM cohort c JOIN moved m ON m.stay_id = c.id
            """
        ),
        {"from": from_date, "to": to_date},
    ).scalar_one()

    hk_completed = db.execute(
        text(
            f"""
            SELECT COUNT(*)::int FROM housekeeping_tasks
             WHERE status = 'COMPLETED'
               AND {_BD.format(col="completed_at")} >= :from
               AND {_BD.format(col="completed_at")} < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).scalar_one()

    scheduled = cohort.scheduled
    cancelled = cohort.cancelled
    no_show = cohort.no_show
    non_cancelled = scheduled - cancelled

    return {
        "actual_occupied_room_nights": occupied,
        "physical_room_nights": physical_nights,
        "physical_occupancy_rate": _rate(occupied, physical_nights),
        "completed_stays": alos.completed,
        "average_length_of_stay": (
            _rate(alos.nights, alos.completed) if alos.completed else None
        ),
        "scheduled_arrivals": scheduled,
        "cancelled_arrivals": cancelled,
        "cancellation_rate": _rate(cancelled, scheduled),
        "no_show_count": no_show,
        "no_show_rate": _rate(no_show, non_cancelled),
        "average_booking_lead_days": (
            round(float(cohort.avg_lead), 1) if cohort.avg_lead is not None else None
        ),
        "room_move_count": moves.move_count,
        "moved_stay_count": moves.moved_stays,
        "room_move_rate": _rate(move_rate_numerator, checkin_cohort_count(db, from_date, to_date)),
        "housekeeping_completed_tasks": hk_completed,
    }


def checkin_cohort_count(db: Session, from_date: date, to_date: date) -> int:
    """actual check-in Business Date ∈ [from, to) 的 Stay 数（room_move_rate 分母）。"""
    return int(
        db.execute(
            text(
                f"""
                SELECT COUNT(*)::int FROM stays
                 WHERE {_BD.format(col="actual_check_in_at")} >= :from
                   AND {_BD.format(col="actual_check_in_at")} < :to
                """
            ),
            {"from": from_date, "to": to_date},
        ).scalar_one()
    )


def snapshot_metrics(db: Session) -> dict:
    """当前快照指标（§9，不得把 backlog 当作周期指标）。"""
    row = db.execute(
        text(
            """
            SELECT
              (SELECT COUNT(*)::int FROM stays WHERE status = 'ACTIVE') AS active_stays,
              (SELECT COUNT(*)::int FROM stays WHERE status = 'ACTIVE'
                 AND planned_check_out_date <= :bd) AS overdue_active_stays,
              (SELECT COUNT(*)::int FROM housekeeping_tasks
                 WHERE status IN ('PENDING','IN_PROGRESS','INSPECTION','REWORK')) AS hk_backlog,
              (SELECT COUNT(*)::int FROM maintenance_work_orders
                 WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED')) AS active_maintenance,
              (SELECT COUNT(*)::int FROM maintenance_work_orders
                 WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED')
                   AND blocks_room = true) AS active_blocking_maintenance
            """
        ),
        {"bd": business_date()},
    ).one()
    return {
        "active_stays": row.active_stays,
        "overdue_active_stays": row.overdue_active_stays,
        "housekeeping_backlog": row.hk_backlog,
        "active_maintenance": row.active_maintenance,
        "active_blocking_maintenance": row.active_blocking_maintenance,
    }


# ---------------------------------------------------------------------------
# On-Books Forecast（§10/§11）
# ---------------------------------------------------------------------------


def _forecast_room_days(db: Session, current_bd: date, horizon: int) -> int:
    """未来 horizon 天在册房晚（distinct (business_date, room_id) 仲裁去重，§10）。

    来源：CONFIRMED Reservation（[check_in, check_out) ∩ [bd, bd+horizon)）+
    ACTIVE Stay remaining planned occupancy（[bd, planned_check_out) ∩ 同样窗口）。
    planned_check_out <= bd 的 ACTIVE Stay 不贡献任何未来房晚（超期运营问题，
    由 overdue_active_stays 反映，禁止擅自发明未来住宿 nights）。
    """
    sql = text(
        """
        WITH resv AS (
            SELECT r.room_id, g.d
              FROM reservations r
              JOIN LATERAL generate_series(
                       r.check_in_date, r.check_out_date - 1, interval '1 day') AS g(d)
                ON true
             WHERE r.status = 'CONFIRMED'
               AND r.check_out_date > :bd
               AND r.check_in_date < CAST(:bd AS date) + :horizon
        ),
        stays AS (
            SELECT s.room_id, g.d
              FROM stays s
              JOIN LATERAL generate_series(
                       CAST(:bd AS date), s.planned_check_out_date - 1, interval '1 day') AS g(d)
                ON true
             WHERE s.status = 'ACTIVE'
               AND s.planned_check_out_date > :bd
        ),
        booked AS (
            SELECT d, room_id FROM resv
            UNION
            SELECT d, room_id FROM stays
        )
        SELECT COUNT(*)::int FROM (
            SELECT DISTINCT d, room_id FROM booked
             WHERE d >= :bd AND d < CAST(:bd AS date) + :horizon
        ) x
        """
    )
    return int(
        db.execute(sql, {"bd": current_bd, "horizon": horizon}).scalar_one()
    )


def on_books_horizons(db: Session) -> dict:
    """On-books 7d / 14d / 30d 摘要（Overview 与 Forecast 端点共用）。"""
    current_bd = business_date()
    physical_count = physical_room_count(db)
    result: dict = {}
    for key, horizon in (("7d", 7), ("14d", 14), ("30d", 30)):
        booked = _forecast_room_days(db, current_bd, horizon)
        physical = physical_count * horizon
        result[key] = {
            "days": horizon,
            "physical_room_nights": physical,
            "on_books_room_nights": booked,
            "occupancy_rate": _rate(booked, physical),
        }
    return result


def forecast(db: Session) -> dict:
    """Forecast 端点：7/14/30 日程 + 30 日每日序列（§38）。"""
    current_bd = business_date()
    physical_count = physical_room_count(db)
    horizons = on_books_horizons(db)

    # 30 日每日在册占用（distinct (d, room_id) 去重后按日聚合）
    sql = text(
        """
        WITH resv AS (
            SELECT r.room_id, g.d
              FROM reservations r
              JOIN LATERAL generate_series(
                       r.check_in_date, r.check_out_date - 1, interval '1 day') AS g(d)
                ON true
             WHERE r.status = 'CONFIRMED'
               AND r.check_out_date > :bd
               AND r.check_in_date < CAST(:bd AS date) + 30
        ),
        stays AS (
            SELECT s.room_id, g.d
              FROM stays s
              JOIN LATERAL generate_series(
                       CAST(:bd AS date), s.planned_check_out_date - 1, interval '1 day') AS g(d)
                ON true
             WHERE s.status = 'ACTIVE'
               AND s.planned_check_out_date > :bd
        ),
        booked AS (
            SELECT d, room_id FROM resv
            UNION
            SELECT d, room_id FROM stays
        )
        SELECT d::date AS business_date, COUNT(*)::int AS on_books_room_nights
          FROM (SELECT DISTINCT d, room_id FROM booked
                 WHERE d >= :bd AND d < CAST(:bd AS date) + 30) x
         GROUP BY d
         ORDER BY d
        """
    )
    rows = db.execute(sql, {"bd": current_bd}).all()
    booked_by_date = {r.business_date: r.on_books_room_nights for r in rows}
    daily = []
    for i in range(30):  # 30 日序列补零：系列本身由日程定义，无预订日 = 0（§33）
        day = current_bd + timedelta(days=i)
        booked = booked_by_date.get(day, 0)
        daily.append(
            {
                "business_date": day,
                "on_books_room_nights": booked,
                "physical_room_nights": physical_count,
                "occupancy_rate": _rate(booked, physical_count),
            }
        )
    return {
        "business_date": current_bd,
        "physical_room_count": physical_count,
        "horizons": horizons,
        "daily": daily,
    }


# ---------------------------------------------------------------------------
# Operations: Bookings（Arrival Cohort，§12-§16）
# ---------------------------------------------------------------------------


def bookings_analytics(db: Session, from_date: date, to_date: date) -> dict:
    current_bd = business_date()
    physical_count = physical_room_count(db)
    report_days = (to_date - from_date).days

    cohort = db.execute(
        text(
            """
            SELECT COUNT(*)::int AS scheduled,
                   COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
                   COUNT(*) FILTER (WHERE status = 'NO_SHOW')::int AS no_show,
                   AVG(GREATEST(0, check_in_date - (created_at AT TIME ZONE 'Asia/Shanghai')::date))
                       FILTER (WHERE status <> 'CANCELLED') AS avg_lead
              FROM reservations
             WHERE check_in_date >= :from AND check_in_date < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    buckets = db.execute(
        text(
            """
            SELECT
                COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND GREATEST(0, check_in_date - (created_at AT TIME ZONE 'Asia/Shanghai')::date) <= 1)::int AS b01,
                COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND GREATEST(0, check_in_date - (created_at AT TIME ZONE 'Asia/Shanghai')::date) BETWEEN 2 AND 3)::int AS b23,
                COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND GREATEST(0, check_in_date - (created_at AT TIME ZONE 'Asia/Shanghai')::date) BETWEEN 4 AND 7)::int AS b47,
                COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND GREATEST(0, check_in_date - (created_at AT TIME ZONE 'Asia/Shanghai')::date) BETWEEN 8 AND 14)::int AS b814,
                COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND GREATEST(0, check_in_date - (created_at AT TIME ZONE 'Asia/Shanghai')::date) BETWEEN 15 AND 30)::int AS b1530,
                COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND GREATEST(0, check_in_date - (created_at AT TIME ZONE 'Asia/Shanghai')::date) >= 31)::int AS b31
              FROM reservations
             WHERE check_in_date >= :from AND check_in_date < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    alos = db.execute(
        text(
            f"""
            SELECT COUNT(*)::int AS completed,
                   COALESCE(SUM({_BD.format(col="actual_check_out_at")} - {_BD.format(col="actual_check_in_at")}), 0)::int AS nights
              FROM stays
             WHERE status = 'CHECKED_OUT'
               AND {_BD.format(col="actual_check_out_at")} >= :from
               AND {_BD.format(col="actual_check_out_at")} < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    moves = db.execute(
        text(
            f"""
            SELECT COUNT(*)::int AS move_count,
                   COUNT(DISTINCT stay_id)::int AS moved_stays
              FROM stay_room_assignments
             WHERE reason IS NOT NULL
               AND {_BD.format(col="started_at")} >= :from
               AND {_BD.format(col="started_at")} < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()
    move_rate_num = db.execute(
        text(
            f"""
            WITH cohort AS (
                SELECT id FROM stays
                 WHERE {_BD.format(col="actual_check_in_at")} >= :from
                   AND {_BD.format(col="actual_check_in_at")} < :to
            ),
            moved AS (
                SELECT DISTINCT stay_id FROM stay_room_assignments
                 WHERE reason IS NOT NULL
                   AND {_BD.format(col="started_at")} >= :from
                   AND {_BD.format(col="started_at")} < :to
            )
            SELECT COUNT(*)::int FROM cohort c JOIN moved m ON m.stay_id = c.id
            """
        ),
        {"from": from_date, "to": to_date},
    ).scalar_one()
    checkin_count = checkin_cohort_count(db, from_date, to_date)

    scheduled = cohort.scheduled
    cancelled = cohort.cancelled
    no_show = cohort.no_show
    non_cancelled = scheduled - cancelled

    daily_rows = _daily_occupied(db, from_date, to_date)
    daily_by_date = {r["business_date"]: r["occupied_room_nights"] for r in daily_rows}
    daily = []
    for i in range(report_days):
        day = from_date + timedelta(days=i)
        occupied = daily_by_date.get(day, 0)
        daily.append(
            {
                "business_date": day,
                "occupied_room_nights": occupied,
                "physical_room_nights": physical_count,
                "occupancy_rate": _rate(occupied, physical_count),
            }
        )

    return {
        "business_date": current_bd,
        "scheduled_arrivals": scheduled,
        "cancelled_arrivals": cancelled,
        "cancellation_rate": _rate(cancelled, scheduled),
        "no_show_count": no_show,
        "no_show_rate": _rate(no_show, non_cancelled),
        "average_booking_lead_days": (
            round(float(cohort.avg_lead), 1) if cohort.avg_lead is not None else None
        ),
        "booking_lead_distribution": [
            {"bucket": name, "count": getattr(buckets, attr)}
            for name, attr in (
                ("0-1", "b01"),
                ("2-3", "b23"),
                ("4-7", "b47"),
                ("8-14", "b814"),
                ("15-30", "b1530"),
                ("31+", "b31"),
            )
        ],
        "completed_stays": alos.completed,
        "average_length_of_stay": (
            _rate(alos.nights, alos.completed) if alos.completed else None
        ),
        "room_move_count": moves.move_count,
        "moved_stay_count": moves.moved_stays,
        "room_move_rate": _rate(move_rate_num, checkin_count),
        "daily": daily,
    }


# ---------------------------------------------------------------------------
# Operations: Housekeeping（§23）
# ---------------------------------------------------------------------------


def housekeeping_analytics(db: Session, from_date: date, to_date: date) -> dict:
    row = db.execute(
        text(
            f"""
            SELECT
              COUNT(*) FILTER (WHERE status = 'COMPLETED'
                AND {_BD.format(col="completed_at")} >= :from
                AND {_BD.format(col="completed_at")} < :to)::int AS completed,
              AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60.0)
                FILTER (WHERE status = 'COMPLETED'
                  AND {_BD.format(col="completed_at")} >= :from
                  AND {_BD.format(col="completed_at")} < :to) AS cycle_minutes,
              AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60.0)
                FILTER (WHERE status = 'COMPLETED' AND source = 'CHECKOUT'
                  AND {_BD.format(col="completed_at")} >= :from
                  AND {_BD.format(col="completed_at")} < :to) AS checkout_turnover,
              COUNT(*) FILTER (WHERE source = 'ROOM_MOVE'
                  AND {_BD.format(col="created_at")} >= :from
                  AND {_BD.format(col="created_at")} < :to)::int AS room_move_tasks,
              (SELECT COUNT(*)::int FROM housekeeping_tasks
                WHERE status IN ('PENDING','IN_PROGRESS','INSPECTION','REWORK')) AS backlog
            FROM housekeeping_tasks
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    daily_rows = db.execute(
        text(
            f"""
            SELECT {_BD.format(col="completed_at")} AS business_date,
                   COUNT(*)::int AS completed_tasks
              FROM housekeeping_tasks
             WHERE status = 'COMPLETED'
               AND {_BD.format(col="completed_at")} >= :from
               AND {_BD.format(col="completed_at")} < :to
             GROUP BY {_BD.format(col="completed_at")}
             ORDER BY {_BD.format(col="completed_at")}
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    return {
        "business_date": business_date(),
        "housekeeping_completed_tasks": row.completed,
        "average_housekeeping_cycle_minutes": _avg_minutes(row.cycle_minutes),
        "checkout_turnover_minutes": _avg_minutes(row.checkout_turnover),
        "room_move_cleaning_tasks": row.room_move_tasks,
        "housekeeping_backlog": row.backlog,
        "daily": [
            {"business_date": r.business_date, "completed_tasks": r.completed_tasks}
            for r in daily_rows
        ],
    }


# ---------------------------------------------------------------------------
# Operations: Maintenance（§24）
# ---------------------------------------------------------------------------


def maintenance_analytics(db: Session, from_date: date, to_date: date) -> dict:
    row = db.execute(
        text(
            f"""
            SELECT
              COUNT(*) FILTER (WHERE {_BD.format(col="created_at")} >= :from
                  AND {_BD.format(col="created_at")} < :to)::int AS created,
              COUNT(*) FILTER (WHERE status = 'COMPLETED'
                  AND {_BD.format(col="completed_at")} >= :from
                  AND {_BD.format(col="completed_at")} < :to)::int AS completed,
              (SELECT COUNT(*)::int FROM maintenance_work_orders
                WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED')) AS active,
              (SELECT COUNT(*)::int FROM maintenance_work_orders
                WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED')
                  AND blocks_room = true) AS active_blocking,
              AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60.0)
                FILTER (WHERE {_BD.format(col="resolved_at")} >= :from
                  AND {_BD.format(col="resolved_at")} < :to) AS mttr_minutes,
              AVG(EXTRACT(EPOCH FROM (completed_at - resolved_at)) / 60.0)
                FILTER (WHERE status = 'COMPLETED'
                  AND {_BD.format(col="completed_at")} >= :from
                  AND {_BD.format(col="completed_at")} < :to) AS verification_minutes
            FROM maintenance_work_orders
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    by_category = db.execute(
        text(
            f"""
            SELECT category, COUNT(*)::int AS count
              FROM maintenance_work_orders
             WHERE {_BD.format(col="created_at")} >= :from
               AND {_BD.format(col="created_at")} < :to
             GROUP BY category
             ORDER BY count DESC, category
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    by_room = db.execute(
        text(
            f"""
            SELECT m.room_id, r.room_number, COUNT(*)::int AS count
              FROM maintenance_work_orders m
              JOIN rooms r ON r.id = m.room_id
             WHERE {_BD.format(col="m.created_at")} >= :from
               AND {_BD.format(col="m.created_at")} < :to
             GROUP BY m.room_id, r.room_number
             ORDER BY count DESC, r.room_number
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    return {
        "business_date": business_date(),
        "maintenance_created": row.created,
        "maintenance_completed": row.completed,
        "active_maintenance": row.active,
        "active_blocking_maintenance": row.active_blocking,
        "mean_time_to_resolution_minutes": _avg_minutes(row.mttr_minutes),
        "mean_verification_minutes": _avg_minutes(row.verification_minutes),
        "maintenance_by_category": [
            {"category": r.category, "count": r.count} for r in by_category
        ],
        "maintenance_by_room": [
            {"room_id": r.room_id, "room_number": r.room_number, "count": r.count}
            for r in by_room
        ],
    }


# ---------------------------------------------------------------------------
# Operations: Room Moves（§25）
# ---------------------------------------------------------------------------


def room_moves_analytics(db: Session, from_date: date, to_date: date) -> dict:
    moves = db.execute(
        text(
            f"""
            SELECT COUNT(*)::int AS move_count,
                   COUNT(DISTINCT stay_id)::int AS moved_stays
              FROM stay_room_assignments
             WHERE reason IS NOT NULL
               AND {_BD.format(col="started_at")} >= :from
               AND {_BD.format(col="started_at")} < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()
    move_rate_num = db.execute(
        text(
            f"""
            WITH cohort AS (
                SELECT id FROM stays
                 WHERE {_BD.format(col="actual_check_in_at")} >= :from
                   AND {_BD.format(col="actual_check_in_at")} < :to
            ),
            moved AS (
                SELECT DISTINCT stay_id FROM stay_room_assignments
                 WHERE reason IS NOT NULL
                   AND {_BD.format(col="started_at")} >= :from
                   AND {_BD.format(col="started_at")} < :to
            )
            SELECT COUNT(*)::int FROM cohort c JOIN moved m ON m.stay_id = c.id
            """
        ),
        {"from": from_date, "to": to_date},
    ).scalar_one()
    checkin_count = checkin_cohort_count(db, from_date, to_date)

    by_reason = db.execute(
        text(
            f"""
            SELECT reason, COUNT(*)::int AS count
              FROM stay_room_assignments
             WHERE reason IS NOT NULL
               AND {_BD.format(col="started_at")} >= :from
               AND {_BD.format(col="started_at")} < :to
             GROUP BY reason
             ORDER BY count DESC, reason
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    by_source_room = db.execute(
        text(
            f"""
            SELECT prev.room_id, r.room_number, COUNT(*)::int AS count
              FROM stay_room_assignments cur
              JOIN stay_room_assignments prev
                ON prev.stay_id = cur.stay_id AND prev.ended_at = cur.started_at
              JOIN rooms r ON r.id = prev.room_id
             WHERE cur.reason IS NOT NULL
               AND {_BD.format(col="cur.started_at")} >= :from
               AND {_BD.format(col="cur.started_at")} < :to
             GROUP BY prev.room_id, r.room_number
             ORDER BY count DESC, r.room_number
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    return {
        "business_date": business_date(),
        "room_move_count": moves.move_count,
        "moved_stay_count": moves.moved_stays,
        "room_move_rate": _rate(move_rate_num, checkin_count),
        "room_moves_by_reason": [
            {"reason": r.reason, "count": r.count} for r in by_reason
        ],
        "room_moves_by_source_room": [
            {"room_id": r.room_id, "room_number": r.room_number, "count": r.count}
            for r in by_source_room
        ],
    }


# ---------------------------------------------------------------------------
# Business: Contracted Room Value（§17-§22）
# ---------------------------------------------------------------------------


def business_rooms_analytics(db: Session, from_date: date, to_date: date) -> dict:
    """合同房费分析：只有已实际入住形成的 Stay 住宿可以贡献（§19）。"""
    current_bd = business_date()
    physical_count = physical_room_count(db)
    report_days = (to_date - from_date).days

    # 每晚：是否落在 Reservation planned interval 内；落在则贡献 contracted_nightly_value。
    # 超出原计划区间的实际住宿：occupied night 计入 unpriced，contract value 不计（不猜价格）。
    sql = text(
        f"""
        WITH stay_intervals AS (
            SELECT id,
                   reservation_id,
                   {_BD.format(col="actual_check_in_at")} AS check_in_bd,
                   CASE WHEN status = 'ACTIVE' THEN :current_bd
                        ELSE {_BD.format(col="actual_check_out_at")} END AS check_out_bd
              FROM stays
        ),
        nights AS (
            SELECT s.id AS stay_id,
                   g.day::date AS business_date,
                   r.check_in_date,
                   r.check_out_date,
                   r.agreed_total_amount,
                   (r.check_out_date - r.check_in_date) AS planned_nights
              FROM stay_intervals s
              JOIN reservations r ON r.id = s.reservation_id
              JOIN generate_series(CAST(:from AS date), CAST(:to AS date) - 1, interval '1 day') AS g(day)
                ON g.day::date >= s.check_in_bd AND g.day::date < s.check_out_bd
        )
        SELECT
            COUNT(*) FILTER (WHERE
                business_date >= check_in_date AND business_date < check_out_date
            )::int AS priced,
            COUNT(*) FILTER (WHERE NOT (
                business_date >= check_in_date AND business_date < check_out_date
            ))::int AS unpriced,
            COALESCE(SUM(
                agreed_total_amount / NULLIF(planned_nights, 0)
            ) FILTER (WHERE
                business_date >= check_in_date AND business_date < check_out_date
            ), 0) AS contracted_value
          FROM nights
        """
    )
    total = db.execute(
        sql, {"from": from_date, "to": to_date, "current_bd": current_bd}
    ).one()

    daily_sql = text(
        f"""
        WITH stay_intervals AS (
            SELECT id,
                   reservation_id,
                   {_BD.format(col="actual_check_in_at")} AS check_in_bd,
                   CASE WHEN status = 'ACTIVE' THEN :current_bd
                        ELSE {_BD.format(col="actual_check_out_at")} END AS check_out_bd
              FROM stays
        ),
        nights AS (
            SELECT s.id AS stay_id,
                   g.day::date AS business_date,
                   r.check_in_date,
                   r.check_out_date,
                   r.agreed_total_amount,
                   (r.check_out_date - r.check_in_date) AS planned_nights
              FROM stay_intervals s
              JOIN reservations r ON r.id = s.reservation_id
              JOIN generate_series(CAST(:from AS date), CAST(:to AS date) - 1, interval '1 day') AS g(day)
                ON g.day::date >= s.check_in_bd AND g.day::date < s.check_out_bd
        )
        SELECT business_date,
               COUNT(*) FILTER (WHERE
                   business_date >= check_in_date AND business_date < check_out_date
               )::int AS priced,
               COALESCE(SUM(
                   agreed_total_amount / NULLIF(planned_nights, 0)
               ) FILTER (WHERE
                   business_date >= check_in_date AND business_date < check_out_date
               ), 0) AS contracted_value
          FROM nights
         GROUP BY business_date
         ORDER BY business_date
        """
    )
    daily_rows = db.execute(
        daily_sql, {"from": from_date, "to": to_date, "current_bd": current_bd}
    ).all()

    priced = total.priced
    unpriced = total.unpriced
    value = _money(Decimal(total.contracted_value))
    physical_nights = physical_count * report_days

    def _dec_rate(v: Decimal, d: int) -> Decimal | None:
        if d == 0:
            return None
        return (v / Decimal(d)).quantize(Decimal("0.0001"))

    daily = []
    daily_by_date = {r.business_date: r for r in daily_rows}
    for i in range(report_days):
        day = from_date + timedelta(days=i)
        r = daily_by_date.get(day)
        daily.append(
            {
                "business_date": day,
                "contracted_room_value": _money(Decimal(r.contracted_value)) if r else ZERO,
                "priced_occupied_room_nights": r.priced if r else 0,
            }
        )

    return {
        "business_date": current_bd,
        "contracted_room_value": value,
        "priced_occupied_room_nights": priced,
        "unpriced_occupied_room_nights": unpriced,
        "contracted_adr": _dec_rate(value, priced),
        "contracted_revpar": _dec_rate(value, physical_nights),
        "physical_room_nights": physical_nights,
        "daily": daily,
    }


# ---------------------------------------------------------------------------
# Business: Inventory（§26-§28）
# ---------------------------------------------------------------------------


def inventory_analytics(db: Session, from_date: date, to_date: date) -> dict:
    """库存分析：低/缺货快照 + 每物资领用量与领用强度（不跨 Base Unit 求和，§26）。"""
    current_bd = business_date()

    items = db.execute(
        text(
            """
            SELECT id, item_code, name, category, base_unit,
                   minimum_stock, is_active
              FROM inventory_items
             ORDER BY id
            """
        )
    ).all()
    totals = dict(
        db.execute(
            text(
                "SELECT item_id, SUM(quantity) FROM inventory_balances GROUP BY item_id"
            )
        ).all()
    )
    issues = dict(
        db.execute(
            text(
                f"""
                SELECT item_id, SUM(ABS(quantity))
                  FROM stock_movements
                 WHERE movement_type = 'ISSUE'
                   AND {_BD.format(col="created_at")} >= :from
                   AND {_BD.format(col="created_at")} < :to
                 GROUP BY item_id
                """
            ),
            {"from": from_date, "to": to_date},
        ).all()
    )

    occupied = _occupied_room_nights(db, from_date, to_date)
    low_count = 0
    out_count = 0
    item_rows: list[dict] = []
    for item in items:
        total = Decimal(totals.get(item.id, ZERO))
        minimum = Decimal(item.minimum_stock)
        if total == 0:
            status = "OUT_OF_STOCK"
        elif minimum > 0 and total <= minimum:
            status = "LOW_STOCK"
        else:
            status = "NORMAL"
        if item.is_active:
            if status == "OUT_OF_STOCK":
                out_count += 1
            elif status == "LOW_STOCK":
                low_count += 1
        issue_qty = Decimal(issues.get(item.id, ZERO))
        item_rows.append(
            {
                "item_id": item.id,
                "item_code": item.item_code,
                "name": item.name,
                "category": item.category,
                "base_unit": item.base_unit,
                "stock_status": status,
                "total_stock": total,
                "is_active": item.is_active,
                "issue_quantity": issue_qty,
                # 分母（实际房晚）= 0 -> null；否则 0 领用 = 0.0（§28/§33）
                "issue_quantity_per_occupied_room_night": _rate(issue_qty, occupied),
            }
        )

    return {
        "business_date": current_bd,
        "current_low_stock_items": low_count,
        "current_out_of_stock_items": out_count,
        "occupied_room_nights": occupied,
        "items": item_rows,
    }


# ---------------------------------------------------------------------------
# Business: Procurement（§29/§30）
# ---------------------------------------------------------------------------


def procurement_analytics(db: Session, from_date: date, to_date: date) -> dict:
    current_bd = business_date()

    row = db.execute(
        text(
            f"""
            SELECT
              (SELECT COUNT(*)::int FROM purchase_requests
                WHERE {_BD.format(col="created_at")} >= :from
                  AND {_BD.format(col="created_at")} < :to) AS pr_created,
              (SELECT COUNT(*)::int FROM purchase_requests
                WHERE status IN ('SUBMITTED','APPROVED')) AS pending_pr,
              (SELECT COUNT(*)::int FROM purchase_orders
                WHERE {_BD.format(col="created_at")} >= :from
                  AND {_BD.format(col="created_at")} < :to) AS po_created,
              (SELECT COUNT(*)::int FROM purchase_orders
                WHERE status IN ('ORDERED','PARTIALLY_RECEIVED')) AS pending_receipt,
              (SELECT COUNT(*)::int FROM purchase_orders
                WHERE status = 'PARTIALLY_RECEIVED') AS partially_received
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    value_row = db.execute(
        text(
            f"""
            SELECT COALESCE(SUM(grl.received_quantity * pol.unit_price)
                    FILTER (WHERE pol.unit_price IS NOT NULL), 0) AS value,
                   COUNT(*) FILTER (WHERE pol.unit_price IS NULL)::int AS unpriced_lines
              FROM goods_receipt_lines grl
              JOIN goods_receipts gr ON gr.id = grl.receipt_id
              JOIN purchase_order_lines pol ON pol.id = grl.purchase_order_line_id
             WHERE {_BD.format(col="gr.received_at")} >= :from
               AND {_BD.format(col="gr.received_at")} < :to
            """
        ),
        {"from": from_date, "to": to_date},
    ).one()

    by_supplier = db.execute(
        text(
            f"""
            SELECT po.supplier_id, s.supplier_code, s.name AS supplier_name,
                   COALESCE(SUM(grl.received_quantity * pol.unit_price)
                       FILTER (WHERE pol.unit_price IS NOT NULL), 0) AS value
              FROM goods_receipt_lines grl
              JOIN goods_receipts gr ON gr.id = grl.receipt_id
              JOIN purchase_order_lines pol ON pol.id = grl.purchase_order_line_id
              JOIN purchase_orders po ON po.id = gr.purchase_order_id
              JOIN suppliers s ON s.id = po.supplier_id
             WHERE {_BD.format(col="gr.received_at")} >= :from
               AND {_BD.format(col="gr.received_at")} < :to
             GROUP BY po.supplier_id, s.supplier_code, s.name
             ORDER BY value DESC
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    by_item = db.execute(
        text(
            f"""
            SELECT pol.item_id, i.item_code, i.name AS item_name, i.base_unit,
                   COALESCE(SUM(grl.received_quantity * pol.unit_price)
                       FILTER (WHERE pol.unit_price IS NOT NULL), 0) AS value
              FROM goods_receipt_lines grl
              JOIN goods_receipts gr ON gr.id = grl.receipt_id
              JOIN purchase_order_lines pol ON pol.id = grl.purchase_order_line_id
              JOIN inventory_items i ON i.id = pol.item_id
             WHERE {_BD.format(col="gr.received_at")} >= :from
               AND {_BD.format(col="gr.received_at")} < :to
             GROUP BY pol.item_id, i.item_code, i.name, i.base_unit
             ORDER BY value DESC
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    daily = db.execute(
        text(
            f"""
            SELECT {_BD.format(col="gr.received_at")} AS business_date,
                   COALESCE(SUM(grl.received_quantity * pol.unit_price)
                       FILTER (WHERE pol.unit_price IS NOT NULL), 0) AS value
              FROM goods_receipt_lines grl
              JOIN goods_receipts gr ON gr.id = grl.receipt_id
              JOIN purchase_order_lines pol ON pol.id = grl.purchase_order_line_id
             WHERE {_BD.format(col="gr.received_at")} >= :from
               AND {_BD.format(col="gr.received_at")} < :to
             GROUP BY {_BD.format(col="gr.received_at")}
             ORDER BY {_BD.format(col="gr.received_at")}
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    return {
        "business_date": current_bd,
        "purchase_requests_created": row.pr_created,
        "pending_purchase_requests": row.pending_pr,
        "purchase_orders_created": row.po_created,
        "pending_receipt_orders": row.pending_receipt,
        "partially_received_orders": row.partially_received,
        "received_purchase_value": _money(Decimal(value_row.value)),
        "unpriced_received_lines": value_row.unpriced_lines,
        "received_value_by_supplier": [
            {
                "supplier_id": r.supplier_id,
                "supplier_code": r.supplier_code,
                "supplier_name": r.supplier_name,
                "received_value": _money(Decimal(r.value)),
            }
            for r in by_supplier
        ],
        "received_value_by_item": [
            {
                "item_id": r.item_id,
                "item_code": r.item_code,
                "item_name": r.item_name,
                "base_unit": r.base_unit,
                "received_value": _money(Decimal(r.value)),
            }
            for r in by_item
        ],
        "daily": [
            {"business_date": r.business_date, "received_purchase_value": _money(Decimal(r.value))}
            for r in daily
        ],
    }


# ---------------------------------------------------------------------------
# Business: Channel Performance（alpha.9.6 F4 客源渠道经营分析）
# ---------------------------------------------------------------------------


def channel_performance_analytics(
    db: Session, from_date: date, to_date: date
) -> dict:
    """客源渠道经营分析（「客人从哪里来」）。

    统计口径（LOCKED，见 docs/DECISIONS.md；全部复用既有事实源，不新增口径）：

    - **归因链**：`Stay -> Reservation.source_channel_id -> Channel`。
      每单恰好归因一次（`COUNT(DISTINCT reservation_id)`），无二次计数。
    - **订单数 order_count**：Arrival Cohort —— `reservation.check_in_date ∈ [from, to)`，
      且排除 `CANCELLED` / `NO_SHOW`（取消单不计入正式经营订单）。
      与 `/analytics/operations/bookings` 的 cohort 同源同界。
    - **实际占用房晚 occupied_room_nights**：逐字复用 `_stay_intervals_sql`
      （COMPLETED 用 `bd(actual_check_out_at)`，ACTIVE 用 `current_business_date`
      exclusive），只对同时归属于该渠道的住宿计数。
    - **合同房费 contracted_room_value**：逐字复用
      `business_rooms_analytics` 的 `agreed_total_amount / planned_nights ×
      实际占用且落在计划区间内的房晚`。**不是实际收款**（StayOps 无
      Folio / Payment / Settlement），UI 必须注明。
    - **合同 ADR contracted_adr** = 合同房费 ÷ 有价实际房晚（分母 0 -> null）。
    - **渠道占比 share** = 该渠道合同房费 ÷ 区间合同房费总额（分母 0 -> null）。
    - `unassigned`：`source_channel_id IS NULL` 的预订（历史兼容路径），
      单独计一桶，保证 `Σ channels + unassigned == totals`。
    - 默认包含「启用但区间内无业务」的渠道（count=0 / value=0），
      便于经营者看到全覆盖渠道清单；`include_zero=False` 可只返回有业务的渠道。
    """
    current_bd = business_date()

    # --- 订单数（Arrival Cohort；排除 CANCELLED / NO_SHOW） ---
    order_rows = db.execute(
        text(
            """
            SELECT r.source_channel_id AS channel_id,
                   COUNT(*)::int AS order_count
              FROM reservations r
             WHERE r.check_in_date >= :from
               AND r.check_in_date < :to
               AND r.status NOT IN ('CANCELLED', 'NO_SHOW')
             GROUP BY r.source_channel_id
            """
        ),
        {"from": from_date, "to": to_date},
    ).all()

    # --- 房晚 + 合同房费（与 business_rooms_analytics 同一 CTE 语义） ---
    # 注意：一个 Stay 可能含 Room Move，因此按 distinct stay 计一次房晚，
    # 渠道归因走 Stay -> Reservation（而非 assignment），天然防重复计数。
    revenue_rows = db.execute(
        text(
            f"""
            WITH stay_intervals AS (
                SELECT id,
                       reservation_id,
                       {_BD.format(col="actual_check_in_at")} AS check_in_bd,
                       CASE WHEN status = 'ACTIVE' THEN :current_bd
                            ELSE {_BD.format(col="actual_check_out_at")} END
                           AS check_out_bd
                  FROM stays
            ),
            nights AS (
                SELECT s.id AS stay_id,
                       r.source_channel_id AS channel_id,
                       g.day::date AS business_date,
                       r.check_in_date,
                       r.check_out_date,
                       r.agreed_total_amount,
                       (r.check_out_date - r.check_in_date) AS planned_nights
                  FROM stay_intervals s
                  JOIN reservations r ON r.id = s.reservation_id
                  JOIN generate_series(
                         CAST(:from AS date), CAST(:to AS date) - 1, interval '1 day'
                       ) AS g(day)
                    ON g.day::date >= s.check_in_bd
                   AND g.day::date < s.check_out_bd
            )
            SELECT channel_id,
                   COUNT(*) FILTER (WHERE business_date >= check_in_date
                                      AND business_date < check_out_date)::int
                       AS priced_nights,
                   COUNT(*) FILTER (WHERE NOT (business_date >= check_in_date
                                      AND business_date < check_out_date))::int
                       AS unpriced_nights,
                   COUNT(DISTINCT stay_id)::int AS stay_count,
                   COALESCE(SUM(agreed_total_amount / NULLIF(planned_nights, 0))
                       FILTER (WHERE business_date >= check_in_date
                                 AND business_date < check_out_date), 0)
                       AS contracted_value
              FROM nights
             GROUP BY channel_id
            """
        ),
        {"from": from_date, "to": to_date, "current_bd": current_bd},
    ).all()

    orders_by_channel = {r.channel_id: r.order_count for r in order_rows}
    revenue_by_channel = {r.channel_id: r for r in revenue_rows}

    channels = db.scalars(
        select(Channel).order_by(Channel.sort_order, Channel.id)
    ).all()

    rows: list[dict] = []
    total_value = ZERO
    total_orders = 0
    total_nights = 0
    total_stays = 0

    for channel in channels:
        orders = orders_by_channel.get(channel.id, 0)
        rev = revenue_by_channel.get(channel.id)
        value = _money(Decimal(rev.contracted_value)) if rev else ZERO
        nights = rev.priced_nights if rev else 0
        stays = rev.stay_count if rev else 0
        total_value += value
        total_orders += orders
        total_nights += nights
        total_stays += stays
        rows.append(
            {
                "channel_id": channel.id,
                "channel_code": channel.code,
                "channel_name": channel.name,
                "channel_category": channel.category,
                "channel_enabled": channel.enabled,
                "is_system": channel.is_system,
                "order_count": orders,
                "stay_count": stays,
                "occupied_room_nights": nights,
                "contracted_room_value": value,
                "contracted_adr": (
                    (value / Decimal(nights)).quantize(Decimal("0.01"))
                    if nights
                    else None
                ),
            }
        )

    # 「未指定渠道」桶（source_channel_id IS NULL；历史兼容路径）
    unassigned_orders = orders_by_channel.get(None, 0)
    unassigned_rev = revenue_by_channel.get(None)
    unassigned_value = (
        _money(Decimal(unassigned_rev.contracted_value)) if unassigned_rev else ZERO
    )
    unassigned_nights = unassigned_rev.priced_nights if unassigned_rev else 0
    unassigned_stays = unassigned_rev.stay_count if unassigned_rev else 0
    total_value += unassigned_value
    total_orders += unassigned_orders
    total_nights += unassigned_nights
    total_stays += unassigned_stays

    # 占比（分母 0 -> null；禁止 NaN/Infinity）
    for row in rows:
        row["share"] = _rate(row["contracted_room_value"], total_value)

    unassigned_row = {
        "channel_id": None,
        "channel_code": None,
        "channel_name": "未指定渠道",
        "channel_category": None,
        "channel_enabled": True,
        "is_system": False,
        "order_count": unassigned_orders,
        "stay_count": unassigned_stays,
        "occupied_room_nights": unassigned_nights,
        "contracted_room_value": unassigned_value,
        "contracted_adr": (
            (unassigned_value / Decimal(unassigned_nights)).quantize(
                Decimal("0.01")
            )
            if unassigned_nights
            else None
        ),
        "share": _rate(unassigned_value, total_value),
    }

    return {
        "business_date": current_bd,
        "physical_room_count": physical_room_count(db),
        "totals": {
            "order_count": total_orders,
            "stay_count": total_stays,
            "occupied_room_nights": total_nights,
            "contracted_room_value": _money(total_value),
            "contracted_adr": (
                (total_value / Decimal(total_nights)).quantize(Decimal("0.01"))
                if total_nights
                else None
            ),
        },
        "channels": rows,
        "unassigned": unassigned_row,
    }


# ---------------------------------------------------------------------------
# Comparison（§31/§32 + D1 Calendar Preset Comparison semantics）
# ---------------------------------------------------------------------------

# 正式 Comparison Modes（D1.1 LOCKED）：
#   equal_length              等长前移：Last 7/30/90 Days、Custom
#   previous_calendar_month   上一完整自然月：Last Month
#   previous_month_elapsed    上一自然月同 elapsed 日跨度（clamp 于上月月末）：
#                             This Month
COMPARISON_MODE_EQUAL_LENGTH = "equal_length"
COMPARISON_MODE_PREVIOUS_CALENDAR_MONTH = "previous_calendar_month"
COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED = "previous_month_elapsed"
COMPARISON_MODES = (
    COMPARISON_MODE_EQUAL_LENGTH,
    COMPARISON_MODE_PREVIOUS_CALENDAR_MONTH,
    COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED,
)
DEFAULT_COMPARISON_MODE = COMPARISON_MODE_EQUAL_LENGTH


def previous_period(
    from_date: date, to_date: date, mode: str = DEFAULT_COMPARISON_MODE
) -> tuple[date, date]:
    """按 Comparison Mode 计算前一个周期（Backend 权威，D1）。

    - equal_length：current [from, to) -> previous [from - days, from)。
    - previous_calendar_month：current 为本自然月区间时，
      previous = [上月初, 本月初)（两月天数无需相同）。
    - previous_month_elapsed：current 为 [本月初, from)（MTD）时，
      previous = [上月初, 上月初 + elapsed)，elapsed = from - 本月初；
      **clamp 于上一自然月月末**（禁止跨出上一自然月凑等长，D1.2）：
      例如 3 月已过 30 日、2 月只有 28 天 -> previous = [2/1, 3/1)。
      闰年 2 月（29 天）、30/31 天月、1 月 vs 12 月（跨年）同理由月末钳制。
    """
    if mode == COMPARISON_MODE_EQUAL_LENGTH:
        days = (to_date - from_date).days
        return from_date - timedelta(days=days), from_date
    month_start = from_date.replace(day=1)
    prev_month_start = (month_start - timedelta(days=1)).replace(day=1)
    if mode == COMPARISON_MODE_PREVIOUS_CALENDAR_MONTH:
        return prev_month_start, month_start
    if mode == COMPARISON_MODE_PREVIOUS_MONTH_ELAPSED:
        # current = [本月初, ...)（MTD）；elapsed = 当前区间自身天数 = to - from
        elapsed = (to_date - from_date).days
        prev_end = prev_month_start + timedelta(days=elapsed)
        clamped_end = min(prev_end, month_start)  # clamp 于上一自然月月末（D1.2）
        return prev_month_start, clamped_end
    raise ValueError(f"未知 comparison_mode: {mode}")


RATE_METRICS = (
    "physical_occupancy_rate",
    "cancellation_rate",
    "no_show_rate",
    "room_move_rate",
)


def build_comparison(
    current: dict, previous: dict, prev_from: date, prev_to: date
) -> dict:
    """按 §32 计算对比：比率 -> pp_delta；数量/金额/平均 -> percent_change（prev=0 -> null）。"""
    changes: dict[str, dict] = {}
    for key, value in current.items():
        prev_value = previous.get(key)
        if key in RATE_METRICS:
            if value is not None and prev_value is not None:
                changes[key] = {"pp_delta": round(value - prev_value, 4)}
            else:
                changes[key] = {"pp_delta": None}
        else:
            if isinstance(value, bool) or value is None or prev_value is None:
                changes[key] = {"percent_change": None}
            else:
                changes[key] = {
                    "percent_change": _percent_change(float(value), float(prev_value))
                }
    return {
        "period": {"from": prev_from, "to": prev_to, "days": (prev_to - prev_from).days},
        "metrics": previous,
        "changes": changes,
    }
