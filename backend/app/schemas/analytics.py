"""Analytics 域 schemas（Sprint 8，read-only derived layer）。

原则（Sprint 8 §2/§33/§53）：
- Analytics = 只读派生层，响应结构明确区分 period / snapshot（§9）。
- Count -> 0；Rate/Average 分母 0 -> null；Empty series -> []；
  禁止 NaN / Infinity。
- Money（Contracted Room Value / Received Purchase Value / ADR / RevPAR）
  使用 Decimal（JSON 字符串序列化，沿用既有金额约定）。
- Rate 使用 ratio 0..1（如 0.643），UI 负责显示为 64.3%。
- 不返回任何 Guest / Supplier 联系信息（§35/§36 PII）。
"""

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.models.channel import ChannelCategory


class AnalyticsPeriod(BaseModel):
    """报告区间 [from, to)，Business Date 口径（§2.4）。"""

    from_: date = Field(alias="from")
    to: date
    days: int

    model_config = ConfigDict(populate_by_name=True)


class ComparisonPeriod(BaseModel):
    """对比周期（前一个等长区间，§31）。"""

    from_: date = Field(alias="from")
    to: date
    days: int

    model_config = ConfigDict(populate_by_name=True)


class PercentChange(BaseModel):
    """数量 / 金额 / 平均 的百分比变化（§32）。previous = 0 -> null（禁止 Infinity）。"""

    percent_change: float | None = None


class RateChange(BaseModel):
    """比率类指标的变化以 percentage points 表达（§32）。"""

    pp_delta: float | None = None


class OnBooksHorizon(BaseModel):
    """On-books Forecast 单一日程（§10/§11）。"""

    days: int
    physical_room_nights: int
    on_books_room_nights: int
    occupancy_rate: float | None = None


# On-books 摘要：keys 固定为 "7d" / "14d" / "30d"
OnBooksSummary = dict[str, OnBooksHorizon]


# ---------------------------------------------------------------------------
# Operations 域
# ---------------------------------------------------------------------------


class OperationsOverviewMetrics(BaseModel):
    """Operations Overview 周期指标（§45）。"""

    actual_occupied_room_nights: int
    physical_room_nights: int
    physical_occupancy_rate: float | None = None
    completed_stays: int
    average_length_of_stay: float | None = None
    scheduled_arrivals: int
    cancelled_arrivals: int
    cancellation_rate: float | None = None
    no_show_count: int
    no_show_rate: float | None = None
    average_booking_lead_days: float | None = None
    room_move_count: int
    moved_stay_count: int
    room_move_rate: float | None = None
    housekeeping_completed_tasks: int


class OperationsSnapshot(BaseModel):
    """Operations 当前快照（§9，不得把快照当作周期指标）。"""

    active_stays: int
    overdue_active_stays: int
    housekeeping_backlog: int
    active_maintenance: int
    active_blocking_maintenance: int


class OperationsOverviewComparison(BaseModel):
    """Overview 对比（§31/§32）。"""

    period: ComparisonPeriod
    metrics: OperationsOverviewMetrics
    changes: dict[str, PercentChange | RateChange]


class OperationsOverviewOut(BaseModel):
    """GET /analytics/operations/overview"""

    business_date: date
    period: AnalyticsPeriod
    metrics: OperationsOverviewMetrics
    snapshot: OperationsSnapshot
    on_books: OnBooksSummary
    comparison: OperationsOverviewComparison | None = None


class DailyOccupancy(BaseModel):
    """每日实际占用（趋势用，§46）。"""

    business_date: date
    occupied_room_nights: int
    physical_room_nights: int
    occupancy_rate: float | None = None


class LeadBucket(BaseModel):
    """预订提前天数分桶（§15，Bucket 逻辑 Backend 权威）。"""

    bucket: str
    count: int


class BookingsOut(BaseModel):
    """GET /analytics/operations/bookings（Arrival Cohort，§12）。"""

    business_date: date
    period: AnalyticsPeriod
    scheduled_arrivals: int
    cancelled_arrivals: int
    cancellation_rate: float | None = None
    no_show_count: int
    no_show_rate: float | None = None
    average_booking_lead_days: float | None = None
    booking_lead_distribution: list[LeadBucket]
    completed_stays: int
    average_length_of_stay: float | None = None
    room_move_count: int
    moved_stay_count: int
    room_move_rate: float | None = None
    daily: list[DailyOccupancy]


class DailyHousekeeping(BaseModel):
    """每日完成保洁任务数（趋势用）。"""

    business_date: date
    completed_tasks: int


class HousekeepingOut(BaseModel):
    """GET /analytics/operations/housekeeping（§23）。"""

    business_date: date
    period: AnalyticsPeriod
    housekeeping_completed_tasks: int
    average_housekeeping_cycle_minutes: float | None = None
    checkout_turnover_minutes: float | None = None
    room_move_cleaning_tasks: int
    housekeeping_backlog: int
    daily: list[DailyHousekeeping]


class MaintenanceCategoryCount(BaseModel):
    category: str
    count: int


class MaintenanceRoomCount(BaseModel):
    room_id: int
    room_number: str
    count: int


class MaintenanceOut(BaseModel):
    """GET /analytics/operations/maintenance（§24）。"""

    business_date: date
    period: AnalyticsPeriod
    maintenance_created: int
    maintenance_completed: int
    active_maintenance: int
    active_blocking_maintenance: int
    mean_time_to_resolution_minutes: float | None = None
    mean_verification_minutes: float | None = None
    maintenance_by_category: list[MaintenanceCategoryCount]
    maintenance_by_room: list[MaintenanceRoomCount]


class RoomMoveReasonCount(BaseModel):
    reason: str
    count: int


class RoomMoveSourceRoomCount(BaseModel):
    room_id: int
    room_number: str
    count: int


class RoomMovesOut(BaseModel):
    """GET /analytics/operations/room-moves（§25）。"""

    business_date: date
    period: AnalyticsPeriod
    room_move_count: int
    moved_stay_count: int
    room_move_rate: float | None = None
    room_moves_by_reason: list[RoomMoveReasonCount]
    room_moves_by_source_room: list[RoomMoveSourceRoomCount]


# ---------------------------------------------------------------------------
# Business 域
# ---------------------------------------------------------------------------


class DailyContractedValue(BaseModel):
    """每日合同房费（趋势用，§46）。"""

    business_date: date
    contracted_room_value: Decimal
    priced_occupied_room_nights: int


class BusinessRoomsOut(BaseModel):
    """GET /analytics/business/rooms（§19/§20/§21/§22）。"""

    business_date: date
    period: AnalyticsPeriod
    contracted_room_value: Decimal
    priced_occupied_room_nights: int
    unpriced_occupied_room_nights: int
    contracted_adr: Decimal | None = None
    contracted_revpar: Decimal | None = None
    physical_room_nights: int
    daily: list[DailyContractedValue]


class InventoryItemAnalytics(BaseModel):
    """单个物资的领用分析（§26/§27/§28，每 Item 每 Base Unit 单独给出）。"""

    item_id: int
    item_code: str
    name: str
    category: str
    base_unit: str
    stock_status: str
    total_stock: Decimal
    is_active: bool
    issue_quantity: Decimal
    issue_quantity_per_occupied_room_night: float | None = None


class BusinessInventoryOut(BaseModel):
    """GET /analytics/business/inventory（§26/§27/§28）。"""

    business_date: date
    period: AnalyticsPeriod
    current_low_stock_items: int
    current_out_of_stock_items: int
    occupied_room_nights: int
    items: list[InventoryItemAnalytics]


class ReceivedValueBySupplier(BaseModel):
    supplier_id: int
    supplier_code: str
    supplier_name: str
    received_value: Decimal


class ReceivedValueByItem(BaseModel):
    item_id: int
    item_code: str
    item_name: str
    base_unit: str
    received_value: Decimal


class DailyReceivedValue(BaseModel):
    business_date: date
    received_purchase_value: Decimal


class BusinessProcurementOut(BaseModel):
    """GET /analytics/business/procurement（§29/§30）。"""

    business_date: date
    period: AnalyticsPeriod
    purchase_requests_created: int
    pending_purchase_requests: int
    purchase_orders_created: int
    pending_receipt_orders: int
    partially_received_orders: int
    received_purchase_value: Decimal
    unpriced_received_lines: int
    received_value_by_supplier: list[ReceivedValueBySupplier]
    received_value_by_item: list[ReceivedValueByItem]
    daily: list[DailyReceivedValue]


# ---------------------------------------------------------------------------
# Forecast（operations 域，§10/§11/§37/§38）
# ---------------------------------------------------------------------------


class ForecastDaily(BaseModel):
    """未来单日在册占用（30 日序列）。"""

    business_date: date
    on_books_room_nights: int
    physical_room_nights: int
    occupancy_rate: float | None = None


class ForecastOut(BaseModel):
    """GET /analytics/forecast"""

    business_date: date
    physical_room_count: int
    horizons: OnBooksSummary
    daily: list[ForecastDaily]


# ---------------------------------------------------------------------------
# Business: Channel Performance（alpha.9.6 F4 客源渠道经营分析）
# ---------------------------------------------------------------------------


class ChannelPerformanceRow(BaseModel):
    """单渠道经营表现。

    `contracted_room_value` = 合同房费金额（**非实际收款**；StayOps 无
    Folio / Payment / Settlement）。`contracted_adr` 同为合同口径。
    """

    channel_id: int | None = None  # None = 「未指定渠道」桶
    channel_code: str | None = None
    channel_name: str
    channel_category: ChannelCategory | None = None
    channel_enabled: bool = True
    is_system: bool = False
    order_count: int
    stay_count: int
    occupied_room_nights: int
    contracted_room_value: Decimal
    contracted_adr: Decimal | None = None
    # 渠道占比（ratio 0..1；区间总额为 0 -> null）
    share: float | None = None


class ChannelPerformanceTotals(BaseModel):
    """全部渠道合计（与 /analytics/business/rooms、/operations/bookings 同区间对账）。"""

    order_count: int
    stay_count: int
    occupied_room_nights: int
    contracted_room_value: Decimal
    contracted_adr: Decimal | None = None


class BusinessChannelsOut(BaseModel):
    """GET /analytics/business/channels"""

    business_date: date
    period: AnalyticsPeriod
    physical_room_count: int
    totals: ChannelPerformanceTotals
    channels: list[ChannelPerformanceRow]
    unassigned: ChannelPerformanceRow
