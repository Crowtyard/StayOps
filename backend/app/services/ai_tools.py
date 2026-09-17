"""AI Manager Tools（Sprint 9 §10-§12/§24）。

两个核心工具：
- get_analytics：访问 S8 正式 Analytics Service（指标定义唯一权威，禁止 AI
  自行重新实现 Physical Occupancy / ADR / RevPAR / Cancellation / No-show /
  ALOS / Forecast）；按 analytics:operations_read / business_read 域继承
  当前用户权限（§22/§23）。
- query_stayops_database：只读 SQL（Validator + stayops_ai_reader 双层保护）；
  按 §24 SQL Domain Access 映射限制可查询表/视图。

工具失败不抛业务异常，而是返回 {"error": code, "message": ...} 结果给模型
（模型负责向用户解释），但写操作在执行前被硬拒绝（§30）。
"""

from __future__ import annotations

import json
from datetime import date

from sqlalchemy.orm import Session

from app.core.ai_sql_validator import SqlValidationError, allowed_tables_for
from app.core.business_date import business_date
from app.services import analytics as analytics_svc
from app.services.ai_sql import AiSqlError, execute_ai_query

# ---------------------------------------------------------------------------
# SQL Domain Access（§24）：permission 域 -> 可查询视图
# ---------------------------------------------------------------------------

OPERATIONS_DOMAIN_TABLES: frozenset[str] = frozenset(
    {
        "AI_ROOM_TYPES",
        "AI_ROOMS",
        # alpha.9.6 F3：客源渠道主数据（运营域 —— 主数据不含金额；
        # 含金额的渠道经营分析走 get_analytics(channels)，受经营域权限约束）
        "AI_CHANNELS",
        "AI_RESERVATIONS",
        "AI_STAYS",
        "AI_STAY_ROOM_ASSIGNMENTS",
        "AI_HOUSEKEEPING_TASKS",
        "AI_MAINTENANCE_WORK_ORDERS",
        "AI_USERS",
    }
)

BUSINESS_DOMAIN_TABLES: frozenset[str] = frozenset(
    {
        "AI_INVENTORY_ITEMS",
        "AI_INVENTORY_LOCATIONS",
        "AI_INVENTORY_BALANCES",
        "AI_STOCK_MOVEMENTS",
        "AI_STOCK_ISSUES",
        "AI_STOCK_ISSUE_LINES",
        "AI_SUPPLIERS",
        "AI_PURCHASE_REQUESTS",
        "AI_PURCHASE_REQUEST_LINES",
        "AI_PURCHASE_ORDERS",
        "AI_PURCHASE_ORDER_LINES",
        "AI_GOODS_RECEIPTS",
        "AI_GOODS_RECEIPT_LINES",
    }
)

ALL_AI_TABLES = OPERATIONS_DOMAIN_TABLES | BUSINESS_DOMAIN_TABLES

# get_analytics 端点白名单（§11：正式 S8 Metric 一律走 get_analytics）
OPERATIONS_ENDPOINTS: dict[str, str] = {
    "overview": "运营总览（周期指标 + 当前快照 + On-books 7/14/30）",
    "bookings": "预订分析（Arrival Cohort / 取消 / 未到店 / 提前天数 / ALOS / 换房 / 每日占用）",
    "housekeeping": "保洁分析（完成数 / 平均周期 / 退房翻房 / 积压）",
    "maintenance": "维修分析（新建 / 完成 / MTTR / 验收 / 分类与房间分布）",
    "room-moves": "换房分析（次数 / 涉及住宿 / 换房率 / 原因 / 换出房）",
    "forecast": "On-books 在册预测（7/14/30 日 + 未来 30 日每日序列）",
}
BUSINESS_ENDPOINTS: dict[str, str] = {
    "rooms": "合同房费 / 有价与无价房晚 / 合同 ADR / 合同 RevPAR",
    "channels": "客源渠道经营分析（每渠道订单数 / 实际房晚 / 合同房费 / 占比 / 合同 ADR）",
    "inventory": "低/缺货快照 + 每物资领用量与领用强度",
    "procurement": "申请/订单/待收货 + 到货采购金额（供应商/物资/每日）",
}

MAX_SPAN_DAYS = 366
_DAILY_CAP = 31  # daily 序列截断上限（控制 token 量，§35 精神）


def _tool_error(code: str, message: str) -> dict:
    return {"error": code, "message": message}


def _jsonable(value):
    """递归 JSON 安全化（Decimal/date/datetime -> 字符串）。"""
    from datetime import datetime
    from decimal import Decimal

    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def _cap_daily(data: dict) -> dict:
    """截断 daily 序列（每端点最多保留最近 _DAILY_CAP 天，控制上下文长度）。"""
    daily = data.get("daily")
    if isinstance(daily, list) and len(daily) > _DAILY_CAP:
        data = dict(data)
        data["daily"] = daily[-_DAILY_CAP:]
        data["daily_truncated"] = True
    return data


def _parse_arguments(arguments: str | dict | None) -> dict | None:
    if arguments is None:
        return {}
    if isinstance(arguments, dict):
        return arguments
    try:
        value = json.loads(arguments)
        return value if isinstance(value, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


def _validate_analytics_period(from_value, to_value) -> tuple[date, date] | None:
    """Actual 区间校验（与 /analytics 路由同规则 §3/§38）：失败返回错误信息。"""
    if from_value is None or to_value is None:
        return "需要 from 与 to（YYYY-MM-DD）参数"
    try:
        from_date = date.fromisoformat(str(from_value))
        to_date = date.fromisoformat(str(to_value))
    except ValueError:
        return "日期格式错误：需要 YYYY-MM-DD"
    if to_date <= from_date:
        return "from 必须早于 to（区间为 [from, to)）"
    if to_date > business_date():
        return "不允许未来实际数据：to 不能超过业务日期"
    if (to_date - from_date).days > MAX_SPAN_DAYS:
        return f"报告区间最大跨度为 {MAX_SPAN_DAYS} 天"
    return None


# ---------------------------------------------------------------------------
# get_analytics（§11：优先使用 S8 Analytics，不要重新发明 Metric）
# ---------------------------------------------------------------------------


def run_get_analytics(
    db: Session,
    permissions: set[str],
    arguments: str | dict | None,
) -> dict:
    args = _parse_arguments(arguments)
    if args is None:
        return _tool_error("AI_TOOL_ARGUMENTS_INVALID", "get_analytics 参数必须是 JSON 对象")
    endpoint = args.get("endpoint")

    if endpoint in OPERATIONS_ENDPOINTS:
        if "analytics:operations_read" not in permissions:
            return _tool_error(
                "AI_PERMISSION_DENIED",
                "当前账号没有运营分析（analytics:operations_read）权限，无法获取该指标",
            )
        if endpoint == "forecast":
            data = analytics_svc.forecast(db)
        else:
            error = _validate_analytics_period(args.get("from"), args.get("to"))
            if error:
                return _tool_error("AI_ANALYTICS_PARAMETER_ERROR", error)
            from_date = date.fromisoformat(str(args["from"]))
            to_date = date.fromisoformat(str(args["to"]))
            if endpoint == "overview":
                data = {
                    "metrics": analytics_svc.overview_metrics(db, from_date, to_date),
                    "snapshot": analytics_svc.snapshot_metrics(db),
                    "on_books": analytics_svc.on_books_horizons(db),
                }
            elif endpoint == "bookings":
                data = analytics_svc.bookings_analytics(db, from_date, to_date)
            elif endpoint == "housekeeping":
                data = analytics_svc.housekeeping_analytics(db, from_date, to_date)
            elif endpoint == "maintenance":
                data = analytics_svc.maintenance_analytics(db, from_date, to_date)
            elif endpoint == "room-moves":
                data = analytics_svc.room_moves_analytics(db, from_date, to_date)
            else:  # pragma: no cover - 白名单保证不可达
                return _tool_error("AI_UNKNOWN_ENDPOINT", f"未知端点：{endpoint}")
        return {"endpoint": endpoint, "data": _jsonable(_cap_daily(data))}

    if endpoint in BUSINESS_ENDPOINTS:
        if "analytics:business_read" not in permissions:
            return _tool_error(
                "AI_PERMISSION_DENIED",
                "当前账号没有经营分析（analytics:business_read）权限，无法获取该指标",
            )
        error = _validate_analytics_period(args.get("from"), args.get("to"))
        if error:
            return _tool_error("AI_ANALYTICS_PARAMETER_ERROR", error)
        from_date = date.fromisoformat(str(args["from"]))
        to_date = date.fromisoformat(str(args["to"]))
        if endpoint == "rooms":
            data = analytics_svc.business_rooms_analytics(db, from_date, to_date)
        elif endpoint == "channels":
            # alpha.9.6 F4：客源渠道经营分析（回答「哪个渠道订单最多 / 收入最高」）
            data = analytics_svc.channel_performance_analytics(
                db, from_date, to_date
            )
        elif endpoint == "inventory":
            data = analytics_svc.inventory_analytics(db, from_date, to_date)
        else:  # procurement
            data = analytics_svc.procurement_analytics(db, from_date, to_date)
        return {"endpoint": endpoint, "data": _jsonable(_cap_daily(data))}

    return _tool_error(
        "AI_UNKNOWN_ENDPOINT",
        f"未知 analytics 端点：{endpoint}；可选 operations: {', '.join(OPERATIONS_ENDPOINTS)}，"
        f"business: {', '.join(BUSINESS_ENDPOINTS)}",
    )


# ---------------------------------------------------------------------------
# query_stayops_database（§12/§30：只读 SQL，双层保护）
# ---------------------------------------------------------------------------


def run_query_database(
    db: Session,
    permissions: set[str],
    arguments: str | dict | None,
) -> dict:
    args = _parse_arguments(arguments)
    if args is None:
        return _tool_error(
            "AI_TOOL_ARGUMENTS_INVALID", "query_stayops_database 参数必须是 JSON 对象"
        )
    sql = args.get("sql")
    if not isinstance(sql, str) or not sql.strip():
        return _tool_error("AI_SQL_PARAMETER_ERROR", "缺少 sql 参数")

    allowed = allowed_tables_for(permissions)
    try:
        result = execute_ai_query(sql, allowed_tables=allowed)
    except SqlValidationError as exc:
        return {
            "error": "AI_SQL_REJECTED",
            "message": str(exc),
            "sql_rejected": True,
        }
    except AiSqlError as exc:
        return {"error": exc.code, "message": str(exc)}
    return result


TOOL_DEFINITIONS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "get_analytics",
            "description": (
                "获取 StayOps 正式经营分析指标（S8 Analytics，Backend 唯一权威）："
                "运营域（operations）包括运营总览、预订、保洁、维修、换房、在册预测；"
                "经营域（business）包括合同房费/ADR/RevPAR、客源渠道经营分析、"
                "库存、采购。"
                "涉及正式指标（入住率、ADR、RevPAR、取消率、未到店率、ALOS、预测、"
                "渠道订单数与渠道合同房费等）"
                "必须使用本工具，不要自行计算。"
            ),
            # Hotfix（Real-use Defect #8）：Tool Schema 必须与 Backend Tool
            # Contract 一致——除 forecast 外所有端点都要求 from/to（否则
            # AI_ANALYTICS_PARAMETER_ERROR）；forecast 不需要 period。
            # 用 oneOf 表达条件 required，不粗暴全局 required，也不依赖
            # “模型先调用错 -> 工具报错 -> 模型重试”作为正常路径。
            "parameters": {
                "type": "object",
                "oneOf": [
                    {
                        "properties": {
                            "endpoint": {
                                "type": "string",
                                "enum": [
                                    "overview", "bookings", "housekeeping",
                                    "maintenance", "room-moves",
                                    "rooms", "channels", "inventory",
                                    "procurement",
                                ],
                                "description": "分析端点（需 period 的 Actual 端点）；"
                                "channels = 客源渠道经营分析（回答「哪个渠道"
                                "订单最多 / 渠道合同房费最高 / 客源占比」）",
                            },
                            "from": {
                                "type": "string",
                                "description": "区间起点 YYYY-MM-DD（含）；"
                                "与当前业务日期同口径，例如近7天 = 业务日期-7",
                            },
                            "to": {
                                "type": "string",
                                "description": "区间终点 YYYY-MM-DD（不含）；"
                                "不能超过当前业务日期",
                            },
                        },
                        "required": ["endpoint", "from", "to"],
                    },
                    {
                        "properties": {
                            "endpoint": {
                                "type": "string",
                                "enum": ["forecast"],
                                "description": "在册预测端点（无 period 参数）",
                            }
                        },
                        "required": ["endpoint"],
                    },
                ],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_stayops_database",
            "description": (
                "对 StayOps 数据库执行只读 SQL 查询（SELECT / WITH ... SELECT）。"
                "只能查询 AI 视图（ai_rooms、ai_reservations、ai_stays、"
                "ai_housekeeping_tasks、ai_maintenance_work_orders 等运营视图；"
                "ai_inventory_items、ai_stock_movements、ai_purchase_orders、"
                "ai_suppliers 等经营视图）。禁止写语句；数据库只读。"
                "返回 {columns, rows, row_count, truncated}。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "只读 SELECT 查询（单条语句）",
                    },
                },
                "required": ["sql"],
            },
        },
    },
]
