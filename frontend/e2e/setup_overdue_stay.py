# -*- coding: utf-8 -*-
"""E2E 测试状态准备：将指定 Stay 置为「超期在住」（Attention 规则 B）。

规则 B（Stay = ACTIVE 且 planned_check_out_date < business_date）在真实业务中
只能由时间流逝产生（Check-in 的 planned_check_out_date 恒 >= 业务日期当天）。
E2E 通过同一测试库、同一 ORM 模型的真实 UPDATE 构造该状态，
不 mock、不改写任何业务逻辑；Attention 计算仍完全由前端组合真实 List API 得出。

用法：
    .venv\\Scripts\\python.exe e2e\\setup_overdue_stay.py <stay_id>
"""

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))
os.chdir(BACKEND_DIR)
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops_test",
)

from app.core.business_date import add_days, business_date  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import Stay  # noqa: E402


def main() -> None:
    stay_id = int(sys.argv[1])
    with SessionLocal() as db:
        stay = db.get(Stay, stay_id)
        if stay is None:
            raise SystemExit(f"stay {stay_id} not found")
        if stay.status.value != "ACTIVE":
            raise SystemExit(f"stay {stay_id} is not ACTIVE")
        stay.planned_check_out_date = add_days(business_date(), -1)
        db.commit()
        print(f"OK {stay.id} {stay.planned_check_out_date}")


if __name__ == "__main__":
    main()
