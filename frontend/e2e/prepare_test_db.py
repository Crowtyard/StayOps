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

CREDS_FILE = Path(__file__).resolve().parent / ".env.test-creds"


def load_admin_password() -> str | None:
    """bootstrap 管理员密码（D2 起 seed.py 不再内置默认值）。

    与 backend/tests/conftest.py 同一契约：由调用方显式提供。
    E2E 从 gitignored 的 e2e/.env.test-creds 读取 E2E_ADMIN_PASSWORD
    （缺失即失败，绝不静默使用任何默认密码）。
    """
    password = os.environ.get("E2E_ADMIN_PASSWORD")
    if password:
        return password
    if CREDS_FILE.exists():
        for line in CREDS_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("E2E_ADMIN_PASSWORD="):
                return line.split("=", 1)[1].strip()
    return None


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

    admin_password = load_admin_password()
    if not admin_password:
        raise SystemExit(
            "[prepare_test_db] 缺少 E2E_ADMIN_PASSWORD：seed 需要 bootstrap 管理员密码。"
            "请复制 e2e/test-creds.example 为 e2e/.env.test-creds 并填写（该文件已被 gitignore）。"
        )
    os.environ["STAYOPS_ADMIN_PASSWORD"] = admin_password

    from app.seed import seed  # noqa: E402

    seed()
    print(f"[prepare_test_db] {db_name} ready: migrate + seed done")


if __name__ == "__main__":
    main()
