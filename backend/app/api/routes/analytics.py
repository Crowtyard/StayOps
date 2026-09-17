"""Analytics 路由（Sprint 8，read-only derived layer，统一前缀 /api/v1/analytics）。

权限域分离（§35/§37，用 permission 判断，禁止硬编码角色名）：
- /analytics/operations/*  -> analytics:operations_read
  （Occupancy / Bookings / Stay / Housekeeping / Maintenance / Room Move / Forecast）
- /analytics/business/*    -> analytics:business_read
  （Contracted Room Value / Contracted ADR / Contracted RevPAR /
    Inventory Analytics / Procurement Analytics / Supplier value）
- /analytics/forecast      -> analytics:operations_read（On-books Forecast 属运营域）
禁止单个 /analytics/everything 聚合端点返回全部敏感指标。

查询参数（§38/§3）：
- Actual 端点：from=YYYY-MM-DD & to=YYYY-MM-DD（必填）、compare=true|false（默认 false）
  - from < to（否则 422）
  - to <= current_business_date（Actual 至多统计到业务日期当天之前；不允许未来实际数据）
  - 最大跨度 366 天（防无界查询）
- Forecast：无参数，一次返回 7d/14d/30d + 30 日每日序列。

响应结构明确区分 period / snapshot（§9）；Count -> 0、Rate/Average 分母 0 -> null、
Empty series -> []（§33）；不返回任何 Guest / Supplier 联系信息（§36 PII）。
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import require_permissions
from app.core.business_date import business_date
from app.database import get_db
from app.schemas.analytics import (
    AnalyticsPeriod,
    BookingsOut,
    BusinessChannelsOut,
    BusinessInventoryOut,
    BusinessProcurementOut,
    BusinessRoomsOut,
    ComparisonPeriod,
    ForecastOut,
    HousekeepingOut,
    MaintenanceOut,
    OperationsOverviewComparison,
    OperationsOverviewMetrics,
    OperationsOverviewOut,
    OperationsSnapshot,
    RoomMovesOut,
)
from app.services import analytics as svc

router = APIRouter(prefix="/analytics", tags=["analytics"])

OPERATIONS = require_permissions("analytics:operations_read")
BUSINESS = require_permissions("analytics:business_read")

MAX_SPAN_DAYS = 366


def _validate_period(from_date: date, to_date: date) -> tuple[date, date]:
    """Actual 区间校验（§3/§38）：from < to、to <= current_business_date、跨度 <= 366。"""
    if to_date <= from_date:
        raise HTTPException(status_code=422, detail="from 必须早于 to（区间为 [from, to)）")
    current_bd = business_date()
    if to_date > current_bd:
        raise HTTPException(
            status_code=422,
            detail="不允许未来实际数据：to 不能超过业务日期（Actual 至多统计到业务日期当天之前）",
        )
    if (to_date - from_date).days > MAX_SPAN_DAYS:
        raise HTTPException(
            status_code=422, detail=f"报告区间最大跨度为 {MAX_SPAN_DAYS} 天"
        )
    return from_date, to_date


def _period(from_date: date, to_date: date) -> AnalyticsPeriod:
    return AnalyticsPeriod(
        from_=from_date, to=to_date, days=(to_date - from_date).days
    )


# ---------------------------------------------------------------------------
# Operations 域
# ---------------------------------------------------------------------------


@router.get(
    "/operations/overview",
    response_model=OperationsOverviewOut,
    summary="运营总览（周期指标 + 当前快照 + On-books 摘要 + 可选对比）",
)
def operations_overview(
    from_date: date = Query(alias="from", description="区间起点（含）"),
    to_date: date = Query(alias="to", description="区间终点（不含）"),
    compare: bool = False,
    comparison_mode: str = Query(
        default=svc.DEFAULT_COMPARISON_MODE,
        description="对比语义：equal_length（默认，Last 7/30/90、Custom）/ "
        "previous_calendar_month（Last Month）/ previous_month_elapsed（This Month）",
    ),
    db=Depends(get_db),
    _user=Depends(OPERATIONS),
):
    from_date, to_date = _validate_period(from_date, to_date)
    if comparison_mode not in svc.COMPARISON_MODES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"非法 comparison_mode：{comparison_mode}；"
                f"可选 {', '.join(svc.COMPARISON_MODES)}"
            ),
        )
    metrics = svc.overview_metrics(db, from_date, to_date)
    snapshot = svc.snapshot_metrics(db)
    on_books = svc.on_books_horizons(db)

    comparison = None
    if compare:
        prev_from, prev_to = svc.previous_period(from_date, to_date, comparison_mode)
        prev_metrics = svc.overview_metrics(db, prev_from, prev_to)
        comparison = svc.build_comparison(metrics, prev_metrics, prev_from, prev_to)

    return {
        "business_date": business_date(),
        "period": _period(from_date, to_date),
        "metrics": metrics,
        "snapshot": snapshot,
        "on_books": on_books,
        "comparison": comparison,
    }


@router.get(
    "/operations/bookings",
    response_model=BookingsOut,
    summary="预订分析（Arrival Cohort：取消/未到店/提前天数/ALOS/换房 + 每日占用趋势）",
)
def operations_bookings(
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    db=Depends(get_db),
    _user=Depends(OPERATIONS),
):
    from_date, to_date = _validate_period(from_date, to_date)
    data = svc.bookings_analytics(db, from_date, to_date)
    data["period"] = _period(from_date, to_date)
    return data


@router.get(
    "/operations/housekeeping",
    response_model=HousekeepingOut,
    summary="保洁分析（完成数/平均周期/退房翻房/换房保洁 + 积压快照）",
)
def operations_housekeeping(
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    db=Depends(get_db),
    _user=Depends(OPERATIONS),
):
    from_date, to_date = _validate_period(from_date, to_date)
    data = svc.housekeeping_analytics(db, from_date, to_date)
    data["period"] = _period(from_date, to_date)
    return data


@router.get(
    "/operations/maintenance",
    response_model=MaintenanceOut,
    summary="维修分析（新建/完成/MTTR/验收时长 + 分类/房间分布 + 阻断快照）",
)
def operations_maintenance(
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    db=Depends(get_db),
    _user=Depends(OPERATIONS),
):
    from_date, to_date = _validate_period(from_date, to_date)
    data = svc.maintenance_analytics(db, from_date, to_date)
    data["period"] = _period(from_date, to_date)
    return data


@router.get(
    "/operations/room-moves",
    response_model=RoomMovesOut,
    summary="换房分析（次数/涉及住宿/换房率 + 原因/来源房分布）",
)
def operations_room_moves(
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    db=Depends(get_db),
    _user=Depends(OPERATIONS),
):
    from_date, to_date = _validate_period(from_date, to_date)
    data = svc.room_moves_analytics(db, from_date, to_date)
    data["period"] = _period(from_date, to_date)
    return data


# ---------------------------------------------------------------------------
# Business 域
# ---------------------------------------------------------------------------


@router.get(
    "/business/rooms",
    response_model=BusinessRoomsOut,
    summary="客房经营分析（合同房费/有价与无价房晚/合同 ADR/合同 RevPAR）",
)
def business_rooms(
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    db=Depends(get_db),
    _user=Depends(BUSINESS),
):
    from_date, to_date = _validate_period(from_date, to_date)
    data = svc.business_rooms_analytics(db, from_date, to_date)
    data["period"] = _period(from_date, to_date)
    return data


@router.get(
    "/business/channels",
    response_model=BusinessChannelsOut,
    summary="客源渠道经营分析（订单数/实际房晚/合同房费/占比/合同 ADR）",
)
def business_channels(
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    db=Depends(get_db),
    _user=Depends(BUSINESS),
):
    """「客人从哪里来」：按 source_channel_id 归因（每单恰好一次）。

    口径（LOCKED，见 docs/DECISIONS.md）：
    - 订单数 = Arrival Cohort 且排除 CANCELLED / NO_SHOW
    - 房晚 = 实际占用（Stay 派生，天然防 Room Move 重复计数）
    - 合同房费 = 复用既有经营分析同一事实源（agreed_total_amount 按计划房晚
      分摊到实际占用房晚），**非实际收款**
    - Σ channels + unassigned == totals（对账不变式）
    """
    from_date, to_date = _validate_period(from_date, to_date)
    data = svc.channel_performance_analytics(db, from_date, to_date)
    data["period"] = _period(from_date, to_date)
    return data


@router.get(
    "/business/inventory",
    response_model=BusinessInventoryOut,
    summary="库存分析（低/缺货快照 + 每物资领用量与领用强度，不跨单位求和）",
)
def business_inventory(
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    db=Depends(get_db),
    _user=Depends(BUSINESS),
):
    from_date, to_date = _validate_period(from_date, to_date)
    data = svc.inventory_analytics(db, from_date, to_date)
    data["period"] = _period(from_date, to_date)
    return data


@router.get(
    "/business/procurement",
    response_model=BusinessProcurementOut,
    summary="采购分析（申请/订单/待收货 + 到货采购金额（按收货日期）+ 供应商/物资分布）",
)
def business_procurement(
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    db=Depends(get_db),
    _user=Depends(BUSINESS),
):
    from_date, to_date = _validate_period(from_date, to_date)
    data = svc.procurement_analytics(db, from_date, to_date)
    data["period"] = _period(from_date, to_date)
    return data


# ---------------------------------------------------------------------------
# Forecast（operations 域）
# ---------------------------------------------------------------------------


@router.get(
    "/forecast",
    response_model=ForecastOut,
    summary="On-books 在册预测（7d/14d/30d + 30 日每日序列）",
)
def forecast(
    db=Depends(get_db),
    _user=Depends(OPERATIONS),
):
    return svc.forecast(db)
