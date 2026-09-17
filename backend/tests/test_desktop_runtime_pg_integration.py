# -*- coding: utf-8 -*-
"""alpha.9.6 Windows runtime hotfix · **真实集成测试**（默认跳过）。

运行方式（需要本地 PostgreSQL runtime 与一个空闲端口）：

    cd backend
    $env:STAYOPS_PG_INTEGRATION = "1"
    .venv\\Scripts\\python.exe -m pytest tests/test_desktop_runtime_pg_integration.py -q -s

验证真实链路（与安装版启动完全同一条代码路径）：

    cmd_db_ensure(fresh) → 标记写在 data 目录**同级** → initdb -E UTF8 --locale=C
    → pg_ctl start → pg_isready → 建库 stayops

为什么必须有这一层：单元测试只覆盖分类/清理的纯逻辑，而「标记文件放在 data
目录里面会让 initdb 直接失败（directory exists but is not empty）」只有在真实
initdb 上才会暴露 —— 2026-09-17 实机 QA 正是这样捕获该缺陷的。

安全：只使用临时目录（data/conf 均在 %TEMP%）与专用端口；结束前停止实例并删除
临时目录；不触碰 %PROGRAMDATA%\\StayOps 与开发库。
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import tempfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
PG_BIN = REPO_ROOT / "runtime" / "postgres" / "pgsql" / "bin"
TEST_PORT = 5457

ENABLED = os.environ.get("STAYOPS_PG_INTEGRATION") == "1" and (PG_BIN / "initdb.exe").exists()

pytestmark = pytest.mark.skipif(
    not ENABLED,
    reason="设置 STAYOPS_PG_INTEGRATION=1 且存在 runtime/postgres/pgsql/bin 时才运行",
)


def _load_runtime_module():
    spec = importlib.util.spec_from_file_location(
        "stayops_desktop_runtime_it", SCRIPTS_DIR / "desktop_runtime.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cmd_db_ensure_fresh_initdb_start_and_createdb():
    """真实 initdb + 启动 + 建库：data 目录必须保持为空直到 initdb 接管。"""
    cwd = os.getcwd()
    try:
        runtime = _load_runtime_module()
    finally:
        os.chdir(cwd)

    work = Path(tempfile.mkdtemp(prefix="stayops-pg-ensure-"))
    pg_home = work / "PostgreSQL"
    data_dir = pg_home / "data"
    creds = pg_home / "conf" / "dbpass.conf"
    try:
        args = runtime.argparse.Namespace(
            pg_bin=str(PG_BIN),
            data_dir=str(data_dir),
            creds_file=str(creds),
            port=TEST_PORT,
            timeout_ms=120_000,
        )

        # 1) 全新初始化：标记必须写在 data 目录**同级**，initdb 才能接受空目录
        result = runtime.cmd_db_ensure(args)
        assert result["ok"] is True, result.get("error")
        assert result["initialized"] is True
        assert (data_dir / "PG_VERSION").is_file(), "initdb 未生成 PG_VERSION"
        assert not (data_dir / runtime.INIT_INCOMPLETE_MARKER).exists(), (
            "incomplete 标记不能留在 data 目录内（会让下次 initdb 失败）"
        )
        assert not runtime.init_marker_path(data_dir).exists(), (
            "initdb 成功后标记应被删除"
        )
        assert "dbUrl" in result and "stayops" in result["dbUrl"]

        # 2) 幂等第二次调用：识别为已就绪实例，不重复 initdb
        second = runtime.cmd_db_ensure(args)
        assert second["ok"] is True, second.get("error")
        assert second["initialized"] is False

        # 3) 状态判定符合预期（有效 cluster）
        assert runtime.classify_data_dir(data_dir) == runtime.DATA_DIR_VALID_CLUSTER

        # 4) 有 PG_VERSION 的 cluster 永不被清理
        cleaned, reason = runtime.clean_partial_data_dir(data_dir)
        assert cleaned is False
        assert "PG_VERSION" in reason
        assert (data_dir / "PG_VERSION").is_file()
    finally:
        # 停止自建实例（只停自己的端口/data 目录）
        try:
            runtime._pg_ctl_stop(PG_BIN, data_dir)
        except Exception:
            pass
        shutil.rmtree(work, ignore_errors=True)
