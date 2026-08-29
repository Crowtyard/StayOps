# -*- coding: utf-8 -*-
"""E2E 测试状态准备：将指定 Stay 的实际入住时刻回填到 N 天前的固定时刻。

Analytics 的「实际占用房晚」只统计 business_date(actual_check_in_at) 起的
历史房晚；E2E 只能通过真实 API 在“今天”入住，因此需要一个真实 UPDATE
（与 setup_overdue_stay.py 同模式）把 actual_check_in_at 与初始 assignment
的 started_at 回填到过去，使报告期 [today-N, today) 内有确定性的房晚。
同时把关联 Reservation 的 check_in/check_out 平移回过去（合同房费可定价，§19），
并把同房间已完成的保洁任务与 E2E 维修工单的创建/完成时刻回填到过去
（Actual 区间不含业务日期当天，§3）。

Safety（Sprint 8 QA D2 同口径）：只允许数据库名 == stayops_test（解析实际
连接目标，拒绝前不执行任何写入；不使用 setdefault——DATABASE_URL 缺失即拒绝）；
只修改调用方显式传入的 <stay_id> 对应记录（不整表修改）。

用法：
    .venv\\Scripts\\python.exe e2e\\setup_backdate_stay.py <stay_id> <days_ago>
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))
os.chdir(BACKEND_DIR)

from sqlalchemy import select  # noqa: E402

from app.core.business_date import add_days, business_date  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import (  # noqa: E402
    HousekeepingTask,
    MaintenanceWorkOrder,
    Reservation,
    Stay,
    StayRoomAssignment,
)

PROPERTY_UTC_OFFSET = timezone(timedelta(hours=8), name="Asia/Shanghai")

TEST_DATABASE_NAME = "stayops_test"


def _require_test_database() -> None:
    """D2.1：只允许测试库 stayops_test；开发/生产库在写前拒绝。"""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("拒绝执行：缺少 DATABASE_URL（本脚本不提供默认连接目标）")
    parsed = urlparse(url)
    name = (parsed.path or "").lstrip("/")
    if name != TEST_DATABASE_NAME:
        raise SystemExit(
            f"拒绝执行：目标数据库为 {name!r}，仅允许测试库 {TEST_DATABASE_NAME!r}。"
            "本脚本是 Analytics E2E 专用历史时间回填，禁止作用于开发/生产数据库。"
        )


def ts(days_ago: int, hour: int, minute: int) -> datetime:
    return datetime.combine(
        add_days(business_date(), -days_ago),
        datetime.min.time().replace(hour=hour, minute=minute),
    ).replace(tzinfo=PROPERTY_UTC_OFFSET)


def main() -> None:
    _require_test_database()
    stay_id = int(sys.argv[1])
    days_ago = int(sys.argv[2])
    with SessionLocal() as db:
        stay = db.get(Stay, stay_id)
        if stay is None:
            raise SystemExit(f"stay {stay_id} not found")
        stay.actual_check_in_at = ts(days_ago, 14, 0)
        reservation = db.get(Reservation, stay.reservation_id)
        if reservation is not None:
            reservation.check_in_date = add_days(business_date(), -days_ago)
            reservation.check_out_date = add_days(business_date(), -days_ago + 2)
        first = db.scalars(
            select(StayRoomAssignment)
            .where(StayRoomAssignment.stay_id == stay_id)
            .order_by(StayRoomAssignment.id)
        ).first()
        if first is not None:
            first.started_at = ts(days_ago, 14, 0)
        # 同房间已完成的保洁任务（CHECKOUT 自动任务）回填到过去
        completed_task = db.scalars(
            select(HousekeepingTask)
            .where(HousekeepingTask.room_id == stay.room_id)
            .where(HousekeepingTask.status == "COMPLETED")
            .order_by(HousekeepingTask.id.desc())
        ).first()
        if completed_task is not None:
            completed_task.created_at = ts(days_ago, 10, 0)
            completed_task.started_at = ts(days_ago, 10, 15)
            completed_task.submitted_for_inspection_at = ts(days_ago, 11, 30)
            completed_task.completed_at = ts(days_ago, 12, 0)
        # E2E 维修工单（房间 + 固定标题）回填到过去
        e2e_order = db.scalars(
            select(MaintenanceWorkOrder)
            .where(MaintenanceWorkOrder.room_id == stay.room_id)
            .where(MaintenanceWorkOrder.title == "E2E 分析空调故障")
            .order_by(MaintenanceWorkOrder.id)
        ).first()
        if e2e_order is not None:
            e2e_order.created_at = ts(days_ago, 11, 0)
        db.commit()
        print(f"OK {stay.id} {stay.actual_check_in_at.isoformat()}")


if __name__ == "__main__":
    main()
