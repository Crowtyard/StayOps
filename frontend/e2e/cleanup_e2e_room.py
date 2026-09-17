# -*- coding: utf-8 -*-
"""E2E 测试清理：删除 alpha.9.6 E2E 用例自建的房间及其全部关联记录。

背景（真实缺陷）：Playwright 全套共用一个 `stayops_test` 库，且库只在
webServer 启动时重建一次 —— 用例中途新建的房间会残留在库中，使既有
「28 间种子房」断言（rooms / regression / front-desk）失败。因此
alpha.9.6 的 E2E 用例必须**自行清理**：本脚本按房间号精确删除该用例创建的
房间，并先清掉它产生的业务记录（停用房间不可删除，而带历史的房间按产品
规则也不允许删除 —— 这里只处理**本用例自己创建的测试数据**）。

Safety（与 setup_backdate_stay.py 同口径，Sprint 8 QA D2）：
- 只允许数据库名 == `stayops_test`（解析实际连接目标，拒绝前不执行任何写入；
  不使用 setdefault —— DATABASE_URL 缺失即拒绝）
- 只处理调用方显式传入的**单个房间号**，不做整表/批量删除
- 只删除「本用例创建」的派生记录：该房间的 stay_room_assignments / stays /
  housekeeping_tasks / reservations / maintenance_work_orders，随后删除房间本身

用法：
    .venv\\Scripts\\python.exe e2e\\cleanup_e2e_room.py <room_number>
"""

import os
import sys
from pathlib import Path
from urllib.parse import urlparse

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))
os.chdir(BACKEND_DIR)

from sqlalchemy import delete, select  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.models import (  # noqa: E402
    HousekeepingTask,
    MaintenanceWorkOrder,
    Reservation,
    Room,
    Stay,
    StayRoomAssignment,
)

TEST_DATABASE_NAME = "stayops_test"


def _require_test_database() -> None:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("拒绝执行：缺少 DATABASE_URL（本脚本不提供默认连接目标）")
    name = (urlparse(url).path or "").lstrip("/")
    if name != TEST_DATABASE_NAME:
        raise SystemExit(
            f"拒绝执行：目标数据库为 {name!r}，仅允许测试库 {TEST_DATABASE_NAME!r}。"
            "本脚本是 E2E 用例自建房间的清理工具，禁止作用于开发/生产数据库。"
        )


def main() -> None:
    _require_test_database()
    if len(sys.argv) < 2:
        raise SystemExit("用法：cleanup_e2e_room.py <room_number>")
    room_number = sys.argv[1]

    with SessionLocal() as db:
        room = db.scalar(select(Room).where(Room.room_number == room_number))
        if room is None:
            print(f"SKIP {room_number} (not found)")
            return
        room_id = room.id

        stay_ids = list(
            db.scalars(select(Stay.id).where(Stay.room_id == room_id))
        )
        reservation_ids = list(
            db.scalars(select(Reservation.id).where(Reservation.room_id == room_id))
        )
        if stay_ids:
            db.execute(
                delete(StayRoomAssignment).where(
                    StayRoomAssignment.stay_id.in_(stay_ids)
                )
            )
        db.execute(delete(Stay).where(Stay.room_id == room_id))
        # 该房间的入住记录可能因换房出现在其它房间上，一并清掉本用例的停留
        if reservation_ids:
            other_stays = list(
                db.scalars(
                    select(Stay.id).where(Stay.reservation_id.in_(reservation_ids))
                )
            )
            if other_stays:
                db.execute(
                    delete(StayRoomAssignment).where(
                        StayRoomAssignment.stay_id.in_(other_stays)
                    )
                )
            db.execute(delete(Stay).where(Stay.reservation_id.in_(reservation_ids)))
        db.execute(delete(Reservation).where(Reservation.room_id == room_id))
        db.execute(delete(HousekeepingTask).where(HousekeepingTask.room_id == room_id))
        db.execute(
            delete(MaintenanceWorkOrder).where(
                MaintenanceWorkOrder.room_id == room_id
            )
        )
        db.execute(delete(Room).where(Room.id == room_id))
        db.commit()
        print(f"OK removed room {room_number} (id={room_id})")


if __name__ == "__main__":
    main()
