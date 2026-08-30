# -*- coding: utf-8 -*-
"""StayOps Desktop Backend Runner（Electron 桌面壳的 FastAPI 生产后端桥）。

设计（Desktop D1 · 复用已验证模式）：
- 使用 backend/.venv 已验证的 Python Runtime，在本进程内运行 uvicorn
  （NO --reload，Production Mode），默认绑定 127.0.0.1:8100
  （STAYOPS_BACKEND_HOST / STAYOPS_BACKEND_PORT 环境变量可覆盖）。
- stdin EOF（Electron 关闭写入端，即桌面退出/优雅停机请求）→ 设置
  server.should_exit = True，触发 uvicorn 优雅停机（lifespan shutdown、
  关闭连接、释放端口）。与 scripts/dev_runtime.py 的 stdin watchdog
  同一已验证模式；不依赖任何 PowerShell / 信号 hack。
- stdout/stderr 由 Electron 捕获写入 backend.log（含 secret scrub）。

运行方式（由 desktop/src/runtime/processes.ts 调用，cwd=backend）：
    backend/.venv/Scripts/python.exe backend/scripts/desktop_backend_runner.py
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

import uvicorn  # noqa: E402
from app.main import app  # noqa: E402

HOST = os.environ.get("STAYOPS_BACKEND_HOST", "127.0.0.1")
PORT = int(os.environ.get("STAYOPS_BACKEND_PORT", "8100"))

config = uvicorn.Config(
    app,
    host=HOST,
    port=PORT,
    log_level="info",
    access_log=True,
    timeout_graceful_shutdown=10,
)
server = uvicorn.Server(config)


def _stdin_watchdog() -> None:
    """stdin EOF = 桌面优雅停机请求（与 dev_runtime 的 stdin watchdog 同模式）。"""
    try:
        sys.stdin.buffer.read()
    except Exception:
        pass
    server.should_exit = True


threading.Thread(target=_stdin_watchdog, daemon=True).start()
try:
    server.run()
except SystemExit:
    # uvicorn 启动失败（如端口被占）以 SystemExit(STARTUP_FAILURE) 退出。
    # 若走解释器 finalize，会与阻塞在 stdin read() 的 watchdog 线程竞争
    # BufferedReader 锁，导致 `_enter_buffered_busy` fatal error（0xC0000005）。
    # 与 dev_runtime.py 同一已验证模式：os._exit 跳过 finalize，保留退出码。
    os._exit(3)
# 正常停机（stdin EOF / uvicorn should_exit）后同样跳过 finalize，
# 直接以 0 退出（真实异常仍会在 run() 内抛出并非零退出）。
os._exit(0)
