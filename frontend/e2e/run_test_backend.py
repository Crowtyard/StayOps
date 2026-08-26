# -*- coding: utf-8 -*-
"""E2E 后端单进程入口（Playwright webServer 直接运行，无 .cmd 包装）。

好处：uvicorn 在本进程内运行，Playwright 可干净地杀死整个进程树，
避免 .cmd 包装产生的“孙进程”在运行结束后残留、下次运行时被 prepare
DROP 掉数据库连接导致的竞态。

流程：重建 stayops_test（迁移 + 种子）-> 在本进程内启动 uvicorn(:8001)。
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

# 复用同目录 prepare_test_db.py 的重建逻辑
sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_test_db import main as prepare_test_db  # noqa: E402

if __name__ == "__main__":
    prepare_test_db()

    import uvicorn  # noqa: E402

    uvicorn.run("app.main:app", host="127.0.0.1", port=8001, log_level="info")
