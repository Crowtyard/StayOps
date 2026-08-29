"""Analytics Metric Dictionary（经营指标语义层，Sprint 8）。

本模块是 StayOps 经营指标的集中定义（Metric Definitions / constants），
是 docs/ANALYTICS.md 的代码镜像。每一个正式 Metric 记录：

    code                      指标代码（稳定，API / 前端 / 文档共用）
    name_zh                   中文名
    name_en                   English Name
    domain                    operations | business（Analytics 权限域，§35）
    definition                定义
    formula                   公式
    source_tables             来源表（正式业务表 = Source of Truth，§2.1）
    date_basis                日期口径（一律 Business Date，Asia/Shanghai，§2.4）
    included_statuses         纳入状态
    excluded_statuses         排除状态
    unit                      单位
    zero_denominator_behavior 分母为 0 的行为（null / 0 / 空数组）
    required_permission       所需权限 code

原则（Sprint 8 §2/§39）：
- Analytics = read-only derived layer；正式业务表仍然是 Source of Truth。
- 不建立 daily_statistics / analytics_fact 等第二套业务事实；不建 analytics 表。
- Backend 是指标计算唯一权威；Frontend 只 request → format / visualize。
- 禁止 NaN / Infinity；Count -> 0，Rate/Average 分母 0 -> null，Empty series -> []。

Metric code 一经发布保持稳定（API 契约的一部分）。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class MetricDefinition:
    code: str
    name_zh: str
    name_en: str
    domain: str  # "operations" | "business"
    definition: str
    formula: str
    source_tables: tuple[str, ...]
    date_basis: str
    unit: str
    zero_denominator_behavior: str
    required_permission: str
    included_statuses: str = "-"
    excluded_statuses: str = "-"
    aliases: tuple[str, ...] = field(default_factory=tuple)


# 报告区间一律为半开区间 [from, to)（§2.4），Actual 至多到 current_business_date（exclusive，§3）。
_PERIOD = "报告区间 [from, to)，Business Date（Asia/Shanghai）"
_TODAY = "Business Date = current_business_date（Asia/Shanghai）"
_SNAPSHOT = f"当前时刻快照（{_TODAY}）"

METRICS: dict[str, MetricDefinition] = {}


def _register(m: MetricDefinition) -> MetricDefinition:
    METRICS[m.code] = m
    return m


# ---------------------------------------------------------------------------
# Occupancy（占用）— operations
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="actual_occupied_room_nights",
        name_zh="实际占用房晚",
        name_en="Actual Occupied Room Nights",
        domain="operations",
        definition="报告区间内实际占用房晚数。酒店总体房晚 MUST derive from Stay（§5），"
        "禁止对 StayRoomAssignment 时长求和（Room Move 防重复计数）。",
        formula="Σ over Stays of |[from, to) ∩ [business_date(actual_check_in_at), "
        "check_out_bd)|，其中 COMPLETED Stay 的 check_out_bd = "
        "business_date(actual_check_out_at)，ACTIVE Stay 的 check_out_bd = "
        "current_business_date（实际历史不能被 planned_checkout 截断，§4）。",
        source_tables=("stays",),
        date_basis=_PERIOD,
        included_statuses="ACTIVE（仅统计到 current_business_date 之前的实际历史）、CHECKED_OUT",
        excluded_statuses="-",
        unit="nights",
        zero_denominator_behavior="0（无 Stay 时为空区间计 0）",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="physical_room_nights",
        name_zh="物理房晚（可售房晚上限）",
        name_en="Physical Room Nights",
        domain="operations",
        definition="报告区间内物理房间×天数的理论房晚上限。physical_room_count 必须查询"
        "当前正式 Room master（§6），禁止硬编码 28。Alpha.8 假设报告期内物理房间"
        "库存稳定（当前无 Room physical-lifecycle history）。",
        formula="physical_room_count × report_days（report_days = (to - from).days）",
        source_tables=("rooms",),
        date_basis=_PERIOD,
        included_statuses="全部 Room 行（含 blocked / out_of_service）",
        excluded_statuses="-",
        unit="nights",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="physical_occupancy_rate",
        name_zh="物理入住率",
        name_en="Physical Occupancy Rate",
        domain="operations",
        definition="实际占用房晚 ÷ 物理房晚（§7）。只提供 Physical Occupancy；"
        "禁止 Sellable Occupancy（Alpha.8 无可靠历史 room_sellability_intervals，§8）。",
        formula="actual_occupied_room_nights / physical_room_nights",
        source_tables=("stays", "rooms"),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="ratio 0..1（UI 显示百分比）",
        zero_denominator_behavior="null（禁止 NaN / Infinity）",
        required_permission="analytics:operations_read",
    )
)

# ---------------------------------------------------------------------------
# Stay / 入住（Stay）— operations
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="active_stays",
        name_zh="当前在住",
        name_en="Active Stays",
        domain="operations",
        definition="当前 ACTIVE 的 Stay 数量（Snapshot）。",
        formula="COUNT(stays WHERE status = 'ACTIVE')",
        source_tables=("stays",),
        date_basis=_SNAPSHOT,
        included_statuses="ACTIVE",
        excluded_statuses="CHECKED_OUT",
        unit="stays",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="overdue_active_stays",
        name_zh="超期在住",
        name_en="Overdue Active Stays",
        domain="operations",
        definition="planned_check_out_date <= current_business_date 的 ACTIVE Stay 数量"
        "（运营问题项；不得因此擅自发明未来住宿房晚，§10）。",
        formula="COUNT(stays WHERE status = 'ACTIVE' AND planned_check_out_date <= "
        "current_business_date)",
        source_tables=("stays",),
        date_basis=_SNAPSHOT,
        included_statuses="ACTIVE 且超期",
        excluded_statuses="CHECKED_OUT / 未超期",
        unit="stays",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="completed_stays",
        name_zh="完成住宿数",
        name_en="Completed Stays",
        domain="operations",
        definition="actual_check_out_at 的 Business Date 落在报告区间的已退房 Stay 数量"
        "（ALOS 的 cohort 分母，§16）。",
        formula="COUNT(stays WHERE business_date(actual_check_out_at) ∈ [from, to))",
        source_tables=("stays",),
        date_basis=_PERIOD,
        included_statuses="CHECKED_OUT",
        excluded_statuses="ACTIVE",
        unit="stays",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="average_length_of_stay",
        name_zh="平均住宿时长",
        name_en="Average Length of Stay (ALOS)",
        domain="operations",
        definition="完成住宿 cohort 的实际平均房晚数（§16）。使用实际 check-in → "
        "checkout，不使用计划 Reservation nights。",
        formula="Σ(business_date(actual_check_out_at) - business_date(actual_check_in_at)) "
        "/ completed_stays（cohort：business_date(actual_check_out_at) ∈ [from, to)）",
        source_tables=("stays",),
        date_basis=_PERIOD,
        included_statuses="CHECKED_OUT",
        excluded_statuses="ACTIVE",
        unit="nights / stay",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

# ---------------------------------------------------------------------------
# Arrival Cohort（预订到达组）— operations
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="scheduled_arrivals",
        name_zh="计划到店预订数",
        name_en="Scheduled Arrivals",
        domain="operations",
        definition="Arrival Cohort = Reservation.check_in_date ∈ [from, to)（§12）。"
        "该组内全部预订（含后续 CANCELLED / NO_SHOW）。",
        formula="COUNT(reservations WHERE check_in_date ∈ [from, to))",
        source_tables=("reservations",),
        date_basis=_PERIOD,
        included_statuses="全部状态（CONFIRMED / CANCELLED / NO_SHOW / CHECKED_IN / COMPLETED）",
        excluded_statuses="-",
        unit="reservations",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="cancelled_arrivals",
        name_zh="已取消到店预订数",
        name_en="Cancelled Arrivals",
        domain="operations",
        definition="Arrival Cohort 内状态为 CANCELLED 的预订数。",
        formula="COUNT(reservations WHERE check_in_date ∈ [from, to) AND status = 'CANCELLED')",
        source_tables=("reservations",),
        date_basis=_PERIOD,
        included_statuses="CANCELLED",
        excluded_statuses="其它",
        unit="reservations",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="cancellation_rate",
        name_zh="取消率",
        name_en="Cancellation Rate",
        domain="operations",
        definition="Arrival Cohort 内取消比例（§13）。",
        formula="cancelled_arrivals / scheduled_arrivals（Arrival Cohort 全量）",
        source_tables=("reservations",),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="ratio 0..1（UI 显示百分比）",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="no_show_count",
        name_zh="未到店数",
        name_en="No-show Count",
        domain="operations",
        definition="Arrival Cohort 内状态为 NO_SHOW 的预订数。",
        formula="COUNT(reservations WHERE check_in_date ∈ [from, to) AND status = 'NO_SHOW')",
        source_tables=("reservations",),
        date_basis=_PERIOD,
        included_statuses="NO_SHOW",
        excluded_statuses="其它",
        unit="reservations",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="no_show_rate",
        name_zh="未到店率",
        name_en="No-show Rate",
        domain="operations",
        definition="NO_SHOW ÷ 非 CANCELLED 的 Arrival Cohort（§14）。",
        formula="no_show_count / (scheduled_arrivals - cancelled_arrivals)",
        source_tables=("reservations",),
        date_basis=_PERIOD,
        included_statuses="NO_SHOW",
        excluded_statuses="CANCELLED（从分母排除）",
        unit="ratio 0..1（UI 显示百分比）",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="average_booking_lead_days",
        name_zh="平均预订提前天数",
        name_en="Average Booking Lead Days",
        domain="operations",
        definition="非 CANCELLED 的 Arrival Cohort 平均预订提前天数（§15）。"
        "lead_days = max(0, check_in_date - business_date(created_at))；"
        "提前天数不可能为负（改期导致 created 晚于 check_in 的按 0 计）。",
        formula="AVG(max(0, check_in_date - business_date(created_at))) "
        "over non-CANCELLED Arrival Cohort",
        source_tables=("reservations",),
        date_basis=_PERIOD,
        included_statuses="非 CANCELLED（CONFIRMED / NO_SHOW / CHECKED_IN / COMPLETED）",
        excluded_statuses="CANCELLED",
        unit="days",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="booking_lead_distribution",
        name_zh="预订提前天数分布",
        name_en="Booking Lead Distribution",
        domain="operations",
        definition="非 CANCELLED 的 Arrival Cohort 按提前天数分桶（§15，Bucket 逻辑 Backend 权威）。",
        formula="lead_days ∈ [0,1] -> 0-1；[2,3] -> 2-3；[4,7] -> 4-7；[8,14] -> 8-14；"
        "[15,30] -> 15-30；≥31 -> 31+",
        source_tables=("reservations",),
        date_basis=_PERIOD,
        included_statuses="非 CANCELLED",
        excluded_statuses="CANCELLED",
        unit="reservations / bucket",
        zero_denominator_behavior="[]（空分布）",
        required_permission="analytics:operations_read",
    )
)

# ---------------------------------------------------------------------------
# Room Move（换房）— operations
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="room_move_count",
        name_zh="换房次数",
        name_en="Room Move Count",
        domain="operations",
        definition="报告区间内的 Room Move 事件数（§25）。Move event = "
        "StayRoomAssignment.reason IS NOT NULL；Move timestamp = 新 assignment 的 started_at。",
        formula="COUNT(stay_room_assignments WHERE reason IS NOT NULL AND "
        "business_date(started_at) ∈ [from, to))",
        source_tables=("stay_room_assignments",),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="reason IS NULL（初始入住分配）",
        unit="moves",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="moved_stay_count",
        name_zh="发生换房的住宿数",
        name_en="Moved Stay Count",
        domain="operations",
        definition="报告区间内发生过 ≥1 次换房的 distinct Stay 数（一个 Stay 换房三次："
        "room_move_count = 3、moved_stay_count = 1，§25）。",
        formula="COUNT(DISTINCT stay_id) over move events in period",
        source_tables=("stay_room_assignments",),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="stays",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="room_move_rate",
        name_zh="换房率",
        name_en="Room Move Rate",
        domain="operations",
        definition="到达 cohort（actual check-in Business Date ∈ [from, to)）中发生过 ≥1 次"
        "换房的 Stay 占比（§25）。",
        formula="stays with ≥1 move in period / stays with business_date(actual_check_in_at) ∈ [from, to)",
        source_tables=("stays", "stay_room_assignments"),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="ratio 0..1（UI 显示百分比）",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

# ---------------------------------------------------------------------------
# Contracted Room Value（合同房费）— business（§17/§19/§21/§22）
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="contracted_room_value",
        name_zh="合同房费金额",
        name_en="Contracted Room Value",
        domain="business",
        definition="报告区间内已实际入住房晚的合同房费金额（§19）。只有已经实际入住形成 "
        "Stay 的住宿可以贡献；每个 Actual occupied night 若同时落在 Reservation planned "
        "interval 且 agreed_total_amount 可用，则贡献 contracted_nightly_value = "
        "agreed_total_amount / planned_nights。超出原计划区间的实际住宿：occupied night 计入，"
        "contracted value 不计入（不得猜价格）。Money 一律 Decimal/Numeric（§18）。",
        formula="Σ contracted_nightly_value over priced occupied nights in [from, to) "
        "（contracted_nightly_value = agreed_total_amount / (check_out_date - check_in_date)）",
        source_tables=("stays", "reservations"),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="CNY（Decimal 字符串序列化）",
        zero_denominator_behavior="Decimal('0')",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="priced_occupied_room_nights",
        name_zh="有价实际房晚",
        name_en="Priced Occupied Room Nights",
        domain="business",
        definition="报告区间内具有可靠合同单价的 Actual occupied nights（§20）。",
        formula="COUNT(actual occupied nights in [from, to) with night ∈ "
        "[check_in_date, check_out_date) of linked reservation)",
        source_tables=("stays", "reservations"),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="nights",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="unpriced_occupied_room_nights",
        name_zh="无价实际房晚",
        name_en="Unpriced Occupied Room Nights",
        domain="business",
        definition="没有可靠合同单价的 Actual occupied nights（§20 Data Quality）。"
        "正常期望 0；> 0 必须显式暴露。不允许使用前一晚价格 / 平均价格补值。",
        formula="actual_occupied_room_nights - priced_occupied_room_nights",
        source_tables=("stays", "reservations"),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="nights",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="contracted_adr",
        name_zh="合同 ADR",
        name_en="Contracted ADR (Average Daily Rate)",
        domain="business",
        definition="合同房费金额 ÷ 有价实际房晚（§21）。UI 必须说明：非实际收款。",
        formula="contracted_room_value / priced_occupied_room_nights",
        source_tables=("stays", "reservations"),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="CNY / night（Decimal 字符串序列化）",
        zero_denominator_behavior="null",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="contracted_revpar",
        name_zh="合同 RevPAR",
        name_en="Contracted RevPAR (Revenue Per Available Room)",
        domain="business",
        definition="合同房费金额 ÷ 物理房晚（§22）。UI 必须明确：合同 RevPAR、物理房间分母，"
        "不是财务正式 RevPAR。",
        formula="contracted_room_value / physical_room_nights",
        source_tables=("stays", "reservations", "rooms"),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="CNY / physical night（Decimal 字符串序列化）",
        zero_denominator_behavior="null",
        required_permission="analytics:business_read",
    )
)

# ---------------------------------------------------------------------------
# Housekeeping（保洁）— operations
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="housekeeping_completed_tasks",
        name_zh="完成保洁任务数",
        name_en="Housekeeping Completed Tasks",
        domain="operations",
        definition="报告区间内 completed_at Business Date 落在区间内的保洁任务数（§23）。",
        formula="COUNT(housekeeping_tasks WHERE business_date(completed_at) ∈ [from, to))",
        source_tables=("housekeeping_tasks",),
        date_basis=_PERIOD,
        included_statuses="COMPLETED",
        excluded_statuses="CANCELLED / 未完成",
        unit="tasks",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="housekeeping_backlog",
        name_zh="保洁积压",
        name_en="Housekeeping Backlog",
        domain="operations",
        definition="当前进行中的保洁任务数（Snapshot，§23）。不得把当前 backlog 当作"
        "『过去 30 天 backlog』（§9）。",
        formula="COUNT(housekeeping_tasks WHERE status IN "
        "('PENDING','IN_PROGRESS','INSPECTION','REWORK'))",
        source_tables=("housekeeping_tasks",),
        date_basis=_SNAPSHOT,
        included_statuses="PENDING / IN_PROGRESS / INSPECTION / REWORK",
        excluded_statuses="COMPLETED / CANCELLED",
        unit="tasks",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="average_housekeeping_cycle_minutes",
        name_zh="平均保洁周期（分钟）",
        name_en="Average Housekeeping Cycle Minutes",
        domain="operations",
        definition="报告区间内完成任务的 completed_at - created_at 平均分钟数（§23）。",
        formula="AVG(completed_at - created_at) over tasks with "
        "business_date(completed_at) ∈ [from, to)",
        source_tables=("housekeeping_tasks",),
        date_basis=_PERIOD,
        included_statuses="COMPLETED",
        excluded_statuses="其它",
        unit="minutes",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="checkout_turnover_minutes",
        name_zh="退房翻房时长（分钟）",
        name_en="Checkout Turnover Minutes",
        domain="operations",
        definition="source = CHECKOUT 且报告区间内完成的任务 completed_at - created_at "
        "平均分钟数（§23）。",
        formula="AVG(completed_at - created_at) over tasks with source = 'CHECKOUT' "
        "and business_date(completed_at) ∈ [from, to)",
        source_tables=("housekeeping_tasks",),
        date_basis=_PERIOD,
        included_statuses="COMPLETED + source=CHECKOUT",
        excluded_statuses="其它",
        unit="minutes",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="room_move_cleaning_tasks",
        name_zh="换房保洁任务数",
        name_en="Room Move Cleaning Tasks",
        domain="operations",
        definition="报告区间内创建（created_at Business Date）的 source = ROOM_MOVE "
        "保洁任务数（§23）。",
        formula="COUNT(housekeeping_tasks WHERE source = 'ROOM_MOVE' AND "
        "business_date(created_at) ∈ [from, to))",
        source_tables=("housekeeping_tasks",),
        date_basis=_PERIOD,
        included_statuses="source=ROOM_MOVE（任意状态）",
        excluded_statuses="其它来源",
        unit="tasks",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

# ---------------------------------------------------------------------------
# Maintenance（维修）— operations
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="maintenance_created",
        name_zh="新建维修工单数",
        name_en="Maintenance Created",
        domain="operations",
        definition="报告区间内创建（created_at Business Date）的维修工单数（§24）。",
        formula="COUNT(maintenance_work_orders WHERE business_date(created_at) ∈ [from, to))",
        source_tables=("maintenance_work_orders",),
        date_basis=_PERIOD,
        included_statuses="全部状态",
        excluded_statuses="-",
        unit="orders",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="maintenance_completed",
        name_zh="完成维修工单数",
        name_en="Maintenance Completed",
        domain="operations",
        definition="报告区间内完成（completed_at Business Date）的维修工单数（§24）。",
        formula="COUNT(maintenance_work_orders WHERE business_date(completed_at) ∈ [from, to))",
        source_tables=("maintenance_work_orders",),
        date_basis=_PERIOD,
        included_statuses="COMPLETED",
        excluded_statuses="其它",
        unit="orders",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="active_maintenance",
        name_zh="进行中维修工单",
        name_en="Active Maintenance",
        domain="operations",
        definition="当前进行中的维修工单数（Snapshot，§24）。",
        formula="COUNT(maintenance_work_orders WHERE status IN "
        "('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED'))",
        source_tables=("maintenance_work_orders",),
        date_basis=_SNAPSHOT,
        included_statuses="OPEN / ASSIGNED / IN_PROGRESS / RESOLVED",
        excluded_statuses="COMPLETED / CANCELLED",
        unit="orders",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="active_blocking_maintenance",
        name_zh="阻断性维修工单",
        name_en="Active Blocking Maintenance",
        domain="operations",
        definition="当前进行中且 blocks_room = true 的维修工单数（Snapshot，§24）。",
        formula="COUNT(maintenance_work_orders WHERE status IN "
        "('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED') AND blocks_room = true)",
        source_tables=("maintenance_work_orders",),
        date_basis=_SNAPSHOT,
        included_statuses="Active Blocking（含 RESOLVED）",
        excluded_statuses="COMPLETED / CANCELLED / blocks_room = false",
        unit="orders",
        zero_denominator_behavior="0",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="mean_time_to_resolution_minutes",
        name_zh="平均维修解决时长（分钟）",
        name_en="Mean Time To Resolution (MTTR)",
        domain="operations",
        definition="报告区间内 resolved_at Business Date 落在区间内的工单 "
        "resolved_at - created_at 平均分钟数（§24）。",
        formula="AVG(resolved_at - created_at) over orders with "
        "business_date(resolved_at) ∈ [from, to)",
        source_tables=("maintenance_work_orders",),
        date_basis=_PERIOD,
        included_statuses="已 resolve（RESOLVED / COMPLETED）",
        excluded_statuses="未 resolve",
        unit="minutes",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="mean_verification_minutes",
        name_zh="平均验收时长（分钟）",
        name_en="Mean Verification Minutes",
        domain="operations",
        definition="报告区间内 completed_at Business Date 落在区间内的工单 "
        "completed_at - resolved_at 平均分钟数（§24）。",
        formula="AVG(completed_at - resolved_at) over orders with "
        "business_date(completed_at) ∈ [from, to)",
        source_tables=("maintenance_work_orders",),
        date_basis=_PERIOD,
        included_statuses="COMPLETED",
        excluded_statuses="其它",
        unit="minutes",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

# ---------------------------------------------------------------------------
# Inventory（库存）— business
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="current_low_stock_items",
        name_zh="低库存物资数",
        name_en="Current Low Stock Items",
        domain="business",
        definition="当前库存状态为 LOW_STOCK 的物资数（Snapshot，§26）。",
        formula="COUNT(items WHERE total_stock > 0 AND minimum_stock > 0 AND "
        "total_stock <= minimum_stock)",
        source_tables=("inventory_items", "inventory_balances"),
        date_basis=_SNAPSHOT,
        included_statuses="LOW_STOCK",
        excluded_statuses="NORMAL / OUT_OF_STOCK",
        unit="items",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="current_out_of_stock_items",
        name_zh="缺货物资数",
        name_en="Current Out-of-stock Items",
        domain="business",
        definition="当前库存状态为 OUT_OF_STOCK 的物资数（Snapshot，§26）。",
        formula="COUNT(items WHERE total_stock = 0)",
        source_tables=("inventory_items", "inventory_balances"),
        date_basis=_SNAPSHOT,
        included_statuses="OUT_OF_STOCK",
        excluded_statuses="NORMAL / LOW_STOCK",
        unit="items",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="item_issue_quantity",
        name_zh="领用量",
        name_en="Item Issue Quantity",
        domain="business",
        definition="每个物资在报告区间内的领用毛量（§27）。SUM(abs(quantity)) where "
        "movement_type = ISSUE；不减 RETURN（gross issue activity）。历史数量禁止跨不同 "
        "Base Unit 求和（§26）；每 Item / 每 Base Unit 单独给出。",
        formula="per item: SUM(abs(quantity)) over stock_movements with "
        "movement_type = 'ISSUE' and business_date(created_at) ∈ [from, to)",
        source_tables=("stock_movements", "inventory_items"),
        date_basis=_PERIOD,
        included_statuses="ISSUE",
        excluded_statuses="RETURN / PURCHASE_RECEIPT / TRANSFER / ADJUSTMENT / INITIAL",
        unit="per item per base_unit",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="issue_quantity_per_occupied_room_night",
        name_zh="每实际房晚领用强度",
        name_en="Issue Quantity per Occupied Room Night",
        domain="business",
        definition="每个物资的领用强度（§28）：item_issue_quantity ÷ "
        "actual_occupied_room_nights。这是酒店库存领用强度，不等于客人实际消费量"
        "（无自动客耗扣账，Sprint 7）。每 Item 单独计算，禁止跨单位求和。",
        formula="item_issue_quantity / actual_occupied_room_nights",
        source_tables=("stock_movements", "inventory_items", "stays"),
        date_basis=_PERIOD,
        included_statuses="-",
        excluded_statuses="-",
        unit="per item per base_unit per occupied night",
        zero_denominator_behavior="null（无实际房晚）",
        required_permission="analytics:business_read",
    )
)

# ---------------------------------------------------------------------------
# Procurement（采购）— business
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="purchase_requests_created",
        name_zh="新建采购申请数",
        name_en="Purchase Requests Created",
        domain="business",
        definition="报告区间内创建（created_at Business Date）的采购申请数（§29）。",
        formula="COUNT(purchase_requests WHERE business_date(created_at) ∈ [from, to))",
        source_tables=("purchase_requests",),
        date_basis=_PERIOD,
        included_statuses="全部状态",
        excluded_statuses="-",
        unit="requests",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="pending_purchase_requests",
        name_zh="待处理采购申请",
        name_en="Pending Purchase Requests",
        domain="business",
        definition="当前处于 SUBMITTED（待审批）或 APPROVED（待转单）的采购申请数"
        "（Snapshot，§29）。",
        formula="COUNT(purchase_requests WHERE status IN ('SUBMITTED','APPROVED'))",
        source_tables=("purchase_requests",),
        date_basis=_SNAPSHOT,
        included_statuses="SUBMITTED / APPROVED",
        excluded_statuses="DRAFT / ORDERED / REJECTED / CANCELLED",
        unit="requests",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="purchase_orders_created",
        name_zh="新建采购订单数",
        name_en="Purchase Orders Created",
        domain="business",
        definition="报告区间内创建（created_at Business Date）的采购订单数（§29）。",
        formula="COUNT(purchase_orders WHERE business_date(created_at) ∈ [from, to))",
        source_tables=("purchase_orders",),
        date_basis=_PERIOD,
        included_statuses="全部状态",
        excluded_statuses="-",
        unit="orders",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="pending_receipt_orders",
        name_zh="待收货采购订单",
        name_en="Pending Receipt Orders",
        domain="business",
        definition="当前 ORDERED 或 PARTIALLY_RECEIVED（仍有剩余未收）的采购订单数"
        "（Snapshot，§29）。",
        formula="COUNT(purchase_orders WHERE status IN ('ORDERED','PARTIALLY_RECEIVED'))",
        source_tables=("purchase_orders",),
        date_basis=_SNAPSHOT,
        included_statuses="ORDERED / PARTIALLY_RECEIVED",
        excluded_statuses="DRAFT / RECEIVED / CANCELLED",
        unit="orders",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="partially_received_orders",
        name_zh="部分收货订单数",
        name_en="Partially Received Orders",
        domain="business",
        definition="当前 PARTIALLY_RECEIVED 的采购订单数（Snapshot，§29）。",
        formula="COUNT(purchase_orders WHERE status = 'PARTIALLY_RECEIVED')",
        source_tables=("purchase_orders",),
        date_basis=_SNAPSHOT,
        included_statuses="PARTIALLY_RECEIVED",
        excluded_statuses="其它",
        unit="orders",
        zero_denominator_behavior="0",
        required_permission="analytics:business_read",
    )
)

_register(
    MetricDefinition(
        code="received_purchase_value",
        name_zh="到货采购金额",
        name_en="Received Purchase Value",
        domain="business",
        definition="报告区间内按 GoodsReceipt.received_at（Business Date）归属的到货金额"
        "（§30）：GoodsReceiptLine.received_quantity × PurchaseOrderLine.unit_price。"
        "禁止使用 PurchaseOrder.created_at 作为实际到货金额日期。UI 必须说明："
        "≠ 已付款金额、≠ 会计成本。unit_price = NULL 的行不猜价格，计入 "
        "unpriced_received_lines（Data Quality）。",
        formula="Σ(grl.received_quantity × pol.unit_price) where "
        "business_date(gr.received_at) ∈ [from, to) and pol.unit_price IS NOT NULL",
        source_tables=("goods_receipts", "goods_receipt_lines", "purchase_order_lines"),
        date_basis=_PERIOD,
        included_statuses="全部收货（含 PARTIALLY_RECEIVED 后取消的历史收货）",
        excluded_statuses="-",
        unit="CNY（Decimal 字符串序列化）",
        zero_denominator_behavior="Decimal('0')",
        required_permission="analytics:business_read",
    )
)

# ---------------------------------------------------------------------------
# On-books Forecast（在册预测）— operations（§10/§11）
# ---------------------------------------------------------------------------

_register(
    MetricDefinition(
        code="on_books_7d",
        name_zh="在册占用率（7 日）",
        name_en="On-Books Occupancy 7d",
        domain="operations",
        definition="未来 7 天（含当前 business_date 起的 7 个日历日）在册占用房晚 ÷ "
        "物理房晚（§10/§11）。来源：CONFIRMED Reservation + ACTIVE Stay remaining "
        "planned occupancy [current_business_date, planned_check_out)。",
        formula="on_books_room_nights(horizon=7) / (physical_room_count × 7)",
        source_tables=("reservations", "stays", "rooms"),
        date_basis="Horizon 起点 = current_business_date；区间 [bd, bd + 7)",
        included_statuses="CONFIRMED / ACTIVE remaining planned",
        excluded_statuses="CANCELLED / NO_SHOW / CHECKED_IN(room_id 不得作为未来占用) / "
        "COMPLETED",
        unit="ratio 0..1（UI 显示百分比）",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="on_books_14d",
        name_zh="在册占用率（14 日）",
        name_en="On-Books Occupancy 14d",
        domain="operations",
        definition="未来 14 天在册占用房晚 ÷ 物理房晚（§10/§11，同 on_books_7d 口径）。",
        formula="on_books_room_nights(horizon=14) / (physical_room_count × 14)",
        source_tables=("reservations", "stays", "rooms"),
        date_basis="Horizon 起点 = current_business_date；区间 [bd, bd + 14)",
        included_statuses="CONFIRMED / ACTIVE remaining planned",
        excluded_statuses="CANCELLED / NO_SHOW / CHECKED_IN / COMPLETED",
        unit="ratio 0..1（UI 显示百分比）",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

_register(
    MetricDefinition(
        code="on_books_30d",
        name_zh="在册占用率（30 日）",
        name_en="On-Books Occupancy 30d",
        domain="operations",
        definition="未来 30 天在册占用房晚 ÷ 物理房晚（§10/§11，同 on_books_7d 口径）。"
        "最终按 distinct (business_date, room_id) 仲裁去重（§10），防止 ACTIVE Stay + "
        "linked Reservation 双重计算。",
        formula="on_books_room_nights(horizon=30) / (physical_room_count × 30)",
        source_tables=("reservations", "stays", "rooms"),
        date_basis="Horizon 起点 = current_business_date；区间 [bd, bd + 30)",
        included_statuses="CONFIRMED / ACTIVE remaining planned",
        excluded_statuses="CANCELLED / NO_SHOW / CHECKED_IN / COMPLETED",
        unit="ratio 0..1（UI 显示百分比）",
        zero_denominator_behavior="null",
        required_permission="analytics:operations_read",
    )
)

# ---------------------------------------------------------------------------
# 便捷查询
# ---------------------------------------------------------------------------

OPERATIONS_PERMISSION = "analytics:operations_read"
BUSINESS_PERMISSION = "analytics:business_read"


def metric(code: str) -> MetricDefinition:
    return METRICS[code]


def metrics_by_domain(domain: str) -> list[MetricDefinition]:
    return [m for m in METRICS.values() if m.domain == domain]


def all_metrics() -> list[MetricDefinition]:
    return list(METRICS.values())
