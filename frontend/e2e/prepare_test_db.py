# -*- coding: utf-8 -*-
"""E2E 测试库准备脚本（Playwright webServer 启动前后端 8001 前执行）。

与 backend/tests/conftest.py 同一策略：
- DROP/CREATE stayops_test（WITH FORCE）-> alembic upgrade head -> 幂等 seed
- 每次 E2E 运行重建测试库，保证 28 间种子房处于确定初始状态，
  E2E 完全不触碰开发库 stayops（127.0.0.1:8000）。
"""

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))
os.chdir(BACKEND_DIR)

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg2://stayops:change-me@localhost:5432/stayops_test",
)
# 必须先于任何 app.* 导入设置（与 pytest conftest 相同）
os.environ["DATABASE_URL"] = TEST_DATABASE_URL

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.engine.url import make_url  # noqa: E402


def main() -> None:
    url = make_url(TEST_DATABASE_URL)
    db_name = url.database
    admin_engine = create_engine(url.set(database="postgres"))
    with admin_engine.connect() as conn:
        conn = conn.execution_options(isolation_level="AUTOCOMMIT")
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin_engine.dispose()

    from alembic import command  # noqa: E402
    from alembic.config import Config  # noqa: E402

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    command.upgrade(cfg, "head")

    from app.seed import seed  # noqa: E402

    seed()
    print(f"[prepare_test_db] {db_name} ready: migrate + seed done")


if __name__ == "__main__":
    main()
