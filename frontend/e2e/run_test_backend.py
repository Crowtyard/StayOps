# -*- coding: utf-8 -*-
"""E2E 后端单进程入口（Playwright webServer 直接运行，无 .cmd 包装）。

好处：uvicorn 在本进程内运行，Playwright 可干净地杀死整个进程树，
避免 .cmd 包装产生的“孙进程”在运行结束后残留、下次运行时被 prepare
DROP 掉数据库连接导致的竞态。

流程：重建 stayops_test（迁移 + 种子）-> 启动 Fake DeepSeek Provider
（127.0.0.1:8099，AI E2E 不依赖真实 DeepSeek API，绝不向真实 API 发送 fake key）
-> 在本进程内启动 uvicorn(:8001)。
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

# Sprint 9：AI E2E 的 DeepSeek 请求指向本地 Fake Provider
os.environ["DEEPSEEK_API_BASE_URL"] = "http://127.0.0.1:8099"

# 复用同目录 prepare_test_db.py 的重建逻辑
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fake_deepseek_provider import start_fake_deepseek_provider  # noqa: E402
from prepare_test_db import main as prepare_test_db  # noqa: E402

if __name__ == "__main__":
    prepare_test_db()

    start_fake_deepseek_provider()

    import uvicorn  # noqa: E402

    uvicorn.run("app.main:app", host="127.0.0.1", port=8001, log_level="info")
